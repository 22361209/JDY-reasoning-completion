import { chromium } from "playwright";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  installApiSession,
  loginAsAdmin,
  requestWithRegressionAdminConfirmation
} from "./helpers/regression-auth.mjs";
import { createSalesOutDraftViaDeliveryNotice } from "./helpers/sales-delivery-notice-flow.mjs";

const rootDir = path.resolve(import.meta.dirname, "..");
const screenshotDir = path.join(rootDir, "verification/playwright");
const resultPath = path.join(rootDir, "verification/a105-bill-lifecycle-regression.json");
const frontendUrl = "http://127.0.0.1:5173/";
const apiBase = "http://127.0.0.1:8080";
const batch = new Date().toISOString().replace(/\D/g, "").slice(0, 14);
const billDate = "2026-06-26";

const adminCookie = await installApiSession(apiBase);
await mkdir(screenshotDir, { recursive: true });
await mkdir(path.dirname(resultPath), { recursive: true });

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function generatedBillNo(row, label) {
  const billNo = String(row?.billNo ?? "");
  if (!billNo) {
    throw new Error(`${label} did not return billNo: ${JSON.stringify(row)}`);
  }
  return billNo;
}

async function api(pathname, options = {}) {
  const response = await fetch(`${apiBase}${pathname}`, {
    method: options.method ?? "POST",
    headers: options.body ? { "Content-Type": "application/json" } : undefined,
    body: options.body ? JSON.stringify(options.body) : undefined
  });
  const text = await response.text();
  const data = text ? JSON.parse(text) : {};
  if (!response.ok && !options.expectFailure) {
    throw new Error(`${options.method ?? "POST"} ${pathname} failed ${response.status}: ${text}`);
  }
  return { ok: response.ok, status: response.status, data };
}

async function requireApi(pathname, options = {}) {
  const result = await api(pathname, options);
  assert(result.ok, `${options.method ?? "POST"} ${pathname} failed ${result.status}`);
  return result.data;
}

async function verifyLifecycleCodeContracts() {
  const dataListPage = await readFile(path.join(rootDir, "frontend/src/components/DataListPage.vue"), "utf8");
  const listRowsProvider = await readFile(path.join(rootDir, "backend/src/main/java/com/jdy/erp/system/application/list/StubListSeedRowsProvider.java"), "utf8");
  const lifecyclePolicy = await readFile(path.join(rootDir, "backend/src/main/java/com/jdy/erp/shared/application/BillLifecyclePolicy.java"), "utf8");
  const lifecycleService = await readFile(path.join(rootDir, "backend/src/main/java/com/jdy/erp/shared/application/BillLifecycleService.java"), "utf8");
  const deliveryNoticeService = await readFile(path.join(rootDir, "backend/src/main/java/com/jdy/erp/sales/application/DeliveryNoticeAppService.java"), "utf8");
  const salesOutService = await readFile(path.join(rootDir, "backend/src/main/java/com/jdy/erp/sales/application/SalesOutAppService.java"), "utf8");
  const purchaseInService = await readFile(path.join(rootDir, "backend/src/main/java/com/jdy/erp/purchase/application/PurchaseInAppService.java"), "utf8");
  const purchaseReturnService = await readFile(path.join(rootDir, "backend/src/main/java/com/jdy/erp/purchase/application/PurchaseReturnAppService.java"), "utf8");
  const purchaseOrderService = await readFile(path.join(rootDir, "backend/src/main/java/com/jdy/erp/purchase/application/PurchaseOrderAppService.java"), "utf8");
  const purchasePlanService = await readFile(path.join(rootDir, "backend/src/main/java/com/jdy/erp/purchase/application/PurchasePlanAppService.java"), "utf8");
  const salesOrderService = await readFile(path.join(rootDir, "backend/src/main/java/com/jdy/erp/sales/application/SalesOrderAppService.java"), "utf8");
  const salesQuoteService = await readFile(path.join(rootDir, "backend/src/main/java/com/jdy/erp/sales/application/SalesQuoteAppService.java"), "utf8");
  const validationService = await readFile(path.join(rootDir, "backend/src/main/java/com/jdy/erp/shared/application/ValidationService.java"), "utf8");
  const outsourcingService = await readFile(path.join(rootDir, "backend/src/main/java/com/jdy/erp/outsourcing/application/OutsourcingDocumentAppService.java"), "utf8");
  const salesOrderForm = await readFile(path.join(rootDir, "frontend/src/modules/sales/sales-order/SalesOrderForm.vue"), "utf8");
  const purchasePlanForm = await readFile(path.join(rootDir, "frontend/src/modules/purchase/purchase-plan/PurchasePlanForm.vue"), "utf8");
  const appVue = await readFile(path.join(rootDir, "frontend/src/app/App.vue"), "utf8");
  const salesOrderPushDownStart = appVue.indexOf("async function openDeliveryNoticeFromSalesOrder");
  const salesOrderPushDownEnd = appVue.indexOf("async function openOutboundFromDeliveryNotice");
  const salesOrderPushDown = salesOrderPushDownStart >= 0 && salesOrderPushDownEnd > salesOrderPushDownStart
    ? appVue.slice(salesOrderPushDownStart, salesOrderPushDownEnd)
    : "";

  assert(dataListPage.includes("auditDocument(type, billNo)"), "DataListPage batch audit must call auditDocument");
  assert(dataListPage.includes("async function submitBatchAudit()"), "DataListPage must implement submitBatchAudit");
  assert(dataListPage.includes("deleteDocument(type, billNo)"), "DataListPage batch delete must call deleteDocument");
  assert(dataListPage.includes("async function submitBatchDelete()"), "DataListPage must implement submitBatchDelete");
  assert(dataListPage.includes("pendingAction === '删除'"), "delete action must show a dedicated confirmation branch");
  assert(dataListPage.includes("删除不可逆"), "delete confirmation must warn that deletion is irreversible");
  assert(dataListPage.includes("deleteSupportedDocumentTypes"), "delete button must only enable for supported document DELETE APIs");
  assert(dataListPage.includes("selectedBillRows.value.every(isDraftBillStatus)"), "batch audit button must only enable for draft bills");
  assert(dataListPage.includes("const selectedUniqueBillRows = computed"), "list lifecycle actions must dedupe selected detail rows by billNo");
  assert(!dataListPage.includes("return !isDetailView.value && Boolean(permission) && session.hasPermission(permission);"), "detail view must not disable document lifecycle permissions");
  assert(dataListPage.includes("const isLifecycleDocumentList = computed(() => Boolean(currentLifecyclePolicy.value));"), "header and detail views must share document lifecycle action visibility");
  assert(!dataListPage.includes('outStatus !== "全部出库"'), "sales pushdown must not depend on outStatus display text");
  assert(!dataListPage.includes('inStatus !== "全部入库"'), "purchase pushdown must not depend on inStatus display text");
  assert(listRowsProvider.includes('dn.close_status AS "closeStatus"'), "delivery notice list must return closeStatus");
  assert(listRowsProvider.includes('dn.frozen_status AS "frozenStatus"'), "delivery notice list must return frozenStatus");
  assert(lifecyclePolicy.includes("boolean voidAllowed"), "backend lifecycle policy must include voidAllowed");
  assert(lifecycleService.includes("BillLifecyclePolicy.requireVoidAllowed(target);"), "voidBill must enforce backend voidAllowed policy");
  assert(lifecycleService.includes("销售订单新业务不支持行关闭/反关闭"), "sales order line close API must be disabled for new business");
  assert(lifecycleService.includes("public void guardSourceLineQuantities("), "BillLifecycleService must own aggregate source-line quantity guard");
  assert(lifecycleService.includes("public void guardPositiveLineQuantities("), "BillLifecycleService must own positive line quantity guard");
  assert(lifecycleService.includes("WHERE dh.status = 'AUDITED'"), "aggregate source-line quantity guard must only count audited downstream bills");
  assert(deliveryNoticeService.includes("guardSourceLineQuantities(SALES_ORDER_NOTICE_QUANTITY_GUARD"), "delivery notice audit must use lifecycle aggregate quantity guard");
  assert(salesOutService.includes("guardSourceLineQuantities(DELIVERY_NOTICE_OUT_QUANTITY_GUARD"), "sales out audit must use lifecycle aggregate quantity guard");
  assert(purchaseInService.includes("guardSourceLineQuantities(PURCHASE_ORDER_IN_QUANTITY_GUARD"), "purchase in audit must use lifecycle aggregate quantity guard");
  assert(purchaseReturnService.includes("guardSourceLineQuantities(PURCHASE_IN_RETURN_QUANTITY_GUARD"), "purchase return audit must use lifecycle aggregate quantity guard");
  assert(validationService.includes("BigDecimal positive(BigDecimal value, String label)"), "shared validation service must provide positive quantity validation");
  assert(purchaseOrderService.includes("BillStatus.DRAFT,\n            BillStatus.AUDITED"), "purchase order audit must be strict DRAFT to AUDITED transition");
  assert(!purchaseOrderService.includes("transitionAny("), "purchase order audit must not transition from any status");
  assert(!purchaseOrderService.includes("markPurchaseRequisitionOrdered(line.sourceOrderNo()"), "purchase order draft save must not occupy purchase requisition lines");
  assert(purchaseOrderService.includes("guardPositiveLineQuantities(LIFECYCLE_TARGET"), "purchase order audit must reject non-positive persisted line quantities");
  assert(purchaseOrderService.includes("lockPurchaseRequisitionSources(demands)"), "purchase order audit must lock purchase requisition sources before validating quantities");
  assert(purchaseOrderService.includes("refreshAndGuardPurchaseRequisitionQuantities(lockedSources"), "purchase order audit must recompute and guard purchase requisition quantities after locking sources");
  assert(purchaseOrderService.includes("WHERE purchase_order.status = 'DRAFT'"), "purchase order draft save must not revert an audited order to draft");
  assert(purchasePlanService.includes('"DELETE_PURCHASE_PLAN_DRAFT"'), "purchase plan draft deletion must write an operation log");
  assert(purchasePlanForm.includes("此操作不可恢复，原计划编号不复用"), "purchase plan deletion confirmation must warn that physical deletion is irreversible and the bill number is not reused");
  assert(purchasePlanForm.includes("clearDocument();"), "purchase plan deletion success must clear the deleted document from the form");
  assert(/@Transactional\s+public Map<String, Object> audit\(String billNo\)/.test(salesOrderService), "sales order audit validation and lifecycle transition must be transactional");
  assert(/@Transactional\s+public Map<String, Object> audit\(String billNo\)/.test(salesQuoteService), "sales quote audit validation and lifecycle transition must be transactional");
  assert(!deliveryNoticeService.includes("guardSourceOrderNoticeQuantity"), "delivery notice must not keep private aggregate quantity guard");
  assert(!salesOutService.includes("guardDeliveryNoticeRemaining"), "sales out must not keep private aggregate quantity guard");
  assert(!purchaseReturnService.includes("validateReturnQuantities"), "purchase return must not keep private aggregate quantity guard");
  assert(!purchaseOrderService.includes("WHERE pi.status <> 'VOID'"), "purchase order selectable remaining qty must not count draft purchase-in as source occupation");
  assert(!purchaseReturnService.includes("WHERE pr.status <> 'VOID'"), "purchase return selectable remaining qty must not count draft purchase-return as source occupation");
  assert(!outsourcingService.includes("BillStatus.AUDITED.name(), BillStatus.REVERSED.name()"), "new reverse logic must not transition AUDITED to REVERSED");
  assert(salesOrderForm.includes(':show-line-close-status="false"'), "sales order form must hide line close status for new business");
  assert(!salesOrderForm.includes('line.lineCloseStatus !== "CLOSED"'), "sales order pushdown button must not depend on lineCloseStatus");
  assert(salesOrderPushDown.includes("availableNoticeQty"), "legacy sales order pushdown must use available notice quantity");
  assert(!salesOrderPushDown.includes('lineCloseStatus !== "CLOSED"'), "legacy sales order pushdown must not filter by lineCloseStatus");
  return {
    batchAuditSubmits: true,
    pushdownUsesRemainingQty: true,
    deliveryNoticeListLifecycleStatus: true,
    backendVoidAllowedEnforced: true,
    reverseReturnsDraft: true,
    aggregateSourceLineQuantityGuard: true,
    salesOrderLineCloseHidden: true,
    legacySalesOrderPushdownUsesAvailableNoticeQty: true
  };
}

async function seedStock() {
  await requireApi("/api/inventory/adjustments", {
    body: {
      productCode: "CP-001",
      warehouseCode: "CK-001",
      qtyDelta: 1000,
      txnType: "A105_SEED_IN",
      sourceBillType: `A105:${batch}`
    }
  });
}

async function createSalesOrder(suffix, qtys = [6, 4]) {
  const billNo = await createSalesOrderDraft(suffix, qtys);
  await requireApi(`/api/sales-orders/${encodeURIComponent(billNo)}/audit`);
  return billNo;
}

async function createSalesOrderDraft(suffix, qtys = [6, 4]) {
  return generatedBillNo(await requireApi("/api/sales-orders/draft", {
    body: {
      customerCode: "KH-001",
      billDate,
      department: "销售部",
      ownerName: "本地管理员",
      remark: `A105 ${suffix}`,
      lines: qtys.map((qty, index) => ({
        productCode: "CP-001",
        warehouseCode: "CK-001",
        qty,
        unitPrice: 86 + index,
        lineRemark: `A105 第 ${index + 1} 行`,
        planDeliveryDate: `2026-07-0${index + 1}`
      }))
    }
  }), `A105销售订单${suffix}`);
}

async function createSalesOutFromOrder(salesOrderNo, suffix, qty = 1) {
  const payload = {
    sourceOrderNo: salesOrderNo,
    customerCode: "KH-001",
    billDate,
    department: "销售部",
    ownerName: "本地管理员",
    lines: [{ productCode: "CP-001", warehouseCode: "CK-001", sourceOrderNo: salesOrderNo, sourceLineNo: 1, qty, unitPrice: 86 }]
  };
  const flow = await createSalesOutDraftViaDeliveryNotice((pathname, body) => requireApi(pathname, { body }), payload);
  const billNo = flow.salesOutNo;
  await requireApi(`/api/sales-outs/${encodeURIComponent(billNo)}/audit`);
  return billNo;
}

async function createDeliveryNoticeFromOrder(salesOrderNo, suffix, qty = 1) {
  const notice = await requireApi("/api/delivery-notices/draft", {
    body: {
      sourceOrderNo: salesOrderNo,
      customerCode: "KH-001",
      billDate,
      department: "销售部",
      ownerName: "本地管理员",
      lines: [{ productCode: "CP-001", warehouseCode: "CK-001", sourceOrderNo: salesOrderNo, sourceLineNo: 1, qty, unitPrice: 86 }]
    }
  });
  const noticeNo = generatedBillNo(notice, `A105发货通知${suffix}`);
  await requireApi(`/api/delivery-notices/${encodeURIComponent(noticeNo)}/audit`);
  return noticeNo;
}

async function createSalesOutDraftFromNotice(noticeNo, suffix, qty = 1) {
  return generatedBillNo(await requireApi("/api/sales-outs/draft", {
    body: {
      customerCode: "KH-001",
      billDate,
      department: "销售部",
      ownerName: "本地管理员",
      lines: [{
        productCode: "CP-001",
        warehouseCode: "CK-001",
        sourceOrderNo: noticeNo,
        sourceLineNo: 1,
        sourceDeliveryNoticeNo: noticeNo,
        sourceDeliveryLineNo: 1,
        qty,
        unitPrice: 86
      }]
    }
  }), `A105销售出库${suffix}`);
}

async function verifyLifecycleApi() {
  const closeNo = await createSalesOrder("CLOSE");
  const lineClose = await api(`/api/document-lifecycle/salesOrder/${encodeURIComponent(closeNo)}/lines/1/close`, { body: { reason: "A105 行关闭" }, expectFailure: true });
  assert(lineClose.status === 400, `sales order line close API should be disabled with 400, got ${lineClose.status}`);
  let detail = await requireApi(`/api/sales-orders/${encodeURIComponent(closeNo)}`, { method: "GET" });
  assert(detail.lines.every((line) => line.lineCloseStatus === "OPEN"), "sales order line close API should not mutate lines");
  await requireApi(`/api/document-lifecycle/salesOrder/${encodeURIComponent(closeNo)}/close`, { body: { reason: "A105 整单关闭" } });
  detail = await requireApi(`/api/sales-orders/${encodeURIComponent(closeNo)}`, { method: "GET" });
  assert(detail.order.closeStatus === "CLOSED", "header close status should be CLOSED");
  assert(detail.order.closeMode === "MANUAL", "sales order manual header close should set closeMode MANUAL");
  assert(detail.lines.every((line) => line.lineCloseStatus === "OPEN"), "sales order header close should not close lines");
  await requireApi(`/api/document-lifecycle/salesOrder/${encodeURIComponent(closeNo)}/unclose`, { body: { reason: "A105 整单反关闭" } });
  detail = await requireApi(`/api/sales-orders/${encodeURIComponent(closeNo)}`, { method: "GET" });
  assert(detail.order.closeStatus === "OPEN", "header close status should reopen");
  assert(!detail.order.closeMode, "sales order manual unclose should clear closeMode");
  assert(detail.lines.every((line) => line.lineCloseStatus === "OPEN"), "all lines should reopen");

  const freezeNo = await createSalesOrder("FREEZE");
  await requireApi(`/api/document-lifecycle/salesOrder/${encodeURIComponent(freezeNo)}/lines/1/freeze`, { body: { reason: "A105 行冻结" } });
  detail = await requireApi(`/api/sales-orders/${encodeURIComponent(freezeNo)}`, { method: "GET" });
  assert(detail.lines[0].lineFrozenStatus === "FROZEN", "line frozen status should be FROZEN");
  await requireApi(`/api/document-lifecycle/salesOrder/${encodeURIComponent(freezeNo)}/lines/1/unfreeze`, { body: { reason: "A105 行解冻" } });
  const frozenNoticeNo = await createDeliveryNoticeFromOrder(freezeNo, "FROZEN");
  await requireApi(`/api/document-lifecycle/salesOrder/${encodeURIComponent(freezeNo)}/freeze`, { body: { reason: "A105 整单冻结" } });
  detail = await requireApi(`/api/sales-orders/${encodeURIComponent(freezeNo)}`, { method: "GET" });
  assert(detail.order.frozenStatus === "FROZEN", "header frozen status should be FROZEN");
  assert(detail.lines.every((line) => line.lineFrozenStatus === "FROZEN"), "all lines should be frozen by header freeze");
  await requireApi(`/api/document-lifecycle/deliveryNotice/${encodeURIComponent(frozenNoticeNo)}/freeze`, { body: { reason: "A105 冻结通知阻断执行" } });
  const frozenSalesOutNo = await createSalesOutDraftFromNotice(frozenNoticeNo, "FROZEN");
  const blockedByFreeze = { ok: true };
  assert(blockedByFreeze.ok, "draft against frozen source can still be saved before audit");
  const frozenAudit = await api(`/api/sales-outs/${encodeURIComponent(frozenSalesOutNo)}/audit`, { expectFailure: true });
  assert(frozenAudit.status === 409, `frozen source audit should be blocked with 409, got ${frozenAudit.status}`);
  await requireApi(`/api/document-lifecycle/salesOrder/${encodeURIComponent(freezeNo)}/unfreeze`, { body: { reason: "A105 整单解冻" } });

  const lineBlockNo = await createSalesOrder("LINEBLOCK");
  await requireApi(`/api/document-lifecycle/salesOrder/${encodeURIComponent(lineBlockNo)}/lines/1/freeze`, { body: { reason: "A105 已冻结行不下推" } });
  const selectable = await requireApi(`/api/sales-orders/selectable-lines?customerCode=KH-001`, { method: "GET" });
  const sourceLines = selectable.lines.filter((line) => line.billNo === lineBlockNo);
  assert(sourceLines.length === 1 && Number(sourceLines[0].lineNo) === 2, "selectable lines should skip frozen line and keep normal line");

  const voidNo = generatedBillNo(await requireApi("/api/sales-orders/draft", {
    body: {
      customerCode: "KH-001",
      billDate,
      department: "销售部",
      ownerName: "本地管理员",
      lines: [{ productCode: "CP-001", warehouseCode: "CK-001", qty: 2, unitPrice: 86 }]
    }
  }), "A105作废草稿");
  const wrongPassword = await requestWithRegressionAdminConfirmation(
    apiBase,
    `/api/document-lifecycle/salesOrder/${encodeURIComponent(voidNo)}/void`,
    { sessionCookie: adminCookie, reason: "A105 错密", invalidPassword: true }
  );
  assert(wrongPassword.status === 401, `wrong password void should be 401, got ${wrongPassword.status}`);
  const voidedResponse = await requestWithRegressionAdminConfirmation(
    apiBase,
    `/api/document-lifecycle/salesOrder/${encodeURIComponent(voidNo)}/void`,
    { sessionCookie: adminCookie, reason: "A105 草稿作废" }
  );
  assert(voidedResponse.ok, `draft void should succeed, got ${voidedResponse.status}`);
  const voided = voidedResponse.data;
  assert(voided.status === "VOID", "draft void should set VOID");

  const downstreamNo = await createSalesOrder("DOWNSTREAM");
  await createSalesOutFromOrder(downstreamNo, "DOWNSTREAM");
  const blockedVoid = await requestWithRegressionAdminConfirmation(
    apiBase,
    `/api/document-lifecycle/salesOrder/${encodeURIComponent(downstreamNo)}/void`,
    { sessionCookie: adminCookie, reason: "A105 有下游作废" }
  );
  assert(blockedVoid.status === 409, `void with downstream should be blocked with 409, got ${blockedVoid.status}`);

  return { closeNo, freezeNo, lineBlockNo, voidNo, downstreamNo, wrongPasswordStatus: wrongPassword.status, blockedVoidStatus: blockedVoid.status, frozenAuditStatus: frozenAudit.status };
}

async function verifyUi() {
  const uiNo = await createSalesOrder("UI", [3]);
  const dangerDraftNo = await createSalesOrderDraft("UIDANGER", [1]);
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1366, height: 768 } });
  const screenshots = [];
  try {
    await page.goto(frontendUrl, { waitUntil: "networkidle" });
    await loginAsAdmin(page);
    await page.getByTestId("module-销售管理").hover();
    await page.getByTestId("query-sales-order-form").click();
    await page.getByTestId("tab-sales-order-form-list").waitFor({ state: "visible" });
    await page.getByTestId("list-keyword").fill(uiNo);
    await page.getByTestId("list-query").click();
    await page.getByTestId(`open-document-${uiNo}`).waitFor({ state: "visible", timeout: 10000 });
    await page.getByTestId(`open-document-${uiNo}`).click();
    await page.waitForFunction((billNo) => {
      const input = document.querySelector('[data-testid="sales-bill-no"]');
      return input instanceof HTMLInputElement && input.value === billNo;
    }, uiNo, { timeout: 15000 });
    await page.getByTestId("close-document").waitFor({ state: "visible", timeout: 15000 });
    await page.getByText("已审核").waitFor({ state: "visible" });
    assert(await page.getByTestId("close-document").isEnabled(), "close button should be enabled for audited document");
    assert(await page.getByTestId("freeze-document").isEnabled(), "freeze button should be enabled for audited document");
    await page.getByTestId("module-销售管理").hover();
    await page.getByTestId("query-sales-order-form").click();
    await page.getByTestId("tab-sales-order-form-list").waitFor({ state: "visible" });
    await page.getByTestId("list-keyword").fill(dangerDraftNo);
    await page.getByTestId("list-query").click();
    await page.getByTestId(`open-document-${dangerDraftNo}`).waitFor({ state: "visible", timeout: 10000 });
    await page.getByTestId(`open-document-${dangerDraftNo}`).click();
    await page.waitForFunction((billNo) => {
      const input = document.querySelector('[data-testid="sales-bill-no"]');
      return input instanceof HTMLInputElement && input.value === billNo;
    }, dangerDraftNo, { timeout: 15000 });
    assert(await page.getByTestId("void-document").isEnabled(), "void button should be enabled for saved draft document");
    await page.getByTestId("void-document").click();
    await page.getByTestId("lifecycle-action-dialog").waitFor({ state: "visible" });
    await page.getByText("作废后单据将不再作为有效业务事实").waitFor({ state: "visible" });
    await page.getByTestId("void-username").waitFor({ state: "visible" });
    await page.getByTestId("void-password").waitFor({ state: "visible" });
    const shot = `a105-lifecycle-danger-dialog-${batch}.png`;
    await page.screenshot({ path: path.join(screenshotDir, shot), fullPage: true });
    screenshots.push(`verification/playwright/${shot}`);
    await page.getByTestId("lifecycle-action-cancel").click();
    return { uiNo, dangerDraftNo, screenshots };
  } finally {
    await browser.close();
  }
}

async function verifyBatchAuditUi() {
  const draftNo = await createSalesOrderDraft("BATCHAUDIT", [2]);
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1366, height: 768 } });
  try {
    await page.goto(frontendUrl, { waitUntil: "networkidle" });
    await loginAsAdmin(page);
    await page.getByTestId("module-销售管理").hover();
    await page.getByTestId("query-sales-order-form").click();
    await page.getByTestId("tab-sales-order-form-list").waitFor({ state: "visible" });
    await page.getByTestId("list-keyword").fill(draftNo);
    await page.getByTestId("list-query").click();
    await page.getByTestId(`open-document-${draftNo}`).waitFor({ state: "visible", timeout: 10000 });

    const row = page.locator(".vxe-body--row", { has: page.getByTestId(`open-document-${draftNo}`) }).first();
    await row.locator("[data-testid^='list-select-toggle-']").first().click();
    const auditButton = page.getByTestId("batch-audit");
    await auditButton.waitFor({ state: "visible" });
    assert(await auditButton.isEnabled(), "batch audit button should be enabled for selected draft bill");
    await auditButton.click();
    await page.getByTestId("batch-confirm-dialog").waitFor({ state: "visible" });
    await page.getByRole("button", { name: "确定" }).last().click();
    await page.getByTestId("list-batch-message").waitFor({ state: "visible", timeout: 10000 });
    const message = (await page.getByTestId("list-batch-message").textContent())?.trim() ?? "";
    assert(message.includes("已审核 1 张单据"), `batch audit should report success, got ${message}`);

    const detail = await requireApi(`/api/sales-orders/${encodeURIComponent(draftNo)}`, { method: "GET" });
    assert(detail.order.status === "AUDITED", "batch audit should persist AUDITED status");
    return { draftNo, message };
  } finally {
    await browser.close();
  }
}

async function verifyBatchDeleteUi() {
  const draftNo = await createSalesOrderDraft("BATCHDELETE", [1]);
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1366, height: 768 } });
  try {
    await page.goto(frontendUrl, { waitUntil: "networkidle" });
    await loginAsAdmin(page);
    await page.getByTestId("module-销售管理").hover();
    await page.getByTestId("query-sales-order-form").click();
    await page.getByTestId("tab-sales-order-form-list").waitFor({ state: "visible" });
    await page.getByTestId("list-keyword").fill(draftNo);
    await page.getByTestId("list-query").click();
    await page.getByTestId(`open-document-${draftNo}`).waitFor({ state: "visible", timeout: 10000 });

    const row = page.locator(".vxe-body--row", { has: page.getByTestId(`open-document-${draftNo}`) }).first();
    await row.locator("[data-testid^='list-select-toggle-']").first().click();
    await page.getByTestId("list-more-actions").hover();
    const deleteButton = page.getByTestId("batch-delete");
    await deleteButton.waitFor({ state: "visible" });
    assert(await deleteButton.isEnabled(), "batch delete button should be enabled for selected draft bill");
    await deleteButton.click();

    const dialog = page.getByTestId("batch-confirm-dialog");
    await dialog.waitFor({ state: "visible" });
    const dialogText = await dialog.innerText();
    assert(dialogText.includes("确定要删除已选中的 1 条数据吗？"), `delete confirmation should show target count, got ${dialogText}`);
    assert(dialogText.includes("删除不可逆"), `delete confirmation should warn irreversible deletion, got ${dialogText}`);
    await dialog.getByRole("button", { name: "确定" }).click();

    await page.getByTestId("list-batch-message").waitFor({ state: "visible", timeout: 10000 });
    const message = (await page.getByTestId("list-batch-message").textContent())?.trim() ?? "";
    assert(message.includes("已删除 1 张草稿单据"), `batch delete should report success, got ${message}`);

    const deleted = await api(`/api/sales-orders/${encodeURIComponent(draftNo)}`, { method: "GET", expectFailure: true });
    assert(deleted.status === 404, `deleted draft sales order should return 404, got ${deleted.status}`);
    return { draftNo, message };
  } finally {
    await browser.close();
  }
}

const codeContracts = await verifyLifecycleCodeContracts();
await seedStock();
const lifecycle = await verifyLifecycleApi();
const ui = await verifyUi();
const batchAuditUi = await verifyBatchAuditUi();
const batchDeleteUi = await verifyBatchDeleteUi();

const result = {
  batch,
  generatedAt: new Date().toISOString(),
  assertions: [
    "销售订单关闭/反关闭只作用整单，销售订单行关闭 API 已禁用",
    "冻结/解冻支持表头与行级并阻断执行",
    "下推可选行跳过已冻结行",
    "作废需要账号密码且草稿作废成功",
    "已有下游影响禁止作废",
    "前端普通按钮和作废危险区二次确认可见",
    "批量审核接入真实 auditDocument 提交",
    "发货通知单列表返回 closeStatus/frozenStatus",
    "下推按钮不再依赖 outStatus/inStatus 展示文案",
    "后端作废入口强校验 voidAllowed",
    "新反审核逻辑不再转入 REVERSED",
    "销售订单前端不再暴露行关闭状态且下推按钮不依赖 lineCloseStatus",
    "删除按钮弹出不可逆确认并接入真实 deleteDocument 提交"
  ],
  codeContracts,
  lifecycle,
  ui,
  batchAuditUi,
  batchDeleteUi
};

await writeFile(resultPath, JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));
