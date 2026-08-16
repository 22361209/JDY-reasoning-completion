import { chromium } from "playwright";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { installApiSession, loginAsAdmin, regressionAdminIdentity } from "./helpers/regression-auth.mjs";

const rootDir = path.resolve(import.meta.dirname, "..");
const screenshotDir = path.join(rootDir, "verification/playwright");
const resultPath = path.join(rootDir, "verification/a101-stock-alert-regression.json");
const frontendUrl = "http://127.0.0.1:5173/";
const apiBase = "http://127.0.0.1:8080";
const adminIdentity = regressionAdminIdentity();
const batch = new Date().toISOString().replace(/\D/g, "").slice(0, 14);
const productCode = "CP-001";
const faultPhase = (process.env.A101_FAULT_PHASE ?? "").trim();
const runToken = `${Date.now().toString(36)}-${randomUUID().slice(0, 12)}`.toUpperCase();
const fixtureKey = `A101-${runToken}`;
const warehouseCode = fixtureKey;
const warehouseName = `A101 库存预警回归仓 ${runToken}`;
const warehouseId = randomUUID();
const balanceId = randomUUID();
const fixtureQty = 12;

await installApiSession(apiBase);
await mkdir(screenshotDir, { recursive: true });
await mkdir(path.dirname(resultPath), { recursive: true });

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function assertUuid(value, label) {
  assert(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(value ?? "")), `${label} should be a UUID, got ${JSON.stringify(value)}`);
}

function sqlLiteral(value) {
  if (value == null) return "NULL";
  return `'${String(value).replaceAll("'", "''")}'`;
}

function nullableSql(value, type) {
  return value == null ? `NULL::${type}` : `${sqlLiteral(value)}::${type}`;
}

function dbScalar(sql) {
  return execFileSync("docker", [
    "exec", "jdy-erp-postgres", "psql", "-X", "-v", "ON_ERROR_STOP=1", "-qAt",
    "-U", "jdy", "-d", "jdy_erp", "-c", sql
  ], { encoding: "utf8" }).trim();
}

function dbExecute(sql) {
  execFileSync("docker", [
    "exec", "jdy-erp-postgres", "psql", "-X", "-v", "ON_ERROR_STOP=1", "-q",
    "-U", "jdy", "-d", "jdy_erp", "-c", sql
  ], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

function dbJson(sql) {
  const raw = dbScalar(sql);
  assert(raw, `SQL JSON query returned no row: ${sql}`);
  return JSON.parse(raw);
}

function productSnapshot() {
  return dbJson(`
    SELECT jsonb_build_object(
      'id', product.id::text,
      'code', product.code,
      'auditStatus', product.audit_status,
      'enabled', product.enabled,
      'isInventory', product.is_inventory,
      'rowDigest', encode(digest(to_jsonb(product)::text, 'sha256'), 'hex')
    )::text
    FROM public.md_product product
    WHERE product.code = ${sqlLiteral(productCode)}
  `);
}

function uuidArray(values) {
  return values.length === 0
    ? "ARRAY[]::uuid[]"
    : `ARRAY[${values.map(sqlLiteral).join(", ")}]::uuid[]`;
}

function quoteIdentifier(value) {
  return `"${String(value).replaceAll('"', '""')}"`;
}

function same(actual, expected) {
  return JSON.stringify(actual) === JSON.stringify(expected);
}

function normalizedSettingSql(alias) {
  return `jsonb_build_object(
    'id', ${alias}.id::text,
    'productId', ${alias}.product_id::text,
    'warehouseId', ${alias}.warehouse_id::text,
    'safetyQty', ${alias}.safety_qty::text,
    'maxQty', CASE WHEN ${alias}.max_qty IS NULL THEN NULL ELSE ${alias}.max_qty::text END,
    'createdAt', ${alias}.created_at::text,
    'updatedAt', ${alias}.updated_at::text,
    'version', ${alias}.version::text
  )`;
}

async function api(pathname, options = {}) {
  const response = await fetch(`${apiBase}${pathname}`, {
    method: options.method ?? "GET",
    headers: options.body ? { "Content-Type": "application/json" } : undefined,
    body: options.body ? JSON.stringify(options.body) : undefined
  });
  const text = await response.text();
  const data = text ? JSON.parse(text) : {};
  if (!response.ok) {
    throw new Error(`${options.method ?? "GET"} ${pathname} failed ${response.status}: ${text}`);
  }
  return data;
}

function fixtureCoordinates() {
  return dbJson(`
    SELECT jsonb_build_object(
      'productIds', (SELECT COALESCE(jsonb_agg(id::text ORDER BY id), '[]'::jsonb) FROM public.md_product WHERE code = ${sqlLiteral(productCode)}),
      'warehouseIds', (SELECT COALESCE(jsonb_agg(id::text ORDER BY id), '[]'::jsonb) FROM public.md_warehouse WHERE id = ${sqlLiteral(warehouseId)}::uuid OR code = ${sqlLiteral(warehouseCode)}),
      'balanceIds', (SELECT COALESCE(jsonb_agg(id::text ORDER BY id), '[]'::jsonb) FROM public.inv_stock_balance WHERE id = ${sqlLiteral(balanceId)}::uuid OR warehouse_id = ${sqlLiteral(warehouseId)}::uuid)
    )::text
  `);
}

function createFixture(accountSetId, productId) {
  return dbJson(`
    WITH inserted_warehouse AS (
      INSERT INTO public.md_warehouse (
        id, code, name, warehouse_type, manager, allow_negative_stock, remark, enabled, audit_status
      ) VALUES (
        ${sqlLiteral(warehouseId)}::uuid,
        ${sqlLiteral(warehouseCode)},
        ${sqlLiteral(warehouseName)},
        '普通仓',
        'A101',
        FALSE,
        ${sqlLiteral(fixtureKey)},
        TRUE,
        'AUDITED'
      )
      RETURNING *
    ), inserted_balance AS (
      INSERT INTO public.inv_stock_balance (
        id, account_set_id, product_id, warehouse_id,
        qty_on_hand, qty_available, qty_reserved
      )
      SELECT
        ${sqlLiteral(balanceId)}::uuid,
        ${sqlLiteral(accountSetId)}::uuid,
        ${sqlLiteral(productId)}::uuid,
        inserted_warehouse.id,
        ${fixtureQty}::numeric,
        ${fixtureQty}::numeric,
        0::numeric
      FROM inserted_warehouse
      RETURNING *
    )
    SELECT jsonb_build_object(
      'warehouse', (SELECT to_jsonb(inserted_warehouse) FROM inserted_warehouse),
      'balance', (SELECT to_jsonb(inserted_balance) FROM inserted_balance)
    )::text
  `);
}

function settingSnapshot(productId, warehouseId) {
  return dbJson(`
    SELECT COALESCE((
      SELECT ${normalizedSettingSql("setting")}
      FROM public.inv_safety_stock_setting setting
      WHERE setting.product_id = ${sqlLiteral(productId)}::uuid
        AND setting.warehouse_id = ${sqlLiteral(warehouseId)}::uuid
    ), 'null'::jsonb)::text
  `);
}

function assertOwnedMutation(previousSnapshot, currentSnapshot, productId, warehouseId, label, expectedSettingId = null) {
  assert(currentSnapshot, `${label} must leave one safety-stock setting row`);
  assertUuid(currentSnapshot.id, `${label} setting id`);
  if (expectedSettingId != null) {
    assertUuid(expectedSettingId, `${label} expected setting id`);
    assert(currentSnapshot.id === expectedSettingId,
      `${label} setting id must match the API-owned id: ${JSON.stringify({ expectedSettingId, currentSettingId: currentSnapshot.id })}`);
  }
  assert(currentSnapshot.productId === productId && currentSnapshot.warehouseId === warehouseId,
    `${label} setting coordinates changed: ${JSON.stringify(currentSnapshot)}`);
  assert(Number(currentSnapshot.safetyQty) === targetSafetyQty && Number(currentSnapshot.maxQty) === targetMaxQty,
    `${label} must persist this run's target values: ${JSON.stringify(currentSnapshot)}`);
  const expectedVersion = previousSnapshot == null ? 0n : BigInt(previousSnapshot.version) + 1n;
  assert(BigInt(currentSnapshot.version) === expectedVersion,
    `${label} detected concurrent version drift: expected ${expectedVersion}, got ${currentSnapshot.version}`);
  if (previousSnapshot) {
    assert(currentSnapshot.id === previousSnapshot.id, `${label} must update the original setting id`);
  }
  return currentSnapshot;
}

function restoreSettingWithCas({ productId, warehouseId, baseline, expectedCurrent, mutationObserved, ownedSettingId }) {
  const expected = expectedCurrent ?? baseline;
  if (mutationObserved) {
    assertUuid(ownedSettingId, "A101 CAS owned setting id");
    assert(expected?.id === ownedSettingId,
      `A101 CAS expected snapshot must match the API-owned setting id: ${JSON.stringify({ ownedSettingId, expected })}`);
  }
  const expectedJson = sqlLiteral(JSON.stringify(expected));
  const baselineJson = sqlLiteral(JSON.stringify(baseline));
  const ownedSettingIdSql = nullableSql(ownedSettingId, "uuid");
  dbExecute(`
    BEGIN;
    SET LOCAL lock_timeout = '5s';
    SET LOCAL statement_timeout = '30s';
    DO $a101_setting_restore$
    DECLARE
      expected_snapshot jsonb := ${expectedJson}::jsonb;
      baseline_snapshot jsonb := ${baselineJson}::jsonb;
      owned_setting_id uuid := ${ownedSettingIdSql};
      current_snapshot jsonb;
      restored_snapshot jsonb;
      affected_count bigint;
    BEGIN
      PERFORM 1
      FROM public.inv_safety_stock_setting setting
      WHERE setting.product_id = ${sqlLiteral(productId)}::uuid
        AND setting.warehouse_id = ${sqlLiteral(warehouseId)}::uuid
      FOR UPDATE;

      SELECT COALESCE((
        SELECT ${normalizedSettingSql("setting")}
        FROM public.inv_safety_stock_setting setting
        WHERE setting.product_id = ${sqlLiteral(productId)}::uuid
          AND setting.warehouse_id = ${sqlLiteral(warehouseId)}::uuid
      ), 'null'::jsonb)
      INTO current_snapshot;

      IF current_snapshot IS DISTINCT FROM expected_snapshot THEN
        RAISE EXCEPTION 'A101 CAS refused: setting changed after this run recorded its owned value/version';
      END IF;

      IF ${mutationObserved ? "TRUE" : "FALSE"} THEN
        IF owned_setting_id IS NULL
           OR expected_snapshot ->> 'id' IS NULL
           OR (expected_snapshot ->> 'id')::uuid IS DISTINCT FROM owned_setting_id THEN
          RAISE EXCEPTION 'A101 CAS refused: expected snapshot does not match the API-owned setting id';
        END IF;
        IF baseline_snapshot = 'null'::jsonb THEN
          DELETE FROM public.inv_safety_stock_setting
          WHERE id = owned_setting_id
            AND product_id = ${sqlLiteral(productId)}::uuid
            AND warehouse_id = ${sqlLiteral(warehouseId)}::uuid;
          GET DIAGNOSTICS affected_count = ROW_COUNT;
          IF affected_count <> 1 THEN
            RAISE EXCEPTION 'A101 CAS refused: fixture-created setting delete count was not one';
          END IF;
        ELSE
          UPDATE public.inv_safety_stock_setting
          SET safety_qty = (baseline_snapshot ->> 'safetyQty')::numeric,
              max_qty = CASE WHEN baseline_snapshot -> 'maxQty' = 'null'::jsonb THEN NULL ELSE (baseline_snapshot ->> 'maxQty')::numeric END,
              created_at = (baseline_snapshot ->> 'createdAt')::timestamptz,
              updated_at = (baseline_snapshot ->> 'updatedAt')::timestamptz,
              version = (baseline_snapshot ->> 'version')::bigint
          WHERE id = owned_setting_id
            AND product_id = ${sqlLiteral(productId)}::uuid
            AND warehouse_id = ${sqlLiteral(warehouseId)}::uuid;
          GET DIAGNOSTICS affected_count = ROW_COUNT;
          IF affected_count <> 1 THEN
            RAISE EXCEPTION 'A101 CAS refused: original setting restore count was not one';
          END IF;
        END IF;
      END IF;

      SELECT COALESCE((
        SELECT ${normalizedSettingSql("setting")}
        FROM public.inv_safety_stock_setting setting
        WHERE setting.product_id = ${sqlLiteral(productId)}::uuid
          AND setting.warehouse_id = ${sqlLiteral(warehouseId)}::uuid
      ), 'null'::jsonb)
      INTO restored_snapshot;
      IF restored_snapshot IS DISTINCT FROM baseline_snapshot THEN
        RAISE EXCEPTION 'A101 CAS restore did not reproduce the complete baseline snapshot';
      END IF;
    END;
    $a101_setting_restore$;
    COMMIT;
  `);
  const restored = settingSnapshot(productId, warehouseId);
  assert(same(restored, baseline), `A101 complete setting snapshot must return to baseline: ${JSON.stringify({ baseline, restored })}`);
  return restored;
}

function warehouseReferenceInventorySql() {
  return `(
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
      'constraintOid', reference.constraint_oid::text,
      'constraintName', reference.constraint_name,
      'keyOrdinal', reference.key_ordinal,
      'schemaName', reference.schema_name,
      'tableName', reference.table_name,
      'columnName', reference.column_name,
      'targetSchemaName', reference.target_schema_name,
      'targetTableName', reference.target_table_name,
      'targetColumnName', reference.target_column_name,
      'deleteAction', reference.delete_action
    ) ORDER BY reference.constraint_oid, reference.key_ordinal), '[]'::jsonb)
    FROM (
      SELECT constraint_row.oid AS constraint_oid,
             constraint_row.conname AS constraint_name,
             source_key.ordinal AS key_ordinal,
             source_namespace.nspname AS schema_name,
             source_table.relname AS table_name,
             source_attribute.attname AS column_name,
             target_namespace.nspname AS target_schema_name,
             target_table.relname AS target_table_name,
             target_attribute.attname AS target_column_name,
             constraint_row.confdeltype::text AS delete_action
      FROM pg_constraint constraint_row
      JOIN pg_class source_table ON source_table.oid = constraint_row.conrelid
      JOIN pg_namespace source_namespace ON source_namespace.oid = source_table.relnamespace
      JOIN pg_class target_table ON target_table.oid = constraint_row.confrelid
      JOIN pg_namespace target_namespace ON target_namespace.oid = target_table.relnamespace
      JOIN LATERAL unnest(constraint_row.conkey) WITH ORDINALITY source_key(attnum, ordinal) ON TRUE
      JOIN LATERAL unnest(constraint_row.confkey) WITH ORDINALITY target_key(attnum, ordinal)
        ON target_key.ordinal = source_key.ordinal
      JOIN pg_attribute source_attribute
        ON source_attribute.attrelid = constraint_row.conrelid
       AND source_attribute.attnum = source_key.attnum
      JOIN pg_attribute target_attribute
        ON target_attribute.attrelid = constraint_row.confrelid
       AND target_attribute.attnum = target_key.attnum
      WHERE constraint_row.contype = 'f'
        AND constraint_row.confrelid = 'public.md_warehouse'::regclass
    ) reference
  )`;
}

function warehouseReferenceColumns() {
  return dbJson(`SELECT ${warehouseReferenceInventorySql()}::text`);
}

function documentReferenceColumns(references) {
  const nonDocumentTables = new Set([
    "inv_safety_stock_setting",
    "inv_stock_balance",
    "inv_stock_txn"
  ]);
  return references.filter((reference) => !nonDocumentTables.has(reference.tableName));
}

function countWarehouseReferenceRows(references) {
  if (references.length === 0) return 0;
  const union = references.map((reference) => `
    SELECT count(*)::bigint AS reference_count
    FROM ${quoteIdentifier(reference.schemaName)}.${quoteIdentifier(reference.tableName)}
    WHERE ${quoteIdentifier(reference.columnName)} = ${sqlLiteral(warehouseId)}::uuid
  `).join(" UNION ALL ");
  return Number(dbScalar(`SELECT COALESCE(sum(reference_count), 0)::text FROM (${union}) reference_counts`));
}

function fixtureResidue(references, settingIds) {
  const core = dbJson(`
    SELECT jsonb_build_object(
      'settings', (SELECT count(*) FROM public.inv_safety_stock_setting WHERE warehouse_id = ${sqlLiteral(warehouseId)}::uuid OR id = ANY(${uuidArray(settingIds)})),
      'balances', (SELECT count(*) FROM public.inv_stock_balance WHERE warehouse_id = ${sqlLiteral(warehouseId)}::uuid OR id = ${sqlLiteral(balanceId)}::uuid),
      'warehouse', (SELECT count(*) FROM public.md_warehouse WHERE id = ${sqlLiteral(warehouseId)}::uuid OR code = ${sqlLiteral(warehouseCode)}),
      'transactions', (SELECT count(*) FROM public.inv_stock_txn WHERE warehouse_id = ${sqlLiteral(warehouseId)}::uuid),
      'logs', (SELECT count(*) FROM public.sys_operation_log WHERE target_id = ANY(${uuidArray([warehouseId, balanceId, ...settingIds])}) OR target_no IN (${sqlLiteral(warehouseCode)}, ${sqlLiteral(fixtureKey)})),
      'locks', (SELECT count(*) FROM public.doc_edit_lock WHERE bill_no IN (${sqlLiteral(warehouseCode)}, ${sqlLiteral(fixtureKey)}))
    )::text
  `);
  return {
    ...core,
    documents: countWarehouseReferenceRows(documentReferenceColumns(references))
  };
}

function cleanupFixtureWithSnapshots({ references, snapshots, settingIds }) {
  const expectedWarehouseRows = snapshots.warehouse ? [snapshots.warehouse] : [];
  const expectedBalanceRows = snapshots.balance ? [snapshots.balance] : [];
  const expectedReferences = sqlLiteral(JSON.stringify(references));
  const documentReferences = documentReferenceColumns(references);
  const childLockTables = new Set([
    '"public"."inv_safety_stock_setting"',
    '"public"."inv_stock_balance"',
    '"public"."inv_stock_txn"',
    '"public"."sys_operation_log"',
    '"public"."doc_edit_lock"'
  ]);
  for (const reference of references) {
    const tableName = `${quoteIdentifier(reference.schemaName)}.${quoteIdentifier(reference.tableName)}`;
    if (tableName !== '"public"."md_warehouse"') {
      childLockTables.add(tableName);
    }
  }
  const assertNoDocumentReferences = documentReferences.map((reference) => `
      IF EXISTS (
        SELECT 1
        FROM ${quoteIdentifier(reference.schemaName)}.${quoteIdentifier(reference.tableName)}
        WHERE ${quoteIdentifier(reference.columnName)} = ${sqlLiteral(warehouseId)}::uuid
      ) THEN
        RAISE EXCEPTION 'A101 cleanup refused: run warehouse is referenced by %.%.%',
          ${sqlLiteral(reference.schemaName)}, ${sqlLiteral(reference.tableName)}, ${sqlLiteral(reference.columnName)};
      END IF;
  `).join("\n");
  const trackedTargetIds = [warehouseId, balanceId, ...settingIds];

  dbExecute(`
    BEGIN;
    SET LOCAL lock_timeout = '5s';
    SET LOCAL statement_timeout = '30s';
    LOCK TABLE ${[...childLockTables].sort().join(",\n               ")} IN SHARE ROW EXCLUSIVE MODE;
    LOCK TABLE "public"."md_warehouse" IN SHARE ROW EXCLUSIVE MODE;

    DO $a101_fk_inventory_after_all_locks$
    DECLARE
      expected_references jsonb := ${expectedReferences}::jsonb;
      actual_references jsonb;
    BEGIN
      SELECT ${warehouseReferenceInventorySql()}
      INTO actual_references;
      IF actual_references IS DISTINCT FROM expected_references THEN
        RAISE EXCEPTION 'A101 cleanup refused: warehouse FK inventory changed after known child and parent locks';
      END IF;
      IF EXISTS (
        SELECT 1
        FROM jsonb_array_elements(actual_references) reference
        WHERE reference ->> 'schemaName' <> 'public'
           OR reference ->> 'targetSchemaName' <> 'public'
           OR reference ->> 'targetTableName' <> 'md_warehouse'
           OR reference ->> 'targetColumnName' <> 'id'
           OR reference ->> 'deleteAction' <> 'a'
      ) THEN
        RAISE EXCEPTION 'A101 cleanup refused: warehouse FK inventory contains an unsupported schema, target column, or delete action';
      END IF;
    END;
    $a101_fk_inventory_after_all_locks$;

    DO $a101_fixture_cleanup$
    DECLARE
      expected_references jsonb := ${expectedReferences}::jsonb;
      expected_warehouse_rows jsonb := ${sqlLiteral(JSON.stringify(expectedWarehouseRows))}::jsonb;
      expected_balance_rows jsonb := ${sqlLiteral(JSON.stringify(expectedBalanceRows))}::jsonb;
      actual_references jsonb;
      actual_rows jsonb;
      affected_count bigint;
    BEGIN
      SELECT ${warehouseReferenceInventorySql()}
      INTO actual_references;
      IF actual_references IS DISTINCT FROM expected_references THEN
        RAISE EXCEPTION 'A101 cleanup refused: warehouse FK inventory changed after child-table locks';
      END IF;
      IF EXISTS (
        SELECT 1
        FROM jsonb_array_elements(actual_references) reference
        WHERE reference ->> 'schemaName' <> 'public'
           OR reference ->> 'targetSchemaName' <> 'public'
           OR reference ->> 'targetTableName' <> 'md_warehouse'
           OR reference ->> 'targetColumnName' <> 'id'
           OR reference ->> 'deleteAction' <> 'a'
      ) THEN
        RAISE EXCEPTION 'A101 cleanup refused: locked warehouse FK inventory contains an unsupported schema, target column, or delete action';
      END IF;

      SELECT COALESCE(jsonb_agg(to_jsonb(warehouse_row) ORDER BY warehouse_row.id), '[]'::jsonb)
      INTO actual_rows
      FROM public.md_warehouse warehouse_row
      WHERE warehouse_row.id = ${sqlLiteral(warehouseId)}::uuid
         OR warehouse_row.code = ${sqlLiteral(warehouseCode)};
      IF actual_rows IS DISTINCT FROM expected_warehouse_rows THEN
        RAISE EXCEPTION 'A101 cleanup refused: complete warehouse snapshot or unique-code set changed';
      END IF;

      SELECT COALESCE(jsonb_agg(to_jsonb(balance_row) ORDER BY balance_row.id), '[]'::jsonb)
      INTO actual_rows
      FROM public.inv_stock_balance balance_row
      WHERE balance_row.id = ${sqlLiteral(balanceId)}::uuid
         OR balance_row.warehouse_id = ${sqlLiteral(warehouseId)}::uuid;
      IF actual_rows IS DISTINCT FROM expected_balance_rows THEN
        RAISE EXCEPTION 'A101 cleanup refused: complete balance snapshot or warehouse balance set changed';
      END IF;

      IF EXISTS (
        SELECT 1 FROM public.inv_safety_stock_setting
        WHERE warehouse_id = ${sqlLiteral(warehouseId)}::uuid
           OR id = ANY(${uuidArray(settingIds)})
      ) THEN
        RAISE EXCEPTION 'A101 cleanup refused: safety-stock setting remains after CAS cleanup';
      END IF;
      IF EXISTS (SELECT 1 FROM public.inv_stock_txn WHERE warehouse_id = ${sqlLiteral(warehouseId)}::uuid) THEN
        RAISE EXCEPTION 'A101 cleanup refused: transaction references the run warehouse';
      END IF;
      IF EXISTS (
        SELECT 1 FROM public.sys_operation_log
        WHERE target_id = ANY(${uuidArray(trackedTargetIds)})
           OR target_no IN (${sqlLiteral(warehouseCode)}, ${sqlLiteral(fixtureKey)})
      ) THEN
        RAISE EXCEPTION 'A101 cleanup refused: operation log references a run fixture id or code';
      END IF;
      IF EXISTS (
        SELECT 1 FROM public.doc_edit_lock
        WHERE bill_no IN (${sqlLiteral(warehouseCode)}, ${sqlLiteral(fixtureKey)})
      ) THEN
        RAISE EXCEPTION 'A101 cleanup refused: document lock references the run fixture key';
      END IF;
${assertNoDocumentReferences}

      IF jsonb_array_length(expected_balance_rows) = 1 THEN
        DELETE FROM public.inv_stock_balance balance_row
        WHERE balance_row.id = ${sqlLiteral(balanceId)}::uuid
          AND balance_row.warehouse_id = ${sqlLiteral(warehouseId)}::uuid
          AND to_jsonb(balance_row) = (expected_balance_rows -> 0);
        GET DIAGNOSTICS affected_count = ROW_COUNT;
        IF affected_count <> 1 THEN
          RAISE EXCEPTION 'A101 cleanup refused: exact balance delete count was not one';
        END IF;
      ELSIF jsonb_array_length(expected_balance_rows) <> 0 THEN
        RAISE EXCEPTION 'A101 cleanup refused: invalid expected balance snapshot cardinality';
      END IF;

      IF jsonb_array_length(expected_warehouse_rows) = 1 THEN
        DELETE FROM public.md_warehouse warehouse_row
        WHERE warehouse_row.id = ${sqlLiteral(warehouseId)}::uuid
          AND warehouse_row.code = ${sqlLiteral(warehouseCode)}
          AND to_jsonb(warehouse_row) = (expected_warehouse_rows -> 0);
        GET DIAGNOSTICS affected_count = ROW_COUNT;
        IF affected_count <> 1 THEN
          RAISE EXCEPTION 'A101 cleanup refused: exact warehouse delete count was not one';
        END IF;
      ELSIF jsonb_array_length(expected_warehouse_rows) <> 0 THEN
        RAISE EXCEPTION 'A101 cleanup refused: invalid expected warehouse snapshot cardinality';
      END IF;

      IF EXISTS (SELECT 1 FROM public.inv_safety_stock_setting WHERE warehouse_id = ${sqlLiteral(warehouseId)}::uuid OR id = ANY(${uuidArray(settingIds)}))
         OR EXISTS (SELECT 1 FROM public.inv_stock_balance WHERE warehouse_id = ${sqlLiteral(warehouseId)}::uuid OR id = ${sqlLiteral(balanceId)}::uuid)
         OR EXISTS (SELECT 1 FROM public.md_warehouse WHERE id = ${sqlLiteral(warehouseId)}::uuid OR code = ${sqlLiteral(warehouseCode)})
         OR EXISTS (SELECT 1 FROM public.inv_stock_txn WHERE warehouse_id = ${sqlLiteral(warehouseId)}::uuid)
         OR EXISTS (SELECT 1 FROM public.sys_operation_log WHERE target_id = ANY(${uuidArray(trackedTargetIds)}) OR target_no IN (${sqlLiteral(warehouseCode)}, ${sqlLiteral(fixtureKey)}))
         OR EXISTS (SELECT 1 FROM public.doc_edit_lock WHERE bill_no IN (${sqlLiteral(warehouseCode)}, ${sqlLiteral(fixtureKey)})) THEN
        RAISE EXCEPTION 'A101 cleanup closure is not zero';
      END IF;
${assertNoDocumentReferences}
    END;
    $a101_fixture_cleanup$;
    COMMIT;
  `);

  const residue = fixtureResidue(references, settingIds);
  const nonZero = Object.entries(residue).filter(([, value]) => Number(value) !== 0);
  assert(nonZero.length === 0, `A101 fixture cleanup residue must be zero, got ${JSON.stringify(residue)}`);
  return residue;
}

function serializeError(error) {
  if (!error) return null;
  return { name: error.name ?? "Error", message: error.message ?? String(error), stack: error.stack ?? "" };
}

const health = await api("/api/system/health");
assert(health.status === "UP", `A101 health precondition should be UP, got ${JSON.stringify(health.status)}`);
assert(health.testInventoryAdjustmentApi === true, `A101 requires health.testInventoryAdjustmentApi=true before fixture writes, got ${JSON.stringify(health.testInventoryAdjustmentApi)}`);
const session = await api("/api/system/session");
assert(session.authenticated === true, `A101 session must be authenticated, got ${JSON.stringify(session.authenticated)}`);
assert(session.user?.username === adminIdentity.username, `A101 session actor must be the run-scoped admin, got ${JSON.stringify(session.user?.username)}`);
assert(session.tenant?.code === "BLD-TEST", `A101 must run only in tenant.code=BLD-TEST, got ${JSON.stringify(session.tenant?.code)}`);
assert(session.tenant?.schemaName === "public", `A101 must run only in tenant.schemaName=public, got ${JSON.stringify(session.tenant?.schemaName)}`);
assertUuid(session.tenant?.id, "A101 account set id");
assert(["", "after-api-write"].includes(faultPhase), `A101_FAULT_PHASE only accepts after-api-write, got ${JSON.stringify(faultPhase)}`);

const baselineProductSnapshot = productSnapshot();
assert(baselineProductSnapshot.code === productCode, `A101 product snapshot must resolve ${productCode}`);
assert(baselineProductSnapshot.auditStatus === "AUDITED", `A101 product ${productCode} must be audited`);
assert(baselineProductSnapshot.enabled === true, `A101 product ${productCode} must be enabled`);
assert(baselineProductSnapshot.isInventory === true, `A101 product ${productCode} must be inventory-enabled`);
assert(/^[0-9a-f]{64}$/.test(String(baselineProductSnapshot.rowDigest ?? "")), "A101 product row digest must be SHA-256");

const coordinates = fixtureCoordinates();
assert(coordinates.productIds.length === 1, `A101 requires exactly one public product ${productCode}, got ${JSON.stringify(coordinates.productIds)}`);
assert(coordinates.warehouseIds.length === 0, `A101 unique warehouse id/code must be unused before fixture write, got ${JSON.stringify(coordinates.warehouseIds)}`);
assert(coordinates.balanceIds.length === 0, `A101 unique balance id/warehouse must be unused before fixture write, got ${JSON.stringify(coordinates.balanceIds)}`);
const [productId] = coordinates.productIds;
assertUuid(productId, `A101 product ${productCode}`);
assert(productId === baselineProductSnapshot.id, `A101 product id must match the baseline snapshot: ${JSON.stringify({ productId, baselineProductSnapshot })}`);
const accountSetId = session.tenant.id;
const referenceColumns = warehouseReferenceColumns();
const unsupportedReferenceColumns = referenceColumns.filter((reference) =>
  reference.schemaName !== "public"
  || reference.targetSchemaName !== "public"
  || reference.targetTableName !== "md_warehouse"
  || reference.targetColumnName !== "id"
  || reference.deleteAction !== "a"
);
assert(unsupportedReferenceColumns.length === 0,
  `A101 warehouse reference inventory contains unsupported schema/target/delete semantics: ${JSON.stringify(unsupportedReferenceColumns)}`);
assert(referenceColumns.some((reference) => reference.tableName === "inv_safety_stock_setting" && reference.columnName === "warehouse_id"),
  `A101 warehouse reference inventory must include inv_safety_stock_setting.warehouse_id, got ${JSON.stringify(referenceColumns)}`);
assert(referenceColumns.some((reference) => reference.tableName === "inv_stock_balance" && reference.columnName === "warehouse_id"),
  `A101 warehouse reference inventory must include inv_stock_balance.warehouse_id, got ${JSON.stringify(referenceColumns)}`);

const baselineSnapshot = null;
let fixtureSnapshots = { warehouse: null, balance: null };
let availableQty = null;
let targetSafetyQty = null;
let targetMaxQty = null;

let browser = null;
const screenshots = [];
let lowRow = null;
let expectedCurrentSnapshot = baselineSnapshot;
let mutationObserved = false;
let ownedSettingId = null;
let pendingMutation = null;
let primaryError = null;
let cleanupError = null;
let restoredProductSnapshot = null;
const cleanupErrors = [];
const cleanup = {
  attempted: false,
  passed: false,
  baseline: baselineSnapshot,
  expectedCurrent: null,
  ownershipReconciliation: null,
  restored: null,
  fixtureSnapshots: null,
  productSnapshot: {
    baseline: baselineProductSnapshot,
    restored: null
  },
  residue: null
};

try {
  fixtureSnapshots = createFixture(accountSetId, productId);
  cleanup.fixtureSnapshots = fixtureSnapshots;
  assert(fixtureSnapshots.warehouse?.id === warehouseId
    && fixtureSnapshots.warehouse?.code === warehouseCode
    && fixtureSnapshots.warehouse?.name === warehouseName
    && fixtureSnapshots.warehouse?.remark === fixtureKey
    && fixtureSnapshots.warehouse?.enabled === true
    && fixtureSnapshots.warehouse?.audit_status === "AUDITED",
  `A101 created warehouse snapshot does not match known fixture identity: ${JSON.stringify(fixtureSnapshots.warehouse)}`);
  assert(fixtureSnapshots.balance?.id === balanceId
    && fixtureSnapshots.balance?.account_set_id === accountSetId
    && fixtureSnapshots.balance?.product_id === productId
    && fixtureSnapshots.balance?.warehouse_id === warehouseId
    && Number(fixtureSnapshots.balance?.qty_on_hand) === fixtureQty
    && Number(fixtureSnapshots.balance?.qty_available) === fixtureQty
    && Number(fixtureSnapshots.balance?.qty_reserved) === 0,
  `A101 created balance snapshot does not match known fixture identity: ${JSON.stringify(fixtureSnapshots.balance)}`);

  const afterCreateCoordinates = fixtureCoordinates();
  assert(same(afterCreateCoordinates.warehouseIds, [warehouseId]), `A101 unique warehouse set mismatch after creation: ${JSON.stringify(afterCreateCoordinates.warehouseIds)}`);
  assert(same(afterCreateCoordinates.balanceIds, [balanceId]), `A101 unique balance set mismatch after creation: ${JSON.stringify(afterCreateCoordinates.balanceIds)}`);
  assert(settingSnapshot(productId, warehouseId) == null, `A101 unique product/warehouse coordinate must start without a setting`);

  const settingsBefore = await api("/api/inventory/stock-alert-settings");
  const matchingSettingsBefore = settingsBefore.filter((setting) => setting.productCode === productCode && setting.warehouseCode === warehouseCode);
  assert(matchingSettingsBefore.length === 0, `A101 API baseline must not contain ${productCode}/${warehouseCode}, got ${JSON.stringify(matchingSettingsBefore)}`);

  const warehouseList = await api(`/api/lists/warehouse-master-list?keyword=${encodeURIComponent(warehouseCode)}&status=&page=1&pageSize=200`);
  const warehouseListRow = warehouseList.rows.find((row) => row.code === warehouseCode);
  assert(warehouseListRow?.name === warehouseName, `A101 unique warehouse should be visible by exact code/name, got ${JSON.stringify(warehouseListRow)}`);
  const inventoryList = await api(`/api/lists/inventory-query-list?keyword=${encodeURIComponent(productCode)}&status=&page=1&pageSize=200`);
  const inventoryRow = inventoryList.rows.find((row) => row.code === productCode && row.warehouse === warehouseName);
  assert(inventoryRow, `${productCode} ${warehouseName} should exist in inventory list`);
  availableQty = Number(inventoryRow.available);
  assert(availableQty === fixtureQty && Number(inventoryRow.onHand) === fixtureQty,
    `A101 unique balance should expose on-hand/available ${fixtureQty}, got ${JSON.stringify(inventoryRow)}`);
  targetSafetyQty = availableQty + 1;
  targetMaxQty = targetSafetyQty + 100;

  pendingMutation = {
    label: "A101 API upsert",
    previousSnapshot: expectedCurrentSnapshot,
    expectedSettingId: null
  };
  const upsertedSetting = await api("/api/inventory/stock-alert-settings", {
    method: "PUT",
    body: {
      productCode,
      warehouseCode,
      safetyQty: targetSafetyQty,
      maxQty: targetMaxQty
    }
  });
  assertUuid(upsertedSetting.id, "A101 API upsert response setting id");
  pendingMutation.expectedSettingId = upsertedSetting.id;
  const afterApiSnapshot = settingSnapshot(productId, warehouseId);
  expectedCurrentSnapshot = assertOwnedMutation(
    baselineSnapshot,
    afterApiSnapshot,
    productId,
    warehouseId,
    "A101 API upsert",
    upsertedSetting.id
  );
  ownedSettingId = upsertedSetting.id;
  mutationObserved = true;
  if (faultPhase === "after-api-write") {
    throw new Error("A101 intentional fault injection after API write response");
  }
  pendingMutation = null;

  const alertList = await api(`/api/lists/stock-alert-list?keyword=${encodeURIComponent(productCode)}&status=&page=1&pageSize=200`);
  lowRow = alertList.rows.find((row) => row.productCode === productCode && row.warehouseName === warehouseName);
  assert(lowRow, `${productCode} ${warehouseName} should appear in stock alert list`);
  assert(lowRow.status === "低于安全库存", `${productCode} stock alert status should be 低于安全库存, got ${lowRow.status}`);
  assert(Number(lowRow.available) < Number(lowRow.safetyQty), "available qty should be lower than safety qty");

  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1366, height: 768 } });
  await page.goto(frontendUrl, { waitUntil: "networkidle" });
  await loginAsAdmin(page);
  await page.getByTestId("module-库存管理").hover();
  await page.getByTestId("query-stock-alert-list").click();
  await page.getByTestId("tab-stock-alert-list").waitFor({ state: "visible" });
  await page.getByTestId("list-keyword").fill(productCode);
  await page.getByTestId("list-keyword").press("Enter");
  const row = page.locator(".vxe-body--row", { hasText: warehouseName }).filter({ hasText: productCode }).first();
  await row.waitFor({ state: "visible" });
  await page.locator(".vxe-table--body-wrapper.body--wrapper").evaluate((element) => { element.scrollLeft = element.scrollWidth; });
  await page.waitForTimeout(200);
  const rowText = await row.innerText();
  assert(rowText.includes(warehouseName) && rowText.includes("低于安全库存"), `frontend list should show this run's low safety stock row, got row text: ${rowText}`);
  const listShot = `a101-stock-alert-list-${batch}-${runToken}.png`;
  await page.screenshot({ path: path.join(screenshotDir, listShot), fullPage: true });
  screenshots.push(`verification/playwright/${listShot}`);

  await page.getByTestId("stock-alert-settings").click();
  await page.getByTestId("stock-alert-settings-dialog").waitFor({ state: "visible" });
  await page.getByTestId(`stock-alert-edit-${productCode}-${warehouseCode}`).click();
  await page.getByTestId("stock-alert-safety-qty").fill(String(targetSafetyQty));
  await page.getByTestId("stock-alert-max-qty").fill(String(targetMaxQty));
  pendingMutation = {
    label: "A101 UI save",
    previousSnapshot: expectedCurrentSnapshot,
    expectedSettingId: ownedSettingId
  };
  await page.getByTestId("stock-alert-save").click();
  await page.getByTestId("stock-alert-settings-message").waitFor({ state: "visible" });
  assert((await page.getByTestId("stock-alert-settings-message").innerText()).includes("已保存"), "stock alert setting should save from dialog");
  const afterUiSnapshot = settingSnapshot(productId, warehouseId);
  expectedCurrentSnapshot = assertOwnedMutation(
    expectedCurrentSnapshot,
    afterUiSnapshot,
    productId,
    warehouseId,
    "A101 UI save",
    ownedSettingId
  );
  mutationObserved = true;
  pendingMutation = null;
  const settingsShot = `a101-stock-alert-settings-${batch}-${runToken}.png`;
  await page.screenshot({ path: path.join(screenshotDir, settingsShot), fullPage: true });
  screenshots.push(`verification/playwright/${settingsShot}`);

} catch (error) {
  primaryError = error;
} finally {
  try {
    await browser?.close();
  } catch (error) {
    primaryError ??= error;
  }
  cleanup.attempted = true;
  if (pendingMutation) {
    const { label, previousSnapshot, expectedSettingId } = pendingMutation;
    let observedSnapshot;
    try {
      observedSnapshot = settingSnapshot(productId, warehouseId);
      if (same(observedSnapshot, previousSnapshot)) {
        cleanup.ownershipReconciliation = {
          label,
          claimed: false,
          reason: "write left the complete snapshot unchanged",
          previousSnapshot,
          observedSnapshot
        };
      } else {
        assertUuid(expectedSettingId, `${label} response-owned setting id`);
        expectedCurrentSnapshot = assertOwnedMutation(
          previousSnapshot,
          observedSnapshot,
          productId,
          warehouseId,
          `${label} finally reconciliation`,
          expectedSettingId
        );
        ownedSettingId = expectedSettingId;
        mutationObserved = true;
        cleanup.ownershipReconciliation = {
          label,
          claimed: true,
          previousSnapshot,
          observedSnapshot
        };
      }
    } catch (error) {
      cleanup.ownershipReconciliation = {
        label,
        claimed: false,
        reason: error.message ?? String(error),
        previousSnapshot,
        observedSnapshot
      };
    } finally {
      pendingMutation = null;
    }
  }
  cleanup.expectedCurrent = expectedCurrentSnapshot;
  const settingIds = [...new Set([ownedSettingId, expectedCurrentSnapshot?.id].filter(Boolean))];
  for (const settingId of settingIds) {
    assertUuid(settingId, "A101 owned setting id");
  }
  try {
    cleanup.restored = restoreSettingWithCas({
      productId,
      warehouseId,
      baseline: baselineSnapshot,
      expectedCurrent: expectedCurrentSnapshot,
      mutationObserved,
      ownedSettingId
    });
    cleanup.settingPassed = true;
  } catch (error) {
    cleanup.settingPassed = false;
    cleanupErrors.push(error);
  }
  try {
    cleanup.residue = cleanupFixtureWithSnapshots({
      references: referenceColumns,
      snapshots: fixtureSnapshots,
      settingIds
    });
    cleanup.fixturePassed = true;
  } catch (error) {
    cleanup.fixturePassed = false;
    cleanupErrors.push(error);
    try {
      cleanup.residue = fixtureResidue(referenceColumns, settingIds);
    } catch (residueError) {
      cleanup.residueFailure = serializeError(residueError);
      cleanupErrors.push(residueError);
    }
  }
  try {
    restoredProductSnapshot = productSnapshot();
    cleanup.productSnapshot.restored = restoredProductSnapshot;
    assert(same(restoredProductSnapshot, baselineProductSnapshot),
      `A101 shared product must remain byte-stable: ${JSON.stringify({ baselineProductSnapshot, restoredProductSnapshot })}`);
    cleanup.productPassed = true;
  } catch (error) {
    cleanup.productPassed = false;
    cleanupErrors.push(error);
  }
  cleanup.passed = cleanupErrors.length === 0;
  cleanupError = cleanupErrors.length === 0
    ? null
    : cleanupErrors.length === 1
      ? cleanupErrors[0]
      : new AggregateError(cleanupErrors, `A101 cleanup failed in ${cleanupErrors.length} guarded phases`);
}

const result = {
  ok: primaryError == null && cleanupError == null,
  batch,
  generatedAt: new Date().toISOString(),
  preconditions: {
    healthStatus: health.status,
    actorUsername: session.user?.username,
    tenantCode: session.tenant?.code,
    schemaName: session.tenant?.schemaName,
    accountSetId: session.tenant?.id,
    productAuditStatus: baselineProductSnapshot.auditStatus,
    productEnabled: baselineProductSnapshot.enabled,
    productInventoryEnabled: baselineProductSnapshot.isInventory,
    testInventoryAdjustmentApi: health.testInventoryAdjustmentApi,
    faultPhase: faultPhase || null
  },
  assertions: [
    "低于安全库存出现在库存预警列表",
    "库存预警列表直查 inv_stock_balance + 安全库存配置",
    "安全库存阈值配置入口可打开并保存",
    "本轮唯一仓库与余额坐标隔离并发写入",
    "安全库存设置以完整快照 CAS 删除，仓库与余额以完整 to_jsonb 快照锁表清理",
    "canonical 商品只读使用且完整行 digest 保持不变"
  ],
  fixture: {
    fixtureKey,
    productCode,
    productId,
    warehouseCode,
    warehouseName,
    warehouseId,
    balanceId,
    accountSetId,
    fixtureQty,
    availableQty,
    runToken,
    targetSafetyQty,
    targetMaxQty
  },
  lowRow,
  snapshots: {
    product: {
      baseline: baselineProductSnapshot,
      restored: restoredProductSnapshot
    },
    baseline: baselineSnapshot,
    expectedCurrent: expectedCurrentSnapshot,
    fixture: fixtureSnapshots
  },
  screenshots,
  cleanup,
  failure: serializeError(primaryError),
  cleanupFailure: serializeError(cleanupError)
};

await writeFile(resultPath, JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));

if (primaryError) throw primaryError;
if (cleanupError) throw cleanupError;
