#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";

const rootDir = path.resolve(import.meta.dirname, "..");
const migrationDir = path.join(rootDir, "backend/src/main/resources/db/migration");
const v119Path = path.join(migrationDir, "V119__registered_tenant_and_red_payable_reversal_hardening.sql");
const v120Path = path.join(migrationDir, "V120__red_payable_reversal_shape_guard.sql");
const resultPath = path.join(rootDir, "verification/a167-production-plan-multi-line-migration-regression.json");
const container = process.env.JDY_POSTGRES_CONTAINER || "jdy-erp-postgres";
const databaseUser = process.env.JDY_DATABASE_USER || "jdy";
const databasePassword = process.env.JDY_DATABASE_PASSWORD || "jdy_dev";
const token = randomBytes(6).toString("hex");
const upgradeDatabase = `jdy_a167_mig_${token}`;
const freshDatabase = `jdy_a167_fresh_${token}`;
const tenantSchema = `tenant_a167_${token}`;
const inactiveTenantSchema = `tenant_a167_inactive_${token}`;
const backupSchema = `bk_a167_${token}`;
const tenantId = randomUUID();
const inactiveTenantId = randomUUID();
const backupId = randomUUID();
const supplierId = randomUUID();
const sourceAccountId = randomUUID();
const targetAccountId = randomUUID();
const cashTransferId = randomUUID();
const normalPurchaseInId = randomUUID();
const redOriginalPurchaseInId = randomUUID();
const redPurchaseInId = randomUUID();
const purchaseReturnId = randomUUID();
const redDecoyPayableId = randomUUID();
const preexistingRedPayableId = randomUUID();
const unsafePurchaseReturnId = randomUUID();
const unsafePayableId = randomUUID();
const categoryId = randomUUID();
const unitId = randomUUID();
const warehouseId = randomUUID();
const productId = randomUUID();
const bomId = randomUUID();
const draftRequisitionLineId = randomUUID();
const auditedRequisitionLineId = randomUUID();
const draftPurchasePlanId = randomUUID();
const auditedPurchasePlanId = randomUUID();
const legacyPlanNo = `SCJH-A167-${token.toUpperCase()}`;
const normalPurchaseInNo = `RK-A167-${token.toUpperCase()}`;
const redOriginalPurchaseInNo = `RK-A167-RED-SRC-${token.toUpperCase()}`;
const redPurchaseInNo = `HC-RK-A167-${token.toUpperCase()}`;
const purchaseReturnNo = `TH-A167-${token.toUpperCase()}`;
const cashTransferNo = `ZZ-A167-${token.toUpperCase()}`;
const normalReversalBillNo = `YF-CX-${normalPurchaseInNo}`;
const redMainPayableBillNo = `YF-HC-${javaShortHash(redPurchaseInNo)}`;
const redReversalBillNo = `YF-HC-CX-${javaShortHash(redPurchaseInNo)}`;
const returnReversalBillNo = `YF-TH-CX-${purchaseReturnNo}`;
const redDecoyBillNo = `YF-HC-CX-WRONG-${token.toUpperCase()}`;
const preexistingRedBillNo = `YF-HC-CX-OLD-${token.toUpperCase()}`;
const unsafePurchaseReturnNo = `TH-A167-UNSAFE-${token.toUpperCase()}`;
const result = {
  ok: false,
  generatedAt: new Date().toISOString(),
  token,
  assertions: [],
  upgrade: {},
  fresh: {},
  cleanup: { databases: {}, residue: [] },
  failure: null
};

await mkdir(path.dirname(resultPath), { recursive: true });

function assert(condition, message, details = undefined) {
  if (!condition) throw new Error(`${message}${details === undefined ? "" : ` ${JSON.stringify(details)}`}`);
  result.assertions.push({ message, details });
}

function literal(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function javaShortHash(value) {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = (Math.imul(hash, 31) + value.charCodeAt(index)) | 0;
  }
  return (hash >>> 0).toString(36).toUpperCase();
}

function identifier(value) {
  const normalized = String(value);
  assert(/^[a-z][a-z0-9_]{0,62}$/.test(normalized), `unsafe identifier ${normalized}`);
  return `"${normalized}"`;
}

function safeDatabase(database) {
  assert(/^jdy_a167_(?:mig|fresh)_[a-f0-9]{12}$/.test(database), `unsafe database ${database}`);
  return database;
}

function psql(database, statement) {
  return execFileSync(
    "docker",
    ["exec", container, "psql", "-X", "-v", "ON_ERROR_STOP=1", "-U", databaseUser, "-d", safeDatabase(database), "-tAq", "-c", statement],
    { encoding: "utf8", maxBuffer: 30 * 1024 * 1024 }
  ).trim();
}

async function psqlFile(database, file) {
  const statement = await readFile(file, "utf8");
  return execFileSync(
    "docker",
    ["exec", container, "psql", "-X", "-v", "ON_ERROR_STOP=1", "-U", databaseUser, "-d", safeDatabase(database), "-tAq", "-c", statement],
    { encoding: "utf8", maxBuffer: 30 * 1024 * 1024 }
  ).trim();
}

async function expectPsqlFileFailure(database, file, messagePattern) {
  try {
    await psqlFile(database, file);
  } catch (error) {
    const output = `${String(error?.stdout ?? "")}\n${String(error?.stderr ?? "")}\n${String(error)}`;
    assert(messagePattern.test(output), "expected migration refusal was not reported", output.split(/\r?\n/).slice(-20));
    return output.split(/\r?\n/).filter(Boolean).slice(-12);
  }
  throw new Error(`migration ${path.basename(file)} unexpectedly accepted an unsafe fixture`);
}

function json(database, statement) {
  const output = psql(database, statement);
  return output ? JSON.parse(output) : null;
}

function createDatabase(database) {
  execFileSync("docker", ["exec", container, "createdb", "-U", databaseUser, "-O", databaseUser, safeDatabase(database)], { encoding: "utf8" });
}

function dropDatabase(database) {
  execFileSync("docker", ["exec", container, "dropdb", "-U", databaseUser, "--if-exists", "--force", safeDatabase(database)], { encoding: "utf8" });
}

function flyway(database, target = null) {
  const args = [
    "org.flywaydb:flyway-maven-plugin:11.7.2:migrate",
    `-Dflyway.url=jdbc:postgresql://127.0.0.1:5432/${safeDatabase(database)}`,
    `-Dflyway.user=${databaseUser}`,
    `-Dflyway.password=${databasePassword}`,
    `-Dflyway.locations=filesystem:${migrationDir}`
  ];
  if (target != null) args.push(`-Dflyway.target=${target}`);
  try {
    return execFileSync("./scripts/backend-test.sh", args, {
      cwd: rootDir,
      encoding: "utf8",
      maxBuffer: 40 * 1024 * 1024
    }).trim().split(/\r?\n/).slice(-12);
  } catch (error) {
    const stdout = String(error?.stdout ?? "").trim().split(/\r?\n/).slice(-40).join("\n");
    const stderr = String(error?.stderr ?? "").trim().split(/\r?\n/).slice(-40).join("\n");
    throw new Error(`Flyway migration failed for ${safeDatabase(database)}${target == null ? "" : ` at target ${target}`}\nstdout:\n${stdout}\nstderr:\n${stderr}`, { cause: error });
  }
}

function expectFlywayFailure(database, messagePattern) {
  const args = [
    "org.flywaydb:flyway-maven-plugin:11.7.2:migrate",
    `-Dflyway.url=jdbc:postgresql://127.0.0.1:5432/${safeDatabase(database)}`,
    `-Dflyway.user=${databaseUser}`,
    `-Dflyway.password=${databasePassword}`,
    `-Dflyway.locations=filesystem:${migrationDir}`
  ];
  try {
    execFileSync("./scripts/backend-test.sh", args, {
      cwd: rootDir,
      encoding: "utf8",
      maxBuffer: 40 * 1024 * 1024
    });
  } catch (error) {
    const output = `${String(error?.stdout ?? "")}\n${String(error?.stderr ?? "")}\n${String(error)}`;
    assert(messagePattern.test(output), "expected Flyway refusal was not reported", output.split(/\r?\n/).slice(-40));
    return output.split(/\r?\n/).filter(Boolean).slice(-20);
  }
  throw new Error(`Flyway unexpectedly accepted a migration fixture in ${safeDatabase(database)}`);
}

function topology(database, schema) {
  return json(database, `
    SELECT jsonb_build_object(
      'tables', (SELECT count(*) FROM public.sys_tenant_managed_table),
      'pk', count(*) FILTER (WHERE constraint_row.contype='p'),
      'uk', count(*) FILTER (WHERE constraint_row.contype='u'),
      'fk', count(*) FILTER (WHERE constraint_row.contype='f'),
      'check', count(*) FILTER (WHERE constraint_row.contype='c')
    )::text
    FROM pg_constraint constraint_row
    JOIN pg_class table_row ON table_row.oid=constraint_row.conrelid
    JOIN pg_namespace schema_row ON schema_row.oid=table_row.relnamespace
    JOIN public.sys_tenant_managed_table managed ON managed.table_name=table_row.relname
    WHERE schema_row.nspname=${literal(schema)}
  `);
}

function lifecycleSemantics(database, schema) {
  return json(database, `
    SELECT jsonb_build_object(
      'postingVersionColumns', (
        SELECT count(*) FROM information_schema.columns
        WHERE table_schema=${literal(schema)} AND table_name='cash_transfer_fact' AND column_name='posting_version'
      ),
      'postingVersionNotNull', COALESCE((
        SELECT attribute.attnotnull
        FROM pg_attribute attribute
        WHERE attribute.attrelid=to_regclass(${literal(`${schema}.cash_transfer_fact`)})
          AND attribute.attname='posting_version' AND attribute.attnum > 0 AND NOT attribute.attisdropped
      ), FALSE),
      'postingVersionDefaults', (
        SELECT count(*) FROM information_schema.columns
        WHERE table_schema=${literal(schema)} AND table_name='cash_transfer_fact'
          AND column_name='posting_version' AND column_default IS NOT NULL
      ),
      'postingVersionChecks', (
        SELECT count(*) FROM pg_constraint constraint_row
        WHERE constraint_row.conrelid=to_regclass(${literal(`${schema}.cash_transfer_fact`)})
          AND constraint_row.conname='ck_cash_transfer_fact_posting_version'
          AND regexp_replace(pg_get_expr(constraint_row.conbin, constraint_row.conrelid), '\\s+', '', 'g')
              IN ('posting_version>0', '(posting_version>0)')
      ),
      'lifecycleUniques', (
        SELECT count(*) FROM pg_constraint constraint_row
        WHERE constraint_row.conrelid=to_regclass(${literal(`${schema}.cash_transfer_fact`)})
          AND constraint_row.conname='uq_cash_transfer_fact_leg'
          AND pg_get_constraintdef(constraint_row.oid, TRUE)
              = 'UNIQUE (cash_transfer_id, account_id, posting_action, posting_version)'
      ),
      'factConstraints', (
        SELECT count(*) FROM pg_constraint constraint_row
        WHERE constraint_row.conrelid=to_regclass(${literal(`${schema}.cash_transfer_fact`)})
      ),
      'fixtureFacts', (
        SELECT count(*) FROM ${identifier(schema)}.cash_transfer_fact
        WHERE cash_transfer_id=${literal(cashTransferId)}::uuid
      ),
      'invalidBackfills', (
        SELECT count(*) FROM ${identifier(schema)}.cash_transfer_fact
        WHERE cash_transfer_id=${literal(cashTransferId)}::uuid
          AND NOT (
            (posting_action='AUDIT' AND posting_version=1)
            OR (posting_action='REVERSE' AND posting_version=2)
          )
      ),
      'retiredReversals', (
        SELECT count(*) FROM ${identifier(schema)}.ap_payable
        WHERE bill_no IN (
          ${literal(normalReversalBillNo)}, ${literal(redReversalBillNo)}, ${literal(returnReversalBillNo)}
        ) AND status='REVERSED'
      ),
      'activeReversals', (
        SELECT count(*) FROM ${identifier(schema)}.ap_payable
        WHERE bill_no IN (
          ${literal(normalReversalBillNo)}, ${literal(redReversalBillNo)}, ${literal(returnReversalBillNo)}
        ) AND status<>'REVERSED'
      ),
      'activeRedMainPayables', (
        SELECT count(*) FROM ${identifier(schema)}.ap_payable
        WHERE bill_no=${literal(redMainPayableBillNo)}
          AND source_bill_no=${literal(redPurchaseInNo)}
          AND status<>'REVERSED'
      )
    )::text
  `);
}

function assertLifecycleSemantics(label, actual, live) {
  const numeric = Object.fromEntries(
    Object.entries(actual).map(([key, value]) => [key, typeof value === "boolean" ? value : Number(value)])
  );
  assert(numeric.postingVersionColumns === 1, `${label} must have one posting_version column`, actual);
  assert(numeric.postingVersionNotNull === true, `${label} posting_version must be NOT NULL`, actual);
  assert(numeric.postingVersionDefaults === 0, `${label} posting_version must not have a default`, actual);
  assert(numeric.fixtureFacts === 4 && numeric.invalidBackfills === 0, `${label} posting-version backfill mismatch`, actual);
  assert(numeric.retiredReversals === 3 && numeric.activeReversals === 0, `${label} payable reversal backfill mismatch`, actual);
  assert(numeric.activeRedMainPayables === 1, `${label} red main payable must remain active`, actual);
  if (live) {
    assert(numeric.postingVersionChecks === 1, `${label} must have the positive posting-version CHECK`, actual);
    assert(numeric.lifecycleUniques === 1, `${label} must have the lifecycle-versioned UNIQUE`, actual);
  } else {
    assert(numeric.postingVersionChecks === 0 && numeric.lifecycleUniques === 0 && numeric.factConstraints === 0, `${label} backup fact table must remain data-only`, actual);
  }
}

function assertTopology(label, actual, expectedFk) {
  const normalized = Object.fromEntries(Object.entries(actual).map(([key, value]) => [key, Number(value)]));
  assert(
    normalized.tables === 90
      && normalized.pk === 90
      && normalized.uk === 87
      && normalized.fk === expectedFk
      && normalized.check === 119,
    `${label} topology mismatch`,
    normalized
  );
}

async function cleanup() {
  for (const database of [upgradeDatabase, freshDatabase]) {
    try {
      dropDatabase(database);
      result.cleanup.databases[database] = true;
    } catch (error) {
      result.cleanup.databases[database] = false;
      result.cleanup.residue.push({ database, error: String(error) });
    }
  }
}

let primaryError = null;
try {
  createDatabase(upgradeDatabase);
  result.upgrade.flywayV109 = flyway(upgradeDatabase, 109);
  psql(upgradeDatabase, `
    INSERT INTO public.md_product_category (id, code, name, enabled, audit_status)
    VALUES (${literal(categoryId)}::uuid, 'A167-CATEGORY', 'A167 migration category', TRUE, 'AUDITED');
    INSERT INTO public.md_unit (id, code, name, decimal_places, enabled, audit_status)
    VALUES (${literal(unitId)}::uuid, 'A167-UNIT', 'A167 migration unit', 4, TRUE, 'AUDITED');
    INSERT INTO public.md_warehouse (id, code, name, enabled, audit_status)
    VALUES (${literal(warehouseId)}::uuid, 'A167-WH', 'A167 migration warehouse', TRUE, 'AUDITED');
    INSERT INTO public.md_supplier (id, code, name, enabled, audit_status)
    VALUES (${literal(supplierId)}::uuid, 'A167-SUPPLIER', 'A167 migration supplier', TRUE, 'AUDITED');
    INSERT INTO public.md_financial_account (
      id, system_no, code, name, account_type, currency, enabled, audit_status
    ) VALUES
      (${literal(sourceAccountId)}::uuid, 799990001, 'A167-CASH-SOURCE', 'A167 source account', 'CASH', 'CNY', TRUE, 'AUDITED'),
      (${literal(targetAccountId)}::uuid, 799990002, 'A167-CASH-TARGET', 'A167 target account', 'CASH', 'CNY', TRUE, 'AUDITED');
    INSERT INTO public.md_product (
      id, code, name, spec, unit, enabled, audit_status, is_inventory, is_produce,
      default_warehouse_code, default_warehouse_id, product_category_id, unit_id
    ) VALUES (
      ${literal(productId)}::uuid, 'A167-FG', 'A167 migration product', 'A167', '件',
      TRUE, 'AUDITED', TRUE, TRUE, 'A167-WH', ${literal(warehouseId)}::uuid,
      ${literal(categoryId)}::uuid, ${literal(unitId)}::uuid
    );
    INSERT INTO public.prod_bom (id, code, product_id, qty, enabled, version_no, is_current, audit_status)
    VALUES (${literal(bomId)}::uuid, 'A167-BOM', ${literal(productId)}::uuid, 1, TRUE, 1, TRUE, 'AUDITED');
    INSERT INTO public.purchase_in (
      id, bill_no, red_source_bill_id, supplier_id, bill_date, status, total_amount, currency
    ) VALUES
      (${literal(normalPurchaseInId)}::uuid, ${literal(normalPurchaseInNo)}, NULL,
       ${literal(supplierId)}::uuid, DATE '2026-08-09', 'AUDITED', 10, 'CNY'),
      (${literal(redOriginalPurchaseInId)}::uuid, ${literal(redOriginalPurchaseInNo)}, NULL,
       ${literal(supplierId)}::uuid, DATE '2026-08-09', 'AUDITED', 11, 'CNY'),
      (${literal(redPurchaseInId)}::uuid, ${literal(redPurchaseInNo)}, ${literal(redOriginalPurchaseInId)}::uuid,
       ${literal(supplierId)}::uuid, DATE '2026-08-09', 'AUDITED', -11, 'CNY');
    INSERT INTO public.purchase_return (
      id, bill_no, supplier_id, bill_date, status, total_amount
    ) VALUES (
      ${literal(purchaseReturnId)}::uuid, ${literal(purchaseReturnNo)},
      ${literal(supplierId)}::uuid, DATE '2026-08-09', 'AUDITED', 4
    );
    INSERT INTO public.ap_payable (
      bill_no, source_bill_no, supplier_id, bill_date, amount, paid_amount, status, currency
    ) VALUES
      (${literal(normalReversalBillNo)}, ${literal(normalPurchaseInNo)},
       ${literal(supplierId)}::uuid, DATE '2026-08-09', -10, 0, 'OPEN', 'CNY'),
      (${literal(redMainPayableBillNo)}, ${literal(redPurchaseInNo)},
       ${literal(supplierId)}::uuid, DATE '2026-08-09', -11, 0, 'OPEN', 'CNY'),
      (${literal(redReversalBillNo)}, ${literal(redPurchaseInNo)},
       ${literal(supplierId)}::uuid, DATE '2026-08-09', 11, 0, 'OPEN', 'CNY'),
      (${literal(returnReversalBillNo)}, ${literal(purchaseReturnNo)},
       ${literal(supplierId)}::uuid, DATE '2026-08-09', 4, 0, 'OPEN', 'CNY');
    INSERT INTO public.cash_transfer (
      id, bill_no, bill_date, source_account_id, target_account_id,
      currency, amount, status, audited_at
    ) VALUES (
      ${literal(cashTransferId)}::uuid, ${literal(cashTransferNo)}, DATE '2026-08-09',
      ${literal(sourceAccountId)}::uuid, ${literal(targetAccountId)}::uuid,
      'CNY', 12.50, 'AUDITED', now()
    );
    INSERT INTO public.cash_transfer_fact (
      cash_transfer_id, account_id, currency, amount_delta, posting_action
    ) VALUES
      (${literal(cashTransferId)}::uuid, ${literal(sourceAccountId)}::uuid, 'CNY', -12.50, 'AUDIT'),
      (${literal(cashTransferId)}::uuid, ${literal(targetAccountId)}::uuid, 'CNY', 12.50, 'AUDIT'),
      (${literal(cashTransferId)}::uuid, ${literal(sourceAccountId)}::uuid, 'CNY', 12.50, 'REVERSE'),
      (${literal(cashTransferId)}::uuid, ${literal(targetAccountId)}::uuid, 'CNY', -12.50, 'REVERSE');
    INSERT INTO public.production_plan (
      bill_no, bom_id, product_id, warehouse_id, planned_qty,
      product_code_snapshot, product_name_snapshot, product_spec_snapshot,
      product_unit_snapshot, net_weight_snapshot, gross_weight_snapshot,
      department_code, bom_code_snapshot, bom_version_no,
      plan_delivery_date, in_progress_qty, source_type, status
    )
    VALUES (
      ${literal(legacyPlanNo)}, ${literal(bomId)}::uuid, ${literal(productId)}::uuid,
      ${literal(warehouseId)}::uuid, 7, 'A167-FG', 'A167 migration product', 'A167',
      '件', NULL, NULL, NULL, 'A167-BOM', 1, DATE '2026-08-15', 0, 'SELF', 'AUDITED'
    );

    INSERT INTO public.sys_account_set (
      id, code, name, environment, database_name, schema_name,
      attachment_prefix, redis_key_prefix, accounting_period, business_period,
      enabled, initialized
    ) VALUES (
      ${literal(tenantId)}::uuid, 'A167-MIG', 'A167 migration tenant',
      'A167 regression', ${literal(upgradeDatabase)}, ${literal(tenantSchema)},
      'account-sets/A167-MIG', 'A167-MIG', '2026-08', '2026-08', TRUE, TRUE
    ), (
      ${literal(inactiveTenantId)}::uuid, 'A167-INACTIVE', 'A167 inactive migration tenant',
      'A167 regression', ${literal(upgradeDatabase)}, ${literal(inactiveTenantSchema)},
      'account-sets/A167-INACTIVE', 'A167-INACTIVE', '2026-08', '2026-08', FALSE, FALSE
    );
    SELECT public.jdy_sync_tenant_schema(${literal(tenantSchema)}, TRUE);
    SELECT public.jdy_sync_tenant_schema(${literal(inactiveTenantSchema)}, TRUE);

    INSERT INTO ${identifier(tenantSchema)}.md_supplier
    SELECT * FROM public.md_supplier WHERE id=${literal(supplierId)}::uuid;
    INSERT INTO ${identifier(tenantSchema)}.md_financial_account
    SELECT * FROM public.md_financial_account WHERE id IN (${literal(sourceAccountId)}::uuid, ${literal(targetAccountId)}::uuid);
    INSERT INTO ${identifier(tenantSchema)}.purchase_in
    SELECT * FROM public.purchase_in WHERE id IN (
      ${literal(normalPurchaseInId)}::uuid,
      ${literal(redOriginalPurchaseInId)}::uuid,
      ${literal(redPurchaseInId)}::uuid
    );
    INSERT INTO ${identifier(tenantSchema)}.purchase_return
    SELECT * FROM public.purchase_return WHERE id=${literal(purchaseReturnId)}::uuid;
    INSERT INTO ${identifier(tenantSchema)}.ap_payable
    SELECT * FROM public.ap_payable WHERE source_bill_no IN (
      ${literal(normalPurchaseInNo)},
      ${literal(redPurchaseInNo)},
      ${literal(purchaseReturnNo)}
    );
    INSERT INTO ${identifier(tenantSchema)}.cash_transfer
    SELECT * FROM public.cash_transfer WHERE id=${literal(cashTransferId)}::uuid;
    INSERT INTO ${identifier(tenantSchema)}.cash_transfer_fact
    SELECT * FROM public.cash_transfer_fact WHERE cash_transfer_id=${literal(cashTransferId)}::uuid;

    INSERT INTO ${identifier(inactiveTenantSchema)}.md_supplier
    SELECT * FROM public.md_supplier WHERE id=${literal(supplierId)}::uuid;
    INSERT INTO ${identifier(inactiveTenantSchema)}.md_financial_account
    SELECT * FROM public.md_financial_account WHERE id IN (${literal(sourceAccountId)}::uuid, ${literal(targetAccountId)}::uuid);
    INSERT INTO ${identifier(inactiveTenantSchema)}.purchase_in
    SELECT * FROM public.purchase_in WHERE id IN (
      ${literal(normalPurchaseInId)}::uuid,
      ${literal(redOriginalPurchaseInId)}::uuid,
      ${literal(redPurchaseInId)}::uuid
    );
    INSERT INTO ${identifier(inactiveTenantSchema)}.purchase_return
    SELECT * FROM public.purchase_return WHERE id=${literal(purchaseReturnId)}::uuid;
    INSERT INTO ${identifier(inactiveTenantSchema)}.ap_payable
    SELECT * FROM public.ap_payable WHERE source_bill_no IN (
      ${literal(normalPurchaseInNo)},
      ${literal(redPurchaseInNo)},
      ${literal(purchaseReturnNo)}
    );
    INSERT INTO ${identifier(inactiveTenantSchema)}.cash_transfer
    SELECT * FROM public.cash_transfer WHERE id=${literal(cashTransferId)}::uuid;
    INSERT INTO ${identifier(inactiveTenantSchema)}.cash_transfer_fact
    SELECT * FROM public.cash_transfer_fact WHERE cash_transfer_id=${literal(cashTransferId)}::uuid;

    DO $fixture$
    DECLARE
      managed RECORD;
      admin_id UUID;
      copied_count INTEGER := 0;
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM public.production_plan WHERE bill_no=${literal(legacyPlanNo)}) THEN
        RAISE EXCEPTION 'A167 legacy production plan fixture could not be created';
      END IF;
      CREATE SCHEMA ${identifier(backupSchema)};
      FOR managed IN SELECT table_name FROM public.sys_tenant_managed_table ORDER BY restore_order, table_name
      LOOP
        EXECUTE format('CREATE TABLE %I.%I AS TABLE public.%I', ${literal(backupSchema)}, managed.table_name, managed.table_name);
        copied_count := copied_count + 1;
      END LOOP;
      IF copied_count <> 86 THEN
        RAISE EXCEPTION 'A167 historical backup expected 86 V109 tables, got %', copied_count;
      END IF;
      SELECT id INTO STRICT admin_id FROM public.sys_user WHERE username='admin';
      INSERT INTO public.sys_account_set_backup (
        id, account_set_id, account_set_code, account_set_name,
        backup_name, backup_schema_name, attachment_prefix,
        table_count, row_count, created_by
      ) VALUES (
        ${literal(backupId)}::uuid, ${literal(tenantId)}::uuid,
        'A167-MIG', 'A167 migration tenant', 'A167 historical backup',
        ${literal(backupSchema)}, '', 86, 1, admin_id
      );
    END $fixture$;
  `);

  result.upgrade.flywayV111 = flyway(upgradeDatabase, 111);
  assert(psql(upgradeDatabase, "SELECT max(version::integer) FROM public.flyway_schema_history WHERE success") === "111", "staged upgrade must reach V111");
  psql(upgradeDatabase, `
    INSERT INTO ${identifier(backupSchema)}.purchase_requisition_line (id, qty, planned_qty, updated_at)
    VALUES
      (${literal(draftRequisitionLineId)}::uuid, 10, 10, TIMESTAMPTZ '2026-01-01 00:00:00+00'),
      (${literal(auditedRequisitionLineId)}::uuid, 7, 0, TIMESTAMPTZ '2026-01-01 00:00:00+00');
    INSERT INTO ${identifier(backupSchema)}.purchase_plan (id, status)
    VALUES
      (${literal(draftPurchasePlanId)}::uuid, 'DRAFT'),
      (${literal(auditedPurchasePlanId)}::uuid, 'AUDITED');
    INSERT INTO ${identifier(backupSchema)}.purchase_plan_line (
      id, plan_id, source_requisition_line_id, product_id,
      product_code_snapshot, product_name_snapshot, qty
    )
    VALUES
      (gen_random_uuid(), ${literal(draftPurchasePlanId)}::uuid, ${literal(draftRequisitionLineId)}::uuid,
       ${literal(productId)}::uuid, 'A167-FG', 'A167 migration product', 10),
      (gen_random_uuid(), ${literal(auditedPurchasePlanId)}::uuid, ${literal(auditedRequisitionLineId)}::uuid,
       ${literal(productId)}::uuid, 'A167-FG', 'A167 migration product', 7);
    INSERT INTO public.ap_payable (
      id, bill_no, source_bill_no, supplier_id, bill_date,
      amount, paid_amount, status, currency, created_at, updated_at
    ) VALUES
      (
        ${literal(redDecoyPayableId)}::uuid, ${literal(redDecoyBillNo)},
        ${literal(redPurchaseInNo)}, ${literal(supplierId)}::uuid, DATE '2026-08-09',
        11, 0, 'OPEN', 'CNY',
        TIMESTAMPTZ '2025-02-01 00:00:00+00', TIMESTAMPTZ '2025-02-01 00:00:00+00'
      ),
      (
        ${literal(preexistingRedPayableId)}::uuid, ${literal(preexistingRedBillNo)},
        ${literal(redPurchaseInNo)}, ${literal(supplierId)}::uuid, DATE '2026-08-09',
        11, 0, 'REVERSED', 'CNY',
        TIMESTAMPTZ '2025-02-02 00:00:00+00', TIMESTAMPTZ '2025-02-02 00:00:00+00'
      );
  `);
  const staleReservations = json(upgradeDatabase, `
    SELECT jsonb_build_object(
      'draftQty', (SELECT planned_qty FROM ${identifier(backupSchema)}.purchase_requisition_line WHERE id=${literal(draftRequisitionLineId)}::uuid),
      'auditedQty', (SELECT planned_qty FROM ${identifier(backupSchema)}.purchase_requisition_line WHERE id=${literal(auditedRequisitionLineId)}::uuid)
    )::text
  `);
  assert(Number(staleReservations.draftQty) === 10 && Number(staleReservations.auditedQty) === 0, "V111 backup fixture must contain stale draft/audited reservations", staleReservations);

  const redShapeBeforeV118 = json(upgradeDatabase, `
    SELECT jsonb_build_object(
      'mainStatus', (SELECT status FROM public.ap_payable WHERE bill_no=${literal(redMainPayableBillNo)}),
      'reversalStatus', (SELECT status FROM public.ap_payable WHERE bill_no=${literal(redReversalBillNo)}),
      'reversalUpdatedAt', (SELECT updated_at FROM public.ap_payable WHERE bill_no=${literal(redReversalBillNo)}),
      'decoyStatus', (SELECT status FROM public.ap_payable WHERE id=${literal(redDecoyPayableId)}::uuid),
      'decoyUpdatedAt', (SELECT updated_at FROM public.ap_payable WHERE id=${literal(redDecoyPayableId)}::uuid),
      'preexistingStatus', (SELECT status FROM public.ap_payable WHERE id=${literal(preexistingRedPayableId)}::uuid),
      'preexistingUpdatedAt', (SELECT updated_at FROM public.ap_payable WHERE id=${literal(preexistingRedPayableId)}::uuid),
      'inactiveReversalStatus', (
        SELECT status FROM ${identifier(inactiveTenantSchema)}.ap_payable
        WHERE bill_no=${literal(redReversalBillNo)}
      )
    )::text
  `);
  result.upgrade.flywayV118 = flyway(upgradeDatabase, 118);
  assert(
    psql(upgradeDatabase, "SELECT max(version::integer) FROM public.flyway_schema_history WHERE success") === "118",
    "staged upgrade must reach V118 before the committed-boundary fixture"
  );
  const redShapeAfterV118 = json(upgradeDatabase, `
    SELECT jsonb_build_object(
      'mainStatus', (SELECT status FROM public.ap_payable WHERE bill_no=${literal(redMainPayableBillNo)}),
      'reversalStatus', (SELECT status FROM public.ap_payable WHERE bill_no=${literal(redReversalBillNo)}),
      'reversalUpdatedAt', (SELECT updated_at FROM public.ap_payable WHERE bill_no=${literal(redReversalBillNo)}),
      'decoyStatus', (SELECT status FROM public.ap_payable WHERE id=${literal(redDecoyPayableId)}::uuid),
      'decoyUpdatedAt', (SELECT updated_at FROM public.ap_payable WHERE id=${literal(redDecoyPayableId)}::uuid),
      'preexistingStatus', (SELECT status FROM public.ap_payable WHERE id=${literal(preexistingRedPayableId)}::uuid),
      'preexistingUpdatedAt', (SELECT updated_at FROM public.ap_payable WHERE id=${literal(preexistingRedPayableId)}::uuid),
      'inactiveReversalStatus', (
        SELECT status FROM ${identifier(inactiveTenantSchema)}.ap_payable
        WHERE bill_no=${literal(redReversalBillNo)}
      )
    )::text
  `);
  assert(
    redShapeBeforeV118.mainStatus === "OPEN"
      && redShapeBeforeV118.reversalStatus === "OPEN"
      && redShapeBeforeV118.decoyStatus === "OPEN"
      && redShapeBeforeV118.preexistingStatus === "REVERSED"
      && redShapeBeforeV118.inactiveReversalStatus === "OPEN"
      && redShapeAfterV118.mainStatus === "OPEN"
      && redShapeAfterV118.reversalStatus === "REVERSED"
      && redShapeAfterV118.decoyStatus === "REVERSED"
      && redShapeAfterV118.preexistingStatus === "REVERSED"
      && redShapeAfterV118.preexistingUpdatedAt === redShapeBeforeV118.preexistingUpdatedAt
      && redShapeAfterV118.reversalUpdatedAt !== redShapeBeforeV118.reversalUpdatedAt
      && redShapeAfterV118.decoyUpdatedAt !== redShapeBeforeV118.decoyUpdatedAt
      && redShapeAfterV118.inactiveReversalStatus === "OPEN",
    "V118 must expose the broad active-scope mutation without touching disabled tenant or pre-existing history",
    { redShapeBeforeV118, redShapeAfterV118 }
  );

  // This independent blocker is deliberately added after V118 and before V119.
  // V120 must discover it only after the first ambiguity is repaired, while the
  // already-committed V119 compensation remains observable.
  psql(upgradeDatabase, `
    INSERT INTO ${identifier(backupSchema)}.purchase_return (
      id, bill_no, supplier_id, bill_date, status, total_amount
    ) VALUES (
      ${literal(unsafePurchaseReturnId)}::uuid, ${literal(unsafePurchaseReturnNo)},
      ${literal(supplierId)}::uuid, DATE '2026-08-09', 'AUDITED', 3
    );
    INSERT INTO ${identifier(backupSchema)}.ap_payable (
      id, bill_no, source_bill_no, supplier_id, bill_date,
      amount, paid_amount, status, currency
    ) VALUES (
      ${literal(unsafePayableId)}::uuid, 'YF-TH-CX-' || ${literal(unsafePurchaseReturnNo)},
      ${literal(unsafePurchaseReturnNo)}, ${literal(supplierId)}::uuid, DATE '2026-08-09',
      3, 1, 'PART_SETTLED', 'CNY'
    );
  `);

  result.upgrade.v120AmbiguousBoundaryRefusal = expectFlywayFailure(
    upgradeDatabase,
    /V120 refused ambiguous red payable reversal shape:[\s\S]*schema=public/
  );
  assert(
    psql(upgradeDatabase, "SELECT max(version::integer) FROM public.flyway_schema_history WHERE success") === "119",
    "ambiguous pre-V118 red shape must commit V119 compensation and stop before V120"
  );
  const redShapeAfterAmbiguousRefusal = json(upgradeDatabase, `
    SELECT jsonb_build_object(
      'mainStatus', (SELECT status FROM public.ap_payable WHERE bill_no=${literal(redMainPayableBillNo)}),
      'reversalStatus', (SELECT status FROM public.ap_payable WHERE bill_no=${literal(redReversalBillNo)}),
      'reversalUpdatedAt', (SELECT updated_at FROM public.ap_payable WHERE bill_no=${literal(redReversalBillNo)}),
      'decoyStatus', (SELECT status FROM public.ap_payable WHERE id=${literal(redDecoyPayableId)}::uuid),
      'decoyUpdatedAt', (SELECT updated_at FROM public.ap_payable WHERE id=${literal(redDecoyPayableId)}::uuid),
      'preexistingStatus', (SELECT status FROM public.ap_payable WHERE id=${literal(preexistingRedPayableId)}::uuid),
      'preexistingUpdatedAt', (SELECT updated_at FROM public.ap_payable WHERE id=${literal(preexistingRedPayableId)}::uuid),
      'inactiveReversalStatus', (
        SELECT status FROM ${identifier(inactiveTenantSchema)}.ap_payable
        WHERE bill_no=${literal(redReversalBillNo)}
      ),
      'unsafePaidState', (
        SELECT status || ':' || paid_amount::text
        FROM ${identifier(backupSchema)}.ap_payable
        WHERE id=${literal(unsafePayableId)}::uuid
      )
    )::text
  `);
  assert(
    redShapeAfterAmbiguousRefusal.mainStatus === "OPEN"
      && redShapeAfterAmbiguousRefusal.reversalStatus === "OPEN"
      && redShapeAfterAmbiguousRefusal.decoyStatus === "OPEN"
      && redShapeAfterAmbiguousRefusal.reversalUpdatedAt === redShapeAfterV118.reversalUpdatedAt
      && redShapeAfterAmbiguousRefusal.decoyUpdatedAt === redShapeAfterV118.decoyUpdatedAt
      && redShapeAfterAmbiguousRefusal.preexistingStatus === redShapeBeforeV118.preexistingStatus
      && redShapeAfterAmbiguousRefusal.preexistingUpdatedAt === redShapeBeforeV118.preexistingUpdatedAt
      && redShapeAfterAmbiguousRefusal.inactiveReversalStatus === "OPEN"
      && redShapeAfterAmbiguousRefusal.unsafePaidState === "PART_SETTLED:1.00",
    "V119 compensation must commit before V120 ambiguity refusal without touching excluded or historical rows",
    { redShapeBeforeV118, redShapeAfterV118, redShapeAfterAmbiguousRefusal }
  );

  // Keep the compensated decoy row itself as the now-exact companion so its
  // OPEN state can prove the second V120 refusal also performs no write.
  psql(upgradeDatabase, `
    DELETE FROM public.ap_payable WHERE bill_no=${literal(redReversalBillNo)};
    DELETE FROM public.ap_payable WHERE id=${literal(preexistingRedPayableId)}::uuid;
    UPDATE public.ap_payable
    SET bill_no=${literal(redReversalBillNo)}
    WHERE id=${literal(redDecoyPayableId)}::uuid
  `);

  const beforePaidBoundaryRefusal = {
    publicRed: json(upgradeDatabase, `
      SELECT jsonb_build_object(
        'id', id,
        'billNo', bill_no,
        'status', status,
        'updatedAt', updated_at
      )::text
      FROM public.ap_payable
      WHERE id=${literal(redDecoyPayableId)}::uuid
    `),
    inactiveLifecycle: lifecycleSemantics(upgradeDatabase, inactiveTenantSchema),
    inactiveTopology: topology(upgradeDatabase, inactiveTenantSchema)
  };
  result.upgrade.v120PaidBoundaryRefusal = expectFlywayFailure(
    upgradeDatabase,
    /V120 refused settled active payable reversal:[\s\S]*schema=.*bk_a167_[a-f0-9]{12}/
  );
  assert(
    psql(upgradeDatabase, "SELECT max(version::integer) FROM public.flyway_schema_history WHERE success") === "119",
    "paid V120 refusal must retain the committed V119 boundary"
  );
  const afterPaidBoundaryRefusal = {
    publicRed: json(upgradeDatabase, `
      SELECT jsonb_build_object(
        'id', id,
        'billNo', bill_no,
        'status', status,
        'updatedAt', updated_at
      )::text
      FROM public.ap_payable
      WHERE id=${literal(redDecoyPayableId)}::uuid
    `),
    inactiveLifecycle: lifecycleSemantics(upgradeDatabase, inactiveTenantSchema),
    inactiveTopology: topology(upgradeDatabase, inactiveTenantSchema)
  };
  assert(
    JSON.stringify(afterPaidBoundaryRefusal) === JSON.stringify(beforePaidBoundaryRefusal)
      && afterPaidBoundaryRefusal.publicRed.billNo === redReversalBillNo
      && afterPaidBoundaryRefusal.publicRed.status === "OPEN"
      && psql(upgradeDatabase, `
        SELECT status || ':' || paid_amount::text
        FROM ${identifier(backupSchema)}.ap_payable
        WHERE id=${literal(unsafePayableId)}::uuid
      `) === "PART_SETTLED:1.00",
    "second V120 preflight refusal must preserve V119 compensation and perform no topology or lifecycle write",
    { beforePaidBoundaryRefusal, afterPaidBoundaryRefusal }
  );
  psql(upgradeDatabase, `
    DELETE FROM ${identifier(backupSchema)}.ap_payable WHERE id=${literal(unsafePayableId)}::uuid;
    DELETE FROM ${identifier(backupSchema)}.purchase_return WHERE id=${literal(unsafePurchaseReturnId)}::uuid;
  `);

  result.upgrade.flywayLatest = flyway(upgradeDatabase);
  const latestVersion = psql(upgradeDatabase, "SELECT max(version::integer) FROM public.flyway_schema_history WHERE success");
  assert(latestVersion === "120", "upgrade must end at V120", latestVersion);
  assertTopology("upgrade public", topology(upgradeDatabase, "public"), 203);
  assertTopology("upgrade tenant", topology(upgradeDatabase, tenantSchema), 199);
  assertTopology("upgrade inactive tenant", topology(upgradeDatabase, inactiveTenantSchema), 199);
  assert(psql(upgradeDatabase, `SELECT public.jdy_sync_tenant_schema(${literal(tenantSchema)}, FALSE)`) === "90", "repeat tenant sync must return 90");
  assert(psql(upgradeDatabase, `SELECT public.jdy_sync_tenant_schema(${literal(inactiveTenantSchema)}, FALSE)`) === "90", "repeat inactive tenant sync must return 90");
  assert(
    psql(upgradeDatabase, `SELECT enabled::text || ':' || initialized::text FROM public.sys_account_set WHERE id=${literal(inactiveTenantId)}::uuid`) === "false:false",
    "second tenant fixture must remain disabled and uninitialized"
  );
  assert(
    psql(upgradeDatabase, `SELECT status FROM public.ap_payable WHERE id=${literal(redDecoyPayableId)}::uuid`) === "REVERSED",
    "V120 must retire the compensated row after it becomes the exact zero-settlement companion"
  );

  const publicLifecycle = lifecycleSemantics(upgradeDatabase, "public");
  const tenantLifecycle = lifecycleSemantics(upgradeDatabase, tenantSchema);
  const inactiveTenantLifecycle = lifecycleSemantics(upgradeDatabase, inactiveTenantSchema);
  const backupLifecycle = lifecycleSemantics(upgradeDatabase, backupSchema);
  assertLifecycleSemantics("upgrade public", publicLifecycle, true);
  assertLifecycleSemantics("upgrade tenant", tenantLifecycle, true);
  assertLifecycleSemantics("upgrade inactive tenant", inactiveTenantLifecycle, true);
  assertLifecycleSemantics("upgrade backup", backupLifecycle, false);

  psql(upgradeDatabase, `
    INSERT INTO ${identifier(backupSchema)}.purchase_return (
      id, bill_no, supplier_id, bill_date, status, total_amount
    ) VALUES (
      ${literal(unsafePurchaseReturnId)}::uuid, ${literal(unsafePurchaseReturnNo)},
      ${literal(supplierId)}::uuid, DATE '2026-08-09', 'AUDITED', 3
    );
    INSERT INTO ${identifier(backupSchema)}.ap_payable (
      id, bill_no, source_bill_no, supplier_id, bill_date,
      amount, paid_amount, status, currency
    ) VALUES (
      ${literal(unsafePayableId)}::uuid, 'YF-TH-CX-' || ${literal(unsafePurchaseReturnNo)},
      ${literal(unsafePurchaseReturnNo)}, ${literal(supplierId)}::uuid, DATE '2026-08-09',
      3, 1, 'PART_SETTLED', 'CNY'
    );
  `);
  result.upgrade.unsafePaidRefusal = await expectPsqlFileFailure(
    upgradeDatabase,
    v120Path,
    /V120 refused settled active payable reversal:[\s\S]*schema=.*bk_a167_[a-f0-9]{12}/
  );
  assert(
    psql(upgradeDatabase, `SELECT status || ':' || paid_amount::text FROM ${identifier(backupSchema)}.ap_payable WHERE id=${literal(unsafePayableId)}::uuid`) === "PART_SETTLED:1.00",
    "unsafe paid refusal must leave the backup reversal unchanged"
  );
  psql(upgradeDatabase, `
    DELETE FROM ${identifier(backupSchema)}.ap_payable WHERE id=${literal(unsafePayableId)}::uuid;
    DELETE FROM ${identifier(backupSchema)}.purchase_return WHERE id=${literal(unsafePurchaseReturnId)}::uuid;
  `);
  await psqlFile(upgradeDatabase, v119Path);
  await psqlFile(upgradeDatabase, v120Path);
  const lifecycleAfterRepeat = {
    public: lifecycleSemantics(upgradeDatabase, "public"),
    tenant: lifecycleSemantics(upgradeDatabase, tenantSchema),
    inactiveTenant: lifecycleSemantics(upgradeDatabase, inactiveTenantSchema),
    backup: lifecycleSemantics(upgradeDatabase, backupSchema)
  };
  assert(
    JSON.stringify(lifecycleAfterRepeat) === JSON.stringify({
      public: publicLifecycle,
      tenant: tenantLifecycle,
      inactiveTenant: inactiveTenantLifecycle,
      backup: backupLifecycle
    }),
    "V119/V120 repeated execution must preserve all-layer lifecycle semantics",
    lifecycleAfterRepeat
  );

  const reservationReconciliation = json(upgradeDatabase, `
    SELECT jsonb_build_object(
      'draftQty', (SELECT planned_qty FROM ${identifier(backupSchema)}.purchase_requisition_line WHERE id=${literal(draftRequisitionLineId)}::uuid),
      'auditedQty', (SELECT planned_qty FROM ${identifier(backupSchema)}.purchase_requisition_line WHERE id=${literal(auditedRequisitionLineId)}::uuid),
      'draftUpdatedAt', (SELECT updated_at FROM ${identifier(backupSchema)}.purchase_requisition_line WHERE id=${literal(draftRequisitionLineId)}::uuid),
      'auditedUpdatedAt', (SELECT updated_at FROM ${identifier(backupSchema)}.purchase_requisition_line WHERE id=${literal(auditedRequisitionLineId)}::uuid)
    )::text
  `);
  assert(Number(reservationReconciliation.draftQty) === 0, "V113 must remove draft purchase-plan reservations from historical backups", reservationReconciliation);
  assert(Number(reservationReconciliation.auditedQty) === 7, "V113 must rebuild historical backup reservations from audited purchase plans", reservationReconciliation);
  psql(upgradeDatabase, "SELECT pg_sleep(0.02)");
  await psqlFile(upgradeDatabase, path.join(migrationDir, "V113__recalculate_backup_purchase_plan_reservations.sql"));
  const reservationReconciliationAfterRepeat = json(upgradeDatabase, `
    SELECT jsonb_build_object(
      'draftQty', (SELECT planned_qty FROM ${identifier(backupSchema)}.purchase_requisition_line WHERE id=${literal(draftRequisitionLineId)}::uuid),
      'auditedQty', (SELECT planned_qty FROM ${identifier(backupSchema)}.purchase_requisition_line WHERE id=${literal(auditedRequisitionLineId)}::uuid),
      'draftUpdatedAt', (SELECT updated_at FROM ${identifier(backupSchema)}.purchase_requisition_line WHERE id=${literal(draftRequisitionLineId)}::uuid),
      'auditedUpdatedAt', (SELECT updated_at FROM ${identifier(backupSchema)}.purchase_requisition_line WHERE id=${literal(auditedRequisitionLineId)}::uuid)
    )::text
  `);
  assert(JSON.stringify(reservationReconciliationAfterRepeat) === JSON.stringify(reservationReconciliation), "V113 backup reservation reconciliation must be idempotent", { reservationReconciliation, reservationReconciliationAfterRepeat });

  const backfill = json(upgradeDatabase, `
    SELECT jsonb_build_object(
      'publicLines', (SELECT count(*) FROM public.production_plan_line line JOIN public.production_plan plan ON plan.id=line.plan_id WHERE plan.bill_no=${literal(legacyPlanNo)} AND line.line_no=1 AND line.planned_qty=7),
      'backupLines', (SELECT count(*) FROM ${identifier(backupSchema)}.production_plan_line line JOIN ${identifier(backupSchema)}.production_plan plan ON plan.id=line.plan_id WHERE plan.bill_no=${literal(legacyPlanNo)} AND line.line_no=1 AND line.planned_qty=7 AND line.id IS NOT NULL),
      'backupConstraints', (SELECT count(*) FROM pg_constraint c JOIN pg_class t ON t.oid=c.conrelid JOIN pg_namespace n ON n.oid=t.relnamespace WHERE n.nspname=${literal(backupSchema)} AND t.relname='production_plan_line'),
      'publicSourceIssueColumn', (SELECT count(*) FROM information_schema.columns WHERE table_schema='public' AND table_name='production_completion' AND column_name='source_issue_id'),
      'tenantSourceIssueColumn', (SELECT count(*) FROM information_schema.columns WHERE table_schema=${literal(tenantSchema)} AND table_name='production_completion' AND column_name='source_issue_id'),
      'backupSourceIssueColumn', (SELECT count(*) FROM information_schema.columns WHERE table_schema=${literal(backupSchema)} AND table_name='production_completion' AND column_name='source_issue_id'),
      'publicPlanningFlags', (SELECT count(*) FROM information_schema.columns WHERE table_schema='public' AND table_name='production_plan_line' AND column_name IN ('expand_multilevel_tasks', 'generate_purchase_requisition')),
      'tenantPlanningFlags', (SELECT count(*) FROM information_schema.columns WHERE table_schema=${literal(tenantSchema)} AND table_name='production_plan_line' AND column_name IN ('expand_multilevel_tasks', 'generate_purchase_requisition')),
      'backupPlanningFlags', (SELECT count(*) FROM information_schema.columns WHERE table_schema=${literal(backupSchema)} AND table_name='production_plan_line' AND column_name IN ('expand_multilevel_tasks', 'generate_purchase_requisition')),
      'publicPurchasePlanTables', (SELECT count(*) FROM information_schema.tables WHERE table_schema='public' AND table_name IN ('purchase_plan', 'purchase_plan_line')),
      'tenantPurchasePlanTables', (SELECT count(*) FROM information_schema.tables WHERE table_schema=${literal(tenantSchema)} AND table_name IN ('purchase_plan', 'purchase_plan_line')),
      'backupPurchasePlanTables', (SELECT count(*) FROM information_schema.tables WHERE table_schema=${literal(backupSchema)} AND table_name IN ('purchase_plan', 'purchase_plan_line')),
      'planBillNoUniqueBtree', (
        SELECT count(*) FROM pg_index index_row
        JOIN pg_class table_row ON table_row.oid=index_row.indrelid
        JOIN pg_namespace schema_row ON schema_row.oid=table_row.relnamespace
        JOIN pg_class index_class ON index_class.oid=index_row.indexrelid
        JOIN pg_am access_method ON access_method.oid=index_class.relam
        WHERE schema_row.nspname='public' AND table_row.relname='production_plan'
          AND index_row.indisunique AND index_row.indnkeyatts=1 AND access_method.amname='btree'
          AND pg_get_indexdef(index_row.indexrelid) LIKE '%(bill_no)%'
      )
    )::text
  `);
  assert(Number(backfill.publicLines) === 1, "V110 must backfill public legacy plan as line 1", backfill);
  assert(Number(backfill.backupLines) === 1, "V110 must backfill historical backup legacy plan as line 1", backfill);
  assert(Number(backfill.backupConstraints) === 0, "historical backup line table must remain data-only", backfill);
  assert(Number(backfill.publicSourceIssueColumn) === 1 && Number(backfill.tenantSourceIssueColumn) === 1 && Number(backfill.backupSourceIssueColumn) === 1, "receipt-to-issue trace column must exist in every schema shape", backfill);
  assert(Number(backfill.publicPlanningFlags) === 2 && Number(backfill.tenantPlanningFlags) === 2 && Number(backfill.backupPlanningFlags) === 2, "A170 production plan switches must exist in public, tenant and backup shapes", backfill);
  assert(Number(backfill.publicPurchasePlanTables) === 2 && Number(backfill.tenantPurchasePlanTables) === 2 && Number(backfill.backupPurchasePlanTables) === 2, "A170 purchase plan tables must exist in public, tenant and backup shapes", backfill);
  assert(Number(backfill.planBillNoUniqueBtree) === 1, "production_plan must retain exactly one single-column unique bill_no btree", backfill);
  result.upgrade = {
    ...result.upgrade,
    latestVersion,
    publicTopology: topology(upgradeDatabase, "public"),
    tenantTopology: topology(upgradeDatabase, tenantSchema),
    inactiveTenantTopology: topology(upgradeDatabase, inactiveTenantSchema),
    lifecycle: lifecycleAfterRepeat,
    backfill,
    reservationReconciliation,
    reservationReconciliationAfterRepeat
  };

  createDatabase(freshDatabase);
  result.fresh.flyway = flyway(freshDatabase);
  const sourceScripts = (await readdir(migrationDir))
    .filter((name) => /^V\d+__.+\.sql$/.test(name))
    .sort((left, right) => Number(left.match(/^V(\d+)/)[1]) - Number(right.match(/^V(\d+)/)[1]));
  const historyScripts = json(freshDatabase, "SELECT COALESCE(jsonb_agg(script ORDER BY installed_rank), '[]'::jsonb)::text FROM public.flyway_schema_history WHERE type='SQL'");
  assert(JSON.stringify(historyScripts) === JSON.stringify(sourceScripts), "fresh Flyway history must equal the migration source set");
  assert(psql(freshDatabase, "SELECT max(version::integer) FROM public.flyway_schema_history WHERE success") === "120", "fresh migration must end at V120");
  assertTopology("fresh public", topology(freshDatabase, "public"), 203);
  result.fresh = { ...result.fresh, latestVersion: 120, topology: topology(freshDatabase, "public") };
  result.ok = true;
} catch (error) {
  primaryError = error;
  result.failure = error?.stack ?? String(error);
} finally {
  await cleanup();
  await writeFile(resultPath, JSON.stringify(result, null, 2));
}

if (primaryError) {
  console.error(result.failure);
  process.exitCode = 1;
} else {
  console.log(JSON.stringify({ ok: result.ok, assertions: result.assertions.length, cleanup: result.cleanup }, null, 2));
}
