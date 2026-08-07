import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";
import {
  loginApi,
  loginAsAdmin,
  regressionAdminIdentity,
  requestWithRegressionAdminConfirmation
} from "./helpers/regression-auth.mjs";

const rootDir = path.resolve(import.meta.dirname, "..");
const apiBase = "http://127.0.0.1:8080";
const frontendUrl = "http://127.0.0.1:5173/";
const billDate = "2026-07-01";
const productCode = "CP-001";
const warehouseCode = "CK-001";
const customerCode = "KH-001";
const batch = new Date().toISOString().replace(/\D/g, "").slice(0, 14);
const evidenceDir = path.join(rootDir, "verification");
const screenshotDir = path.join(evidenceDir, "playwright");
const resultPath = path.join(evidenceDir, `a126-sales-daily-usability-${batch}.json`);
const adminIdentity = regressionAdminIdentity();

await mkdir(evidenceDir, { recursive: true });
await mkdir(screenshotDir, { recursive: true });

const adminCookie = await loginApi(apiBase);
const warehouseCookie = await loginApi(apiBase, "warehouse", "warehouse123");
const evidence = {
  batch,
  generatedAt: new Date().toISOString(),
  data: {},
  assertions: [],
  screenshots: [],
  notes: []
};

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

const adminSession = await requireApi(adminCookie, "/api/system/session", { method: "GET" });
const accountSetId = String(adminSession?.tenant?.id ?? "");
assert(/^[0-9a-f-]{36}$/i.test(accountSetId), "current session should expose account set id", { accountSetId });
assert(adminSession?.tenant?.schemaName === "public", "A126 direct SQL expects the BLD-TEST public schema", { schemaName: adminSession?.tenant?.schemaName });

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
  const result = await requestWithRegressionAdminConfirmation(apiBase, pathname, {
    sessionCookie: adminCookie,
    reason
  });
  if (!result.ok) throw new Error(`POST ${pathname} failed ${result.status}: ${result.text}`);
  return result.data;
}

async function expectAdminConfirmationFailure(pathname, expectedStatuses, {
  reason,
  invalidPassword = false,
  expectedReason = ""
}) {
  const result = await requestWithRegressionAdminConfirmation(apiBase, pathname, {
    sessionCookie: adminCookie,
    reason,
    invalidPassword
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
    ["exec", "jdy-erp-postgres", "psql", "-U", "jdy", "-d", "jdy_erp", "-tA", "-c", sql],
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
  const [onHand, reserved, available] = raw.split("|").map(Number);
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
  await requireApi(adminCookie, "/api/inventory/adjustments", {
    body: {
      productCode,
      warehouseCode,
      qtyDelta,
      txnType: "A126_SEED",
      sourceBillType: `A126_SEED:${batch}:${label}`
    }
  });
}

function line(qty, unitPrice = 86, extra = {}) {
  return {
    productCode,
    warehouseCode,
    qty,
    unitPrice,
    taxRate: 13,
    customerOrderNo: `KH-A126-${batch}`,
    lineRemark: "A126 日常可用性验收",
    planDeliveryDate: "2026-07-10",
    ...extra
  };
}

async function createQuote(qty) {
  const saved = await requireApi(adminCookie, "/api/sales-quotes/draft", {
    body: {
      billNo: null,
      customerCode,
      billDate,
      validUntil: "2026-12-31",
      department: "销售部",
      ownerName: "本地管理员",
      remark: "A126 报价源单",
      lines: [line(qty, 86)]
    }
  });
  const quoteNo = generatedBillNo(saved, "XSBJ", "A126 sales quote");
  await requireApi(adminCookie, `/api/sales-quotes/${encodeURIComponent(quoteNo)}/audit`);
  return quoteNo;
}

async function createOrder(qty, sourceQuoteNo = "") {
  const saved = await requireApi(adminCookie, "/api/sales-orders/draft", {
    body: {
      billNo: null,
      sourceOrderNo: sourceQuoteNo || undefined,
      customerCode,
      billDate,
      department: "销售部",
      ownerName: "本地管理员",
      remark: "A126 销售订单",
      lines: [line(qty, 86, sourceQuoteNo ? { sourceOrderNo: sourceQuoteNo, sourceLineNo: 1 } : {})]
    }
  });
  const orderNo = generatedBillNo(saved, "XSDD", "A126 sales order");
  await requireApi(adminCookie, `/api/sales-orders/${encodeURIComponent(orderNo)}/audit`);
  return orderNo;
}

async function createNotice(orderNo, qty, cookie = adminCookie) {
  const noticeNo = await saveNoticeDraft(orderNo, [line(qty, 86, { sourceOrderNo: orderNo, sourceLineNo: 1 })], cookie);
  await requireApi(cookie, `/api/delivery-notices/${encodeURIComponent(noticeNo)}/audit`);
  return noticeNo;
}

async function saveNoticeDraft(orderNo, lines, cookie = adminCookie) {
  const saved = await requireApi(cookie, "/api/delivery-notices/draft", {
    body: {
      billNo: null,
      sourceOrderNo: orderNo,
      customerCode,
      billDate,
      department: "销售部",
      ownerName: cookie === warehouseCookie ? "仓库操作员" : "本地管理员",
      remark: "A126 发货通知",
      lines
    }
  });
  return generatedBillNo(saved, "FHTZD", "A126 delivery notice");
}

async function saveSalesOutDraft(noticeNo, lines, cookie = warehouseCookie) {
  const saved = await requireApi(cookie, "/api/sales-outs/draft", {
    body: {
      billNo: null,
      customerCode,
      billDate,
      department: "仓储部",
      ownerName: cookie === warehouseCookie ? "仓库操作员" : "本地管理员",
      remark: "A126 销售出库",
      lines
    }
  });
  return generatedBillNo(saved, "XSCKD", "A126 sales out");
}

async function createSalesOut(noticeNo, qty, cookie = warehouseCookie) {
  const outNo = await saveSalesOutDraft(
    noticeNo,
    [line(qty, 86, { sourceDeliveryNoticeNo: noticeNo, sourceDeliveryLineNo: 1 })],
    cookie
  );
  await requireApi(cookie, `/api/sales-outs/${encodeURIComponent(outNo)}/audit`);
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
  const redDraft = await requireApi(warehouseCookie, `/api/sales-outs/${encodeURIComponent(outNo)}/red-reverse`, {
    body: { billDate, ownerName: "仓库操作员" }
  });
  const redNo = generatedBillNo(redDraft, "XSCKD", "A126 red sales out");
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
      ownerName: "仓库操作员",
      remark: "A126 篡改红字草稿",
      lines: [line(20, 86, { sourceDeliveryNoticeNo: noticeNo, sourceDeliveryLineNo: 1 })]
    },
    expectedReason: "销售出库单红字草稿由来源单生成，不能通过普通保存修改"
  });
  const afterTamperedSaveBlocked = stock();
  await requireApi(warehouseCookie, `/api/sales-outs/${encodeURIComponent(redNo)}/audit`);
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
  const draft = await requireApi(adminCookie, "/api/sales-orders/draft", {
    body: {
      billNo: null,
      customerCode,
      billDate,
      department: "销售部",
      ownerName: "本地管理员",
      lines: [line(3)]
    }
  });
  const draftNo = generatedBillNo(draft, "XSDD", "A126 voidable sales order");
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
    body: { username: "warehouse", password: "warehouse123", reason: "A126 销售出库草稿作废" }
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
      ownerName: "仓库操作员",
      lines: [line(1)]
    },
    expectedReason: "当前角色无权执行该操作：sales.order.audit"
  });
  await expectApiFailure(warehouseCookie, `/api/sales-orders/${encodeURIComponent(evidence.data.mainFlow.orderNo)}/audit`, 403, {
    expectedReason: "当前角色无权执行该操作：sales.order.audit"
  });
  evidence.data.permissions = {
    salesOperator: `${adminIdentity.username}/系统管理员模拟销售人员`,
    warehouseOperator: "warehouse/仓库员",
    warehouseSalesOrderDraftBlocked: true,
    warehouseSalesOrderAuditBlocked: true
  };
  evidence.notes.push("当前系统尚无独立 SALES 角色/账号，本轮以 run-scoped ADMIN 模拟销售人员，以 warehouse 模拟仓库人员。");
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
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  try {
    await page.goto(frontendUrl, { waitUntil: "domcontentloaded" });
    await loginAsAdmin(page);
    await openListAndScreenshot(page, "query-sales-order-form", "sales-order-form-list", main.orderNo, "sales-order-list");
    await openListAndScreenshot(page, "query-delivery-notice-form", "delivery-notice-form-list", main.noticeNo, "delivery-notice-list");
    await openListAndScreenshot(page, "query-sales-out-form", "sales-out-form-list", main.outNo, "sales-out-list");
  } finally {
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

await runMainFlow();
await runPartialFlow();
await runFullyNoticedPendingShipmentFlow();
await runNoticeDraftAndGroupedAuditGuardFlow();
await runCloseRemainingFlow();
await runRedReverseFlow();
await runFreezeFlow();
await runVoidFlow();
await runPermissionFlow();
await runPageUsabilityFlow();

await writeFile(resultPath, JSON.stringify(evidence, null, 2));
console.log(JSON.stringify({ ok: true, resultPath: path.relative(rootDir, resultPath), evidence }, null, 2));
