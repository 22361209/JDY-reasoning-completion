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

async function waitForText(locator, text) {
  await locator.filter({ hasText: text }).waitFor({ state: "visible", timeout: 10000 });
}

const firstTaskRequestSeen = deferred();
const releaseFirstTaskRequest = deferred();
const evidence = {
  taskId: "A186-5",
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
