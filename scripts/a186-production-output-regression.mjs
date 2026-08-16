#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";

import { loginAsAdmin } from "./helpers/regression-auth.mjs";

const rootDir = path.resolve(import.meta.dirname, "..");
const verificationDir = path.join(rootDir, "verification");
const screenshotDir = path.join(verificationDir, "playwright");
const resultPath = path.join(verificationDir, "a186-production-output-regression.json");
const frontendUrl = process.env.JDY_WEB_BASE || "http://127.0.0.1:5173/";
const runId = randomUUID();
const runShort = runId.replaceAll("-", "").slice(0, 12).toUpperCase();
const taskBillNo = "SCRW900001";
const lossBillNo = "PK900001";
const issueHeaderBillNo = "SOUT900001";
const productInHeaderBillNo = "SCRK900001";
const transferHeaderBillNo = "DBD900001";
const countHeaderBillNo = "PD900001";
const headerBillNos = Object.freeze({
  "material-issue-form-list": issueHeaderBillNo,
  "product-in-form-list": productInHeaderBillNo,
  "stock-transfer-form-list": transferHeaderBillNo,
  "stock-count-form-list": countHeaderBillNo
});
const headerRemarks = {
  productIn: "A186 产品入库原备注",
  stockTransfer: "A186 调拨原备注",
  stockCount: "A186 盘点原备注"
};

await mkdir(verificationDir, { recursive: true });
await mkdir(screenshotDir, { recursive: true });

function assert(condition, message, details) {
  if (!condition) {
    const suffix = details === undefined ? "" : `: ${JSON.stringify(details)}`;
    throw new Error(`${message}${suffix}`);
  }
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function waitWithTimeout(promise, timeoutMs, label) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
      })
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function fulfillJson(route, payload, status = 200) {
  await route.fulfill({
    status,
    contentType: "application/json",
    body: JSON.stringify(payload)
  });
}

async function openEntry(page, moduleName, entryId) {
  await page.getByTestId(`module-${moduleName}`).hover();
  await page.getByTestId(`entry-${entryId}`).click();
  await page.getByTestId(`tab-${entryId}`).waitFor({ state: "visible", timeout: 10000 });
  await page.waitForTimeout(275);
}

async function openDetailFromList(page, moduleName, entryId, listId, billNo, billNoTestId) {
  await page.getByTestId(`module-${moduleName}`).hover();
  await page.getByTestId(`query-${entryId}`).click();
  await page.getByTestId(`tab-${listId}`).waitFor({ state: "visible", timeout: 10000 });
  await page.getByTestId("list-keyword").fill(billNo);
  await page.getByTestId("list-keyword").press("Enter");
  await page.getByTestId(`open-document-${billNo}`).waitFor({ state: "visible", timeout: 10000 });
  await page.getByTestId(`open-document-${billNo}`).click();
  await page.waitForFunction(
    ({ id, value }) => document.querySelector(`[data-testid="${id}"]`)?.value === value,
    { id: billNoTestId, value: billNo }
  );
}

async function closeDocumentForm(page, formId, expectedLockRequestCount) {
  await page.getByTestId(`close-${formId}`).click();
  await page.getByTestId(`tab-${formId}`).waitFor({ state: "hidden", timeout: 10000 });
  await waitUntil(
    () => evidence.requests.documentLocks.length === expectedLockRequestCount,
    10000,
    `${formId} document-lock release`
  );
}

async function waitForTabDirtyState(page, formId, dirty) {
  await page.waitForFunction(
    ({ id, expected }) => document.querySelector(`[data-testid="tab-${id}"]`)?.classList.contains("dirty") === expected,
    { id: formId, expected: dirty }
  );
}

async function productInfoValues(page) {
  const section = page.locator("section.master-record-section").filter({ has: page.getByRole("heading", { name: "产品信息", exact: true }) });
  await section.waitFor({ state: "visible", timeout: 10000 });
  return section.locator("input").evaluateAll((inputs) => inputs.map((input) => input.value));
}

async function waitForText(locator, text) {
  await locator.filter({ hasText: text }).waitFor({ state: "visible", timeout: 10000 });
}

async function waitUntil(predicate, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`${label} timed out after ${timeoutMs}ms`);
}

const firstTaskRequestSeen = deferred();
const releaseFirstTaskRequest = deferred();
const evidence = {
  taskId: "A186",
  runId,
  generatedAt: new Date().toISOString(),
  ok: false,
  checks: {},
  requests: {
    taskCreates: [],
    taskPreviews: 0,
    taskPreviewDocuments: [],
    lossDrafts: [],
    lossAudits: 0,
    lossPrints: [],
    headerDrafts: [],
    headerDetailGets: { materialIssue: 0, productIn: 0, stockTransfer: 0, stockCount: 0 },
    documentLocks: [],
    unexpectedWrites: []
  },
  screenshots: [],
  error: ""
};

let browser;
let primaryError;
let closeError;
let runCompleted = false;
let lossStatus = "DRAFT";

try {
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1803, height: 960 } });
  const page = await context.newPage();
  await page.addInitScript(() => {
    window.__a186OpenedUrls = [];
    window.open = (url) => {
      window.__a186OpenedUrls.push(String(url ?? ""));
      return null;
    };
  });
  await page.goto(frontendUrl, { waitUntil: "networkidle" });
  await loginAsAdmin(page);

  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const method = request.method();

    if (method === "GET" && url.pathname.startsWith("/api/lists/")) {
      const listKey = decodeURIComponent(url.pathname.slice("/api/lists/".length));
      const billNo = headerBillNos[listKey];
      if (billNo) {
        await fulfillJson(route, {
          page: 1,
          pageSize: 50,
          total: 1,
          rows: [{
            billNo,
            sourceOrderNo: taskBillNo,
            billDate: "2026-08-16",
            status: "DRAFT",
            department: "A186",
            productCode: "CP-A186-FINISH",
            productName: "A186 完工母件",
            warehouse: "A186-FINISH",
            sourceWarehouse: "CK-001",
            targetWarehouse: "A186-FINISH",
            systemQty: 10,
            countedQty: 10,
            diffQty: 0
          }]
        });
        return;
      }
    }
    const productInfo = {
      productCode: "CP-A186-FINISH",
      productName: "A186 完工母件",
      spec: "A186",
      unit: "PCS",
      warehouseCode: "A186-FINISH",
      taskQty: 1,
      remainingQty: 1,
      bomCode: "BOM-A186-IDEMPOTENT",
      bomVersionNo: 1
    };
    if (method === "GET" && url.pathname === `/api/production/material-issues/${issueHeaderBillNo}`) {
      evidence.requests.headerDetailGets.materialIssue += 1;
      await fulfillJson(route, {
        action: "DETAIL",
        document: { billNo: issueHeaderBillNo, sourceOrderNo: taskBillNo, billDate: "2026-08-16", department: "生产部", status: "DRAFT" },
        productInfo,
        lines: [{ lineNo: 1, productCode: "CP-A186-MAT", productName: "A186 生产子件", spec: "A186-M", unit: "PCS", warehouseCode: "CK-001", qty: 1, unitPrice: 1, amount: 1 }]
      });
      return;
    }
    if (method === "GET" && url.pathname === `/api/production/product-ins/${productInHeaderBillNo}`) {
      evidence.requests.headerDetailGets.productIn += 1;
      await fulfillJson(route, {
        action: "DETAIL",
        document: { billNo: productInHeaderBillNo, sourceOrderNo: taskBillNo, billDate: "2026-08-16", department: "生产部", status: "DRAFT", remark: headerRemarks.productIn },
        productInfo,
        lines: [{ lineNo: 1, productCode: "CP-A186-FINISH", productName: "A186 完工母件", spec: "A186", unit: "PCS", warehouseCode: "A186-FINISH", qty: 1, unitPrice: 1, amount: 1 }]
      });
      return;
    }
    if (method === "GET" && url.pathname === `/api/stock-transfers/${transferHeaderBillNo}`) {
      evidence.requests.headerDetailGets.stockTransfer += 1;
      await fulfillJson(route, {
        action: "DETAIL",
        document: { billNo: transferHeaderBillNo, billDate: "2026-08-16", department: "A186", businessType: "直接调拨", status: "DRAFT", remark: headerRemarks.stockTransfer },
        lines: [{ lineNo: 1, productCode: "CP-A186-FINISH", productName: "A186 完工母件", spec: "A186", unit: "PCS", warehouseCode: "CK-001", targetWarehouseCode: "A186-FINISH", qty: 1, unitPrice: 1, amount: 1 }]
      });
      return;
    }
    if (method === "GET" && url.pathname === `/api/stock-counts/${countHeaderBillNo}`) {
      evidence.requests.headerDetailGets.stockCount += 1;
      await fulfillJson(route, {
        action: "DETAIL",
        document: { billNo: countHeaderBillNo, billDate: "2026-08-16", department: "A186", businessType: "盘点单", status: "DRAFT", remark: headerRemarks.stockCount },
        lines: [{ lineNo: 1, productCode: "CP-A186-FINISH", productName: "A186 完工母件", spec: "A186", unit: "PCS", warehouseCode: "CK-001", qty: 10, systemQty: 10, diffQty: 0, unitPrice: 1 }]
      });
      return;
    }
    const headerDraftType = {
      "/api/production/product-ins/draft": "productIn",
      "/api/stock-transfers/draft": "stockTransfer",
      "/api/stock-counts/draft": "stockCount"
    }[url.pathname];
    if (method === "POST" && headerDraftType) {
      const payload = request.postDataJSON();
      const billNo = headerDraftType === "productIn"
        ? productInHeaderBillNo
        : headerDraftType === "stockTransfer"
          ? transferHeaderBillNo
          : countHeaderBillNo;
      assert(String(payload.billNo ?? "") === billNo, `${headerDraftType} save must update the exact opened draft`, payload);
      evidence.requests.headerDrafts.push({ type: headerDraftType, payload });
      headerRemarks[headerDraftType] = String(payload.remark ?? "");
      await fulfillJson(route, { billNo, status: "DRAFT" }, 201);
      return;
    }
    if ((method === "POST" || method === "DELETE") && url.pathname.startsWith("/api/document-locks/")) {
      evidence.requests.documentLocks.push(`${method} ${url.pathname}`);
      await fulfillJson(route, { mode: "editable", locked: false, readOnly: false, canOverride: false });
      return;
    }

    if (method === "POST" && url.pathname === "/api/production/tasks") {
      const payload = request.postDataJSON();
      evidence.requests.taskCreates.push(payload);
      if (evidence.requests.taskCreates.length === 1) {
        firstTaskRequestSeen.resolve(true);
        await releaseFirstTaskRequest.promise;
        await route.abort("failed");
        return;
      }
      await fulfillJson(route, {
        id: payload.draftId,
        billNo: taskBillNo,
        bomCode: payload.bomCode,
        qty: payload.qty,
        status: "DRAFT",
        sourceKind: "MANUAL"
      }, 201);
      return;
    }
    if (method === "GET" && url.pathname === `/api/production/tasks/${taskBillNo}/material-issue-preview`) {
      evidence.requests.taskPreviews += 1;
      const previewDraftId = evidence.requests.taskCreates.at(-1)?.draftId;
      const previewDocument = {
        id: previewDraftId,
        billNo: taskBillNo,
        sourceOrderNo: taskBillNo,
        planNo: "",
        planLineNo: null,
        sourceKind: "MANUAL",
        sourceLevel: 0,
        bomPath: null,
        status: "DRAFT",
        closeStatus: "OPEN",
        frozenStatus: "NORMAL"
      };
      evidence.requests.taskPreviewDocuments.push(previewDocument);
      await fulfillJson(route, {
        document: previewDocument,
        productInfo: {
          productCode: "CP-A186-FINISH",
          productName: "A186 完工母件",
          spec: "A186",
          unit: "PCS",
          warehouseCode: "A186-FINISH",
          taskQty: 1,
          remainingQty: 1,
          bomCode: "BOM-A186-IDEMPOTENT",
          bomVersionNo: 1
        },
        lines: [{
          lineNo: 1,
          productCode: "CP-A186-MAT",
          productName: "A186 生产子件",
          warehouseCode: "CK-001",
          qty: 1,
          remainingQty: 1,
          stockOnHand: 10,
          stockAvailable: 10
        }]
      });
      return;
    }
    if (method === "POST" && url.pathname === "/api/stock-count-losses/draft") {
      evidence.requests.lossDrafts.push(request.postDataJSON());
      await fulfillJson(route, { billNo: lossBillNo, status: "DRAFT" }, 201);
      return;
    }
    if (method === "GET" && url.pathname === `/api/stock-count-losses/${lossBillNo}`) {
      await fulfillJson(route, {
        action: "DETAIL",
        document: {
          billNo: lossBillNo,
          billDate: "2026-08-16",
          department: `A186 output ${runShort}`,
          status: lossStatus,
          closeStatus: "OPEN",
          frozenStatus: "NORMAL"
        },
        lines: [{
          lineNo: 1,
          productCode: "CP-001",
          productName: "A186 盘亏商品",
          spec: "A186",
          unit: "PCS",
          warehouseCode: "CK-001",
          qty: 1,
          unitPrice: 1,
          amount: 1,
          lineRemark: "A186 print"
        }]
      });
      return;
    }
    if (method === "POST" && url.pathname === `/api/stock-count-losses/${lossBillNo}/audit`) {
      evidence.requests.lossAudits += 1;
      lossStatus = "AUDITED";
      await fulfillJson(route, { billNo: lossBillNo, status: lossStatus });
      return;
    }
    if (method === "GET" && url.pathname === `/api/documents/stock-count-loss/${lossBillNo}/print.pdf`) {
      evidence.requests.lossPrints.push(lossStatus);
      if (evidence.requests.lossPrints.length === 1) {
        await fulfillJson(route, { message: "A186 受控后端打印拒绝" }, 409);
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: "application/pdf",
        body: Buffer.from("%PDF-1.4\n%A186 controlled output\n")
      });
      return;
    }
    if (method !== "GET") {
      evidence.requests.unexpectedWrites.push(`${method} ${url.pathname}`);
      await route.abort("blockedbyclient");
      return;
    }
    await route.continue();
  });

  await openEntry(page, "生产管理", "production-task-form");
  await page.getByTestId("production-task-bom-code").fill("BOM-A186-IDEMPOTENT");
  await page.getByTestId("production-task-qty").fill("1");
  assert(await page.getByTestId("production-task-warehouse-code").inputValue() === "", "new standalone task must not default to CK-001");

  await page.evaluate(() => {
    const button = document.querySelector('[data-testid="save-sales-order"]');
    if (!(button instanceof HTMLButtonElement)) {
      throw new Error("production task save button missing");
    }
    button.click();
    button.click();
  });
  await waitWithTimeout(firstTaskRequestSeen.promise, 10000, "first production task request");
  assert(evidence.requests.taskCreates.length === 1, "synchronous double click must create only one in-flight request", evidence.requests.taskCreates);
  releaseFirstTaskRequest.resolve(true);
  await waitForText(page.getByTestId("form-message"), "网络异常");
  await page.getByTestId("save-sales-order").click();
  await page.waitForFunction((billNo) => {
    const input = document.querySelector('[data-testid="production-task-bill-no"]');
    return input instanceof HTMLInputElement && input.value === billNo;
  }, taskBillNo);

  assert(evidence.requests.taskCreates.length === 2, "one retry must issue one second request", evidence.requests.taskCreates);
  const [failedPayload, retryPayload] = evidence.requests.taskCreates;
  assert(typeof failedPayload.draftId === "string" && failedPayload.draftId.length === 36, "task create must carry UUID draftId", failedPayload);
  assert(retryPayload.draftId === failedPayload.draftId, "network retry must preserve the exact draftId", evidence.requests.taskCreates);
  assert(!("warehouseCode" in failedPayload) && !("warehouseCode" in retryPayload), "blank warehouse must remain omitted so backend resolves product default", evidence.requests.taskCreates);
  assert(await page.getByTestId("production-task-bill-no").inputValue() === taskBillNo, "preview identity fields must preserve the returned SCRW number");
  assert(await page.getByTestId("production-task-warehouse-code").inputValue() === "A186-FINISH", "preview must show resolved product default warehouse");
  assert(evidence.requests.taskPreviews === 1, "successful retry must load one material preview", evidence.requests.taskPreviews);
  assert(evidence.requests.taskPreviewDocuments[0]?.id === retryPayload.draftId, "preview must return the persisted task identity", evidence.requests.taskPreviewDocuments);
  assert(evidence.requests.taskPreviewDocuments[0]?.billNo === taskBillNo, "preview must return the persisted task bill number", evidence.requests.taskPreviewDocuments);
  evidence.checks.productionTask = {
    doubleClickRequestCount: 1,
    retryRequestCount: evidence.requests.taskCreates.length,
    draftId: retryPayload.draftId,
    previewTaskId: retryPayload.draftId,
    billNo: taskBillNo,
    resolvedWarehouse: "A186-FINISH"
  };

  const taskShot = `a186-production-task-idempotent-${runShort}.png`;
  await page.screenshot({ path: path.join(screenshotDir, taskShot), fullPage: true });
  evidence.screenshots.push(`verification/playwright/${taskShot}`);

  const expectedProductInfo = [
    "CP-A186-FINISH",
    "A186 完工母件",
    "A186",
    "PCS",
    "1",
    "1",
    "BOM-A186-IDEMPOTENT",
    "1"
  ];
  await openDetailFromList(
    page,
    "生产管理",
    "material-issue-form",
    "material-issue-form-list",
    issueHeaderBillNo,
    "material-issue-bill-no"
  );
  const issueProductInfo = await productInfoValues(page);
  assert(JSON.stringify(issueProductInfo) === JSON.stringify(expectedProductInfo), "material issue detail must preserve top-level productInfo through frontend normalization", issueProductInfo);
  await closeDocumentForm(page, "material-issue-form", 2);
  await openDetailFromList(
    page,
    "生产管理",
    "material-issue-form",
    "material-issue-form-list",
    issueHeaderBillNo,
    "material-issue-bill-no"
  );
  const issueProductInfoAfterReopen = await productInfoValues(page);
  assert(JSON.stringify(issueProductInfoAfterReopen) === JSON.stringify(expectedProductInfo), "material issue productInfo must survive a fresh list reopen", issueProductInfoAfterReopen);
  await closeDocumentForm(page, "material-issue-form", 4);

  await openDetailFromList(
    page,
    "生产管理",
    "product-in-form",
    "product-in-form-list",
    productInHeaderBillNo,
    "product-in-bill-no"
  );
  const completionProductInfo = await productInfoValues(page);
  assert(JSON.stringify(completionProductInfo) === JSON.stringify(expectedProductInfo), "product-in detail must preserve top-level productInfo through frontend normalization", completionProductInfo);
  const completionRemark = `A186 产品入库复验 ${runShort}`;
  await page.getByTestId("product-in-remark").fill(completionRemark);
  await waitForTabDirtyState(page, "product-in-form", true);
  await page.getByTestId("save-sales-order").click();
  await waitUntil(() => evidence.requests.headerDrafts.length === 1, 10000, "product-in remark save");
  await waitUntil(() => evidence.requests.headerDetailGets.productIn >= 2, 10000, "product-in detail reload after save");
  await waitForTabDirtyState(page, "product-in-form", false);
  const completionRemarkAfterSave = await page.getByTestId("product-in-remark").inputValue();
  assert(completionRemarkAfterSave === completionRemark, "product-in automatic detail reload must preserve the saved remark", completionRemarkAfterSave);
  const completionProductInfoAfterSave = await productInfoValues(page);
  assert(JSON.stringify(completionProductInfoAfterSave) === JSON.stringify(expectedProductInfo), "product-in productInfo must survive automatic detail reload", completionProductInfoAfterSave);
  await closeDocumentForm(page, "product-in-form", 6);
  await openDetailFromList(page, "生产管理", "product-in-form", "product-in-form-list", productInHeaderBillNo, "product-in-bill-no");
  await waitUntil(() => evidence.requests.headerDetailGets.productIn >= 3, 10000, "product-in detail reopen");
  await page.waitForFunction(
    ({ id, value }) => document.querySelector(`[data-testid="${id}"]`)?.value === value,
    { id: "product-in-remark", value: completionRemark }
  );
  const completionRemarkAfterReopen = await page.getByTestId("product-in-remark").inputValue();
  const completionProductInfoAfterReopen = await productInfoValues(page);
  assert(JSON.stringify(completionProductInfoAfterReopen) === JSON.stringify(expectedProductInfo), "product-in productInfo must survive a fresh list reopen", completionProductInfoAfterReopen);
  await closeDocumentForm(page, "product-in-form", 8);

  await openDetailFromList(
    page,
    "库存管理",
    "stock-transfer-form",
    "stock-transfer-form-list",
    transferHeaderBillNo,
    "stock-transfer-bill-no"
  );
  const transferRemark = `A186 调拨复验 ${runShort}`;
  await page.getByTestId("stock-transfer-remark").fill(transferRemark);
  await waitForTabDirtyState(page, "stock-transfer-form", true);
  await page.getByTestId("save-sales-order").click();
  await waitUntil(() => evidence.requests.headerDrafts.length === 2, 10000, "stock-transfer remark save");
  await waitUntil(() => evidence.requests.headerDetailGets.stockTransfer >= 2, 10000, "stock-transfer detail reload after save");
  await waitForTabDirtyState(page, "stock-transfer-form", false);
  const transferRemarkAfterSave = await page.getByTestId("stock-transfer-remark").inputValue();
  assert(transferRemarkAfterSave === transferRemark, "stock-transfer automatic detail reload must preserve the saved remark", transferRemarkAfterSave);
  await closeDocumentForm(page, "stock-transfer-form", 10);
  await openDetailFromList(page, "库存管理", "stock-transfer-form", "stock-transfer-form-list", transferHeaderBillNo, "stock-transfer-bill-no");
  await waitUntil(() => evidence.requests.headerDetailGets.stockTransfer >= 3, 10000, "stock-transfer detail reopen");
  await page.waitForFunction(
    ({ id, value }) => document.querySelector(`[data-testid="${id}"]`)?.value === value,
    { id: "stock-transfer-remark", value: transferRemark }
  );
  const transferRemarkAfterReopen = await page.getByTestId("stock-transfer-remark").inputValue();
  await closeDocumentForm(page, "stock-transfer-form", 12);

  await openDetailFromList(
    page,
    "库存管理",
    "stock-count-form",
    "stock-count-form-list",
    countHeaderBillNo,
    "stock-count-bill-no"
  );
  const countRemark = `A186 盘点复验 ${runShort}`;
  await page.getByTestId("stock-count-remark").fill(countRemark);
  await waitForTabDirtyState(page, "stock-count-form", true);
  await page.getByTestId("save-sales-order").click();
  await waitUntil(() => evidence.requests.headerDrafts.length === 3, 10000, "stock-count remark save");
  await waitUntil(() => evidence.requests.headerDetailGets.stockCount >= 2, 10000, "stock-count detail reload after save");
  await waitForTabDirtyState(page, "stock-count-form", false);
  const countRemarkAfterSave = await page.getByTestId("stock-count-remark").inputValue();
  assert(countRemarkAfterSave === countRemark, "stock-count automatic detail reload must preserve the saved remark", countRemarkAfterSave);
  await closeDocumentForm(page, "stock-count-form", 14);
  await openDetailFromList(page, "库存管理", "stock-count-form", "stock-count-form-list", countHeaderBillNo, "stock-count-bill-no");
  await waitUntil(() => evidence.requests.headerDetailGets.stockCount >= 3, 10000, "stock-count detail reopen");
  await page.waitForFunction(
    ({ id, value }) => document.querySelector(`[data-testid="${id}"]`)?.value === value,
    { id: "stock-count-remark", value: countRemark }
  );
  const countRemarkAfterReopen = await page.getByTestId("stock-count-remark").inputValue();
  const headerShot = `a186-document-headers-${runShort}.png`;
  await page.screenshot({ path: path.join(screenshotDir, headerShot), fullPage: true });
  evidence.screenshots.push(`verification/playwright/${headerShot}`);
  await closeDocumentForm(page, "stock-count-form", 16);
  assert(
    JSON.stringify(evidence.requests.headerDrafts.map((item) => [item.type, item.payload.billNo, item.payload.remark])) === JSON.stringify([
      ["productIn", productInHeaderBillNo, completionRemark],
      ["stockTransfer", transferHeaderBillNo, transferRemark],
      ["stockCount", countHeaderBillNo, countRemark]
    ]),
    "three header draft requests must update their exact bill numbers with exact visible remarks",
    evidence.requests.headerDrafts
  );
  assert(
    JSON.stringify(evidence.requests.headerDetailGets) === JSON.stringify({ materialIssue: 2, productIn: 3, stockTransfer: 3, stockCount: 3 }),
    "five document header scenarios must issue the exact detail GET counts",
    evidence.requests.headerDetailGets
  );
  evidence.checks.documentHeaderScenarios = [
    { defectId: "UAT-A186-012", documentType: "materialIssue", billNo: issueHeaderBillNo, initial: issueProductInfo, afterReopen: issueProductInfoAfterReopen },
    { defectId: "UAT-A186-013", documentType: "productIn", billNo: productInHeaderBillNo, initial: completionProductInfo, afterSave: completionProductInfoAfterSave, afterReopen: completionProductInfoAfterReopen },
    { defectId: "UAT-A186-014", documentType: "productIn", billNo: productInHeaderBillNo, expectedRemark: completionRemark, observedAfterSave: completionRemarkAfterSave, observedAfterReopen: completionRemarkAfterReopen },
    { defectId: "UAT-A186-014", documentType: "stockTransfer", billNo: transferHeaderBillNo, expectedRemark: transferRemark, observedAfterSave: transferRemarkAfterSave, observedAfterReopen: transferRemarkAfterReopen },
    { defectId: "UAT-A186-014", documentType: "stockCount", billNo: countHeaderBillNo, expectedRemark: countRemark, observedAfterSave: countRemarkAfterSave, observedAfterReopen: countRemarkAfterReopen }
  ];

  await openEntry(page, "库存管理", "stock-count-loss-form");
  const printButton = page.getByTestId("print-sales-order");
  assert(await printButton.isDisabled(), "unsaved stock-count-loss print must be disabled");
  assert(evidence.requests.lossPrints.length === 0, "unsaved form must not issue a print request");
  await page.getByTestId("stock-count-loss-bill-date").fill("2026-08-16");
  await page.getByTestId("stock-count-loss-department").fill(`A186 output ${runShort}`);
  await page.getByTestId("stock-count-loss-line-product").fill("CP-001");
  await page.getByTestId("stock-count-loss-line-warehouse").fill("CK-001");
  await page.getByTestId("stock-count-loss-line-qty").fill("1");
  await page.getByTestId("stock-count-loss-line-price").fill("1");
  await page.getByTestId("save-sales-order").click();
  await page.waitForFunction((billNo) => {
    const input = document.querySelector('[data-testid="stock-count-loss-bill-no"]');
    return input instanceof HTMLInputElement && input.value === billNo;
  }, lossBillNo);
  assert(!(await printButton.isDisabled()), "saved DRAFT stock-count-loss print must be enabled");

  await printButton.click();
  await waitForText(page.getByTestId("form-message"), "A186 受控后端打印拒绝");
  await printButton.click();
  await waitForText(page.getByTestId("form-message"), "PDF 打印文件已生成");
  await page.getByTestId("audit-sales-order").click();
  await waitForText(page.getByTestId("form-message"), "审核成功");
  assert(!(await printButton.isDisabled()), "saved AUDITED stock-count-loss print must remain enabled");
  await printButton.click();
  await waitForText(page.getByTestId("form-message"), "PDF 打印文件已生成");

  const openedUrls = await page.evaluate(() => window.__a186OpenedUrls ?? []);
  assert(openedUrls.length === 2 && openedUrls.every((url) => url.startsWith("blob:")), "successful DRAFT and AUDITED prints must open generated blob URLs", openedUrls);
  assert(JSON.stringify(evidence.requests.lossPrints) === JSON.stringify(["DRAFT", "DRAFT", "AUDITED"]), "stock loss print status matrix mismatch", evidence.requests.lossPrints);
  assert(evidence.requests.lossAudits === 1, "stock loss audit request count mismatch", evidence.requests.lossAudits);
  evidence.checks.stockCountLossOutput = {
    unsavedPrintDisabled: true,
    backendErrorMessagePreserved: true,
    printStatuses: evidence.requests.lossPrints,
    openedBlobCount: openedUrls.length
  };

  const lossShot = `a186-stock-count-loss-output-${runShort}.png`;
  await page.screenshot({ path: path.join(screenshotDir, lossShot), fullPage: true });
  evidence.screenshots.push(`verification/playwright/${lossShot}`);

  const expectedDocumentLocks = [
    `POST /api/document-locks/materialIssue/${issueHeaderBillNo}/acquire`,
    `DELETE /api/document-locks/materialIssue/${issueHeaderBillNo}`,
    `POST /api/document-locks/materialIssue/${issueHeaderBillNo}/acquire`,
    `DELETE /api/document-locks/materialIssue/${issueHeaderBillNo}`,
    `POST /api/document-locks/productIn/${productInHeaderBillNo}/acquire`,
    `DELETE /api/document-locks/productIn/${productInHeaderBillNo}`,
    `POST /api/document-locks/productIn/${productInHeaderBillNo}/acquire`,
    `DELETE /api/document-locks/productIn/${productInHeaderBillNo}`,
    `POST /api/document-locks/stockTransfer/${transferHeaderBillNo}/acquire`,
    `DELETE /api/document-locks/stockTransfer/${transferHeaderBillNo}`,
    `POST /api/document-locks/stockTransfer/${transferHeaderBillNo}/acquire`,
    `DELETE /api/document-locks/stockTransfer/${transferHeaderBillNo}`,
    `POST /api/document-locks/stockCount/${countHeaderBillNo}/acquire`,
    `DELETE /api/document-locks/stockCount/${countHeaderBillNo}`,
    `POST /api/document-locks/stockCount/${countHeaderBillNo}/acquire`,
    `DELETE /api/document-locks/stockCount/${countHeaderBillNo}`
  ];
  assert(
    JSON.stringify(evidence.requests.documentLocks) === JSON.stringify(expectedDocumentLocks),
    "controlled document-lock writes must acquire and release each exact document in order",
    evidence.requests.documentLocks
  );
  assert(evidence.requests.unexpectedWrites.length === 0, "no unapproved real write may escape the controlled browser script", evidence.requests.unexpectedWrites);
  runCompleted = true;
} catch (error) {
  primaryError = error;
  evidence.error = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
} finally {
  releaseFirstTaskRequest.resolve(true);
  if (browser) {
    try {
      await browser.close();
    } catch (error) {
      closeError = error;
    }
  }
  evidence.ok = runCompleted && !primaryError && !closeError;
  if (closeError) {
    const closeMessage = closeError instanceof Error ? `${closeError.name}: ${closeError.message}` : String(closeError);
    evidence.error = evidence.error ? `${evidence.error}; browser cleanup: ${closeMessage}` : `browser cleanup: ${closeMessage}`;
  }
  await writeFile(resultPath, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
}

if (primaryError && closeError) {
  throw new AggregateError([primaryError, closeError], "A186 production/output regression and browser cleanup both failed");
}
if (primaryError) {
  throw primaryError;
}
if (closeError) {
  throw closeError;
}

console.log(JSON.stringify({
  ok: evidence.ok,
  runId,
  resultPath,
  checks: evidence.checks,
  screenshots: evidence.screenshots
}, null, 2));
