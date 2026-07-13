import { execFileSync, spawn } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdir, open, readFile, readdir, writeFile } from "node:fs/promises";
import http from "node:http";
import path from "node:path";

import { loginApi } from "./helpers/regression-auth.mjs";

const rootDir = path.resolve(import.meta.dirname, "..");
const verificationDir = path.join(rootDir, "verification");
const isolationDir = path.join(verificationDir, "a141-settlement-migration-isolation");
const resultPath = path.join(verificationDir, "a141-settlement-migration-regression.json");
const migrationDir = path.join(rootDir, "backend/src/main/resources/db/migration");
const container = process.env.JDY_POSTGRES_CONTAINER || "jdy-erp-postgres";
const redisContainer = process.env.JDY_REDIS_CONTAINER || "jdy-erp-redis";
const databaseUser = process.env.JDY_DATABASE_USER || "jdy";
const databasePassword = process.env.JDY_DATABASE_PASSWORD || "jdy_dev";
const token = randomBytes(6).toString("hex");
const upperToken = token.toUpperCase();
const upgradeDatabase = `jdy_a141_mig_${token}`;
const freshDatabase = `jdy_a141_fresh_${token}`;
const tenantSchema = `tenant_a141_mig_${token}`;
const backupSchema = `bk_a141_mig_${token}`;
const tenantCode = `A141-MIG-${upperToken}`;
const tenantId = randomUUID();
const backupId = randomUUID();
const backupName = `BK-${tenantCode}-${upperToken}`;
const redisNamespace = `jdy:a141:migration:${token}`;
const passwordResetRedisPrefix = `jdy:a141:{migration-${token}}:password-reset`;
const processes = [];

const fixtures = {
  public: makeFixture("PUBLIC"),
  tenant: makeFixture("TENANT")
};

await mkdir(isolationDir, { recursive: true });

const result = {
  ok: false,
  generatedAt: new Date().toISOString(),
  token,
  runtime: {
    postgresContainer: container,
    redisContainer,
    flywayVersion: "11.7.2",
    upgradeDatabase,
    freshDatabase,
    tenantSchema,
    backupSchema
  },
  upgrade: {
    target101: {},
    fixtures: {},
    migration102: {},
    repeatFlyway: {},
    repeatTenantSync: {},
    restoreApi: {}
  },
  fresh: {},
  processes: [],
  cleanup: {
    errors: [],
    forcedProcessKills: [],
    databases: {},
    redisKeysDeleted: 0,
    processResidue: []
  }
};

let primaryError = null;
let cleanupPromise = null;
let signalBeingHandled = null;

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function errorText(error) {
  return error instanceof Error ? error.stack ?? error.message : String(error);
}

function sqlLiteral(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function quoteIdentifier(value) {
  const normalized = String(value);
  assert(/^[a-z][a-z0-9_]{0,62}$/.test(normalized), `unsafe SQL identifier: ${normalized}`);
  return `"${normalized}"`;
}

function canonical(value) {
  if (Array.isArray(value)) {
    return value.map(canonical);
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value).sort().map((key) => [key, canonical(value[key])])
    );
  }
  return value;
}

function same(left, right) {
  return JSON.stringify(canonical(left)) === JSON.stringify(canonical(right));
}

function digest(value) {
  return createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function makeFixture(label) {
  const marker = `${label}-${upperToken}`;
  return {
    label,
    customerId: randomUUID(),
    supplierId: randomUUID(),
    receivableId: randomUUID(),
    receiptIds: [randomUUID(), randomUUID()],
    payableId: randomUUID(),
    paymentIds: [randomUUID(), randomUUID()],
    customerCode: `A141-C-${marker}`,
    supplierCode: `A141-S-${marker}`,
    receivableNo: `AR-A141-${marker}`,
    receiptNos: [`ARCT-A141-${marker}-01`, `ARCT-A141-${marker}-02`],
    payableNo: `AP-A141-${marker}`,
    paymentNos: [`APAY-A141-${marker}-01`, `APAY-A141-${marker}-02`]
  };
}

function psql(database, statement) {
  return execFileSync(
    "docker",
    [
      "exec", container, "psql", "-X", "-v", "ON_ERROR_STOP=1", "-U", databaseUser,
      "-d", database, "-tAq", "-c", statement
    ],
    { encoding: "utf8", maxBuffer: 20 * 1024 * 1024 }
  ).trim();
}

function sqlJson(database, statement) {
  const raw = psql(database, statement);
  return raw ? JSON.parse(raw) : null;
}

function createDatabase(database) {
  assert(/^jdy_a141_(?:mig|fresh)_[a-f0-9]{12}$/.test(database), `refusing to create unsafe database ${database}`);
  execFileSync("docker", ["exec", container, "createdb", "-U", databaseUser, "-O", databaseUser, database], {
    encoding: "utf8"
  });
}

function dropDatabase(database) {
  assert(/^jdy_a141_(?:mig|fresh)_[a-f0-9]{12}$/.test(database), `refusing to drop unsafe database ${database}`);
  execFileSync(
    "docker",
    ["exec", container, "dropdb", "-U", databaseUser, "--if-exists", "--force", database],
    { encoding: "utf8" }
  );
}

function flywayMigrate(database, target = null) {
  const args = [
    "org.flywaydb:flyway-maven-plugin:11.7.2:migrate",
    `-Dflyway.url=jdbc:postgresql://localhost:5432/${database}`,
    `-Dflyway.user=${databaseUser}`,
    `-Dflyway.password=${databasePassword}`,
    `-Dflyway.locations=filesystem:${migrationDir}`
  ];
  if (target != null) {
    args.push(`-Dflyway.target=${target}`);
  }
  const output = execFileSync("./scripts/backend-test.sh", args, {
    cwd: rootDir,
    encoding: "utf8",
    maxBuffer: 30 * 1024 * 1024
  });
  return output.trim().split(/\r?\n/).slice(-18);
}

function migrationHistory(database) {
  return sqlJson(database, `
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
      'installedRank', installed_rank,
      'version', version,
      'description', description,
      'script', script,
      'checksum', checksum,
      'success', success
    ) ORDER BY installed_rank), '[]'::jsonb)::text
    FROM public.flyway_schema_history
    WHERE type = 'SQL'
  `);
}

function createTenant() {
  psql(upgradeDatabase, `
    BEGIN;
    INSERT INTO public.sys_account_set (
      id, code, name, environment, database_name, schema_name,
      attachment_prefix, redis_key_prefix, accounting_period, business_period,
      enabled, initialized
    )
    VALUES (
      ${sqlLiteral(tenantId)}::uuid,
      ${sqlLiteral(tenantCode)},
      'A141 migration isolated tenant',
      'A141 regression',
      ${sqlLiteral(upgradeDatabase)},
      ${sqlLiteral(tenantSchema)},
      ${sqlLiteral(`account-sets/${tenantCode}`)},
      ${sqlLiteral(tenantCode)},
      '2026-07',
      '2026-07',
      TRUE,
      TRUE
    );
    SELECT public.jdy_sync_tenant_schema(${sqlLiteral(tenantSchema)}, TRUE);
    INSERT INTO public.sys_user_account_set (
      user_id, account_set_id, role_code, is_default, enabled
    )
    SELECT id, ${sqlLiteral(tenantId)}::uuid, 'ADMIN', FALSE, TRUE
    FROM public.sys_user
    WHERE username = 'admin';
    COMMIT;
  `);
}

function fixtureSql(schema, fixture) {
  const q = quoteIdentifier(schema);
  return `
    INSERT INTO ${q}.md_customer (id, code, name, enabled, audit_status)
    VALUES (
      ${sqlLiteral(fixture.customerId)}::uuid,
      ${sqlLiteral(fixture.customerCode)},
      ${sqlLiteral(`A141 ${fixture.label} migration customer`)},
      TRUE,
      'AUDITED'
    );
    INSERT INTO ${q}.md_supplier (id, code, name, enabled, audit_status)
    VALUES (
      ${sqlLiteral(fixture.supplierId)}::uuid,
      ${sqlLiteral(fixture.supplierCode)},
      ${sqlLiteral(`A141 ${fixture.label} migration supplier`)},
      TRUE,
      'AUDITED'
    );
    INSERT INTO ${q}.ar_receivable (
      id, bill_no, source_bill_no, customer_id, bill_date, amount,
      received_amount, status, created_at, updated_at
    )
    VALUES (
      ${sqlLiteral(fixture.receivableId)}::uuid,
      ${sqlLiteral(fixture.receivableNo)},
      ${sqlLiteral(`SO-A141-${fixture.label}-${upperToken}`)},
      ${sqlLiteral(fixture.customerId)}::uuid,
      DATE '2026-07-01',
      100.00,
      60.00,
      'PART_SETTLED',
      TIMESTAMPTZ '2026-07-01 01:02:03.123456+00',
      TIMESTAMPTZ '2026-07-03 03:04:05.654321+00'
    );
    INSERT INTO ${q}.ar_receipt (
      id, bill_no, receivable_id, receipt_date, amount, created_at
    )
    VALUES
      (
        ${sqlLiteral(fixture.receiptIds[0])}::uuid,
        ${sqlLiteral(fixture.receiptNos[0])},
        ${sqlLiteral(fixture.receivableId)}::uuid,
        DATE '2026-07-02',
        20.00,
        TIMESTAMPTZ '2026-07-02 02:03:04.111111+00'
      ),
      (
        ${sqlLiteral(fixture.receiptIds[1])}::uuid,
        ${sqlLiteral(fixture.receiptNos[1])},
        ${sqlLiteral(fixture.receivableId)}::uuid,
        DATE '2026-07-03',
        40.00,
        TIMESTAMPTZ '2026-07-03 02:03:04.222222+00'
      );
    INSERT INTO ${q}.ap_payable (
      id, bill_no, source_bill_no, supplier_id, bill_date, amount,
      paid_amount, status, created_at, updated_at
    )
    VALUES (
      ${sqlLiteral(fixture.payableId)}::uuid,
      ${sqlLiteral(fixture.payableNo)},
      ${sqlLiteral(`PI-A141-${fixture.label}-${upperToken}`)},
      ${sqlLiteral(fixture.supplierId)}::uuid,
      DATE '2026-07-04',
      200.00,
      75.00,
      'PART_SETTLED',
      TIMESTAMPTZ '2026-07-04 04:05:06.123456+00',
      TIMESTAMPTZ '2026-07-06 06:07:08.654321+00'
    );
    INSERT INTO ${q}.ap_payment (
      id, bill_no, payable_id, payment_date, amount, created_at
    )
    VALUES
      (
        ${sqlLiteral(fixture.paymentIds[0])}::uuid,
        ${sqlLiteral(fixture.paymentNos[0])},
        ${sqlLiteral(fixture.payableId)}::uuid,
        DATE '2026-07-05',
        30.00,
        TIMESTAMPTZ '2026-07-05 05:06:07.111111+00'
      ),
      (
        ${sqlLiteral(fixture.paymentIds[1])}::uuid,
        ${sqlLiteral(fixture.paymentNos[1])},
        ${sqlLiteral(fixture.payableId)}::uuid,
        DATE '2026-07-06',
        45.00,
        TIMESTAMPTZ '2026-07-06 05:06:07.222222+00'
      );
  `;
}

function insertLegacyFixtures() {
  psql(upgradeDatabase, `
    BEGIN;
    ${fixtureSql("public", fixtures.public)}
    ${fixtureSql(tenantSchema, fixtures.tenant)}
    COMMIT;
  `);
}

function createHistoricalBackup() {
  psql(upgradeDatabase, `
    DO $backup$
    DECLARE
      managed RECORD;
      copied_rows BIGINT := 0;
      table_rows BIGINT;
      admin_id UUID;
    BEGIN
      CREATE SCHEMA ${quoteIdentifier(backupSchema)};
      FOR managed IN
        SELECT table_name
        FROM public.sys_tenant_managed_table
        ORDER BY restore_order, table_name
      LOOP
        EXECUTE format(
          'CREATE TABLE %I.%I AS TABLE %I.%I',
          ${sqlLiteral(backupSchema)}, managed.table_name,
          ${sqlLiteral(tenantSchema)}, managed.table_name
        );
        EXECUTE format('SELECT count(*) FROM %I.%I', ${sqlLiteral(backupSchema)}, managed.table_name)
        INTO table_rows;
        copied_rows := copied_rows + table_rows;
      END LOOP;
      SELECT id INTO STRICT admin_id FROM public.sys_user WHERE username = 'admin';
      INSERT INTO public.sys_account_set_backup (
        id, account_set_id, account_set_code, account_set_name,
        backup_name, backup_schema_name, attachment_prefix,
        table_count, row_count, created_by
      )
      VALUES (
        ${sqlLiteral(backupId)}::uuid,
        ${sqlLiteral(tenantId)}::uuid,
        ${sqlLiteral(tenantCode)},
        'A141 migration isolated tenant',
        ${sqlLiteral(backupName)},
        ${sqlLiteral(backupSchema)},
        ${sqlLiteral(`account-sets/${tenantCode}`)},
        (SELECT count(*) FROM public.sys_tenant_managed_table),
        copied_rows,
        admin_id
      );
    END
    $backup$;
  `);
}

function timestampExpression(column) {
  return `to_char(${column} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
}

function legacySnapshot(schema, fixture, migrated) {
  const q = quoteIdentifier(schema);
  const receiptSourceColumn = migrated ? "legacy_receivable_id" : "receivable_id";
  const receiptDateColumn = migrated ? "bill_date" : "receipt_date";
  const paymentSourceColumn = migrated ? "legacy_payable_id" : "payable_id";
  const paymentDateColumn = migrated ? "bill_date" : "payment_date";
  return sqlJson(upgradeDatabase, `
    SELECT jsonb_build_object(
      'customer', (
        SELECT jsonb_build_object('id', id::text, 'code', code, 'name', name)
        FROM ${q}.md_customer WHERE id = ${sqlLiteral(fixture.customerId)}::uuid
      ),
      'supplier', (
        SELECT jsonb_build_object('id', id::text, 'code', code, 'name', name)
        FROM ${q}.md_supplier WHERE id = ${sqlLiteral(fixture.supplierId)}::uuid
      ),
      'receivable', (
        SELECT jsonb_build_object(
          'id', id::text, 'billNo', bill_no, 'sourceBillNo', source_bill_no,
          'customerId', customer_id::text, 'billDate', bill_date::text,
          'amount', amount::text, 'receivedAmount', received_amount::text,
          'status', status, 'createdAt', ${timestampExpression("created_at")},
          'updatedAt', ${timestampExpression("updated_at")}
        )
        FROM ${q}.ar_receivable WHERE id = ${sqlLiteral(fixture.receivableId)}::uuid
      ),
      'receipts', (
        SELECT COALESCE(jsonb_agg(jsonb_build_object(
          'id', id::text, 'billNo', bill_no,
          'receivableId', ${receiptSourceColumn}::text,
          'billDate', ${receiptDateColumn}::text, 'amount', amount::text,
          'createdAt', ${timestampExpression("created_at")}
        ) ORDER BY ${receiptDateColumn}, created_at, id), '[]'::jsonb)
        FROM ${q}.ar_receipt
        WHERE id IN (${fixture.receiptIds.map((id) => `${sqlLiteral(id)}::uuid`).join(", ")})
      ),
      'payable', (
        SELECT jsonb_build_object(
          'id', id::text, 'billNo', bill_no, 'sourceBillNo', source_bill_no,
          'supplierId', supplier_id::text, 'billDate', bill_date::text,
          'amount', amount::text, 'paidAmount', paid_amount::text,
          'status', status, 'createdAt', ${timestampExpression("created_at")},
          'updatedAt', ${timestampExpression("updated_at")}
        )
        FROM ${q}.ap_payable WHERE id = ${sqlLiteral(fixture.payableId)}::uuid
      ),
      'payments', (
        SELECT COALESCE(jsonb_agg(jsonb_build_object(
          'id', id::text, 'billNo', bill_no,
          'payableId', ${paymentSourceColumn}::text,
          'billDate', ${paymentDateColumn}::text, 'amount', amount::text,
          'createdAt', ${timestampExpression("created_at")}
        ) ORDER BY ${paymentDateColumn}, created_at, id), '[]'::jsonb)
        FROM ${q}.ap_payment
        WHERE id IN (${fixture.paymentIds.map((id) => `${sqlLiteral(id)}::uuid`).join(", ")})
      )
    )::text
  `);
}

function formalSnapshot(schema, fixture) {
  const q = quoteIdentifier(schema);
  return sqlJson(upgradeDatabase, `
    SELECT jsonb_build_object(
      'sources', jsonb_build_object(
        'receivableCurrency', (SELECT currency FROM ${q}.ar_receivable WHERE id = ${sqlLiteral(fixture.receivableId)}::uuid),
        'payableCurrency', (SELECT currency FROM ${q}.ap_payable WHERE id = ${sqlLiteral(fixture.payableId)}::uuid)
      ),
      'receipts', (
        SELECT COALESCE(jsonb_agg(jsonb_build_object(
          'id', id::text, 'partyId', party_id::text, 'currency', currency,
          'status', status, 'version', version::text, 'remark', remark,
          'legacyImported', legacy_imported,
          'createdAt', ${timestampExpression("created_at")},
          'updatedAt', ${timestampExpression("updated_at")},
          'auditedAt', ${timestampExpression("audited_at")},
          'auditedBy', audited_by::text
        ) ORDER BY bill_date, created_at, id), '[]'::jsonb)
        FROM ${q}.ar_receipt
        WHERE id IN (${fixture.receiptIds.map((id) => `${sqlLiteral(id)}::uuid`).join(", ")})
      ),
      'receiptAllocations', (
        SELECT COALESCE(jsonb_agg(jsonb_build_object(
          'receiptId', receipt_id::text, 'lineNo', line_no,
          'receivableId', receivable_id::text, 'sourceAmount', source_amount::text,
          'settledBefore', settled_before::text, 'unsettledBefore', unsettled_before::text,
          'settlementAmount', settlement_amount::text, 'remark', remark
        ) ORDER BY receipt_id, line_no), '[]'::jsonb)
        FROM ${q}.ar_receipt_allocation
        WHERE receipt_id IN (${fixture.receiptIds.map((id) => `${sqlLiteral(id)}::uuid`).join(", ")})
      ),
      'receiptFundLineCount', (
        SELECT count(*) FROM ${q}.ar_receipt_fund_line
        WHERE receipt_id IN (${fixture.receiptIds.map((id) => `${sqlLiteral(id)}::uuid`).join(", ")})
      ),
      'payments', (
        SELECT COALESCE(jsonb_agg(jsonb_build_object(
          'id', id::text, 'partyId', party_id::text, 'currency', currency,
          'status', status, 'version', version::text, 'remark', remark,
          'legacyImported', legacy_imported,
          'createdAt', ${timestampExpression("created_at")},
          'updatedAt', ${timestampExpression("updated_at")},
          'auditedAt', ${timestampExpression("audited_at")},
          'auditedBy', audited_by::text
        ) ORDER BY bill_date, created_at, id), '[]'::jsonb)
        FROM ${q}.ap_payment
        WHERE id IN (${fixture.paymentIds.map((id) => `${sqlLiteral(id)}::uuid`).join(", ")})
      ),
      'paymentAllocations', (
        SELECT COALESCE(jsonb_agg(jsonb_build_object(
          'paymentId', payment_id::text, 'lineNo', line_no,
          'payableId', payable_id::text, 'sourceAmount', source_amount::text,
          'settledBefore', settled_before::text, 'unsettledBefore', unsettled_before::text,
          'settlementAmount', settlement_amount::text, 'remark', remark
        ) ORDER BY payment_id, line_no), '[]'::jsonb)
        FROM ${q}.ap_payment_allocation
        WHERE payment_id IN (${fixture.paymentIds.map((id) => `${sqlLiteral(id)}::uuid`).join(", ")})
      ),
      'paymentFundLineCount', (
        SELECT count(*) FROM ${q}.ap_payment_fund_line
        WHERE payment_id IN (${fixture.paymentIds.map((id) => `${sqlLiteral(id)}::uuid`).join(", ")})
      )
    )::text
  `);
}

function assertFormalMigration(schema, fixture, before, legacy, formal) {
  assert(same(before, legacy), `${schema} legacy settlement/source fields changed during V102`);
  assert(formal.sources.receivableCurrency === "CNY" && formal.sources.payableCurrency === "CNY", `${schema} legacy sources must default to CNY`);
  assert(formal.receipts.length === 2, `${schema} should preserve two legacy receipts`);
  assert(formal.payments.length === 2, `${schema} should preserve two legacy payments`);
  for (const row of formal.receipts) {
    assert(row.partyId === fixture.customerId, `${schema} receipt party mismatch`);
    assert(row.currency === "CNY" && row.status === "AUDITED", `${schema} receipt formal status/currency mismatch`);
    assert(row.version === "0" && row.legacyImported === true, `${schema} receipt legacy/version mismatch`);
    assert(row.remark == null && row.auditedBy == null, `${schema} receipt unexpected mutable metadata`);
    assert(row.createdAt === row.updatedAt && row.createdAt === row.auditedAt, `${schema} receipt timestamps were not preserved`);
  }
  for (const row of formal.payments) {
    assert(row.partyId === fixture.supplierId, `${schema} payment party mismatch`);
    assert(row.currency === "CNY" && row.status === "AUDITED", `${schema} payment formal status/currency mismatch`);
    assert(row.version === "0" && row.legacyImported === true, `${schema} payment legacy/version mismatch`);
    assert(row.remark == null && row.auditedBy == null, `${schema} payment unexpected mutable metadata`);
    assert(row.createdAt === row.updatedAt && row.createdAt === row.auditedAt, `${schema} payment timestamps were not preserved`);
  }
  const expectedReceiptAllocations = [
    {
      receiptId: fixture.receiptIds[0], lineNo: 1, receivableId: fixture.receivableId,
      sourceAmount: "100.00", settledBefore: "0.00", unsettledBefore: "100.00",
      settlementAmount: "20.00", remark: null
    },
    {
      receiptId: fixture.receiptIds[1], lineNo: 1, receivableId: fixture.receivableId,
      sourceAmount: "100.00", settledBefore: "20.00", unsettledBefore: "80.00",
      settlementAmount: "40.00", remark: null
    }
  ].sort((left, right) => left.receiptId.localeCompare(right.receiptId));
  const expectedPaymentAllocations = [
    {
      paymentId: fixture.paymentIds[0], lineNo: 1, payableId: fixture.payableId,
      sourceAmount: "200.00", settledBefore: "0.00", unsettledBefore: "200.00",
      settlementAmount: "30.00", remark: null
    },
    {
      paymentId: fixture.paymentIds[1], lineNo: 1, payableId: fixture.payableId,
      sourceAmount: "200.00", settledBefore: "30.00", unsettledBefore: "170.00",
      settlementAmount: "45.00", remark: null
    }
  ].sort((left, right) => left.paymentId.localeCompare(right.paymentId));
  assert(same(formal.receiptAllocations, expectedReceiptAllocations), `${schema} receipt allocation history mismatch: ${JSON.stringify(formal.receiptAllocations)}`);
  assert(same(formal.paymentAllocations, expectedPaymentAllocations), `${schema} payment allocation history mismatch: ${JSON.stringify(formal.paymentAllocations)}`);
  assert(Number(formal.receiptFundLineCount) === 0 && Number(formal.paymentFundLineCount) === 0, `${schema} legacy rows must not synthesize fund lines`);
}

function migratedSnapshot(schema, fixture) {
  return {
    legacy: legacySnapshot(schema, fixture, true),
    formal: formalSnapshot(schema, fixture)
  };
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
  assert(port > 0, "failed to reserve an isolated backend port");
  return port;
}

async function tailFile(filePath, maximumLength = 12_000) {
  try {
    const content = await readFile(filePath, "utf8");
    return content.slice(-maximumLength);
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
    if (error?.code === "ESRCH") {
      return false;
    }
    if (error?.code === "EPERM") {
      return true;
    }
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
  if (!processInfo || processInfo.stopped) {
    return;
  }
  if (processInfo.stopPromise) {
    return processInfo.stopPromise;
  }
  processInfo.stopPromise = (async () => {
    if (!processGroupIsAlive(processInfo)) {
      processInfo.stopped = true;
      return;
    }
    try {
      process.kill(-processInfo.child.pid, "SIGTERM");
    } catch (error) {
      if (error?.code !== "ESRCH") {
        throw error;
      }
    }
    if (!await waitForProcessGroupExit(processInfo, 8_000)) {
      processInfo.forcedKill = true;
      try {
        process.kill(-processInfo.child.pid, "SIGKILL");
      } catch (error) {
        if (error?.code !== "ESRCH") {
          throw error;
        }
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
  const name = `a141-migration-${token}`;
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
    if (processInfo.spawnError) {
      throw processInfo.spawnError;
    }
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
      // Compilation and startup are still in progress.
    }
    await sleep(500);
  }
  throw new Error(`${name} did not become healthy:\n${await tailFile(logPath)}`);
}

async function apiRequest(baseUrl, cookie, pathname, options = {}) {
  const headers = new Headers(options.headers ?? {});
  if (cookie) {
    headers.set("Cookie", cookie);
  }
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

function clearRedisNamespace() {
  const keysOutput = execFileSync(
    "docker",
    ["exec", redisContainer, "redis-cli", "--raw", "--scan", "--pattern", `${redisNamespace}:*`],
    { encoding: "utf8" }
  ).trim();
  const keys = keysOutput ? keysOutput.split(/\r?\n/).filter(Boolean) : [];
  for (const key of keys) {
    execFileSync("docker", ["exec", redisContainer, "redis-cli", "DEL", key], { encoding: "utf8" });
  }
  return keys.length;
}

function exitLastResort() {
  for (const processInfo of [...processes].reverse()) {
    if (!processGroupIsAlive(processInfo)) {
      continue;
    }
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
  if (cleanupPromise) {
    return cleanupPromise;
  }
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
      const remaining = clearRedisNamespace();
      assert(remaining === 0, `Redis namespace still has ${remaining} keys`);
    } catch (error) {
      result.cleanup.errors.push(`Redis cleanup: ${errorText(error)}`);
    }
    for (const database of [upgradeDatabase, freshDatabase]) {
      try {
        dropDatabase(database);
      } catch (error) {
        result.cleanup.errors.push(`drop database ${database}: ${errorText(error)}`);
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
      result.cleanup.errors.push(`database residue check: ${errorText(error)}`);
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

const signalExitCodes = new Map([
  ["SIGHUP", 129],
  ["SIGINT", 130],
  ["SIGTERM", 143]
]);
const signalHandlers = new Map();
function removeLifecycleHandlers() {
  for (const [signal, handler] of signalHandlers) {
    process.removeListener(signal, handler);
  }
  process.removeListener("exit", exitLastResort);
}
for (const [signal, exitCode] of signalExitCodes) {
  const handler = () => {
    if (signalBeingHandled) {
      return;
    }
    signalBeingHandled = signal;
    primaryError ??= new Error(`received ${signal}`);
    process.exitCode = exitCode;
    void cleanup().finally(async () => {
      result.ok = false;
      result.error = errorText(primaryError);
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
  result.upgrade.target101.flywayOutputTail = flywayMigrate(upgradeDatabase, 101);
  const target101History = migrationHistory(upgradeDatabase);
  const target101Versions = target101History.map((row) => row.version);
  assert(target101History.every((row) => row.success === true), "target=101 history contains a failed migration");
  assert(target101Versions.includes("101") && !target101Versions.includes("102"), "target=101 did not stop before V102");
  result.upgrade.target101.historyCount = target101History.length;
  result.upgrade.target101.minVersion = target101Versions[0];
  result.upgrade.target101.maxVersion = target101Versions.at(-1);
  result.upgrade.target101.v102Absent = true;

  createTenant();
  insertLegacyFixtures();
  createHistoricalBackup();
  const beforeSnapshots = {
    public: legacySnapshot("public", fixtures.public, false),
    tenant: legacySnapshot(tenantSchema, fixtures.tenant, false),
    backup: legacySnapshot(backupSchema, fixtures.tenant, false)
  };
  assert(same(beforeSnapshots.tenant, beforeSnapshots.backup), "V101 backup does not exactly match the tenant fixture");
  result.upgrade.fixtures = {
    schemas: ["public", tenantSchema, backupSchema],
    receiptsPerSchema: 2,
    paymentsPerSchema: 2,
    tenantBackupExactBeforeMigration: true,
    digestsBefore: Object.fromEntries(Object.entries(beforeSnapshots).map(([schema, value]) => [schema, digest(value)]))
  };

  result.upgrade.migration102.flywayOutputTail = flywayMigrate(upgradeDatabase);
  const migratedHistory = migrationHistory(upgradeDatabase);
  const v102Rows = migratedHistory.filter((row) => row.version === "102");
  assert(v102Rows.length === 1 && v102Rows[0].success === true, `V102 history mismatch: ${JSON.stringify(v102Rows)}`);
  const migratedSnapshots = {
    public: migratedSnapshot("public", fixtures.public),
    tenant: migratedSnapshot(tenantSchema, fixtures.tenant),
    backup: migratedSnapshot(backupSchema, fixtures.tenant)
  };
  assertFormalMigration("public", fixtures.public, beforeSnapshots.public, migratedSnapshots.public.legacy, migratedSnapshots.public.formal);
  assertFormalMigration(tenantSchema, fixtures.tenant, beforeSnapshots.tenant, migratedSnapshots.tenant.legacy, migratedSnapshots.tenant.formal);
  assertFormalMigration(backupSchema, fixtures.tenant, beforeSnapshots.backup, migratedSnapshots.backup.legacy, migratedSnapshots.backup.formal);
  assert(same(migratedSnapshots.tenant, migratedSnapshots.backup), "migrated tenant and backup settlement semantics differ");
  result.upgrade.migration102 = {
    ...result.upgrade.migration102,
    history: v102Rows[0],
    preservedSchemas: ["public", tenantSchema, backupSchema],
    arApTotalsUnchanged: true,
    legacyHeadersPreserved: true,
    allocationHistoryReconstructed: true,
    syntheticFundLines: 0,
    digestsAfter: Object.fromEntries(Object.entries(migratedSnapshots).map(([schema, value]) => [schema, digest(value)]))
  };

  const repeatFlywayOutput = flywayMigrate(upgradeDatabase);
  const repeatFlywayHistory = migrationHistory(upgradeDatabase);
  const repeatFlywaySnapshots = {
    public: migratedSnapshot("public", fixtures.public),
    tenant: migratedSnapshot(tenantSchema, fixtures.tenant),
    backup: migratedSnapshot(backupSchema, fixtures.tenant)
  };
  assert(same(repeatFlywayHistory, migratedHistory), "repeat Flyway migrate changed migration history");
  assert(same(repeatFlywaySnapshots, migratedSnapshots), "repeat Flyway migrate changed migrated settlement semantics");
  result.upgrade.repeatFlyway = {
    flywayOutputTail: repeatFlywayOutput,
    historyCountBefore: migratedHistory.length,
    historyCountAfter: repeatFlywayHistory.length,
    historyDigestBefore: digest(migratedHistory),
    historyDigestAfter: digest(repeatFlywayHistory),
    settlementDigestsBefore: Object.fromEntries(
      Object.entries(migratedSnapshots).map(([schema, value]) => [schema, digest(value)])
    ),
    settlementDigestsAfter: Object.fromEntries(
      Object.entries(repeatFlywaySnapshots).map(([schema, value]) => [schema, digest(value)])
    ),
    historyUnchanged: true,
    settlementSemanticsUnchanged: true
  };

  const tenantBeforeSync = migratedSnapshot(tenantSchema, fixtures.tenant);
  const syncCounts = [
    Number(psql(upgradeDatabase, `SELECT public.jdy_sync_tenant_schema(${sqlLiteral(tenantSchema)}, FALSE)`)),
    Number(psql(upgradeDatabase, `SELECT public.jdy_sync_tenant_schema(${sqlLiteral(tenantSchema)}, FALSE)`))
  ];
  const tenantAfterSync = migratedSnapshot(tenantSchema, fixtures.tenant);
  assert(same(syncCounts, [78, 78]), `repeat tenant sync counts should be 78/78, got ${JSON.stringify(syncCounts)}`);
  assert(same(tenantBeforeSync, tenantAfterSync), "repeat tenant sync changed migrated settlement data");
  result.upgrade.repeatTenantSync = {
    managedCounts: syncCounts,
    beforeDigest: digest(tenantBeforeSync),
    afterDigest: digest(tenantAfterSync),
    idempotent: true
  };

  psql(upgradeDatabase, `
    BEGIN;
    DELETE FROM ${quoteIdentifier(tenantSchema)}.ar_receipt
    WHERE id IN (${fixtures.tenant.receiptIds.map((id) => `${sqlLiteral(id)}::uuid`).join(", ")});
    DELETE FROM ${quoteIdentifier(tenantSchema)}.ap_payment
    WHERE id IN (${fixtures.tenant.paymentIds.map((id) => `${sqlLiteral(id)}::uuid`).join(", ")});
    UPDATE ${quoteIdentifier(tenantSchema)}.ar_receivable
    SET received_amount = 0, status = 'OPEN'
    WHERE id = ${sqlLiteral(fixtures.tenant.receivableId)}::uuid;
    UPDATE ${quoteIdentifier(tenantSchema)}.ap_payable
    SET paid_amount = 0, status = 'OPEN'
    WHERE id = ${sqlLiteral(fixtures.tenant.payableId)}::uuid;
    COMMIT;
  `);
  const mutatedCounts = sqlJson(upgradeDatabase, `
    SELECT jsonb_build_object(
      'receipts', (SELECT count(*) FROM ${quoteIdentifier(tenantSchema)}.ar_receipt WHERE id IN (${fixtures.tenant.receiptIds.map((id) => `${sqlLiteral(id)}::uuid`).join(", ")})),
      'payments', (SELECT count(*) FROM ${quoteIdentifier(tenantSchema)}.ap_payment WHERE id IN (${fixtures.tenant.paymentIds.map((id) => `${sqlLiteral(id)}::uuid`).join(", ")})),
      'received', (SELECT received_amount::text FROM ${quoteIdentifier(tenantSchema)}.ar_receivable WHERE id = ${sqlLiteral(fixtures.tenant.receivableId)}::uuid),
      'paid', (SELECT paid_amount::text FROM ${quoteIdentifier(tenantSchema)}.ap_payable WHERE id = ${sqlLiteral(fixtures.tenant.payableId)}::uuid)
    )::text
  `);
  assert(Number(mutatedCounts.receipts) === 0 && Number(mutatedCounts.payments) === 0, "restore precondition mutation did not remove settlement headers");
  assert(mutatedCounts.received === "0.00" && mutatedCounts.paid === "0.00", "restore precondition mutation did not change AR/AP totals");

  const backend = await startBackend();
  let cookie = null;
  try {
    cookie = await loginApi(backend.baseUrl, "admin", "admin123", tenantCode);
    const session = await apiRequest(backend.baseUrl, cookie, "/api/system/session");
    assert(session.status === 200 && session.data?.tenant?.code === tenantCode, `isolated tenant session failed: ${session.text}`);
    const restore = await apiRequest(
      backend.baseUrl,
      cookie,
      `/api/system/account-sets/current/backups/${encodeURIComponent(backupName)}/restore`,
      { method: "POST", timeoutMs: 120_000 }
    );
    assert(restore.status === 200 && restore.data?.ok === true, `real restore API failed ${restore.status}: ${restore.text}`);
    const restored = migratedSnapshot(tenantSchema, fixtures.tenant);
    assert(same(restored, migratedSnapshots.backup), "real restore API did not restore migrated backup settlement semantics");
    const restoreMetadata = sqlJson(upgradeDatabase, `
      SELECT jsonb_build_object(
        'restoredAtSet', restored_at IS NOT NULL,
        'restoredBySet', restored_by IS NOT NULL,
        'backupSchema', backup_schema_name,
        'backupName', backup_name
      )::text
      FROM public.sys_account_set_backup
      WHERE id = ${sqlLiteral(backupId)}::uuid
    `);
    assert(restoreMetadata.restoredAtSet === true && restoreMetadata.restoredBySet === true, "restore metadata was not updated");
    result.upgrade.restoreApi = {
      status: restore.status,
      backupName,
      backupSchema,
      mutationBeforeRestore: mutatedCounts,
      restoredDigest: digest(restored),
      backupDigest: digest(migratedSnapshots.backup),
      exactSemanticRestore: true,
      metadata: restoreMetadata
    };
  } finally {
    if (cookie) {
      const logout = await apiRequest(backend.baseUrl, cookie, "/api/system/logout", { method: "POST", timeoutMs: 10_000 }).catch(() => null);
      result.upgrade.restoreApi.logoutStatus = logout?.status ?? null;
    }
    await stopBackend(backend);
  }

  createDatabase(freshDatabase);
  result.fresh.flywayOutputTail = flywayMigrate(freshDatabase);
  const freshHistory = migrationHistory(freshDatabase);
  const sourceFiles = (await readdir(migrationDir))
    .filter((name) => /^V\d+__.+\.sql$/.test(name))
    .sort((left, right) => Number(left.match(/^V(\d+)/)[1]) - Number(right.match(/^V(\d+)/)[1]));
  const historyScripts = freshHistory.map((row) => row.script);
  assert(freshHistory.every((row) => row.success === true), "fresh history contains a failed migration");
  assert(same(historyScripts, sourceFiles), "fresh Flyway history does not exactly match the versioned migration source set");
  const freshMetrics = sqlJson(freshDatabase, `
    SELECT jsonb_build_object(
      'managedTables', (SELECT count(*) FROM public.sys_tenant_managed_table),
      'formalTables', (
        SELECT count(*) FROM information_schema.tables
        WHERE table_schema = 'public'
          AND table_name IN ('ar_receipt_fund_line', 'ar_receipt_allocation', 'ap_payment_fund_line', 'ap_payment_allocation')
      ),
      'legacyReceipts', (SELECT count(*) FROM public.ar_receipt WHERE legacy_imported),
      'legacyPayments', (SELECT count(*) FROM public.ap_payment WHERE legacy_imported),
      'nonPublicRegisteredTenants', (
        SELECT count(*) FROM public.sys_account_set
        WHERE nullif(btrim(schema_name), '') IS NOT NULL AND lower(btrim(schema_name)) <> 'public'
      )
    )::text
  `);
  assert(Number(freshMetrics.managedTables) === 78, `fresh managed table count should be 78: ${JSON.stringify(freshMetrics)}`);
  assert(Number(freshMetrics.formalTables) === 4, `fresh formal settlement table count should be four: ${JSON.stringify(freshMetrics)}`);
  assert(Number(freshMetrics.legacyReceipts) === 0 && Number(freshMetrics.legacyPayments) === 0, `fresh database unexpectedly contains legacy settlements: ${JSON.stringify(freshMetrics)}`);
  assert(Number(freshMetrics.nonPublicRegisteredTenants) === 0, `fresh database unexpectedly registered tenant schemas: ${JSON.stringify(freshMetrics)}`);
  result.fresh = {
    ...result.fresh,
    historyCount: freshHistory.length,
    sourceMigrationCount: sourceFiles.length,
    minVersion: freshHistory[0]?.version,
    maxVersion: freshHistory.at(-1)?.version,
    exactSourceHistory: true,
    metrics: freshMetrics
  };
} catch (error) {
  primaryError = error;
} finally {
  await cleanup();
  removeLifecycleHandlers();
  result.ok = primaryError == null && result.cleanup.errors.length === 0;
  if (primaryError) {
    result.error = errorText(primaryError);
  } else if (result.cleanup.errors.length > 0) {
    result.error = result.cleanup.errors.join("; ");
  }
  await writeFile(resultPath, `${JSON.stringify(result, null, 2)}\n`);
}

if (primaryError) {
  throw primaryError;
}
if (result.cleanup.errors.length > 0) {
  throw new Error(result.cleanup.errors.join("; "));
}

console.log(JSON.stringify({
  ok: result.ok,
  result: path.relative(rootDir, resultPath),
  upgrade: {
    target: result.upgrade.target101.maxVersion,
    migrated: result.upgrade.migration102.history?.version,
    tenantSync: result.upgrade.repeatTenantSync.managedCounts,
    restoreStatus: result.upgrade.restoreApi.status
  },
  fresh: {
    historyCount: result.fresh.historyCount,
    maxVersion: result.fresh.maxVersion
  },
  cleanup: result.cleanup
}, null, 2));
