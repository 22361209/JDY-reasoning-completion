import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { loginApi, regressionAdminIdentity } from "./helpers/regression-auth.mjs";

const rootDir = path.resolve(import.meta.dirname, "..");
const verificationDir = path.join(rootDir, "verification");
const resultPath = path.join(verificationDir, "a136-operation-log-actor-regression.json");
const baselinePath = path.join(verificationDir, "a136-operation-log-actor-baseline.json");
const apiBase = "http://127.0.0.1:8080";
const adminIdentity = regressionAdminIdentity();
const batch = new Date().toISOString().replace(/\D/g, "").slice(0, 14);
const token = randomBytes(5).toString("hex");
const fixtureKey = `A136_ACTOR_${batch}_${token}`;
const username = `a136actor${token}`;
const secondUsername = `a136tenant${token}`;
const displayNameBefore = `A136 操作人前 ${token}`;
const displayNameAfter = `A136 操作人后 ${token}`;
const secondDisplayName = `A136 租户操作人 ${token}`;
const oldPassword = `A136-Old-${token}!`;
const newPassword = `A136-New-${token}!`;
const secondPassword = `A136-Tenant-${token}!`;
const restoreAccountSetCode = "A119OPS-49F5546B";
const fakeBackupName = `${fixtureKey}_MISSING_BACKUP`;
const lifecycleAccountSetCodes = ["BLD-TEST", restoreAccountSetCode];
const permissionDenialTargets = {
  resetPassword: "PUT /api/system/managed-users/{username}/password",
  receipt: "POST /api/finance/receivables/{billNo}/receipt"
};
const csvFieldMapping = {
  id: "日志ID",
  operatedAt: "操作时间",
  module: "模块",
  action: "动作",
  actorType: "主体类型",
  actorUsername: "操作人账号",
  actorDisplayName: "操作时姓名",
  operator: "操作人",
  accountSetId: "账套ID",
  accountSetCode: "账套编码",
  accountSetName: "账套名称",
  targetType: "对象类型",
  targetId: "对象ID",
  targetNo: "业务单号",
  status: "状态",
  reason: "失败原因",
  beforeState: "操作前状态",
  afterState: "操作后状态"
};
const frozenLegacyBaseline = {
  generatedAt: "2026-07-12T23:35:41Z",
  public: {
    total: 130109,
    operatedByNull: 54203,
    operatedByNonNull: 75906,
    beforeStateNull: 130109,
    afterStateNull: 130109,
    accountSetBlank: 114031,
    idSha256: "13f8beeb22e50f4540c542b3a811fb87d5acd1978001ff68f55a43ac779e47c2"
  }
};

await mkdir(verificationDir, { recursive: true });
let baselineSource = "embedded A136 contract baseline";
const baseline = await readFile(baselinePath, "utf8")
  .then((content) => {
    baselineSource = "verification/a136-operation-log-actor-baseline.json";
    return JSON.parse(content);
  })
  .catch(() => frozenLegacyBaseline);
const startedAt = sqlScalar("SELECT clock_timestamp()::text");
const result = {
  batch,
  fixtureKey,
  generatedAt: new Date().toISOString(),
  startedAt,
  ok: false,
  baseline: {},
  actorChecks: {},
  scopeMatrix: [],
  parityChecks: [],
  sessionCleanup: [],
  restoreChecks: {},
  cleanup: {},
  intentionalArtifacts: {
    retainedLoginAudits: [adminIdentity.username, "warehouse", "finance"],
    reason: "Formal login audits remain until the owning suite removes its run-scoped ADMIN actor; all script-owned temporary-user and temporary-object logs are removed."
  }
};

let primaryError = null;
let fixtureUserId = "";
let secondFixtureUserId = "";
let notificationId = "";
let restoreAccountSet = null;
let backup = null;
let backupFixtureId = "";
const lifecycleFixtures = [];
const explicitFixtureLogIds = [];
const restoreFixtureLogIds = [];

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function same(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function errorText(error) {
  return error instanceof Error ? error.stack ?? error.message : String(error);
}

function sqlLiteral(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function quoteIdentifier(value) {
  const normalized = String(value);
  assert(/^[a-z_][a-z0-9_]*$/.test(normalized), `unsafe SQL identifier: ${normalized}`);
  return `"${normalized}"`;
}

function sqlScalar(statement) {
  return execFileSync(
    "docker",
    ["exec", "jdy-erp-postgres", "psql", "-X", "-U", "jdy", "-d", "jdy_erp", "-v", "ON_ERROR_STOP=1", "-tAq", "-c", statement],
    { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }
  ).trim();
}

function sqlJson(statement) {
  const raw = sqlScalar(statement);
  return raw ? JSON.parse(raw) : null;
}

function sha256(value) {
  return createHash("sha256").update(String(value).trim()).digest("hex");
}

function auditRows(schema, whereSql) {
  const table = `${quoteIdentifier(schema)}.sys_operation_log`;
  return sqlJson(`
    SELECT COALESCE(jsonb_agg(to_jsonb(row_value) ORDER BY row_value.operated_at, row_value.id), '[]'::jsonb)::text
    FROM (
      SELECT id::text AS id,
             operated_at,
             module_code AS module,
             action_code AS action,
             target_type AS "targetType",
             target_id::text AS "targetId",
             COALESCE(target_no, '') AS "targetNo",
             success,
             COALESCE(failure_reason, '') AS reason,
             operated_by::text AS "operatedBy",
             actor_type AS "actorType",
             actor_username AS "actorUsername",
             actor_display_name AS "actorDisplayName",
             account_set_id::text AS "accountSetId",
             COALESCE(account_set_code, '') AS "accountSetCode",
             COALESCE(account_set_name, '') AS "accountSetName",
             before_state AS "beforeState",
             after_state AS "afterState"
      FROM ${table}
      WHERE ${whereSql}
    ) row_value
  `);
}

async function request(cookie, pathname, options = {}) {
  const headers = new Headers(options.headers ?? {});
  if (cookie) {
    headers.set("Cookie", cookie);
  }
  if (options.body !== undefined) {
    headers.set("Content-Type", "application/json");
  }
  const response = await fetch(`${apiBase}${pathname}`, {
    method: options.method ?? "GET",
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    signal: AbortSignal.timeout(options.timeoutMs ?? 15_000)
  });
  const text = await response.text();
  let data = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = { text };
    }
  }
  return { status: response.status, ok: response.ok, data, text };
}

function expectStatus(label, response, expectedStatus) {
  result.scopeMatrix.push({ label, expectedStatus, actualStatus: response.status });
  assert(response.status === expectedStatus, `${label} should return ${expectedStatus}, got ${response.status}: ${response.text}`);
}

async function logoutCookie(label, cookie) {
  const response = await request(cookie, "/api/system/logout", { method: "POST" });
  result.sessionCleanup.push({ label, expectedStatus: 200, actualStatus: response.status });
  assert(response.status === 200, `${label} logout should return 200, got ${response.status}: ${response.text}`);
}

function parseCsv(text) {
  const source = text.replace(/^\uFEFF/, "");
  const records = [];
  let record = [];
  let field = "";
  let quoted = false;
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (quoted) {
      if (char === '"' && source[index + 1] === '"') {
        field += '"';
        index += 1;
      } else if (char === '"') {
        quoted = false;
      } else {
        field += char;
      }
    } else if (char === '"') {
      quoted = true;
    } else if (char === ",") {
      record.push(field);
      field = "";
    } else if (char === "\n") {
      record.push(field.replace(/\r$/, ""));
      if (record.some((value) => value !== "")) {
        records.push(record);
      }
      record = [];
      field = "";
    } else {
      field += char;
    }
  }
  if (field || record.length) {
    record.push(field.replace(/\r$/, ""));
    records.push(record);
  }
  const [headers = [], ...rows] = records;
  return rows.map((values) => Object.fromEntries(headers.map((header, index) => [header, values[index] ?? ""])));
}

function parseCsvColumn(text, headerName) {
  const source = text.replace(/^\uFEFF/, "");
  const values = [];
  let headers = null;
  let targetIndex = -1;
  let record = [];
  let field = "";
  let quoted = false;
  const finishRecord = () => {
    record.push(field.replace(/\r$/, ""));
    if (headers == null) {
      headers = record;
      targetIndex = headers.indexOf(headerName);
      assert(targetIndex >= 0, `CSV is missing required column ${headerName}: ${JSON.stringify(headers)}`);
    } else if (record.some((value) => value !== "")) {
      values.push(record[targetIndex] ?? "");
    }
    record = [];
    field = "";
  };
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (quoted) {
      if (char === '"' && source[index + 1] === '"') {
        field += '"';
        index += 1;
      } else if (char === '"') {
        quoted = false;
      } else {
        field += char;
      }
    } else if (char === '"') {
      quoted = true;
    } else if (char === ",") {
      record.push(field);
      field = "";
    } else if (char === "\n") {
      finishRecord();
    } else {
      field += char;
    }
  }
  if (field || record.length) {
    finishRecord();
  }
  return values;
}

function csvComparable(value) {
  return value && typeof value === "object" ? JSON.stringify(value) : String(value ?? "");
}

function assertListCsvParity(listRows, csvRows, label) {
  assert(listRows.length === csvRows.length, `${label} row count mismatch: list=${listRows.length}, csv=${csvRows.length}`);
  listRows.forEach((row, index) => {
    for (const [fieldName, csvHeader] of Object.entries(csvFieldMapping)) {
      assert(
        csvComparable(row[fieldName]) === String(csvRows[index]?.[csvHeader] ?? ""),
        `${label} row ${index} ${fieldName} mismatch: list=${csvComparable(row[fieldName])}, csv=${csvRows[index]?.[csvHeader] ?? ""}`
      );
    }
  });
}

async function queryListAndCsv(cookie, scope, keyword, label, minimumRows = 1) {
  const query = new URLSearchParams({ scope, keyword, page: "1", pageSize: "1000" });
  const list = await request(cookie, `/api/lists/operation-log-list?${query}`);
  const csv = await request(cookie, `/api/lists/operation-log-list/export.csv?${query}`);
  assert(list.status === 200, `${label} list failed ${list.status}: ${list.text}`);
  assert(csv.status === 200, `${label} CSV failed ${csv.status}: ${csv.text}`);
  const listRows = list.data?.rows ?? [];
  const csvRows = parseCsv(csv.text);
  assert(listRows.length >= minimumRows, `${label} should return at least ${minimumRows} rows, got ${listRows.length}`);
  assertListCsvParity(listRows, csvRows, label);
  result.parityChecks.push({
    label,
    scope,
    keyword,
    rowCount: listRows.length,
    ids: listRows.map((row) => row.id),
    csvIds: csvRows.map((row) => row["日志ID"])
  });
  return listRows;
}

async function waitFor(predicate, label, timeoutMs = 25_000) {
  const deadline = Date.now() + timeoutMs;
  let lastValue = null;
  while (Date.now() < deadline) {
    lastValue = await predicate();
    if (lastValue) {
      return lastValue;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`${label} timed out; last=${JSON.stringify(lastValue)}`);
}

function assertUserActor(row, expectedUserId, expectedUsername, expectedDisplayName, label) {
  assert(row?.actorType === "USER", `${label} actor_type should be USER: ${JSON.stringify(row)}`);
  assert(row.operatedBy === expectedUserId, `${label} operated_by should equal ${expectedUserId}: ${JSON.stringify(row)}`);
  assert(row.actorUsername === expectedUsername, `${label} username snapshot mismatch: ${JSON.stringify(row)}`);
  assert(row.actorDisplayName === expectedDisplayName, `${label} display snapshot mismatch: ${JSON.stringify(row)}`);
}

function lifecycleAccountSets() {
  const rows = sqlJson(`
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
      'id', id::text,
      'code', code,
      'name', name,
      'schemaName', COALESCE(NULLIF(schema_name, ''), 'public')
    ) ORDER BY code), '[]'::jsonb)::text
    FROM public.sys_account_set
    WHERE code IN (${lifecycleAccountSetCodes.map(sqlLiteral).join(", ")})
  `);
  assert(rows.length === lifecycleAccountSetCodes.length, `A136 lifecycle account sets are incomplete: ${JSON.stringify(rows)}`);
  return Object.fromEntries(rows.map((row) => [row.code, row]));
}

function createLifecycleFixture(accountSet, actorUsername, actorDisplayName, suffix) {
  const schema = quoteIdentifier(accountSet.schemaName);
  const billNo = `A136PD-${batch}-${token}-${suffix}`;
  const productCode = `A136P-${token}-${suffix}`;
  const productSystemNo = 7_000_000_000_000 + Number.parseInt(token, 16) + (suffix === "PUBLIC" ? 0 : 1);
  const created = sqlJson(`
    WITH master_data AS (
      SELECT category_row.id AS category_id,
             category_row.name AS category_name,
             unit_row.id AS unit_id,
             unit_row.code AS unit_code,
             warehouse_row.id AS warehouse_id
      FROM ${schema}.md_product_category category_row
      CROSS JOIN ${schema}.md_unit unit_row
      CROSS JOIN ${schema}.md_warehouse warehouse_row
      WHERE category_row.enabled = TRUE
        AND category_row.audit_status = 'AUDITED'
        AND unit_row.enabled = TRUE
        AND unit_row.audit_status = 'AUDITED'
        AND warehouse_row.enabled = TRUE
        AND warehouse_row.audit_status = 'AUDITED'
      ORDER BY category_row.code, unit_row.code, warehouse_row.code
      LIMIT 1
    ), inserted_product AS (
      INSERT INTO ${schema}.md_product (
        system_no, code, name, spec, category, unit, enabled, audit_status, product_category_id, unit_id
      )
      SELECT ${productSystemNo},
             ${sqlLiteral(productCode)},
             ${sqlLiteral(`A136 临时物料 ${suffix}`)},
             'A136',
             master_data.category_name,
             master_data.unit_code,
             TRUE,
             'AUDITED',
             master_data.category_id,
             master_data.unit_id
      FROM master_data
      RETURNING id, code, name, spec, unit
    ), inserted_bill AS (
      INSERT INTO ${schema}.stock_count (
        bill_no, bill_date, department, document_type, business_type, status, owner_name
      )
      SELECT ${sqlLiteral(billNo)}, CURRENT_DATE, 'A136', 'STK_StockCountInput', '盘点单', 'DRAFT', ${sqlLiteral(actorDisplayName)}
      FROM inserted_product
      RETURNING id
    ), inserted_line AS (
    INSERT INTO ${schema}.stock_count_line (
      bill_id, line_no, product_id, product_code_snapshot, product_name_snapshot, product_spec_snapshot,
      product_unit_snapshot, warehouse_id, system_qty, counted_qty, diff_qty, unit_price, line_remark
    )
    SELECT inserted_bill.id,
           1,
           inserted_product.id,
           inserted_product.code,
           inserted_product.name,
           inserted_product.spec,
           inserted_product.unit,
           master_data.warehouse_id,
           0,
           0,
           0,
           0,
           ${sqlLiteral(fixtureKey)}
    FROM inserted_bill
    CROSS JOIN inserted_product
    CROSS JOIN master_data
    RETURNING bill_id
    )
    SELECT jsonb_build_object(
      'billId', inserted_bill.id::text,
      'productId', inserted_product.id::text
    )::text
    FROM inserted_bill
    CROSS JOIN inserted_product
    CROSS JOIN inserted_line
  `);
  assert(created?.billId && created?.productId, `could not create isolated lifecycle fixture in ${accountSet.code}`);
  const fixture = {
    accountSet,
    actorUsername,
    actorDisplayName,
    billId: created.billId,
    billNo,
    productId: created.productId,
    productCode,
    productSystemNo
  };
  lifecycleFixtures.push(fixture);
  return fixture;
}

async function runLifecycleActions(cookie, fixture, expectedUserId) {
  const audit = await request(cookie, `/api/stock-counts/${encodeURIComponent(fixture.billNo)}/audit`, { method: "POST" });
  assert(audit.status === 200 && audit.data?.status === "AUDITED", `${fixture.accountSet.code} lifecycle audit failed ${audit.status}: ${audit.text}`);
  assert(Number(audit.data?.gainCount ?? -1) === 0 && Number(audit.data?.lossCount ?? -1) === 0, `${fixture.accountSet.code} isolated lifecycle fixture must not create adjustment documents: ${audit.text}`);
  const reverse = await request(cookie, `/api/stock-counts/${encodeURIComponent(fixture.billNo)}/reverse`, { method: "POST" });
  assert(reverse.status === 200 && reverse.data?.status === "DRAFT", `${fixture.accountSet.code} lifecycle reverse failed ${reverse.status}: ${reverse.text}`);

  const rows = auditRows(fixture.accountSet.schemaName, `
    target_type = 'stock_count'
    AND target_id = ${sqlLiteral(fixture.billId)}::uuid
    AND target_no = ${sqlLiteral(fixture.billNo)}
    AND action_code IN ('AUDIT', 'REVERSE')
    AND operated_at >= ${sqlLiteral(startedAt)}::timestamptz
  `);
  assert(rows.length === 2, `${fixture.accountSet.code} should have exactly two successful lifecycle logs: ${JSON.stringify(rows)}`);
  const expectedTransitions = [
    { action: "AUDIT", before: "DRAFT", after: "AUDITED" },
    { action: "REVERSE", before: "AUDITED", after: "DRAFT" }
  ];
  expectedTransitions.forEach((expected) => {
    const row = rows.find((candidate) => candidate.action === expected.action);
    assert(row?.action === expected.action && row.success === true, `${fixture.accountSet.code} ${expected.action} identity/outcome mismatch: ${JSON.stringify(row)}`);
    assertUserActor(row, expectedUserId, fixture.actorUsername, fixture.actorDisplayName, `${fixture.accountSet.code} ${expected.action}`);
    assert(
      row.accountSetId === fixture.accountSet.id
        && row.accountSetCode === fixture.accountSet.code
        && row.accountSetName === fixture.accountSet.name,
      `${fixture.accountSet.code} ${expected.action} account provenance mismatch: ${JSON.stringify(row)}`
    );
    assert(row.targetType === "stock_count" && row.targetId === fixture.billId && row.targetNo === fixture.billNo, `${fixture.accountSet.code} ${expected.action} object provenance mismatch: ${JSON.stringify(row)}`);
    assert(row.beforeState?.status === expected.before && row.afterState?.status === expected.after, `${fixture.accountSet.code} ${expected.action} before/after mismatch: ${JSON.stringify(row)}`);
  });
  return rows;
}

async function verifyCompleteHistoricalScope(cookie) {
  const cutoff = sqlLiteral(baseline.generatedAt);
  const baselineIdText = sqlScalar(`
    SELECT string_agg(id::text, E'\\n' ORDER BY id)
    FROM public.sys_operation_log
    WHERE operated_at <= ${cutoff}::timestamptz
      AND account_set_id IS NULL
      AND account_set_code = ''
  `);
  const baselineIds = baselineIdText ? baselineIdText.split("\n") : [];
  assert(baselineIds.length === Number(baseline.public.accountSetBlank), `historical baseline ID count mismatch: expected ${baseline.public.accountSetBlank}, got ${baselineIds.length}`);
  const expectedIdText = sqlScalar(`
    SELECT string_agg(id::text, E'\\n' ORDER BY id)
    FROM public.sys_operation_log
    WHERE account_set_id IS NULL
      AND account_set_code = ''
  `);
  const expectedIds = expectedIdText ? expectedIdText.split("\n") : [];
  const completeIdSet = new Set(expectedIds);
  assert(baselineIds.every((id) => completeIdSet.has(id)), `historical scope is missing one or more of the ${baselineIds.length} frozen baseline IDs`);

  const pageSize = 1000;
  const listIds = [];
  const pageCount = Math.ceil(expectedIds.length / pageSize);
  for (let page = 1; page <= pageCount; page += 1) {
    const query = new URLSearchParams({
      scope: "historical",
      page: String(page),
      pageSize: String(pageSize),
      sortField: "id",
      sortOrder: "asc"
    });
    const response = await request(cookie, `/api/lists/operation-log-list?${query}`, { timeoutMs: 30_000 });
    assert(response.status === 200, `historical page ${page}/${pageCount} failed ${response.status}: ${response.text}`);
    assert(Number(response.data?.total) === expectedIds.length, `historical page ${page} total mismatch: ${response.text}`);
    const pageIds = (response.data?.rows ?? []).map((row) => row.id);
    const expectedPageIds = expectedIds.slice((page - 1) * pageSize, page * pageSize);
    assert(same(pageIds, expectedPageIds), `historical page ${page}/${pageCount} ID order/parity mismatch`);
    listIds.push(...pageIds);
  }
  assert(same(listIds, expectedIds), "paginated historical list does not expose the exact full legacy blank-account ID set in deterministic order");

  const exportQuery = new URLSearchParams({
    scope: "historical",
    pageSize: String(pageSize),
    sortField: "id",
    sortOrder: "asc"
  });
  const csv = await request(cookie, `/api/lists/operation-log-list/export.csv?${exportQuery}`, { timeoutMs: 120_000 });
  assert(csv.status === 200, `complete historical CSV failed ${csv.status}: ${csv.text.slice(0, 1_000)}`);
  const csvIds = parseCsvColumn(csv.text, "\u65e5\u5fd7ID");
  assert(same(csvIds, expectedIds), "complete historical CSV does not expose the exact full legacy blank-account ID set in deterministic order");
  assert(same(csvIds, listIds), "complete historical CSV and paginated list ID order/parity differ");

  const digest = sha256(expectedIds.join("\n"));
  const check = {
    label: "historical full legacy blank-account completeness",
    scope: "historical",
    rowCount: expectedIds.length,
    baselineRowCount: baselineIds.length,
    pageCount,
    idOrder: "id asc",
    idSha256: digest,
    baselineIdSha256: sha256(baselineIds.join("\n")),
    firstId: expectedIds[0] ?? null,
    lastId: expectedIds.at(-1) ?? null,
    baselineAllAccessible: true,
    listCsvExactIdParity: true
  };
  result.parityChecks.push(check);
  return check;
}

function legacySnapshot() {
  const cutoff = sqlLiteral(baseline.generatedAt);
  const metrics = sqlJson(`
    SELECT jsonb_build_object(
      'total', count(*),
      'operatedByNull', count(*) FILTER (WHERE operated_by IS NULL),
      'operatedByNonNull', count(*) FILTER (WHERE operated_by IS NOT NULL),
      'beforeStateNull', count(*) FILTER (WHERE before_state IS NULL),
      'afterStateNull', count(*) FILTER (WHERE after_state IS NULL),
      'accountSetBlank', count(*) FILTER (WHERE COALESCE(account_set_code, '') = ''),
      'historicalUnknown', count(*) FILTER (WHERE actor_type = 'HISTORICAL_UNKNOWN'),
      'userActor', count(*) FILTER (WHERE actor_type = 'USER')
    )::text
    FROM public.sys_operation_log
    WHERE operated_at <= ${cutoff}::timestamptz
  `);
  const ids = sqlScalar(`
    SELECT string_agg(id::text, E'\\n' ORDER BY id)
    FROM public.sys_operation_log
    WHERE operated_at <= ${cutoff}::timestamptz
  `);
  return { ...metrics, idSha256: sha256(ids) };
}

function assertLegacySnapshot(snapshot) {
  for (const field of ["total", "operatedByNull", "operatedByNonNull", "beforeStateNull", "afterStateNull", "accountSetBlank"]) {
    assert(Number(snapshot[field]) === Number(baseline.public[field]), `legacy ${field} drifted: expected ${baseline.public[field]}, got ${snapshot[field]}`);
  }
  assert(Number(snapshot.historicalUnknown) === Number(baseline.public.operatedByNull), "legacy NULL actors must map exactly to HISTORICAL_UNKNOWN");
  assert(Number(snapshot.userActor) === Number(baseline.public.operatedByNonNull), "legacy non-NULL actors must map exactly to USER");
  assert(snapshot.idSha256 === baseline.public.idSha256, `legacy ID digest drifted: expected ${baseline.public.idSha256}, got ${snapshot.idSha256}`);
}

function fixtureLogSafetyRows() {
  const fixtureUsernames = [username, secondUsername];
  const targetIds = [fixtureUserId, secondFixtureUserId, notificationId, ...lifecycleFixtures.map((fixture) => fixture.billId)].filter(Boolean);
  const targetNos = [...fixtureUsernames, ...lifecycleFixtures.map((fixture) => fixture.billNo)];
  const schemas = [...new Set(["public", ...lifecycleFixtures.map((fixture) => fixture.accountSet.schemaName)])];
  return schemas.flatMap((schema) => auditRows(schema, `
    operated_at >= ${sqlLiteral(startedAt)}::timestamptz
    AND (
      actor_username IN (${fixtureUsernames.map(sqlLiteral).join(", ")})
      OR target_no IN (${targetNos.map(sqlLiteral).join(", ")})
      ${targetIds.length > 0 ? `OR target_id IN (${targetIds.map((id) => `${sqlLiteral(id)}::uuid`).join(", ")})` : ""}
    )
  `));
}

async function cleanup() {
  const fixtureUsernames = [username, secondUsername];
  const discoveredUsers = sqlJson(`
    SELECT COALESCE(jsonb_agg(jsonb_build_object('id', id::text, 'username', username) ORDER BY username), '[]'::jsonb)::text
    FROM public.sys_user
    WHERE username IN (${fixtureUsernames.map(sqlLiteral).join(", ")})
  `);
  const discoveredUserIds = discoveredUsers.map((row) => row.id);
  const backupRows = restoreAccountSet && backupFixtureId
    ? sqlJson(`
        SELECT COALESCE(jsonb_agg(jsonb_build_object(
          'id', id::text,
          'backupName', backup_name,
          'backupSchemaName', backup_schema_name
        ) ORDER BY created_at), '[]'::jsonb)::text
        FROM public.sys_account_set_backup
        WHERE id = ${sqlLiteral(backupFixtureId)}::uuid
          AND account_set_id = ${sqlLiteral(restoreAccountSet.id)}::uuid
      `)
    : [];
  for (const row of backupRows) {
    sqlScalar(`DROP SCHEMA IF EXISTS ${quoteIdentifier(row.backupSchemaName)} CASCADE`);
  }
  if (restoreAccountSet) {
    const tenantSchema = quoteIdentifier(restoreAccountSet.schemaName);
    const discoveredRestoreLogIds = auditRows(restoreAccountSet.schemaName, `
      target_type = 'sys_account_set'
      AND target_id = ${sqlLiteral(restoreAccountSet.id)}::uuid
      AND action_code IN ('BACKUP_ACCOUNT_SET', 'RESTORE_ACCOUNT_SET')
      AND (
        after_state ->> 'backupName' = ${sqlLiteral(backup?.backupName ?? "")}
        OR before_state ->> 'backupName' = ${sqlLiteral(fakeBackupName)}
      )
    `).map((row) => row.id);
    const exactRestoreLogIds = [...new Set([...restoreFixtureLogIds, ...discoveredRestoreLogIds])];
    const restoreLogPredicate = exactRestoreLogIds.length > 0
      ? `id IN (${exactRestoreLogIds.map((id) => `${sqlLiteral(id)}::uuid`).join(", ")})`
      : "FALSE";
    const backupPredicate = backupFixtureId
      ? `id = ${sqlLiteral(backupFixtureId)}::uuid`
      : "FALSE";
    sqlScalar(`
      DELETE FROM ${tenantSchema}.sys_operation_log
      WHERE ${restoreLogPredicate};
      DELETE FROM public.sys_account_set_backup
      WHERE ${backupPredicate}
        AND account_set_id = ${sqlLiteral(restoreAccountSet.id)}::uuid;
    `);
  }

  for (const fixture of lifecycleFixtures) {
    const schema = quoteIdentifier(fixture.accountSet.schemaName);
    sqlScalar(`
      BEGIN;
      DELETE FROM ${schema}.sys_operation_log
      WHERE operated_at >= ${sqlLiteral(startedAt)}::timestamptz
        AND (
          actor_username = ${sqlLiteral(fixture.actorUsername)}
          OR target_id = ${sqlLiteral(fixture.billId)}::uuid
          OR target_no = ${sqlLiteral(fixture.billNo)}
        );
      DELETE FROM ${schema}.stock_count_line WHERE bill_id = ${sqlLiteral(fixture.billId)}::uuid;
      DELETE FROM ${schema}.stock_count WHERE id = ${sqlLiteral(fixture.billId)}::uuid;
      DELETE FROM ${schema}.md_product WHERE id = ${sqlLiteral(fixture.productId)}::uuid;
      COMMIT;
    `);
  }

  const userIdPredicate = discoveredUserIds.length > 0
    ? `IN (${discoveredUserIds.map((id) => `${sqlLiteral(id)}::uuid`).join(", ")})`
    : "IN (NULL)";
  sqlScalar(`
    BEGIN;
    CREATE TEMP TABLE a136_cleanup_notifications ON COMMIT DROP AS
    SELECT id
    FROM public.sys_notification_outbox
    WHERE recipient_username IN (${fixtureUsernames.map(sqlLiteral).join(", ")})
       OR recipient_user_id ${userIdPredicate};
    DELETE FROM public.sys_operation_log
    WHERE operated_at >= ${sqlLiteral(startedAt)}::timestamptz
      AND (
        actor_username IN (${fixtureUsernames.map(sqlLiteral).join(", ")})
        OR target_no IN (${fixtureUsernames.map(sqlLiteral).join(", ")})
        OR target_id ${userIdPredicate}
        OR target_id IN (SELECT id FROM a136_cleanup_notifications)
        ${lifecycleFixtures.length > 0 ? `OR target_id IN (${lifecycleFixtures.map((fixture) => `${sqlLiteral(fixture.billId)}::uuid`).join(", ")})` : ""}
        ${explicitFixtureLogIds.length > 0 ? `OR id IN (${explicitFixtureLogIds.map((id) => `${sqlLiteral(id)}::uuid`).join(", ")})` : ""}
      );
    DELETE FROM public.sys_notification_outbox
    WHERE id IN (SELECT id FROM a136_cleanup_notifications);
    DELETE FROM public.sys_password_reset_request
    WHERE username IN (${fixtureUsernames.map(sqlLiteral).join(", ")})
       OR requested_user_id ${userIdPredicate};
    DELETE FROM public.sys_user_account_set WHERE user_id ${userIdPredicate};
    DELETE FROM public.sys_user_role WHERE user_id ${userIdPredicate};
    DELETE FROM public.sys_user WHERE id ${userIdPredicate};
    COMMIT;
  `);

  const lifecycleObjectCountSql = lifecycleFixtures.length === 0
    ? "0"
    : lifecycleFixtures.map((fixture) => `(
        (SELECT count(*) FROM ${quoteIdentifier(fixture.accountSet.schemaName)}.stock_count WHERE id = ${sqlLiteral(fixture.billId)}::uuid)
        + (SELECT count(*) FROM ${quoteIdentifier(fixture.accountSet.schemaName)}.stock_count_line WHERE bill_id = ${sqlLiteral(fixture.billId)}::uuid)
        + (SELECT count(*) FROM ${quoteIdentifier(fixture.accountSet.schemaName)}.md_product WHERE id = ${sqlLiteral(fixture.productId)}::uuid)
      )`).join(" + ");
  const lifecycleLogCountSql = lifecycleFixtures.length === 0
    ? "0"
    : lifecycleFixtures.map((fixture) => `(SELECT count(*) FROM ${quoteIdentifier(fixture.accountSet.schemaName)}.sys_operation_log WHERE operated_at >= ${sqlLiteral(startedAt)}::timestamptz AND (actor_username = ${sqlLiteral(fixture.actorUsername)} OR target_id = ${sqlLiteral(fixture.billId)}::uuid OR target_no = ${sqlLiteral(fixture.billNo)}))`).join(" + ");
  const systemNotificationLogCountSql = notificationId
    ? `(SELECT count(*) FROM public.sys_operation_log WHERE target_id = ${sqlLiteral(notificationId)}::uuid)`
    : "0";
  const restoreLogCountSql = restoreAccountSet && restoreFixtureLogIds.length > 0
    ? `(SELECT count(*) FROM ${quoteIdentifier(restoreAccountSet.schemaName)}.sys_operation_log WHERE id IN (${restoreFixtureLogIds.map((id) => `${sqlLiteral(id)}::uuid`).join(", ")}))`
    : "0";
  const backupCountSql = backupFixtureId
    ? `(SELECT count(*) FROM public.sys_account_set_backup WHERE id = ${sqlLiteral(backupFixtureId)}::uuid)`
    : "0";
  const cleanupState = sqlJson(`
    SELECT jsonb_build_object(
      'users', (SELECT count(*) FROM public.sys_user WHERE username IN (${fixtureUsernames.map(sqlLiteral).join(", ")})),
      'notifications', (SELECT count(*) FROM public.sys_notification_outbox WHERE recipient_username IN (${fixtureUsernames.map(sqlLiteral).join(", ")})),
      'publicFixtureLogs', (SELECT count(*) FROM public.sys_operation_log WHERE operated_at >= ${sqlLiteral(startedAt)}::timestamptz AND (actor_username IN (${fixtureUsernames.map(sqlLiteral).join(", ")}) OR target_no IN (${fixtureUsernames.map(sqlLiteral).join(", ")}))),
      'lifecycleObjects', ${lifecycleObjectCountSql},
      'lifecycleLogs', ${lifecycleLogCountSql},
      'systemNotificationLogs', ${systemNotificationLogCountSql},
      'restoreLogs', ${restoreLogCountSql},
      'backups', ${backupCountSql}
    )::text
  `);
  assert(Object.values(cleanupState).every((value) => Number(value) === 0), `A136 cleanup incomplete: ${JSON.stringify(cleanupState)}`);
  result.cleanup = { ok: true, ...cleanupState, droppedBackupSchemas: backupRows.map((row) => row.backupSchemaName) };
}

try {
  const health = await request("", "/api/system/health");
  assert(health.status === 200, `health should return 200, got ${health.status}: ${health.text}`);
  const migrationState = sqlJson(`
    SELECT jsonb_build_object(
      'actorColumn', EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'sys_operation_log' AND column_name = 'actor_type'
      ),
      'targetNoColumn', EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'sys_operation_log' AND column_name = 'target_no'
      ),
      'actorOrphans', (
        SELECT count(*) FROM public.sys_operation_log log_row
        LEFT JOIN public.sys_user user_row ON user_row.id = log_row.operated_by
        WHERE log_row.operated_by IS NOT NULL AND user_row.id IS NULL
      ),
      'invalidActors', (
        SELECT count(*) FROM public.sys_operation_log
        WHERE actor_type IS NULL
           OR (actor_type = 'USER' AND (operated_by IS NULL OR COALESCE(actor_username, '') = ''))
           OR (actor_type <> 'USER' AND (operated_by IS NOT NULL OR actor_username IS NOT NULL OR actor_display_name IS NOT NULL))
      )
    )::text
  `);
  assert(migrationState.actorColumn === true && migrationState.targetNoColumn === true, `V97 columns are required: ${JSON.stringify(migrationState)}`);
  assert(Number(migrationState.actorOrphans) === 0, `operation actor orphans must be zero: ${JSON.stringify(migrationState)}`);
  assert(Number(migrationState.invalidActors) === 0, `operation actor constraints must hold: ${JSON.stringify(migrationState)}`);
  const legacyBefore = legacySnapshot();
  assertLegacySnapshot(legacyBefore);
  result.baseline = { source: baselineSource, migrationState, legacyBefore };

  const adminCookie = await loginApi(apiBase);
  const warehouseCookie = await loginApi(apiBase, "warehouse", "warehouse123", "BLD-TEST");
  const financeCookie = await loginApi(apiBase, "finance", "finance123", "BLD-TEST");
  const adminSession = await request(adminCookie, "/api/system/session");
  const warehouseSession = await request(warehouseCookie, "/api/system/session");
  const financeSession = await request(financeCookie, "/api/system/session");
  assert(adminSession.status === 200 && adminSession.data?.user?.roleCode === "ADMIN", "ADMIN session precondition failed");
  assert(warehouseSession.status === 200 && warehouseSession.data?.user?.roleCode === "WAREHOUSE", "WAREHOUSE session precondition failed");
  assert(financeSession.status === 200 && financeSession.data?.user?.roleCode === "FINANCE", "FINANCE session precondition failed");
  const adminUserId = sqlScalar(`SELECT id::text FROM public.sys_user WHERE username = ${sqlLiteral(adminIdentity.username)}`);
  const adminDisplayName = String(adminSession.data.user.name);
  assert(adminUserId && adminDisplayName, "ADMIN immutable actor fixture is incomplete");
  const accountSets = lifecycleAccountSets();

  const createUser = await request(adminCookie, "/api/system/managed-users", {
    method: "POST",
    body: {
      username,
      displayName: displayNameBefore,
      roleCode: "WAREHOUSE",
      password: oldPassword,
      enabled: true,
      accountSetCodes: ["BLD-TEST"],
      defaultAccountSetCode: "BLD-TEST"
    }
  });
  assert(createUser.status === 200, `create fixture user failed ${createUser.status}: ${createUser.text}`);
  fixtureUserId = sqlScalar(`SELECT id::text FROM public.sys_user WHERE username = ${sqlLiteral(username)}`);
  assert(fixtureUserId, "fixture user UUID was not persisted");
  const createLogs = auditRows("public", `action_code = 'CREATE_USER' AND target_id = ${sqlLiteral(fixtureUserId)}::uuid`);
  assert(createLogs.length === 1, `CREATE_USER should have one log: ${JSON.stringify(createLogs)}`);
  assertUserActor(createLogs[0], adminUserId, adminIdentity.username, adminDisplayName, "CREATE_USER");
  assert(createLogs[0].accountSetCode === "platform" && createLogs[0].targetNo === username, `CREATE_USER provenance mismatch: ${JSON.stringify(createLogs[0])}`);
  assert(createLogs[0].beforeState == null, `CREATE_USER must truthfully have no pre-existing state: ${JSON.stringify(createLogs[0])}`);
  assert(
    createLogs[0].afterState?.displayName === displayNameBefore
      && createLogs[0].afterState?.roleCode === "WAREHOUSE"
      && createLogs[0].afterState?.enabled === true,
    `CREATE_USER should carry the created user state: ${JSON.stringify(createLogs[0])}`
  );

  const createSecondUser = await request(adminCookie, "/api/system/managed-users", {
    method: "POST",
    body: {
      username: secondUsername,
      displayName: secondDisplayName,
      roleCode: "WAREHOUSE",
      password: secondPassword,
      enabled: true,
      accountSetCodes: [restoreAccountSetCode],
      defaultAccountSetCode: restoreAccountSetCode
    }
  });
  assert(createSecondUser.status === 200, `create second account-set fixture user failed ${createSecondUser.status}: ${createSecondUser.text}`);
  secondFixtureUserId = sqlScalar(`SELECT id::text FROM public.sys_user WHERE username = ${sqlLiteral(secondUsername)}`);
  assert(secondFixtureUserId && secondFixtureUserId !== fixtureUserId, "second fixture must be a distinct persisted real user");

  const publicLifecycleFixture = createLifecycleFixture(accountSets["BLD-TEST"], username, displayNameBefore, "PUBLIC");
  const tenantLifecycleFixture = createLifecycleFixture(accountSets[restoreAccountSetCode], secondUsername, secondDisplayName, "TENANT");

  const wrongLogin = await request("", "/api/system/login", {
    method: "POST",
    body: { username, password: `${oldPassword}-wrong`, accountSetCode: "BLD-TEST" }
  });
  assert(wrongLogin.status === 401, `wrong login should return 401, got ${wrongLogin.status}: ${wrongLogin.text}`);
  const anonymousLogs = auditRows("public", `
    action_code = 'LOGIN'
    AND success = FALSE
    AND actor_type = 'ANONYMOUS'
    AND target_id = ${sqlLiteral(fixtureUserId)}::uuid
    AND operated_at >= ${sqlLiteral(startedAt)}::timestamptz
  `);
  assert(anonymousLogs.length === 1, `wrong login should persist exactly one ANONYMOUS log: ${JSON.stringify(anonymousLogs)}`);
  assert(anonymousLogs[0].operatedBy == null && anonymousLogs[0].actorUsername == null && anonymousLogs[0].actorDisplayName == null, `ANONYMOUS must have no user snapshot: ${JSON.stringify(anonymousLogs[0])}`);
  assert(anonymousLogs[0].accountSetCode === "platform" && !anonymousLogs[0].reason.includes(oldPassword), `ANONYMOUS log leaked or has wrong scope: ${JSON.stringify(anonymousLogs[0])}`);

  const firstUserCookie = await loginApi(apiBase, username, oldPassword, "BLD-TEST");
  const firstLifecycleLogs = await runLifecycleActions(firstUserCookie, publicLifecycleFixture, fixtureUserId);
  const tenantFixtureCookie = await loginApi(apiBase, secondUsername, secondPassword, restoreAccountSetCode);
  const secondLifecycleLogs = await runLifecycleActions(tenantFixtureCookie, tenantLifecycleFixture, secondFixtureUserId);
  await logoutCookie("temporary tenant lifecycle user", tenantFixtureCookie);
  const passwordStateBeforeFailure = sqlJson(`
    SELECT jsonb_build_object('passwordHash', password_hash, 'version', version, 'failedLoginCount', failed_login_count)::text
    FROM public.sys_user WHERE id = ${sqlLiteral(fixtureUserId)}::uuid
  `);
  const samePasswordFailure = await request(firstUserCookie, "/api/system/password", {
    method: "PUT",
    body: { currentPassword: oldPassword, newPassword: oldPassword }
  });
  assert(samePasswordFailure.status === 400, `same-password business failure should return 400, got ${samePasswordFailure.status}: ${samePasswordFailure.text}`);
  const passwordStateAfterFailure = sqlJson(`
    SELECT jsonb_build_object('passwordHash', password_hash, 'version', version, 'failedLoginCount', failed_login_count)::text
    FROM public.sys_user WHERE id = ${sqlLiteral(fixtureUserId)}::uuid
  `);
  assert(same(passwordStateAfterFailure, passwordStateBeforeFailure), "failed own-password change must not mutate the user row");
  const businessFailureLogs = auditRows("public", `
    module_code = 'SYSTEM'
    AND action_code = 'CHANGE_OWN_PASSWORD'
    AND target_type = 'sys_user'
    AND target_id = ${sqlLiteral(fixtureUserId)}::uuid
    AND success = FALSE
    AND actor_username = ${sqlLiteral(username)}
    AND operated_at >= ${sqlLiteral(startedAt)}::timestamptz
  `);
  assert(businessFailureLogs.length === 1, `business failure should be deduplicated to one log: ${JSON.stringify(businessFailureLogs)}`);
  assert(businessFailureLogs[0].accountSetCode === "platform", `own-password failure should retain platform scope: ${JSON.stringify(businessFailureLogs[0])}`);

  await logoutCookie("temporary lifecycle user before rename", firstUserCookie);
  const updateUser = await request(adminCookie, `/api/system/managed-users/${encodeURIComponent(username)}`, {
    method: "PUT",
    body: {
      username,
      displayName: displayNameAfter,
      roleCode: "WAREHOUSE",
      enabled: true,
      accountSetCodes: ["BLD-TEST"],
      defaultAccountSetCode: "BLD-TEST"
    }
  });
  assert(updateUser.status === 200, `update fixture user failed ${updateUser.status}: ${updateUser.text}`);
  const firstLifecycleLogsAfterRename = auditRows("public", `
    target_id = ${sqlLiteral(publicLifecycleFixture.billId)}::uuid
    AND action_code IN ('AUDIT', 'REVERSE')
    AND operated_at >= ${sqlLiteral(startedAt)}::timestamptz
  `);
  assert(same(firstLifecycleLogsAfterRename.map((row) => row.id), firstLifecycleLogs.map((row) => row.id)), "renaming an actor must not replace or reorder prior lifecycle audit rows");
  firstLifecycleLogsAfterRename.forEach((row) => assertUserActor(row, fixtureUserId, username, displayNameBefore, `immutable lifecycle snapshot after ${username} rename`));
  const renamedUserCookie = await loginApi(apiBase, username, oldPassword, "BLD-TEST");
  const loginLogs = auditRows("public", `
    action_code = 'LOGIN'
    AND success = TRUE
    AND actor_type = 'USER'
    AND operated_by = ${sqlLiteral(fixtureUserId)}::uuid
    AND operated_at >= ${sqlLiteral(startedAt)}::timestamptz
  `);
  assert(loginLogs.length === 2, `fixture should have exactly two successful LOGIN logs: ${JSON.stringify(loginLogs)}`);
  assertUserActor(loginLogs[0], fixtureUserId, username, displayNameBefore, "first fixture LOGIN");
  assertUserActor(loginLogs[1], fixtureUserId, username, displayNameAfter, "second fixture LOGIN");
  assert(loginLogs[0].actorDisplayName === displayNameBefore, "old login display snapshot must remain immutable after rename");
  const changePassword = await request(renamedUserCookie, "/api/system/password", {
    method: "PUT",
    body: { currentPassword: oldPassword, newPassword }
  });
  assert(changePassword.status === 200, `successful own-password change failed ${changePassword.status}: ${changePassword.text}`);
  const ownPasswordLogs = auditRows("public", `
    action_code = 'CHANGE_OWN_PASSWORD'
    AND success = TRUE
    AND target_id = ${sqlLiteral(fixtureUserId)}::uuid
    AND operated_at >= ${sqlLiteral(startedAt)}::timestamptz
  `);
  assert(ownPasswordLogs.length === 1, `CHANGE_OWN_PASSWORD should have one log: ${JSON.stringify(ownPasswordLogs)}`);
  assertUserActor(ownPasswordLogs[0], fixtureUserId, username, displayNameAfter, "CHANGE_OWN_PASSWORD");
  assert(!JSON.stringify(ownPasswordLogs[0]).includes(oldPassword) && !JSON.stringify(ownPasswordLogs[0]).includes(newPassword), "password audit must not contain either password");

  const denialActorCookie = await loginApi(apiBase, username, newPassword, "BLD-TEST");
  const deniedPasswordReset = await request(denialActorCookie, `/api/system/managed-users/${encodeURIComponent(username)}/password`, {
    method: "PUT",
    body: { password: newPassword }
  });
  assert(deniedPasswordReset.status === 403, `WAREHOUSE reset-password denial should return 403, got ${deniedPasswordReset.status}: ${deniedPasswordReset.text}`);
  const deniedLogs = auditRows("public", `
    module_code = 'SECURITY'
    AND action_code = 'WRITE_DENIED'
    AND target_type = 'http_endpoint'
    AND success = FALSE
    AND target_no = ${sqlLiteral(permissionDenialTargets.resetPassword)}
    AND operated_at >= ${sqlLiteral(startedAt)}::timestamptz
  `);
  assert(deniedLogs.length === 1, `permission denial should be deduplicated to one log: ${JSON.stringify(deniedLogs)}`);
  explicitFixtureLogIds.push(deniedLogs[0].id);
  assertUserActor(deniedLogs[0], fixtureUserId, username, displayNameAfter, "platform WRITE_DENIED");
  assert(deniedLogs[0].accountSetCode === "platform" && deniedLogs[0].targetId == null, `platform permission denial scope/endpoint mismatch: ${JSON.stringify(deniedLogs[0])}`);
  assert(!JSON.stringify(deniedLogs[0]).includes(newPassword), "permission-denial audit must not retain the rejected request body");

  const tenantDenied = await request(denialActorCookie, `/api/finance/receivables/${encodeURIComponent(username)}/receipt`, {
    method: "POST",
    body: { date: "2026-07-13", amount: 1 }
  });
  assert(tenantDenied.status === 403, `WAREHOUSE tenant finance denial should return 403, got ${tenantDenied.status}: ${tenantDenied.text}`);
  const tenantDeniedLogs = auditRows("public", `
    module_code = 'SECURITY'
    AND action_code = 'WRITE_DENIED'
    AND target_type = 'http_endpoint'
    AND success = FALSE
    AND target_no = ${sqlLiteral(permissionDenialTargets.receipt)}
    AND operated_at >= ${sqlLiteral(startedAt)}::timestamptz
  `);
  assert(tenantDeniedLogs.length === 1, `tenant permission denial should be deduplicated to one log: ${JSON.stringify(tenantDeniedLogs)}`);
  explicitFixtureLogIds.push(tenantDeniedLogs[0].id);
  assertUserActor(tenantDeniedLogs[0], fixtureUserId, username, displayNameAfter, "tenant WRITE_DENIED");
  assert(tenantDeniedLogs[0].accountSetCode === "BLD-TEST" && tenantDeniedLogs[0].targetId == null, `tenant permission denial scope/endpoint mismatch: ${JSON.stringify(tenantDeniedLogs[0])}`);
  await logoutCookie("temporary denial actor", denialActorCookie);

  notificationId = sqlScalar(`
    INSERT INTO public.sys_notification_outbox (
      channel, template_code, recipient_user_id, recipient_username, recipient_contact,
      title, body, source_type, source_id, status, provider, retry_count, last_attempt_at, failure_reason
    ) VALUES (
      'IN_APP', ${sqlLiteral(`PASSWORD_RESET_${fixtureKey}`)}, ${sqlLiteral(fixtureUserId)}::uuid,
      ${sqlLiteral(username)}, '', ${sqlLiteral(fixtureKey)}, 'A136 SYSTEM actor regression',
      'a136_regression', ${sqlLiteral(fixtureUserId)}::uuid, 'FAILED', 'LOCAL', 0,
      now() - interval '10 seconds', 'A136 scheduled retry fixture'
    )
    RETURNING id::text
  `);
  const systemLog = await waitFor(() => {
    const rows = auditRows("public", `
      action_code = 'AUTO_RETRY_NOTIFICATION'
      AND target_id = ${sqlLiteral(notificationId)}::uuid
      AND operated_at >= ${sqlLiteral(startedAt)}::timestamptz
    `);
    return rows.length === 1 ? rows[0] : null;
  }, "SYSTEM auto-retry audit");
  assert(systemLog.actorType === "SYSTEM" && systemLog.operatedBy == null && systemLog.actorUsername == null && systemLog.actorDisplayName == null, `scheduled retry should be SYSTEM: ${JSON.stringify(systemLog)}`);
  assert(systemLog.accountSetCode === "platform" && systemLog.targetNo === notificationId, `SYSTEM provenance mismatch: ${JSON.stringify(systemLog)}`);
  assert(sqlScalar(`SELECT status FROM public.sys_notification_outbox WHERE id = ${sqlLiteral(notificationId)}::uuid`) === "SENT", "scheduled retry should transition fixture notification to SENT");

  const historicalSampleId = sqlScalar(`
    SELECT id::text
    FROM public.sys_operation_log
    WHERE operated_at <= ${sqlLiteral(baseline.generatedAt)}::timestamptz
      AND actor_type = 'HISTORICAL_UNKNOWN'
      AND operated_by IS NULL
      AND account_set_id IS NULL
      AND account_set_code = ''
    ORDER BY operated_at, id
    LIMIT 1
  `);
  const historicalRows = historicalSampleId
    ? auditRows("public", `id = ${sqlLiteral(historicalSampleId)}::uuid`)
    : [];
  assert(historicalRows.length > 0, "historical-unassigned scope requires at least one immutable legacy row");
  const historicalRow = historicalRows[0];
  assert(historicalRow.actorUsername == null && historicalRow.actorDisplayName == null, `historical actor must not be inferred: ${JSON.stringify(historicalRow)}`);

  const currentRowId = tenantDeniedLogs[0].id;
  const platformRowId = createLogs[0].id;
  const historicalRowId = historicalRow.id;
  const actors = [
    { label: "anonymous", cookie: "", statuses: { current: 401, platform: 401, historical: 401 } },
    { label: "WAREHOUSE", cookie: warehouseCookie, statuses: { current: 403, platform: 403, historical: 403 } },
    { label: "FINANCE", cookie: financeCookie, statuses: { current: 200, platform: 403, historical: 403 } },
    { label: "ADMIN", cookie: adminCookie, statuses: { current: 200, platform: 200, historical: 200 } }
  ];
  for (const actor of actors) {
    for (const scope of ["current", "platform", "historical"]) {
      const expectedStatus = actor.statuses[scope];
      const fixtureId = scope === "current" ? currentRowId : scope === "platform" ? platformRowId : historicalRowId;
      const query = new URLSearchParams({ scope, keyword: fixtureId, page: "1", pageSize: "1" });
      const listResponse = await request(actor.cookie, `/api/lists/operation-log-list?${query}`);
      const exportResponse = await request(actor.cookie, `/api/lists/operation-log-list/export.csv?${query}`);
      expectStatus(`${actor.label} ${scope} list`, listResponse, expectedStatus);
      expectStatus(`${actor.label} ${scope} export`, exportResponse, expectedStatus);
    }
  }

  const detailFixtures = [
    { scope: "current", id: currentRowId },
    { scope: "platform", id: platformRowId },
    { scope: "historical", id: historicalRowId }
  ];
  for (const fixture of detailFixtures) {
    const correctDetail = await request(adminCookie, `/api/lists/operation-log-list/rows/${fixture.id}?scope=${fixture.scope}`);
    expectStatus(`ADMIN ${fixture.scope} detail`, correctDetail, 200);
    assert(correctDetail.data?.id === fixture.id, `${fixture.scope} detail returned wrong row: ${correctDetail.text}`);
    for (const wrongScope of ["current", "platform", "historical"].filter((scope) => scope !== fixture.scope)) {
      const wrongDetail = await request(adminCookie, `/api/lists/operation-log-list/rows/${fixture.id}?scope=${wrongScope}`);
      expectStatus(`ADMIN ${fixture.scope} row via ${wrongScope} detail`, wrongDetail, 404);
    }
  }
  for (const scope of ["current", "platform", "historical"]) {
    const id = scope === "current" ? currentRowId : scope === "platform" ? platformRowId : historicalRowId;
    expectStatus(`anonymous ${scope} detail`, await request("", `/api/lists/operation-log-list/rows/${id}?scope=${scope}`), 401);
    expectStatus(`WAREHOUSE ${scope} detail`, await request(warehouseCookie, `/api/lists/operation-log-list/rows/${id}?scope=${scope}`), 403);
    expectStatus(`FINANCE ${scope} detail`, await request(financeCookie, `/api/lists/operation-log-list/rows/${id}?scope=${scope}`), scope === "current" ? 200 : 403);
  }

  const historicalCompleteness = await verifyCompleteHistoricalScope(adminCookie);
  const userRows = await queryListAndCsv(adminCookie, "platform", username, "platform USER fixture parity", 4);
  const anonymousRows = await queryListAndCsv(adminCookie, "platform", anonymousLogs[0].id, "platform ANONYMOUS parity");
  const systemRows = await queryListAndCsv(adminCookie, "platform", systemLog.id, "platform SYSTEM parity");
  const historicalParityRows = await queryListAndCsv(adminCookie, "historical", historicalRowId, "historical-unassigned parity");
  const currentRows = await queryListAndCsv(adminCookie, "current", currentRowId, "current tenant failure parity");
  assert(userRows.some((row) => row.actorType === "USER" && row.operator === `${displayNameBefore}（${username}）`), "USER list must expose immutable old display snapshot");
  assert(userRows.some((row) => row.actorType === "USER" && row.operator === `${displayNameAfter}（${username}）`), "USER list must expose current operation-time display snapshot");
  assert(anonymousRows[0].operator === "未认证请求", `ANONYMOUS display mismatch: ${JSON.stringify(anonymousRows[0])}`);
  assert(systemRows[0].operator === "系统任务", `SYSTEM display mismatch: ${JSON.stringify(systemRows[0])}`);
  assert(historicalParityRows[0].operator === "历史未知", `historical display mismatch: ${JSON.stringify(historicalParityRows[0])}`);
  assert(currentRows[0].accountSetCode === "BLD-TEST", `current row provenance mismatch: ${JSON.stringify(currentRows[0])}`);
  await logoutCookie("built-in ADMIN BLD-TEST", adminCookie);
  await logoutCookie("built-in WAREHOUSE BLD-TEST", warehouseCookie);
  await logoutCookie("built-in FINANCE BLD-TEST", financeCookie);

  const tenantAdminCookie = await loginApi(apiBase, undefined, undefined, restoreAccountSetCode);
  const tenantSession = await request(tenantAdminCookie, "/api/system/session");
  assert(tenantSession.status === 200 && tenantSession.data?.tenant?.code === restoreAccountSetCode, `tenant restore session failed: ${tenantSession.text}`);
  restoreAccountSet = {
    id: String(tenantSession.data.tenant.id),
    code: String(tenantSession.data.tenant.code),
    name: String(tenantSession.data.tenant.name),
    schemaName: String(tenantSession.data.tenant.schemaName)
  };
  assert(restoreAccountSet.schemaName !== "public", `restore regression requires a tenant schema: ${JSON.stringify(restoreAccountSet)}`);
  const backupResponse = await request(tenantAdminCookie, "/api/system/account-sets/current/backups", { method: "POST", timeoutMs: 60_000 });
  assert(backupResponse.status === 200, `tenant backup failed ${backupResponse.status}: ${backupResponse.text}`);
  backup = backupResponse.data?.backup;
  assert(backup?.backupName && backup?.backupSchemaName, `tenant backup response is incomplete: ${backupResponse.text}`);
  backupFixtureId = String(backup.id ?? "");
  assert(backupFixtureId, `tenant backup response must expose immutable backup ID: ${backupResponse.text}`);
  const backupLogsBeforeRestore = auditRows(restoreAccountSet.schemaName, `
    action_code = 'BACKUP_ACCOUNT_SET'
    AND target_id = ${sqlLiteral(restoreAccountSet.id)}::uuid
    AND target_no = ${sqlLiteral(restoreAccountSet.code)}
    AND after_state ->> 'backupName' = ${sqlLiteral(backup.backupName)}
    AND operated_at >= ${sqlLiteral(startedAt)}::timestamptz
  `);
  assert(backupLogsBeforeRestore.length === 1, `backup should append one tenant log: ${JSON.stringify(backupLogsBeforeRestore)}`);
  assertUserActor(backupLogsBeforeRestore[0], adminUserId, adminIdentity.username, adminDisplayName, "BACKUP_ACCOUNT_SET");
  assert(backupLogsBeforeRestore[0].accountSetId === restoreAccountSet.id && backupLogsBeforeRestore[0].accountSetCode === restoreAccountSet.code && backupLogsBeforeRestore[0].accountSetName === restoreAccountSet.name, `backup tenant provenance mismatch: ${JSON.stringify(backupLogsBeforeRestore[0])}`);
  const backupLogId = backupLogsBeforeRestore[0].id;
  restoreFixtureLogIds.push(backupLogId);

  const restoreResponse = await request(
    tenantAdminCookie,
    `/api/system/account-sets/current/backups/${encodeURIComponent(backup.backupName)}/restore`,
    { method: "POST", timeoutMs: 60_000 }
  );
  assert(restoreResponse.status === 200, `tenant restore failed ${restoreResponse.status}: ${restoreResponse.text}`);
  const restoreLogs = auditRows(restoreAccountSet.schemaName, `
    action_code = 'RESTORE_ACCOUNT_SET'
    AND success = TRUE
    AND target_id = ${sqlLiteral(restoreAccountSet.id)}::uuid
    AND after_state ->> 'backupName' = ${sqlLiteral(backup.backupName)}
    AND operated_at >= ${sqlLiteral(startedAt)}::timestamptz
  `);
  assert(restoreLogs.length === 1, `restore should append one success log: ${JSON.stringify(restoreLogs)}`);
  restoreFixtureLogIds.push(restoreLogs[0].id);
  const backupLogsAfterRestore = auditRows(restoreAccountSet.schemaName, `id = ${sqlLiteral(backupLogId)}::uuid`);
  assert(backupLogsAfterRestore.length === 1, "backup-created-after-snapshot audit must survive restore");

  const failedRestore = await request(
    tenantAdminCookie,
    `/api/system/account-sets/current/backups/${encodeURIComponent(fakeBackupName)}/restore`,
    { method: "POST", timeoutMs: 30_000 }
  );
  assert(failedRestore.status === 404, `missing backup restore should return 404, got ${failedRestore.status}: ${failedRestore.text}`);
  const failedRestoreLogs = await waitFor(() => {
    const rows = auditRows(restoreAccountSet.schemaName, `
      action_code = 'RESTORE_ACCOUNT_SET'
      AND success = FALSE
      AND target_id = ${sqlLiteral(restoreAccountSet.id)}::uuid
      AND before_state ->> 'backupName' = ${sqlLiteral(fakeBackupName)}
      AND operated_at >= ${sqlLiteral(startedAt)}::timestamptz
    `);
    return rows.length === 1 ? rows : null;
  }, "failed restore audit");
  assert(failedRestoreLogs.length === 1, `failed restore should be deduplicated to one log: ${JSON.stringify(failedRestoreLogs)}`);
  restoreFixtureLogIds.push(failedRestoreLogs[0].id);
  assert(auditRows(restoreAccountSet.schemaName, `id = ${sqlLiteral(backupLogId)}::uuid`).length === 1, "failed restore must not erase the preserved backup audit");
  assert(auditRows(restoreAccountSet.schemaName, `id = ${sqlLiteral(restoreLogs[0].id)}::uuid`).length === 1, "failed restore must not erase the prior restore audit");
  await logoutCookie("built-in ADMIN tenant restore", tenantAdminCookie);

  const fixtureLogs = fixtureLogSafetyRows();
  assert(fixtureLogs.length >= 9, `expected complete fixture audit evidence, got ${fixtureLogs.length}`);
  const serializedFixtureLogs = JSON.stringify(fixtureLogs).toLowerCase();
  for (const secret of [oldPassword, newPassword, secondPassword, "password_hash", "session_token", "webhook_secret"]) {
    assert(!serializedFixtureLogs.includes(secret.toLowerCase()), `fixture audit leaked forbidden secret marker: ${secret}`);
  }
  const newHistoricalUnknown = Number(sqlScalar(`
    SELECT count(*)
    FROM public.sys_operation_log
    WHERE operated_at > ${sqlLiteral(baseline.generatedAt)}::timestamptz
      AND actor_type = 'HISTORICAL_UNKNOWN'
  `));
  assert(newHistoricalUnknown === 0, `A136 must create zero new HISTORICAL_UNKNOWN rows, got ${newHistoricalUnknown}`);
  const allowedNewActorViolations = Number(sqlScalar(`
    SELECT count(*)
    FROM public.sys_operation_log
    WHERE operated_at > ${sqlLiteral(baseline.generatedAt)}::timestamptz
      AND actor_type NOT IN ('USER', 'SYSTEM', 'ANONYMOUS')
  `));
  assert(allowedNewActorViolations === 0, `new actor types must be USER/SYSTEM/ANONYMOUS only, got ${allowedNewActorViolations}`);
  const legacyAfter = legacySnapshot();
  assertLegacySnapshot(legacyAfter);
  assert(same(legacyAfter, legacyBefore), `legacy migration snapshot changed during regression: before=${JSON.stringify(legacyBefore)}, after=${JSON.stringify(legacyAfter)}`);

  result.actorChecks = {
    fixtureUserId,
    createUserLogId: createLogs[0].id,
    loginLogIds: loginLogs.map((row) => row.id),
    anonymousLogId: anonymousLogs[0].id,
    systemLogId: systemLog.id,
    historicalRowId,
    businessFailureLogId: businessFailureLogs[0].id,
    permissionDeniedLogId: deniedLogs[0].id,
    tenantPermissionDeniedLogId: tenantDeniedLogs[0].id,
    ownPasswordLogId: ownPasswordLogs[0].id,
    lifecycle: {
      actionCount: firstLifecycleLogs.length + secondLifecycleLogs.length,
      users: [fixtureUserId, secondFixtureUserId],
      accountSets: lifecycleAccountSetCodes,
      rows: [...firstLifecycleLogs, ...secondLifecycleLogs].map((row) => ({
        id: row.id,
        action: row.action,
        actorUsername: row.actorUsername,
        accountSetId: row.accountSetId,
        accountSetCode: row.accountSetCode,
        targetId: row.targetId,
        targetNo: row.targetNo,
        beforeState: row.beforeState,
        afterState: row.afterState
      }))
    },
    historicalCompleteness,
    newHistoricalUnknown,
    allowedNewActorViolations,
    legacyAfter
  };
  result.restoreChecks = {
    accountSet: restoreAccountSet,
    backupName: backup.backupName,
    backupSchemaName: backup.backupSchemaName,
    backupLogId,
    backupLogSurvivedRestore: true,
    restoreLogId: restoreLogs[0].id,
    failedRestoreLogId: failedRestoreLogs[0].id,
    failedRestoreDeduplicated: true
  };
  result.ok = true;
} catch (error) {
  primaryError = error;
  result.error = errorText(error);
} finally {
  try {
    await cleanup();
  } catch (cleanupError) {
    result.cleanup = { ok: false, error: errorText(cleanupError) };
    if (primaryError == null) {
      primaryError = cleanupError;
    } else {
      primaryError = new Error(`${errorText(primaryError)}\nCleanup failed:\n${errorText(cleanupError)}`);
    }
  }
  result.completedAt = new Date().toISOString();
  result.ok = result.ok && result.cleanup.ok === true && primaryError == null;
  await writeFile(resultPath, `${JSON.stringify(result, null, 2)}\n`);
}

if (primaryError != null) {
  throw primaryError;
}

console.log(JSON.stringify(result, null, 2));
