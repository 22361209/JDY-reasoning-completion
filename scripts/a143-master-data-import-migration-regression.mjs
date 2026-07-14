#!/usr/bin/env node

import { execFileSync, spawn } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdir, open, readFile, readdir, writeFile } from "node:fs/promises";
import http from "node:http";
import path from "node:path";

import { loginApi } from "./helpers/regression-auth.mjs";

const rootDir = path.resolve(import.meta.dirname, "..");
const migrationDir = path.join(rootDir, "backend/src/main/resources/db/migration");
const verificationDir = path.join(rootDir, "verification");
const isolationDir = path.join(verificationDir, "a143-master-data-import-migration-isolation");
const resultPath = path.join(verificationDir, "a143-master-data-import-migration-regression.json");
const container = process.env.JDY_POSTGRES_CONTAINER || "jdy-erp-postgres";
const redisContainer = process.env.JDY_REDIS_CONTAINER || "jdy-erp-redis";
const databaseUser = process.env.JDY_DATABASE_USER || "jdy";
const databasePassword = process.env.JDY_DATABASE_PASSWORD || "jdy_dev";
const token = randomBytes(6).toString("hex");
const upperToken = token.toUpperCase();
const upgradeDatabase = `jdy_a143_mig_${token}`;
const freshDatabase = `jdy_a143_fresh_${token}`;
const tenantSchema = `tenant_a143_mig_${token}`;
const otherTenantSchema = `tenant_a143_other_${token}`;
const historicalBackupSchema = `bk_a143_legacy_${token}`;
const freshTenantSchema = `tenant_a143_fresh_${token}`;
const tenantCode = `A143-MIG-${upperToken}`;
const otherTenantCode = `A143-OTHER-${upperToken}`;
const tenantId = randomUUID();
const otherTenantId = randomUUID();
const historicalBackupId = randomUUID();
const freshTenantId = randomUUID();
const freshTenantCode = `A143-FRESH-${upperToken}`;
const redisNamespace = `jdy:a143:migration:${token}`;
const passwordResetRedisPrefix = `jdy:a143:{migration-${token}}:password-reset`;
const processes = [];
const unsubmittedStatuses = ["VALIDATED", "INVALID", "STALE", "FAILED"];
const batchIds = Object.fromEntries(
  [...unsubmittedStatuses, "COMMITTED", "EXPIRED", "OTHER_VALIDATED"].map((status) => [status, randomUUID()])
);

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
    otherTenantSchema,
    historicalBackupSchema,
    freshTenantSchema
  },
  assertions: [],
  upgrade: {},
  repeat: {},
  restoreApi: {},
  tenantIsolation: {},
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

function assert(condition, message, details = undefined) {
  if (!condition) {
    throw new Error(`${message}${details === undefined ? "" : ` ${JSON.stringify(details)}`}`);
  }
  result.assertions.push({ message, details });
}

function errorText(error) {
  return error instanceof Error ? error.stack ?? error.message : String(error);
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
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
  const raw = psql(database, statement);
  return raw ? JSON.parse(raw) : null;
}

function createDatabase(database) {
  assert(/^jdy_a143_(?:mig|fresh)_[a-f0-9]{12}$/.test(database), `unsafe database create: ${database}`);
  execFileSync("docker", ["exec", container, "createdb", "-U", databaseUser, "-O", databaseUser, database], { encoding: "utf8" });
}

function dropDatabase(database) {
  assert(/^jdy_a143_(?:mig|fresh)_[a-f0-9]{12}$/.test(database), `unsafe database drop: ${database}`);
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
  }).trim().split(/\r?\n/).slice(-20);
}

function history(database) {
  return sqlJson(database, `
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
      'rank', installed_rank,
      'version', version,
      'script', script,
      'checksum', checksum,
      'success', success
    ) ORDER BY installed_rank), '[]'::jsonb)::text
    FROM public.flyway_schema_history
    WHERE type = 'SQL'
  `);
}

function createUpgradeTenantsAndHistoricalBackup() {
  psql(upgradeDatabase, `
    BEGIN;
    INSERT INTO public.sys_account_set (
      id, code, name, environment, database_name, schema_name,
      attachment_prefix, redis_key_prefix, accounting_period, business_period,
      enabled, initialized
    ) VALUES
      (
        ${sqlLiteral(tenantId)}::uuid, ${sqlLiteral(tenantCode)}, 'A143 migration tenant',
        'A143 regression', ${sqlLiteral(upgradeDatabase)}, ${sqlLiteral(tenantSchema)},
        ${sqlLiteral(`account-sets/${tenantCode}`)}, ${sqlLiteral(tenantCode)},
        '2026-07', '2026-07', TRUE, TRUE
      ),
      (
        ${sqlLiteral(otherTenantId)}::uuid, ${sqlLiteral(otherTenantCode)}, 'A143 isolation tenant',
        'A143 regression', ${sqlLiteral(upgradeDatabase)}, ${sqlLiteral(otherTenantSchema)},
        ${sqlLiteral(`account-sets/${otherTenantCode}`)}, ${sqlLiteral(otherTenantCode)},
        '2026-07', '2026-07', TRUE, TRUE
      );
    SELECT public.jdy_sync_tenant_schema(${sqlLiteral(tenantSchema)}, TRUE);
    SELECT public.jdy_sync_tenant_schema(${sqlLiteral(otherTenantSchema)}, TRUE);
    COMMIT;

    DO $backup$
    DECLARE
      managed RECORD;
      admin_id UUID;
    BEGIN
      CREATE SCHEMA ${quoteIdentifier(historicalBackupSchema)};
      FOR managed IN
        SELECT table_name FROM public.sys_tenant_managed_table ORDER BY restore_order, table_name
      LOOP
        EXECUTE format(
          'CREATE TABLE %I.%I AS TABLE %I.%I',
          ${sqlLiteral(historicalBackupSchema)}, managed.table_name,
          ${sqlLiteral(tenantSchema)}, managed.table_name
        );
      END LOOP;
      SELECT id INTO STRICT admin_id FROM public.sys_user WHERE username = 'admin';
      INSERT INTO public.sys_account_set_backup (
        id, account_set_id, account_set_code, account_set_name,
        backup_name, backup_schema_name, attachment_prefix,
        table_count, row_count, created_by
      ) VALUES (
        ${sqlLiteral(historicalBackupId)}::uuid,
        ${sqlLiteral(tenantId)}::uuid,
        ${sqlLiteral(tenantCode)},
        'A143 migration tenant',
        ${sqlLiteral(`BK-A143-LEGACY-${upperToken}`)},
        ${sqlLiteral(historicalBackupSchema)},
        ${sqlLiteral(`account-sets/${tenantCode}`)},
        (SELECT count(*) FROM public.sys_tenant_managed_table),
        0,
        admin_id
      );
    END $backup$;
  `);
}

function tableExists(database, schema, table) {
  return psql(database, `SELECT to_regclass(${sqlLiteral(`${schema}.${table}`)}) IS NOT NULL`) === "t";
}

function schemaTopology(database, schema) {
  const schemaValue = sqlLiteral(schema);
  return sqlJson(database, `
    WITH reference_columns AS (
      SELECT managed.table_name,
             attribute.attname AS column_name,
             format_type(attribute.atttypid, attribute.atttypmod) AS data_type,
             attribute.attnotnull AS not_null,
             pg_get_expr(default_value.adbin, default_value.adrelid) AS default_expression,
             attribute.attidentity AS identity_kind,
             attribute.attgenerated AS generated_kind
      FROM public.sys_tenant_managed_table managed
      JOIN pg_class relation ON relation.oid = to_regclass(format('public.%I', managed.table_name))
      JOIN pg_attribute attribute ON attribute.attrelid = relation.oid
      LEFT JOIN pg_attrdef default_value
        ON default_value.adrelid = attribute.attrelid
       AND default_value.adnum = attribute.attnum
      WHERE attribute.attnum > 0 AND NOT attribute.attisdropped
    ), target_columns AS (
      SELECT managed.table_name,
             attribute.attname AS column_name,
             format_type(attribute.atttypid, attribute.atttypmod) AS data_type,
             attribute.attnotnull AS not_null,
             pg_get_expr(default_value.adbin, default_value.adrelid) AS default_expression,
             attribute.attidentity AS identity_kind,
             attribute.attgenerated AS generated_kind
      FROM public.sys_tenant_managed_table managed
      JOIN pg_class relation ON relation.oid = to_regclass(format('%I.%I', ${schemaValue}, managed.table_name))
      JOIN pg_attribute attribute ON attribute.attrelid = relation.oid
      LEFT JOIN pg_attrdef default_value
        ON default_value.adrelid = attribute.attrelid
       AND default_value.adnum = attribute.attnum
      WHERE attribute.attnum > 0 AND NOT attribute.attisdropped
    ), column_mismatches AS (
      SELECT COALESCE(reference.table_name, target.table_name) AS table_name,
             COALESCE(reference.column_name, target.column_name) AS column_name
      FROM reference_columns reference
      FULL JOIN target_columns target USING (table_name, column_name)
      WHERE reference.table_name IS NULL
         OR target.table_name IS NULL
         OR reference.data_type IS DISTINCT FROM target.data_type
         OR reference.not_null IS DISTINCT FROM target.not_null
         OR reference.default_expression IS DISTINCT FROM target.default_expression
         OR reference.identity_kind IS DISTINCT FROM target.identity_kind
         OR reference.generated_kind IS DISTINCT FROM target.generated_kind
    ), reference_constraints AS (
      SELECT child.relname AS table_name,
             constraint_row.contype,
             pg_get_constraintdef(constraint_row.oid, TRUE) AS definition
      FROM pg_constraint constraint_row
      JOIN pg_class child ON child.oid = constraint_row.conrelid
      JOIN pg_namespace namespace ON namespace.oid = child.relnamespace
      JOIN public.sys_tenant_managed_table managed ON managed.table_name = child.relname
      WHERE namespace.nspname = 'public'
        AND constraint_row.contype IN ('p', 'u', 'c')
    ), target_constraints AS (
      SELECT child.relname AS table_name,
             constraint_row.contype,
             pg_get_constraintdef(constraint_row.oid, TRUE) AS definition,
             constraint_row.convalidated
      FROM pg_constraint constraint_row
      JOIN pg_class child ON child.oid = constraint_row.conrelid
      JOIN pg_namespace namespace ON namespace.oid = child.relnamespace
      JOIN public.sys_tenant_managed_table managed ON managed.table_name = child.relname
      WHERE namespace.nspname = ${schemaValue}
    )
    SELECT jsonb_build_object(
      'schema', ${schemaValue},
      'baseTables', (
        SELECT count(*) FROM pg_class relation
        JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
        WHERE namespace.nspname = ${schemaValue} AND relation.relkind IN ('r', 'p')
      ),
      'managedTables', (
        SELECT count(*) FROM public.sys_tenant_managed_table managed
        WHERE to_regclass(format('%I.%I', ${schemaValue}, managed.table_name)) IS NOT NULL
      ),
      'primaryKeys', (SELECT count(*) FROM target_constraints WHERE contype = 'p'),
      'uniqueConstraints', (SELECT count(*) FROM target_constraints WHERE contype = 'u'),
      'foreignKeys', (SELECT count(*) FROM target_constraints WHERE contype = 'f'),
      'checkConstraints', (SELECT count(*) FROM target_constraints WHERE contype = 'c'),
      'unvalidatedConstraints', (SELECT count(*) FROM target_constraints WHERE NOT convalidated),
      'columnMismatchCount', (SELECT count(*) FROM column_mismatches),
      'referenceConstraintMismatchCount', (
        SELECT count(*) FROM reference_constraints reference
        WHERE NOT EXISTS (
          SELECT 1 FROM target_constraints target
          WHERE target.table_name = reference.table_name
            AND target.contype = reference.contype
            AND target.definition = reference.definition
        )
      ),
      'importColumns', (
        SELECT count(*) FROM information_schema.columns
        WHERE table_schema = ${schemaValue} AND table_name = 'md_import_batch'
      ),
      'importConstraints', (
        SELECT count(*) FROM target_constraints
        WHERE table_name = 'md_import_batch'
      ),
      'importForeignKeys', (
        SELECT count(*) FROM target_constraints
        WHERE table_name = 'md_import_batch' AND contype = 'f'
      ),
      'importIndexes', (
        SELECT count(*) FROM pg_indexes
        WHERE schemaname = ${schemaValue} AND tablename = 'md_import_batch'
      )
    )::text
  `);
}

function backupShape(database, schema) {
  const schemaValue = sqlLiteral(schema);
  return sqlJson(database, `
    SELECT jsonb_build_object(
      'schema', ${schemaValue},
      'baseTables', (
        SELECT count(*) FROM pg_class relation
        JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
        WHERE namespace.nspname = ${schemaValue} AND relation.relkind IN ('r', 'p')
      ),
      'managedTables', (
        SELECT count(*) FROM public.sys_tenant_managed_table managed
        WHERE to_regclass(format('%I.%I', ${schemaValue}, managed.table_name)) IS NOT NULL
      ),
      'constraints', (
        SELECT count(*) FROM pg_constraint constraint_row
        JOIN pg_class relation ON relation.oid = constraint_row.conrelid
        JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
        WHERE namespace.nspname = ${schemaValue}
      ),
      'importRows', (SELECT count(*) FROM ${quoteIdentifier(schema)}.md_import_batch),
      'importColumns', (
        SELECT count(*) FROM information_schema.columns
        WHERE table_schema = ${schemaValue} AND table_name = 'md_import_batch'
      )
    )::text
  `);
}

function assertTopology(label, topology, expectedForeignKeys, expectedBaseTables = 82) {
  const expected = {
    baseTables: expectedBaseTables,
    managedTables: 82,
    primaryKeys: 82,
    uniqueConstraints: 76,
    foreignKeys: expectedForeignKeys,
    checkConstraints: 76,
    unvalidatedConstraints: 0,
    columnMismatchCount: 0,
    referenceConstraintMismatchCount: 0,
    importColumns: 23,
    importConstraints: 13,
    importForeignKeys: 0,
    importIndexes: 3
  };
  for (const [field, value] of Object.entries(expected)) {
    assert(Number(topology?.[field]) === value, `${label} ${field} expected ${value}`, topology);
  }
}

function importPayload(code, hasError = false) {
  return [{
    rowNo: 3,
    payload: { code, name: `${code}-NAME` },
    errors: hasError ? [{ rowNo: 3, field: "code", code: "A143_TEST", message: "fixture", value: code }] : []
  }];
}

function insertBatchSql({ id, accountSetId, accountSetCode, status, code }) {
  const invalid = ["INVALID", "STALE", "FAILED"].includes(status);
  const committed = status === "COMMITTED";
  const expired = status === "EXPIRED";
  const cleared = committed || expired;
  const payload = cleared ? [] : importPayload(code, invalid);
  const validRows = invalid ? 0 : 1;
  const errorRows = invalid ? 1 : 0;
  return `
    INSERT INTO md_import_batch (
      id, account_set_id, account_set_code, created_by, created_by_username,
      import_type, template_version, original_file_name, file_sha256, file_size_bytes,
      status, total_rows, valid_rows, error_rows, committed_rows, rows_payload,
      failure_reason, created_at, expires_at, committed_at, payload_cleared_at, updated_at, version
    )
    SELECT
      ${sqlLiteral(id)}::uuid,
      ${sqlLiteral(accountSetId)}::uuid,
      ${sqlLiteral(accountSetCode)},
      admin.id,
      admin.username,
      'customer', 1, ${sqlLiteral(`${code}.xlsx`)}, repeat(${sqlLiteral(code.slice(-1).toLowerCase() || "a")}, 64), 1024,
      ${sqlLiteral(status)}, 1, ${validRows}, ${errorRows}, ${committed ? 1 : 0},
      ${sqlLiteral(JSON.stringify(payload))}::jsonb,
      ${status === "FAILED" ? sqlLiteral("A143 fixture failure") : "NULL"},
      now() - interval '1 minute', now() + interval '29 minutes',
      ${committed ? "now()" : "NULL"},
      ${cleared ? "now()" : "NULL"},
      now(), 0
    FROM public.sys_user admin
    WHERE admin.username = 'admin';
  `;
}

function seedImportBatches() {
  const tenant = quoteIdentifier(tenantSchema);
  const other = quoteIdentifier(otherTenantSchema);
  const tenantRows = [
    ...unsubmittedStatuses.map((status) => ({
      id: batchIds[status], accountSetId: tenantId, accountSetCode: tenantCode, status, code: `A143-${status}-${upperToken}`
    })),
    { id: batchIds.COMMITTED, accountSetId: tenantId, accountSetCode: tenantCode, status: "COMMITTED", code: `A143-COMMITTED-${upperToken}` },
    { id: batchIds.EXPIRED, accountSetId: tenantId, accountSetCode: tenantCode, status: "EXPIRED", code: `A143-EXPIRED-${upperToken}` }
  ];
  const tenantSql = tenantRows.map(insertBatchSql).join("\n").replaceAll("INSERT INTO md_import_batch", `INSERT INTO ${tenant}.md_import_batch`);
  const otherSql = insertBatchSql({
    id: batchIds.OTHER_VALIDATED,
    accountSetId: otherTenantId,
    accountSetCode: otherTenantCode,
    status: "VALIDATED",
    code: `A143-OTHER-${upperToken}`
  }).replaceAll("INSERT INTO md_import_batch", `INSERT INTO ${other}.md_import_batch`);
  psql(upgradeDatabase, `BEGIN; ${tenantSql} ${otherSql} COMMIT;`);
}

function batchSnapshot(schema) {
  return sqlJson(upgradeDatabase, `
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
      'id', id::text,
      'accountSetId', account_set_id::text,
      'accountSetCode', account_set_code,
      'status', status,
      'totalRows', total_rows,
      'validRows', valid_rows,
      'errorRows', error_rows,
      'committedRows', committed_rows,
      'payload', rows_payload,
      'failureReason', failure_reason,
      'committedAtSet', committed_at IS NOT NULL,
      'payloadCleared', payload_cleared_at IS NOT NULL,
      'version', version
    ) ORDER BY id), '[]'::jsonb)::text
    FROM ${quoteIdentifier(schema)}.md_import_batch
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

async function tailFile(filePath, maximumLength = 16_000) {
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

async function waitForProcessGroupExit(processInfo, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (processGroupIsAlive(processInfo) && Date.now() < deadline) await sleep(100);
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
  const name = `a143-migration-${token}`;
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
      const response = await fetch(`${processInfo.baseUrl}/api/system/health`, { signal: AbortSignal.timeout(1_000) });
      if (response.ok) {
        result.processes.push({ name, port, log: path.relative(rootDir, logPath) });
        return processInfo;
      }
    } catch {
      // Build/start still in progress.
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
        // Asynchronous cleanup reports actionable errors.
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
    result.cleanup.processResidue = processes.filter(processGroupIsAlive).map((processInfo) => processInfo.name);
    result.cleanup.forcedProcessKills = processes.filter((processInfo) => processInfo.forcedKill).map((processInfo) => processInfo.name);
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
  result.upgrade.target103 = flyway(upgradeDatabase, 103);
  const targetHistory = history(upgradeDatabase);
  assert(targetHistory.at(-1)?.version === "103", "upgrade database must stop at V103", targetHistory.at(-1));
  createUpgradeTenantsAndHistoricalBackup();
  assert(Number(psql(upgradeDatabase, "SELECT count(*) FROM public.sys_tenant_managed_table")) === 81, "V103 managed catalog must contain 81 tables");
  for (const schema of ["public", tenantSchema, otherTenantSchema, historicalBackupSchema]) {
    assert(!tableExists(upgradeDatabase, schema, "md_import_batch"), `V103 must not already contain ${schema}.md_import_batch`);
  }

  result.upgrade.latest = flyway(upgradeDatabase);
  const migratedHistory = history(upgradeDatabase);
  const v104Rows = migratedHistory.filter((row) => row.version === "104");
  assert(v104Rows.length === 1 && v104Rows[0].success === true, "V104 history row missing or failed", v104Rows);
  assert(migratedHistory.at(-1)?.version === "104", "upgrade max migration must be V104", migratedHistory.at(-1));
  const upgradeTopologies = {
    public: schemaTopology(upgradeDatabase, "public"),
    tenant: schemaTopology(upgradeDatabase, tenantSchema),
    otherTenant: schemaTopology(upgradeDatabase, otherTenantSchema)
  };
  assertTopology("upgrade public", upgradeTopologies.public, 174, 95);
  assertTopology("upgrade tenant", upgradeTopologies.tenant, 170);
  assertTopology("upgrade other tenant", upgradeTopologies.otherTenant, 170);
  const historicalBackup = backupShape(upgradeDatabase, historicalBackupSchema);
  assert(
    Number(historicalBackup.baseTables) === 82
      && Number(historicalBackup.managedTables) === 82
      && Number(historicalBackup.constraints) === 0
      && Number(historicalBackup.importRows) === 0
      && Number(historicalBackup.importColumns) === 23,
    "V104 must add an empty data-only import shell to historical backups",
    historicalBackup
  );
  result.upgrade = {
    ...result.upgrade,
    history: v104Rows[0],
    managedCount: Number(psql(upgradeDatabase, "SELECT count(*) FROM public.sys_tenant_managed_table")),
    topologies: upgradeTopologies,
    historicalBackup
  };

  const repeatBefore = {
    history: migratedHistory,
    topologies: upgradeTopologies,
    historicalBackup
  };
  result.repeat.flywayOutput = flyway(upgradeDatabase);
  const syncCounts = [
    Number(psql(upgradeDatabase, `SELECT public.jdy_sync_tenant_schema(${sqlLiteral(tenantSchema)}, FALSE)`)),
    Number(psql(upgradeDatabase, `SELECT public.jdy_sync_tenant_schema(${sqlLiteral(tenantSchema)}, FALSE)`)),
    Number(psql(upgradeDatabase, `SELECT public.jdy_sync_tenant_schema(${sqlLiteral(otherTenantSchema)}, FALSE)`))
  ];
  const repeatAfter = {
    history: history(upgradeDatabase),
    topologies: {
      public: schemaTopology(upgradeDatabase, "public"),
      tenant: schemaTopology(upgradeDatabase, tenantSchema),
      otherTenant: schemaTopology(upgradeDatabase, otherTenantSchema)
    },
    historicalBackup: backupShape(upgradeDatabase, historicalBackupSchema)
  };
  assert(same(syncCounts, [82, 82, 82]), "repeat tenant sync must return 82 every time", syncCounts);
  assert(same(repeatBefore, repeatAfter), "repeat Flyway/sync must preserve exact V104 topology and history");
  result.repeat = {
    ...result.repeat,
    syncCounts,
    historyDigest: digest(repeatAfter.history),
    topologyDigest: digest(repeatAfter.topologies)
  };

  seedImportBatches();
  const batchesBeforeBackup = batchSnapshot(tenantSchema);
  const otherTenantBefore = batchSnapshot(otherTenantSchema);
  const publicBefore = batchSnapshot("public");
  assert(batchesBeforeBackup.length === 6, "tenant A must contain six restore-state fixtures", batchesBeforeBackup);
  assert(otherTenantBefore.length === 1 && otherTenantBefore[0].status === "VALIDATED", "tenant B isolation fixture missing", otherTenantBefore);
  assert(publicBefore.length === 0, "public must not receive tenant import fixtures", publicBefore);
  assert(redisNamespaceKeys().length === 0, "isolated Redis namespace must start empty");

  const backend = await startBackend();
  let cookie = null;
  try {
    cookie = await loginApi(backend.baseUrl, "admin", "admin123", tenantCode);
    const session = await apiRequest(backend.baseUrl, cookie, "/api/system/session");
    assert(session.status === 200 && session.data?.tenant?.code === tenantCode, "isolated backend session must route tenant A", session.data);
    const backupResponse = await apiRequest(
      backend.baseUrl,
      cookie,
      "/api/system/account-sets/current/backups",
      { method: "POST", timeoutMs: 120_000 }
    );
    assert(backupResponse.status === 200 && backupResponse.data?.ok === true, `formal backup API failed: ${backupResponse.text}`);
    const formalBackup = backupResponse.data?.backup;
    assert(formalBackup?.backupName && formalBackup?.backupSchemaName, "formal backup response incomplete", formalBackup);
    assert(Number(formalBackup.tableCount) === 82, "formal backup must copy all 82 managed tables", formalBackup);
    quoteIdentifier(String(formalBackup.backupSchemaName));
    const formalBackupShape = backupShape(upgradeDatabase, String(formalBackup.backupSchemaName));
    assert(
      Number(formalBackupShape.baseTables) === 82
        && Number(formalBackupShape.managedTables) === 82
        && Number(formalBackupShape.constraints) === 0
        && Number(formalBackupShape.importRows) === 6,
      "formal backup must be a complete data-only 82-table snapshot",
      formalBackupShape
    );
    const batchesInBackup = batchSnapshot(String(formalBackup.backupSchemaName));
    assert(same(batchesInBackup, batchesBeforeBackup), "formal backup must preserve pre-restore import batch facts");

    psql(upgradeDatabase, `DELETE FROM ${quoteIdentifier(tenantSchema)}.md_import_batch`);
    assert(batchSnapshot(tenantSchema).length === 0, "tenant mutation must remove all import batches before restore");
    const restoreResponse = await apiRequest(
      backend.baseUrl,
      cookie,
      `/api/system/account-sets/current/backups/${encodeURIComponent(formalBackup.backupName)}/restore`,
      { method: "POST", timeoutMs: 120_000 }
    );
    assert(restoreResponse.status === 200 && restoreResponse.data?.ok === true, `formal restore API failed: ${restoreResponse.text}`);
    const batchesAfterRestore = batchSnapshot(tenantSchema);
    assert(batchesAfterRestore.length === 6, "formal restore must restore all six batch summaries", batchesAfterRestore);
    for (const status of unsubmittedStatuses) {
      const restored = batchesAfterRestore.find((row) => row.id === batchIds[status]);
      assert(
        restored?.status === "EXPIRED"
          && same(restored.payload, [])
          && restored.committedRows === 0
          && restored.committedAtSet === false
          && restored.payloadCleared === true
          && Number(restored.version) === 1,
        `restore must expire and clear ${status} batch`,
        restored
      );
    }
    const restoredCommitted = batchesAfterRestore.find((row) => row.id === batchIds.COMMITTED);
    assert(
      restoredCommitted?.status === "COMMITTED"
        && same(restoredCommitted.payload, [])
        && restoredCommitted.committedRows === 1
        && restoredCommitted.committedAtSet === true
        && restoredCommitted.payloadCleared === true
        && Number(restoredCommitted.version) === 0,
      "restore must preserve COMMITTED result",
      restoredCommitted
    );
    const restoredExpired = batchesAfterRestore.find((row) => row.id === batchIds.EXPIRED);
    assert(
      restoredExpired?.status === "EXPIRED"
        && same(restoredExpired.payload, [])
        && restoredExpired.payloadCleared === true
        && Number(restoredExpired.version) === 0,
      "restore must preserve already EXPIRED result without replay mutation",
      restoredExpired
    );

    const otherTenantAfter = batchSnapshot(otherTenantSchema);
    const publicAfter = batchSnapshot("public");
    assert(same(otherTenantAfter, otherTenantBefore), "tenant A backup/restore must not mutate tenant B batches");
    assert(same(publicAfter, publicBefore), "tenant A backup/restore must not write public batches");
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
    assert(restoreMetadata?.restoredAtSet === true && restoreMetadata?.restoredBySet === true, "restore metadata must record actor and time", restoreMetadata);
    result.restoreApi = {
      backupStatus: backupResponse.status,
      restoreStatus: restoreResponse.status,
      backupId: formalBackup.id,
      backupName: formalBackup.backupName,
      backupSchema: formalBackup.backupSchemaName,
      tableCount: Number(formalBackup.tableCount),
      rowCount: Number(formalBackup.rowCount),
      shape: formalBackupShape,
      beforeDigest: digest(batchesBeforeBackup),
      backupDigest: digest(batchesInBackup),
      restoredDigest: digest(batchesAfterRestore),
      unsubmittedExpired: unsubmittedStatuses,
      committedPreserved: true,
      expiredPreserved: true,
      batchesAfterRestore,
      metadata: restoreMetadata
    };
    result.tenantIsolation = {
      otherTenantBefore,
      otherTenantAfter,
      publicBefore,
      publicAfter,
      isolated: true
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
  const sourceScripts = (await readdir(migrationDir))
    .filter((name) => /^V\d+__.+\.sql$/.test(name))
    .sort((left, right) => Number(left.match(/^V(\d+)/)[1]) - Number(right.match(/^V(\d+)/)[1]));
  assert(same(freshHistory.map((row) => row.script), sourceScripts), "fresh migration history must equal source migration set");
  assert(freshHistory.at(-1)?.version === "104", "fresh migration max version must be V104", freshHistory.at(-1));
  const freshPublicTopology = schemaTopology(freshDatabase, "public");
  assertTopology("fresh public", freshPublicTopology, 174, 95);
  psql(freshDatabase, `
    INSERT INTO public.sys_account_set (
      id, code, name, environment, database_name, schema_name,
      attachment_prefix, redis_key_prefix, accounting_period, business_period,
      enabled, initialized
    ) VALUES (
      ${sqlLiteral(freshTenantId)}::uuid,
      ${sqlLiteral(freshTenantCode)},
      'A143 fresh tenant',
      'A143 regression',
      ${sqlLiteral(freshDatabase)},
      ${sqlLiteral(freshTenantSchema)},
      ${sqlLiteral(`account-sets/${freshTenantCode}`)},
      ${sqlLiteral(freshTenantCode)},
      '2026-07', '2026-07', TRUE, TRUE
    )
  `);
  const freshSyncCounts = [
    Number(psql(freshDatabase, `SELECT public.jdy_sync_tenant_schema(${sqlLiteral(freshTenantSchema)}, TRUE)`)),
    Number(psql(freshDatabase, `SELECT public.jdy_sync_tenant_schema(${sqlLiteral(freshTenantSchema)}, FALSE)`))
  ];
  assert(same(freshSyncCounts, [82, 82]), "fresh tenant create/repeat sync must return 82/82", freshSyncCounts);
  const freshTenantTopology = schemaTopology(freshDatabase, freshTenantSchema);
  assertTopology("fresh tenant", freshTenantTopology, 170);
  result.fresh = {
    ...result.fresh,
    historyCount: freshHistory.length,
    maxVersion: freshHistory.at(-1)?.version,
    publicTopology: freshPublicTopology,
    tenantTopology: freshTenantTopology,
    syncCounts: freshSyncCounts
  };
} catch (error) {
  primaryError = error;
  result.failure = errorText(error);
} finally {
  await cleanup();
  result.ok = primaryError == null
    && result.cleanup.errors.length === 0
    && result.restoreApi.restoreStatus === 200
    && result.restoreApi.committedPreserved === true
    && result.tenantIsolation.isolated === true;
  await writeFile(resultPath, `${JSON.stringify(result, null, 2)}\n`);
  removeLifecycleHandlers();
}

if (primaryError) throw primaryError;
if (result.cleanup.errors.length > 0) throw new Error(result.cleanup.errors.join("; "));

process.stdout.write(`${JSON.stringify({
  ok: result.ok,
  taskId: "A143",
  result: path.relative(rootDir, resultPath),
  assertions: result.assertions.length,
  upgrade: {
    version: result.upgrade.history?.version,
    managedCount: result.upgrade.managedCount,
    topologyDigest: digest(result.upgrade.topologies)
  },
  repeat: result.repeat.syncCounts,
  restoreApi: {
    backupStatus: result.restoreApi.backupStatus,
    restoreStatus: result.restoreApi.restoreStatus,
    unsubmittedExpired: result.restoreApi.unsubmittedExpired,
    committedPreserved: result.restoreApi.committedPreserved,
    restoredDigest: result.restoreApi.restoredDigest
  },
  tenantIsolation: result.tenantIsolation.isolated,
  fresh: {
    maxVersion: result.fresh.maxVersion,
    syncCounts: result.fresh.syncCounts,
    topologyDigest: digest({ public: result.fresh.publicTopology, tenant: result.fresh.tenantTopology })
  },
  cleanup: result.cleanup
}, null, 2)}\n`);
