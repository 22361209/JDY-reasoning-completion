import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";
import {
  createIsolatedRoleSessionFixture
} from "./helpers/regression-auth.mjs";
import {
  captureA126Baseline,
  captureA126RunSnapshot,
  cleanupA126Run,
  validateA126RunSnapshot
} from "./helpers/a126-fixture-cleanup.mjs";

const rootDir = path.resolve(import.meta.dirname, "..");
const apiBase = "http://127.0.0.1:8080";
const frontendUrl = "http://127.0.0.1:5173/";
const billDate = "2026-07-01";
const productCode = "CP-001";
const warehouseCode = "CK-001";
const customerCode = "KH-001";
const batchTimestamp = new Date().toISOString().replace(/\D/g, "").slice(0, 14);
const runId = randomUUID();
const batch = `${batchTimestamp}-${runId.slice(0, 8)}`;
const marker = `A126:${runId}`;
const seedPrefix = `A126_SEED:${runId}:`;
const evidenceDir = path.join(rootDir, "verification");
const screenshotDir = path.join(evidenceDir, "playwright");
const resultPath = path.join(evidenceDir, `a126-sales-daily-usability-${batch}.json`);
const tempResultPath = `${resultPath}.tmp`;
const failurePoint = String(process.env.A126_TEST_FAILURE_POINT ?? "");
const allowedFailurePoints = new Set([
  "after-first-seed",
  "after-quote-server-commit-before-register",
  "after-notice-audit",
  "after-sales-out-audit",
  "after-red-audit",
  "before-browser"
]);
delete process.env.A126_TEST_FAILURE_POINT;
if (failurePoint) {
  if (process.env.JDY_REGRESSION_ALLOW_A126_FAILURES !== "1" || !allowedFailurePoints.has(failurePoint)) {
    throw new Error("A126 failure injection requires an explicit controlled marker and a whitelisted point");
  }
}
delete process.env.JDY_REGRESSION_ALLOW_A126_FAILURES;

let adminFixture = null;
let warehouseFixture = null;
let adminCookie = "";
let warehouseCookie = "";
let accountSetId = "";
let baseline = null;
let cleanupConfig = null;
const evidenceWriteErrors = [];
const evidence = {
  batch,
  batchTimestamp,
  runId,
  marker,
  generatedAt: new Date().toISOString(),
  data: {},
  artifacts: { intents: [] },
  cleanup: { attempted: false, success: false, phases: [] },
  assertions: [],
  screenshots: [],
  notes: []
};

async function persistEvidence() {
  await mkdir(evidenceDir, { recursive: true });
  await writeFile(tempResultPath, JSON.stringify(evidence, null, 2), { mode: 0o600 });
  await rename(tempResultPath, resultPath);
}

async function persistCleanupEvidence(label) {
  try {
    await persistEvidence();
  } catch (error) {
    evidenceWriteErrors.push({
      label,
      error: error instanceof Error ? error : new Error(String(error))
    });
  }
}

async function trackIntent(kind, operation) {
  const intent = {
    id: randomUUID(),
    kind,
    operation,
    state: "PENDING",
    createdAt: new Date().toISOString()
  };
  evidence.artifacts.intents.push(intent);
  await persistEvidence();
  return {
    async complete(details = {}) {
      intent.state = "COMPLETED";
      intent.completedAt = new Date().toISOString();
      Object.assign(intent, details);
      await persistEvidence();
    },
    async fail(error) {
      intent.state = "FAILED";
      intent.failedAt = new Date().toISOString();
      intent.error = error instanceof Error ? error.message : String(error);
      await persistEvidence();
    }
  };
}

function inject(point) {
  if (failurePoint === point) throw new Error(`A126 controlled failure injection: ${point}`);
}

function assert(condition, message, details = undefined) {
  if (!condition) {
    const suffix = details ? ` ${JSON.stringify(details)}` : "";
    throw new Error(`${message}${suffix}`);
  }
  evidence.assertions.push({ ok: true, message, details });
}

function numberOf(value) {
  if (value == null || value === "") return 0;
  return Number(String(value).replace(/,/g, ""));
}

async function api(cookie, pathname, options = {}) {
  const response = await fetch(`${apiBase}${pathname}`, {
    method: options.method ?? "POST",
    headers: {
      Cookie: cookie,
      ...(options.body ? { "Content-Type": "application/json" } : {})
    },
    body: options.body ? JSON.stringify(options.body) : undefined
  });
  const text = await response.text();
  let data = {};
  if (text.trim()) {
    try {
      data = JSON.parse(text);
    } catch {
      data = { raw: text };
    }
  }
  return { ok: response.ok, status: response.status, data, text };
}

async function requireApi(cookie, pathname, options = {}) {
  const result = await api(cookie, pathname, options);
  if (!result.ok) {
    throw new Error(`${options.method ?? "POST"} ${pathname} failed ${result.status}: ${result.text}`);
  }
  return result.data;
}

async function expectApiFailure(cookie, pathname, expectedStatuses, options = {}) {
  const { expectedReason, ...requestOptions } = options;
  const result = await api(cookie, pathname, requestOptions);
  const expected = Array.isArray(expectedStatuses) ? expectedStatuses : [expectedStatuses];
  assert(!result.ok && expected.includes(result.status), `${requestOptions.method ?? "POST"} ${pathname} should fail with ${expected.join("/")}`, {
    actualStatus: result.status,
    response: result.data
  });
  if (expectedReason) {
    assert(result.text.includes(expectedReason), `${requestOptions.method ?? "POST"} ${pathname} should report the formal business reason`, {
      expectedReason,
      response: result.data
    });
  }
  return result;
}

async function requireAdminConfirmation(pathname, reason) {
  const result = await api(adminCookie, pathname, {
    body: {
      username: adminFixture.username,
      password: adminFixture.password,
      reason
    }
  });
  if (!result.ok) throw new Error(`POST ${pathname} failed ${result.status}: ${result.text}`);
  return result.data;
}

async function expectAdminConfirmationFailure(pathname, expectedStatuses, {
  reason,
  invalidPassword = false,
  expectedReason = ""
}) {
  const result = await api(adminCookie, pathname, {
    body: {
      username: adminFixture.username,
      password: invalidPassword ? `${adminFixture.password}-wrong` : adminFixture.password,
      reason
    }
  });
  const expected = Array.isArray(expectedStatuses) ? expectedStatuses : [expectedStatuses];
  assert(!result.ok && expected.includes(result.status), `POST ${pathname} should fail with ${expected.join("/")}`, {
    actualStatus: result.status,
    response: result.data
  });
  if (expectedReason) {
    assert(result.text.includes(expectedReason), `POST ${pathname} should report the formal business reason`, {
      expectedReason,
      response: result.data
    });
  }
  return result;
}

function generatedBillNo(row, prefix, label) {
  const value = String(row?.billNo ?? "");
  assert(new RegExp(`^${prefix}\\d{6}$`).test(value), `${label} should return a system bill number`, row);
  return value;
}

function sqlValue(sql) {
  return execFileSync(
    "docker",
    ["exec", "jdy-erp-postgres", "psql", "-X", "-U", "jdy", "-d", "jdy_erp", "-v", "ON_ERROR_STOP=1", "-tAq", "-c", sql],
    { encoding: "utf8" }
  ).trim();
}

function stock() {
  const raw = sqlValue(`
    SELECT COALESCE(b.qty_on_hand, 0) || '|' || COALESCE(b.qty_reserved, 0) || '|' || COALESCE(b.qty_available, 0)
    FROM md_product p
    JOIN md_warehouse w ON w.code = '${warehouseCode}'
    LEFT JOIN inv_stock_balance b ON b.product_id = p.id AND b.warehouse_id = w.id AND b.account_set_id = '${accountSetId}'::uuid
    WHERE p.code = '${productCode}'
  `);
  assert(raw.includes("|"), "A126 controlled stock balance is unavailable", { raw });
  const [onHand, reserved, available] = raw.split("|").map(Number);
  assert([onHand, reserved, available].every(Number.isFinite), "A126 controlled stock balance is invalid", { raw });
  return { onHand, reserved, available };
}

function orderStats(orderNo) {
  const raw = sqlValue(`
    SELECT so.status || '|' || so.close_status || '|' || COALESCE(so.close_mode, '') || '|' || so.frozen_status || '|' || so.out_status || '|' ||
           COALESCE(sol.qty, 0) || '|' || COALESCE(sol.shipped_qty, 0) || '|' ||
           GREATEST(0, COALESCE(sol.qty, 0) - COALESCE(sol.shipped_qty, 0)) || '|' ||
           sol.line_close_status || '|' || sol.line_frozen_status
    FROM sales_order so
    JOIN sales_order_line sol ON sol.order_id = so.id AND sol.line_no = 1
    WHERE so.bill_no = '${orderNo}'
  `);
  const [status, closeStatus, closeMode, frozenStatus, outStatus, qty, shippedQty, remainingQty, lineCloseStatus, lineFrozenStatus] = raw.split("|");
  return {
    status,
    closeStatus,
    closeMode: closeMode || null,
    frozenStatus,
    outStatus,
    qty: Number(qty),
    shippedQty: Number(shippedQty),
    remainingQty: Number(remainingQty),
    lineCloseStatus,
    lineFrozenStatus
  };
}

async function listRow(listKey, billNo, view = "header") {
  const encoded = encodeURIComponent(billNo);
  const json = await requireApi(
    adminCookie,
    `/api/lists/${listKey}?keyword=${encoded}&view=${view}&pageSize=200`,
    { method: "GET" }
  );
  return (json.rows || []).find((row) => row.billNo === billNo) || null;
}

async function selectableSalesOrderLines(customerCodeValue = customerCode) {
  const result = await requireApi(
    adminCookie,
    `/api/sales-orders/selectable-lines?customerCode=${encodeURIComponent(customerCodeValue)}`,
    { method: "GET" }
  );
  return Array.isArray(result.lines) ? result.lines : [];
}

async function seedInventory(qtyDelta, label) {
  const intent = await trackIntent("inventory_seed", label);
  try {
    await requireApi(adminCookie, "/api/inventory/adjustments", {
      body: {
        productCode,
        warehouseCode,
        qtyDelta,
        txnType: "A126_SEED",
        sourceBillType: `${seedPrefix}${label}`
      }
    });
    await intent.complete({ qtyDelta, sourceBillType: `${seedPrefix}${label}` });
  } catch (error) {
    await intent.fail(error);
    throw error;
  }
  if (label === "main") inject("after-first-seed");
}

function line(qty, unitPrice = 86, extra = {}) {
  return {
    productCode,
    warehouseCode,
    qty,
    unitPrice,
    taxRate: 13,
    customerOrderNo: marker,
    lineRemark: marker,
    planDeliveryDate: "2026-07-10",
    ...extra
  };
}

async function createQuote(qty) {
  const intent = await trackIntent("sales_quote", "create-and-audit");
  try {
    const saved = await requireApi(adminCookie, "/api/sales-quotes/draft", {
      body: {
        billNo: null,
        customerCode,
        billDate,
        validUntil: "2026-12-31",
        department: "销售部",
        ownerName: adminFixture.expectedRole,
        remark: `${marker}:quote`,
        lines: [line(qty, 86)]
      }
    });
    inject("after-quote-server-commit-before-register");
    const quoteNo = generatedBillNo(saved, "XSBJ", "A126 sales quote");
    await requireApi(adminCookie, `/api/sales-quotes/${encodeURIComponent(quoteNo)}/audit`);
    await intent.complete({ id: saved.id, billNo: quoteNo });
    return quoteNo;
  } catch (error) {
    await intent.fail(error);
    throw error;
  }
}

async function createOrder(qty, sourceQuoteNo = "") {
  const intent = await trackIntent("sales_order", sourceQuoteNo ? "create-from-quote-and-audit" : "create-and-audit");
  try {
    const saved = await requireApi(adminCookie, "/api/sales-orders/draft", {
      body: {
        billNo: null,
        sourceOrderNo: sourceQuoteNo || undefined,
        customerCode,
        billDate,
        department: "销售部",
        ownerName: adminFixture.expectedRole,
        remark: `${marker}:order`,
        lines: [line(qty, 86, sourceQuoteNo ? { sourceOrderNo: sourceQuoteNo, sourceLineNo: 1 } : {})]
      }
    });
    const orderNo = generatedBillNo(saved, "XSDD", "A126 sales order");
    await requireApi(adminCookie, `/api/sales-orders/${encodeURIComponent(orderNo)}/audit`);
    await intent.complete({ id: saved.id, billNo: orderNo });
    return orderNo;
  } catch (error) {
    await intent.fail(error);
    throw error;
  }
}

async function createNotice(orderNo, qty, cookie = adminCookie) {
  const noticeNo = await saveNoticeDraft(orderNo, [line(qty, 86, { sourceOrderNo: orderNo, sourceLineNo: 1 })], cookie);
  const intent = await trackIntent("delivery_notice", `audit:${noticeNo}`);
  try {
    await requireApi(cookie, `/api/delivery-notices/${encodeURIComponent(noticeNo)}/audit`);
    await intent.complete({ billNo: noticeNo });
  } catch (error) {
    await intent.fail(error);
    throw error;
  }
  inject("after-notice-audit");
  return noticeNo;
}

async function saveNoticeDraft(orderNo, lines, cookie = adminCookie) {
  const intent = await trackIntent("delivery_notice", "save-draft");
  try {
    const saved = await requireApi(cookie, "/api/delivery-notices/draft", {
      body: {
        billNo: null,
        sourceOrderNo: orderNo,
        customerCode,
        billDate,
        department: "销售部",
        ownerName: cookie === warehouseCookie ? warehouseFixture.expectedRole : adminFixture.expectedRole,
        remark: `${marker}:notice`,
        lines
      }
    });
    const billNo = generatedBillNo(saved, "FHTZD", "A126 delivery notice");
    await intent.complete({ id: saved.id, billNo });
    return billNo;
  } catch (error) {
    await intent.fail(error);
    throw error;
  }
}

async function saveSalesOutDraft(noticeNo, lines, cookie = warehouseCookie) {
  const intent = await trackIntent("sales_out", "save-draft");
  try {
    const saved = await requireApi(cookie, "/api/sales-outs/draft", {
      body: {
        billNo: null,
        customerCode,
        billDate,
        department: "仓储部",
        ownerName: cookie === warehouseCookie ? warehouseFixture.expectedRole : adminFixture.expectedRole,
        remark: `${marker}:out`,
        lines
      }
    });
    const billNo = generatedBillNo(saved, "XSCKD", "A126 sales out");
    await intent.complete({ id: saved.id, billNo });
    return billNo;
  } catch (error) {
    await intent.fail(error);
    throw error;
  }
}

async function createSalesOut(noticeNo, qty, cookie = warehouseCookie) {
  const outNo = await saveSalesOutDraft(
    noticeNo,
    [line(qty, 86, { sourceDeliveryNoticeNo: noticeNo, sourceDeliveryLineNo: 1 })],
    cookie
  );
  const intent = await trackIntent("sales_out", `audit:${outNo}`);
  try {
    await requireApi(cookie, `/api/sales-outs/${encodeURIComponent(outNo)}/audit`);
    await intent.complete({ billNo: outNo });
  } catch (error) {
    await intent.fail(error);
    throw error;
  }
  inject("after-sales-out-audit");
  return outNo;
}

async function runMainFlow() {
  await seedInventory(300, "main");
  const before = stock();
  const quoteNo = await createQuote(12);
  const orderNo = await createOrder(12, quoteNo);
  const noticeNo = await createNotice(orderNo, 12);
  const afterNotice = stock();
  const outNo = await createSalesOut(noticeNo, 12);
  const afterOut = stock();
  const stats = orderStats(orderNo);
  assert(afterNotice.onHand === before.onHand, "发货通知审核不改变即时库存", { before, afterNotice });
  assert(afterNotice.reserved === before.reserved + 12, "发货通知审核增加预留库存", { before, afterNotice });
  assert(afterOut.onHand === afterNotice.onHand - 12, "销售出库审核扣减即时库存", { afterNotice, afterOut });
  assert(afterOut.reserved === afterNotice.reserved - 12, "销售出库审核释放对应预留库存", { afterNotice, afterOut });
  assert(stats.shippedQty === 12 && stats.remainingQty === 0 && stats.outStatus === "ALL_OUT", "主流程销售订单已出库/未出库数量正确", stats);
  assert(stats.closeStatus === "CLOSED" && stats.closeMode === "AUTO", "销售订单全部出库后自动关闭", stats);
  const blockedNoticeAfterAutoClose = await saveNoticeDraft(orderNo, [line(1, 86, { sourceOrderNo: orderNo, sourceLineNo: 1 })]);
  await expectApiFailure(adminCookie, `/api/delivery-notices/${encodeURIComponent(blockedNoticeAfterAutoClose)}/audit`, 409, {
    expectedReason: "源单或源单行已关闭/冻结，或源单未审核，不能继续下推或执行"
  });
  await expectApiFailure(adminCookie, `/api/document-lifecycle/salesOrder/${encodeURIComponent(orderNo)}/unclose`, 409, {
    body: { reason: "自动关闭不能手动反关闭" },
    expectedReason: "只有手动关闭的销售订单可以反关闭"
  });
  const orderDetail = await requireApi(adminCookie, `/api/sales-orders/${encodeURIComponent(orderNo)}`, { method: "GET" });
  const outDetail = await requireApi(adminCookie, `/api/sales-outs/${encodeURIComponent(outNo)}`, { method: "GET" });
  assert((orderDetail.lines?.[0]?.downstreamDocs ?? []).some((doc) => doc.billNo === noticeNo), "销售订单行能追踪到发货通知单", orderDetail.lines?.[0]?.downstreamDocs);
  assert(outDetail.lines?.[0]?.sourceDeliveryNoticeNo === noticeNo && outDetail.lines?.[0]?.sourceOrderNo === orderNo, "销售出库行保留发货通知和销售订单来源", outDetail.lines?.[0]);
  evidence.data.mainFlow = { quoteNo, orderNo, noticeNo, outNo, blockedNoticeAfterAutoClose, before, afterNotice, afterOut, stats };
  return evidence.data.mainFlow;
}

async function runPartialFlow() {
  await seedInventory(300, "partial");
  const orderNo = await createOrder(100);
  const n1 = await createNotice(orderNo, 30);
  const o1 = await createSalesOut(n1, 30);
  const afterFirst = orderStats(orderNo);
  assert(afterFirst.shippedQty === 30 && afterFirst.remainingQty === 70 && afterFirst.outStatus === "PART_OUT", "第一次出库后未出库数量为 70", afterFirst);
  const n2 = await createNotice(orderNo, 50);
  const o2 = await createSalesOut(n2, 50);
  const afterSecond = orderStats(orderNo);
  assert(afterSecond.shippedQty === 80 && afterSecond.remainingQty === 20 && afterSecond.outStatus === "PART_OUT", "第二次出库后未出库数量为 20", afterSecond);
  const overNoticeNo = await saveNoticeDraft(orderNo, [line(25, 86, { sourceOrderNo: orderNo, sourceLineNo: 1 })]);
  await expectApiFailure(adminCookie, `/api/delivery-notices/${encodeURIComponent(overNoticeNo)}/audit`, 409, {
    expectedReason: "发货通知数量不能超过销售订单剩余可通知数量"
  });
  const overOutNo = await saveSalesOutDraft(n2, [line(60, 86, { sourceDeliveryNoticeNo: n2, sourceDeliveryLineNo: 1 })]);
  await expectApiFailure(warehouseCookie, `/api/sales-outs/${encodeURIComponent(overOutNo)}/audit`, 409, {
    expectedReason: "销售出库数量不能超过发货通知剩余可出数量"
  });
  const headerRow = await listRow("sales-order-form-list", orderNo, "header");
  const detailRow = await listRow("sales-order-form-list", orderNo, "detail");
  assert(numberOf(headerRow?.shippedQty) === 80 && numberOf(headerRow?.remainingQty) === 20, "销售订单整单列表显示已出库/未出库数量", headerRow);
  assert(numberOf(detailRow?.shippedQty) === 80 && numberOf(detailRow?.remainingQty) === 20, "销售订单明细列表显示已出库/未出库数量", detailRow);
  evidence.data.partialFlow = { orderNo, notices: [n1, n2], outs: [o1, o2], afterFirst, afterSecond, headerRow, detailRow };
  return evidence.data.partialFlow;
}

async function runFullyNoticedPendingShipmentFlow() {
  await seedInventory(120, "fully-noticed-pending-shipment");
  const orderNo = await createOrder(100);
  const noticeNo = await createNotice(orderNo, 100);

  const stats = orderStats(orderNo);
  assert(stats.shippedQty === 0 && stats.remainingQty === 100, "已全量发货通知但未出库时，销售订单未出库数量仍按已出库事实计算", stats);
  assert(stats.closeStatus === "OPEN" && stats.closeMode === null, "已通知未出库不应自动关闭销售订单", stats);

  const orderDetail = await requireApi(adminCookie, `/api/sales-orders/${encodeURIComponent(orderNo)}`, { method: "GET" });
  const detailLine = orderDetail.lines?.[0] ?? {};
  assert(numberOf(detailLine.shippedQty) === 0, "销售订单详情显示已出库数量为 0", detailLine);
  assert(numberOf(detailLine.remainingQty) === 100, "销售订单详情未出库数量不被发货通知扣减", detailLine);
  assert(numberOf(detailLine.availableNoticeQty) === 0, "销售订单详情可通知数量已被发货通知扣完", detailLine);

  const headerRow = await listRow("sales-order-form-list", orderNo, "header");
  const detailRow = await listRow("sales-order-form-list", orderNo, "detail");
  assert(numberOf(headerRow?.shippedQty) === 0 && numberOf(headerRow?.remainingQty) === 100, "销售订单整单列表未出库数量不被发货通知扣减", headerRow);
  assert(numberOf(detailRow?.shippedQty) === 0 && numberOf(detailRow?.remainingQty) === 100, "销售订单明细列表未出库数量不被发货通知扣减", detailRow);

  const selectableLines = await selectableSalesOrderLines();
  assert(!selectableLines.some((line) => line.billNo === orderNo), "已全量发货通知的销售订单不再进入发货通知选源", selectableLines.filter((line) => line.billNo === orderNo));

  evidence.data.fullyNoticedPendingShipment = { orderNo, noticeNo, stats, detailLine, headerRow, detailRow };
  return evidence.data.fullyNoticedPendingShipment;
}

async function runNoticeDraftAndGroupedAuditGuardFlow() {
  const draftOrderNo = await createOrder(100);
  const draftNoticeNo = await saveNoticeDraft(draftOrderNo, [line(100, 86, { sourceOrderNo: draftOrderNo, sourceLineNo: 1 })]);

  const draftOrderDetail = await requireApi(adminCookie, `/api/sales-orders/${encodeURIComponent(draftOrderNo)}`, { method: "GET" });
  const draftLine = draftOrderDetail.lines?.[0] ?? {};
  assert(numberOf(draftLine.availableNoticeQty) === 100, "发货通知草稿不占用销售订单可通知量", draftLine);
  let selectableLines = await selectableSalesOrderLines();
  const selectableDraftLine = selectableLines.find((line) => line.billNo === draftOrderNo);
  assert(numberOf(selectableDraftLine?.availableNoticeQty ?? selectableDraftLine?.remainingQty) === 100, "草稿发货通知不影响销售订单选源可通知量", selectableDraftLine);

  await requireApi(adminCookie, `/api/delivery-notices/${encodeURIComponent(draftNoticeNo)}/audit`);
  const auditedOrderDetail = await requireApi(adminCookie, `/api/sales-orders/${encodeURIComponent(draftOrderNo)}`, { method: "GET" });
  assert(numberOf(auditedOrderDetail.lines?.[0]?.availableNoticeQty) === 0, "发货通知审核后才占用销售订单可通知量", auditedOrderDetail.lines?.[0]);

  const groupedOrderNo = await createOrder(100);
  const overNoticeNo = await saveNoticeDraft(groupedOrderNo, [
    line(80, 86, { sourceOrderNo: groupedOrderNo, sourceLineNo: 1 }),
    line(30, 86, { sourceOrderNo: groupedOrderNo, sourceLineNo: 1 })
  ]);
  await expectApiFailure(adminCookie, `/api/delivery-notices/${encodeURIComponent(overNoticeNo)}/audit`, 409, {
    expectedReason: "发货通知数量不能超过销售订单剩余可通知数量"
  });

  const okNoticeNo = await saveNoticeDraft(groupedOrderNo, [
    line(40, 86, { sourceOrderNo: groupedOrderNo, sourceLineNo: 1 }),
    line(60, 86, { sourceOrderNo: groupedOrderNo, sourceLineNo: 1 })
  ]);
  await requireApi(adminCookie, `/api/delivery-notices/${encodeURIComponent(okNoticeNo)}/audit`);

  evidence.data.noticeDraftAndGroupedAuditGuard = { draftOrderNo, draftNoticeNo, groupedOrderNo, overNoticeNo, okNoticeNo };
  return evidence.data.noticeDraftAndGroupedAuditGuard;
}

async function runCloseRemainingFlow() {
  await seedInventory(200, "close");
  const orderNo = await createOrder(100);
  const n1 = await createNotice(orderNo, 80);
  const o1 = await createSalesOut(n1, 80);
  await requireApi(adminCookie, `/api/document-lifecycle/salesOrder/${encodeURIComponent(orderNo)}/close`, {
    body: { reason: "客户接受少发，关闭剩余 20" }
  });
  const afterClose = orderStats(orderNo);
  assert(afterClose.closeStatus === "CLOSED" && afterClose.closeMode === "MANUAL", "销售订单剩余未发可手动关闭整单", afterClose);
  assert(afterClose.remainingQty === 20 && afterClose.lineCloseStatus === "OPEN", "手动关闭后未出库数量保留且不关闭行", afterClose);
  const blockedNotice = await saveNoticeDraft(orderNo, [line(1, 86, { sourceOrderNo: orderNo, sourceLineNo: 1 })]);
  await expectApiFailure(adminCookie, `/api/delivery-notices/${encodeURIComponent(blockedNotice)}/audit`, 409, {
    expectedReason: "源单或源单行已关闭/冻结，或源单未审核，不能继续下推或执行"
  });
  await requireApi(adminCookie, `/api/document-lifecycle/salesOrder/${encodeURIComponent(orderNo)}/unclose`, {
    body: { reason: "A126 手动反关闭恢复执行" }
  });
  const afterUnclose = orderStats(orderNo);
  assert(afterUnclose.closeStatus === "OPEN" && afterUnclose.closeMode === null && afterUnclose.remainingQty === 20, "手动关闭的销售订单可以反关闭且保留未出库数量", afterUnclose);
  evidence.data.closeRemaining = { orderNo, shippedOut: o1, afterClose, afterUnclose };
  return evidence.data.closeRemaining;
}

async function runRedReverseFlow() {
  await seedInventory(100, "red");
  const orderNo = await createOrder(10);
  const noticeNo = await createNotice(orderNo, 10);
  const beforeOut = stock();
  const outNo = await createSalesOut(noticeNo, 10);
  const afterOut = stock();
  const redIntent = await trackIntent("sales_out_red", `create-from:${outNo}`);
  let redDraft;
  let redNo;
  try {
    redDraft = await requireApi(warehouseCookie, `/api/sales-outs/${encodeURIComponent(outNo)}/red-reverse`, {
      body: { billDate, ownerName: warehouseFixture.expectedRole }
    });
    redNo = generatedBillNo(redDraft, "XSCKD", "A126 red sales out");
    await redIntent.complete({ id: redDraft.id, billNo: redNo, sourceBillNo: outNo });
  } catch (error) {
    await redIntent.fail(error);
    throw error;
  }
  const afterRedDraft = stock();
  await expectApiFailure(adminCookie, `/api/sales-outs/${encodeURIComponent(outNo)}/reverse`, 409, {
    expectedReason: "销售出库单已存在非作废红字单，不能反审核"
  });
  await expectApiFailure(warehouseCookie, "/api/sales-outs/draft", 409, {
    body: {
      billNo: redNo,
      customerCode,
      billDate,
      department: "仓储部",
      ownerName: warehouseFixture.expectedRole,
      remark: "A126 篡改红字草稿",
      lines: [line(20, 86, { sourceDeliveryNoticeNo: noticeNo, sourceDeliveryLineNo: 1 })]
    },
    expectedReason: "销售出库单红字草稿由来源单生成，不能通过普通保存修改"
  });
  const afterTamperedSaveBlocked = stock();
  const auditIntent = await trackIntent("sales_out_red", `audit:${redNo}`);
  try {
    await requireApi(warehouseCookie, `/api/sales-outs/${encodeURIComponent(redNo)}/audit`);
    await auditIntent.complete({ billNo: redNo });
  } catch (error) {
    await auditIntent.fail(error);
    throw error;
  }
  inject("after-red-audit");
  const afterRed = stock();
  const original = await requireApi(adminCookie, `/api/sales-outs/${encodeURIComponent(outNo)}`, { method: "GET" });
  const red = await requireApi(adminCookie, `/api/sales-outs/${encodeURIComponent(redNo)}`, { method: "GET" });
  assert(afterOut.onHand === beforeOut.onHand - 10, "错发场景原销售出库扣减库存", { beforeOut, afterOut });
  assert(afterRedDraft.onHand === afterOut.onHand, "红字草稿保存不动库存", { afterOut, afterRedDraft });
  assert(afterTamperedSaveBlocked.onHand === afterRedDraft.onHand, "篡改红字草稿保存失败不动库存", { afterRedDraft, afterTamperedSaveBlocked });
  assert(afterRed.onHand === beforeOut.onHand, "红冲后库存回退到出库前", { beforeOut, afterRed });
  assert(original.document?.redReverseBillNo === redNo, "原销售出库能看到红字单", original.document);
  assert(red.document?.redSourceBillNo === outNo && red.document?.status === "AUDITED", "红字单能追溯原销售出库且审核后生效", red.document);
  const afterRedOrder = orderStats(orderNo);
  assert(afterRedOrder.closeStatus === "OPEN" && afterRedOrder.closeMode === null && afterRedOrder.remainingQty === 10, "红冲导致未出库数量回升后自动关闭订单恢复未关闭", afterRedOrder);
  evidence.data.redReverse = { orderNo, noticeNo, outNo, redNo, beforeOut, afterOut, afterRedDraft, afterTamperedSaveBlocked, afterRed, afterRedOrder };
  return evidence.data.redReverse;
}

async function runFreezeFlow() {
  await seedInventory(100, "freeze");
  const orderNo = await createOrder(10);
  const beforeFreeze = stock();
  await requireApi(adminCookie, `/api/document-lifecycle/salesOrder/${encodeURIComponent(orderNo)}/freeze`, {
    body: { reason: "客户要求暂停发货" }
  });
  const afterFreeze = orderStats(orderNo);
  const frozenStock = stock();
  assert(afterFreeze.frozenStatus === "FROZEN" && afterFreeze.lineFrozenStatus === "FROZEN", "销售订单冻结状态写入单头和分录", afterFreeze);
  assert(JSON.stringify(beforeFreeze) === JSON.stringify(frozenStock), "冻结不改变库存数量", { beforeFreeze, frozenStock });
  const blockedNotice = await saveNoticeDraft(orderNo, [line(1, 86, { sourceOrderNo: orderNo, sourceLineNo: 1 })]);
  await expectApiFailure(adminCookie, `/api/delivery-notices/${encodeURIComponent(blockedNotice)}/audit`, 409, {
    expectedReason: "源单或源单行已关闭/冻结，或源单未审核，不能继续下推或执行"
  });
  await requireApi(adminCookie, `/api/document-lifecycle/salesOrder/${encodeURIComponent(orderNo)}/unfreeze`, {
    body: { reason: "客户恢复发货" }
  });
  const noticeNo = await createNotice(orderNo, 1);
  evidence.data.freeze = { orderNo, blockedNotice, noticeNo, afterFreeze };
  return evidence.data.freeze;
}

async function runVoidFlow() {
  const auditedNo = await createOrder(5);
  await expectAdminConfirmationFailure(`/api/document-lifecycle/salesOrder/${encodeURIComponent(auditedNo)}/void`, 409, {
    reason: "已审核不可作废",
    expectedReason: "只有草稿且无下游影响的单据可以作废"
  });
  const draftIntent = await trackIntent("sales_order", "save-voidable-draft");
  let draft;
  let draftNo;
  try {
    draft = await requireApi(adminCookie, "/api/sales-orders/draft", {
      body: {
        billNo: null,
        customerCode,
        billDate,
        department: "销售部",
        ownerName: adminFixture.expectedRole,
        remark: `${marker}:order`,
        lines: [line(3)]
      }
    });
    draftNo = generatedBillNo(draft, "XSDD", "A126 voidable sales order");
    await draftIntent.complete({ id: draft.id, billNo: draftNo });
  } catch (error) {
    await draftIntent.fail(error);
    throw error;
  }
  await expectAdminConfirmationFailure(`/api/document-lifecycle/salesOrder/${encodeURIComponent(draftNo)}/void`, [400, 401, 403, 409], {
    reason: "错误密码",
    invalidPassword: true,
    expectedReason: "当前密码不正确"
  });
  await requireAdminConfirmation(
    `/api/document-lifecycle/salesOrder/${encodeURIComponent(draftNo)}/void`,
    "A126 草稿作废"
  );
  const voided = await requireApi(adminCookie, `/api/sales-orders/${encodeURIComponent(draftNo)}`, { method: "GET" });
  assert(voided.order?.status === "VOID", "草稿销售订单经账号密码原因校验后可作废", voided.order);
  const downstreamNo = await createOrder(5);
  const downstreamNotice = await createNotice(downstreamNo, 1);
  await expectAdminConfirmationFailure(`/api/document-lifecycle/salesOrder/${encodeURIComponent(downstreamNo)}/void`, 409, {
    reason: "已有下游不可作废",
    expectedReason: "已有下游影响，禁止作废"
  });
  const { outDraftNo, noticeNo: outNotice } = await createSalesOutDraftForVoid();
  await expectApiFailure(warehouseCookie, `/api/sales-outs/${encodeURIComponent(outDraftNo)}/void`, [400, 401, 403, 409], {
    body: {},
    expectedReason: "当前密码不正确"
  });
  await requireApi(warehouseCookie, `/api/sales-outs/${encodeURIComponent(outDraftNo)}/void`, {
    body: { username: warehouseFixture.username, password: warehouseFixture.password, reason: "A126 销售出库草稿作废" }
  });
  const outVoided = await requireApi(adminCookie, `/api/sales-outs/${encodeURIComponent(outDraftNo)}`, { method: "GET" });
  assert(outVoided.document?.status === "VOID", "销售出库旧作废入口同样要求账号密码原因并走统一作废", outVoided.document);
  evidence.data.void = { draftNo, auditedNo, downstreamNo, downstreamNotice, outDraftNo, outNotice };
  return evidence.data.void;
}

async function createSalesOutDraftForVoid() {
  await seedInventory(50, "void-sales-out");
  const orderNo = await createOrder(3);
  const noticeNo = await createNotice(orderNo, 3);
  const outDraftNo = await saveSalesOutDraft(noticeNo, [line(3, 86, { sourceDeliveryNoticeNo: noticeNo, sourceDeliveryLineNo: 1 })]);
  return { orderNo, noticeNo, outDraftNo };
}

async function runPermissionFlow() {
  await expectApiFailure(warehouseCookie, "/api/sales-orders/draft", 403, {
    body: {
      billNo: null,
      customerCode,
      billDate,
      department: "销售部",
      ownerName: warehouseFixture.expectedRole,
      lines: [line(1)]
    },
    expectedReason: "当前角色无权执行该操作：sales.order.audit"
  });
  await expectApiFailure(warehouseCookie, `/api/sales-orders/${encodeURIComponent(evidence.data.mainFlow.orderNo)}/audit`, 403, {
    expectedReason: "当前角色无权执行该操作：sales.order.audit"
  });
  evidence.data.permissions = {
    salesOperator: `${adminFixture.username}/系统管理员模拟销售人员`,
    warehouseOperator: `${warehouseFixture.username}/仓库员`,
    warehouseSalesOrderDraftBlocked: true,
    warehouseSalesOrderAuditBlocked: true
  };
  evidence.notes.push("当前系统尚无独立 SALES 角色/账号，本轮以 run-owned ADMIN 模拟销售人员，以 run-owned WAREHOUSE 执行仓库链路。");
}

async function runPageUsabilityFlow() {
  const main = evidence.data.mainFlow;
  const [
    salesOrderHeader,
    salesOrderDetail,
    deliveryNoticeHeader,
    deliveryNoticeDetail,
    salesOutHeader,
    salesOutDetail
  ] = await Promise.all([
    listRow("sales-order-form-list", main.orderNo, "header"),
    listRow("sales-order-form-list", main.orderNo, "detail"),
    listRow("delivery-notice-form-list", main.noticeNo, "header"),
    listRow("delivery-notice-form-list", main.noticeNo, "detail"),
    listRow("sales-out-form-list", main.outNo, "header"),
    listRow("sales-out-form-list", main.outNo, "detail")
  ]);
  const lists = {
    salesOrderHeader,
    salesOrderDetail,
    deliveryNoticeHeader,
    deliveryNoticeDetail,
    salesOutHeader,
    salesOutDetail
  };
  assert(Boolean(lists.salesOrderHeader?.status && lists.salesOrderHeader?.customer && lists.salesOrderHeader?.qty), "销售订单列表可见状态、客户、数量", lists.salesOrderHeader);
  assert(Boolean(lists.salesOrderHeader?.shippedQty !== undefined && lists.salesOrderHeader?.remainingQty !== undefined), "销售订单列表可见已出库/未出库数量", lists.salesOrderHeader);
  assert(Boolean(lists.deliveryNoticeHeader?.closeStatus !== undefined && lists.deliveryNoticeHeader?.frozenStatus !== undefined), "发货通知列表返回关闭/冻结状态", lists.deliveryNoticeHeader);
  assert(Boolean(lists.salesOutHeader?.status && lists.salesOutHeader?.sourceBillNo), "销售出库列表可见状态和源单", lists.salesOutHeader);
  evidence.data.pageUsability = { lists };
  await captureScreenshots(main);
}

async function captureScreenshots(main) {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  try {
    await adminFixture.installInBrowser(context, "BLD-TEST");
    const page = await context.newPage();
    await page.goto(frontendUrl, { waitUntil: "domcontentloaded" });
    const session = await page.evaluate(async () => {
      const response = await fetch("/api/system/session");
      return { status: response.status, body: await response.json() };
    });
    assert(session.status === 200
      && session.body?.authenticated === true
      && session.body?.user?.username === adminFixture.username
      && session.body?.user?.roleCode === "ADMIN"
      && session.body?.tenant?.schemaName === "public", "A126 browser session must use the run-owned ADMIN in BLD-TEST", session);
    await openListAndScreenshot(page, "query-sales-order-form", "sales-order-form-list", main.orderNo, "sales-order-list");
    await openListAndScreenshot(page, "query-delivery-notice-form", "delivery-notice-form-list", main.noticeNo, "delivery-notice-list");
    await openListAndScreenshot(page, "query-sales-out-form", "sales-out-form-list", main.outNo, "sales-out-list");
  } finally {
    await context.close().catch(() => {});
    await browser.close();
  }
}

async function openListAndScreenshot(page, entryTestId, tabKey, billNo, name) {
  await page.getByTestId("module-销售管理").hover();
  await page.getByTestId(entryTestId).click();
  await page.getByTestId(`tab-${tabKey}`).waitFor({ state: "visible", timeout: 10000 });
  await page.getByTestId("list-keyword").fill(billNo);
  await page.getByTestId("list-keyword").press("Enter");
  await page.locator(".vxe-body--row", { hasText: billNo }).first().waitFor({ state: "visible", timeout: 10000 });
  const screenshot = `a126-${name}-${batch}.png`;
  await page.screenshot({ path: path.join(screenshotDir, screenshot), fullPage: true });
  evidence.screenshots.push(`verification/playwright/${screenshot}`);
}

async function setup() {
  await mkdir(evidenceDir, { recursive: true });
  await mkdir(screenshotDir, { recursive: true });
  await persistEvidence();
  adminFixture = createIsolatedRoleSessionFixture(apiBase, {
    label: "a126_admin",
    roleCode: "ADMIN",
    expectedRole: "系统管理员",
    accountSetCodes: ["BLD-TEST"],
    defaultAccountSetCode: "BLD-TEST",
    autoManageRequestFence: true,
    displayName: `A126 隔离管理员 ${runId}`
  });
  warehouseFixture = createIsolatedRoleSessionFixture(apiBase, {
    label: "a126_warehouse",
    roleCode: "WAREHOUSE",
    expectedRole: "仓库员",
    accountSetCodes: ["BLD-TEST"],
    defaultAccountSetCode: "BLD-TEST",
    autoManageRequestFence: true,
    displayName: `A126 隔离仓库员 ${runId}`
  });
  evidence.identities = {
    admin: { userId: adminFixture.userId, username: adminFixture.username, roleCode: adminFixture.roleCode },
    warehouse: { userId: warehouseFixture.userId, username: warehouseFixture.username, roleCode: warehouseFixture.roleCode }
  };
  await persistEvidence();
  adminCookie = await adminFixture.login("BLD-TEST");
  warehouseCookie = await warehouseFixture.login("BLD-TEST");
  const [adminSession, warehouseSession] = await Promise.all([
    requireApi(adminCookie, "/api/system/session", { method: "GET" }),
    requireApi(warehouseCookie, "/api/system/session", { method: "GET" })
  ]);
  accountSetId = String(adminSession?.tenant?.id ?? "");
  assert(/^[0-9a-f-]{36}$/i.test(accountSetId), "current session should expose account set id", { accountSetId });
  assert(adminSession?.tenant?.schemaName === "public" && adminSession?.tenant?.code === "BLD-TEST" && adminSession?.user?.roleCode === "ADMIN",
    "A126 ADMIN route must be BLD-TEST/public", adminSession);
  assert(warehouseSession?.tenant?.schemaName === "public" && warehouseSession?.tenant?.code === "BLD-TEST" && warehouseSession?.user?.roleCode === "WAREHOUSE",
    "A126 WAREHOUSE route must be BLD-TEST/public", warehouseSession);
  baseline = captureA126Baseline();
  assert(numberOf(baseline.balance.qty_available) === numberOf(baseline.balance.qty_on_hand) - numberOf(baseline.balance.qty_reserved),
    "A126 baseline stock quantities must satisfy available = on-hand - reserved", baseline.balance);
  cleanupConfig = {
    marker,
    seedPrefix,
    productCode,
    warehouseCode,
    billDate,
    startedAt: evidence.generatedAt,
    userIds: [adminFixture.userId, warehouseFixture.userId]
  };
  evidence.baseline = baseline;
  await persistEvidence();
}

async function run() {
  await runMainFlow();
  await persistEvidence();
  await runPartialFlow();
  await persistEvidence();
  await runFullyNoticedPendingShipmentFlow();
  await persistEvidence();
  await runNoticeDraftAndGroupedAuditGuardFlow();
  await persistEvidence();
  await runCloseRemainingFlow();
  await persistEvidence();
  await runRedReverseFlow();
  await persistEvidence();
  await runFreezeFlow();
  await persistEvidence();
  await runVoidFlow();
  await persistEvidence();
  await runPermissionFlow();
  await persistEvidence();
  inject("before-browser");
  await runPageUsabilityFlow();
  await persistEvidence();
}

function frozenSnapshotEvidence(snapshot, transform) {
  const rows = (key) => snapshot[key].map((row) => ({ id: row.id, billNo: row.bill_no })).sort((left, right) => String(left.id).localeCompare(String(right.id)));
  return {
    snapshotDigest: snapshot.snapshotDigest,
    transform,
    allowlist: {
      quotes: rows("quotes"),
      orders: rows("orders"),
      notices: rows("notices"),
      outs: rows("outs"),
      receivableIds: snapshot.receivables.map((row) => row.id).sort(),
      transactionIds: snapshot.transactions.map((row) => row.id).sort(),
      operationLogIds: snapshot.logs.map((row) => row.id).sort(),
      locks: snapshot.locks.map((row) => ({ documentType: row.document_type, billNo: row.bill_no, holderUserId: row.holder_user_id }))
    },
    external: snapshot.external,
    nonOwnedTransactions: snapshot.nonOwnedTransactions,
    currentBalance: snapshot.balance
  };
}

async function cleanup() {
  evidence.cleanup.attempted = true;
  const phaseErrors = [];
  let requestFencesClosed = true;
  for (const [label, fixture] of [["admin fence", adminFixture], ["warehouse fence", warehouseFixture]]) {
    if (!fixture) continue;
    try {
      const result = await fixture.closeAndDrainRequestFence();
      assert(result?.state === "CLOSED" && Number(result?.activeCount) === 0,
        `A126 ${label} did not reach a closed and drained request fence`, result);
      evidence.cleanup.phases.push({ label, ok: true, result });
    } catch (error) {
      requestFencesClosed = false;
      phaseErrors.push({ label, message: error instanceof Error ? error.message : String(error) });
    }
  }
  await persistCleanupEvidence("request fences");
  if (baseline && cleanupConfig && requestFencesClosed) {
    try {
      const snapshot = captureA126RunSnapshot(cleanupConfig);
      const transform = validateA126RunSnapshot({ baseline, snapshot, config: cleanupConfig });
      evidence.cleanup.frozen = frozenSnapshotEvidence(snapshot, transform);
      await persistEvidence();
      const result = cleanupA126Run({ baseline, snapshot, config: cleanupConfig });
      evidence.cleanup.phases.push({ label: "business facts and stock baseline", ok: true, result });
    } catch (error) {
      phaseErrors.push({ label: "business facts and stock baseline", message: error instanceof Error ? error.message : String(error) });
    }
  } else if (baseline && cleanupConfig) {
    phaseErrors.push({
      label: "business facts and stock baseline",
      message: "skipped fail-closed because every request fence was not proven CLOSED with zero active requests"
    });
  }
  await persistCleanupEvidence("business facts and stock baseline");
  for (const [label, fixture] of [["warehouse identity", warehouseFixture], ["admin identity", adminFixture]]) {
    if (!fixture) continue;
    try {
      const result = await fixture.cleanup({ allowForcedRedisRelease: true });
      evidence.cleanup.phases.push({ label, ok: true, result });
    } catch (error) {
      phaseErrors.push({ label, message: error instanceof Error ? error.message : String(error), cleanup: error?.cleanup });
    }
  }
  evidence.cleanup.phaseErrors = phaseErrors;
  evidence.cleanup.success = phaseErrors.length === 0;
  await persistCleanupEvidence("identity closure");
  if (phaseErrors.length > 0) throw new Error(`A126 cleanup did not close every phase ${JSON.stringify(phaseErrors)}`);
}

let runError = null;
let cleanupError = null;
let finalEvidenceError = null;
try {
  await setup();
  await run();
} catch (error) {
  runError = error;
  evidence.failure = {
    phase: "main",
    message: error instanceof Error ? error.message : String(error),
    stack: error instanceof Error ? error.stack : undefined
  };
}

try {
  await cleanup();
} catch (error) {
  cleanupError = error;
  evidence.cleanup.error = error instanceof Error ? error.message : String(error);
}

evidence.ok = !runError && !cleanupError;
evidence.completedAt = new Date().toISOString();
if (evidenceWriteErrors.length > 0) {
  evidence.ok = false;
  evidence.evidenceWriteErrors = evidenceWriteErrors.map(({ label, error }) => ({
    label,
    message: error.message
  }));
}
try {
  await persistEvidence();
} catch (error) {
  finalEvidenceError = error instanceof Error ? error : new Error(String(error));
}

const terminalErrors = [
  runError,
  cleanupError,
  ...evidenceWriteErrors.map(({ error }) => error),
  finalEvidenceError
].filter(Boolean);
if (terminalErrors.length > 1) throw new AggregateError(terminalErrors, "A126 run, cleanup, or evidence delivery failed");
if (terminalErrors.length === 1) throw terminalErrors[0];

console.log(JSON.stringify({
  ok: true,
  resultPath: path.relative(rootDir, resultPath),
  batch,
  cleanup: evidence.cleanup,
  data: evidence.data
}, null, 2));
