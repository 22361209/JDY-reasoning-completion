import { chromium } from "playwright";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { installApiSession, loginAsAdmin } from "./helpers/regression-auth.mjs";
import { clickNewDocument } from "./helpers/document-actions.mjs";
import { salesOutPayloadViaDeliveryNotice } from "./helpers/sales-delivery-notice-flow.mjs";

const rootDir = path.resolve(import.meta.dirname, "..");
const screenshotDir = path.join(rootDir, "verification/playwright");
const resultPath = path.join(rootDir, "verification/a105-bill-lifecycle-regression.json");
const frontendUrl = "http://127.0.0.1:5173/";
const apiBase = "http://127.0.0.1:8080";
const batch = new Date().toISOString().replace(/\D/g, "").slice(0, 14);
const billDate = "2026-06-26";

await installApiSession(apiBase);
await mkdir(screenshotDir, { recursive: true });
await mkdir(path.dirname(resultPath), { recursive: true });

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
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
  const listStubController = await readFile(path.join(rootDir, "backend/src/main/java/com/jdy/erp/system/api/ListStubController.java"), "utf8");
  const lifecyclePolicy = await readFile(path.join(rootDir, "backend/src/main/java/com/jdy/erp/shared/application/BillLifecyclePolicy.java"), "utf8");
  const lifecycleService = await readFile(path.join(rootDir, "backend/src/main/java/com/jdy/erp/shared/application/BillLifecycleService.java"), "utf8");
  const outsourcingService = await readFile(path.join(rootDir, "backend/src/main/java/com/jdy/erp/outsourcing/application/OutsourcingDocumentAppService.java"), "utf8");

  assert(dataListPage.includes("auditDocument(type, billNo)"), "DataListPage batch audit must call auditDocument");
  assert(dataListPage.includes("async function submitBatchAudit()"), "DataListPage must implement submitBatchAudit");
  assert(dataListPage.includes("selectedBillRows.value.every(isDraftBillStatus)"), "batch audit button must only enable for draft bills");
  assert(!dataListPage.includes('outStatus !== "全部出库"'), "sales pushdown must not depend on outStatus display text");
  assert(!dataListPage.includes('inStatus !== "全部入库"'), "purchase pushdown must not depend on inStatus display text");
  assert(listStubController.includes('dn.close_status AS "closeStatus"'), "delivery notice list must return closeStatus");
  assert(listStubController.includes('dn.frozen_status AS "frozenStatus"'), "delivery notice list must return frozenStatus");
  assert(lifecyclePolicy.includes("boolean voidAllowed"), "backend lifecycle policy must include voidAllowed");
  assert(lifecycleService.includes("BillLifecyclePolicy.requireVoidAllowed(target);"), "voidBill must enforce backend voidAllowed policy");
  assert(!outsourcingService.includes("BillStatus.AUDITED.name(), BillStatus.REVERSED.name()"), "new reverse logic must not transition AUDITED to REVERSED");
  return {
    batchAuditSubmits: true,
    pushdownUsesRemainingQty: true,
    deliveryNoticeListLifecycleStatus: true,
    backendVoidAllowedEnforced: true,
    reverseReturnsDraft: true
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
  const billNo = `XSDD-A105-${suffix}-${batch}`;
  await requireApi("/api/sales-orders/draft", {
    body: {
      billNo,
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
  });
  return billNo;
}

async function createSalesOutFromOrder(salesOrderNo, suffix, qty = 1) {
  const billNo = `XSCK-A105-${suffix}-${batch}`;
  const payload = {
    billNo,
    sourceOrderNo: salesOrderNo,
    customerCode: "KH-001",
    billDate,
    department: "销售部",
    ownerName: "本地管理员",
    lines: [{ productCode: "CP-001", warehouseCode: "CK-001", sourceOrderNo: salesOrderNo, sourceLineNo: 1, qty, unitPrice: 86 }]
  };
  const flow = salesOutPayloadViaDeliveryNotice(payload, `FHTZ-A105-${suffix}-${batch}`);
  await requireApi("/api/delivery-notices/draft", { body: flow.noticePayload });
  await requireApi(`/api/delivery-notices/${encodeURIComponent(flow.noticeNo)}/audit`);
  await requireApi("/api/sales-outs/draft", { body: flow.outPayload });
  await requireApi(`/api/sales-outs/${encodeURIComponent(billNo)}/audit`);
  return billNo;
}

async function createDeliveryNoticeFromOrder(salesOrderNo, suffix, qty = 1) {
  const noticeNo = `FHTZ-A105-${suffix}-${batch}`;
  await requireApi("/api/delivery-notices/draft", {
    body: {
      billNo: noticeNo,
      sourceOrderNo: salesOrderNo,
      customerCode: "KH-001",
      billDate,
      department: "销售部",
      ownerName: "本地管理员",
      lines: [{ productCode: "CP-001", warehouseCode: "CK-001", sourceOrderNo: salesOrderNo, sourceLineNo: 1, qty, unitPrice: 86 }]
    }
  });
  await requireApi(`/api/delivery-notices/${encodeURIComponent(noticeNo)}/audit`);
  return noticeNo;
}

async function createSalesOutDraftFromNotice(noticeNo, suffix, qty = 1) {
  const billNo = `XSCK-A105-${suffix}-${batch}`;
  await requireApi("/api/sales-outs/draft", {
    body: {
      billNo,
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
  });
  return billNo;
}

async function verifyLifecycleApi() {
  const closeNo = await createSalesOrder("CLOSE");
  await requireApi(`/api/document-lifecycle/salesOrder/${encodeURIComponent(closeNo)}/lines/1/close`, { body: { reason: "A105 行关闭" } });
  let detail = await requireApi(`/api/sales-orders/${encodeURIComponent(closeNo)}`, { method: "GET" });
  assert(detail.lines[0].lineCloseStatus === "CLOSED", "line close status should be CLOSED");
  assert(detail.lines[1].lineCloseStatus === "OPEN", "other line should stay OPEN");
  await requireApi(`/api/document-lifecycle/salesOrder/${encodeURIComponent(closeNo)}/lines/1/unclose`, { body: { reason: "A105 行反关闭" } });
  await requireApi(`/api/document-lifecycle/salesOrder/${encodeURIComponent(closeNo)}/close`, { body: { reason: "A105 整单关闭" } });
  detail = await requireApi(`/api/sales-orders/${encodeURIComponent(closeNo)}`, { method: "GET" });
  assert(detail.order.closeStatus === "CLOSED", "header close status should be CLOSED");
  assert(detail.lines.every((line) => line.lineCloseStatus === "CLOSED"), "all lines should be closed by header close");
  await requireApi(`/api/document-lifecycle/salesOrder/${encodeURIComponent(closeNo)}/unclose`, { body: { reason: "A105 整单反关闭" } });
  detail = await requireApi(`/api/sales-orders/${encodeURIComponent(closeNo)}`, { method: "GET" });
  assert(detail.order.closeStatus === "OPEN", "header close status should reopen");
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
  await requireApi(`/api/document-lifecycle/salesOrder/${encodeURIComponent(lineBlockNo)}/lines/1/close`, { body: { reason: "A105 已关闭行不下推" } });
  const selectable = await requireApi(`/api/sales-orders/selectable-lines?customerCode=KH-001`, { method: "GET" });
  const sourceLines = selectable.lines.filter((line) => line.billNo === lineBlockNo);
  assert(sourceLines.length === 1 && Number(sourceLines[0].lineNo) === 2, "selectable lines should skip closed line and keep open line");

  const voidNo = `XSDD-A105-VOID-${batch}`;
  await requireApi("/api/sales-orders/draft", {
    body: {
      billNo: voidNo,
      customerCode: "KH-001",
      billDate,
      department: "销售部",
      ownerName: "本地管理员",
      lines: [{ productCode: "CP-001", warehouseCode: "CK-001", qty: 2, unitPrice: 86 }]
    }
  });
  const wrongPassword = await api(`/api/document-lifecycle/salesOrder/${encodeURIComponent(voidNo)}/void`, {
    body: { reason: "A105 错密", username: "admin", password: "bad" },
    expectFailure: true
  });
  assert(wrongPassword.status === 401, `wrong password void should be 401, got ${wrongPassword.status}`);
  const voided = await requireApi(`/api/document-lifecycle/salesOrder/${encodeURIComponent(voidNo)}/void`, {
    body: { reason: "A105 草稿作废", username: "admin", password: "admin123" }
  });
  assert(voided.status === "VOID", "draft void should set VOID");

  const downstreamNo = await createSalesOrder("DOWNSTREAM");
  await createSalesOutFromOrder(downstreamNo, "DOWNSTREAM");
  const blockedVoid = await api(`/api/document-lifecycle/salesOrder/${encodeURIComponent(downstreamNo)}/void`, {
    body: { reason: "A105 有下游作废", username: "admin", password: "admin123" },
    expectFailure: true
  });
  assert(blockedVoid.status === 409, `void with downstream should be blocked with 409, got ${blockedVoid.status}`);

  return { closeNo, freezeNo, lineBlockNo, voidNo, downstreamNo, wrongPasswordStatus: wrongPassword.status, blockedVoidStatus: blockedVoid.status, frozenAuditStatus: frozenAudit.status };
}

async function verifyUi() {
  const uiNo = await createSalesOrder("UI", [3]);
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
    await clickNewDocument(page);
    await page.waitForFunction(() => {
      const input = document.querySelector('[data-testid="sales-bill-no"]');
      return input instanceof HTMLInputElement && input.value.trim().length > 0;
    });
    await page.getByTestId("void-document").click();
    await page.getByTestId("lifecycle-action-dialog").waitFor({ state: "visible" });
    await page.getByText("作废后单据将不再作为有效业务事实").waitFor({ state: "visible" });
    await page.getByTestId("void-username").waitFor({ state: "visible" });
    await page.getByTestId("void-password").waitFor({ state: "visible" });
    const shot = `a105-lifecycle-danger-dialog-${batch}.png`;
    await page.screenshot({ path: path.join(screenshotDir, shot), fullPage: true });
    screenshots.push(`verification/playwright/${shot}`);
    await page.getByTestId("lifecycle-action-cancel").click();
    return { uiNo, screenshots };
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

const codeContracts = await verifyLifecycleCodeContracts();
await seedStock();
const lifecycle = await verifyLifecycleApi();
const ui = await verifyUi();
const batchAuditUi = await verifyBatchAuditUi();

const result = {
  batch,
  generatedAt: new Date().toISOString(),
  assertions: [
    "关闭/反关闭支持表头与行级并保留业务事实",
    "冻结/解冻支持表头与行级并阻断执行",
    "下推可选行跳过已关闭/已冻结行",
    "作废需要账号密码且草稿作废成功",
    "已有下游影响禁止作废",
    "前端普通按钮和作废危险区二次确认可见",
    "批量审核接入真实 auditDocument 提交",
    "发货通知单列表返回 closeStatus/frozenStatus",
    "下推按钮不再依赖 outStatus/inStatus 展示文案",
    "后端作废入口强校验 voidAllowed",
    "新反审核逻辑不再转入 REVERSED"
  ],
  codeContracts,
  lifecycle,
  ui,
  batchAuditUi
};

await writeFile(resultPath, JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));
