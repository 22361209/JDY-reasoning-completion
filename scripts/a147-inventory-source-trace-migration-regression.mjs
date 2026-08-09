#!/usr/bin/env node

import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { open, readFile, unlink } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { loginApi } from "./helpers/regression-auth.mjs";
import {
  registerRegressionProcessTree,
  regressionProcessTreeIsAlive,
  signalRegressionProcessTree
} from "./helpers/regression-process-tree.mjs";

const root = path.resolve(import.meta.dirname, "..");
const migrationDir = path.join(root, "backend/src/main/resources/db/migration");
const container = process.env.JDY_POSTGRES_CONTAINER || "jdy-erp-postgres";
const redisContainer = process.env.JDY_REDIS_CONTAINER || "jdy-erp-redis";
const user = process.env.JDY_DATABASE_USER || "jdy";
const password = process.env.JDY_DATABASE_PASSWORD || "jdy_dev";
const token = randomBytes(6).toString("hex");
const database = `jdy_a147_mig_${token}`;
const freshDatabase = `jdy_a147_fresh_${token}`;
const tenantSchema = `tenant_a147_mig_${token}`;
const newTenantSchema = `tenant_a147_new_${token}`;
const backupSchema = `bk_a147_mig_${token}`;
const tenantId = randomUUID();
const newTenantId = randomUUID();
const backupId = randomUUID();
const redisNamespace = `jdy:a147:migration:${token}`;
const passwordResetPrefix = `jdy:a147:{migration-${token}}:password-reset`;

const fixture = {
  categoryId: randomUUID(),
  unitId: randomUUID(),
  productId: randomUUID(),
  warehouseId: randomUUID(),
  supplierId: randomUUID(),
  publicHeaderId: randomUUID(),
  publicTxnId: randomUUID(),
  publicUnknownTxnId: randomUUID(),
  publicTestTxnId: randomUUID(),
  tenantHeaderId: randomUUID(),
  tenantTxnId: randomUUID(),
  productionBomId: randomUUID(),
  productionPlanId: randomUUID(),
  productionTaskId: randomUUID(),
  productionHeaderId: randomUUID(),
  productionAuditTxnId: randomUUID(),
  productionRedTxnId: randomUUID(),
  productionReverseTxnId: randomUUID(),
  productionRedReverseTxnId: randomUUID(),
  legacySourceId: randomUUID(),
  publicBillNo: `CGRK-A147-P-${token.toUpperCase()}`,
  tenantBillNo: `CGRK-A147-T-${token.toUpperCase()}`,
  productionBillNo: `CPRK-A147-${token.toUpperCase()}`,
  productCode: `A147-P-${token.toUpperCase()}`,
  warehouseCode: `A147-W-${token.toUpperCase()}`,
  supplierCode: `A147-S-${token.toUpperCase()}`
};

const restoreFixture = {
  headerId: randomUUID(),
  lineId: randomUUID(),
  firstAuditTxnId: randomUUID(),
  reverseTxnId: randomUUID(),
  secondAuditTxnId: randomUUID(),
  billNo: `QTRK-A147-BR-${token.toUpperCase()}`
};

function literal(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function identifier(value) {
  assert(/^[a-z][a-z0-9_]{0,62}$/.test(value), `unsafe identifier: ${value}`);
  return `"${value}"`;
}

function psqlDatabase(databaseName, statement) {
  return execFileSync(
    "docker",
    ["exec", container, "psql", "-X", "-v", "ON_ERROR_STOP=1", "-U", user, "-d", databaseName, "-tAq", "-c", statement],
    { encoding: "utf8", maxBuffer: 20 * 1024 * 1024 }
  ).trim();
}

function psql(statement) {
  return psqlDatabase(database, statement);
}

function flyway(databaseName, target = null) {
  const args = [
    "org.flywaydb:flyway-maven-plugin:11.7.2:migrate",
    `-Dflyway.url=jdbc:postgresql://localhost:5432/${databaseName}`,
    `-Dflyway.user=${user}`,
    `-Dflyway.password=${password}`,
    `-Dflyway.locations=filesystem:${migrationDir}`
  ];
  if (target != null) args.push(`-Dflyway.target=${target}`);
  execFileSync("./scripts/backend-test.sh", args, {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 40 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"]
  });
}

function scalar(statement) {
  return psql(statement).split(/\r?\n/).at(-1);
}

function scalarDatabase(databaseName, statement) {
  return psqlDatabase(databaseName, statement).split(/\r?\n/).at(-1);
}

function assertColumns(schema, databaseName = database) {
  const count = Number(scalarDatabase(databaseName, `
    SELECT count(*)
    FROM information_schema.columns
    WHERE table_schema = ${literal(schema)}
      AND table_name = 'inv_stock_txn'
      AND column_name IN (
        'source_bill_no', 'source_bill_date', 'posting_action',
        'qty_on_hand_after', 'trace_quality', 'reversal_of_txn_id'
      )
  `));
  assert.equal(count, 6, `${schema}.inv_stock_txn must expose all V106 trace columns`);
}

function assertIndexes(schema, requireStableNames = true, databaseName = database) {
  const predicate = requireStableNames
    ? `indexname IN (
        'idx_inv_stock_txn_scope_business_time',
        'idx_inv_stock_txn_exact_source',
        'idx_inv_stock_txn_reversal',
        'idx_inv_stock_txn_exact_posting_fact'
      )`
    : `(indexdef LIKE '%(account_set_id, source_bill_date DESC, occurred_at DESC, id DESC)%'
        OR indexdef LIKE '%(account_set_id, source_bill_type, source_bill_id, source_bill_line_id)%'
        OR indexdef LIKE '%(account_set_id, reversal_of_txn_id)%reversal_of_txn_id IS NOT NULL%'
        OR indexdef LIKE '%(account_set_id, source_bill_type, source_bill_id, source_bill_line_id, posting_action, txn_type)%trace_quality%EXACT%')`;
  const count = Number(scalarDatabase(databaseName, `
    SELECT count(*)
    FROM pg_indexes
    WHERE schemaname = ${literal(schema)}
      AND tablename = 'inv_stock_txn'
      AND ${predicate}
  `));
  assert.equal(count, 4, `${schema}.inv_stock_txn must expose all V106 indexes`);
  assertExactPostingIndex(schema, databaseName);
}

function assertExactPostingIndex(schema, databaseName = database) {
  assert.equal(scalarDatabase(databaseName, `
    SELECT count(*)
    FROM pg_indexes
    WHERE schemaname = ${literal(schema)}
      AND tablename = 'inv_stock_txn'
      AND indexdef LIKE '%(account_set_id, source_bill_type, source_bill_id, source_bill_line_id, posting_action, txn_type)%trace_quality%EXACT%'
  `), "1", `${schema} must expose exactly one exact posting fact index`);
  assert.equal(scalarDatabase(databaseName, `
    SELECT bool_or(indexdef LIKE 'CREATE UNIQUE INDEX%')
    FROM pg_indexes
    WHERE schemaname = ${literal(schema)}
      AND tablename = 'inv_stock_txn'
      AND indexdef LIKE '%(account_set_id, source_bill_type, source_bill_id, source_bill_line_id, posting_action, txn_type)%trace_quality%EXACT%'
  `), "f", `${schema} exact posting fact index must allow audit/reverse/re-audit history`);
  assert.equal(scalarDatabase(databaseName, `
    SELECT count(*)
    FROM pg_indexes
    WHERE schemaname = ${literal(schema)}
      AND tablename = 'inv_stock_txn'
      AND indexname = 'uq_inv_stock_txn_exact_posting_fact'
  `), "0", `${schema} must not retain the published unique exact-fact index`);
}

function assertMigrationHistory(databaseName) {
  assert.equal(
    scalarDatabase(databaseName, "SELECT checksum FROM public.flyway_schema_history WHERE version = '106'"),
    "1207842815",
    `${databaseName} must resolve the immutable published V106 checksum`
  );
  assert.equal(
    scalarDatabase(databaseName, "SELECT success FROM public.flyway_schema_history WHERE version = '107'"),
    "t",
    `${databaseName} must apply the A147 forward correction`
  );
}

function insertAccountSet(id, code, schema) {
  psql(`
    INSERT INTO public.sys_account_set (
      id, code, name, environment, database_name, schema_name,
      attachment_prefix, redis_key_prefix, accounting_period, business_period,
      enabled, initialized
    ) VALUES (
      ${literal(id)}::uuid, ${literal(code)}, ${literal(code)}, 'A147 regression',
      ${literal(database)}, ${literal(schema)}, ${literal(`account-sets/${code}`)},
      ${literal(code)}, '2026-07', '2026-07', TRUE, TRUE
    );
    SELECT public.jdy_sync_tenant_schema(${literal(schema)}, TRUE);
  `);
}

function seedSchema(schema, headerId, txnId, billNo, accountSetId) {
  const q = identifier(schema);
  psql(`
    INSERT INTO ${q}.md_product_category (id, code, name, enabled, audit_status)
    VALUES (${literal(fixture.categoryId)}::uuid, ${literal(`${fixture.productCode}-C`)}, 'A147 category', TRUE, 'AUDITED');
    INSERT INTO ${q}.md_unit (id, code, name, enabled, audit_status)
    VALUES (
      ${literal(fixture.unitId)}::uuid, ${literal(`${fixture.productCode}-U`)},
      ${literal(`A147 unit ${token}`)}, TRUE, 'AUDITED'
    );
    INSERT INTO ${q}.md_warehouse (id, code, name, enabled, audit_status)
    VALUES (${literal(fixture.warehouseId)}::uuid, ${literal(fixture.warehouseCode)}, 'A147 warehouse', TRUE, 'AUDITED');
    INSERT INTO ${q}.md_supplier (id, code, name, enabled, audit_status)
    VALUES (${literal(fixture.supplierId)}::uuid, ${literal(fixture.supplierCode)}, 'A147 supplier', TRUE, 'AUDITED');
    INSERT INTO ${q}.md_product (
      id, code, name, unit, category, product_category_id, unit_id, enabled, audit_status
    ) VALUES (
      ${literal(fixture.productId)}::uuid, ${literal(fixture.productCode)}, 'A147 product',
      ${literal(`${fixture.productCode}-U`)}, 'A147 category',
      ${literal(fixture.categoryId)}::uuid, ${literal(fixture.unitId)}::uuid, TRUE, 'AUDITED'
    );
    INSERT INTO ${q}.purchase_in (id, bill_no, supplier_id, bill_date, status, total_amount)
    VALUES (
      ${literal(headerId)}::uuid, ${literal(billNo)}, ${literal(fixture.supplierId)}::uuid,
      DATE '2026-07-13', 'AUDITED', 0
    );
    INSERT INTO ${q}.inv_stock_txn (
      id, account_set_id, txn_type, product_id, warehouse_id, qty_delta,
      source_bill_type, source_bill_id, source_bill_line_id, amount
    ) VALUES (
      ${literal(txnId)}::uuid, ${literal(accountSetId)}::uuid, 'PURCHASE_IN',
      ${literal(fixture.productId)}::uuid, ${literal(fixture.warehouseId)}::uuid, 2,
      ${literal(`PURCHASE_IN:${billNo}`)}, ${literal(fixture.legacySourceId)}::uuid, NULL, 0
    );
    INSERT INTO ${q}.prod_bom (id, code, product_id, qty, enabled)
    VALUES (
      ${literal(fixture.productionBomId)}::uuid,
      ${literal(`BOM-${fixture.productionBillNo}`)},
      ${literal(fixture.productId)}::uuid, 1, TRUE
    );
    INSERT INTO ${q}.production_plan (
      id, bill_no, bom_id, product_id, warehouse_id, planned_qty, status
    ) VALUES (
      ${literal(fixture.productionPlanId)}::uuid,
      ${literal(`SCJH-${fixture.productionBillNo}`)},
      ${literal(fixture.productionBomId)}::uuid,
      ${literal(fixture.productId)}::uuid,
      ${literal(fixture.warehouseId)}::uuid, 5, 'AUDITED'
    );
    INSERT INTO ${q}.production_task (
      id, bill_no, bom_id, product_id, warehouse_id, qty,
      issued_qty, completed_qty, status, plan_id
    ) VALUES (
      ${literal(fixture.productionTaskId)}::uuid,
      ${literal(`SCRW-${fixture.productionBillNo}`)},
      ${literal(fixture.productionBomId)}::uuid,
      ${literal(fixture.productId)}::uuid,
      ${literal(fixture.warehouseId)}::uuid,
      5, 0, 5, 'AUDITED', ${literal(fixture.productionPlanId)}::uuid
    );
    INSERT INTO ${q}.production_completion (
      id, bill_no, task_id, qty, status, created_at
    ) VALUES (
      ${literal(fixture.productionHeaderId)}::uuid,
      ${literal(fixture.productionBillNo)},
      ${literal(fixture.productionTaskId)}::uuid,
      5, 'AUDITED', TIMESTAMPTZ '2026-07-13 16:30:00+00'
    );
    INSERT INTO ${q}.inv_stock_txn (
      id, account_set_id, txn_type, product_id, warehouse_id, qty_delta,
      source_bill_type, source_bill_id, source_bill_line_id, amount
    ) VALUES
      (
        ${literal(fixture.productionAuditTxnId)}::uuid,
        ${literal(accountSetId)}::uuid, 'PRODUCTION_COMPLETE',
        ${literal(fixture.productId)}::uuid, ${literal(fixture.warehouseId)}::uuid, 5,
        ${literal(`PRODUCTION_COMPLETE:${fixture.productionBillNo}`)},
        ${literal(fixture.legacySourceId)}::uuid, NULL, 0
      ),
      (
        ${literal(fixture.productionRedTxnId)}::uuid,
        ${literal(accountSetId)}::uuid, 'PRODUCTION_COMPLETE_RED',
        ${literal(fixture.productId)}::uuid, ${literal(fixture.warehouseId)}::uuid, -5,
        ${literal(`PRODUCTION_COMPLETE_RED:${fixture.productionBillNo}`)},
        ${literal(fixture.legacySourceId)}::uuid, NULL, 0
      ),
      (
        ${literal(fixture.productionReverseTxnId)}::uuid,
        ${literal(accountSetId)}::uuid, 'PRODUCTION_COMPLETE_REVERSE',
        ${literal(fixture.productId)}::uuid, ${literal(fixture.warehouseId)}::uuid, -5,
        ${literal(`PRODUCTION_COMPLETE_REVERSE:${fixture.productionBillNo}`)},
        ${literal(fixture.legacySourceId)}::uuid, NULL, 0
      ),
      (
        ${literal(fixture.productionRedReverseTxnId)}::uuid,
        ${literal(accountSetId)}::uuid, 'PRODUCTION_COMPLETE_RED_REVERSE',
        ${literal(fixture.productId)}::uuid, ${literal(fixture.warehouseId)}::uuid, 5,
        ${literal(`PRODUCTION_COMPLETE_RED_REVERSE:${fixture.productionBillNo}`)},
        ${literal(fixture.legacySourceId)}::uuid, NULL, 0
      );
  `);
}

function seedRestoreCycle() {
  const q = identifier(tenantSchema);
  psql(`
    INSERT INTO ${q}.other_stock_in (id, bill_no, bill_date, status, total_amount)
    VALUES (
      ${literal(restoreFixture.headerId)}::uuid,
      ${literal(restoreFixture.billNo)}, DATE '2026-07-14', 'AUDITED', 7
    );
    INSERT INTO ${q}.other_stock_in_line (
      id, bill_id, line_no, product_id, warehouse_id, qty, unit_price, amount
    ) VALUES (
      ${literal(restoreFixture.lineId)}::uuid,
      ${literal(restoreFixture.headerId)}::uuid, 1,
      ${literal(fixture.productId)}::uuid,
      ${literal(fixture.warehouseId)}::uuid, 7, 1, 7
    );
    INSERT INTO ${q}.inv_stock_balance (
      account_set_id, product_id, warehouse_id, qty_on_hand, qty_available, qty_reserved
    ) VALUES (
      ${literal(tenantId)}::uuid,
      ${literal(fixture.productId)}::uuid,
      ${literal(fixture.warehouseId)}::uuid, 7, 7, 0
    ) ON CONFLICT (account_set_id, product_id, warehouse_id) DO UPDATE
      SET qty_on_hand = 7, qty_available = 7, qty_reserved = 0;
    INSERT INTO ${q}.inv_stock_txn (
      id, account_set_id, txn_type, product_id, warehouse_id, qty_delta,
      source_bill_type, source_bill_id, source_bill_line_id,
      source_bill_no, source_bill_date, posting_action,
      qty_on_hand_after, trace_quality, reversal_of_txn_id, amount, occurred_at
    ) VALUES
      (
        ${literal(restoreFixture.firstAuditTxnId)}::uuid,
        ${literal(tenantId)}::uuid, 'OTHER_STOCK_IN',
        ${literal(fixture.productId)}::uuid, ${literal(fixture.warehouseId)}::uuid, 7,
        'OTHER_STOCK_IN', ${literal(restoreFixture.headerId)}::uuid,
        ${literal(restoreFixture.lineId)}::uuid, ${literal(restoreFixture.billNo)},
        DATE '2026-07-14', 'AUDIT', 7, 'EXACT', NULL, 0,
        TIMESTAMPTZ '2026-07-14 01:00:00+00'
      ),
      (
        ${literal(restoreFixture.reverseTxnId)}::uuid,
        ${literal(tenantId)}::uuid, 'OTHER_STOCK_IN_REVERSE',
        ${literal(fixture.productId)}::uuid, ${literal(fixture.warehouseId)}::uuid, -7,
        'OTHER_STOCK_IN', ${literal(restoreFixture.headerId)}::uuid,
        ${literal(restoreFixture.lineId)}::uuid, ${literal(restoreFixture.billNo)},
        DATE '2026-07-14', 'REVERSE', 0, 'EXACT',
        ${literal(restoreFixture.firstAuditTxnId)}::uuid, 0,
        TIMESTAMPTZ '2026-07-14 01:00:01+00'
      ),
      (
        ${literal(restoreFixture.secondAuditTxnId)}::uuid,
        ${literal(tenantId)}::uuid, 'OTHER_STOCK_IN',
        ${literal(fixture.productId)}::uuid, ${literal(fixture.warehouseId)}::uuid, 7,
        'OTHER_STOCK_IN', ${literal(restoreFixture.headerId)}::uuid,
        ${literal(restoreFixture.lineId)}::uuid, ${literal(restoreFixture.billNo)},
        DATE '2026-07-14', 'AUDIT', 7, 'EXACT', NULL, 0,
        TIMESTAMPTZ '2026-07-14 01:00:02+00'
      );
  `);
}

function traceSnapshot(schema) {
  const q = identifier(schema);
  return psql(`
    SELECT concat_ws('|', id::text, source_bill_type, source_bill_id::text,
      source_bill_line_id::text, source_bill_no, source_bill_date::text,
      posting_action, qty_delta::text, qty_on_hand_after::text,
      COALESCE(reversal_of_txn_id::text, 'NULL'), trace_quality)
    FROM ${q}.inv_stock_txn
    WHERE source_bill_id = ${literal(restoreFixture.headerId)}::uuid
    ORDER BY occurred_at, id
  `).split(/\r?\n/).filter(Boolean);
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
    return (await readFile(filePath, "utf8")).slice(-maximumLength);
  } catch {
    return "";
  }
}

function processGroupIsAlive(processInfo) {
  return regressionProcessTreeIsAlive(processInfo);
}

async function stopBackend(processInfo) {
  if (!processGroupIsAlive(processInfo)) return;
  signalRegressionProcessTree(processInfo, "SIGTERM");
  const deadline = Date.now() + 8_000;
  while (processGroupIsAlive(processInfo) && Date.now() < deadline) await sleep(100);
  if (processGroupIsAlive(processInfo)) {
    signalRegressionProcessTree(processInfo, "SIGKILL");
    const killDeadline = Date.now() + 3_000;
    while (processGroupIsAlive(processInfo) && Date.now() < killDeadline) await sleep(100);
  }
  assert(!processGroupIsAlive(processInfo), "isolated A147 backend process group did not terminate");
}

async function startBackend() {
  const port = await reserveHttpPort();
  assert.notEqual(port, 8080, "A147 migration regression must never bind the live backend port");
  const logPath = path.join("/tmp", `a147-migration-backend-${token}.log`);
  const logFile = await open(logPath, "w");
  const env = {
    ...process.env,
    JAVA_HOME: process.env.JAVA_HOME || "/opt/homebrew/opt/openjdk@21/libexec/openjdk.jdk/Contents/Home",
    JDY_SERVER_PORT: String(port),
    JDY_DB_URL: `jdbc:postgresql://127.0.0.1:5432/${database}`,
    JDY_DB_USERNAME: user,
    JDY_DB_PASSWORD: password,
    JDY_REDIS_HOST: "127.0.0.1",
    JDY_REDIS_PORT: "6379",
    SPRING_SESSION_REDIS_NAMESPACE: redisNamespace,
    JDY_PASSWORD_RESET_REDIS_KEY_PREFIX: passwordResetPrefix,
    JDY_PASSWORD_RESET_CLEANUP_FIXED_DELAY_MS: "3600000",
    JDY_PASSWORD_RESET_CLEANUP_INITIAL_DELAY_MS: "3600000"
  };
  delete env.SPRING_APPLICATION_JSON;
  delete env.SPRING_PROFILES_DEFAULT;
  delete env.SPRING_PROFILES_INCLUDE;
  const child = spawn("./mvnw", ["spring-boot:run"], {
    cwd: path.join(root, "backend"),
    env,
    detached: false,
    stdio: ["ignore", logFile.fd, logFile.fd]
  });
  const processInfo = { child, port, baseUrl: `http://127.0.0.1:${port}`, logPath, spawnError: null };
  spawnedBackend = processInfo;
  child.once("error", (error) => { processInfo.spawnError = error; });
  try {
    registerRegressionProcessTree(processInfo);
  } finally {
    await logFile.close();
  }
  for (let attempt = 1; attempt <= 240; attempt += 1) {
    if (processInfo.spawnError) throw processInfo.spawnError;
    if (child.exitCode != null) throw new Error(`isolated backend exited before health check:\n${await tailFile(logPath)}`);
    try {
      const response = await fetch(`${processInfo.baseUrl}/api/system/health`, { signal: AbortSignal.timeout(1_000) });
      if (response.ok) return processInfo;
    } catch {
      // Compilation or startup is still in progress.
    }
    await sleep(500);
  }
  throw new Error(`isolated backend did not become healthy:\n${await tailFile(logPath)}`);
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
  const responseText = await response.text();
  let data = null;
  try {
    data = responseText ? JSON.parse(responseText) : null;
  } catch {
    data = { text: responseText };
  }
  return { status: response.status, data, text: responseText };
}

function clearRedisNamespace() {
  for (const pattern of [`${redisNamespace}:*`, `${passwordResetPrefix}:*`]) {
    const output = execFileSync(
      "docker",
      ["exec", redisContainer, "redis-cli", "--raw", "--scan", "--pattern", pattern],
      { encoding: "utf8" }
    ).trim();
    for (const key of output ? output.split(/\r?\n/).filter(Boolean) : []) {
      execFileSync("docker", ["exec", redisContainer, "redis-cli", "DEL", key], { encoding: "utf8" });
    }
  }
}

function redisNamespaceKeys() {
  return [`${redisNamespace}:*`, `${passwordResetPrefix}:*`].flatMap((pattern) => {
    const output = execFileSync(
      "docker",
      ["exec", redisContainer, "redis-cli", "--raw", "--scan", "--pattern", pattern],
      { encoding: "utf8" }
    ).trim();
    return output ? output.split(/\r?\n/).filter(Boolean) : [];
  });
}

let databaseCreated = false;
let freshDatabaseCreated = false;
let spawnedBackend = null;
try {
  execFileSync("docker", ["exec", container, "createdb", "-U", user, "-O", user, database], { encoding: "utf8" });
  databaseCreated = true;
  psqlDatabase(database, `ALTER DATABASE ${identifier(database)} SET timezone TO 'America/Los_Angeles'`);
  assert.equal(
    scalarDatabase(database, "SHOW timezone"),
    "America/Los_Angeles",
    "upgrade regression must exercise V106 under a non-Shanghai session time zone"
  );
  flyway(database, "104");

  insertAccountSet(tenantId, `A147-MIG-${token.toUpperCase()}`, tenantSchema);
  seedSchema("public", fixture.publicHeaderId, fixture.publicTxnId, fixture.publicBillNo, tenantId);
  seedSchema(tenantSchema, fixture.tenantHeaderId, fixture.tenantTxnId, fixture.tenantBillNo, tenantId);

  psql(`
    INSERT INTO public.inv_stock_txn (
      id, account_set_id, txn_type, product_id, warehouse_id, qty_delta,
      source_bill_type, source_bill_id, source_bill_line_id, amount
    ) VALUES
      (
        ${literal(fixture.publicUnknownTxnId)}::uuid, ${literal(tenantId)}::uuid, 'UNKNOWN',
        ${literal(fixture.productId)}::uuid, ${literal(fixture.warehouseId)}::uuid, 0,
        ${literal(`UNMAPPED:A147-${token}`)}, ${literal(randomUUID())}::uuid, NULL, 0
      ),
      (
        ${literal(fixture.publicTestTxnId)}::uuid, ${literal(tenantId)}::uuid, 'A147_TEST',
        ${literal(fixture.productId)}::uuid, ${literal(fixture.warehouseId)}::uuid, 0,
        ${literal(`A147_TEST:A147-${token}`)}, ${literal(randomUUID())}::uuid, NULL, 0
      );

    CREATE SCHEMA ${identifier(backupSchema)};
    CREATE TABLE ${identifier(backupSchema)}.ap_payable (LIKE public.ap_payable INCLUDING ALL);
    CREATE TABLE ${identifier(backupSchema)}.document_number_sequence (LIKE public.document_number_sequence INCLUDING ALL);
    CREATE TABLE ${identifier(backupSchema)}.purchase_in (LIKE public.purchase_in INCLUDING ALL);
    CREATE TABLE ${identifier(backupSchema)}.purchase_return (LIKE public.purchase_return INCLUDING ALL);
    CREATE TABLE ${identifier(backupSchema)}.production_completion (LIKE public.production_completion INCLUDING ALL);
    CREATE TABLE ${identifier(backupSchema)}.inv_stock_txn (LIKE public.inv_stock_txn INCLUDING ALL);
    INSERT INTO ${identifier(backupSchema)}.purchase_in
      SELECT * FROM public.purchase_in WHERE id = ${literal(fixture.publicHeaderId)}::uuid;
    INSERT INTO ${identifier(backupSchema)}.inv_stock_txn
      SELECT * FROM public.inv_stock_txn
      WHERE id IN (
        ${literal(fixture.publicTxnId)}::uuid,
        ${literal(fixture.productionAuditTxnId)}::uuid,
        ${literal(fixture.productionRedTxnId)}::uuid,
        ${literal(fixture.productionReverseTxnId)}::uuid,
        ${literal(fixture.productionRedReverseTxnId)}::uuid
      );
    INSERT INTO ${identifier(backupSchema)}.production_completion
      SELECT * FROM public.production_completion
      WHERE id = ${literal(fixture.productionHeaderId)}::uuid;
    INSERT INTO public.sys_account_set_backup (
      id, account_set_id, account_set_code, account_set_name,
      backup_name, backup_schema_name, table_count, row_count
    ) VALUES (
      ${literal(backupId)}::uuid, ${literal(tenantId)}::uuid,
      ${literal(`A147-MIG-${token.toUpperCase()}`)}, 'A147 migration tenant',
      ${literal(`BK-A147-${token.toUpperCase()}`)}, ${literal(backupSchema)}, 6, 6
    );
  `);

  flyway(database);
  assertMigrationHistory(database);

  for (const schema of ["public", tenantSchema, backupSchema]) assertColumns(schema);
  for (const schema of ["public", tenantSchema]) assertIndexes(schema);
  assertExactPostingIndex(backupSchema);

  for (const [schema, txnId, headerId, billNo] of [
    ["public", fixture.publicTxnId, fixture.publicHeaderId, fixture.publicBillNo],
    [tenantSchema, fixture.tenantTxnId, fixture.tenantHeaderId, fixture.tenantBillNo],
    [backupSchema, fixture.publicTxnId, fixture.publicHeaderId, fixture.publicBillNo]
  ]) {
    const q = identifier(schema);
    const fact = scalar(`
      SELECT concat_ws('|', source_bill_id::text, COALESCE(source_bill_line_id::text, 'NULL'),
        source_bill_no, source_bill_date::text, posting_action, trace_quality)
      FROM ${q}.inv_stock_txn
      WHERE id = ${literal(txnId)}::uuid
    `);
    assert.equal(fact, `${headerId}|NULL|${billNo}|2026-07-13|AUDIT|HEADER_ONLY`, `${schema} unique historical header must be backfilled without a guessed line`);
  }
  assert.equal(scalar(`SELECT trace_quality FROM public.inv_stock_txn WHERE id = ${literal(fixture.publicUnknownTxnId)}::uuid`), "LEGACY", "unmapped history must remain legacy");
  assert.equal(scalar(`SELECT trace_quality FROM public.inv_stock_txn WHERE id = ${literal(fixture.publicTestTxnId)}::uuid`), "TEST", "A-number fixtures must remain test history");

  for (const schema of ["public", tenantSchema, backupSchema]) {
    const q = identifier(schema);
    const completionFacts = psql(`
      SELECT concat_ws('|', txn_type, source_bill_id::text,
        COALESCE(source_bill_line_id::text, 'NULL'), source_bill_no,
        source_bill_date::text, posting_action, trace_quality)
      FROM ${q}.inv_stock_txn
      WHERE id IN (
        ${literal(fixture.productionAuditTxnId)}::uuid,
        ${literal(fixture.productionRedTxnId)}::uuid,
        ${literal(fixture.productionReverseTxnId)}::uuid,
        ${literal(fixture.productionRedReverseTxnId)}::uuid
      )
      ORDER BY txn_type
    `).split(/\r?\n/).filter(Boolean);
    assert.deepEqual(completionFacts, [
      `PRODUCTION_COMPLETE|${fixture.productionHeaderId}|NULL|${fixture.productionBillNo}|2026-07-14|AUDIT|HEADER_ONLY`,
      `PRODUCTION_COMPLETE_RED|${fixture.productionHeaderId}|NULL|${fixture.productionBillNo}|2026-07-14|RED_AUDIT|HEADER_ONLY`,
      `PRODUCTION_COMPLETE_RED_REVERSE|${fixture.productionHeaderId}|NULL|${fixture.productionBillNo}|2026-07-14|RED_REVERSE|HEADER_ONLY`,
      `PRODUCTION_COMPLETE_REVERSE|${fixture.productionHeaderId}|NULL|${fixture.productionBillNo}|2026-07-14|REVERSE|HEADER_ONLY`
    ], `${schema} must backfill all historical PRODUCTION_COMPLETE variants without guessing a line`);
  }

  insertAccountSet(newTenantId, `A147-NEW-${token.toUpperCase()}`, newTenantSchema);
  assertColumns(newTenantSchema);
  assertIndexes(newTenantSchema, false);
  psql(`SELECT public.jdy_sync_tenant_schema(${literal(newTenantSchema)}, FALSE)`);
  assertColumns(newTenantSchema);
  assertIndexes(newTenantSchema, false);

  const historyBeforeRepeat = psql(`
    SELECT version || '|' || checksum || '|' || success
    FROM public.flyway_schema_history
    ORDER BY installed_rank
  `);
  flyway(database);
  const historyAfterRepeat = psql(`
    SELECT version || '|' || checksum || '|' || success
    FROM public.flyway_schema_history
    ORDER BY installed_rank
  `);
  assert.equal(historyAfterRepeat, historyBeforeRepeat, "repeat Flyway migrate must be a no-op");
  assert.equal(scalar("SELECT count(*) FROM public.flyway_schema_history WHERE version = '107'"), "1", "V107 history must remain singular after repeat migrate");
  for (const schema of ["public", tenantSchema]) assertIndexes(schema);
  assertExactPostingIndex(backupSchema);

  execFileSync("docker", ["exec", container, "createdb", "-U", user, "-O", user, freshDatabase], { encoding: "utf8" });
  freshDatabaseCreated = true;
  flyway(freshDatabase);
  assertMigrationHistory(freshDatabase);
  assertColumns("public", freshDatabase);
  assertIndexes("public", true, freshDatabase);
  const freshHistory = psqlDatabase(freshDatabase, `
    SELECT version || '|' || checksum || '|' || success
    FROM public.flyway_schema_history
    ORDER BY installed_rank
  `);
  flyway(freshDatabase);
  assert.equal(psqlDatabase(freshDatabase, `
    SELECT version || '|' || checksum || '|' || success
    FROM public.flyway_schema_history
    ORDER BY installed_rank
  `), freshHistory, "fresh database repeat migrate must be a no-op");

  assert.deepEqual(redisNamespaceKeys(), [], "isolated Redis namespace must be empty before backend startup");
  seedRestoreCycle();
  const traceBeforeBackup = traceSnapshot(tenantSchema);
  assert.equal(traceBeforeBackup.length, 3, "non-empty audit/reverse/re-audit restore fixture must be created");
  assert(
    traceBeforeBackup[1].includes(`|REVERSE|-7.0000|0.0000|${restoreFixture.firstAuditTxnId}|EXACT`),
    "restore fixture must preserve reversal identity and post-quantity"
  );

  spawnedBackend = await startBackend();
  let cookie = null;
  try {
    const tenantCode = `A147-MIG-${token.toUpperCase()}`;
    cookie = await loginApi(spawnedBackend.baseUrl, "admin", "admin123", tenantCode);
    const session = await apiRequest(spawnedBackend.baseUrl, cookie, "/api/system/session");
    assert.equal(session.status, 200, `isolated tenant session failed: ${session.text}`);
    assert.equal(session.data?.tenant?.code, tenantCode, `isolated backend selected the wrong tenant: ${session.text}`);

    const backupResponse = await apiRequest(
      spawnedBackend.baseUrl,
      cookie,
      "/api/system/account-sets/current/backups",
      { method: "POST", timeoutMs: 120_000 }
    );
    assert.equal(backupResponse.status, 200, `formal backup API failed: ${backupResponse.text}`);
    assert.equal(backupResponse.data?.ok, true, `formal backup API did not report success: ${backupResponse.text}`);
    const formalBackup = backupResponse.data?.backup;
    assert(
      formalBackup?.id && formalBackup?.backupName && formalBackup?.backupSchemaName,
      `formal backup response incomplete: ${backupResponse.text}`
    );
    identifier(String(formalBackup.backupSchemaName));
    assert(Number(formalBackup.tableCount) > 0, "formal backup must copy managed tenant tables");
    assertColumns(String(formalBackup.backupSchemaName));
    const traceInBackup = traceSnapshot(String(formalBackup.backupSchemaName));
    assert.deepEqual(traceInBackup, traceBeforeBackup, "formal backup must preserve exact trace history byte-for-byte");

    psql(`
      DELETE FROM ${identifier(tenantSchema)}.inv_stock_txn
      WHERE source_bill_id = ${literal(restoreFixture.headerId)}::uuid;
      DELETE FROM ${identifier(tenantSchema)}.other_stock_in
      WHERE id = ${literal(restoreFixture.headerId)}::uuid;
      DELETE FROM ${identifier(tenantSchema)}.inv_stock_balance
      WHERE account_set_id = ${literal(tenantId)}::uuid
        AND product_id = ${literal(fixture.productId)}::uuid
        AND warehouse_id = ${literal(fixture.warehouseId)}::uuid;
    `);
    assert.deepEqual(traceSnapshot(tenantSchema), [], "tenant mutation must remove the restore-cycle trace facts");

    const restoreResponse = await apiRequest(
      spawnedBackend.baseUrl,
      cookie,
      `/api/system/account-sets/current/backups/${encodeURIComponent(formalBackup.backupName)}/restore`,
      { method: "POST", timeoutMs: 120_000 }
    );
    assert.equal(restoreResponse.status, 200, `formal restore API failed: ${restoreResponse.text}`);
    assert.equal(restoreResponse.data?.ok, true, `formal restore API did not report success: ${restoreResponse.text}`);
    const traceAfterRestore = traceSnapshot(tenantSchema);
    assert.deepEqual(traceAfterRestore, traceInBackup, "formal restore must exactly recover audit/reverse/re-audit trace semantics");
    assertIndexes(tenantSchema);
    assert.equal(scalar(`
      SELECT count(*)
      FROM public.sys_account_set_backup
      WHERE id = ${literal(formalBackup.id)}::uuid
        AND restored_at IS NOT NULL
        AND restored_by IS NOT NULL
    `), "1", "formal restore metadata must record actor and timestamp");
  } finally {
    if (cookie && spawnedBackend) {
      await apiRequest(
        spawnedBackend.baseUrl,
        cookie,
        "/api/system/logout",
        { method: "POST", timeoutMs: 10_000 }
      ).catch(() => null);
    }
    if (spawnedBackend) {
      await stopBackend(spawnedBackend);
      await unlink(spawnedBackend.logPath).catch(() => {});
      spawnedBackend = null;
    }
  }
  clearRedisNamespace();
  assert.deepEqual(redisNamespaceKeys(), [], "isolated Redis namespace must be empty after backend shutdown");

  console.log("A147 inventory source trace migration regression passed");
} finally {
  if (spawnedBackend) {
    await stopBackend(spawnedBackend).catch(() => {});
    await unlink(spawnedBackend.logPath).catch(() => {});
    spawnedBackend = null;
  }
  clearRedisNamespace();
  if (databaseCreated) {
    execFileSync("docker", ["exec", container, "dropdb", "-U", user, "--if-exists", "--force", database], { encoding: "utf8" });
  }
  if (freshDatabaseCreated) {
    execFileSync("docker", ["exec", container, "dropdb", "-U", user, "--if-exists", "--force", freshDatabase], { encoding: "utf8" });
  }
  const residue = psqlDatabase("postgres", `
    SELECT count(*)
    FROM pg_database
    WHERE datname IN (${literal(database)}, ${literal(freshDatabase)})
  `);
  assert.equal(residue, "0", "A147 migration regression must drop every random database");
}
