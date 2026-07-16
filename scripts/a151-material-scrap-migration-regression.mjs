#!/usr/bin/env node

import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, open, readFile, unlink, writeFile } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { loginApi } from "./helpers/regression-auth.mjs";

const root = path.resolve(import.meta.dirname, "..");
const migrationDir = path.join(root, "backend/src/main/resources/db/migration");
const migrationPath = path.join(migrationDir, "V108__production_material_scrap.sql");
const resultPath = path.join(root, "verification/a151-material-scrap-migration-regression.json");
const container = process.env.JDY_POSTGRES_CONTAINER || "jdy-erp-postgres";
const redisContainer = process.env.JDY_REDIS_CONTAINER || "jdy-erp-redis";
const user = process.env.JDY_DATABASE_USER || "jdy";
const password = process.env.JDY_DATABASE_PASSWORD || "jdy_dev";
const token = randomBytes(6).toString("hex");
const upgradeDatabase = `jdy_a151_mig_${token}`;
const freshDatabase = `jdy_a151_fresh_${token}`;
const tenantSchema = `tenant_a151_mig_${token}`;
const newTenantSchema = `tenant_a151_new_${token}`;
const freshTenantSchema = `tenant_a151_fresh_${token}`;
const backupSchema = `bk_a151_mig_${token}`;
const tenantId = randomUUID();
const newTenantId = randomUUID();
const freshTenantId = randomUUID();
const backupId = randomUUID();
const tenantCode = `A151-MIG-${token.toUpperCase()}`;
const backupName = `BK-A151-${token.toUpperCase()}`;
const customerCode = `A151-C-${token.toUpperCase()}`;
const redisNamespace = `jdy:a151:migration:${token}`;
const passwordResetPrefix = `jdy:a151:{migration-${token}}:password-reset`;

const expectedHeaderColumns = [
  "id", "bill_no", "bill_date", "business_type", "source_issue_id", "workshop_id",
  "workshop_code_snapshot", "workshop_name_snapshot", "status", "close_status",
  "frozen_status", "audited_at", "reversed_at", "version", "voided_at", "void_reason",
  "void_verified_username", "void_verified_at", "created_at", "updated_at"
];
const expectedLineColumns = [
  "id", "scrap_id", "line_no", "source_issue_line_id", "product_id",
  "product_code_snapshot", "product_name_snapshot", "product_spec_snapshot",
  "product_unit_snapshot", "source_warehouse_id", "source_warehouse_code_snapshot",
  "issue_qty_snapshot", "available_scrap_qty_snapshot", "scrap_qty", "scrap_reason",
  "reissue_qty", "is_stock_in", "target_warehouse_id", "target_warehouse_code_snapshot",
  "stock_in_status", "created_at", "updated_at"
];

const result = {
  ok: false,
  generatedAt: new Date().toISOString(),
  token,
  upgrade: {},
  repeat: {},
  historicalBackupRestore: {},
  fresh: {},
  cleanup: { databases: {}, redisKeys: [] },
  failure: null
};

await mkdir(path.dirname(resultPath), { recursive: true });

function literal(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function identifier(value) {
  assert.match(value, /^[a-z][a-z0-9_]{0,62}$/, `unsafe identifier: ${value}`);
  return `"${value}"`;
}

function safeDatabase(value) {
  assert.match(value, /^jdy_a151_(?:mig|fresh)_[a-f0-9]{12}$/, `unsafe database: ${value}`);
  return value;
}

function psql(database, statement) {
  return execFileSync(
    "docker",
    ["exec", container, "psql", "-X", "-v", "ON_ERROR_STOP=1", "-U", user, "-d", safeDatabase(database), "-tAq", "-c", statement],
    { encoding: "utf8", maxBuffer: 30 * 1024 * 1024 }
  ).trim();
}

function json(database, statement) {
  const output = psql(database, statement);
  return output ? JSON.parse(output) : null;
}

function scalar(database, statement) {
  return psql(database, statement).split(/\r?\n/).at(-1);
}

function createDatabase(database) {
  execFileSync("docker", ["exec", container, "createdb", "-U", user, "-O", user, safeDatabase(database)], { encoding: "utf8" });
}

function dropDatabase(database) {
  execFileSync("docker", ["exec", container, "dropdb", "-U", user, "--if-exists", "--force", safeDatabase(database)], { encoding: "utf8" });
}

function flyway(database, target = null) {
  const args = [
    "org.flywaydb:flyway-maven-plugin:11.7.2:migrate",
    `-Dflyway.url=jdbc:postgresql://127.0.0.1:5432/${safeDatabase(database)}`,
    `-Dflyway.user=${user}`,
    `-Dflyway.password=${password}`,
    `-Dflyway.locations=filesystem:${migrationDir}`
  ];
  if (target != null) args.push(`-Dflyway.target=${target}`);
  execFileSync("./scripts/backend-test.sh", args, {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 50 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"]
  });
}

function history(database) {
  return json(database, `
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
      'version', version,
      'script', script,
      'checksum', checksum,
      'success', success
    ) ORDER BY installed_rank), '[]'::jsonb)::text
    FROM public.flyway_schema_history
    WHERE type = 'SQL'
  `);
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

function assertTopology(label, actual, expectedFk) {
  assert.deepEqual(
    Object.fromEntries(Object.entries(actual).map(([key, value]) => [key, Number(value)])),
    { tables: 86, pk: 86, uk: 81, fk: expectedFk, check: 105 },
    `${label} topology mismatch`
  );
}

function columnNames(database, schema, table) {
  return json(database, `
    SELECT COALESCE(jsonb_agg(column_name ORDER BY ordinal_position), '[]'::jsonb)::text
    FROM information_schema.columns
    WHERE table_schema=${literal(schema)} AND table_name=${literal(table)}
  `);
}

function scrapConstraintShape(database, schema) {
  return json(database, `
    SELECT jsonb_build_object(
      'pk', count(*) FILTER (WHERE constraint_row.contype='p'),
      'uk', count(*) FILTER (WHERE constraint_row.contype='u'),
      'fk', count(*) FILTER (WHERE constraint_row.contype='f'),
      'check', count(*) FILTER (WHERE constraint_row.contype='c'),
      'sourceLineFk', count(*) FILTER (
        WHERE constraint_row.contype='f'
          AND child_table.relname='production_material_scrap_line'
          AND pg_get_constraintdef(constraint_row.oid, TRUE) LIKE 'FOREIGN KEY (source_issue_line_id)%'
      ),
      'voidedBy', (
        SELECT count(*)
        FROM information_schema.columns
        WHERE table_schema=${literal(schema)}
          AND table_name='production_material_scrap'
          AND column_name='voided_by'
      ),
      'parentSchemas', COALESCE(jsonb_agg(DISTINCT parent_schema.nspname)
        FILTER (WHERE constraint_row.contype='f'), '[]'::jsonb)
    )::text
    FROM pg_constraint constraint_row
    JOIN pg_class child_table ON child_table.oid=constraint_row.conrelid
    JOIN pg_namespace child_schema ON child_schema.oid=child_table.relnamespace
    LEFT JOIN pg_class parent_table ON parent_table.oid=constraint_row.confrelid
    LEFT JOIN pg_namespace parent_schema ON parent_schema.oid=parent_table.relnamespace
    WHERE child_schema.nspname=${literal(schema)}
      AND child_table.relname IN ('production_material_scrap', 'production_material_scrap_line')
  `);
}

function scrapIndexCount(database, schema) {
  return Number(scalar(database, `
    SELECT count(*)
    FROM pg_indexes
    WHERE schemaname=${literal(schema)}
      AND indexname IN (
        'idx_production_material_scrap_source_status',
        'idx_production_material_scrap_status_date',
        'idx_production_material_scrap_workshop_date',
        'idx_production_material_scrap_line_source',
        'idx_production_material_scrap_line_product',
        'idx_production_material_scrap_line_stock_in'
      )
  `));
}

function assertScrapShape(database, schema, backup = false) {
  assert.deepEqual(columnNames(database, schema, "production_material_scrap"), expectedHeaderColumns, `${schema} header columns drifted`);
  assert.deepEqual(columnNames(database, schema, "production_material_scrap_line"), expectedLineColumns, `${schema} line columns drifted`);
  const sourceLine = json(database, `
    SELECT jsonb_build_object(
      'nullable', is_nullable,
      'type', data_type
    )::text
    FROM information_schema.columns
    WHERE table_schema=${literal(schema)}
      AND table_name='production_material_scrap_line'
      AND column_name='source_issue_line_id'
  `);
  const constraints = scrapConstraintShape(database, schema);
  if (backup) {
    assert.equal(sourceLine?.type, "uuid", `${schema} backup source issue line must preserve the UUID type`);
    assert.deepEqual(
      { pk: Number(constraints.pk), uk: Number(constraints.uk), fk: Number(constraints.fk), check: Number(constraints.check) },
      { pk: 0, uk: 0, fk: 0, check: 0 },
      `${schema} historical backup shells must remain data-only`
    );
    assert.equal(scrapIndexCount(database, schema), 0, `${schema} historical backup shells must not invent live indexes`);
  } else {
    assert.deepEqual(sourceLine, { nullable: "NO", type: "uuid" }, `${schema} source issue line must be a required UUID soft reference`);
    assert.deepEqual(
      {
        pk: Number(constraints.pk), uk: Number(constraints.uk), fk: Number(constraints.fk),
        check: Number(constraints.check), sourceLineFk: Number(constraints.sourceLineFk),
        voidedBy: Number(constraints.voidedBy)
      },
      { pk: 2, uk: 3, fk: 6, check: 17, sourceLineFk: 0, voidedBy: 0 },
      `${schema} material scrap constraints drifted`
    );
    assert.deepEqual(constraints.parentSchemas, [schema], `${schema} material scrap FKs must remain tenant-local`);
    assert.equal(scrapIndexCount(database, schema), 6, `${schema} must expose all six material-scrap access indexes`);
  }
}

function assertStockInMatrix(database, schema) {
  psql(database, `
    DO $matrix$
    BEGIN
      CREATE TEMP TABLE a151_stock_matrix
        (LIKE ${identifier(schema)}.production_material_scrap_line INCLUDING DEFAULTS INCLUDING CONSTRAINTS)
        ON COMMIT DROP;

      INSERT INTO a151_stock_matrix (
        scrap_id, line_no, source_issue_line_id, product_id,
        product_code_snapshot, product_name_snapshot, product_unit_snapshot,
        source_warehouse_id, source_warehouse_code_snapshot,
        issue_qty_snapshot, available_scrap_qty_snapshot, scrap_qty, reissue_qty,
        is_stock_in, target_warehouse_id, target_warehouse_code_snapshot, stock_in_status
      )
      SELECT gen_random_uuid(), fixture.line_no, gen_random_uuid(), gen_random_uuid(),
             'A151-MATRIX', 'A151 matrix material', 'PCS', gen_random_uuid(), 'SOURCE-WH',
             1, 1, 0, 0,
             fixture.is_stock_in, fixture.target_warehouse_id,
             fixture.target_warehouse_code, fixture.stock_in_status
      FROM (VALUES
        (1, FALSE, NULL::UUID, NULL::VARCHAR, 'NOT_REQUIRED'),
        (2, TRUE, gen_random_uuid(), 'SCRAP-WH', 'PENDING'),
        (3, TRUE, gen_random_uuid(), 'SCRAP-WH', 'STOCKED_IN'),
        (4, TRUE, gen_random_uuid(), 'SCRAP-WH', 'REVERSED')
      ) fixture(line_no, is_stock_in, target_warehouse_id, target_warehouse_code, stock_in_status);

      BEGIN
        UPDATE a151_stock_matrix
        SET is_stock_in=TRUE, target_warehouse_id=gen_random_uuid(),
            target_warehouse_code_snapshot='SCRAP-WH', stock_in_status='NOT_REQUIRED'
        WHERE line_no=1;
        RAISE EXCEPTION 'A151 matrix accepted is_stock_in=true with NOT_REQUIRED';
      EXCEPTION WHEN check_violation THEN NULL;
      END;

      BEGIN
        UPDATE a151_stock_matrix SET stock_in_status='PENDING' WHERE line_no=1;
        RAISE EXCEPTION 'A151 matrix accepted is_stock_in=false with PENDING';
      EXCEPTION WHEN check_violation THEN NULL;
      END;

      BEGIN
        UPDATE a151_stock_matrix
        SET target_warehouse_id=gen_random_uuid(), target_warehouse_code_snapshot='SCRAP-WH'
        WHERE line_no=1;
        RAISE EXCEPTION 'A151 matrix accepted target warehouse while is_stock_in=false';
      EXCEPTION WHEN check_violation THEN NULL;
      END;

      BEGIN
        UPDATE a151_stock_matrix
        SET target_warehouse_id=NULL, target_warehouse_code_snapshot=NULL
        WHERE line_no=2;
        RAISE EXCEPTION 'A151 matrix accepted a missing target warehouse while is_stock_in=true';
      EXCEPTION WHEN check_violation THEN NULL;
      END;

      BEGIN
        UPDATE a151_stock_matrix SET target_warehouse_code_snapshot='   ' WHERE line_no=2;
        RAISE EXCEPTION 'A151 matrix accepted a blank target warehouse code';
      EXCEPTION WHEN check_violation THEN NULL;
      END;
    END $matrix$;
  `);
}

function insertAccountSet(database, id, code, schema, createMissing) {
  psql(database, `
    INSERT INTO public.sys_account_set (
      id, code, name, environment, database_name, schema_name,
      attachment_prefix, redis_key_prefix, accounting_period, business_period,
      enabled, initialized
    ) VALUES (
      ${literal(id)}::uuid, ${literal(code)}, ${literal(code)}, 'A151 regression',
      ${literal(database)}, ${literal(schema)}, ${literal(`account-sets/${code}`)},
      ${literal(code)}, '2026-07', '2026-07', TRUE, TRUE
    );
    SELECT public.jdy_sync_tenant_schema(${literal(schema)}, ${createMissing ? "TRUE" : "FALSE"});
  `);
}

function seedUpgradeFixture() {
  insertAccountSet(upgradeDatabase, tenantId, tenantCode, tenantSchema, true);
  const q = identifier(tenantSchema);
  psql(upgradeDatabase, `
    INSERT INTO ${q}.md_customer (code, name, audit_status)
    VALUES (${literal(customerCode)}, 'A151 historical customer', 'AUDITED');

    INSERT INTO public.sys_user_account_set (user_id, account_set_id, role_code, is_default, enabled)
    SELECT id, ${literal(tenantId)}::uuid, 'ADMIN', FALSE, TRUE
    FROM public.sys_user
    WHERE username='admin'
    ON CONFLICT (user_id, account_set_id) DO UPDATE
    SET role_code='ADMIN', enabled=TRUE, updated_at=now();

    DO $backup$
    DECLARE
      managed RECORD;
      admin_id UUID;
      copied_count INTEGER := 0;
    BEGIN
      CREATE SCHEMA ${identifier(backupSchema)};
      FOR managed IN
        SELECT table_name FROM public.sys_tenant_managed_table ORDER BY restore_order, table_name
      LOOP
        EXECUTE format(
          'CREATE TABLE %I.%I AS TABLE %I.%I',
          ${literal(backupSchema)}, managed.table_name,
          ${literal(tenantSchema)}, managed.table_name
        );
        copied_count := copied_count + 1;
      END LOOP;
      IF copied_count <> 82 THEN
        RAISE EXCEPTION 'A151 historical fixture expected 82 pre-V108 tables, got %', copied_count;
      END IF;
      SELECT id INTO STRICT admin_id FROM public.sys_user WHERE username='admin';
      INSERT INTO public.sys_account_set_backup (
        id, account_set_id, account_set_code, account_set_name,
        backup_name, backup_schema_name, attachment_prefix,
        table_count, row_count, created_by
      ) VALUES (
        ${literal(backupId)}::uuid, ${literal(tenantId)}::uuid,
        ${literal(tenantCode)}, ${literal(tenantCode)},
        ${literal(backupName)}, ${literal(backupSchema)}, '', 82, 1, admin_id
      );
    END $backup$;
  `);
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
  if (!Number.isInteger(processInfo?.child?.pid)) return false;
  try {
    process.kill(-processInfo.child.pid, 0);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    if (error?.code === "EPERM") return true;
    throw error;
  }
}

async function stopBackend(processInfo) {
  if (!processGroupIsAlive(processInfo)) return;
  process.kill(-processInfo.child.pid, "SIGTERM");
  const deadline = Date.now() + 8_000;
  while (processGroupIsAlive(processInfo) && Date.now() < deadline) await sleep(100);
  if (processGroupIsAlive(processInfo)) {
    process.kill(-processInfo.child.pid, "SIGKILL");
    const killDeadline = Date.now() + 3_000;
    while (processGroupIsAlive(processInfo) && Date.now() < killDeadline) await sleep(100);
  }
  assert(!processGroupIsAlive(processInfo), "isolated A151 backend process group did not terminate");
}

async function startBackend() {
  const port = await reserveHttpPort();
  assert.notEqual(port, 8080, "A151 migration regression must never bind the live backend port");
  const logPath = path.join("/tmp", `a151-migration-backend-${token}.log`);
  const logFile = await open(logPath, "w");
  const env = {
    ...process.env,
    JAVA_HOME: process.env.JAVA_HOME || "/opt/homebrew/opt/openjdk@21/libexec/openjdk.jdk/Contents/Home",
    JDY_SERVER_PORT: String(port),
    JDY_DB_URL: `jdbc:postgresql://127.0.0.1:5432/${upgradeDatabase}`,
    JDY_DB_USERNAME: user,
    JDY_DB_PASSWORD: password,
    JDY_DB_POOL_MINIMUM_IDLE: "0",
    JDY_DB_POOL_MAXIMUM_SIZE: "4",
    JDY_REDIS_HOST: "127.0.0.1",
    JDY_REDIS_PORT: "6379",
    SPRING_SESSION_REDIS_NAMESPACE: redisNamespace,
    JDY_PASSWORD_RESET_REDIS_KEY_PREFIX: passwordResetPrefix,
    JDY_PASSWORD_RESET_CLEANUP_FIXED_DELAY_MS: "3600000",
    JDY_PASSWORD_RESET_CLEANUP_INITIAL_DELAY_MS: "3600000",
    JDY_MASTER_DATA_IMPORT_CLEANUP_INITIAL_DELAY_MS: "3600000"
  };
  delete env.SPRING_APPLICATION_JSON;
  delete env.SPRING_PROFILES_DEFAULT;
  delete env.SPRING_PROFILES_INCLUDE;
  const child = spawn("./mvnw", ["spring-boot:run"], {
    cwd: path.join(root, "backend"),
    env,
    detached: true,
    stdio: ["ignore", logFile.fd, logFile.fd]
  });
  const processInfo = { child, port, baseUrl: `http://127.0.0.1:${port}`, logPath, spawnError: null };
  backend = processInfo;
  child.once("error", (error) => { processInfo.spawnError = error; });
  await logFile.close();
  for (let attempt = 1; attempt <= 240; attempt += 1) {
    if (processInfo.spawnError) throw processInfo.spawnError;
    if (child.exitCode != null) throw new Error(`isolated backend exited before health check:\n${await tailFile(logPath)}`);
    try {
      const response = await fetch(`${processInfo.baseUrl}/api/system/health`, { signal: AbortSignal.timeout(1_000) });
      if (response.ok) return processInfo;
    } catch {
      // Maven compilation or backend startup is still in progress.
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
    signal: AbortSignal.timeout(options.timeoutMs ?? 120_000)
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

function redisKeys() {
  return [`${redisNamespace}:*`, `${passwordResetPrefix}:*`].flatMap((pattern) => {
    const output = execFileSync(
      "docker",
      ["exec", redisContainer, "redis-cli", "--raw", "--scan", "--pattern", pattern],
      { encoding: "utf8" }
    ).trim();
    return output ? output.split(/\r?\n/).filter(Boolean) : [];
  });
}

function clearRedisKeys() {
  for (const key of redisKeys()) {
    execFileSync("docker", ["exec", redisContainer, "redis-cli", "DEL", key], { encoding: "utf8" });
  }
}

let upgradeCreated = false;
let freshCreated = false;
let backend = null;
let primaryError = null;

try {
  const migrationSource = await readFile(migrationPath, "utf8");
  assert(!/\bvoided_by\s+(?:UUID|VARCHAR|TEXT|TIMESTAMPTZ|BOOLEAN|INTEGER|BIGINT|NUMERIC)\b/i.test(migrationSource), "V108 must not declare voided_by");
  assert.equal((migrationSource.match(/CONSTRAINT ck_/g) ?? []).length, 17, "V108 source must define exactly 17 CHECK constraints");
  assert(migrationSource.includes("expected=84/79/176/97"), "V108 must freeze the tenant sync topology");

  createDatabase(upgradeDatabase);
  upgradeCreated = true;
  flyway(upgradeDatabase, 107);
} catch (error) {
  primaryError = error;
  result.failure = error?.stack ?? String(error);
}

if (!primaryError) {
  try {
    seedUpgradeFixture();
    assert.equal(scalar(upgradeDatabase, `SELECT public.jdy_sync_tenant_schema(${literal(tenantSchema)}, FALSE)`), "82", "pre-V108 tenant topology must remain the frozen V105 shape");

    flyway(upgradeDatabase);
    const upgradeHistory = history(upgradeDatabase);
    const v108 = upgradeHistory.filter((row) => row.version === "108");
    const v109 = upgradeHistory.filter((row) => row.version === "109");
    assert.equal(v108.length, 1, "upgrade must apply V108 exactly once");
    assert.equal(v108[0].success, true, "V108 must be successful");
    assert.equal(v109.length, 1, "upgrade must apply V109 exactly once");
    assert.equal(v109[0].success, true, "V109 must be successful");
    assert.equal(upgradeHistory.at(-1)?.version, "109", "repository latest upgrade must end at V109");
    assert.equal(
      upgradeHistory.find((row) => row.version === "106")?.checksum,
      1207842815,
      "published V106 checksum must remain immutable"
    );

    const publicTopology = topology(upgradeDatabase, "public");
    const tenantTopology = topology(upgradeDatabase, tenantSchema);
    assertTopology("upgrade public", publicTopology, 184);
    assertTopology("upgrade tenant", tenantTopology, 180);
    assertScrapShape(upgradeDatabase, "public");
    assertScrapShape(upgradeDatabase, tenantSchema);
    assertStockInMatrix(upgradeDatabase, "public");
    assertStockInMatrix(upgradeDatabase, tenantSchema);
    assertScrapShape(upgradeDatabase, backupSchema, true);
    assert.equal(scalar(upgradeDatabase, `SELECT count(*) FROM ${identifier(backupSchema)}.production_material_scrap`), "0", "historical backup header shell must be empty");
    assert.equal(scalar(upgradeDatabase, `SELECT count(*) FROM ${identifier(backupSchema)}.production_material_scrap_line`), "0", "historical backup line shell must be empty");

    const syncCounts = [
      Number(scalar(upgradeDatabase, `SELECT public.jdy_sync_tenant_schema(${literal(tenantSchema)}, FALSE)`)),
      Number(scalar(upgradeDatabase, `SELECT public.jdy_sync_tenant_schema(${literal(tenantSchema)}, FALSE)`))
    ];
    assert.deepEqual(syncCounts, [86, 86], "repeat existing-tenant sync must be stable");
    insertAccountSet(upgradeDatabase, newTenantId, `A151-NEW-${token.toUpperCase()}`, newTenantSchema, true);
    assertTopology("new tenant", topology(upgradeDatabase, newTenantSchema), 180);
    assertScrapShape(upgradeDatabase, newTenantSchema);
    assertStockInMatrix(upgradeDatabase, newTenantSchema);

    result.upgrade = {
      history: upgradeHistory.at(-1),
      publicTopology,
      tenantTopology,
      syncCounts,
      historicalBackupTableCount: Number(scalar(upgradeDatabase, `SELECT table_count FROM public.sys_account_set_backup WHERE id=${literal(backupId)}::uuid`))
    };

    const historyBeforeRepeat = JSON.stringify(upgradeHistory);
    flyway(upgradeDatabase);
    const historyAfterRepeat = JSON.stringify(history(upgradeDatabase));
    assert.equal(historyAfterRepeat, historyBeforeRepeat, "repeat Flyway migrate must be a no-op");
    assert.equal(scalar(upgradeDatabase, "SELECT count(*) FROM public.flyway_schema_history WHERE version='109'"), "1", "V109 history must remain singular");
    result.repeat = { noOp: true, v108Rows: 1, v109Rows: 1 };

    psql(upgradeDatabase, `DELETE FROM ${identifier(tenantSchema)}.md_customer WHERE code=${literal(customerCode)}`);
    assert.equal(scalar(upgradeDatabase, `SELECT count(*) FROM ${identifier(tenantSchema)}.md_customer WHERE code=${literal(customerCode)}`), "0", "tenant mutation must remove historical customer before restore");
    assert.deepEqual(redisKeys(), [], "isolated Redis namespace must start empty");
    backend = await startBackend();
    let cookie = null;
    try {
      cookie = await loginApi(backend.baseUrl, "admin", "admin123", tenantCode);
      const restore = await apiRequest(
        backend.baseUrl,
        cookie,
        `/api/system/account-sets/current/backups/${encodeURIComponent(backupName)}/restore`,
        { method: "POST" }
      );
      assert.equal(restore.status, 200, `historical backup restore failed: ${restore.text}`);
      assert.equal(restore.data?.ok, true, `historical backup restore did not report success: ${restore.text}`);
      assert.equal(scalar(upgradeDatabase, `SELECT name FROM ${identifier(tenantSchema)}.md_customer WHERE code=${literal(customerCode)}`), "A151 historical customer", "historical backup must restore pre-V108 business data");
      assert.equal(scalar(upgradeDatabase, `SELECT count(*) FROM ${identifier(tenantSchema)}.production_material_scrap`), "0", "historical restore must preserve empty V108 header semantics");
      assert.equal(scalar(upgradeDatabase, `SELECT count(*) FROM ${identifier(tenantSchema)}.production_material_scrap_line`), "0", "historical restore must preserve empty V108 line semantics");
      assertScrapShape(upgradeDatabase, tenantSchema);
      result.historicalBackupRestore = {
        status: restore.status,
        restoredCustomer: customerCode,
        scrapRows: 0,
        backupMetadataTableCount: 82,
        targetManagedTables: 86
      };
      await apiRequest(backend.baseUrl, cookie, "/api/system/logout", { method: "POST", timeoutMs: 10_000 });
      cookie = null;
    } finally {
      if (cookie) await apiRequest(backend.baseUrl, cookie, "/api/system/logout", { method: "POST", timeoutMs: 10_000 }).catch(() => null);
      await stopBackend(backend);
      await unlink(backend.logPath).catch(() => {});
      backend = null;
    }
    clearRedisKeys();
    assert.deepEqual(redisKeys(), [], "isolated Redis namespace must be empty after backend shutdown");

    createDatabase(freshDatabase);
    freshCreated = true;
    flyway(freshDatabase);
    const freshHistory = history(freshDatabase);
    assert.equal(freshHistory.at(-1)?.version, "109", "fresh V1-to-latest migration must end at V109");
    assertTopology("fresh public", topology(freshDatabase, "public"), 184);
    assertScrapShape(freshDatabase, "public");
    insertAccountSet(freshDatabase, freshTenantId, `A151-FRESH-${token.toUpperCase()}`, freshTenantSchema, true);
    const freshTenantTopology = topology(freshDatabase, freshTenantSchema);
    assertTopology("fresh tenant", freshTenantTopology, 180);
    assertScrapShape(freshDatabase, freshTenantSchema);
    assertStockInMatrix(freshDatabase, "public");
    assertStockInMatrix(freshDatabase, freshTenantSchema);
    assert.equal(scalar(freshDatabase, `SELECT public.jdy_sync_tenant_schema(${literal(freshTenantSchema)}, FALSE)`), "86", "fresh tenant repeat sync must return 86");
    const freshHistoryBeforeRepeat = JSON.stringify(freshHistory);
    flyway(freshDatabase);
    assert.equal(JSON.stringify(history(freshDatabase)), freshHistoryBeforeRepeat, "fresh repeat Flyway migrate must be a no-op");
    result.fresh = {
      history: freshHistory.at(-1),
      publicTopology: topology(freshDatabase, "public"),
      tenantTopology: freshTenantTopology
    };

    result.ok = true;
  } catch (error) {
    primaryError = error;
    result.failure = error?.stack ?? String(error);
  }
}

try {
  if (backend) {
    await stopBackend(backend).catch(() => {});
    await unlink(backend.logPath).catch(() => {});
    backend = null;
  }
  clearRedisKeys();
  result.cleanup.redisKeys = redisKeys();
  if (freshCreated) dropDatabase(freshDatabase);
  if (upgradeCreated) dropDatabase(upgradeDatabase);
} catch (cleanupError) {
  result.cleanup.failure = cleanupError?.stack ?? String(cleanupError);
  if (!primaryError) primaryError = cleanupError;
}

// Database residue is checked from the postgres maintenance database after the
// isolated databases have been dropped.
try {
  const residue = execFileSync(
    "docker",
    ["exec", container, "psql", "-X", "-U", user, "-d", "postgres", "-tAq", "-c",
      `SELECT COALESCE(string_agg(datname, ',' ORDER BY datname), '') FROM pg_database WHERE datname IN (${literal(upgradeDatabase)}, ${literal(freshDatabase)})`],
    { encoding: "utf8" }
  ).trim();
  result.cleanup.databases = { residue };
  assert.equal(residue, "", "temporary A151 databases must be removed");
  assert.deepEqual(result.cleanup.redisKeys, [], "temporary A151 Redis keys must be removed");
} catch (cleanupError) {
  result.cleanup.failure = cleanupError?.stack ?? String(cleanupError);
  if (!primaryError) primaryError = cleanupError;
}

result.finishedAt = new Date().toISOString();
result.ok = result.ok && !primaryError;
await writeFile(resultPath, `${JSON.stringify(result, null, 2)}\n`);

console.log(JSON.stringify({
  ok: result.ok && !primaryError,
  resultPath: path.relative(root, resultPath),
  upgrade: result.upgrade,
  historicalBackupRestore: result.historicalBackupRestore,
  fresh: result.fresh,
  cleanup: result.cleanup
}, null, 2));

if (primaryError) {
  console.error(primaryError?.stack ?? String(primaryError));
  process.exit(1);
}
