import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { installApiSession, regressionAdminIdentity } from "./helpers/regression-auth.mjs";

const rootDir = path.resolve(import.meta.dirname, "..");
const faultPhase = process.env.A32_FAULT_PHASE ?? "";
const resultPath = path.join(rootDir, faultPhase
  ? "verification/a32-line-remark-output-regression-fault.json"
  : "verification/a32-line-remark-output-regression.json");
const apiBase = "http://127.0.0.1:8080";
const adminIdentity = regressionAdminIdentity();
const runId = randomUUID();
const runToken = runId.replaceAll("-", "").slice(0, 12).toUpperCase();
const fixtureKey = `A32-${runToken}`;
const department = `A32回归-${runToken}`;
const firstRemark = `零值原因：样品（单价为 0） [${fixtureKey}]`;
const secondRemark = `零值原因：补录（数量为 0） [${fixtureKey}]`;
const thirdRemark = `正常金额行 [${fixtureKey}]`;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const artifact = {
  id: "",
  billNo: "",
  response: null,
  initialSnapshot: null,
  cleanupSnapshot: null
};

const result = {
  ok: false,
  runId,
  runToken,
  fixtureKey,
  generatedAt: new Date().toISOString(),
  environment: {},
  order: null,
  checks: {},
  snapshots: [],
  fault: { requested: faultPhase || null, reached: false, injected: false },
  cleanup: {
    attempted: false,
    deleted: null,
    logoutStatus: null,
    residue: null,
    errors: []
  },
  failure: null
};

let primaryError = null;
let sessionInstalled = false;

await mkdir(path.dirname(resultPath), { recursive: true });

function assert(condition, message, details = undefined) {
  if (!condition) {
    throw new Error(details === undefined ? message : `${message}: ${JSON.stringify(details)}`);
  }
}

function assertUuid(value, label) {
  assert(uuidPattern.test(String(value ?? "")), `${label} must be a UUID`, value);
}

function sqlLiteral(value) {
  if (value === null || value === undefined) return "NULL";
  return `'${String(value).replaceAll("'", "''")}'`;
}

function uuidArray(values) {
  const ids = [...new Set(values.filter((value) => uuidPattern.test(String(value))).map(String))];
  return ids.length
    ? `ARRAY[${ids.map((value) => `${sqlLiteral(value)}::uuid`).join(", ")}]::uuid[]`
    : "ARRAY[]::uuid[]";
}

function psql(sql) {
  return execFileSync("docker", [
    "exec", "jdy-erp-postgres", "psql", "-X", "-v", "ON_ERROR_STOP=1", "-qAt",
    "-U", "jdy", "-d", "jdy_erp", "-c", sql
  ], { encoding: "utf8" }).trim();
}

function dbJson(sql) {
  const raw = psql(sql);
  if (!raw || raw === "null") return null;
  return JSON.parse(raw);
}

function dbNumber(sql) {
  return Number(psql(sql) || "0");
}

function canonicalJson(value) {
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalJson(value[key])]));
  }
  return value;
}

function jsonEqual(left, right) {
  return JSON.stringify(canonicalJson(left)) === JSON.stringify(canonicalJson(right));
}

function digest(value) {
  return createHash("sha256").update(JSON.stringify(canonicalJson(value))).digest("hex");
}

function errorText(error) {
  return error instanceof Error ? error.message : String(error);
}

async function request(pathname, options = {}) {
  const response = await fetch(`${apiBase}${pathname}`, {
    method: options.method ?? "GET",
    headers: options.body ? { "Content-Type": "application/json" } : undefined,
    body: options.body ? JSON.stringify(options.body) : undefined
  });
  const text = await response.text();
  return { ok: response.ok, status: response.status, text };
}

async function requireJson(pathname, options = {}) {
  const response = await request(pathname, options);
  if (!response.ok) {
    throw new Error(`${options.method ?? "GET"} ${pathname} failed ${response.status}: ${response.text}`);
  }
  return response.text ? JSON.parse(response.text) : {};
}

async function requireText(pathname, options = {}) {
  const response = await request(pathname, options);
  if (!response.ok) {
    throw new Error(`${options.method ?? "GET"} ${pathname} failed ${response.status}: ${response.text}`);
  }
  return response.text;
}

function assertIncludes(name, text, expected) {
  assert(text.includes(expected), `${name} expected to include ${expected}`);
}

function fixtureResidue() {
  const idPredicate = artifact.id ? `id=${sqlLiteral(artifact.id)}::uuid` : "FALSE";
  const billPredicate = artifact.billNo ? `bill_no=${sqlLiteral(artifact.billNo)}` : "FALSE";
  const orderIdPredicate = artifact.id ? `order_id=${sqlLiteral(artifact.id)}::uuid` : "FALSE";
  const sourceIdPredicate = artifact.id ? `source_bill_id=${sqlLiteral(artifact.id)}::uuid` : "FALSE";
  const sourceBillPredicate = artifact.billNo ? `source_order_no=${sqlLiteral(artifact.billNo)}` : "FALSE";
  const lockPredicate = artifact.billNo ? `bill_no=${sqlLiteral(artifact.billNo)}` : "FALSE";
  return dbJson(`
    SELECT jsonb_build_object(
      'headers', (SELECT count(*) FROM public.sales_order WHERE ${idPredicate} OR ${billPredicate} OR remark=${sqlLiteral(fixtureKey)}),
      'lines', (SELECT count(*) FROM public.sales_order_line WHERE ${orderIdPredicate} OR line_remark LIKE ${sqlLiteral(`%${fixtureKey}%`)}),
      'locks', (SELECT count(*) FROM public.doc_edit_lock WHERE ${lockPredicate}),
      'deliveryNoticeLines', (SELECT count(*) FROM public.delivery_notice_line WHERE ${sourceBillPredicate}),
      'salesOutHeaders', (SELECT count(*) FROM public.sales_out WHERE ${artifact.id ? `source_order_id=${sqlLiteral(artifact.id)}::uuid` : "FALSE"}),
      'salesOutLines', (SELECT count(*) FROM public.sales_out_line WHERE ${sourceBillPredicate}),
      'salesOrderSourceLines', (SELECT count(*) FROM public.sales_order_line WHERE ${sourceBillPredicate}),
      'inventoryTransactions', (SELECT count(*) FROM public.inv_stock_txn WHERE ${sourceIdPredicate}),
      'outboxEvents', (SELECT count(*) FROM public.sys_outbox_event WHERE ${artifact.id ? `aggregate_id=${sqlLiteral(artifact.id)}::uuid` : "FALSE"}),
      'operationLogs', (SELECT count(*) FROM public.sys_operation_log WHERE ${artifact.id ? `target_id=${sqlLiteral(artifact.id)}::uuid` : "FALSE"} OR ${artifact.billNo ? `target_no=${sqlLiteral(artifact.billNo)}` : "FALSE"})
    )::text
  `);
}

function captureSnapshot(phase) {
  assertUuid(artifact.id, "A32 captured sales-order id");
  assert(artifact.billNo.length > 0, "A32 captured sales-order bill number is required");
  const snapshot = dbJson(`
    SELECT jsonb_build_object(
      'headers', COALESCE((
        SELECT jsonb_agg(to_jsonb(header_row) ORDER BY header_row.id)
        FROM public.sales_order header_row
        WHERE header_row.id=${sqlLiteral(artifact.id)}::uuid
           OR header_row.bill_no=${sqlLiteral(artifact.billNo)}
           OR header_row.remark=${sqlLiteral(fixtureKey)}
      ), '[]'::jsonb),
      'lines', COALESCE((
        SELECT jsonb_agg(to_jsonb(line_row) ORDER BY line_row.line_no, line_row.id)
        FROM public.sales_order_line line_row
        WHERE line_row.order_id=${sqlLiteral(artifact.id)}::uuid
           OR line_row.line_remark LIKE ${sqlLiteral(`%${fixtureKey}%`)}
      ), '[]'::jsonb),
      'locks', COALESCE((
        SELECT jsonb_agg(to_jsonb(lock_row) ORDER BY lock_row.document_type, lock_row.bill_no)
        FROM public.doc_edit_lock lock_row
        WHERE lock_row.bill_no=${sqlLiteral(artifact.billNo)}
      ), '[]'::jsonb),
      'relatedLogs', COALESCE((
        SELECT jsonb_agg(to_jsonb(log_row) ORDER BY log_row.id)
        FROM public.sys_operation_log log_row
        WHERE log_row.target_id=${sqlLiteral(artifact.id)}::uuid
           OR log_row.target_no=${sqlLiteral(artifact.billNo)}
      ), '[]'::jsonb),
      'downstream', jsonb_build_object(
        'deliveryNoticeLines', (SELECT count(*) FROM public.delivery_notice_line WHERE source_order_no=${sqlLiteral(artifact.billNo)}),
        'salesOutHeaders', (SELECT count(*) FROM public.sales_out WHERE source_order_id=${sqlLiteral(artifact.id)}::uuid),
        'salesOutLines', (SELECT count(*) FROM public.sales_out_line WHERE source_order_no=${sqlLiteral(artifact.billNo)}),
        'salesOrderSourceLines', (SELECT count(*) FROM public.sales_order_line WHERE source_order_no=${sqlLiteral(artifact.billNo)}),
        'inventoryTransactions', (SELECT count(*) FROM public.inv_stock_txn WHERE source_bill_id=${sqlLiteral(artifact.id)}::uuid),
        'outboxEvents', (SELECT count(*) FROM public.sys_outbox_event WHERE aggregate_id=${sqlLiteral(artifact.id)}::uuid)
      )
    )::text
  `);
  assert(snapshot?.headers?.length === 1, "A32 snapshot requires exactly one response-owned header", snapshot?.headers);
  const header = snapshot.headers[0];
  assert(header.id === artifact.id
    && header.bill_no === artifact.billNo
    && header.remark === fixtureKey
    && header.department === department
    && header.status === "DRAFT"
    && Number(header.version) === 0,
  "A32 response-owned header semantic identity changed", header);
  assert(snapshot.lines.length === 3
    && snapshot.lines.every((line) => line.order_id === artifact.id)
    && snapshot.lines.map((line) => Number(line.line_no)).join(",") === "1,2,3",
  "A32 snapshot requires the exact three response-owned lines", snapshot.lines);
  const remarks = snapshot.lines.map((line) => line.line_remark);
  assert(remarks.includes(firstRemark) && remarks.includes(secondRemark) && remarks.includes(thirdRemark),
    "A32 response-owned line remarks changed", remarks);
  assert(snapshot.relatedLogs.length === 0, "A32 refuses to claim or delete unexpected operation logs", snapshot.relatedLogs);
  assert(snapshot.locks.length === 0, "A32 non-browser scenario must not own a document lock", snapshot.locks);
  assert(Object.values(snapshot.downstream).every((value) => Number(value) === 0),
    "A32 draft fixture unexpectedly has downstream facts", snapshot.downstream);
  if (artifact.initialSnapshot) {
    assert(jsonEqual(snapshot.headers, artifact.initialSnapshot.headers)
      && jsonEqual(snapshot.lines, artifact.initialSnapshot.lines),
    "A32 header/line snapshot changed after read-only output checks");
  }
  result.snapshots.push({
    phase,
    sha256: digest(snapshot),
    headerId: header.id,
    billNo: header.bill_no,
    lineIds: snapshot.lines.map((line) => line.id),
    lockCount: snapshot.locks.length,
    relatedLogCount: snapshot.relatedLogs.length
  });
  return snapshot;
}

function cleanupFixture(snapshot) {
  assert(snapshot, "A32 cleanup requires a complete semantic snapshot");
  const header = snapshot.headers[0];
  const lineIds = snapshot.lines.map((line) => line.id);
  lineIds.forEach((id) => assertUuid(id, "A32 cleanup line id"));
  return dbJson(`
    BEGIN;
    LOCK TABLE public.sales_order,
               public.sales_order_line,
               public.delivery_notice_line,
               public.sales_out,
               public.sales_out_line,
               public.inv_stock_txn,
               public.sys_outbox_event,
               public.doc_edit_lock,
               public.sys_operation_log
      IN SHARE ROW EXCLUSIVE MODE;
    DO $a32_cleanup$
    DECLARE
      actual_header jsonb;
      actual_lines jsonb;
      actual_locks jsonb;
    BEGIN
      PERFORM 1 FROM public.sales_order
      WHERE id=${sqlLiteral(artifact.id)}::uuid AND bill_no=${sqlLiteral(artifact.billNo)}
      FOR UPDATE;
      SELECT to_jsonb(header_row) INTO actual_header
      FROM public.sales_order header_row
      WHERE header_row.id=${sqlLiteral(artifact.id)}::uuid
        AND header_row.bill_no=${sqlLiteral(artifact.billNo)};
      IF actual_header IS DISTINCT FROM ${sqlLiteral(JSON.stringify(header))}::jsonb THEN
        RAISE EXCEPTION 'A32 cleanup refused: complete header snapshot changed';
      END IF;
      IF (SELECT count(*) FROM public.sales_order
          WHERE id=${sqlLiteral(artifact.id)}::uuid
             OR bill_no=${sqlLiteral(artifact.billNo)}
             OR remark=${sqlLiteral(fixtureKey)}) <> 1 THEN
        RAISE EXCEPTION 'A32 cleanup refused: ambiguous header id, bill number, or marker';
      END IF;
      PERFORM 1 FROM public.sales_order_line
      WHERE order_id=${sqlLiteral(artifact.id)}::uuid
      ORDER BY line_no, id FOR UPDATE;
      SELECT COALESCE(jsonb_agg(to_jsonb(line_row) ORDER BY line_row.line_no, line_row.id), '[]'::jsonb)
      INTO actual_lines
      FROM public.sales_order_line line_row
      WHERE line_row.order_id=${sqlLiteral(artifact.id)}::uuid;
      IF actual_lines IS DISTINCT FROM ${sqlLiteral(JSON.stringify(snapshot.lines))}::jsonb THEN
        RAISE EXCEPTION 'A32 cleanup refused: complete line snapshot changed';
      END IF;
      SELECT COALESCE(jsonb_agg(to_jsonb(lock_row) ORDER BY lock_row.document_type, lock_row.bill_no), '[]'::jsonb)
      INTO actual_locks
      FROM public.doc_edit_lock lock_row
      WHERE lock_row.bill_no=${sqlLiteral(artifact.billNo)};
      IF actual_locks IS DISTINCT FROM ${sqlLiteral(JSON.stringify(snapshot.locks))}::jsonb THEN
        RAISE EXCEPTION 'A32 cleanup refused: document-lock snapshot changed';
      END IF;
      IF EXISTS (SELECT 1 FROM public.delivery_notice_line WHERE source_order_no=${sqlLiteral(artifact.billNo)})
         OR EXISTS (SELECT 1 FROM public.sales_out WHERE source_order_id=${sqlLiteral(artifact.id)}::uuid)
         OR EXISTS (SELECT 1 FROM public.sales_out_line WHERE source_order_no=${sqlLiteral(artifact.billNo)})
         OR EXISTS (SELECT 1 FROM public.sales_order_line WHERE source_order_no=${sqlLiteral(artifact.billNo)})
         OR EXISTS (SELECT 1 FROM public.inv_stock_txn WHERE source_bill_id=${sqlLiteral(artifact.id)}::uuid)
         OR EXISTS (SELECT 1 FROM public.sys_outbox_event WHERE aggregate_id=${sqlLiteral(artifact.id)}::uuid)
         OR EXISTS (SELECT 1 FROM public.sys_operation_log WHERE target_id=${sqlLiteral(artifact.id)}::uuid OR target_no=${sqlLiteral(artifact.billNo)}) THEN
        RAISE EXCEPTION 'A32 cleanup refused: response-owned draft gained downstream or audit facts';
      END IF;
    END;
    $a32_cleanup$;
    WITH deleted_locks AS (
      DELETE FROM public.doc_edit_lock
      WHERE document_type='salesOrder' AND bill_no=${sqlLiteral(artifact.billNo)}
      RETURNING 1
    ), deleted_lines AS (
      DELETE FROM public.sales_order_line
      WHERE order_id=${sqlLiteral(artifact.id)}::uuid
        AND id=ANY(${uuidArray(lineIds)})
      RETURNING 1
    ), deleted_header AS (
      DELETE FROM public.sales_order
      WHERE id=${sqlLiteral(artifact.id)}::uuid
        AND bill_no=${sqlLiteral(artifact.billNo)}
        AND remark=${sqlLiteral(fixtureKey)}
        AND status='DRAFT'
      RETURNING 1
    )
    SELECT jsonb_build_object(
      'locks', (SELECT count(*) FROM deleted_locks),
      'lines', (SELECT count(*) FROM deleted_lines),
      'headers', (SELECT count(*) FROM deleted_header)
    )::text;
    COMMIT;
  `);
}

async function logoutApiSession() {
  if (!sessionInstalled) return null;
  const response = await request("/api/system/logout", { method: "POST" });
  assert(response.status >= 200 && response.status < 300,
    `A32 API session logout failed ${response.status}: ${response.text}`);
  return response.status;
}

async function run() {
  assert(["", "after-create"].includes(faultPhase),
    `A32_FAULT_PHASE only accepts after-create, got ${JSON.stringify(faultPhase)}`);
  assert(new URL(apiBase).hostname === "127.0.0.1", "A32 may only write through the local API");
  await installApiSession(apiBase, "admin", "admin123", "BLD-TEST");
  sessionInstalled = true;
  const session = await requireJson("/api/system/session");
  assert(session?.authenticated === true
    && session.user?.username === adminIdentity.username
    && session.user?.roleCode === "ADMIN"
    && session.tenant?.code === "BLD-TEST"
    && session.tenant?.schemaName === "public",
  "A32 requires the exact admin/BLD-TEST/public route", session);
  const route = dbJson(`
    SELECT jsonb_build_object('accountSet', to_jsonb(account_set), 'actor', to_jsonb(actor))::text
    FROM public.sys_account_set account_set
    CROSS JOIN public.sys_user actor
    WHERE account_set.id=${sqlLiteral(session.tenant.id)}::uuid
      AND account_set.code='BLD-TEST'
      AND account_set.schema_name='public'
      AND account_set.enabled=TRUE
      AND actor.username=${sqlLiteral(adminIdentity.username)}
      AND actor.enabled=TRUE
  `);
  assert(route?.accountSet?.id === session.tenant.id && route.actor?.username === adminIdentity.username,
    "A32 database route must match the authenticated BLD-TEST/public actor", route);
  assertUuid(route.actor.id, "A32 admin actor id");
  result.environment = {
    apiBase,
    accountSet: { id: route.accountSet.id, code: route.accountSet.code, schemaName: route.accountSet.schema_name },
    actor: { id: route.actor.id, username: route.actor.username }
  };
  assert(dbNumber(`SELECT count(*) FROM public.sales_order WHERE remark=${sqlLiteral(fixtureKey)}`) === 0,
    "A32 create-only run marker must not pre-exist");
  assert(dbNumber(`SELECT count(*) FROM public.sales_order_line WHERE line_remark LIKE ${sqlLiteral(`%${fixtureKey}%`)}`) === 0,
    "A32 create-only line marker must not pre-exist");

  const created = await requireJson("/api/sales-orders/draft", {
    method: "POST",
    body: {
      customerCode: "KH-001",
      billDate: new Date().toISOString().slice(0, 10),
      department,
      remark: fixtureKey,
      currency: "CNY",
      lines: [
        { productCode: "CP-001", warehouseCode: "CK-001", qty: 1, unitPrice: 0, lineRemark: firstRemark },
        { productCode: "PJ-014", warehouseCode: "CK-002", qty: 0, unitPrice: 5, lineRemark: secondRemark },
        { productCode: "CP-T413874", warehouseCode: "CK-001", qty: 2, unitPrice: 30, lineRemark: thirdRemark }
      ]
    }
  });
  assertUuid(created?.id, "A32 sales-order create response id");
  assert(typeof created?.billNo === "string" && created.billNo.length > 0,
    "A32 sales-order create response must contain the generated bill number", created);
  artifact.id = created.id;
  artifact.billNo = created.billNo;
  artifact.response = created;
  result.order = { id: artifact.id, billNo: artifact.billNo, response: created, systemGenerated: true };
  artifact.initialSnapshot = captureSnapshot("after-create");

  if (faultPhase === "after-create") {
    result.fault.reached = true;
    result.fault.injected = true;
    throw new Error(`A32_FAULT_INJECTED_AFTER_CREATE:${runId}`);
  }

  const csv = await requireText(`/api/documents/sales-order/${encodeURIComponent(artifact.billNo)}/export.csv`);
  assertIncludes("csv header", csv, "行号,源单号,物料编码,物料名称,规格型号,仓库,数量,单价,金额,行备注");
  assertIncludes("csv first remark", csv, firstRemark);
  assertIncludes("csv second remark", csv, secondRemark);

  const html = await requireText(`/api/documents/sales-order/${encodeURIComponent(artifact.billNo)}/print.html`);
  assertIncludes("print remark column", html, "<th>行备注</th>");
  assertIncludes("print first remark", html, firstRemark);
  assertIncludes("print second remark", html, secondRemark);
  assertIncludes("print remark class", html, "class=\"remark\"");
  artifact.cleanupSnapshot = captureSnapshot("after-output-checks");

  result.checks = {
    csv: {
      hasRemarkHeader: csv.includes("行号,源单号,物料编码,物料名称,规格型号,仓库,数量,单价,金额,行备注"),
      hasFirstRemark: csv.includes(firstRemark),
      hasSecondRemark: csv.includes(secondRemark)
    },
    html: {
      hasRemarkHeader: html.includes("<th>行备注</th>"),
      hasFirstRemark: html.includes(firstRemark),
      hasSecondRemark: html.includes(secondRemark),
      hasRemarkClass: html.includes("class=\"remark\"")
    },
    csvPreview: csv.split("\n").slice(0, 10),
    htmlLength: html.length
  };
}

try {
  await run();
} catch (error) {
  primaryError = error;
  result.failure = { message: errorText(error), stack: error instanceof Error ? error.stack ?? "" : "" };
} finally {
  result.cleanup.attempted = true;
  if (artifact.id && artifact.billNo && artifact.initialSnapshot) {
    try {
      if (!artifact.cleanupSnapshot) artifact.cleanupSnapshot = captureSnapshot("before-cleanup");
      result.cleanup.deleted = cleanupFixture(artifact.cleanupSnapshot);
      assert(Number(result.cleanup.deleted?.headers) === 1, "A32 cleanup must delete exactly one header", result.cleanup.deleted);
      assert(Number(result.cleanup.deleted?.lines) === 3, "A32 cleanup must delete exactly three lines", result.cleanup.deleted);
      assert(Number(result.cleanup.deleted?.locks) === artifact.cleanupSnapshot.locks.length,
        "A32 cleanup lock count must match the complete snapshot", result.cleanup.deleted);
    } catch (error) {
      result.cleanup.errors.push(`fixture cleanup: ${errorText(error)}`);
    }
  } else if (artifact.id || artifact.billNo) {
    result.cleanup.errors.push("fixture cleanup refused: response identity is incomplete or the complete semantic snapshot was not captured");
  }
  try {
    result.cleanup.logoutStatus = await logoutApiSession();
  } catch (error) {
    result.cleanup.errors.push(`session cleanup: ${errorText(error)}`);
  }
  try {
    result.cleanup.residue = fixtureResidue();
    const nonZero = Object.entries(result.cleanup.residue).filter(([, value]) => Number(value) !== 0);
    if (nonZero.length > 0) result.cleanup.errors.push(`fixture residue remains: ${JSON.stringify(result.cleanup.residue)}`);
  } catch (error) {
    result.cleanup.errors.push(`residue verification: ${errorText(error)}`);
  }
  result.ok = primaryError === null
    && result.cleanup.errors.length === 0
    && result.cleanup.residue
    && Object.values(result.cleanup.residue).every((value) => Number(value) === 0);
  await writeFile(resultPath, JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
}

if (primaryError) {
  throw primaryError;
}
assert(result.cleanup.errors.length === 0, `A32 cleanup must be residue-free: ${result.cleanup.errors.join(" | ")}`);
assert(result.ok, "A32 line remark output regression should pass");
