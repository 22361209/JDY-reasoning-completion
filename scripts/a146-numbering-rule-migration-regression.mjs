#!/usr/bin/env node

import { execFileSync, spawnSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, readdir, writeFile } from "node:fs/promises";
import path from "node:path";

const rootDir = path.resolve(import.meta.dirname, "..");
const migrationDir = path.join(rootDir, "backend/src/main/resources/db/migration");
const resultPath = path.join(rootDir, "verification/a146-numbering-rule-migration-regression.json");
const container = process.env.JDY_POSTGRES_CONTAINER || "jdy-erp-postgres";
const databaseUser = process.env.JDY_DATABASE_USER || "jdy";
const databasePassword = process.env.JDY_DATABASE_PASSWORD || "jdy_dev";
const publishedV106Checksum = 1207842815;
const token = randomBytes(6).toString("hex");
const upgradeDatabase = `jdy_a146_mig_${token}`;
const freshDatabase = `jdy_a146_fresh_${token}`;
const invalidDatabase = `jdy_a146_invalid_${token}`;
const tenantSchema = `tenant_a146_${token}`;
const backupSchema = `bk_a146_${token}`;
const tenantCode = `A146-MIG-${token.toUpperCase()}`;
const tenantId = randomUUID();
const backupId = randomUUID();
const formalDocumentTables = [
  "sales_order", "sales_quote", "delivery_notice", "sales_out", "sales_return",
  "ar_receipt", "purchase_order", "purchase_requisition", "purchase_in", "ap_payment",
  "purchase_return", "production_material_issue", "production_completion", "other_stock_in",
  "other_stock_out", "stock_transfer", "stock_count", "stock_count_gain", "stock_count_loss",
  "production_plan", "production_task", "production_material_scrap", "outsourcing_work_order", "outsourcing_material_issue",
  "outsourcing_receipt", "outsourcing_return", "outsourcing_scrap"
];
const result = {
  ok: false,
  generatedAt: new Date().toISOString(),
  token,
  assertions: [],
  upgrade: {},
  repeat: {},
  restore: {},
  fresh: {},
  failClosed: {},
  cleanup: { databases: {}, residue: [] },
  failure: null
};

await mkdir(path.dirname(resultPath), { recursive: true });

function assert(condition, message, details = undefined) {
  if (!condition) throw new Error(`${message}${details === undefined ? "" : ` ${JSON.stringify(details)}`}`);
  result.assertions.push({ message, details });
}

function sqlLiteral(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function quoteIdentifier(value) {
  const normalized = String(value);
  assert(/^[a-z][a-z0-9_]{0,62}$/.test(normalized), `unsafe identifier ${normalized}`);
  return `"${normalized}"`;
}

function safeDatabase(database) {
  assert(/^jdy_a146_(?:mig|fresh|invalid)_[a-f0-9]{12}$/.test(database), `unsafe database ${database}`);
  return database;
}

function psql(database, statement) {
  return execFileSync(
    "docker",
    ["exec", container, "psql", "-X", "-v", "ON_ERROR_STOP=1", "-U", databaseUser, "-d", safeDatabase(database), "-tAq", "-c", statement],
    { encoding: "utf8", maxBuffer: 20 * 1024 * 1024 }
  ).trim();
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

function flywayArgs(database, target = null) {
  const args = [
    "org.flywaydb:flyway-maven-plugin:11.7.2:migrate",
    `-Dflyway.url=jdbc:postgresql://127.0.0.1:5432/${safeDatabase(database)}`,
    `-Dflyway.user=${databaseUser}`,
    `-Dflyway.password=${databasePassword}`,
    `-Dflyway.locations=filesystem:${migrationDir}`
  ];
  if (target != null) args.push(`-Dflyway.target=${target}`);
  return args;
}

function flyway(database, target = null) {
  const output = execFileSync("./scripts/backend-test.sh", flywayArgs(database, target), {
    cwd: rootDir,
    encoding: "utf8",
    maxBuffer: 40 * 1024 * 1024
  });
  return output.trim().split(/\r?\n/).slice(-12);
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

function numberingShape(database, schema) {
  return json(database, `
    SELECT jsonb_build_object(
      'lastType', (
        SELECT data_type FROM information_schema.columns
        WHERE table_schema=${sqlLiteral(schema)} AND table_name='document_number_sequence' AND column_name='last_number'
      ),
      'versionType', (
        SELECT data_type FROM information_schema.columns
        WHERE table_schema=${sqlLiteral(schema)} AND table_name='document_number_sequence' AND column_name='version'
      ),
      'versionNullable', (
        SELECT is_nullable FROM information_schema.columns
        WHERE table_schema=${sqlLiteral(schema)} AND table_name='document_number_sequence' AND column_name='version'
      ),
      'versionDefault', (
        SELECT column_default FROM information_schema.columns
        WHERE table_schema=${sqlLiteral(schema)} AND table_name='document_number_sequence' AND column_name='version'
      ),
      'checks', (
        SELECT COALESCE(jsonb_agg(conname ORDER BY conname), '[]'::jsonb)
        FROM pg_constraint c
        JOIN pg_class t ON t.oid=c.conrelid
        JOIN pg_namespace n ON n.oid=t.relnamespace
        WHERE n.nspname=${sqlLiteral(schema)} AND t.relname='document_number_sequence' AND c.contype='c'
      ),
      'legacyRows', (SELECT count(*) FROM ${quoteIdentifier(schema)}.document_number_sequence WHERE document_type='outsourcingSurface'),
      'validRow', (
        SELECT jsonb_build_object('prefix', prefix, 'lastNumber', last_number, 'width', width, 'version', version)
        FROM ${quoteIdentifier(schema)}.document_number_sequence
        WHERE document_type='stockCountGain'
      )
    )::text
  `);
}

function managedTopology(database, schema) {
  return json(database, `
    SELECT jsonb_build_object(
      'tables', (SELECT count(*) FROM public.sys_tenant_managed_table),
      'pk', count(*) FILTER (WHERE c.contype='p'),
      'uk', count(*) FILTER (WHERE c.contype='u'),
      'fk', count(*) FILTER (WHERE c.contype='f'),
      'check', count(*) FILTER (WHERE c.contype='c')
    )::text
    FROM pg_constraint c
    JOIN pg_class t ON t.oid=c.conrelid
    JOIN pg_namespace n ON n.oid=t.relnamespace
    JOIN public.sys_tenant_managed_table m ON m.table_name=t.relname
    WHERE n.nspname=${sqlLiteral(schema)}
  `);
}

function billNoIndexCoverage(database, schema) {
  const tableValues = formalDocumentTables.map((table) => `(${sqlLiteral(table)})`).join(", ");
  return Number(psql(database, `
    WITH formal_table(table_name) AS (VALUES ${tableValues})
    SELECT count(*)
    FROM formal_table formal
    WHERE EXISTS (
      SELECT 1
      FROM pg_class table_class
      JOIN pg_namespace schema_row ON schema_row.oid=table_class.relnamespace
      JOIN pg_attribute bill_no
        ON bill_no.attrelid=table_class.oid
       AND bill_no.attname='bill_no'
       AND NOT bill_no.attisdropped
      JOIN pg_index index_row ON index_row.indrelid=table_class.oid
      JOIN pg_class index_class ON index_class.oid=index_row.indexrelid
      JOIN pg_am access_method ON access_method.oid=index_class.relam
      WHERE schema_row.nspname=${sqlLiteral(schema)}
        AND table_class.relname=formal.table_name
        AND index_row.indisvalid
        AND index_row.indisready
        AND index_row.indisunique
        AND index_row.indpred IS NULL
        AND index_row.indexprs IS NULL
        AND index_row.indnkeyatts=1
        AND index_row.indkey[0]=bill_no.attnum
        AND access_method.amname='btree'
    )
  `));
}

function seedUpgradeFixture() {
  psql(upgradeDatabase, `
    BEGIN;
    INSERT INTO public.sys_account_set (
      id, code, name, environment, database_name, schema_name,
      attachment_prefix, redis_key_prefix, accounting_period, business_period,
      enabled, initialized
    ) VALUES (
      ${sqlLiteral(tenantId)}::uuid,
      ${sqlLiteral(tenantCode)},
      'A146 migration tenant',
      'A146 regression',
      ${sqlLiteral(upgradeDatabase)},
      ${sqlLiteral(tenantSchema)},
      ${sqlLiteral(`account-sets/${tenantCode}`)},
      ${sqlLiteral(tenantCode)},
      '2026-07', '2026-07', TRUE, TRUE
    );
    SELECT public.jdy_sync_tenant_schema(${sqlLiteral(tenantSchema)}, TRUE);

    INSERT INTO public.document_number_sequence (
      account_set_id, document_type, prefix, last_number, width, description, enabled
    ) VALUES
      ('00000000-0000-0000-0000-000000000001'::uuid, 'stockCountGain', 'PUBPY', 321, 6, '盘盈单', TRUE),
      ('00000000-0000-0000-0000-000000000001'::uuid, 'outsourcingSurface', 'WWBM', 7, 6, '遗留表面处理', TRUE);

    INSERT INTO ${quoteIdentifier(tenantSchema)}.document_number_sequence (
      account_set_id, document_type, prefix, last_number, width, description, enabled
    ) VALUES
      (${sqlLiteral(tenantId)}::uuid, 'stockCountGain', 'TENPY', 2147483647, 12, '盘盈单', TRUE),
      (${sqlLiteral(tenantId)}::uuid, 'outsourcingSurface', 'WWBM', 8, 6, '遗留表面处理', TRUE);
    COMMIT;

    DO $backup$
    DECLARE
      managed RECORD;
      admin_id UUID;
    BEGIN
      CREATE SCHEMA ${quoteIdentifier(backupSchema)};
      FOR managed IN SELECT table_name FROM public.sys_tenant_managed_table ORDER BY restore_order, table_name
      LOOP
        EXECUTE format(
          'CREATE TABLE %I.%I AS TABLE %I.%I',
          ${sqlLiteral(backupSchema)}, managed.table_name,
          ${sqlLiteral(tenantSchema)}, managed.table_name
        );
      END LOOP;
      SELECT id INTO STRICT admin_id FROM public.sys_user WHERE username='admin';
      INSERT INTO public.sys_account_set_backup (
        id, account_set_id, account_set_code, account_set_name,
        backup_name, backup_schema_name, attachment_prefix,
        table_count, row_count, created_by
      ) VALUES (
        ${sqlLiteral(backupId)}::uuid,
        ${sqlLiteral(tenantId)}::uuid,
        ${sqlLiteral(tenantCode)},
        'A146 migration tenant',
        'A146 historical backup',
        ${sqlLiteral(backupSchema)},
        '',
        82,
        2,
        admin_id
      );
    END $backup$;
  `);
}

function assertShape(label, shape, expectedChecks, expectedLast) {
  assert(shape.lastType === "bigint", `${label} last_number must be BIGINT`, shape);
  assert(shape.versionType === "bigint" && shape.versionNullable === "NO", `${label} version must be required BIGINT`, shape);
  assert(String(shape.versionDefault).includes("0"), `${label} version default must be zero`, shape);
  assert(shape.checks.length === expectedChecks, `${label} CHECK count mismatch`, shape);
  assert(Number(shape.legacyRows) === 0, `${label} retired outsourcingSurface must be removed`, shape);
  if (expectedLast != null) {
    assert(Number(shape.validRow?.lastNumber) === expectedLast && Number(shape.validRow?.version) === 0, `${label} valid high water must be preserved`, shape);
  }
}

function restoreDataOnlySnapshot() {
  psql(upgradeDatabase, `
    UPDATE ${quoteIdentifier(backupSchema)}.document_number_sequence
    SET last_number=999999999999,
        width=12,
        version=7
    WHERE document_type='stockCountGain';

    TRUNCATE TABLE ${quoteIdentifier(tenantSchema)}.document_number_sequence;
    INSERT INTO ${quoteIdentifier(tenantSchema)}.document_number_sequence (
      document_type, prefix, last_number, updated_at, id,
      account_set_id, width, description, enabled, version
    )
    SELECT document_type, prefix, last_number, updated_at, id,
           account_set_id, width, description, enabled, version
    FROM ${quoteIdentifier(backupSchema)}.document_number_sequence;
  `);
  return json(upgradeDatabase, `
    SELECT jsonb_build_object(
      'lastNumber', last_number,
      'width', width,
      'version', version,
      'legacyRows', (SELECT count(*) FROM ${quoteIdentifier(tenantSchema)}.document_number_sequence WHERE document_type='outsourcingSurface')
    )::text
    FROM ${quoteIdentifier(tenantSchema)}.document_number_sequence
    WHERE document_type='stockCountGain'
  `);
}

let primaryError = null;
try {
  createDatabase(upgradeDatabase);
  flyway(upgradeDatabase, 104);
  seedUpgradeFixture();
  result.upgrade.flyway = flyway(upgradeDatabase);
  const upgradeHistory = history(upgradeDatabase);
  const v105Rows = upgradeHistory.filter((row) => row.version === "105");
  const v106Rows = upgradeHistory.filter((row) => row.version === "106");
  const v107Rows = upgradeHistory.filter((row) => row.version === "107");
  const v108Rows = upgradeHistory.filter((row) => row.version === "108");
  assert(v105Rows.length === 1 && v105Rows[0].success === true, "upgrade must apply successful V105 exactly once", v105Rows);
  assert(v106Rows.length === 1 && v106Rows[0].success === true, "upgrade must apply successful V106 exactly once", v106Rows);
  assert(Number(v106Rows[0].checksum) === publishedV106Checksum, "published V106 checksum must remain immutable", v106Rows[0]);
  assert(v107Rows.length === 1 && v107Rows[0].success === true, "upgrade must apply successful V107 exactly once", v107Rows);
  assert(v108Rows.length === 1 && v108Rows[0].success === true, "upgrade must apply successful V108 exactly once", v108Rows);
  assert(upgradeHistory.at(-1)?.version === "108", "repository latest upgrade must end at V108", upgradeHistory.at(-1));
  const shapes = {
    public: numberingShape(upgradeDatabase, "public"),
    tenant: numberingShape(upgradeDatabase, tenantSchema),
    backup: numberingShape(upgradeDatabase, backupSchema)
  };
  assertShape("upgrade public", shapes.public, 4, 321);
  assertShape("upgrade tenant", shapes.tenant, 4, 2147483647);
  assertShape("historical backup", shapes.backup, 0, 2147483647);
  const topologies = {
    public: managedTopology(upgradeDatabase, "public"),
    tenant: managedTopology(upgradeDatabase, tenantSchema)
  };
  const indexCoverage = {
    public: billNoIndexCoverage(upgradeDatabase, "public"),
    tenant: billNoIndexCoverage(upgradeDatabase, tenantSchema)
  };
  assert(indexCoverage.public === 27 && indexCoverage.tenant === 27, "all 27 formal bill_no columns need a unique btree for indexed reverse high-water lookup", indexCoverage);
  assert(
    Number(topologies.public.tables) === 84
      && Number(topologies.public.pk) === 84
      && Number(topologies.public.uk) === 79
      && Number(topologies.public.fk) === 180
      && Number(topologies.public.check) === 97,
    "public V108 topology mismatch",
    topologies.public
  );
  assert(
    Number(topologies.tenant.tables) === 84
      && Number(topologies.tenant.pk) === 84
      && Number(topologies.tenant.uk) === 79
      && Number(topologies.tenant.fk) === 176
      && Number(topologies.tenant.check) === 97,
    "tenant V108 topology mismatch",
    topologies.tenant
  );
  result.upgrade = {
    ...result.upgrade,
    history: upgradeHistory.at(-1),
    migrations: { v105: v105Rows[0], v106: v106Rows[0], v107: v107Rows[0], v108: v108Rows[0] },
    shapes,
    topologies,
    indexCoverage
  };

  const beforeRepeat = JSON.stringify({ history: upgradeHistory, shapes, topologies, indexCoverage });
  result.repeat.flyway = flyway(upgradeDatabase);
  const syncCounts = [
    Number(psql(upgradeDatabase, `SELECT public.jdy_sync_tenant_schema(${sqlLiteral(tenantSchema)}, FALSE)`)),
    Number(psql(upgradeDatabase, `SELECT public.jdy_sync_tenant_schema(${sqlLiteral(tenantSchema)}, FALSE)`))
  ];
  assert(syncCounts.every((count) => count === 84), "repeat tenant sync must return 84", syncCounts);
  const afterRepeat = JSON.stringify({
    history: history(upgradeDatabase),
    shapes: {
      public: numberingShape(upgradeDatabase, "public"),
      tenant: numberingShape(upgradeDatabase, tenantSchema),
      backup: numberingShape(upgradeDatabase, backupSchema)
    },
    topologies: {
      public: managedTopology(upgradeDatabase, "public"),
      tenant: managedTopology(upgradeDatabase, tenantSchema)
    },
    indexCoverage: {
      public: billNoIndexCoverage(upgradeDatabase, "public"),
      tenant: billNoIndexCoverage(upgradeDatabase, tenantSchema)
    }
  });
  assert(beforeRepeat === afterRepeat, "repeat Flyway/sync must be a no-op for exact repository-latest state");
  result.repeat = { ...result.repeat, syncCounts };

  const restored = restoreDataOnlySnapshot();
  assert(Number(restored.lastNumber) === 999999999999 && Number(restored.width) === 12 && Number(restored.version) === 7, "backup/restore must preserve 12-digit BIGINT state", restored);
  assert(Number(restored.legacyRows) === 0, "restore must not resurrect retired numbering rule", restored);
  result.restore = {
    mode: "data-only structural copy; real AccountSetMaintenanceService backup/restore is covered by NumberingServiceReliabilityIntegrationTest",
    snapshot: restored
  };

  createDatabase(freshDatabase);
  result.fresh.flyway = flyway(freshDatabase);
  const freshHistory = history(freshDatabase);
  const sourceScripts = (await readdir(migrationDir))
    .filter((name) => /^V\d+__.+\.sql$/.test(name))
    .sort((left, right) => Number(left.match(/^V(\d+)/)[1]) - Number(right.match(/^V(\d+)/)[1]));
  const freshV105Rows = freshHistory.filter((row) => row.version === "105");
  const freshV106Rows = freshHistory.filter((row) => row.version === "106");
  const freshV107Rows = freshHistory.filter((row) => row.version === "107");
  const freshV108Rows = freshHistory.filter((row) => row.version === "108");
  const freshShape = numberingShape(freshDatabase, "public");
  assert(freshHistory.every((row) => row.success === true), "fresh history must contain only successful migrations", freshHistory);
  assert(JSON.stringify(freshHistory.map((row) => row.script)) === JSON.stringify(sourceScripts), "fresh history must exactly equal the migration source set");
  assert(freshV105Rows.length === 1 && freshV105Rows[0].success === true, "fresh migration must apply successful V105 exactly once", freshV105Rows);
  assert(freshV106Rows.length === 1 && freshV106Rows[0].success === true, "fresh migration must apply successful V106 exactly once", freshV106Rows);
  assert(Number(freshV106Rows[0].checksum) === publishedV106Checksum, "fresh V106 checksum must match the immutable published checksum", freshV106Rows[0]);
  assert(freshV107Rows.length === 1 && freshV107Rows[0].success === true, "fresh migration must apply successful V107 exactly once", freshV107Rows);
  assert(freshV108Rows.length === 1 && freshV108Rows[0].success === true, "fresh migration must apply successful V108 exactly once", freshV108Rows);
  assert(freshHistory.at(-1)?.version === "108", "fresh migration must end at V108", freshHistory.at(-1));
  assertShape("fresh public", freshShape, 4, null);
  const freshIndexCoverage = billNoIndexCoverage(freshDatabase, "public");
  assert(freshIndexCoverage === 27, "fresh public must retain unique btree coverage for all 27 formal bill_no columns", freshIndexCoverage);
  result.fresh = {
    ...result.fresh,
    history: freshHistory.at(-1),
    migrations: { v105: freshV105Rows[0], v106: freshV106Rows[0], v107: freshV107Rows[0], v108: freshV108Rows[0] },
    exactSourceHistory: true,
    shape: freshShape,
    indexCoverage: freshIndexCoverage
  };

  createDatabase(invalidDatabase);
  flyway(invalidDatabase, 104);
  psql(invalidDatabase, `
    INSERT INTO public.document_number_sequence (
      account_set_id, document_type, prefix, last_number, width, description, enabled
    ) VALUES (
      '00000000-0000-0000-0000-000000000001'::uuid,
      'stockCountGain',
      'BAD PREFIX',
      -1,
      2,
      'invalid fixture',
      TRUE
    )
  `);
  const failed = spawnSync("./scripts/backend-test.sh", flywayArgs(invalidDatabase), {
    cwd: rootDir,
    encoding: "utf8",
    maxBuffer: 40 * 1024 * 1024
  });
  const failureOutput = `${failed.stdout || ""}\n${failed.stderr || ""}`;
  assert(failed.status !== 0, "invalid V104 row must fail V105 migration");
  assert(failureOutput.includes("V105 invalid numbering rows require manual repair") && failureOutput.includes("schema=public") && failureOutput.includes("stockCountGain"), "fail-closed error must identify schema and document type", failureOutput.slice(-3000));
  assert(history(invalidDatabase).at(-1)?.version === "104", "failed migration must roll back and leave database at V104");
  assert(Number(psql(invalidDatabase, "SELECT count(*) FROM public.document_number_sequence WHERE document_type='stockCountGain' AND prefix='BAD PREFIX' AND last_number=-1")) === 1, "failed migration must not mutate invalid row");
  result.failClosed = { status: failed.status, messageIdentifiesObject: true, maxVersion: "104" };

  result.ok = true;
} catch (error) {
  primaryError = error;
  result.failure = error instanceof Error ? error.stack ?? error.message : String(error);
  process.exitCode = 1;
} finally {
  for (const database of [upgradeDatabase, freshDatabase, invalidDatabase]) {
    try {
      dropDatabase(database);
      result.cleanup.databases[database] = true;
    } catch (error) {
      result.cleanup.databases[database] = false;
      result.cleanup.residue.push(`${database}: ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 1;
    }
  }
  try {
    const residue = execFileSync(
      "docker",
      ["exec", container, "psql", "-X", "-U", databaseUser, "-d", "postgres", "-tAq", "-c", `SELECT datname FROM pg_database WHERE datname IN (${[upgradeDatabase, freshDatabase, invalidDatabase].map(sqlLiteral).join(",")}) ORDER BY datname`],
      { encoding: "utf8" }
    ).trim().split(/\r?\n/).filter(Boolean);
    result.cleanup.residue.push(...residue);
    assert(residue.length === 0, "isolated migration databases must leave zero residue", residue);
  } catch (error) {
    if (!primaryError) {
      result.ok = false;
      result.failure = error instanceof Error ? error.stack ?? error.message : String(error);
      process.exitCode = 1;
    }
  }
  await writeFile(resultPath, `${JSON.stringify(result, null, 2)}\n`);
}

if (!result.ok || result.cleanup.residue.length > 0) {
  console.error(JSON.stringify(result, null, 2));
} else {
  console.log(JSON.stringify({ ok: true, assertions: result.assertions.length, cleanup: result.cleanup }, null, 2));
}
