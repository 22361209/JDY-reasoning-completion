import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";
import { installApiSession, loginAsAdmin } from "./helpers/regression-auth.mjs";
import { saveDocument, auditDocument } from "./helpers/document-actions.mjs";

const rootDir = path.resolve(import.meta.dirname, "..");
const screenshotDir = path.join(rootDir, "verification/playwright");
const resultPath = path.join(rootDir, "verification/a87-stock-transfer-regression.json");
const frontendUrl = "http://127.0.0.1:5173/";
const apiBase = "http://127.0.0.1:8080";
const runId = `${new Date().toISOString().replace(/\D/g, "").slice(0, 14)}-${randomUUID().slice(0, 8)}`;
const compactRunId = runId.replaceAll("-", "").toUpperCase();
const fixtureTag = `A87-STOCK-TRANSFER-${runId}`;
const sourceWarehouseCode = `A87S-${compactRunId}`;
const targetWarehouseCode = `A87T-${compactRunId}`;
const sourceWarehouseName = `A87 调拨源仓 ${runId}`;
const targetWarehouseName = `A87 调拨目标仓 ${runId}`;
const seedSourceType = `A87_TRANSFER_SEED:${compactRunId}`;
const seedTxnType = "A87_TRANSFER_SEED";
const shortageFailureEndpoint = "POST /api/stock-transfers/{billNo}/audit";
const shortageFailureReason = "库存不足，不能调整为负数";
const fixtureUsername = `a87tr_${compactRunId.toLowerCase()}`;
const fixturePassword = `A87-${compactRunId.slice(-8)}-Admin!`;
const fixtureDisplayName = `A87 调拨管理员 ${runId}`;
const billDate = "2026-06-25";
const productCode = "CP-001";
const qty = 4;
const seedQty = qty + 3;
const unitPrice = 1;
const uuidPattern = /^[0-9a-f-]{36}$/i;
const documentType = "stockTransfer";
const operationTargetType = "stock_transfer";
const faultPhase = process.env.A87_STOCK_TRANSFER_FAULT_PHASE ?? "";

let accountSetId = "";
let productId = "";
let fixtureUserId = "";
let fixtureGrantId = "";
let adminRoleId = "";
let billNo = "";
let shortageBillNo = "";
let browser = null;
let preflightAuthorized = false;
let seedSourceBillDate = "";
let shortageFailureBaselineCaptured = false;
let shortageFailureBaselineIds = [];
let shortageFailureLog = null;
let shortageAuditAttempted = false;
const capturedTxnIds = new Set();
const capturedLogIds = new Set();
const createdWarehouseIds = new Set();

const result = {
  runId,
  generatedAt: new Date().toISOString(),
  ok: false,
  environment: {},
  billNo: "",
  shortageBillNo: "",
  productCode,
  sourceWarehouseCode,
  targetWarehouseCode,
  qty,
  stock: {},
  transactions: [],
  seed: null,
  shortage: null,
  artifacts: {
    fixtureUsername,
    fixtureUserId: null,
    fixtureGrantId: null,
    adminRoleId: null,
    shortageFailureLogId: null
  },
  screenshots: [],
  cleanup: { attempted: false, capturedTxnIds: [], capturedLogIds: [], residue: null, error: "" },
  failure: null
};

await mkdir(screenshotDir, { recursive: true });
await mkdir(path.dirname(resultPath), { recursive: true });

function assert(condition, message, detail = undefined) {
  if (!condition) {
    throw new Error(detail === undefined ? message : `${message}: ${JSON.stringify(detail)}`);
  }
}

function sqlLiteral(value) {
  if (value === null || value === undefined) return "NULL";
  return `'${String(value).replaceAll("'", "''")}'`;
}

function javaNameUuid(value) {
  const bytes = createHash("md5").update(value, "utf8").digest();
  bytes[6] = (bytes[6] & 0x0f) | 0x30;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function currentBusinessDate() {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en", {
    timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit"
  }).formatToParts(new Date()).filter((part) => part.type !== "literal").map((part) => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

const seedSourceBillId = javaNameUuid(`TEST_HEADER:${seedSourceType}`);
const seedSourceBillLineId = javaNameUuid(`TEST_LINE:${seedSourceType}:${productCode}:${sourceWarehouseCode}`);

function uuidArray(values) {
  const normalized = [...new Set(values.filter((value) => uuidPattern.test(String(value))))].sort();
  return normalized.length
    ? `ARRAY[${normalized.map((value) => `${sqlLiteral(value)}::uuid`).join(",")}]`
    : "ARRAY[]::uuid[]";
}

function textArray(values) {
  const normalized = [...new Set(values.filter(Boolean).map(String))].sort();
  return normalized.length
    ? `ARRAY[${normalized.map(sqlLiteral).join(",")}]::text[]`
    : "ARRAY[]::text[]";
}

function lockKeyPredicate(alias, locks) {
  if (locks.length === 0) return "FALSE";
  return locks.map((row) => `(${alias}.document_type=${sqlLiteral(row.document_type)} AND ${alias}.bill_no=${sqlLiteral(row.bill_no)})`).join(" OR ");
}

function dbScalar(sql) {
  return execFileSync("docker", [
    "exec", "jdy-erp-postgres", "psql", "-U", "jdy", "-d", "jdy_erp", "-v", "ON_ERROR_STOP=1", "-tA", "-c", sql
  ], { encoding: "utf8" }).trim();
}

function dbJson(sql) {
  const value = dbScalar(sql);
  return value ? JSON.parse(value) : null;
}

function dbNumber(sql) {
  return Number(dbScalar(sql) || "0");
}

async function api(pathname, options = {}) {
  const response = await fetch(`${apiBase}${pathname}`, {
    method: options.method ?? "POST",
    headers: options.body ? { "Content-Type": "application/json" } : undefined,
    body: options.body ? JSON.stringify(options.body) : undefined
  });
  const text = await response.text();
  let body = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }
  if (!response.ok && !options.expectFailure) {
    throw new Error(`${options.method ?? "POST"} ${pathname} failed ${response.status}: ${text}`);
  }
  return { status: response.status, body };
}

function warehouseRowsByCode() {
  return dbJson(`
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
      'id', id::text,
      'code', code,
      'name', name,
      'remark', COALESCE(remark, '')
    ) ORDER BY code), '[]'::jsonb)::text
    FROM public.md_warehouse
    WHERE code IN (${sqlLiteral(sourceWarehouseCode)}, ${sqlLiteral(targetWarehouseCode)})
  `) ?? [];
}

function ownedWarehouseRows() {
  if (createdWarehouseIds.size === 0) return [];
  return dbJson(`
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
      'id', id::text,
      'code', code,
      'name', name,
      'remark', COALESCE(remark, '')
    ) ORDER BY code), '[]'::jsonb)::text
    FROM public.md_warehouse
    WHERE id=ANY(${uuidArray([...createdWarehouseIds])})
  `) ?? [];
}

function stockState(warehouseCode) {
  return dbJson(`
    SELECT jsonb_build_object(
      'balanceId', b.id::text,
      'onHand', b.qty_on_hand::text,
      'available', b.qty_available::text,
      'reserved', b.qty_reserved::text,
      'version', b.version::text
    )::text
    FROM public.inv_stock_balance b
    JOIN public.md_product product ON product.id=b.product_id
    JOIN public.md_warehouse warehouse ON warehouse.id=b.warehouse_id
    WHERE b.account_set_id=${sqlLiteral(accountSetId)}::uuid
      AND product.code=${sqlLiteral(productCode)}
      AND warehouse.code=${sqlLiteral(warehouseCode)}
  `) ?? { balanceId: null, onHand: "0", available: "0", reserved: "0", version: null };
}

function runDocuments() {
  return dbJson(`
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
      'headerId', header.id::text,
      'billNo', header.bill_no,
      'billDate', header.bill_date::text,
      'status', header.status,
      'lineId', line.id::text,
      'lineNo', line.line_no,
      'productId', line.product_id::text,
      'sourceWarehouseId', line.source_warehouse_id::text,
      'targetWarehouseId', line.target_warehouse_id::text,
      'qty', line.qty::text
    ) ORDER BY header.bill_no, line.line_no), '[]'::jsonb)::text
    FROM public.stock_transfer header
    JOIN public.stock_transfer_line line ON line.bill_id=header.id
    WHERE header.department=${sqlLiteral(fixtureTag)}
  `) ?? [];
}

function documentByBillNo(targetBillNo) {
  return runDocuments().find((row) => row.billNo === targetBillNo) ?? null;
}

function transactionsForDocument(headerId) {
  return dbJson(`
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
      'id', txn.id::text,
      'txnType', txn.txn_type,
      'sourceBillType', txn.source_bill_type,
      'sourceBillId', txn.source_bill_id::text,
      'sourceBillLineId', txn.source_bill_line_id::text,
      'sourceBillNo', txn.source_bill_no,
      'sourceBillDate', txn.source_bill_date::text,
      'postingAction', txn.posting_action,
      'traceQuality', txn.trace_quality,
      'reversalOfTxnId', txn.reversal_of_txn_id::text,
      'warehouseId', txn.warehouse_id::text,
      'warehouseCode', warehouse.code,
      'qtyDelta', txn.qty_delta::text
    ) ORDER BY txn.created_at, txn.id::text), '[]'::jsonb)::text
    FROM public.inv_stock_txn txn
    JOIN public.md_warehouse warehouse ON warehouse.id=txn.warehouse_id
    WHERE txn.account_set_id=${sqlLiteral(accountSetId)}::uuid
      AND txn.source_bill_type='STOCK_TRANSFER'
      AND txn.source_bill_id=${sqlLiteral(headerId)}::uuid
  `) ?? [];
}

function seedTransactions() {
  return dbJson(`
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
      'id', txn.id::text,
      'accountSetId', txn.account_set_id::text,
      'productId', txn.product_id::text,
      'txnType', txn.txn_type,
      'sourceBillType', txn.source_bill_type,
      'sourceBillId', txn.source_bill_id::text,
      'sourceBillLineId', txn.source_bill_line_id::text,
      'sourceBillNo', txn.source_bill_no,
      'sourceBillDate', txn.source_bill_date::text,
      'postingAction', txn.posting_action,
      'traceQuality', txn.trace_quality,
      'reversalOfTxnId', txn.reversal_of_txn_id::text,
      'warehouseId', txn.warehouse_id::text,
      'warehouseCode', warehouse.code,
      'qtyDelta', txn.qty_delta::text
    ) ORDER BY txn.id::text), '[]'::jsonb)::text
    FROM public.inv_stock_txn txn
    JOIN public.md_warehouse warehouse ON warehouse.id=txn.warehouse_id
    WHERE txn.account_set_id=${sqlLiteral(accountSetId)}::uuid
      AND txn.source_bill_type=${sqlLiteral(seedSourceType)}
  `) ?? [];
}

function endpointFailureLogs() {
  return dbJson(`
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
      'id', log.id::text,
      'module', log.module_code,
      'action', log.action_code,
      'targetType', log.target_type,
      'targetId', log.target_id::text,
      'targetNo', log.target_no,
      'success', log.success,
      'reason', log.failure_reason,
      'accountSetId', log.account_set_id::text,
      'accountSetCode', log.account_set_code,
      'actorType', log.actor_type,
      'actorUsername', log.actor_username
    ) ORDER BY log.operated_at, log.id), '[]'::jsonb)::text
    FROM public.sys_operation_log log
    WHERE log.action_code='WRITE_FAILED'
      AND log.target_type='http_endpoint'
      AND log.target_no=${sqlLiteral(shortageFailureEndpoint)}
      AND log.actor_username=${sqlLiteral(fixtureUsername)}
      AND log.account_set_code='BLD-TEST'
  `) ?? [];
}

function assertShortageFailureLog(row) {
  assert(uuidPattern.test(row?.id), "shortage WRITE_FAILED log must expose a UUID", row);
  assert(row.module === "SECURITY"
    && row.action === "WRITE_FAILED"
    && row.targetType === "http_endpoint"
    && row.targetId === null
    && row.targetNo === shortageFailureEndpoint
    && row.success === false
    && row.reason === shortageFailureReason
    && row.accountSetId === accountSetId
    && row.accountSetCode === "BLD-TEST"
    && row.actorType === "USER"
    && row.actorUsername === fixtureUsername, "shortage failure log must match the exact rejected fixture-admin/BLD-TEST request", row);
}

function captureNewShortageFailureLogs() {
  assert(shortageFailureBaselineCaptured, "shortage failure-log baseline must be captured before audit");
  const baseline = new Set(shortageFailureBaselineIds);
  const created = endpointFailureLogs().filter((row) => !baseline.has(row.id));
  for (const row of created) assertShortageFailureLog(row);
  return created;
}

function capture(rows) {
  for (const row of rows) {
    assert(uuidPattern.test(row.id), "owned inventory transaction must expose a UUID", row);
    capturedTxnIds.add(row.id);
  }
  return rows;
}

function assertSeedTransaction(row, sourceWarehouseId) {
  assert(row.accountSetId === accountSetId && row.productId === productId, "transfer seed must keep exact account/product identity", row);
  assert(row.warehouseId === sourceWarehouseId && row.warehouseCode === sourceWarehouseCode, "transfer seed must belong only to the created source warehouse UUID", row);
  assert(row.txnType === seedTxnType && row.sourceBillType === seedSourceType, "transfer seed must keep its exact A-number TEST identity", row);
  assert(row.sourceBillId === seedSourceBillId && row.sourceBillLineId === seedSourceBillLineId, "transfer seed must keep deterministic TEST header/line UUIDs", row);
  assert(row.sourceBillNo === seedSourceType && row.sourceBillDate === seedSourceBillDate, "transfer seed must keep exact source number/date", row);
  assert(row.traceQuality === "TEST" && row.postingAction === "AUDIT" && row.reversalOfTxnId === null, "transfer seed must remain a TEST/AUDIT fact without reversal", row);
  assert(Number(row.qtyDelta) === seedQty, "transfer seed quantity mismatch", row);
}

function assertTransferTrace(rows, document, reversed) {
  const expected = reversed
    ? [
        { txnType: "STOCK_TRANSFER_OUT", warehouseCode: sourceWarehouseCode, qtyDelta: -qty, postingAction: "AUDIT", reverseOf: null },
        { txnType: "STOCK_TRANSFER_IN", warehouseCode: targetWarehouseCode, qtyDelta: qty, postingAction: "AUDIT", reverseOf: null },
        { txnType: "STOCK_TRANSFER_IN_REVERSE", warehouseCode: targetWarehouseCode, qtyDelta: -qty, postingAction: "REVERSE", reverseOf: "STOCK_TRANSFER_IN" },
        { txnType: "STOCK_TRANSFER_OUT_REVERSE", warehouseCode: sourceWarehouseCode, qtyDelta: qty, postingAction: "REVERSE", reverseOf: "STOCK_TRANSFER_OUT" }
      ]
    : [
        { txnType: "STOCK_TRANSFER_OUT", warehouseCode: sourceWarehouseCode, qtyDelta: -qty, postingAction: "AUDIT", reverseOf: null },
        { txnType: "STOCK_TRANSFER_IN", warehouseCode: targetWarehouseCode, qtyDelta: qty, postingAction: "AUDIT", reverseOf: null }
      ];
  assert(rows.length === expected.length, `stock transfer should expose ${expected.length} exact owned transactions`, rows);
  for (const spec of expected) {
    const row = rows.find((candidate) => candidate.txnType === spec.txnType);
    assert(row, `missing ${spec.txnType} inventory transaction`, rows);
    assert(row.sourceBillType === "STOCK_TRANSFER", `${spec.txnType} must keep canonical source type`, row);
    assert(row.sourceBillId === document.headerId, `${spec.txnType} must point to the exact header UUID`, row);
    assert(row.sourceBillLineId === document.lineId, `${spec.txnType} must point to the exact line UUID`, row);
    assert(row.sourceBillNo === document.billNo, `${spec.txnType} must keep canonical bill number`, row);
    assert(row.sourceBillDate === billDate, `${spec.txnType} must keep the business date`, row);
    assert(row.postingAction === spec.postingAction, `${spec.txnType} posting action mismatch`, row);
    assert(row.traceQuality === "EXACT", `${spec.txnType} must be EXACT`, row);
    assert(row.warehouseCode === spec.warehouseCode, `${spec.txnType} warehouse mismatch`, row);
    const expectedWarehouseId = spec.warehouseCode === sourceWarehouseCode
      ? document.sourceWarehouseId
      : document.targetWarehouseId;
    assert(row.warehouseId === expectedWarehouseId, `${spec.txnType} must point to the exact warehouse UUID`, { row, document });
    assert(Number(row.qtyDelta) === spec.qtyDelta, `${spec.txnType} quantity mismatch`, row);
    if (spec.reverseOf === null) {
      assert(row.reversalOfTxnId === null, `${spec.txnType} original posting must not link a reversal`, row);
    } else {
      const original = rows.find((candidate) => candidate.txnType === spec.reverseOf);
      assert(original && row.reversalOfTxnId === original.id, `${spec.txnType} must pair with ${spec.reverseOf}`, { row, original });
    }
  }
}

async function assertHealthBeforeSession() {
  assert(new URL(apiBase).hostname === "127.0.0.1" && new URL(frontendUrl).hostname === "127.0.0.1", "A87 may only write through local services");
  const health = await api("/api/system/health", { method: "GET" });
  assert(health.status === 200, "local health endpoint must be available", health);
  assert(health.body?.testInventoryAdjustmentApi === true, "A87 requires the restricted test inventory adjustment capability", health.body);
  result.environment.health = health.body;
}

async function assertAuthenticatedEnvironmentBeforeWrites() {
  const session = await api("/api/system/session", { method: "GET" });
  const sessionAccountSetId = String(session.body?.tenant?.id ?? "");
  assert(uuidPattern.test(sessionAccountSetId) && sessionAccountSetId === accountSetId, "session must expose the exact fixture account-set UUID", session.body);
  assert(session.body?.tenant?.code === "BLD-TEST", "A87 writes are allowed only in BLD-TEST", session.body?.tenant);
  assert(session.body?.tenant?.schemaName === "public", "A87 direct SQL is allowed only in the public test schema", session.body?.tenant);
  const account = dbJson(`
    SELECT jsonb_build_object('id', id::text, 'code', code, 'schemaName', schema_name, 'enabled', enabled)::text
    FROM public.sys_account_set WHERE id=${sqlLiteral(accountSetId)}::uuid
  `);
  assert(account?.code === "BLD-TEST" && account?.schemaName === "public" && account?.enabled === true, "database account-set route must match BLD-TEST/public", account);
  const authenticatedProductId = dbScalar(`
    SELECT id::text FROM public.md_product
    WHERE code=${sqlLiteral(productCode)} AND enabled=TRUE
  `);
  assert(uuidPattern.test(authenticatedProductId) && authenticatedProductId === productId,
    "A87 authenticated preflight must retain the exact enabled run product UUID", { productCode, productId, authenticatedProductId });
  result.environment.tenant = session.body.tenant;
  result.environment.productId = productId;
}

function setupFixtureAdminUser() {
  const route = dbJson(`
    SELECT jsonb_build_object(
      'accountSetId', account_set.id::text,
      'accountSetCode', account_set.code,
      'schemaName', account_set.schema_name,
      'accountEnabled', account_set.enabled,
      'adminRoleId', role.id::text,
      'roleEnabled', role.enabled,
      'productId', product.id::text,
      'productEnabled', product.enabled
    )::text
    FROM public.sys_account_set account_set
    CROSS JOIN public.sys_role role
    CROSS JOIN public.md_product product
    WHERE account_set.code='BLD-TEST' AND role.code='ADMIN'
      AND product.code=${sqlLiteral(productCode)}
  `);
  assert(route?.accountSetCode === "BLD-TEST" && route?.schemaName === "public"
    && route?.accountEnabled === true && route?.roleEnabled === true && route?.productEnabled === true
    && uuidPattern.test(route.accountSetId) && uuidPattern.test(route.adminRoleId) && uuidPattern.test(route.productId),
  "fixture admin route must be enabled BLD-TEST/public ADMIN with an enabled run product", route);
  accountSetId = route.accountSetId;
  adminRoleId = route.adminRoleId;
  productId = route.productId;
  assert(dbNumber(`SELECT count(*) FROM public.sys_user WHERE username=${sqlLiteral(fixtureUsername)}`) === 0, "run-unique fixture admin username must not pre-exist", fixtureUsername);
  const created = dbJson(`
    WITH created_user AS (
      INSERT INTO public.sys_user (username, display_name, password_hash, enabled, default_account_set_id)
      VALUES (${sqlLiteral(fixtureUsername)}, ${sqlLiteral(fixtureDisplayName)}, ${sqlLiteral(`{noop}${fixturePassword}`)}, TRUE, ${sqlLiteral(accountSetId)}::uuid)
      RETURNING id
    ), created_role_link AS (
      INSERT INTO public.sys_user_role (user_id, role_id)
      SELECT id, ${sqlLiteral(adminRoleId)}::uuid FROM created_user
      RETURNING user_id, role_id
    ), created_grant AS (
      INSERT INTO public.sys_user_account_set (user_id, account_set_id, role_code, is_default, enabled)
      SELECT id, ${sqlLiteral(accountSetId)}::uuid, 'ADMIN', TRUE, TRUE FROM created_user
      RETURNING id, user_id, account_set_id
    )
    SELECT jsonb_build_object(
      'userId', created_user.id::text,
      'grantId', created_grant.id::text,
      'roleId', created_role_link.role_id::text
    )::text
    FROM created_user
    JOIN created_role_link ON created_role_link.user_id=created_user.id
    JOIN created_grant ON created_grant.user_id=created_user.id
  `);
  assert(uuidPattern.test(created?.userId) && uuidPattern.test(created?.grantId) && created?.roleId === adminRoleId, "fixture admin user/grant/role UUID closure must be complete", created);
  fixtureUserId = created.userId;
  fixtureGrantId = created.grantId;
  result.artifacts.fixtureUserId = fixtureUserId;
  result.artifacts.fixtureGrantId = fixtureGrantId;
  result.artifacts.adminRoleId = adminRoleId;
}

function setupWarehouses() {
  const collisions = warehouseRowsByCode();
  assert(collisions.length === 0, "run-unique transfer warehouses must not pre-exist", collisions);
  const inserted = dbJson(`
    WITH created AS (
      INSERT INTO public.md_warehouse (code, name, allow_negative_stock, enabled, audit_status, remark)
      VALUES
        (${sqlLiteral(sourceWarehouseCode)}, ${sqlLiteral(sourceWarehouseName)}, FALSE, TRUE, 'AUDITED', ${sqlLiteral(fixtureTag)}),
        (${sqlLiteral(targetWarehouseCode)}, ${sqlLiteral(targetWarehouseName)}, FALSE, TRUE, 'AUDITED', ${sqlLiteral(fixtureTag)})
      RETURNING id, code, name, remark
    )
    SELECT jsonb_agg(jsonb_build_object(
      'id', id::text,
      'code', code,
      'name', name,
      'remark', COALESCE(remark, '')
    ) ORDER BY code)::text FROM created
  `) ?? [];
  assert(inserted.length === 2, "two run-unique transfer warehouses must be inserted", inserted);
  for (const row of inserted) {
    assert(uuidPattern.test(row.id) && row.remark === fixtureTag, "inserted transfer warehouse identity mismatch", row);
    createdWarehouseIds.add(row.id);
  }
  const owned = ownedWarehouseRows();
  assert(owned.length === 2 && owned.every((row) => row.remark === fixtureTag), "created transfer warehouses must retain UUID and fixture ownership", owned);
}

async function seedOnlySourceWarehouse() {
  seedSourceBillDate = currentBusinessDate();
  await api("/api/inventory/adjustments", {
    body: {
      productCode,
      warehouseCode: sourceWarehouseCode,
      qtyDelta: seedQty,
      txnType: seedTxnType,
      sourceBillType: seedSourceType
    }
  });
  const rows = capture(seedTransactions());
  assert(rows.length === 1, "transfer seed must create exactly one owned transaction", rows);
  const sourceWarehouse = ownedWarehouseRows().find((row) => row.code === sourceWarehouseCode);
  assert(sourceWarehouse, "created source warehouse UUID must remain available for seed validation", ownedWarehouseRows());
  assertSeedTransaction(rows[0], sourceWarehouse.id);
  result.seed = rows[0];
  assert(Number(stockState(sourceWarehouseCode).onHand) === seedQty, "source warehouse seed quantity mismatch", stockState(sourceWarehouseCode));
  assert(stockState(targetWarehouseCode).balanceId === null, "target warehouse must not receive seed inventory", stockState(targetWarehouseCode));
}

async function createAndAuditInFrontend() {
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1366, height: 768 } });
  const screenshots = [];
  try {
    await page.goto(frontendUrl, { waitUntil: "networkidle" });
    await loginAsAdmin(page, fixturePassword, "BLD-TEST", fixtureUsername);
    await page.getByTestId("module-库存管理").hover();
    await page.getByTestId("entry-stock-transfer-form").click();
    await page.getByTestId("tab-stock-transfer-form").waitFor({ state: "visible" });
    const billNoInput = page.getByTestId("stock-transfer-bill-no");
    assert(await billNoInput.inputValue() === "", "new stock transfer bill number should be blank");
    assert(!(await billNoInput.isEditable()), "new stock transfer bill number should be readonly");
    const accountSetName = String(result.environment.tenant?.name ?? "");
    assert(await page.getByTestId("stock-transfer-party-code").inputValue() === "BLD-TEST",
      "stock transfer organization code must be the current account set");
    assert(accountSetName && await page.getByTestId("stock-transfer-party-name").inputValue() === accountSetName,
      "stock transfer organization name must be the current account-set name", accountSetName);
    await page.getByTestId("stock-transfer-party-code").fill(sourceWarehouseCode);
    assert(await page.getByTestId("stock-transfer-party-code").inputValue() === "BLD-TEST",
      "stock transfer organization must reject arbitrary warehouse or free-text values");
    await page.getByTestId("stock-transfer-party-open-selector").click();
    await page.getByTestId("master-selector-source-selector-dialog").waitFor({ state: "visible" });
    await page.getByTestId("master-selector-source-selector-table-core").filter({ hasText: "BLD-TEST" }).waitFor({ state: "visible" });
    assert(await page.locator('[data-testid^="master-selector-source-line-"]').count() === 1,
      "stock transfer organization selector must expose exactly one current-account-set candidate");
    const organizationSelectorText = await page.getByTestId("master-selector-source-selector-table-core").innerText();
    assert(organizationSelectorText.includes("BLD-TEST") && organizationSelectorText.includes(accountSetName),
      "stock transfer organization candidate must identify the current account set", organizationSelectorText);
    assert(!organizationSelectorText.includes(sourceWarehouseCode) && !organizationSelectorText.includes(targetWarehouseCode),
      "stock transfer organization candidates must not be warehouse records", organizationSelectorText);
    await page.getByTestId("master-selector-source-selector-cancel").click();
    await page.getByTestId("stock-transfer-line-warehouse-open-selector").click();
    await page.getByTestId("master-selector-source-selector-dialog").waitFor({ state: "visible" });
    await page.getByTestId("master-selector-source-selector-table-core").filter({ hasText: sourceWarehouseCode }).waitFor({ state: "visible" });
    await page.getByTestId("master-selector-source-selector-table-core").filter({ hasText: targetWarehouseCode }).waitFor({ state: "visible" });
    const warehouseSelectorText = await page.getByTestId("master-selector-source-selector-table-core").innerText();
    assert(warehouseSelectorText.includes(sourceWarehouseCode) && warehouseSelectorText.includes(targetWarehouseCode),
      "stock transfer line warehouse selector must retain warehouse-master candidates", warehouseSelectorText);
    await page.getByTestId("master-selector-source-selector-cancel").click();
    await page.getByTestId("stock-transfer-bill-date").fill(billDate);
    await page.getByTestId("stock-transfer-department").fill(fixtureTag);
    await page.getByTestId("stock-transfer-line-product").fill(productCode);
    await page.getByTestId("stock-transfer-line-warehouse").fill(sourceWarehouseCode);
    await page.locator(".master-selector__menu button").filter({ hasText: sourceWarehouseCode }).first().click();
    await page.getByTestId("stock-transfer-line-target-warehouse").fill(targetWarehouseCode);
    await page.locator(".master-selector__menu button").filter({ hasText: targetWarehouseCode }).first().click();
    await page.getByTestId("stock-transfer-line-qty").fill(String(qty));
    await page.getByTestId("stock-transfer-line-price").fill(String(unitPrice));
    await page.keyboard.press("Escape");
    await saveDocument(page);
    await page.waitForFunction(() => {
      const input = document.querySelector('[data-testid="stock-transfer-bill-no"]');
      return input instanceof HTMLInputElement && /^ZJDB\d{6}$/.test(input.value);
    });
    billNo = await billNoInput.inputValue();
    result.billNo = billNo;
    assert(/^ZJDB\d{6}$/.test(billNo), "saved stock transfer bill number must be generated", billNo);
    await auditDocument(page);
    await page.getByTestId("document-status").filter({ hasText: "已审核" }).waitFor({ state: "visible" });
    const formShot = `a87-stock-transfer-form-audited-${runId}.png`;
    await page.screenshot({ path: path.join(screenshotDir, formShot), fullPage: true });
    screenshots.push(`verification/playwright/${formShot}`);

    await page.getByTestId("module-库存管理").hover();
    await page.getByTestId("query-stock-transfer-form").click();
    await page.getByTestId("tab-stock-transfer-form-list").waitFor({ state: "visible" });
    await page.getByTestId("list-keyword").fill(billNo);
    await page.getByTestId("list-keyword").press("Enter");
    await page.getByText(billNo).waitFor({ state: "visible", timeout: 10000 });
    const listShot = `a87-stock-transfer-list-${runId}.png`;
    await page.screenshot({ path: path.join(screenshotDir, listShot), fullPage: true });
    screenshots.push(`verification/playwright/${listShot}`);
  } finally {
    await browser.close();
    browser = null;
  }
  return screenshots;
}

async function runScenario() {
  setupWarehouses();
  await seedOnlySourceWarehouse();
  if (faultPhase === "after-seed") {
    throw new Error("A87 injected failure after unique-warehouse seed");
  }
  const beforeSource = stockState(sourceWarehouseCode);
  const beforeTarget = stockState(targetWarehouseCode);
  result.screenshots = await createAndAuditInFrontend();

  const document = documentByBillNo(billNo);
  assert(document && uuidPattern.test(document.headerId) && uuidPattern.test(document.lineId), "saved transfer must expose exact header and line UUIDs", document);
  assert(document.billDate === billDate, "saved transfer business date mismatch", document);
  const detailAfterAudit = (await api(`/api/stock-transfers/${encodeURIComponent(billNo)}`, { method: "GET" })).body;
  const auditRows = capture(transactionsForDocument(document.headerId));
  assertTransferTrace(auditRows, document, false);
  const afterAuditSource = stockState(sourceWarehouseCode);
  const afterAuditTarget = stockState(targetWarehouseCode);
  assert(detailAfterAudit.document.status === "AUDITED", "transfer must be audited", detailAfterAudit.document);
  assert(Number(afterAuditSource.onHand) === Number(beforeSource.onHand) - qty, "source stock audit delta mismatch", { beforeSource, afterAuditSource });
  assert(Number(afterAuditTarget.onHand) === Number(beforeTarget.onHand) + qty, "target stock audit delta mismatch", { beforeTarget, afterAuditTarget });

  await api(`/api/stock-transfers/${encodeURIComponent(billNo)}/reverse`);
  const detailAfterReverse = (await api(`/api/stock-transfers/${encodeURIComponent(billNo)}`, { method: "GET" })).body;
  const reverseRows = capture(transactionsForDocument(document.headerId));
  assertTransferTrace(reverseRows, document, true);
  const afterReverseSource = stockState(sourceWarehouseCode);
  const afterReverseTarget = stockState(targetWarehouseCode);
  assert(detailAfterReverse.document.status === "DRAFT", "reversed transfer must return to DRAFT", detailAfterReverse.document);
  assert(Number(afterReverseSource.onHand) === Number(beforeSource.onHand), "source stock must return to its seeded state", { beforeSource, afterReverseSource });
  assert(Number(afterReverseTarget.onHand) === Number(beforeTarget.onHand), "target stock must return to zero", { beforeTarget, afterReverseTarget });

  const shortageState = stockState(sourceWarehouseCode);
  const shortageDraft = await api("/api/stock-transfers/draft", {
    body: {
      billNo: "",
      billDate,
      department: fixtureTag,
      ownerName: "本地管理员",
      lines: [{
        productCode,
        warehouseCode: sourceWarehouseCode,
        targetWarehouseCode,
        qty: Math.max(Number(shortageState.onHand), Number(shortageState.available)) + 100000,
        unitPrice,
        lineRemark: fixtureTag
      }]
    }
  });
  shortageBillNo = String(shortageDraft.body?.billNo ?? "");
  result.shortageBillNo = shortageBillNo;
  assert(/^ZJDB\d{6}$/.test(shortageBillNo), "shortage transfer draft must expose a generated bill number", shortageDraft.body);
  const shortageDocument = documentByBillNo(shortageBillNo);
  assert(shortageDocument && uuidPattern.test(shortageDocument.headerId) && uuidPattern.test(shortageDocument.lineId), "shortage draft must expose exact header and line UUIDs", shortageDocument);
  const sourceBeforeShortage = stockState(sourceWarehouseCode);
  const targetBeforeShortage = stockState(targetWarehouseCode);
  shortageFailureBaselineIds = endpointFailureLogs().map((row) => row.id);
  shortageFailureBaselineCaptured = true;
  shortageAuditAttempted = true;
  const shortageResponse = await api(`/api/stock-transfers/${encodeURIComponent(shortageBillNo)}/audit`, { expectFailure: true });
  const newFailureLogs = captureNewShortageFailureLogs();
  assert(newFailureLogs.length === 1, "shortage transfer must create exactly one new WRITE_FAILED/http_endpoint log UUID", newFailureLogs);
  [shortageFailureLog] = newFailureLogs;
  capturedLogIds.add(shortageFailureLog.id);
  result.artifacts.shortageFailureLogId = shortageFailureLog.id;
  const shortageReason = String(shortageResponse.body?.reason ?? shortageResponse.body?.message ?? "");
  assert(shortageResponse.status === 409, "shortage transfer audit must fail with 409", shortageResponse);
  assert(shortageReason === shortageFailureReason, "shortage transfer must report the formal nonnegative-stock guard", shortageResponse.body);
  assert(JSON.stringify(stockState(sourceWarehouseCode)) === JSON.stringify(sourceBeforeShortage), "shortage transfer must not mutate source balance");
  assert(JSON.stringify(stockState(targetWarehouseCode)) === JSON.stringify(targetBeforeShortage), "shortage transfer must not mutate target balance");
  assert(transactionsForDocument(shortageDocument.headerId).length === 0, "shortage transfer must not create inventory facts");

  const financeCount = dbNumber(`
    SELECT (SELECT count(*) FROM public.ar_receivable WHERE source_bill_no IN (${sqlLiteral(billNo)}, ${sqlLiteral(shortageBillNo)}))
         + (SELECT count(*) FROM public.ap_payable WHERE source_bill_no IN (${sqlLiteral(billNo)}, ${sqlLiteral(shortageBillNo)}))
  `);
  assert(financeCount === 0, "stock transfers must not create finance documents", financeCount);
  result.stock = { beforeSource, beforeTarget, afterAuditSource, afterAuditTarget, afterReverseSource, afterReverseTarget };
  result.transactions = [...seedTransactions(), ...reverseRows];
  result.shortage = {
    status: shortageResponse.status,
    reason: shortageReason,
    endpoint: shortageFailureEndpoint,
    failureLogId: shortageFailureLog.id,
    failureLog: shortageFailureLog
  };
}

function fixtureUserState() {
  const users = dbJson(`
    SELECT COALESCE(jsonb_agg(to_jsonb(app_user) ORDER BY app_user.id), '[]'::jsonb)::text
    FROM public.sys_user app_user
    WHERE app_user.id=${sqlLiteral(fixtureUserId)}::uuid OR app_user.username=${sqlLiteral(fixtureUsername)}
  `) ?? [];
  assert(users.length === 1
    && String(users[0].id) === fixtureUserId
    && users[0].username === fixtureUsername
    && users[0].display_name === fixtureDisplayName
    && users[0].password_hash === `{noop}${fixturePassword}`
    && users[0].enabled === true
    && String(users[0].default_account_set_id) === accountSetId, "cleanup refused a fixture admin user without exact UUID/identity ownership", users);
  const roleLinks = dbJson(`
    SELECT COALESCE(jsonb_agg(jsonb_build_object('link', to_jsonb(link), 'role', to_jsonb(role_row))
      ORDER BY link.user_id, link.role_id), '[]'::jsonb)::text
    FROM public.sys_user_role link
    JOIN public.sys_role role_row ON role_row.id=link.role_id
    WHERE link.user_id=${sqlLiteral(fixtureUserId)}::uuid
  `) ?? [];
  assert(roleLinks.length === 1
    && String(roleLinks[0].link?.user_id) === fixtureUserId
    && String(roleLinks[0].link?.role_id) === adminRoleId
    && String(roleLinks[0].role?.id) === adminRoleId
    && roleLinks[0].role?.code === "ADMIN" && roleLinks[0].role?.enabled === true,
  "cleanup refused a fixture user role outside the exact enabled ADMIN link", roleLinks);
  const grants = dbJson(`
    SELECT COALESCE(jsonb_agg(jsonb_build_object('grant', to_jsonb(grant_row), 'accountSet', to_jsonb(account_set))
      ORDER BY grant_row.id), '[]'::jsonb)::text
    FROM public.sys_user_account_set grant_row
    JOIN public.sys_account_set account_set ON account_set.id=grant_row.account_set_id
    WHERE grant_row.user_id=${sqlLiteral(fixtureUserId)}::uuid
  `) ?? [];
  assert(grants.length === 1
    && String(grants[0].grant?.id) === fixtureGrantId
    && String(grants[0].grant?.user_id) === fixtureUserId
    && String(grants[0].grant?.account_set_id) === accountSetId
    && grants[0].grant?.role_code === "ADMIN"
    && grants[0].grant?.is_default === true
    && grants[0].grant?.enabled === true
    && String(grants[0].accountSet?.id) === accountSetId
    && grants[0].accountSet?.code === "BLD-TEST"
    && grants[0].accountSet?.schema_name === "public"
    && grants[0].accountSet?.enabled === true, "cleanup refused a fixture user grant outside the exact BLD-TEST ADMIN grant", grants);
  const sessionScopes = dbJson(`
    SELECT COALESCE(jsonb_agg(to_jsonb(scope_row) ORDER BY scope_row.session_token), '[]'::jsonb)::text
    FROM public.sys_session_account_scope scope_row
    WHERE scope_row.user_id=${sqlLiteral(fixtureUserId)}::uuid
  `) ?? [];
  for (const scopeRow of sessionScopes) {
    assert(uuidPattern.test(String(scopeRow.session_token))
      && uuidPattern.test(String(scopeRow.scope_token))
      && String(scopeRow.user_id) === fixtureUserId
      && String(scopeRow.account_set_id) === accountSetId,
    "cleanup refused a changed or cross-account fixture session scope", scopeRow);
  }
  return { users, roleLinks, grants, sessionScopes };
}

function discoverCleanupState() {
  const fixtureUser = fixtureUserState();
  const documents = runDocuments();
  const warehouses = ownedWarehouseRows();
  assert(warehouses.length === createdWarehouseIds.size, "cleanup refused because a created transfer warehouse UUID disappeared", { warehouses, createdWarehouseIds: [...createdWarehouseIds] });
  assert(warehouses.every((row) => row.remark === fixtureTag
    && ((row.code === sourceWarehouseCode && row.name === sourceWarehouseName)
      || (row.code === targetWarehouseCode && row.name === targetWarehouseName))), "cleanup refused a warehouse without exact UUID/code/name/fixture ownership", warehouses);
  const warehouseIds = warehouses.map((row) => row.id);
  const ownedWarehouseIdSet = new Set(warehouseIds);
  const warehouseSnapshots = dbJson(`
    SELECT COALESCE(jsonb_agg(to_jsonb(warehouse_row) ORDER BY warehouse_row.id), '[]'::jsonb)::text
    FROM public.md_warehouse warehouse_row
    WHERE warehouse_row.id=ANY(${uuidArray(warehouseIds)})
       OR warehouse_row.code IN (${sqlLiteral(sourceWarehouseCode)}, ${sqlLiteral(targetWarehouseCode)})
  `) ?? [];
  assert(warehouseSnapshots.length === warehouseIds.length
    && warehouseSnapshots.every((row) => ownedWarehouseIdSet.has(String(row.id))
      && row.remark === fixtureTag
      && ((row.code === sourceWarehouseCode && row.name === sourceWarehouseName)
        || (row.code === targetWarehouseCode && row.name === targetWarehouseName))),
  "cleanup refused a changed or colliding complete warehouse snapshot", warehouseSnapshots);
  const sourceWarehouse = warehouses.find((row) => row.code === sourceWarehouseCode);
  const targetWarehouse = warehouses.find((row) => row.code === targetWarehouseCode);
  if (createdWarehouseIds.size > 0) {
    assert(createdWarehouseIds.size === 2 && sourceWarehouse && targetWarehouse, "cleanup requires both created warehouse UUIDs", warehouses);
  }
  const documentHeaderIds = new Set(documents.map((row) => row.headerId));
  assert(documentHeaderIds.size <= 2, "cleanup refused more transfer headers than this run can create", documents);
  assert(documents.length === documentHeaderIds.size && documents.every((row) => uuidPattern.test(row.headerId)
    && uuidPattern.test(row.lineId)
    && /^ZJDB\d{6}$/.test(row.billNo)
    && row.billDate === billDate
    && Number(row.lineNo) === 1
    && row.productId === productId
    && row.sourceWarehouseId === sourceWarehouse.id
      && row.targetWarehouseId === targetWarehouse.id
      && Number(row.qty) > 0), "cleanup refused a transfer line outside the exact current document closure", documents);
  const documentIds = [...documentHeaderIds].sort();
  const headerSnapshots = dbJson(`
    SELECT COALESCE(jsonb_agg(to_jsonb(header) ORDER BY header.id), '[]'::jsonb)::text
    FROM public.stock_transfer header
    WHERE header.department=${sqlLiteral(fixtureTag)}
       OR header.id IN (
         SELECT line.bill_id FROM public.stock_transfer_line line
         WHERE line.source_warehouse_id=ANY(${uuidArray(warehouseIds)})
            OR line.target_warehouse_id=ANY(${uuidArray(warehouseIds)})
       )
  `) ?? [];
  assert(JSON.stringify(headerSnapshots.map((row) => String(row.id)).sort()) === JSON.stringify(documentIds),
    "cleanup refused a transfer header outside the complete run closure", headerSnapshots);
  const lineSnapshots = dbJson(`
    SELECT COALESCE(jsonb_agg(to_jsonb(line) ORDER BY line.id), '[]'::jsonb)::text
    FROM public.stock_transfer_line line
    WHERE line.bill_id=ANY(${uuidArray(documentIds)})
       OR line.source_warehouse_id=ANY(${uuidArray(warehouseIds)})
       OR line.target_warehouse_id=ANY(${uuidArray(warehouseIds)})
  `) ?? [];
  assert(JSON.stringify(lineSnapshots.map((row) => String(row.id)).sort())
      === JSON.stringify(documents.map((row) => row.lineId).sort()),
  "cleanup refused a transfer line outside the complete run closure", lineSnapshots);
  const lineById = new Map(documents.map((row) => [row.lineId, row]));
  const transactions = warehouseIds.length === 0 ? [] : dbJson(`
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
      'id', txn.id::text,
      'accountSetId', txn.account_set_id::text,
      'productId', txn.product_id::text,
      'txnType', txn.txn_type,
      'sourceBillType', txn.source_bill_type,
      'sourceBillId', txn.source_bill_id::text,
      'sourceBillLineId', txn.source_bill_line_id::text,
      'sourceBillNo', txn.source_bill_no,
      'sourceBillDate', txn.source_bill_date::text,
      'warehouseId', txn.warehouse_id::text,
      'warehouseCode', (SELECT code FROM public.md_warehouse WHERE id=txn.warehouse_id),
      'qtyDelta', txn.qty_delta::text,
      'traceQuality', txn.trace_quality,
      'postingAction', txn.posting_action,
      'reversalOfTxnId', txn.reversal_of_txn_id::text
    ) ORDER BY txn.id::text), '[]'::jsonb)::text
    FROM public.inv_stock_txn txn
    WHERE txn.warehouse_id=ANY(${uuidArray(warehouseIds)})
  `) ?? [];
  const formalRows = [];
  const seedRows = [];
  const transferSpecs = {
    STOCK_TRANSFER_OUT: { action: "AUDIT", warehouseId: sourceWarehouse?.id, qtyFactor: -1, reverseOf: null },
    STOCK_TRANSFER_IN: { action: "AUDIT", warehouseId: targetWarehouse?.id, qtyFactor: 1, reverseOf: null },
    STOCK_TRANSFER_IN_REVERSE: { action: "REVERSE", warehouseId: targetWarehouse?.id, qtyFactor: -1, reverseOf: "STOCK_TRANSFER_IN" },
    STOCK_TRANSFER_OUT_REVERSE: { action: "REVERSE", warehouseId: sourceWarehouse?.id, qtyFactor: 1, reverseOf: "STOCK_TRANSFER_OUT" }
  };
  for (const txn of transactions) {
    assert(uuidPattern.test(txn.id), "cleanup transaction must expose a UUID", txn);
    assert(txn.accountSetId === accountSetId && txn.productId === productId && ownedWarehouseIdSet.has(txn.warehouseId), "cleanup refused a foreign transfer transaction scope", txn);
    if (txn.sourceBillType === seedSourceType) {
      assertSeedTransaction(txn, sourceWarehouse.id);
      seedRows.push(txn);
      capturedTxnIds.add(txn.id);
      continue;
    }
    const sourceLine = lineById.get(txn.sourceBillLineId);
    const spec = transferSpecs[txn.txnType];
    assert(txn.sourceBillType === "STOCK_TRANSFER"
      && sourceLine
      && sourceLine.headerId === txn.sourceBillId
      && txn.sourceBillNo === sourceLine.billNo
      && txn.sourceBillDate === sourceLine.billDate
      && txn.traceQuality === "EXACT"
      && spec
      && txn.postingAction === spec.action
      && txn.warehouseId === spec.warehouseId
      && Number(txn.qtyDelta) === Number(sourceLine.qty) * spec.qtyFactor,
    "cleanup refused a transfer fact outside the exact current header/line/source/action closure", { txn, sourceLine });
    formalRows.push(txn);
    capturedTxnIds.add(txn.id);
  }
  assert(seedRows.length <= 1, "cleanup refused duplicate TEST seed facts", seedRows);
  for (const line of documents) {
    const rows = formalRows.filter((txn) => txn.sourceBillLineId === line.lineId);
    const byType = new Map();
    for (const row of rows) {
      assert(!byType.has(row.txnType), "cleanup refused duplicate transfer posting facts", rows);
      byType.set(row.txnType, row);
    }
    assert(rows.length === 0 || rows.length === 2 || rows.length === 4, "cleanup refused an incomplete transfer posting set", rows);
    if (rows.length >= 2) {
      assert(byType.has("STOCK_TRANSFER_OUT") && byType.has("STOCK_TRANSFER_IN"), "transfer posting set must contain both exact audit legs", rows);
      assert(byType.get("STOCK_TRANSFER_OUT").reversalOfTxnId === null
        && byType.get("STOCK_TRANSFER_IN").reversalOfTxnId === null, "transfer audit legs must not claim reversal links", rows);
    }
    if (rows.length === 4) {
      assert(byType.has("STOCK_TRANSFER_IN_REVERSE") && byType.has("STOCK_TRANSFER_OUT_REVERSE"), "transfer reverse set must contain both exact reverse legs", rows);
      assert(byType.get("STOCK_TRANSFER_IN_REVERSE").reversalOfTxnId === byType.get("STOCK_TRANSFER_IN").id
        && byType.get("STOCK_TRANSFER_OUT_REVERSE").reversalOfTxnId === byType.get("STOCK_TRANSFER_OUT").id,
      "transfer reverse facts must pair with the exact same-line forward facts", rows);
    }
  }
  const transactionSnapshots = dbJson(`
    SELECT COALESCE(jsonb_agg(to_jsonb(txn) ORDER BY txn.id), '[]'::jsonb)::text
    FROM public.inv_stock_txn txn
    WHERE txn.warehouse_id=ANY(${uuidArray(warehouseIds)})
       OR txn.source_bill_id=ANY(${uuidArray(documentIds)})
  `) ?? [];
  assert(JSON.stringify(transactionSnapshots.map((row) => String(row.id)).sort())
      === JSON.stringify(transactions.map((row) => row.id).sort()),
  "cleanup refused an inventory transaction outside the complete transfer closure", transactionSnapshots);
  const balances = warehouseIds.length === 0 ? [] : dbJson(`
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
      'id', id::text,
      'accountSetId', account_set_id::text,
      'productId', product_id::text,
      'warehouseId', warehouse_id::text
    ) ORDER BY id::text), '[]'::jsonb)::text
    FROM public.inv_stock_balance WHERE warehouse_id=ANY(${uuidArray(warehouseIds)})
  `) ?? [];
  assert(balances.every((row) => row.accountSetId === accountSetId && row.productId === productId && ownedWarehouseIdSet.has(row.warehouseId)), "cleanup refused a foreign transfer balance scope", balances);
  const balanceSnapshots = dbJson(`
    SELECT COALESCE(jsonb_agg(to_jsonb(balance) ORDER BY balance.id), '[]'::jsonb)::text
    FROM public.inv_stock_balance balance
    WHERE balance.warehouse_id=ANY(${uuidArray(warehouseIds)})
  `) ?? [];
  assert(JSON.stringify(balanceSnapshots.map((row) => String(row.id)).sort())
      === JSON.stringify(balances.map((row) => row.id).sort()),
  "cleanup refused a stock balance outside the complete transfer closure", balanceSnapshots);
  const billNos = [...new Set(documents.map((row) => row.billNo))];
  const documentLogs = documentIds.length === 0 ? [] : dbJson(`
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
      'id', id::text,
      'operatedBy', operated_by::text,
      'actorType', actor_type,
      'actorUsername', actor_username,
      'accountSetId', account_set_id::text,
      'accountSetCode', account_set_code
    ) ORDER BY id::text), '[]'::jsonb)::text
    FROM public.sys_operation_log
    WHERE account_set_id=${sqlLiteral(accountSetId)}::uuid
      AND target_type=${sqlLiteral(operationTargetType)}
      AND target_id=ANY(${uuidArray(documentIds)})
      AND target_no=ANY(${textArray(billNos)})
  `) ?? [];
  for (const log of documentLogs) {
    assert(uuidPattern.test(log.id)
      && log.operatedBy === fixtureUserId
      && log.actorType === "USER"
      && log.actorUsername === fixtureUsername
      && log.accountSetId === accountSetId
      && log.accountSetCode === "BLD-TEST", "cleanup document operation log must belong to the exact fixture admin", log);
    capturedLogIds.add(log.id);
  }
  const actorLogs = dbJson(`
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
      'id', id::text,
      'operatedBy', operated_by::text,
      'actorType', actor_type,
      'actorUsername', actor_username
    ) ORDER BY id::text), '[]'::jsonb)::text
    FROM public.sys_operation_log
    WHERE operated_by=${sqlLiteral(fixtureUserId)}::uuid OR actor_username=${sqlLiteral(fixtureUsername)}
  `) ?? [];
  for (const log of actorLogs) {
    assert(uuidPattern.test(log.id)
      && log.operatedBy === fixtureUserId
      && log.actorType === "USER"
      && log.actorUsername === fixtureUsername, "cleanup refused an operation log outside the exact fixture actor UUID/username", log);
    capturedLogIds.add(log.id);
  }
  const failureLogs = shortageFailureLog === null ? [] : (dbJson(`
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
      'id', id::text,
      'module', module_code,
      'action', action_code,
      'targetType', target_type,
      'targetId', target_id::text,
      'targetNo', target_no,
      'success', success,
      'reason', failure_reason,
      'accountSetId', account_set_id::text,
      'accountSetCode', account_set_code,
      'actorType', actor_type,
      'actorUsername', actor_username
    )), '[]'::jsonb)::text
    FROM public.sys_operation_log WHERE id=${sqlLiteral(shortageFailureLog.id)}::uuid
  `) ?? []);
  assert(failureLogs.length === (shortageFailureLog === null ? 0 : 1), "cleanup shortage failure-log UUID must remain exact", failureLogs);
  for (const log of failureLogs) {
    assert(log.id === shortageFailureLog.id, "cleanup failure-log UUID changed", { log, shortageFailureLog });
    assertShortageFailureLog(log);
    capturedLogIds.add(log.id);
  }
  const logTargetIds = [...new Set([fixtureUserId, ...documentIds])].sort();
  const logTargetNos = [...new Set([fixtureUsername, ...billNos])].sort();
  const logSnapshots = dbJson(`
    SELECT COALESCE(jsonb_agg(to_jsonb(log_row) ORDER BY log_row.id), '[]'::jsonb)::text
    FROM public.sys_operation_log log_row
    WHERE log_row.operated_by=${sqlLiteral(fixtureUserId)}::uuid
       OR log_row.actor_username=${sqlLiteral(fixtureUsername)}
       OR log_row.target_id=ANY(${uuidArray(logTargetIds)})
       OR log_row.target_no=ANY(${textArray(logTargetNos)})
  `) ?? [];
  for (const logRow of logSnapshots) {
    assert(uuidPattern.test(String(logRow.id))
      && String(logRow.operated_by ?? "") === fixtureUserId
      && logRow.actor_username === fixtureUsername,
    "cleanup refused an operation log outside the complete fixture actor closure", logRow);
    capturedLogIds.add(String(logRow.id));
  }
  assert(documentLogs.every((row) => logSnapshots.some((candidate) => String(candidate.id) === row.id))
      && actorLogs.every((row) => logSnapshots.some((candidate) => String(candidate.id) === row.id))
      && failureLogs.every((row) => logSnapshots.some((candidate) => String(candidate.id) === row.id)),
  "cleanup complete log snapshot must contain every previously captured run log", { documentLogs, actorLogs, failureLogs, logSnapshots });
  const lockSnapshots = dbJson(`
    SELECT COALESCE(jsonb_agg(to_jsonb(lock_row) ORDER BY lock_row.document_type, lock_row.bill_no), '[]'::jsonb)::text
    FROM public.doc_edit_lock lock_row
    WHERE (lock_row.document_type=${sqlLiteral(documentType)} AND lock_row.bill_no=ANY(${textArray(billNos)}))
       OR lock_row.holder_user_id=${sqlLiteral(fixtureUserId)}::uuid
       OR lock_row.holder_username=${sqlLiteral(fixtureUsername)}
  `) ?? [];
  for (const lockRow of lockSnapshots) {
    assert(String(lockRow.holder_user_id ?? "") === fixtureUserId
      && lockRow.holder_username === fixtureUsername,
    "cleanup refused an external or changed transfer document-lock holder", lockRow);
  }
  const snapshots = {
    users: fixtureUser.users,
    roleLinks: fixtureUser.roleLinks,
    grants: fixtureUser.grants,
    sessionScopes: fixtureUser.sessionScopes,
    warehouses: warehouseSnapshots,
    headers: headerSnapshots,
    lines: lineSnapshots,
    transactions: transactionSnapshots,
    balances: balanceSnapshots,
    logs: logSnapshots,
    locks: lockSnapshots
  };
  return { fixtureUser, documents, warehouses, transactions, balances, documentLogs, actorLogs, failureLogs,
    logTargetIds, logTargetNos, lockSnapshots, snapshots };
}

function cleanupFixtures() {
  result.cleanup.attempted = true;
  if (shortageAuditAttempted && shortageFailureLog === null) {
    const created = captureNewShortageFailureLogs();
    assert(created.length <= 1, "cleanup refused ambiguous new shortage endpoint failure logs", created);
    if (created.length === 1) {
      [shortageFailureLog] = created;
      capturedLogIds.add(shortageFailureLog.id);
      result.artifacts.shortageFailureLogId = shortageFailureLog.id;
    }
  }
  const state = discoverCleanupState();
  const documentIds = state.documents.map((row) => row.headerId);
  const lineIds = state.documents.map((row) => row.lineId);
  const billNos = state.documents.map((row) => row.billNo);
  const warehouseIds = state.warehouses.map((row) => row.id);
  const txnIds = state.transactions.map((row) => row.id).sort();
  const balanceIds = state.balances.map((row) => row.id).sort();
  const documentLogIds = state.documentLogs.map((row) => row.id).sort();
  const failureLogIds = state.failureLogs.map((row) => row.id).sort();
  const logIds = state.snapshots.logs.map((row) => String(row.id)).sort();
  const sessionTokens = state.snapshots.sessionScopes.map((row) => String(row.session_token)).sort();
  result.cleanup.capturedTxnIds = [...capturedTxnIds].sort();
  result.cleanup.capturedLogIds = [...capturedLogIds].sort();
  assert(txnIds.every((id) => capturedTxnIds.has(id)), "all cleanup inventory facts must have captured UUIDs", { txnIds, captured: result.cleanup.capturedTxnIds });
  assert(logIds.every((id) => capturedLogIds.has(id)), "all cleanup operation logs must have captured UUIDs", { logIds, captured: result.cleanup.capturedLogIds });

  dbScalar(`
    BEGIN;
    SET LOCAL lock_timeout='5s';
    SET LOCAL statement_timeout='30s';
    LOCK TABLE public.sys_account_set,
               public.sys_role,
               public.sys_user,
               public.sys_user_role,
               public.sys_user_account_set,
               public.sys_session_account_scope,
               public.md_warehouse,
               public.stock_transfer,
               public.stock_transfer_line,
               public.inv_stock_balance,
               public.inv_stock_txn,
               public.sys_operation_log,
               public.doc_edit_lock
      IN SHARE ROW EXCLUSIVE MODE;
    DO $a87_stock_transfer_cleanup$
    DECLARE
      expected_documents uuid[] := ${uuidArray(documentIds)};
      expected_lines uuid[] := ${uuidArray(lineIds)};
      expected_warehouses uuid[] := ${uuidArray(warehouseIds)};
      expected_txns uuid[] := ${uuidArray(txnIds)};
      expected_balances uuid[] := ${uuidArray(balanceIds)};
      expected_logs uuid[] := ${uuidArray(logIds)};
      expected_scopes uuid[] := ${uuidArray(sessionTokens)};
      expected_user uuid := ${sqlLiteral(fixtureUserId)}::uuid;
      expected_grant uuid := ${sqlLiteral(fixtureGrantId)}::uuid;
      expected_admin_role uuid := ${sqlLiteral(adminRoleId)}::uuid;
      actual jsonb;
    BEGIN
      SELECT COALESCE(jsonb_agg(to_jsonb(app_user) ORDER BY app_user.id), '[]'::jsonb) INTO actual
      FROM public.sys_user app_user
      WHERE app_user.id=expected_user OR app_user.username=${sqlLiteral(fixtureUsername)};
      IF actual IS DISTINCT FROM ${sqlLiteral(JSON.stringify(state.snapshots.users))}::jsonb THEN RAISE EXCEPTION 'A87 cleanup refused: complete user snapshot changed'; END IF;

      SELECT COALESCE(jsonb_agg(jsonb_build_object('link', to_jsonb(link), 'role', to_jsonb(role_row)) ORDER BY link.user_id, link.role_id), '[]'::jsonb) INTO actual
      FROM public.sys_user_role link JOIN public.sys_role role_row ON role_row.id=link.role_id
      WHERE link.user_id=expected_user;
      IF actual IS DISTINCT FROM ${sqlLiteral(JSON.stringify(state.snapshots.roleLinks))}::jsonb THEN RAISE EXCEPTION 'A87 cleanup refused: complete role-link snapshot changed'; END IF;

      SELECT COALESCE(jsonb_agg(jsonb_build_object('grant', to_jsonb(grant_row), 'accountSet', to_jsonb(account_set)) ORDER BY grant_row.id), '[]'::jsonb) INTO actual
      FROM public.sys_user_account_set grant_row JOIN public.sys_account_set account_set ON account_set.id=grant_row.account_set_id
      WHERE grant_row.user_id=expected_user;
      IF actual IS DISTINCT FROM ${sqlLiteral(JSON.stringify(state.snapshots.grants))}::jsonb THEN RAISE EXCEPTION 'A87 cleanup refused: complete account-set grant snapshot changed'; END IF;

      SELECT COALESCE(jsonb_agg(to_jsonb(scope_row) ORDER BY scope_row.session_token), '[]'::jsonb) INTO actual
      FROM public.sys_session_account_scope scope_row WHERE scope_row.user_id=expected_user;
      IF actual IS DISTINCT FROM ${sqlLiteral(JSON.stringify(state.snapshots.sessionScopes))}::jsonb THEN RAISE EXCEPTION 'A87 cleanup refused: complete session-scope snapshot changed'; END IF;

      SELECT COALESCE(jsonb_agg(to_jsonb(warehouse_row) ORDER BY warehouse_row.id), '[]'::jsonb) INTO actual
      FROM public.md_warehouse warehouse_row
      WHERE warehouse_row.id=ANY(expected_warehouses)
         OR warehouse_row.code IN (${sqlLiteral(sourceWarehouseCode)}, ${sqlLiteral(targetWarehouseCode)});
      IF actual IS DISTINCT FROM ${sqlLiteral(JSON.stringify(state.snapshots.warehouses))}::jsonb THEN RAISE EXCEPTION 'A87 cleanup refused: complete warehouse snapshot changed'; END IF;

      SELECT COALESCE(jsonb_agg(to_jsonb(header) ORDER BY header.id), '[]'::jsonb) INTO actual
      FROM public.stock_transfer header
      WHERE header.department=${sqlLiteral(fixtureTag)}
         OR header.id IN (SELECT line.bill_id FROM public.stock_transfer_line line WHERE line.source_warehouse_id=ANY(expected_warehouses) OR line.target_warehouse_id=ANY(expected_warehouses));
      IF actual IS DISTINCT FROM ${sqlLiteral(JSON.stringify(state.snapshots.headers))}::jsonb THEN RAISE EXCEPTION 'A87 cleanup refused: complete header snapshot changed'; END IF;

      SELECT COALESCE(jsonb_agg(to_jsonb(line) ORDER BY line.id), '[]'::jsonb) INTO actual
      FROM public.stock_transfer_line line
      WHERE line.bill_id=ANY(expected_documents)
         OR line.source_warehouse_id=ANY(expected_warehouses)
         OR line.target_warehouse_id=ANY(expected_warehouses);
      IF actual IS DISTINCT FROM ${sqlLiteral(JSON.stringify(state.snapshots.lines))}::jsonb THEN RAISE EXCEPTION 'A87 cleanup refused: complete line snapshot changed'; END IF;

      SELECT COALESCE(jsonb_agg(to_jsonb(txn) ORDER BY txn.id), '[]'::jsonb) INTO actual
      FROM public.inv_stock_txn txn
      WHERE txn.warehouse_id=ANY(expected_warehouses) OR txn.source_bill_id=ANY(expected_documents);
      IF actual IS DISTINCT FROM ${sqlLiteral(JSON.stringify(state.snapshots.transactions))}::jsonb THEN RAISE EXCEPTION 'A87 cleanup refused: complete transaction snapshot changed'; END IF;

      SELECT COALESCE(jsonb_agg(to_jsonb(balance) ORDER BY balance.id), '[]'::jsonb) INTO actual
      FROM public.inv_stock_balance balance WHERE balance.warehouse_id=ANY(expected_warehouses);
      IF actual IS DISTINCT FROM ${sqlLiteral(JSON.stringify(state.snapshots.balances))}::jsonb THEN RAISE EXCEPTION 'A87 cleanup refused: complete balance snapshot changed'; END IF;

      SELECT COALESCE(jsonb_agg(to_jsonb(log_row) ORDER BY log_row.id), '[]'::jsonb) INTO actual
      FROM public.sys_operation_log log_row
      WHERE log_row.operated_by=expected_user
         OR log_row.actor_username=${sqlLiteral(fixtureUsername)}
         OR log_row.target_id=ANY(${uuidArray(state.logTargetIds)})
         OR log_row.target_no=ANY(${textArray(state.logTargetNos)});
      IF actual IS DISTINCT FROM ${sqlLiteral(JSON.stringify(state.snapshots.logs))}::jsonb THEN RAISE EXCEPTION 'A87 cleanup refused: complete operation-log snapshot changed'; END IF;

      SELECT COALESCE(jsonb_agg(to_jsonb(lock_row) ORDER BY lock_row.document_type, lock_row.bill_no), '[]'::jsonb) INTO actual
      FROM public.doc_edit_lock lock_row
      WHERE (lock_row.document_type=${sqlLiteral(documentType)} AND lock_row.bill_no=ANY(${textArray(billNos)}))
         OR lock_row.holder_user_id=expected_user
         OR lock_row.holder_username=${sqlLiteral(fixtureUsername)};
      IF actual IS DISTINCT FROM ${sqlLiteral(JSON.stringify(state.snapshots.locks))}::jsonb THEN RAISE EXCEPTION 'A87 cleanup refused: complete document-lock snapshot changed'; END IF;

      DELETE FROM public.doc_edit_lock lock_row WHERE ${lockKeyPredicate("lock_row", state.lockSnapshots)};
      DELETE FROM public.sys_operation_log WHERE id=ANY(expected_logs);
      DELETE FROM public.sys_session_account_scope WHERE session_token=ANY(expected_scopes) AND user_id=expected_user;
      DELETE FROM public.inv_stock_txn WHERE id=ANY(expected_txns) AND warehouse_id=ANY(expected_warehouses);
      DELETE FROM public.stock_transfer_line WHERE id=ANY(expected_lines) AND bill_id=ANY(expected_documents);
      DELETE FROM public.stock_transfer WHERE id=ANY(expected_documents) AND department=${sqlLiteral(fixtureTag)};
      DELETE FROM public.inv_stock_balance WHERE id=ANY(expected_balances) AND account_set_id=${sqlLiteral(accountSetId)}::uuid AND product_id=${sqlLiteral(productId)}::uuid AND warehouse_id=ANY(expected_warehouses);
      DELETE FROM public.md_warehouse WHERE id=ANY(expected_warehouses) AND remark=${sqlLiteral(fixtureTag)};
      DELETE FROM public.sys_user_account_set WHERE id=expected_grant AND user_id=expected_user;
      DELETE FROM public.sys_user_role WHERE user_id=expected_user AND role_id=expected_admin_role;
      DELETE FROM public.sys_user WHERE id=expected_user AND username=${sqlLiteral(fixtureUsername)};

      IF EXISTS (SELECT 1 FROM public.stock_transfer WHERE id=ANY(expected_documents) OR department=${sqlLiteral(fixtureTag)})
         OR EXISTS (SELECT 1 FROM public.stock_transfer_line WHERE id=ANY(expected_lines) OR source_warehouse_id=ANY(expected_warehouses) OR target_warehouse_id=ANY(expected_warehouses))
         OR EXISTS (SELECT 1 FROM public.inv_stock_txn WHERE id=ANY(expected_txns) OR warehouse_id=ANY(expected_warehouses) OR source_bill_id=ANY(expected_documents))
         OR EXISTS (SELECT 1 FROM public.inv_stock_balance WHERE id=ANY(expected_balances) OR warehouse_id=ANY(expected_warehouses))
         OR EXISTS (SELECT 1 FROM public.md_warehouse WHERE id=ANY(expected_warehouses) OR code IN (${sqlLiteral(sourceWarehouseCode)}, ${sqlLiteral(targetWarehouseCode)}))
         OR EXISTS (SELECT 1 FROM public.sys_operation_log WHERE id=ANY(expected_logs) OR operated_by=expected_user OR actor_username=${sqlLiteral(fixtureUsername)} OR target_id=ANY(${uuidArray(state.logTargetIds)}) OR target_no=ANY(${textArray(state.logTargetNos)}))
         OR EXISTS (SELECT 1 FROM public.doc_edit_lock WHERE holder_user_id=expected_user OR holder_username=${sqlLiteral(fixtureUsername)} OR (document_type=${sqlLiteral(documentType)} AND bill_no=ANY(${textArray(billNos)})))
         OR EXISTS (SELECT 1 FROM public.sys_session_account_scope WHERE user_id=expected_user OR session_token=ANY(expected_scopes))
         OR EXISTS (SELECT 1 FROM public.sys_user_account_set WHERE user_id=expected_user)
         OR EXISTS (SELECT 1 FROM public.sys_user_role WHERE user_id=expected_user)
         OR EXISTS (SELECT 1 FROM public.sys_user WHERE id=expected_user OR username=${sqlLiteral(fixtureUsername)}) THEN
        RAISE EXCEPTION 'A87 cleanup closure is not zero';
      END IF;
    END;
    $a87_stock_transfer_cleanup$;
    COMMIT;
  `);

  const residue = {
    documents: dbNumber(`SELECT count(*) FROM public.stock_transfer WHERE department=${sqlLiteral(fixtureTag)}`),
    lines: lineIds.length ? dbNumber(`SELECT count(*) FROM public.stock_transfer_line WHERE id=ANY(${uuidArray(lineIds)})`) : 0,
    transactions: txnIds.length ? dbNumber(`SELECT count(*) FROM public.inv_stock_txn WHERE id=ANY(${uuidArray(txnIds)})`) : 0,
    balances: balanceIds.length ? dbNumber(`SELECT count(*) FROM public.inv_stock_balance WHERE id=ANY(${uuidArray(balanceIds)})`) : 0,
    warehouses: dbNumber(`SELECT count(*) FROM public.md_warehouse WHERE code IN (${sqlLiteral(sourceWarehouseCode)}, ${sqlLiteral(targetWarehouseCode)})`),
    locks: dbNumber(`SELECT count(*) FROM public.doc_edit_lock WHERE holder_user_id=${sqlLiteral(fixtureUserId)}::uuid OR holder_username=${sqlLiteral(fixtureUsername)} OR (document_type=${sqlLiteral(documentType)} AND bill_no=ANY(${textArray(billNos)}))`),
    logs: dbNumber(`SELECT count(*) FROM public.sys_operation_log WHERE id=ANY(${uuidArray(logIds)}) OR operated_by=${sqlLiteral(fixtureUserId)}::uuid OR actor_username=${sqlLiteral(fixtureUsername)} OR target_id=ANY(${uuidArray(state.logTargetIds)}) OR target_no=ANY(${textArray(state.logTargetNos)})`),
    actorLogs: dbNumber(`SELECT count(*) FROM public.sys_operation_log WHERE operated_by=${sqlLiteral(fixtureUserId)}::uuid OR actor_username=${sqlLiteral(fixtureUsername)}`),
    failureLogs: failureLogIds.length ? dbNumber(`SELECT count(*) FROM public.sys_operation_log WHERE id=ANY(${uuidArray(failureLogIds)})`) : 0,
    sessionScopes: dbNumber(`SELECT count(*) FROM public.sys_session_account_scope WHERE user_id=${sqlLiteral(fixtureUserId)}::uuid OR session_token=ANY(${uuidArray(sessionTokens)})`),
    userRoles: dbNumber(`SELECT count(*) FROM public.sys_user_role WHERE user_id=${sqlLiteral(fixtureUserId)}::uuid`),
    userGrants: dbNumber(`SELECT count(*) FROM public.sys_user_account_set WHERE user_id=${sqlLiteral(fixtureUserId)}::uuid OR id=${sqlLiteral(fixtureGrantId)}::uuid`),
    users: dbNumber(`SELECT count(*) FROM public.sys_user WHERE id=${sqlLiteral(fixtureUserId)}::uuid OR username=${sqlLiteral(fixtureUsername)}`)
  };
  result.cleanup.residue = residue;
  assert(Object.values(residue).every((value) => value === 0), "A87 transfer cleanup must leave zero residue", residue);
}

let primaryError = null;
try {
  await assertHealthBeforeSession();
  setupFixtureAdminUser();
  if (faultPhase === "after-identity") {
    throw new Error("A87 injected stock-transfer failure after fixture identity creation");
  }
  await installApiSession(apiBase, fixtureUsername, fixturePassword, "BLD-TEST");
  await assertAuthenticatedEnvironmentBeforeWrites();
  preflightAuthorized = true;
  await runScenario();
} catch (error) {
  primaryError = error;
  result.failure = error instanceof Error
    ? { name: error.name, message: error.message, stack: error.stack }
    : { message: String(error) };
} finally {
  if (browser) {
    await browser.close().catch(() => null);
    browser = null;
  }
  if (fixtureUserId) {
    try {
      cleanupFixtures();
    } catch (error) {
      result.cleanup.error = error instanceof Error ? error.message : String(error);
    }
  }
  result.ok = primaryError === null && result.cleanup.error === "" && result.cleanup.residue !== null
    && Object.values(result.cleanup.residue).every((value) => value === 0);
  await writeFile(resultPath, JSON.stringify(result, null, 2));
}

if (primaryError || result.cleanup.error) {
  throw new Error(`A87 stock transfer regression failed: ${primaryError?.message ?? "scenario passed"}; cleanup: ${result.cleanup.error || "ok"}`, { cause: primaryError ?? undefined });
}

console.log(JSON.stringify(result, null, 2));
