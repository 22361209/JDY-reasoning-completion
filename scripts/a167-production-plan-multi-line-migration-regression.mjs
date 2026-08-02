#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, readdir, writeFile } from "node:fs/promises";
import path from "node:path";

const rootDir = path.resolve(import.meta.dirname, "..");
const migrationDir = path.join(rootDir, "backend/src/main/resources/db/migration");
const resultPath = path.join(rootDir, "verification/a167-production-plan-multi-line-migration-regression.json");
const container = process.env.JDY_POSTGRES_CONTAINER || "jdy-erp-postgres";
const databaseUser = process.env.JDY_DATABASE_USER || "jdy";
const databasePassword = process.env.JDY_DATABASE_PASSWORD || "jdy_dev";
const token = randomBytes(6).toString("hex");
const upgradeDatabase = `jdy_a167_mig_${token}`;
const freshDatabase = `jdy_a167_fresh_${token}`;
const tenantSchema = `tenant_a167_${token}`;
const backupSchema = `bk_a167_${token}`;
const tenantId = randomUUID();
const backupId = randomUUID();
const categoryId = randomUUID();
const unitId = randomUUID();
const warehouseId = randomUUID();
const productId = randomUUID();
const bomId = randomUUID();
const legacyPlanNo = `SCJH-A167-${token.toUpperCase()}`;
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
  return execFileSync("./scripts/backend-test.sh", args, {
    cwd: rootDir,
    encoding: "utf8",
    maxBuffer: 40 * 1024 * 1024
  }).trim().split(/\r?\n/).slice(-12);
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
  const normalized = Object.fromEntries(Object.entries(actual).map(([key, value]) => [key, Number(value)]));
  assert(
    normalized.tables === 87
      && normalized.pk === 87
      && normalized.uk === 82
      && normalized.fk === expectedFk
      && normalized.check === 108,
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
    );
    SELECT public.jdy_sync_tenant_schema(${literal(tenantSchema)}, TRUE);

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

  result.upgrade.flywayV110 = flyway(upgradeDatabase);
  const latestVersion = psql(upgradeDatabase, "SELECT max(version::integer) FROM public.flyway_schema_history WHERE success");
  assert(latestVersion === "110", "upgrade must end at V110", latestVersion);
  assertTopology("upgrade public", topology(upgradeDatabase, "public"), 191);
  assertTopology("upgrade tenant", topology(upgradeDatabase, tenantSchema), 187);
  assert(psql(upgradeDatabase, `SELECT public.jdy_sync_tenant_schema(${literal(tenantSchema)}, FALSE)`) === "87", "repeat tenant sync must return 87");

  const backfill = json(upgradeDatabase, `
    SELECT jsonb_build_object(
      'publicLines', (SELECT count(*) FROM public.production_plan_line line JOIN public.production_plan plan ON plan.id=line.plan_id WHERE plan.bill_no=${literal(legacyPlanNo)} AND line.line_no=1 AND line.planned_qty=7),
      'backupLines', (SELECT count(*) FROM ${identifier(backupSchema)}.production_plan_line line JOIN ${identifier(backupSchema)}.production_plan plan ON plan.id=line.plan_id WHERE plan.bill_no=${literal(legacyPlanNo)} AND line.line_no=1 AND line.planned_qty=7 AND line.id IS NOT NULL),
      'backupConstraints', (SELECT count(*) FROM pg_constraint c JOIN pg_class t ON t.oid=c.conrelid JOIN pg_namespace n ON n.oid=t.relnamespace WHERE n.nspname=${literal(backupSchema)} AND t.relname='production_plan_line'),
      'publicSourceIssueColumn', (SELECT count(*) FROM information_schema.columns WHERE table_schema='public' AND table_name='production_completion' AND column_name='source_issue_id'),
      'tenantSourceIssueColumn', (SELECT count(*) FROM information_schema.columns WHERE table_schema=${literal(tenantSchema)} AND table_name='production_completion' AND column_name='source_issue_id'),
      'backupSourceIssueColumn', (SELECT count(*) FROM information_schema.columns WHERE table_schema=${literal(backupSchema)} AND table_name='production_completion' AND column_name='source_issue_id'),
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
  assert(Number(backfill.planBillNoUniqueBtree) === 1, "production_plan must retain exactly one single-column unique bill_no btree", backfill);
  result.upgrade = { ...result.upgrade, latestVersion, publicTopology: topology(upgradeDatabase, "public"), tenantTopology: topology(upgradeDatabase, tenantSchema), backfill };

  createDatabase(freshDatabase);
  result.fresh.flyway = flyway(freshDatabase);
  const sourceScripts = (await readdir(migrationDir))
    .filter((name) => /^V\d+__.+\.sql$/.test(name))
    .sort((left, right) => Number(left.match(/^V(\d+)/)[1]) - Number(right.match(/^V(\d+)/)[1]));
  const historyScripts = json(freshDatabase, "SELECT COALESCE(jsonb_agg(script ORDER BY installed_rank), '[]'::jsonb)::text FROM public.flyway_schema_history WHERE type='SQL'");
  assert(JSON.stringify(historyScripts) === JSON.stringify(sourceScripts), "fresh Flyway history must equal the migration source set");
  assert(psql(freshDatabase, "SELECT max(version::integer) FROM public.flyway_schema_history WHERE success") === "110", "fresh migration must end at V110");
  assertTopology("fresh public", topology(freshDatabase, "public"), 191);
  result.fresh = { ...result.fresh, latestVersion: 110, topology: topology(freshDatabase, "public") };
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
