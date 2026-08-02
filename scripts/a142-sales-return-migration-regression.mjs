#!/usr/bin/env node

import { execFileSync, spawn } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdir, open, readFile, writeFile } from "node:fs/promises";
import http from "node:http";
import path from "node:path";

import { loginApi } from "./helpers/regression-auth.mjs";
import {
  assertPublishedMigrationHistory,
  currentMigrationHead
} from "./helpers/current-migration-head.mjs";

const rootDir = path.resolve(import.meta.dirname, "..");
const verificationDir = path.join(rootDir, "verification");
const isolationDir = path.join(verificationDir, "a142-sales-return-migration-isolation");
const resultPath = path.join(verificationDir, "a142-sales-return-migration-regression.json");
const migrationDir = path.join(rootDir, "backend/src/main/resources/db/migration");
const migrationHead = await currentMigrationHead(migrationDir);
const container = process.env.JDY_POSTGRES_CONTAINER || "jdy-erp-postgres";
const redisContainer = process.env.JDY_REDIS_CONTAINER || "jdy-erp-redis";
const databaseUser = process.env.JDY_DATABASE_USER || "jdy";
const databasePassword = process.env.JDY_DATABASE_PASSWORD || "jdy_dev";
const token = randomBytes(6).toString("hex");
const upperToken = token.toUpperCase();
const upgradeDatabase = `jdy_a142_mig_${token}`;
const freshDatabase = `jdy_a142_fresh_${token}`;
const tenantSchema = `tenant_a142_mig_${token}`;
const backupSchema = `bk_a142_mig_${token}`;
const tenantCode = `A142-MIG-${upperToken}`;
const tenantId = randomUUID();
const backupId = randomUUID();
const backupName = `BK-${tenantCode}`;
const redisNamespace = `jdy:a142:migration:${token}`;
const passwordResetRedisPrefix = `jdy:a142:{migration-${token}}:password-reset`;
const processes = [];

const fixtures = {
  public: fixture("PUBLIC"),
  tenant: fixture("TENANT")
};

const restoreFixture = {
  productCategoryId: randomUUID(),
  unitId: randomUUID(),
  productId: randomUUID(),
  warehouseId: randomUUID(),
  salesOutId: randomUUID(),
  salesOutLineId: randomUUID(),
  salesReturnId: randomUUID(),
  salesReturnLineId: randomUUID(),
  allocationId: randomUUID(),
  unsubmittedImportBatchId: randomUUID(),
  committedImportBatchId: randomUUID(),
  productCategoryCode: `A142-PC-${upperToken}`,
  unitCode: `A142-U-${upperToken}`,
  productCode: `A142-P-${upperToken}`,
  warehouseCode: `A142-W-${upperToken}`,
  salesOutNo: `XSCK-A142-${upperToken}`,
  salesReturnNo: `XSTH-A142-${upperToken}`
};

const result = {
  ok: false,
  generatedAt: new Date().toISOString(),
  token,
  runtime: {
    postgresContainer: container,
    redisContainer,
    upgradeDatabase,
    freshDatabase,
    tenantSchema,
    historicalBackupSchema: backupSchema
  },
  upgrade: {},
  repeat: {},
  restoreApi: {},
  fresh: {},
  processes: [],
  cleanup: {
    databases: {},
    redisKeysDeleted: 0,
    redisKeysRemaining: null,
    processResidue: [],
    forcedProcessKills: [],
    errors: []
  },
  failure: null
};

await mkdir(isolationDir, { recursive: true });
let primaryError = null;
let cleanupPromise = null;
let signalBeingHandled = null;

function fixture(label) {
  const marker = `${label}-${upperToken}`;
  return {
    label,
    customerId: randomUUID(),
    customerCode: `A142-C-${marker}`,
    positiveId: randomUUID(),
    zeroId: randomUUID(),
    negativeId: randomUUID(),
    positiveNo: `AR-A142-${marker}-POS`,
    zeroNo: `AR-A142-${marker}-ZERO`,
    negativeNo: `AR-A142-${marker}-NEG`
  };
}

function assert(condition, message, details = undefined) {
  if (!condition) {
    throw new Error(`${message}${details === undefined ? "" : ` ${JSON.stringify(details)}`}`);
  }
}

function errorText(error) {
  return error instanceof Error ? error.stack ?? error.message : String(error);
}

function same(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function digest(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function sqlLiteral(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function quoteIdentifier(value) {
  const normalized = String(value);
  assert(/^[a-z][a-z0-9_]{0,62}$/.test(normalized), `unsafe SQL identifier: ${normalized}`);
  return `"${normalized}"`;
}

function psql(database, statement) {
  return execFileSync(
    "docker",
    ["exec", container, "psql", "-X", "-v", "ON_ERROR_STOP=1", "-U", databaseUser, "-d", database, "-tAq", "-c", statement],
    { encoding: "utf8", maxBuffer: 30 * 1024 * 1024 }
  ).trim();
}

function sqlJson(database, statement) {
  const value = psql(database, statement);
  return value ? JSON.parse(value) : null;
}

function createDatabase(database) {
  assert(/^jdy_a142_(?:mig|fresh)_[a-f0-9]{12}$/.test(database), `unsafe database create: ${database}`);
  execFileSync("docker", ["exec", container, "createdb", "-U", databaseUser, "-O", databaseUser, database], { encoding: "utf8" });
}

function dropDatabase(database) {
  assert(/^jdy_a142_(?:mig|fresh)_[a-f0-9]{12}$/.test(database), `unsafe database drop: ${database}`);
  execFileSync("docker", ["exec", container, "dropdb", "-U", databaseUser, "--if-exists", "--force", database], { encoding: "utf8" });
}

function flyway(database, target = null) {
  const args = [
    "org.flywaydb:flyway-maven-plugin:11.7.2:migrate",
    `-Dflyway.url=jdbc:postgresql://localhost:5432/${database}`,
    `-Dflyway.user=${databaseUser}`,
    `-Dflyway.password=${databasePassword}`,
    `-Dflyway.locations=filesystem:${migrationDir}`
  ];
  if (target != null) args.push(`-Dflyway.target=${target}`);
  return execFileSync("./scripts/backend-test.sh", args, {
    cwd: rootDir,
    encoding: "utf8",
    maxBuffer: 40 * 1024 * 1024
  }).trim().split(/\r?\n/).slice(-18);
}

function history(database) {
  return sqlJson(database, `
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
      'rank', installed_rank, 'version', version, 'script', script,
      'checksum', checksum, 'success', success
    ) ORDER BY installed_rank), '[]'::jsonb)::text
    FROM public.flyway_schema_history
    WHERE type = 'SQL'
  `);
}

function numberingLatestMetrics(database) {
  return sqlJson(database, `
    SELECT jsonb_build_object(
      'publicChecks', (
        SELECT count(*) FROM pg_constraint constraint_row
        JOIN pg_class table_row ON table_row.oid=constraint_row.conrelid
        JOIN pg_namespace schema_row ON schema_row.oid=table_row.relnamespace
        JOIN public.sys_tenant_managed_table managed ON managed.table_name=table_row.relname
        WHERE schema_row.nspname='public' AND constraint_row.contype='c'
      ),
      'tenantChecks', (
        SELECT count(*) FROM pg_constraint constraint_row
        JOIN pg_class table_row ON table_row.oid=constraint_row.conrelid
        JOIN pg_namespace schema_row ON schema_row.oid=table_row.relnamespace
        JOIN public.sys_tenant_managed_table managed ON managed.table_name=table_row.relname
        WHERE schema_row.nspname=${sqlLiteral(tenantSchema)} AND constraint_row.contype='c'
      ),
      'versionCopies', (
        SELECT count(*) FROM information_schema.columns
        WHERE table_schema IN ('public', ${sqlLiteral(tenantSchema)}, ${sqlLiteral(backupSchema)})
          AND table_name='document_number_sequence'
          AND column_name='version'
          AND data_type='bigint'
      ),
      'legacyRows', (
        (SELECT count(*) FROM public.document_number_sequence WHERE document_type='outsourcingSurface')
        + (SELECT count(*) FROM ${quoteIdentifier(tenantSchema)}.document_number_sequence WHERE document_type='outsourcingSurface')
        + (SELECT count(*) FROM ${quoteIdentifier(backupSchema)}.document_number_sequence WHERE document_type='outsourcingSurface')
      )
    )::text
  `);
}

function createTenant() {
  psql(upgradeDatabase, `
    BEGIN;
    INSERT INTO public.sys_account_set (
      id, code, name, environment, database_name, schema_name,
      attachment_prefix, redis_key_prefix, accounting_period, business_period,
      enabled, initialized
    ) VALUES (
      ${sqlLiteral(tenantId)}::uuid, ${sqlLiteral(tenantCode)}, 'A142 migration tenant',
      'A142 regression', ${sqlLiteral(upgradeDatabase)}, ${sqlLiteral(tenantSchema)},
      ${sqlLiteral(`account-sets/${tenantCode}`)}, ${sqlLiteral(tenantCode)},
      '2026-07', '2026-07', TRUE, TRUE
    );
    SELECT public.jdy_sync_tenant_schema(${sqlLiteral(tenantSchema)}, TRUE);
    COMMIT;
  `);
}

function fixtureSql(schema, data) {
  const q = quoteIdentifier(schema);
  return `
    INSERT INTO ${q}.md_customer (id, code, name, enabled, audit_status)
    VALUES (${sqlLiteral(data.customerId)}::uuid, ${sqlLiteral(data.customerCode)}, ${sqlLiteral(`A142 ${data.label} customer`)}, TRUE, 'AUDITED');
    INSERT INTO ${q}.ar_receivable (
      id, bill_no, source_bill_no, customer_id, bill_date, amount,
      received_amount, currency, status, created_at, updated_at
    ) VALUES
      (${sqlLiteral(data.positiveId)}::uuid, ${sqlLiteral(data.positiveNo)}, ${sqlLiteral(`OUT-${data.label}-POS`)}, ${sqlLiteral(data.customerId)}::uuid,
       DATE '2026-07-01', 100.00, 40.00, 'USD', 'PART_SETTLED', TIMESTAMPTZ '2026-07-01 01:00:00+00', TIMESTAMPTZ '2026-07-02 01:00:00+00'),
      (${sqlLiteral(data.zeroId)}::uuid, ${sqlLiteral(data.zeroNo)}, ${sqlLiteral(`OUT-${data.label}-ZERO`)}, ${sqlLiteral(data.customerId)}::uuid,
       DATE '2026-07-02', 0.00, 0.00, 'CNY', 'OPEN', TIMESTAMPTZ '2026-07-02 01:00:00+00', TIMESTAMPTZ '2026-07-02 01:00:00+00'),
      (${sqlLiteral(data.negativeId)}::uuid, ${sqlLiteral(data.negativeNo)}, ${sqlLiteral(`OUT-${data.label}-NEG`)}, ${sqlLiteral(data.customerId)}::uuid,
       DATE '2026-07-03', -25.00, 0.00, 'CNY', 'OPEN', TIMESTAMPTZ '2026-07-03 01:00:00+00', TIMESTAMPTZ '2026-07-03 01:00:00+00');
  `;
}

function seedV102() {
  psql(upgradeDatabase, `BEGIN; ${fixtureSql("public", fixtures.public)} ${fixtureSql(tenantSchema, fixtures.tenant)} COMMIT;`);
}

function createBackup() {
  psql(upgradeDatabase, `
    DO $backup$
    DECLARE
      managed RECORD;
      copied_rows BIGINT := 0;
      table_rows BIGINT;
      admin_id UUID;
    BEGIN
      CREATE SCHEMA ${quoteIdentifier(backupSchema)};
      FOR managed IN SELECT table_name FROM public.sys_tenant_managed_table ORDER BY restore_order, table_name LOOP
        EXECUTE format('CREATE TABLE %I.%I AS TABLE %I.%I', ${sqlLiteral(backupSchema)}, managed.table_name, ${sqlLiteral(tenantSchema)}, managed.table_name);
        EXECUTE format('SELECT count(*) FROM %I.%I', ${sqlLiteral(backupSchema)}, managed.table_name) INTO table_rows;
        copied_rows := copied_rows + table_rows;
      END LOOP;
      SELECT id INTO STRICT admin_id FROM public.sys_user WHERE username = 'admin';
      INSERT INTO public.sys_account_set_backup (
        id, account_set_id, account_set_code, account_set_name,
        backup_name, backup_schema_name, attachment_prefix,
        table_count, row_count, created_by
      ) VALUES (
        ${sqlLiteral(backupId)}::uuid, ${sqlLiteral(tenantId)}::uuid, ${sqlLiteral(tenantCode)}, 'A142 migration tenant',
        ${sqlLiteral(backupName)}, ${sqlLiteral(backupSchema)}, ${sqlLiteral(`account-sets/${tenantCode}`)},
        (SELECT count(*) FROM public.sys_tenant_managed_table), copied_rows, admin_id
      );
    END $backup$;
  `);
}

function receivableSnapshot(schema, data, migrated) {
  const q = quoteIdentifier(schema);
  const offset = migrated ? "return_offset_amount::text" : "'ABSENT'";
  return sqlJson(upgradeDatabase, `
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
      'id', id::text, 'billNo', bill_no, 'sourceBillNo', source_bill_no,
      'amount', amount::text, 'received', received_amount::text,
      'offset', ${offset}, 'currency', currency, 'status', status
    ) ORDER BY bill_no), '[]'::jsonb)::text
    FROM ${q}.ar_receivable
    WHERE id IN (${[data.positiveId, data.zeroId, data.negativeId].map((id) => `${sqlLiteral(id)}::uuid`).join(", ")})
  `);
}

function shapeSnapshot(schema, constrained) {
  const q = sqlLiteral(schema);
  return sqlJson(upgradeDatabase, `
    SELECT jsonb_build_object(
      'tables', (SELECT count(*) FROM information_schema.tables WHERE table_schema = ${q} AND table_name IN ('sales_return', 'sales_return_line', 'sales_return_finance_allocation')),
      'offsetColumn', (SELECT count(*) FROM information_schema.columns WHERE table_schema = ${q} AND table_name = 'ar_receivable' AND column_name = 'return_offset_amount'),
      'rows', (SELECT count(*) FROM ${quoteIdentifier(schema)}.sales_return),
      'constraints', (SELECT count(*) FROM pg_constraint c JOIN pg_class t ON t.oid = c.conrelid JOIN pg_namespace n ON n.oid = t.relnamespace WHERE n.nspname = ${q} AND t.relname IN ('sales_return', 'sales_return_line', 'sales_return_finance_allocation')),
      'expectedConstraintMode', ${constrained ? "'managed'" : "'backup'"}
    )::text
  `);
}

function importBatchShape(schema, constrained) {
  const q = sqlLiteral(schema);
  return sqlJson(upgradeDatabase, `
    SELECT jsonb_build_object(
      'tables', (SELECT count(*) FROM information_schema.tables WHERE table_schema = ${q} AND table_name = 'md_import_batch'),
      'rows', (SELECT count(*) FROM ${quoteIdentifier(schema)}.md_import_batch),
      'constraints', (
        SELECT count(*)
        FROM pg_constraint constraint_row
        JOIN pg_class table_row ON table_row.oid = constraint_row.conrelid
        JOIN pg_namespace schema_row ON schema_row.oid = table_row.relnamespace
        WHERE schema_row.nspname = ${q}
          AND table_row.relname = 'md_import_batch'
      ),
      'foreignKeys', (
        SELECT count(*)
        FROM pg_constraint constraint_row
        JOIN pg_class table_row ON table_row.oid = constraint_row.conrelid
        JOIN pg_namespace schema_row ON schema_row.oid = table_row.relnamespace
        WHERE schema_row.nspname = ${q}
          AND table_row.relname = 'md_import_batch'
          AND constraint_row.contype = 'f'
      ),
      'expectedConstraintMode', ${constrained ? "'managed'" : "'backup'"}
    )::text
  `);
}

function timestampExpression(column) {
  return `to_char(${column} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
}

function seedRestoreFixture() {
  const q = quoteIdentifier(tenantSchema);
  psql(upgradeDatabase, `
    BEGIN;
    INSERT INTO ${q}.md_product_category (
      id, code, name, sort_no, enabled, audit_status, created_at, updated_at
    ) VALUES (
      ${sqlLiteral(restoreFixture.productCategoryId)}::uuid,
      ${sqlLiteral(restoreFixture.productCategoryCode)},
      'A142 restore category', 142, TRUE, 'AUDITED',
      TIMESTAMPTZ '2026-07-14 01:00:00+00', TIMESTAMPTZ '2026-07-14 01:00:00+00'
    );
    INSERT INTO ${q}.md_unit (
      id, code, name, decimal_places, sort_no, enabled, audit_status, created_at, updated_at
    ) VALUES (
      ${sqlLiteral(restoreFixture.unitId)}::uuid,
      ${sqlLiteral(restoreFixture.unitCode)},
      '件', 4, 142, TRUE, 'AUDITED',
      TIMESTAMPTZ '2026-07-14 01:00:01+00', TIMESTAMPTZ '2026-07-14 01:00:01+00'
    );
    INSERT INTO ${q}.md_product (
      id, code, name, spec, unit, enabled, category, product_type,
      tax_rate, is_sale, is_inventory, issue_method, audit_status,
      product_category_id, unit_id, created_at, updated_at
    ) VALUES (
      ${sqlLiteral(restoreFixture.productId)}::uuid,
      ${sqlLiteral(restoreFixture.productCode)},
      'A142 restore product', 'RESTORE-SPEC', '件', TRUE, '成品总成', '成品',
      0, TRUE, TRUE, '按单领料', 'AUDITED',
      ${sqlLiteral(restoreFixture.productCategoryId)}::uuid,
      ${sqlLiteral(restoreFixture.unitId)}::uuid,
      TIMESTAMPTZ '2026-07-14 01:00:02+00', TIMESTAMPTZ '2026-07-14 01:00:02+00'
    );
    INSERT INTO ${q}.md_warehouse (
      id, code, name, allow_negative_stock, enabled, warehouse_type,
      audit_status, created_at, updated_at
    ) VALUES (
      ${sqlLiteral(restoreFixture.warehouseId)}::uuid,
      ${sqlLiteral(restoreFixture.warehouseCode)},
      'A142 restore warehouse', FALSE, TRUE, '普通仓', 'AUDITED',
      TIMESTAMPTZ '2026-07-14 01:00:03+00', TIMESTAMPTZ '2026-07-14 01:00:03+00'
    );
    INSERT INTO ${q}.sales_out (
      id, bill_no, customer_id, bill_date, status, total_amount, currency,
      owner_name, remark, created_at, updated_at, version
    ) VALUES (
      ${sqlLiteral(restoreFixture.salesOutId)}::uuid,
      ${sqlLiteral(restoreFixture.salesOutNo)},
      ${sqlLiteral(fixtures.tenant.customerId)}::uuid,
      DATE '2026-07-14', 'AUDITED', 100.00, 'USD',
      'A142 restore owner', 'A142 restore source',
      TIMESTAMPTZ '2026-07-14 01:01:00+00', TIMESTAMPTZ '2026-07-14 01:01:00+00', 2
    );
    INSERT INTO ${q}.sales_out_line (
      id, bill_id, line_no, product_id, warehouse_id, qty, unit_price, amount,
      source_line_no, line_remark, tax_rate, tax_amount, price_tax_total,
      product_code_snapshot, product_name_snapshot, product_spec_snapshot,
      product_unit_snapshot, net_weight_snapshot, gross_weight_snapshot
    ) VALUES (
      ${sqlLiteral(restoreFixture.salesOutLineId)}::uuid,
      ${sqlLiteral(restoreFixture.salesOutId)}::uuid,
      1, ${sqlLiteral(restoreFixture.productId)}::uuid,
      ${sqlLiteral(restoreFixture.warehouseId)}::uuid,
      10.0000, 10.00, 100.00, 1, 'A142 restore source line',
      0, 0.00, 100.00,
      ${sqlLiteral(restoreFixture.productCode)}, 'A142 restore product', 'RESTORE-SPEC',
      '件', 1.2500, 1.5000
    );
    UPDATE ${q}.ar_receivable
    SET source_bill_no = ${sqlLiteral(restoreFixture.salesOutNo)},
        return_offset_amount = 60.00,
        status = 'SETTLED',
        updated_at = TIMESTAMPTZ '2026-07-14 01:02:00+00'
    WHERE id = ${sqlLiteral(fixtures.tenant.positiveId)}::uuid;
    INSERT INTO ${q}.sales_return (
      id, bill_no, customer_id, bill_date, department, status, total_amount,
      currency, owner_name, remark, created_at, updated_at, version
    ) VALUES (
      ${sqlLiteral(restoreFixture.salesReturnId)}::uuid,
      ${sqlLiteral(restoreFixture.salesReturnNo)},
      ${sqlLiteral(fixtures.tenant.customerId)}::uuid,
      DATE '2026-07-14', '销售部', 'AUDITED', 70.00,
      'USD', 'A142 restore owner', 'A142 formal restore fact',
      TIMESTAMPTZ '2026-07-14 01:03:00+00', TIMESTAMPTZ '2026-07-14 01:04:00+00', 3
    );
    INSERT INTO ${q}.sales_return_line (
      id, bill_id, line_no, source_out_line_id, source_out_no, source_line_no,
      product_id, product_code_snapshot, product_name_snapshot,
      product_spec_snapshot, product_unit_snapshot, net_weight_snapshot,
      gross_weight_snapshot, warehouse_id, qty, unit_price, amount,
      tax_rate, tax_amount, price_tax_total, line_remark
    ) VALUES (
      ${sqlLiteral(restoreFixture.salesReturnLineId)}::uuid,
      ${sqlLiteral(restoreFixture.salesReturnId)}::uuid,
      1, ${sqlLiteral(restoreFixture.salesOutLineId)}::uuid,
      ${sqlLiteral(restoreFixture.salesOutNo)}, 1,
      ${sqlLiteral(restoreFixture.productId)}::uuid,
      ${sqlLiteral(restoreFixture.productCode)}, 'A142 restore product',
      'RESTORE-SPEC', '件', 1.2500, 1.5000,
      ${sqlLiteral(restoreFixture.warehouseId)}::uuid,
      7.0000, 10.00, 70.00, 0, 0.00, 70.00,
      'A142 restore return line'
    );
    INSERT INTO ${q}.sales_return_finance_allocation (
      id, sales_return_id, receivable_id, source_out_no, receivable_bill_no,
      currency, source_amount, received_before, return_offset_before,
      unsettled_before, return_amount, offset_amount, pending_refund_amount,
      refunded_amount, created_at, updated_at
    ) VALUES (
      ${sqlLiteral(restoreFixture.allocationId)}::uuid,
      ${sqlLiteral(restoreFixture.salesReturnId)}::uuid,
      ${sqlLiteral(fixtures.tenant.positiveId)}::uuid,
      ${sqlLiteral(restoreFixture.salesOutNo)},
      ${sqlLiteral(fixtures.tenant.positiveNo)},
      'USD', 100.00, 40.00, 0.00, 60.00, 70.00, 60.00, 10.00, 0.00,
      TIMESTAMPTZ '2026-07-14 01:05:00+00', TIMESTAMPTZ '2026-07-14 01:05:00+00'
    );
    INSERT INTO ${q}.md_import_batch (
      id, account_set_id, account_set_code, created_by, created_by_username,
      import_type, template_version, original_file_name, file_sha256, file_size_bytes,
      status, total_rows, valid_rows, error_rows, committed_rows, rows_payload,
      created_at, expires_at, committed_at, payload_cleared_at, updated_at, version
    )
    SELECT ${sqlLiteral(restoreFixture.unsubmittedImportBatchId)}::uuid,
           ${sqlLiteral(tenantId)}::uuid,
           ${sqlLiteral(tenantCode)},
           id,
           username,
           'customer',
           1,
           'a142-unsubmitted.xlsx',
           repeat('a', 64),
           128,
           'VALIDATED',
           1,
           1,
           0,
           0,
           '[{"rowNo":3,"payload":{"code":"A142-C001"},"errors":[]}]'::jsonb,
           TIMESTAMPTZ '2026-07-14 01:06:00+00',
           TIMESTAMPTZ '2026-07-14 01:36:00+00',
           NULL,
           NULL,
           TIMESTAMPTZ '2026-07-14 01:06:00+00',
           0
    FROM public.sys_user
    WHERE username = 'admin';
    INSERT INTO ${q}.md_import_batch (
      id, account_set_id, account_set_code, created_by, created_by_username,
      import_type, template_version, original_file_name, file_sha256, file_size_bytes,
      status, total_rows, valid_rows, error_rows, committed_rows, rows_payload,
      created_at, expires_at, committed_at, payload_cleared_at, updated_at, version
    )
    SELECT ${sqlLiteral(restoreFixture.committedImportBatchId)}::uuid,
           ${sqlLiteral(tenantId)}::uuid,
           ${sqlLiteral(tenantCode)},
           id,
           username,
           'customer',
           1,
           'a142-committed.xlsx',
           repeat('b', 64),
           128,
           'COMMITTED',
           1,
           1,
           0,
           1,
           '[]'::jsonb,
           TIMESTAMPTZ '2026-07-14 01:06:00+00',
           TIMESTAMPTZ '2026-07-14 01:36:00+00',
           TIMESTAMPTZ '2026-07-14 01:10:00+00',
           TIMESTAMPTZ '2026-07-14 01:10:00+00',
           TIMESTAMPTZ '2026-07-14 01:10:00+00',
           0
    FROM public.sys_user
    WHERE username = 'admin';
    COMMIT;
  `);
}

function importBatchSnapshot(schema) {
  const q = quoteIdentifier(schema);
  return sqlJson(upgradeDatabase, `
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
      'id', id::text,
      'status', status,
      'payload', rows_payload,
      'payloadCleared', payload_cleared_at IS NOT NULL,
      'committedRows', committed_rows,
      'version', version
    ) ORDER BY id), '[]'::jsonb)::text
    FROM ${q}.md_import_batch
    WHERE id IN (
      ${sqlLiteral(restoreFixture.unsubmittedImportBatchId)}::uuid,
      ${sqlLiteral(restoreFixture.committedImportBatchId)}::uuid
    )
  `);
}

function restoreSemanticSnapshot(schema) {
  const q = quoteIdentifier(schema);
  return sqlJson(upgradeDatabase, `
    SELECT jsonb_build_object(
      'master', jsonb_build_object(
        'customer', (SELECT jsonb_build_object('id', id::text, 'code', code, 'name', name) FROM ${q}.md_customer WHERE id = ${sqlLiteral(fixtures.tenant.customerId)}::uuid),
        'product', (SELECT jsonb_build_object('id', id::text, 'code', code, 'name', name, 'spec', spec, 'unit', unit, 'auditStatus', audit_status, 'categoryId', product_category_id::text, 'unitId', unit_id::text) FROM ${q}.md_product WHERE id = ${sqlLiteral(restoreFixture.productId)}::uuid),
        'warehouse', (SELECT jsonb_build_object('id', id::text, 'code', code, 'name', name, 'allowNegative', allow_negative_stock, 'auditStatus', audit_status) FROM ${q}.md_warehouse WHERE id = ${sqlLiteral(restoreFixture.warehouseId)}::uuid)
      ),
      'source', (SELECT jsonb_build_object(
        'id', source.id::text, 'billNo', source.bill_no, 'customerId', source.customer_id::text,
        'billDate', source.bill_date::text, 'status', source.status,
        'totalAmount', source.total_amount::text, 'currency', source.currency,
        'ownerName', source.owner_name, 'remark', source.remark,
        'createdAt', ${timestampExpression("source.created_at")},
        'updatedAt', ${timestampExpression("source.updated_at")}, 'version', source.version::text,
        'line', (SELECT jsonb_build_object(
          'id', line.id::text, 'lineNo', line.line_no, 'productId', line.product_id::text,
          'warehouseId', line.warehouse_id::text, 'qty', line.qty::text,
          'unitPrice', line.unit_price::text, 'amount', line.amount::text,
          'sourceLineNo', line.source_line_no, 'taxRate', line.tax_rate::text,
          'taxAmount', line.tax_amount::text, 'priceTaxTotal', line.price_tax_total::text,
          'productCode', line.product_code_snapshot, 'productName', line.product_name_snapshot,
          'productSpec', line.product_spec_snapshot, 'productUnit', line.product_unit_snapshot,
          'netWeight', line.net_weight_snapshot::text, 'grossWeight', line.gross_weight_snapshot::text,
          'remark', line.line_remark
        ) FROM ${q}.sales_out_line line WHERE line.id = ${sqlLiteral(restoreFixture.salesOutLineId)}::uuid)
      ) FROM ${q}.sales_out source WHERE source.id = ${sqlLiteral(restoreFixture.salesOutId)}::uuid),
      'receivable', (SELECT jsonb_build_object(
        'id', id::text, 'billNo', bill_no, 'sourceBillNo', source_bill_no,
        'customerId', customer_id::text, 'billDate', bill_date::text,
        'amount', amount::text, 'receivedAmount', received_amount::text,
        'returnOffsetAmount', return_offset_amount::text, 'currency', currency,
        'status', status, 'createdAt', ${timestampExpression("created_at")},
        'updatedAt', ${timestampExpression("updated_at")}
      ) FROM ${q}.ar_receivable WHERE id = ${sqlLiteral(fixtures.tenant.positiveId)}::uuid),
      'returnHeader', (SELECT jsonb_build_object(
        'id', id::text, 'billNo', bill_no, 'customerId', customer_id::text,
        'billDate', bill_date::text, 'department', department, 'status', status,
        'totalAmount', total_amount::text, 'currency', currency,
        'ownerName', owner_name, 'remark', remark,
        'closeStatus', close_status, 'frozenStatus', frozen_status,
        'createdAt', ${timestampExpression("created_at")},
        'updatedAt', ${timestampExpression("updated_at")}, 'version', version::text
      ) FROM ${q}.sales_return WHERE id = ${sqlLiteral(restoreFixture.salesReturnId)}::uuid),
      'returnLine', (SELECT jsonb_build_object(
        'id', id::text, 'billId', bill_id::text, 'lineNo', line_no,
        'sourceOutLineId', source_out_line_id::text, 'sourceOutNo', source_out_no,
        'sourceLineNo', source_line_no, 'productId', product_id::text,
        'productCode', product_code_snapshot, 'productName', product_name_snapshot,
        'productSpec', product_spec_snapshot, 'productUnit', product_unit_snapshot,
        'netWeight', net_weight_snapshot::text, 'grossWeight', gross_weight_snapshot::text,
        'warehouseId', warehouse_id::text, 'qty', qty::text,
        'unitPrice', unit_price::text, 'amount', amount::text,
        'taxRate', tax_rate::text, 'taxAmount', tax_amount::text,
        'priceTaxTotal', price_tax_total::text, 'remark', line_remark,
        'closeStatus', line_close_status, 'frozenStatus', line_frozen_status
      ) FROM ${q}.sales_return_line WHERE id = ${sqlLiteral(restoreFixture.salesReturnLineId)}::uuid),
      'allocation', (SELECT jsonb_build_object(
        'id', id::text, 'salesReturnId', sales_return_id::text,
        'receivableId', receivable_id::text, 'sourceOutNo', source_out_no,
        'receivableBillNo', receivable_bill_no, 'currency', currency,
        'sourceAmount', source_amount::text, 'receivedBefore', received_before::text,
        'returnOffsetBefore', return_offset_before::text,
        'unsettledBefore', unsettled_before::text, 'returnAmount', return_amount::text,
        'offsetAmount', offset_amount::text,
        'pendingRefundAmount', pending_refund_amount::text,
        'refundedAmount', refunded_amount::text,
        'createdAt', ${timestampExpression("created_at")},
        'updatedAt', ${timestampExpression("updated_at")}
      ) FROM ${q}.sales_return_finance_allocation WHERE id = ${sqlLiteral(restoreFixture.allocationId)}::uuid),
      'factCounts', jsonb_build_object(
        'headers', (SELECT count(*) FROM ${q}.sales_return WHERE id = ${sqlLiteral(restoreFixture.salesReturnId)}::uuid),
        'lines', (SELECT count(*) FROM ${q}.sales_return_line WHERE id = ${sqlLiteral(restoreFixture.salesReturnLineId)}::uuid),
        'allocations', (SELECT count(*) FROM ${q}.sales_return_finance_allocation WHERE id = ${sqlLiteral(restoreFixture.allocationId)}::uuid)
      )
    )::text
  `);
}

function mutateRestoreFixture() {
  const q = quoteIdentifier(tenantSchema);
  psql(upgradeDatabase, `
    BEGIN;
    DELETE FROM ${q}.sales_return
    WHERE id = ${sqlLiteral(restoreFixture.salesReturnId)}::uuid;
    UPDATE ${q}.ar_receivable
    SET return_offset_amount = 0,
        status = 'PART_SETTLED',
        updated_at = TIMESTAMPTZ '2026-07-14 02:00:00+00'
    WHERE id = ${sqlLiteral(fixtures.tenant.positiveId)}::uuid;
    UPDATE ${q}.sales_out
    SET total_amount = 10.00,
        updated_at = TIMESTAMPTZ '2026-07-14 02:00:01+00',
        version = version + 1
    WHERE id = ${sqlLiteral(restoreFixture.salesOutId)}::uuid;
    UPDATE ${q}.sales_out_line
    SET qty = 1.0000, amount = 10.00, price_tax_total = 10.00
    WHERE id = ${sqlLiteral(restoreFixture.salesOutLineId)}::uuid;
    DELETE FROM ${q}.md_import_batch
    WHERE id IN (
      ${sqlLiteral(restoreFixture.unsubmittedImportBatchId)}::uuid,
      ${sqlLiteral(restoreFixture.committedImportBatchId)}::uuid
    );
    COMMIT;
  `);
  return restoreSemanticSnapshot(tenantSchema);
}

async function reserveHttpPort() {
  const server = http.createServer((_request, response) => response.end());
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  assert(port > 0, "failed to reserve isolated backend port");
  return port;
}

async function tailFile(filePath, maximumLength = 12_000) {
  try {
    return (await readFile(filePath, "utf8")).slice(-maximumLength);
  } catch {
    return "";
  }
}

function processGroupIsAlive(processInfo) {
  if (!Number.isInteger(processInfo?.child?.pid)) {
    return false;
  }
  try {
    process.kill(-processInfo.child.pid, 0);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    if (error?.code === "EPERM") return true;
    throw error;
  }
}

async function waitForProcessGroupExit(processInfo, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (processGroupIsAlive(processInfo) && Date.now() < deadline) {
    await sleep(100);
  }
  return !processGroupIsAlive(processInfo);
}

async function stopBackend(processInfo) {
  if (!processInfo || processInfo.stopped) return;
  if (processInfo.stopPromise) return processInfo.stopPromise;
  processInfo.stopPromise = (async () => {
    if (!processGroupIsAlive(processInfo)) {
      processInfo.stopped = true;
      return;
    }
    try {
      process.kill(-processInfo.child.pid, "SIGTERM");
    } catch (error) {
      if (error?.code !== "ESRCH") throw error;
    }
    if (!await waitForProcessGroupExit(processInfo, 8_000)) {
      processInfo.forcedKill = true;
      try {
        process.kill(-processInfo.child.pid, "SIGKILL");
      } catch (error) {
        if (error?.code !== "ESRCH") throw error;
      }
      await waitForProcessGroupExit(processInfo, 3_000);
    }
    assert(!processGroupIsAlive(processInfo), `${processInfo.name} process group did not terminate`);
    processInfo.stopped = true;
  })();
  return processInfo.stopPromise;
}

async function startBackend() {
  const port = await reserveHttpPort();
  const name = `a142-migration-${token}`;
  const logPath = path.join(isolationDir, `${name}.log`);
  const logFile = await open(logPath, "w");
  const env = {
    ...process.env,
    JAVA_HOME: process.env.JAVA_HOME || "/opt/homebrew/opt/openjdk@21",
    JDY_SERVER_PORT: String(port),
    JDY_DB_URL: `jdbc:postgresql://127.0.0.1:5432/${upgradeDatabase}`,
    JDY_DB_USERNAME: databaseUser,
    JDY_DB_PASSWORD: databasePassword,
    JDY_REDIS_HOST: "127.0.0.1",
    JDY_REDIS_PORT: "6379",
    SPRING_SESSION_REDIS_NAMESPACE: redisNamespace,
    JDY_PASSWORD_RESET_REDIS_KEY_PREFIX: passwordResetRedisPrefix,
    JDY_PASSWORD_RESET_CLEANUP_FIXED_DELAY_MS: "3600000",
    JDY_PASSWORD_RESET_CLEANUP_INITIAL_DELAY_MS: "3600000"
  };
  delete env.SPRING_PROFILES_DEFAULT;
  delete env.SPRING_PROFILES_INCLUDE;
  delete env.SPRING_APPLICATION_JSON;
  const child = spawn("./mvnw", ["spring-boot:run"], {
    cwd: path.join(rootDir, "backend"),
    env,
    detached: true,
    stdio: ["ignore", logFile.fd, logFile.fd]
  });
  const processInfo = {
    name,
    port,
    baseUrl: `http://127.0.0.1:${port}`,
    logPath,
    child,
    spawnError: null,
    stopped: false,
    forcedKill: false
  };
  processes.push(processInfo);
  child.once("error", (error) => {
    processInfo.spawnError = error;
  });
  await logFile.close();
  for (let attempt = 1; attempt <= 240; attempt += 1) {
    if (processInfo.spawnError) throw processInfo.spawnError;
    if (processInfo.child.exitCode != null) {
      throw new Error(`${name} exited before health check:\n${await tailFile(logPath)}`);
    }
    try {
      const response = await fetch(`${processInfo.baseUrl}/api/system/health`, {
        signal: AbortSignal.timeout(1_000)
      });
      if (response.ok) {
        result.processes.push({ name, port, log: path.relative(rootDir, logPath) });
        return processInfo;
      }
    } catch {
      // Backend compilation/startup is still in progress.
    }
    await sleep(500);
  }
  throw new Error(`${name} did not become healthy:\n${await tailFile(logPath)}`);
}

async function apiRequest(baseUrl, cookie, pathname, options = {}) {
  const headers = new Headers(options.headers ?? {});
  if (cookie) headers.set("Cookie", cookie);
  const response = await fetch(`${baseUrl}${pathname}`, {
    method: options.method ?? "GET",
    headers,
    body: options.body,
    signal: AbortSignal.timeout(options.timeoutMs ?? 60_000)
  });
  const text = await response.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { text };
  }
  return { status: response.status, data, text };
}

function redisNamespaceKeys() {
  const keys = new Set();
  for (const pattern of [`${redisNamespace}:*`, `${passwordResetRedisPrefix}:*`]) {
    const output = execFileSync(
      "docker",
      ["exec", redisContainer, "redis-cli", "--raw", "--scan", "--pattern", pattern],
      { encoding: "utf8" }
    ).trim();
    for (const key of output ? output.split(/\r?\n/).filter(Boolean) : []) keys.add(key);
  }
  return [...keys].sort();
}

function clearRedisNamespace() {
  const keys = redisNamespaceKeys();
  for (const key of keys) {
    execFileSync("docker", ["exec", redisContainer, "redis-cli", "DEL", key], { encoding: "utf8" });
  }
  return keys.length;
}

function exitLastResort() {
  for (const processInfo of [...processes].reverse()) {
    if (!processGroupIsAlive(processInfo)) continue;
    try {
      process.kill(-processInfo.child.pid, "SIGKILL");
      processInfo.forcedKill = true;
    } catch (error) {
      if (error?.code !== "ESRCH") {
        // The asynchronous cleanup path records actionable failures.
      }
    }
  }
}

function cleanup() {
  if (cleanupPromise) return cleanupPromise;
  cleanupPromise = (async () => {
    for (const processInfo of [...processes].reverse()) {
      try {
        await stopBackend(processInfo);
      } catch (error) {
        result.cleanup.errors.push(`stop ${processInfo.name}: ${errorText(error)}`);
      }
    }
    exitLastResort();
    try {
      result.cleanup.redisKeysDeleted = clearRedisNamespace();
      result.cleanup.redisKeysRemaining = redisNamespaceKeys().length;
      assert(result.cleanup.redisKeysRemaining === 0, `isolated Redis residue remains: ${result.cleanup.redisKeysRemaining}`);
    } catch (error) {
      result.cleanup.errors.push(`Redis cleanup: ${errorText(error)}`);
    }
    for (const database of [upgradeDatabase, freshDatabase]) {
      try {
        dropDatabase(database);
      } catch (error) {
        result.cleanup.errors.push(`drop ${database}: ${errorText(error)}`);
      }
    }
    try {
      const residue = sqlJson("postgres", `
        SELECT COALESCE(jsonb_agg(datname ORDER BY datname), '[]'::jsonb)::text
        FROM pg_database
        WHERE datname IN (${sqlLiteral(upgradeDatabase)}, ${sqlLiteral(freshDatabase)})
      `);
      result.cleanup.databases = {
        [upgradeDatabase]: residue.includes(upgradeDatabase),
        [freshDatabase]: residue.includes(freshDatabase),
        residue
      };
      assert(residue.length === 0, `isolated database residue remains: ${JSON.stringify(residue)}`);
    } catch (error) {
      result.cleanup.errors.push(`database residue: ${errorText(error)}`);
    }
    result.cleanup.processResidue = processes
      .filter((processInfo) => processGroupIsAlive(processInfo))
      .map((processInfo) => processInfo.name);
    result.cleanup.forcedProcessKills = processes
      .filter((processInfo) => processInfo.forcedKill)
      .map((processInfo) => processInfo.name);
    if (result.cleanup.processResidue.length > 0) {
      result.cleanup.errors.push(`process residue remains: ${result.cleanup.processResidue.join(", ")}`);
    }
  })();
  return cleanupPromise;
}

const signalExitCodes = new Map([["SIGHUP", 129], ["SIGINT", 130], ["SIGTERM", 143]]);
const signalHandlers = new Map();
function removeLifecycleHandlers() {
  for (const [signal, handler] of signalHandlers) process.removeListener(signal, handler);
  process.removeListener("exit", exitLastResort);
}
for (const [signal, exitCode] of signalExitCodes) {
  const handler = () => {
    if (signalBeingHandled) return;
    signalBeingHandled = signal;
    primaryError ??= new Error(`received ${signal}`);
    process.exitCode = exitCode;
    void cleanup().finally(async () => {
      result.ok = false;
      result.failure = errorText(primaryError);
      await writeFile(resultPath, `${JSON.stringify(result, null, 2)}\n`);
      removeLifecycleHandlers();
      process.exit(exitCode);
    });
  };
  signalHandlers.set(signal, handler);
  process.on(signal, handler);
}
process.on("exit", exitLastResort);

try {
  createDatabase(upgradeDatabase);
  result.upgrade.target102 = flyway(upgradeDatabase, 102);
  const targetHistory = history(upgradeDatabase);
  assert(targetHistory.at(-1)?.version === "102", "upgrade database did not stop at V102", targetHistory.at(-1));
  createTenant();
  seedV102();
  createBackup();
  const before = {
    public: receivableSnapshot("public", fixtures.public, false),
    tenant: receivableSnapshot(tenantSchema, fixtures.tenant, false),
    backup: receivableSnapshot(backupSchema, fixtures.tenant, false)
  };
  assert(same(before.tenant, before.backup), "V102 backup does not match tenant receivables");

  result.upgrade.target104 = flyway(upgradeDatabase, 104);
  const migratedHistory = history(upgradeDatabase);
  const v103 = migratedHistory.filter((row) => row.version === "103");
  const v104 = migratedHistory.filter((row) => row.version === "104");
  assert(v103.length === 1 && v103[0].success === true, "V103 history row missing or failed", v103);
  assert(v104.length === 1 && v104[0].success === true, "V104 history row missing or failed", v104);
  assert(migratedHistory.at(-1)?.version === "104", "historical upgrade phase must stop at V104", migratedHistory.at(-1));
  const after = {
    public: receivableSnapshot("public", fixtures.public, true),
    tenant: receivableSnapshot(tenantSchema, fixtures.tenant, true),
    backup: receivableSnapshot(backupSchema, fixtures.tenant, true)
  };
  for (const [schema, rows] of Object.entries(after)) {
    assert(rows.length === 3, `${schema} should preserve all positive/zero/negative AR rows`, rows);
    assert(rows.every((row) => row.offset === "0.00"), `${schema} should backfill every return offset to zero`, rows);
    assert(rows.some((row) => row.amount === "-25.00"), `${schema} negative AR was not preserved`, rows);
    assert(rows.some((row) => row.amount === "0.00"), `${schema} zero AR was not preserved`, rows);
  }
  assert(same(after.tenant, after.backup), "V103 tenant/backup AR semantics differ");
  const shapes = {
    public: shapeSnapshot("public", true),
    tenant: shapeSnapshot(tenantSchema, true),
    backup: shapeSnapshot(backupSchema, false)
  };
  assert(shapes.public.tables === 3 && shapes.tenant.tables === 3 && shapes.backup.tables === 3, "V103 did not create three return tables in every schema", shapes);
  assert(shapes.public.offsetColumn === 1 && shapes.tenant.offsetColumn === 1 && shapes.backup.offsetColumn === 1, "V103 offset column missing", shapes);
  assert(shapes.public.rows === 0 && shapes.tenant.rows === 0 && shapes.backup.rows === 0, "V103 unexpectedly invented return rows", shapes);
  assert(shapes.public.constraints > 0 && shapes.tenant.constraints > 0 && shapes.backup.constraints === 0, "V103 managed/backup constraint modes differ from contract", shapes);
  const importShapes = {
    public: importBatchShape("public", true),
    tenant: importBatchShape(tenantSchema, true),
    backup: importBatchShape(backupSchema, false)
  };
  assert(
    importShapes.public.tables === 1 && importShapes.tenant.tables === 1 && importShapes.backup.tables === 1,
    "V104 did not create one import batch table in every schema",
    importShapes
  );
  assert(
    importShapes.public.rows === 0 && importShapes.tenant.rows === 0 && importShapes.backup.rows === 0,
    "V104 unexpectedly invented import batches",
    importShapes
  );
  assert(
    importShapes.public.constraints > 0 && importShapes.tenant.constraints > 0 && importShapes.backup.constraints === 0,
    "V104 managed/backup constraint modes differ from contract",
    importShapes
  );
  assert(
    importShapes.public.foreignKeys === 0 && importShapes.tenant.foreignKeys === 0 && importShapes.backup.foreignKeys === 0,
    "V104 added a forbidden import-batch FK exemption",
    importShapes
  );
  const managedCount = Number(psql(upgradeDatabase, "SELECT count(*) FROM public.sys_tenant_managed_table"));
  assert(managedCount === 82, `V104 managed table count should be 82, got ${managedCount}`);
  result.upgrade = {
    ...result.upgrade,
    history: v104[0], salesReturnHistory: v103[0], managedCount, shapes, importShapes,
    beforeDigests: Object.fromEntries(Object.entries(before).map(([key, value]) => [key, digest(value)])),
    afterDigests: Object.fromEntries(Object.entries(after).map(([key, value]) => [key, digest(value)])),
    negativeAndZeroReceivablesPreserved: true
  };

  result.upgrade.latestFlywayOutput = flyway(upgradeDatabase);
  const latestHistory = history(upgradeDatabase);
  const latestMigrations = assertPublishedMigrationHistory(latestHistory, "A142 upgrade history");
  const currentHeadRows = latestHistory.filter((row) => row.version === migrationHead.version);
  const latestNumbering = numberingLatestMetrics(upgradeDatabase);
  assert(currentHeadRows.length === 1 && currentHeadRows[0].success === true && currentHeadRows[0].script === migrationHead.script, "repository current head row missing or failed", { expected: migrationHead, actual: currentHeadRows });
  assert(latestHistory.at(-1)?.version === migrationHead.version, `repository latest upgrade must end at V${migrationHead.version}`, latestHistory.at(-1));
  assert(
    Number(latestNumbering.publicChecks) === 117
      && Number(latestNumbering.tenantChecks) === 117
      && Number(latestNumbering.versionCopies) === 3
      && Number(latestNumbering.legacyRows) === 0,
    "V111 managed topology / V105 numbering shape mismatch",
    latestNumbering
  );
  assert(same(after, {
    public: receivableSnapshot("public", fixtures.public, true),
    tenant: receivableSnapshot(tenantSchema, fixtures.tenant, true),
    backup: receivableSnapshot(backupSchema, fixtures.tenant, true)
  }), "V105 must preserve V103/V104 sales-return semantics");
  result.upgrade.latestHistory = currentHeadRows[0];
  result.upgrade.currentMigrationHead = migrationHead;
  result.upgrade.latestMigrations = latestMigrations;
  result.upgrade.latestNumbering = latestNumbering;

  const repeatHistoryBefore = latestHistory;
  const repeatSnapshotBefore = { rows: after, shapes, importShapes, numbering: latestNumbering };
  result.repeat.flywayOutput = flyway(upgradeDatabase);
  const repeatHistoryAfter = history(upgradeDatabase);
  const syncCounts = [
    Number(psql(upgradeDatabase, `SELECT public.jdy_sync_tenant_schema(${sqlLiteral(tenantSchema)}, FALSE)`)),
    Number(psql(upgradeDatabase, `SELECT public.jdy_sync_tenant_schema(${sqlLiteral(tenantSchema)}, FALSE)`))
  ];
  const repeatSnapshotAfter = {
    rows: {
      public: receivableSnapshot("public", fixtures.public, true),
      tenant: receivableSnapshot(tenantSchema, fixtures.tenant, true),
      backup: receivableSnapshot(backupSchema, fixtures.tenant, true)
    },
    shapes: {
      public: shapeSnapshot("public", true),
      tenant: shapeSnapshot(tenantSchema, true),
      backup: shapeSnapshot(backupSchema, false)
    },
    importShapes: {
      public: importBatchShape("public", true),
      tenant: importBatchShape(tenantSchema, true),
      backup: importBatchShape(backupSchema, false)
    },
    numbering: numberingLatestMetrics(upgradeDatabase)
  };
  assert(same(repeatHistoryBefore, repeatHistoryAfter), "repeat Flyway changed migration history");
  assert(same(syncCounts, [89, 89]), "repeat tenant sync did not return 89/89", syncCounts);
  assert(same(repeatSnapshotBefore, repeatSnapshotAfter), "repeat Flyway/sync changed V103/V104 semantics");
  result.repeat = { ...result.repeat, syncCounts, historyDigest: digest(repeatHistoryAfter), semanticDigest: digest(repeatSnapshotAfter) };

  assert(redisNamespaceKeys().length === 0, "isolated Redis namespace was not empty before backend startup");
  seedRestoreFixture();
  const semanticBeforeBackup = restoreSemanticSnapshot(tenantSchema);
  const importBatchesBeforeBackup = importBatchSnapshot(tenantSchema);
  assert(
    semanticBeforeBackup.factCounts.headers === 1
      && semanticBeforeBackup.factCounts.lines === 1
      && semanticBeforeBackup.factCounts.allocations === 1,
    "non-empty sales return restore fixture was not created",
    semanticBeforeBackup.factCounts
  );
  assert(semanticBeforeBackup.returnHeader?.status === "AUDITED", "restore fixture header must be audited", semanticBeforeBackup.returnHeader);
  assert(semanticBeforeBackup.returnHeader?.currency === "USD", "restore fixture must prove USD preservation", semanticBeforeBackup.returnHeader);
  assert(semanticBeforeBackup.receivable?.returnOffsetAmount === "60.00", "restore fixture AR offset mismatch", semanticBeforeBackup.receivable);
  assert(semanticBeforeBackup.allocation?.offsetAmount === "60.00", "restore fixture allocation offset mismatch", semanticBeforeBackup.allocation);
  assert(semanticBeforeBackup.allocation?.pendingRefundAmount === "10.00", "restore fixture pending refund mismatch", semanticBeforeBackup.allocation);
  assert(
    importBatchesBeforeBackup.length === 2
      && importBatchesBeforeBackup.some((row) => row.status === "VALIDATED")
      && importBatchesBeforeBackup.some((row) => row.status === "COMMITTED"),
    "import batch restore fixtures were not created",
    importBatchesBeforeBackup
  );

  const backend = await startBackend();
  let cookie = null;
  try {
    cookie = await loginApi(backend.baseUrl, "admin", "admin123", tenantCode);
    const session = await apiRequest(backend.baseUrl, cookie, "/api/system/session");
    assert(session.status === 200 && session.data?.tenant?.code === tenantCode, `isolated tenant session failed: ${session.text}`);

    const backupResponse = await apiRequest(
      backend.baseUrl,
      cookie,
      "/api/system/account-sets/current/backups",
      { method: "POST", timeoutMs: 120_000 }
    );
    assert(backupResponse.status === 200 && backupResponse.data?.ok === true, `formal backup API failed ${backupResponse.status}: ${backupResponse.text}`);
    const formalBackup = backupResponse.data?.backup;
    assert(formalBackup?.id && formalBackup?.backupName && formalBackup?.backupSchemaName, `formal backup response incomplete: ${backupResponse.text}`);
    assert(Number(formalBackup.tableCount) === 89, "formal backup did not copy all 89 managed tables", formalBackup);
    assert(/^[0-9a-f-]{36}$/i.test(String(formalBackup.id)), "formal backup id is not a UUID", formalBackup);
    quoteIdentifier(String(formalBackup.backupSchemaName));

    const semanticInBackup = restoreSemanticSnapshot(String(formalBackup.backupSchemaName));
    assert(same(semanticInBackup, semanticBeforeBackup), "formal backup semantic summary differs from tenant before mutation", {
      tenantDigest: digest(semanticBeforeBackup),
      backupDigest: digest(semanticInBackup)
    });
    const backupShape = shapeSnapshot(String(formalBackup.backupSchemaName), false);
    assert(backupShape.rows === 1 && backupShape.constraints === 0, "formal backup return table shape mismatch", backupShape);
    const importBatchesInBackup = importBatchSnapshot(String(formalBackup.backupSchemaName));
    assert(same(importBatchesInBackup, importBatchesBeforeBackup), "formal backup changed import batch facts", {
      tenant: importBatchesBeforeBackup,
      backup: importBatchesInBackup
    });
    const importBackupShape = importBatchShape(String(formalBackup.backupSchemaName), false);
    assert(importBackupShape.rows === 2 && importBackupShape.constraints === 0, "formal backup import batch shape mismatch", importBackupShape);

    const mutated = mutateRestoreFixture();
    const mutatedImportBatches = importBatchSnapshot(tenantSchema);
    assert(!same(mutated, semanticInBackup), "tenant mutation did not change restore semantics");
    assert(
      mutated.factCounts.headers === 0
        && mutated.factCounts.lines === 0
        && mutated.factCounts.allocations === 0,
      "tenant mutation did not destroy all return facts",
      mutated.factCounts
    );
    assert(mutated.receivable?.returnOffsetAmount === "0.00", "tenant mutation did not clear AR return offset", mutated.receivable);
    assert(mutatedImportBatches.length === 0, "tenant mutation did not remove import batches", mutatedImportBatches);

    const restoreResponse = await apiRequest(
      backend.baseUrl,
      cookie,
      `/api/system/account-sets/current/backups/${encodeURIComponent(formalBackup.backupName)}/restore`,
      { method: "POST", timeoutMs: 120_000 }
    );
    assert(restoreResponse.status === 200 && restoreResponse.data?.ok === true, `formal restore API failed ${restoreResponse.status}: ${restoreResponse.text}`);
    const semanticAfterRestore = restoreSemanticSnapshot(tenantSchema);
    const importBatchesAfterRestore = importBatchSnapshot(tenantSchema);
    assert(same(semanticAfterRestore, semanticInBackup), "formal restore API did not exactly restore A142 semantic summary", {
      restoredDigest: digest(semanticAfterRestore),
      backupDigest: digest(semanticInBackup)
    });
    const restoredUnsubmitted = importBatchesAfterRestore.find((row) => row.id === restoreFixture.unsubmittedImportBatchId);
    const restoredCommitted = importBatchesAfterRestore.find((row) => row.id === restoreFixture.committedImportBatchId);
    assert(
      restoredUnsubmitted?.status === "EXPIRED"
        && same(restoredUnsubmitted.payload, [])
        && restoredUnsubmitted.payloadCleared === true
        && Number(restoredUnsubmitted.version) === 1,
      "restore did not expire and clear the unsubmitted import batch",
      restoredUnsubmitted
    );
    assert(
      restoredCommitted?.status === "COMMITTED"
        && same(restoredCommitted.payload, [])
        && restoredCommitted.payloadCleared === true
        && Number(restoredCommitted.version) === 0,
      "restore changed the committed import result",
      restoredCommitted
    );
    const restoreMetadata = sqlJson(upgradeDatabase, `
      SELECT jsonb_build_object(
        'restoredAtSet', restored_at IS NOT NULL,
        'restoredBySet', restored_by IS NOT NULL,
        'backupName', backup_name,
        'backupSchema', backup_schema_name,
        'tableCount', table_count,
        'rowCount', row_count
      )::text
      FROM public.sys_account_set_backup
      WHERE id = ${sqlLiteral(formalBackup.id)}::uuid
    `);
    assert(restoreMetadata?.restoredAtSet === true && restoreMetadata?.restoredBySet === true, "formal restore metadata was not updated", restoreMetadata);
    assert(restoreMetadata?.backupName === formalBackup.backupName && restoreMetadata?.backupSchema === formalBackup.backupSchemaName, "formal restore metadata identity mismatch", restoreMetadata);
    result.restoreApi = {
      backupStatus: backupResponse.status,
      restoreStatus: restoreResponse.status,
      backupId: formalBackup.id,
      backupName: formalBackup.backupName,
      backupSchema: formalBackup.backupSchemaName,
      tableCount: Number(formalBackup.tableCount),
      rowCount: Number(formalBackup.rowCount),
      beforeDigest: digest(semanticBeforeBackup),
      backupDigest: digest(semanticInBackup),
      mutatedDigest: digest(mutated),
      restoredDigest: digest(semanticAfterRestore),
      exactSemanticBackup: true,
      exactSemanticRestore: true,
      importBatches: {
        beforeBackup: importBatchesBeforeBackup,
        inBackup: importBatchesInBackup,
        afterRestore: importBatchesAfterRestore,
        unsubmittedExpired: true,
        committedPreserved: true
      },
      facts: semanticAfterRestore,
      mutation: {
        factCounts: mutated.factCounts,
        returnOffsetAmount: mutated.receivable?.returnOffsetAmount,
        sourceTotalAmount: mutated.source?.totalAmount
      },
      metadata: restoreMetadata
    };
  } finally {
    if (cookie) {
      const logout = await apiRequest(backend.baseUrl, cookie, "/api/system/logout", { method: "POST", timeoutMs: 10_000 }).catch(() => null);
      result.restoreApi.logoutStatus = logout?.status ?? null;
    }
    await stopBackend(backend);
  }

  createDatabase(freshDatabase);
  result.fresh.flywayOutput = flyway(freshDatabase);
  const freshHistory = history(freshDatabase);
  const sourceScripts = migrationHead.sourceScripts;
  assertPublishedMigrationHistory(freshHistory, "A142 fresh history");
  const freshCurrentHeadRows = freshHistory.filter((row) => row.version === migrationHead.version);
  assert(freshHistory.every((row) => row.success === true), "fresh history contains a failed migration", freshHistory);
  assert(same(freshHistory.map((row) => row.script), sourceScripts), "fresh history differs from migration source set");
  assert(freshCurrentHeadRows.length === 1 && freshCurrentHeadRows[0].success === true && freshCurrentHeadRows[0].script === migrationHead.script, "fresh current head row missing or failed", { expected: migrationHead, actual: freshCurrentHeadRows });
  const freshMetrics = sqlJson(freshDatabase, `
    SELECT jsonb_build_object(
      'managedTables', (SELECT count(*) FROM public.sys_tenant_managed_table),
      'returnTables', (SELECT count(*) FROM information_schema.tables WHERE table_schema='public' AND table_name IN ('sales_return','sales_return_line','sales_return_finance_allocation')),
      'offsetColumn', (SELECT count(*) FROM information_schema.columns WHERE table_schema='public' AND table_name='ar_receivable' AND column_name='return_offset_amount'),
      'importBatchTables', (SELECT count(*) FROM information_schema.tables WHERE table_schema='public' AND table_name='md_import_batch'),
      'returnRows', (SELECT count(*) FROM public.sales_return),
      'managedChecks', (
        SELECT count(*) FROM pg_constraint constraint_row
        JOIN pg_class table_row ON table_row.oid=constraint_row.conrelid
        JOIN pg_namespace schema_row ON schema_row.oid=table_row.relnamespace
        JOIN public.sys_tenant_managed_table managed ON managed.table_name=table_row.relname
        WHERE schema_row.nspname='public' AND constraint_row.contype='c'
      ),
      'numberingVersionType', (
        SELECT data_type FROM information_schema.columns
        WHERE table_schema='public' AND table_name='document_number_sequence' AND column_name='version'
      )
    )::text
  `);
  assert(freshHistory.at(-1)?.version === migrationHead.version, `fresh migration max version should be V${migrationHead.version}`, freshHistory.at(-1));
  assert(
    freshMetrics.managedTables === 89
      && freshMetrics.returnTables === 3
      && freshMetrics.offsetColumn === 1
      && freshMetrics.importBatchTables === 1
      && freshMetrics.returnRows === 0
      && freshMetrics.managedChecks === 117
      && freshMetrics.numberingVersionType === "bigint",
    "fresh topology/numbering metrics mismatch after V111",
    freshMetrics
  );
  result.fresh = { ...result.fresh, historyCount: freshHistory.length, maxVersion: freshHistory.at(-1)?.version, currentMigrationHead: migrationHead, metrics: freshMetrics };
} catch (error) {
  primaryError = error;
  result.failure = errorText(error);
} finally {
  await cleanup();
  result.ok = primaryError == null
    && result.cleanup.errors.length === 0
    && result.restoreApi.exactSemanticRestore === true;
  await writeFile(resultPath, `${JSON.stringify(result, null, 2)}\n`);
  removeLifecycleHandlers();
}

if (primaryError) throw primaryError;
if (result.cleanup.errors.length) throw new Error(result.cleanup.errors.join("; "));

console.log(JSON.stringify({
  ok: result.ok,
  result: path.relative(rootDir, resultPath),
  upgrade: { historicalVersion: result.upgrade.history?.version, latestVersion: result.upgrade.latestHistory?.version, managedCount: result.upgrade.managedCount },
  repeat: result.repeat.syncCounts,
  restoreApi: {
    backupStatus: result.restoreApi.backupStatus,
    restoreStatus: result.restoreApi.restoreStatus,
    exactSemanticRestore: result.restoreApi.exactSemanticRestore,
    digest: result.restoreApi.restoredDigest
  },
  fresh: { maxVersion: result.fresh.maxVersion, metrics: result.fresh.metrics },
  cleanup: result.cleanup
}, null, 2));
