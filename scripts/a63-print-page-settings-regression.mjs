import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";
import { loginAsAdmin, logout, regressionAdminIdentity } from "./helpers/regression-auth.mjs";

const rootDir = path.resolve(import.meta.dirname, "..");
const verificationDir = path.join(rootDir, "verification");
const screenshotDir = path.join(verificationDir, "playwright");
const frontendUrl = "http://127.0.0.1:5173/";
const adminIdentity = regressionAdminIdentity();
const runId = randomUUID();
const runToken = runId.replaceAll("-", "").slice(0, 12).toUpperCase();
const fixtureKey = `A63-${runToken}`;
const faultPhase = process.env.A63_FAULT_PHASE ?? "";
const resultPath = path.join(verificationDir, faultPhase
  ? "a63-print-page-settings-regression-fault.json"
  : "a63-print-page-settings-regression.json");
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const customTemplate = {
  templateCode: "STANDARD",
  templateName: `A63打印参数-${runToken}`,
  roleCode: "",
  companyName: `A63模板公司-${runToken}`,
  headerNote: `A63页眉-${runToken}`,
  footerNote: `A63页脚-${runToken}`,
  showSignature: true,
  showSeal: true,
  isDefault: true,
  paperSize: "A4",
  pageOrientation: "LANDSCAPE",
  marginTopMm: "8",
  marginRightMm: "10",
  marginBottomMm: "12",
  marginLeftMm: "14",
  copyCount: 3
};
const lines = [
  { productCode: "CP-001", warehouseCode: "CK-001", qty: 2, unitPrice: 10, lineRemark: `${fixtureKey} 第一行` },
  { productCode: "PJ-014", warehouseCode: "CK-002", qty: 3, unitPrice: 6, lineRemark: `${fixtureKey} 第二行` },
  { productCode: "CP-T413874", warehouseCode: "CK-001", qty: 4, unitPrice: 12, lineRemark: `${fixtureKey} 第三行` }
];

const artifacts = {
  actorId: "",
  order: { id: "", billNo: "", initialSnapshot: null, cleanupSnapshot: null },
  template: { original: null, postMutation: null, mutationAttempted: false },
  screenshotPath: "",
  pdfWritten: false,
  loggedIn: false,
  loggedOut: false
};
const result = {
  ok: false,
  runId,
  runToken,
  fixtureKey,
  faultPhase: faultPhase || null,
  billNo: null,
  savedTemplate: null,
  pdfPath: null,
  screenshots: [],
  checks: {},
  fault: { requested: faultPhase || null, reached: false, injected: false },
  cleanup: {
    attempted: false,
    deleted: null,
    residue: null,
    templateRestored: false,
    sessionLoggedOut: false,
    filesRemovedOnFailure: [],
    errors: []
  },
  failure: null
};

let browser = null;
let page = null;
let primaryError = null;

await mkdir(screenshotDir, { recursive: true });

function assert(condition, message, details = undefined) {
  if (!condition) throw new Error(details === undefined ? message : `${message}: ${JSON.stringify(details)}`);
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
    "-U", "jdy", "-d", "jdy_erp", "-f", "-"
  ], { encoding: "utf8", input: sql }).trim();
}

function dbJson(sql) {
  const raw = psql(sql);
  if (!raw || raw === "null") return null;
  return JSON.parse(raw);
}

function dbNumber(sql) {
  return Number(psql(sql) || "0");
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  }
  return value;
}

function jsonEqual(left, right) {
  return JSON.stringify(canonical(left)) === JSON.stringify(canonical(right));
}

function utf16beHex(value) {
  let hex = "";
  for (const char of value) {
    const codePoint = char.codePointAt(0);
    if (codePoint > 0xffff) {
      const high = Math.floor((codePoint - 0x10000) / 0x400) + 0xd800;
      const low = ((codePoint - 0x10000) % 0x400) + 0xdc00;
      hex += high.toString(16).padStart(4, "0") + low.toString(16).padStart(4, "0");
    } else {
      hex += codePoint.toString(16).padStart(4, "0");
    }
  }
  return hex.toUpperCase();
}

async function browserFetch(pathname, options = {}) {
  return page.evaluate(async ({ pathname, options }) => {
    const response = await fetch(pathname, {
      method: options.method ?? "GET",
      headers: options.body === undefined ? undefined : { "Content-Type": "application/json" },
      body: options.body === undefined ? undefined : JSON.stringify(options.body)
    });
    return { status: response.status, ok: response.ok, text: await response.text() };
  }, { pathname, options });
}

async function browserFetchBytes(pathname) {
  return page.evaluate(async (targetPath) => {
    const response = await fetch(targetPath);
    return {
      status: response.status,
      ok: response.ok,
      contentType: response.headers.get("content-type") ?? "",
      bytes: Array.from(new Uint8Array(await response.arrayBuffer()))
    };
  }, pathname);
}

async function requireJson(pathname, options = {}) {
  const response = await browserFetch(pathname, options);
  assert(response.ok, `${options.method ?? "GET"} ${pathname} failed ${response.status}`, response.text);
  return response.text ? JSON.parse(response.text) : {};
}

async function requireText(pathname) {
  const response = await browserFetch(pathname);
  assert(response.ok, `GET ${pathname} failed ${response.status}`, response.text);
  return response.text;
}

function templateSnapshot() {
  return dbJson(`
    SELECT COALESCE(jsonb_agg(to_jsonb(template_row) ORDER BY template_row.id), '[]'::jsonb)::text
    FROM public.sys_print_template template_row
    WHERE template_row.document_type='sales-order' AND template_row.role_code IS NULL
  `) ?? [];
}

function fixtureResidue() {
  const idPredicate = artifacts.order.id ? `id=${sqlLiteral(artifacts.order.id)}::uuid` : "FALSE";
  const billPredicate = artifacts.order.billNo ? `bill_no=${sqlLiteral(artifacts.order.billNo)}` : "FALSE";
  const orderIdPredicate = artifacts.order.id ? `order_id=${sqlLiteral(artifacts.order.id)}::uuid` : "FALSE";
  const sourceIdPredicate = artifacts.order.id ? `source_bill_id=${sqlLiteral(artifacts.order.id)}::uuid` : "FALSE";
  const sourceBillPredicate = artifacts.order.billNo ? `source_order_no=${sqlLiteral(artifacts.order.billNo)}` : "FALSE";
  const lockPredicate = artifacts.order.billNo ? `bill_no=${sqlLiteral(artifacts.order.billNo)}` : "FALSE";
  return dbJson(`
    SELECT jsonb_build_object(
      'headers', (SELECT count(*) FROM public.sales_order WHERE ${idPredicate} OR ${billPredicate} OR remark=${sqlLiteral(fixtureKey)}),
      'lines', (SELECT count(*) FROM public.sales_order_line WHERE ${orderIdPredicate} OR line_remark LIKE ${sqlLiteral(`%${fixtureKey}%`)}),
      'locks', (SELECT count(*) FROM public.doc_edit_lock WHERE ${lockPredicate}),
      'deliveryNoticeLines', (SELECT count(*) FROM public.delivery_notice_line WHERE ${sourceBillPredicate}),
      'salesOutHeaders', (SELECT count(*) FROM public.sales_out WHERE ${artifacts.order.id ? `source_order_id=${sqlLiteral(artifacts.order.id)}::uuid` : "FALSE"}),
      'salesOutLines', (SELECT count(*) FROM public.sales_out_line WHERE ${sourceBillPredicate}),
      'salesOrderSourceLines', (SELECT count(*) FROM public.sales_order_line WHERE ${sourceBillPredicate}),
      'inventoryTransactions', (SELECT count(*) FROM public.inv_stock_txn WHERE ${sourceIdPredicate}),
      'outboxEvents', (SELECT count(*) FROM public.sys_outbox_event WHERE ${artifacts.order.id ? `aggregate_id=${sqlLiteral(artifacts.order.id)}::uuid` : "FALSE"}),
      'operationLogs', (SELECT count(*) FROM public.sys_operation_log WHERE ${artifacts.order.id ? `target_id=${sqlLiteral(artifacts.order.id)}::uuid` : "FALSE"} OR ${artifacts.order.billNo ? `target_no=${sqlLiteral(artifacts.order.billNo)}` : "FALSE"})
    )::text
  `);
}

function captureOrderSnapshot(phase) {
  assertUuid(artifacts.order.id, "A63 captured sales-order id");
  assertUuid(artifacts.actorId, "A63 authenticated actor id");
  assert(artifacts.order.billNo.length > 0, "A63 captured sales-order bill number is required");
  const snapshot = dbJson(`
    SELECT jsonb_build_object(
      'headers', COALESCE((
        SELECT jsonb_agg(to_jsonb(header_row) ORDER BY header_row.id)
        FROM public.sales_order header_row
        WHERE header_row.id=${sqlLiteral(artifacts.order.id)}::uuid
           OR header_row.bill_no=${sqlLiteral(artifacts.order.billNo)}
           OR header_row.remark=${sqlLiteral(fixtureKey)}
      ), '[]'::jsonb),
      'lines', COALESCE((
        SELECT jsonb_agg(to_jsonb(line_row) ORDER BY line_row.line_no, line_row.id)
        FROM public.sales_order_line line_row
        WHERE line_row.order_id=${sqlLiteral(artifacts.order.id)}::uuid
           OR line_row.line_remark LIKE ${sqlLiteral(`%${fixtureKey}%`)}
      ), '[]'::jsonb),
      'locks', COALESCE((
        SELECT jsonb_agg(to_jsonb(lock_row) ORDER BY lock_row.document_type, lock_row.bill_no)
        FROM public.doc_edit_lock lock_row
        WHERE lock_row.bill_no=${sqlLiteral(artifacts.order.billNo)}
      ), '[]'::jsonb),
      'relatedLogs', COALESCE((
        SELECT jsonb_agg(to_jsonb(log_row) ORDER BY log_row.id)
        FROM public.sys_operation_log log_row
        WHERE log_row.target_id=${sqlLiteral(artifacts.order.id)}::uuid
           OR log_row.target_no=${sqlLiteral(artifacts.order.billNo)}
      ), '[]'::jsonb),
      'downstream', jsonb_build_object(
        'deliveryNoticeLines', (SELECT count(*) FROM public.delivery_notice_line WHERE source_order_no=${sqlLiteral(artifacts.order.billNo)}),
        'salesOutHeaders', (SELECT count(*) FROM public.sales_out WHERE source_order_id=${sqlLiteral(artifacts.order.id)}::uuid),
        'salesOutLines', (SELECT count(*) FROM public.sales_out_line WHERE source_order_no=${sqlLiteral(artifacts.order.billNo)}),
        'salesOrderSourceLines', (SELECT count(*) FROM public.sales_order_line WHERE source_order_no=${sqlLiteral(artifacts.order.billNo)}),
        'inventoryTransactions', (SELECT count(*) FROM public.inv_stock_txn WHERE source_bill_id=${sqlLiteral(artifacts.order.id)}::uuid),
        'outboxEvents', (SELECT count(*) FROM public.sys_outbox_event WHERE aggregate_id=${sqlLiteral(artifacts.order.id)}::uuid)
      )
    )::text
  `);
  assert(snapshot?.headers?.length === 1, "A63 snapshot requires exactly one response-owned header", snapshot?.headers);
  const header = snapshot.headers[0];
  assert(header.id === artifacts.order.id
    && header.bill_no === artifacts.order.billNo
    && header.remark === fixtureKey
    && header.status === "DRAFT"
    && Number(header.version) === 0,
  "A63 response-owned header semantic identity changed", header);
  assert(snapshot.lines.length === 3
    && snapshot.lines.every((line) => line.order_id === artifacts.order.id)
    && snapshot.lines.map((line) => Number(line.line_no)).join(",") === "1,2,3"
    && snapshot.lines.every((line) => String(line.line_remark ?? "").includes(fixtureKey)),
  "A63 snapshot requires the exact three response-owned lines", snapshot.lines);
  assert(snapshot.locks.length === 0, "A63 never opens the order editor and refuses any document lock", snapshot.locks);
  assert(snapshot.relatedLogs.length === 0, "A63 refuses to claim or delete unexpected operation logs", snapshot.relatedLogs);
  assert(Object.values(snapshot.downstream).every((value) => Number(value) === 0),
    "A63 draft fixture unexpectedly has downstream facts", snapshot.downstream);
  if (artifacts.order.initialSnapshot) {
    assert(jsonEqual(snapshot.headers, artifacts.order.initialSnapshot.headers)
      && jsonEqual(snapshot.lines, artifacts.order.initialSnapshot.lines),
    "A63 header/line snapshot changed after read-only print checks");
  }
  result.checks[`${phase}Snapshot`] = true;
  return snapshot;
}

function withoutUpdatedAt(row) {
  const copy = { ...row };
  delete copy.updated_at;
  return copy;
}

function expectedTargetTemplate(original) {
  return {
    ...original,
    template_name: customTemplate.templateName,
    company_name: customTemplate.companyName,
    header_note: customTemplate.headerNote,
    footer_note: customTemplate.footerNote,
    show_signature: true,
    show_seal: true,
    is_default: true,
    enabled: true,
    role_code: null,
    paper_size: "A4",
    page_orientation: "LANDSCAPE",
    margin_top_mm: 8,
    margin_right_mm: 10,
    margin_bottom_mm: 12,
    margin_left_mm: 14,
    copy_count: 3
  };
}

function validateOwnedTemplateMutation(originalRows, currentRows) {
  if (jsonEqual(originalRows, currentRows)) return "unchanged";
  assert(Array.isArray(originalRows) && originalRows.length > 0, "A63 original template snapshot must be non-empty");
  assert(currentRows.length === originalRows.length, "A63 template mutation changed the role-null row count");
  const originalById = new Map(originalRows.map((row) => [row.id, row]));
  const targetRows = originalRows.filter((row) => row.template_code === "STANDARD");
  assert(targetRows.length === 1, "A63 requires exactly one existing role-null STANDARD template", targetRows);
  for (const current of currentRows) {
    const original = originalById.get(current.id);
    assert(original, "A63 template mutation introduced an unknown row", current.id);
    const expected = original.template_code === "STANDARD"
      ? expectedTargetTemplate(original)
      : { ...original, is_default: false };
    assert(jsonEqual(withoutUpdatedAt(current), withoutUpdatedAt(expected)),
      "A63 refuses to restore a template state outside its exact mutation contract", { original, current, expected });
  }
  return "owned-mutation";
}

function restoreTemplate() {
  if (!artifacts.template.original || !artifacts.template.mutationAttempted) {
    result.cleanup.templateRestored = artifacts.template.original !== null;
    return;
  }
  const current = templateSnapshot();
  const mutationState = validateOwnedTemplateMutation(artifacts.template.original, current);
  artifacts.template.postMutation ??= current;
  assert(jsonEqual(current, artifacts.template.postMutation),
    "A63 template state changed after the owned post-mutation snapshot");
  if (mutationState === "owned-mutation") {
    const originalJson = JSON.stringify(artifacts.template.original);
    const postJson = JSON.stringify(artifacts.template.postMutation);
    psql(`
      BEGIN;
      SET LOCAL lock_timeout='5s';
      SET LOCAL statement_timeout='30s';
      LOCK TABLE public.sys_print_template IN SHARE ROW EXCLUSIVE MODE;
      DO $a63_template_restore$
      DECLARE
        actual jsonb;
        restored_count integer;
      BEGIN
        SELECT COALESCE(jsonb_agg(to_jsonb(template_row) ORDER BY template_row.id), '[]'::jsonb)
          INTO actual
        FROM public.sys_print_template template_row
        WHERE template_row.document_type='sales-order' AND template_row.role_code IS NULL;
        IF actual IS DISTINCT FROM ${sqlLiteral(postJson)}::jsonb THEN
          RAISE EXCEPTION 'A63 template restore refused: post-mutation snapshot changed';
        END IF;

        WITH original_rows AS (
          SELECT * FROM jsonb_populate_recordset(NULL::public.sys_print_template, ${sqlLiteral(originalJson)}::jsonb)
        )
        UPDATE public.sys_print_template target
        SET document_type=source.document_type,
            template_code=source.template_code,
            template_name=source.template_name,
            company_name=source.company_name,
            header_note=source.header_note,
            footer_note=source.footer_note,
            show_signature=source.show_signature,
            show_seal=source.show_seal,
            is_default=source.is_default,
            enabled=source.enabled,
            created_at=source.created_at,
            updated_at=source.updated_at,
            role_code=source.role_code,
            paper_size=source.paper_size,
            page_orientation=source.page_orientation,
            margin_top_mm=source.margin_top_mm,
            margin_right_mm=source.margin_right_mm,
            margin_bottom_mm=source.margin_bottom_mm,
            margin_left_mm=source.margin_left_mm,
            copy_count=source.copy_count
        FROM original_rows source
        WHERE target.id=source.id;
        GET DIAGNOSTICS restored_count = ROW_COUNT;
        IF restored_count <> jsonb_array_length(${sqlLiteral(originalJson)}::jsonb) THEN
          RAISE EXCEPTION 'A63 template restore refused: incomplete UUID set';
        END IF;
        SELECT COALESCE(jsonb_agg(to_jsonb(template_row) ORDER BY template_row.id), '[]'::jsonb)
          INTO actual
        FROM public.sys_print_template template_row
        WHERE template_row.document_type='sales-order' AND template_row.role_code IS NULL;
        IF actual IS DISTINCT FROM ${sqlLiteral(originalJson)}::jsonb THEN
          RAISE EXCEPTION 'A63 template restore failed exact snapshot verification';
        END IF;
      END;
      $a63_template_restore$;
      COMMIT;
    `);
  }
  result.cleanup.templateRestored = jsonEqual(templateSnapshot(), artifacts.template.original);
  assert(result.cleanup.templateRestored, "A63 shared print-template snapshot must be restored exactly");
}

function cleanupOrder() {
  if (!artifacts.order.id || !artifacts.order.billNo || !artifacts.order.initialSnapshot) {
    const residue = fixtureResidue();
    assert(Object.values(residue).every((value) => Number(value) === 0),
      "A63 refuses to claim or delete a response-loss sales order; manual review is required", residue);
    return null;
  }
  const snapshot = artifacts.order.cleanupSnapshot ?? captureOrderSnapshot("before-cleanup");
  const header = snapshot.headers[0];
  const lineIds = snapshot.lines.map((line) => line.id);
  lineIds.forEach((id) => assertUuid(id, "A63 cleanup line id"));
  return dbJson(`
    BEGIN;
    SET LOCAL lock_timeout='5s';
    SET LOCAL statement_timeout='30s';
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
    DO $a63_order_cleanup$
    DECLARE
      actual_header jsonb;
      actual_lines jsonb;
      actual_locks jsonb;
    BEGIN
      PERFORM 1 FROM public.sales_order
      WHERE id=${sqlLiteral(artifacts.order.id)}::uuid AND bill_no=${sqlLiteral(artifacts.order.billNo)}
      FOR UPDATE;
      SELECT to_jsonb(header_row) INTO actual_header
      FROM public.sales_order header_row
      WHERE header_row.id=${sqlLiteral(artifacts.order.id)}::uuid
        AND header_row.bill_no=${sqlLiteral(artifacts.order.billNo)};
      IF actual_header IS DISTINCT FROM ${sqlLiteral(JSON.stringify(header))}::jsonb THEN
        RAISE EXCEPTION 'A63 order cleanup refused: complete header snapshot changed';
      END IF;
      IF (SELECT count(*) FROM public.sales_order
          WHERE id=${sqlLiteral(artifacts.order.id)}::uuid
             OR bill_no=${sqlLiteral(artifacts.order.billNo)}
             OR remark=${sqlLiteral(fixtureKey)}) <> 1 THEN
        RAISE EXCEPTION 'A63 order cleanup refused: ambiguous header id, bill number, or marker';
      END IF;
      PERFORM 1 FROM public.sales_order_line
      WHERE order_id=${sqlLiteral(artifacts.order.id)}::uuid
      ORDER BY line_no, id FOR UPDATE;
      SELECT COALESCE(jsonb_agg(to_jsonb(line_row) ORDER BY line_row.line_no, line_row.id), '[]'::jsonb)
      INTO actual_lines
      FROM public.sales_order_line line_row
      WHERE line_row.order_id=${sqlLiteral(artifacts.order.id)}::uuid;
      IF actual_lines IS DISTINCT FROM ${sqlLiteral(JSON.stringify(snapshot.lines))}::jsonb THEN
        RAISE EXCEPTION 'A63 order cleanup refused: complete line snapshot changed';
      END IF;
      PERFORM 1 FROM public.doc_edit_lock
      WHERE bill_no=${sqlLiteral(artifacts.order.billNo)}
      ORDER BY document_type FOR UPDATE;
      SELECT COALESCE(jsonb_agg(to_jsonb(lock_row) ORDER BY lock_row.document_type, lock_row.bill_no), '[]'::jsonb)
      INTO actual_locks
      FROM public.doc_edit_lock lock_row
      WHERE lock_row.bill_no=${sqlLiteral(artifacts.order.billNo)};
      IF actual_locks IS DISTINCT FROM ${sqlLiteral(JSON.stringify(snapshot.locks))}::jsonb THEN
        RAISE EXCEPTION 'A63 order cleanup refused: complete document-lock snapshot changed';
      END IF;
      IF EXISTS (SELECT 1 FROM public.delivery_notice_line WHERE source_order_no=${sqlLiteral(artifacts.order.billNo)})
         OR EXISTS (SELECT 1 FROM public.sales_out WHERE source_order_id=${sqlLiteral(artifacts.order.id)}::uuid)
         OR EXISTS (SELECT 1 FROM public.sales_out_line WHERE source_order_no=${sqlLiteral(artifacts.order.billNo)})
         OR EXISTS (SELECT 1 FROM public.sales_order_line WHERE source_order_no=${sqlLiteral(artifacts.order.billNo)})
         OR EXISTS (SELECT 1 FROM public.inv_stock_txn WHERE source_bill_id=${sqlLiteral(artifacts.order.id)}::uuid)
         OR EXISTS (SELECT 1 FROM public.sys_outbox_event WHERE aggregate_id=${sqlLiteral(artifacts.order.id)}::uuid)
         OR EXISTS (SELECT 1 FROM public.sys_operation_log WHERE target_id=${sqlLiteral(artifacts.order.id)}::uuid OR target_no=${sqlLiteral(artifacts.order.billNo)}) THEN
        RAISE EXCEPTION 'A63 order cleanup refused: response-owned draft gained downstream or audit facts';
      END IF;
    END;
    $a63_order_cleanup$;
    WITH deleted_locks AS (
      DELETE FROM public.doc_edit_lock
      WHERE document_type='salesOrder'
        AND bill_no=${sqlLiteral(artifacts.order.billNo)}
        AND holder_user_id=${sqlLiteral(artifacts.actorId)}::uuid
      RETURNING 1
    ), deleted_lines AS (
      DELETE FROM public.sales_order_line
      WHERE order_id=${sqlLiteral(artifacts.order.id)}::uuid
        AND id=ANY(${uuidArray(lineIds)})
      RETURNING 1
    ), deleted_header AS (
      DELETE FROM public.sales_order
      WHERE id=${sqlLiteral(artifacts.order.id)}::uuid
        AND bill_no=${sqlLiteral(artifacts.order.billNo)}
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

async function saveTemplateThroughUi() {
  await page.getByTestId("module-系统设置").hover();
  await page.getByTestId("entry-print-template-settings").click();
  await page.getByTestId("tab-print-template-settings").waitFor({ state: "visible" });
  await page.getByTestId("print-template-document-type").selectOption("sales-order");
  await page.getByTestId("print-template-code").selectOption("STANDARD");
  await page.getByTestId("print-template-role-code").selectOption("");
  await page.getByTestId("print-template-name").fill(customTemplate.templateName);
  await page.getByTestId("print-template-company").fill(customTemplate.companyName);
  await page.getByTestId("print-template-header-note").fill(customTemplate.headerNote);
  await page.getByTestId("print-template-footer-note").fill(customTemplate.footerNote);
  await page.getByTestId("print-template-paper-size").selectOption(customTemplate.paperSize);
  await page.getByTestId("print-template-page-orientation").selectOption(customTemplate.pageOrientation);
  await page.getByTestId("print-template-copy-count").fill(String(customTemplate.copyCount));
  await page.getByTestId("print-template-margin-top").fill(customTemplate.marginTopMm);
  await page.getByTestId("print-template-margin-right").fill(customTemplate.marginRightMm);
  await page.getByTestId("print-template-margin-bottom").fill(customTemplate.marginBottomMm);
  await page.getByTestId("print-template-margin-left").fill(customTemplate.marginLeftMm);
  artifacts.template.mutationAttempted = true;
  await page.getByTestId("print-template-save").click();
  await page.getByTestId("print-template-message").getByText("打印模板已保存").waitFor({ state: "visible" });
  artifacts.template.postMutation = templateSnapshot();
  assert(validateOwnedTemplateMutation(artifacts.template.original, artifacts.template.postMutation) === "owned-mutation",
    "A63 UI save must create the exact expected template mutation");
}

async function runScenario() {
  assert(faultPhase === "" || faultPhase === "after-template" || faultPhase === "after-create",
    "A63_FAULT_PHASE must be empty, after-template, or after-create");
  const accountSet = dbJson(`
    SELECT to_jsonb(account_set)::text FROM public.sys_account_set account_set
    WHERE account_set.code='BLD-TEST' AND account_set.schema_name='public'
  `);
  assert(accountSet?.code === "BLD-TEST" && accountSet?.schema_name === "public",
    "A63 direct cleanup is restricted to BLD-TEST/public");
  const actor = dbJson(`
    SELECT to_jsonb(actor_row)::text FROM public.sys_user actor_row
    WHERE actor_row.username=${sqlLiteral(adminIdentity.username)} AND actor_row.enabled=TRUE
  `);
  assertUuid(actor?.id, "A63 admin actor id");
  artifacts.actorId = actor.id;
  assert(dbNumber(`SELECT count(*) FROM public.sales_order WHERE remark=${sqlLiteral(fixtureKey)}`) === 0,
    "A63 run-unique sales marker must not pre-exist");
  assert(dbNumber(`SELECT count(*) FROM public.sales_order_line WHERE line_remark LIKE ${sqlLiteral(`%${fixtureKey}%`)}`) === 0,
    "A63 run-unique sales line marker must not pre-exist");
  artifacts.template.original = templateSnapshot();
  assert(artifacts.template.original.filter((row) => row.template_code === "STANDARD").length === 1,
    "A63 requires one existing role-null STANDARD template before mutation");

  browser = await chromium.launch({ headless: true });
  page = await browser.newPage({ viewport: { width: 1366, height: 768 } });
  await page.goto(frontendUrl, { waitUntil: "networkidle" });
  await loginAsAdmin(page);
  artifacts.loggedIn = true;
  const session = await requireJson("/api/system/session");
  assert(session?.authenticated === true
    && session.user?.username === adminIdentity.username
    && session.user?.roleCode === "ADMIN"
    && session.tenant?.code === "BLD-TEST"
    && session.tenant?.schemaName === "public",
  "A63 browser session must be the exact admin/BLD-TEST/public route", session);

  await saveTemplateThroughUi();
  if (faultPhase === "after-template") {
    result.fault.reached = true;
    result.fault.injected = true;
    throw new Error(`A63_FAULT_INJECTED_AFTER_TEMPLATE:${runId}`);
  }

  const screenshotName = `a63-print-page-settings-${runToken}.png`;
  artifacts.screenshotPath = path.join(screenshotDir, screenshotName);
  await page.screenshot({ path: artifacts.screenshotPath, fullPage: true });
  result.screenshots = [`verification/playwright/${screenshotName}`];

  const savedTemplate = await requireJson("/api/documents/sales-order/print-template");
  result.savedTemplate = savedTemplate;
  assert(savedTemplate.paperSize === "A4" && savedTemplate.pageOrientation === "LANDSCAPE",
    "A63 page size and orientation must persist", savedTemplate);
  assert(Number(savedTemplate.copyCount) === 3 && String(savedTemplate.marginTopMm) === "8" && String(savedTemplate.marginLeftMm) === "14",
    "A63 copy count and margins must persist", savedTemplate);

  const created = await requireJson("/api/sales-orders/draft", {
    method: "POST",
    body: {
      customerCode: "KH-001",
      billDate: "2026-06-24",
      department: "销售部",
      remark: fixtureKey,
      lines
    }
  });
  assert(uuidPattern.test(String(created.id ?? "")) && String(created.billNo ?? ""),
    "A63 sales-order create response must expose exact UUID and system billNo", created);
  artifacts.order.id = String(created.id);
  artifacts.order.billNo = String(created.billNo);
  result.billNo = artifacts.order.billNo;
  artifacts.order.initialSnapshot = captureOrderSnapshot("after-create");
  if (faultPhase === "after-create") {
    result.fault.reached = true;
    result.fault.injected = true;
    throw new Error(`A63_FAULT_INJECTED_AFTER_CREATE:${runId}`);
  }

  const html = await requireText(`/api/documents/sales-order/${encodeURIComponent(artifacts.order.billNo)}/print.html`);
  for (const expected of ["@page", "A4 landscape", "8mm 10mm 12mm 14mm", "联次：3联", "第3联 / 共3联"]) {
    assert(html.includes(expected), `A63 HTML should include ${expected}`);
  }

  const pdfResponse = await browserFetchBytes(`/api/documents/sales-order/${encodeURIComponent(artifacts.order.billNo)}/print.pdf`);
  assert(pdfResponse.ok && pdfResponse.contentType.includes("application/pdf"),
    "A63 PDF endpoint must return application/pdf", pdfResponse.status);
  const pdfBytes = Buffer.from(pdfResponse.bytes);
  const pdfPath = path.join(verificationDir, `a63-sales-order-print-settings-${runToken}.pdf`);
  await writeFile(pdfPath, pdfBytes);
  artifacts.pdfWritten = true;
  result.pdfPath = `verification/${path.basename(pdfPath)}`;
  const pdfText = pdfBytes.toString("latin1");
  assert(pdfText.startsWith("%PDF-1.4") && pdfText.includes("/Count 3") && pdfText.includes("/MediaBox [0 0 842 595]"),
    "A63 PDF must use three A4 landscape pages");
  for (const expected of ["第1联 / 共3联", "第2联 / 共3联", "第3联 / 共3联", "纸张：A4", "方向：横向", "边距：8/10/12/14mm"]) {
    assert(pdfText.includes(utf16beHex(expected)), `A63 PDF should include ${expected}`);
  }
  artifacts.order.cleanupSnapshot = captureOrderSnapshot("after-print-checks");
  result.checks = {
    ...result.checks,
    frontendSaved: true,
    templateParamsPersisted: true,
    systemGeneratedBillNo: true,
    completeOwnedSnapshot: true,
    htmlUsesPageSettings: true,
    pdfUsesPageSettings: true
  };
}

try {
  await runScenario();
} catch (error) {
  primaryError = error;
  result.failure = {
    name: error instanceof Error ? error.name : "Error",
    message: error instanceof Error ? error.message : String(error),
    stack: error instanceof Error ? error.stack : null
  };
} finally {
  result.cleanup.attempted = true;
  if (page && artifacts.loggedIn) {
    try {
      await logout(page);
      artifacts.loggedOut = true;
    } catch (error) {
      result.cleanup.errors.push(`logout: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (browser) {
    try {
      await browser.close();
    } catch (error) {
      result.cleanup.errors.push(`browser close: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  try {
    result.cleanup.deleted = cleanupOrder();
    if (result.cleanup.deleted) {
      assert(Number(result.cleanup.deleted.headers) === 1, "A63 cleanup must delete exactly one header", result.cleanup.deleted);
      assert(Number(result.cleanup.deleted.lines) === 3, "A63 cleanup must delete exactly three lines", result.cleanup.deleted);
      assert(Number(result.cleanup.deleted.locks) === 0, "A63 cleanup must not find an order-editor lock", result.cleanup.deleted);
    }
  } catch (error) {
    result.cleanup.errors.push(`order cleanup: ${error instanceof Error ? error.message : String(error)}`);
  }
  try {
    restoreTemplate();
  } catch (error) {
    result.cleanup.errors.push(`template restore: ${error instanceof Error ? error.message : String(error)}`);
  }
  result.cleanup.sessionLoggedOut = artifacts.loggedOut;
  try {
    result.cleanup.residue = fixtureResidue();
    const nonZero = Object.entries(result.cleanup.residue).filter(([, value]) => Number(value) !== 0);
    if (nonZero.length > 0) result.cleanup.errors.push(`fixture residue remains: ${JSON.stringify(result.cleanup.residue)}`);
  } catch (error) {
    result.cleanup.errors.push(`residue verification: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (primaryError) {
    for (const filePath of [artifacts.screenshotPath, result.pdfPath ? path.join(rootDir, result.pdfPath) : ""]) {
      if (!filePath) continue;
      try {
        await rm(filePath, { force: true });
        result.cleanup.filesRemovedOnFailure.push(path.relative(rootDir, filePath));
      } catch (error) {
        result.cleanup.errors.push(`artifact cleanup ${path.basename(filePath)}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }
}

result.ok = primaryError === null
  && result.cleanup.errors.length === 0
  && result.cleanup.residue
  && Object.values(result.cleanup.residue).every((value) => Number(value) === 0)
  && result.cleanup.templateRestored
  && result.cleanup.sessionLoggedOut;

await writeFile(resultPath, JSON.stringify(result, null, 2));

if (!result.ok) {
  throw new Error(
    `A63 print-page settings regression failed: ${primaryError?.message ?? "scenario passed"}; cleanup: ${result.cleanup.errors.join(" | ") || "ok"}`,
    { cause: primaryError ?? undefined }
  );
}

console.log(JSON.stringify(result, null, 2));
