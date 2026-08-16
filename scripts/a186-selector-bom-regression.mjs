#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";

import { loginAsAdmin } from "./helpers/regression-auth.mjs";

const rootDir = path.resolve(import.meta.dirname, "..");
const verificationDir = path.join(rootDir, "verification");
const screenshotDir = path.join(verificationDir, "playwright");
const resultPath = path.join(verificationDir, "a186-selector-bom-regression.json");
const frontendUrl = process.env.JDY_WEB_BASE || "http://127.0.0.1:5173/";
const runId = randomUUID();
const runShort = runId.replaceAll("-", "").slice(0, 12);
const mockSalesOrderBillNo = `XSDDA186${runShort.toUpperCase()}`;
const product = {
  id: randomUUID(),
  code: `A186-P-${runShort}`,
  name: `A186 选择器物料 ${runShort}`,
  spec: "A186-SPEC",
  unit: "件",
  defaultWarehouseCode: "CK-001",
  defaultWorkshopCode: "SCBM-001",
  isProduce: "是",
  status: "启用",
  auditStatus: "已审核"
};
const warehouses = [
  { id: randomUUID(), code: "CK-001", name: "A186 一仓", status: "启用", auditStatus: "已审核" },
  { id: randomUUID(), code: "CK-002", name: "A186 二仓", status: "启用", auditStatus: "已审核" },
  { id: randomUUID(), code: "CK-003", name: "A186 三仓", status: "启用", auditStatus: "已审核" }
];
const bom = {
  id: randomUUID(),
  code: `BOM-A186-${runShort}`,
  versionNo: "V1",
  productCode: product.code,
  status: "启用",
  auditStatus: "已审核",
  isCurrent: "是"
};
const raceProductA = {
  ...product,
  id: randomUUID(),
  code: `A186-PA-${runShort}`,
  name: `A186 竞态物料 A ${runShort}`
};
const raceProductB = {
  ...product,
  id: randomUUID(),
  code: `A186-PB-${runShort}`,
  name: `A186 竞态物料 B ${runShort}`,
  defaultWarehouseCode: "CK-003"
};
const raceBomA = { ...bom, id: randomUUID(), code: `BOM-A186-A-${runShort}`, productCode: raceProductA.code };
const raceBomB = { ...bom, id: randomUUID(), code: `BOM-A186-B-${runShort}`, productCode: raceProductB.code };
const customer = { id: randomUUID(), code: `A186-C-${runShort}`, name: `A186 客户 ${runShort}`, status: "启用", auditStatus: "已审核" };
const outsourcingSource = {
  billNo: `A186-WO-${runShort}`,
  sourceLineNo: 1,
  supplierCode: `A186-S-${runShort}`,
  supplierName: `A186 供应商 ${runShort}`,
  productCode: product.code,
  productName: product.name,
  spec: product.spec,
  unit: product.unit,
  warehouseCode: "CK-001",
  remainingQty: "2",
  lineRemark: "A186 source"
};

await mkdir(verificationDir, { recursive: true });
await mkdir(screenshotDir, { recursive: true });

function assert(condition, message, details) {
  if (!condition) {
    const suffix = details === undefined ? "" : `: ${JSON.stringify(details)}`;
    throw new Error(`${message}${suffix}`);
  }
}

function errorText(error) {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function listPayload(rows, url) {
  return {
    page: Number(url.searchParams.get("page") || 1),
    pageSize: Number(url.searchParams.get("pageSize") || 100),
    total: rows.length,
    rows
  };
}

async function fulfillJson(route, data, status = 200) {
  await route.fulfill({
    status,
    contentType: "application/json",
    body: JSON.stringify(data)
  });
}

async function openForm(page, moduleName, entryId, prefix) {
  await page.getByTestId(`module-${moduleName}`).hover();
  await page.getByTestId(`entry-${entryId}`).click();
  await page.getByTestId(`${prefix}-line-product`).waitFor({ state: "visible", timeout: 10000 });
}

async function selectInlineProduct(page, prefix, optionValue = product) {
  const input = page.getByTestId(`${prefix}-line-product`);
  await input.focus();
  await input.fill(optionValue.code);
  const row = page.getByTestId(`${prefix}-entry-row`).first();
  const option = row.locator(".master-selector__menu button").filter({ hasText: optionValue.code }).first();
  await option.waitFor({ state: "visible", timeout: 10000 });
  await option.click();
  await page.waitForFunction(({ testId, name }) => {
    const target = document.querySelector(`[data-testid="${testId}"]`)?.closest("tr");
    return Boolean(target?.textContent?.includes(name));
  }, { testId: `${prefix}-line-product`, name: optionValue.name });
  return row;
}

async function selectInlineParty(page, prefix) {
  const input = page.getByTestId(`${prefix}-party-code`);
  await input.focus();
  await input.fill(customer.code);
  const option = page.locator(".master-selector__menu button").filter({ hasText: customer.code }).first();
  await option.waitFor({ state: "visible", timeout: 10000 });
  await option.click();
  await page.waitForFunction(({ testId, value }) => document.querySelector(`[data-testid="${testId}"]`)?.value === value,
    { testId: `${prefix}-party-code`, value: customer.code });
  const sourceDialog = page.getByTestId(`${prefix}-source-selector-dialog`);
  if (await sourceDialog.isVisible().catch(() => false)) {
    await page.getByTestId(`${prefix}-source-selector-cancel`).click();
    await sourceDialog.waitFor({ state: "hidden", timeout: 10000 });
  }
}

async function nativeSingleCellPaste(page, testId, value) {
  return page.getByTestId(testId).evaluate((input, pastedValue) => {
    if (!(input instanceof HTMLInputElement)) {
      throw new Error(`paste target is not an input: ${input}`);
    }
    const dataTransfer = new DataTransfer();
    dataTransfer.setData("text/plain", String(pastedValue));
    const event = new ClipboardEvent("paste", {
      bubbles: true,
      cancelable: true,
      clipboardData: dataTransfer
    });
    input.dispatchEvent(event);
    if (!event.defaultPrevented) {
      input.value = String(pastedValue);
      input.dispatchEvent(new InputEvent("input", {
        bubbles: true,
        inputType: "insertFromPaste",
        data: String(pastedValue)
      }));
    }
    return { defaultPrevented: event.defaultPrevented, value: input.value };
  }, value);
}

async function structuredPaste(page, testId, value) {
  return page.getByTestId(testId).evaluate((input, pastedValue) => {
    const dataTransfer = new DataTransfer();
    dataTransfer.setData("text/plain", String(pastedValue));
    const event = new ClipboardEvent("paste", {
      bubbles: true,
      cancelable: true,
      clipboardData: dataTransfer
    });
    input.dispatchEvent(event);
    return event.defaultPrevented;
  }, value);
}

async function lineSnapshot(page, prefix) {
  const row = page.getByTestId(`${prefix}-entry-row`).first();
  const targetWarehouse = page.getByTestId(`${prefix}-line-target-warehouse`);
  return {
    productCode: await page.getByTestId(`${prefix}-line-product`).inputValue(),
    productName: (await page.getByTestId(`${prefix}-line-product-name`).innerText()).trim(),
    spec: (await page.getByTestId(`${prefix}-line-spec`).innerText()).trim(),
    unit: (await page.getByTestId(`${prefix}-line-unit`).innerText()).trim(),
    warehouseCode: await page.getByTestId(`${prefix}-line-warehouse`).inputValue(),
    targetWarehouseCode: await targetWarehouse.count() ? await targetWarehouse.inputValue() : "",
    qty: await page.getByTestId(`${prefix}-line-qty`).inputValue(),
    price: await page.getByTestId(`${prefix}-line-price`).inputValue(),
    rowText: (await row.innerText()).replaceAll(/\s+/g, " ").trim()
  };
}

function assertMaterialSnapshotUnchanged(before, after, label) {
  assert(after.productCode === before.productCode, `${label} must preserve product code`, { before, after });
  assert(after.productName === before.productName, `${label} must preserve product name`, { before, after });
  assert(after.spec === before.spec, `${label} must preserve product spec`, { before, after });
  assert(after.unit === before.unit, `${label} must preserve product unit`, { before, after });
  assert(after.qty === before.qty, `${label} must preserve quantity`, { before, after });
}

function assertMaterialIdentityUnchanged(before, after, label) {
  assert(after.productCode === before.productCode, `${label} must preserve product code`, { before, after });
  assert(after.productName === before.productName, `${label} must preserve product name`, { before, after });
  assert(after.spec === before.spec, `${label} must preserve product spec`, { before, after });
  assert(after.unit === before.unit, `${label} must preserve product unit`, { before, after });
  assert(after.warehouseCode === before.warehouseCode, `${label} must preserve warehouse`, { before, after });
  assert(after.qty === before.qty, `${label} must preserve quantity`, { before, after });
}

async function settleUi(page) {
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}

async function selectInlineWarehouse(page, prefix, code) {
  const input = page.getByTestId(`${prefix}-line-warehouse`);
  await input.focus();
  await input.fill(code);
  const row = page.getByTestId(`${prefix}-entry-row`).first();
  const option = row.locator(".master-selector__menu button").filter({ hasText: code }).first();
  await option.waitFor({ state: "visible", timeout: 10000 });
  await option.click();
  await page.waitForFunction(({ testId, value }) => document.querySelector(`[data-testid="${testId}"]`)?.value === value,
    { testId: `${prefix}-line-warehouse`, value: code });
}

async function selectFullWarehouse(page, prefix, code) {
  await page.getByTestId(`${prefix}-line-warehouse-open-selector`).click();
  const dialog = page.getByTestId("master-selector-source-selector-dialog");
  await dialog.waitFor({ state: "visible", timeout: 10000 });
  await page.getByTestId(`master-selector-source-line-${code}`).click();
  await dialog.waitFor({ state: "hidden", timeout: 10000 });
  await page.waitForFunction(({ testId, value }) => document.querySelector(`[data-testid="${testId}"]`)?.value === value,
    { testId: `${prefix}-line-warehouse`, value: code });
}

async function assertWarehousePasteIsolation(page, prefix, targetWarehouse = "CK-002") {
  await selectInlineProduct(page, prefix);
  const before = await lineSnapshot(page, prefix);
  await page.getByTestId(`${prefix}-line-warehouse`).fill("CK-003");
  const afterTyping = await lineSnapshot(page, prefix);
  assertMaterialSnapshotUnchanged(before, afterTyping, `${prefix} warehouse typing`);
  assert(afterTyping.warehouseCode === "CK-003", `${prefix} warehouse typing must update only warehouse`, { before, afterTyping });
  await selectInlineWarehouse(page, prefix, "CK-001");
  const afterInline = await lineSnapshot(page, prefix);
  assertMaterialSnapshotUnchanged(before, afterInline, `${prefix} warehouse inline selection`);
  assert(afterInline.warehouseCode === "CK-001", `${prefix} inline selection must update warehouse`, afterInline);
  await selectFullWarehouse(page, prefix, "CK-003");
  const afterFull = await lineSnapshot(page, prefix);
  assertMaterialSnapshotUnchanged(before, afterFull, `${prefix} warehouse full selection`);
  assert(afterFull.warehouseCode === "CK-003", `${prefix} full selection must update warehouse`, afterFull);
  const paste = await nativeSingleCellPaste(page, `${prefix}-line-warehouse`, targetWarehouse);
  assert(!paste.defaultPrevented, `${prefix} warehouse single-cell paste must remain native`, paste);
  await page.getByTestId(`${prefix}-line-warehouse`).waitFor({ state: "visible" });
  const after = await lineSnapshot(page, prefix);
  assertMaterialSnapshotUnchanged(before, after, `${prefix} warehouse paste`);
  assert(after.warehouseCode === targetWarehouse, `${prefix} warehouse paste must update only warehouse`, { before, after });
  return { before, afterTyping, afterInline, afterFull, after, paste };
}

async function clickNewDocument(page) {
  await page.getByTestId("new-document").click();
  const dialog = page.getByTestId("new-document-unsaved-dialog");
  if (await dialog.isVisible().catch(() => false)) {
    await page.getByTestId("new-document-unsaved-confirm").click();
    await dialog.waitFor({ state: "hidden" });
  }
}

async function selectProductionPlanProduct(page, optionValue = product, lineNumber = 1) {
  const input = page.getByTestId(`production-plan-product-code-${lineNumber}`);
  await input.focus();
  await input.fill(optionValue.code);
  const option = page.getByTestId(`production-plan-product-option-${lineNumber}-1`);
  await option.waitFor({ state: "visible", timeout: 10000 });
  await option.click();
}

const evidence = {
  taskId: "A186-4",
  runId,
  generatedAt: new Date().toISOString(),
  ok: false,
  checks: {},
  requests: {
    productLists: 0,
    warehouseLists: 0,
    bomLists: 0,
    mockedBusinessWrites: [],
    blockedUnexpectedWrites: []
  },
  screenshots: [],
  error: ""
};

let browser;
let primaryError;
let closeError;
let bomMode = "success";
let productListGate = null;
let salesPriceGate = null;
let bulkPriceGate = null;
let mockSalesOrderPayload = null;
let outsourcingDetailGate = null;
let bomRaceGate = null;

try {
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1803, height: 960 } });
  const page = await context.newPage();
  await page.goto(frontendUrl, { waitUntil: "networkidle" });
  await loginAsAdmin(page);

  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (request.method() === "POST" && url.pathname === "/api/sales-orders/draft") {
      mockSalesOrderPayload = request.postDataJSON();
      evidence.requests.mockedBusinessWrites.push("POST /api/sales-orders/draft");
      await fulfillJson(route, { billNo: mockSalesOrderBillNo, status: "DRAFT" }, 201);
      return;
    }
    if (request.method() === "GET" && url.pathname === `/api/sales-orders/${mockSalesOrderBillNo}`) {
      assert(mockSalesOrderPayload, "mock sales-order detail requires an owned prior draft payload");
      await fulfillJson(route, {
        document: {
          billNo: mockSalesOrderBillNo,
          version: 1,
          customerCode: mockSalesOrderPayload.customerCode,
          customer: customer.name,
          billDate: mockSalesOrderPayload.billDate,
          currency: mockSalesOrderPayload.currency || "CNY",
          department: mockSalesOrderPayload.department || "",
          ownerName: mockSalesOrderPayload.ownerName || "A186",
          remark: mockSalesOrderPayload.remark || "",
          status: "DRAFT",
          closeStatus: "OPEN",
          closeMode: null,
          frozenStatus: "NORMAL"
        },
        lines: mockSalesOrderPayload.lines.map((line, index) => ({
          ...line,
          lineNo: index + 1,
          productId: line.productId || product.id,
          productName: line.productName || product.name,
          spec: line.spec || product.spec,
          unit: line.unit || product.unit
        }))
      });
      return;
    }
    if (request.method() === "POST" && url.pathname === "/api/production/plans") {
      const payload = request.postDataJSON();
      evidence.requests.mockedBusinessWrites.push("POST /api/production/plans");
      await fulfillJson(route, {
        billNo: `SCJHA186${runShort.toUpperCase()}`,
        sourceType: payload.sourceType || "SELF",
        warehouseCode: payload.warehouseCode || "",
        departmentCode: payload.departmentCode || "",
        status: "DRAFT",
        lines: [{
          id: randomUUID(),
          lineNo: 1,
          productId: product.id,
          productCode: product.code,
          productName: product.name,
          spec: product.spec,
          bomCode: bom.code,
          bomVersionNo: bom.versionNo,
          unit: product.unit,
          warehouseCode: "CK-001",
          departmentCode: product.defaultWorkshopCode,
          qty: 1,
          planDeliveryDate: payload.lines?.[0]?.planDeliveryDate || "2026-08-16",
          inProgressQty: 0,
          assignedQty: 0,
          remainingQty: 1,
          expandMultilevelTasks: false,
          generatePurchaseRequisition: true
        }]
      });
      return;
    }
    if (request.method() === "GET" && url.pathname === "/api/sales-prices/unit-price") {
      const gate = salesPriceGate;
      if (gate && url.searchParams.get("productCode") === gate.productCode) {
        gate.started.resolve();
        await gate.release.promise;
      }
      await fulfillJson(route, {
        customerCode: url.searchParams.get("customerCode"),
        productCode: url.searchParams.get("productCode"),
        unitPrice: 31,
        source: "A186"
      });
      gate?.completed.resolve();
      return;
    }
    if (request.method() === "GET" && url.pathname === "/api/sales-prices/unit-price-sources") {
      const gate = bulkPriceGate;
      gate?.started.resolve();
      if (gate) {
        await gate.release.promise;
      }
      const productCodes = (url.searchParams.get("productCodes") || "")
        .split(",")
        .map((code) => code.trim())
        .filter(Boolean);
      await fulfillJson(route, {
        customerCode: url.searchParams.get("customerCode"),
        products: Object.fromEntries(productCodes.map((code) => [code, {
          defaultPrice: { available: true, value: 55, source: "A186" }
        }]))
      });
      gate?.completed.resolve();
      return;
    }
    if (request.method() === "GET" && url.pathname === `/api/outsourcing/work-orders/${outsourcingSource.billNo}`) {
      const gate = outsourcingDetailGate;
      gate?.started.resolve();
      if (gate) {
        await gate.release.promise;
      }
      await fulfillJson(route, {
        billNo: outsourcingSource.billNo,
        supplierCode: outsourcingSource.supplierCode,
        status: "AUDITED",
        lines: [],
        components: [{
          lineNo: 1,
          productCode: product.code,
          productName: product.name,
          spec: product.spec,
          unit: product.unit,
          warehouseCode: "CK-001",
          qty: 2,
          issuedQty: 0
        }]
      });
      gate?.completed.resolve();
      return;
    }
    if (request.method() === "GET" || request.method() === "HEAD") {
      await route.continue();
      return;
    }
    evidence.requests.blockedUnexpectedWrites.push(`${request.method()} ${new URL(request.url()).pathname}`);
    await route.abort("blockedbyclient");
  });
  await page.route("**/api/lists/**", async (route) => {
    const request = route.request();
    if (request.method() !== "GET") {
      evidence.requests.blockedUnexpectedWrites.push(`${request.method()} ${new URL(request.url()).pathname}`);
      await route.abort("blockedbyclient");
      return;
    }
    const url = new URL(request.url());
    if (url.pathname === "/api/lists/product-master-list") {
      evidence.requests.productLists += 1;
      const keyword = url.searchParams.get("keyword") || "";
      const gate = productListGate;
      const gated = gate && keyword === gate.keyword ? gate : null;
      if (gated) {
        gated.started.resolve();
        await gated.release.promise;
      }
      const rows = bomMode === "emptyFull"
        ? [raceProductB]
        : keyword.includes(raceProductA.code)
          ? [raceProductA]
          : keyword.includes(raceProductB.code)
            ? [raceProductB]
            : [product];
      await fulfillJson(route, listPayload(rows, url));
      gated?.completed.resolve();
      return;
    }
    if (url.pathname === "/api/lists/customer-master-list") {
      await fulfillJson(route, listPayload([customer], url));
      return;
    }
    if (url.pathname === "/api/lists/warehouse-master-selector") {
      evidence.requests.warehouseLists += 1;
      await fulfillJson(route, listPayload(warehouses, url));
      return;
    }
    if (url.pathname === "/api/lists/bom-list") {
      evidence.requests.bomLists += 1;
      const productCode = url.searchParams.get("keyword") || "";
      if (bomMode === "race" && productCode === raceProductA.code) {
        const gate = bomRaceGate;
        gate?.started.resolve();
        if (gate) {
          await gate.release.promise;
        }
        await fulfillJson(route, listPayload([raceBomA], url));
        gate?.completed.resolve();
        return;
      }
      if (bomMode === "race" && productCode === raceProductB.code) {
        await fulfillJson(route, listPayload([raceBomB], url));
        return;
      }
      if (bomMode === "error") {
        await fulfillJson(route, { message: "A186 模拟 BOM 查询失败" }, 500);
        return;
      }
      await fulfillJson(route, listPayload(bomMode === "empty" || bomMode === "emptyFull" ? [] : [bom], url));
      return;
    }
    if (url.pathname === "/api/lists/outsourcing-work-order-issue-source-selector") {
      await fulfillJson(route, listPayload([outsourcingSource], url));
      return;
    }
    await route.continue();
  });

  await openForm(page, "销售管理", "sales-quote-form", "sales-quote");
  const quoteWarehouse = await assertWarehousePasteIsolation(page, "sales-quote");
  const quoteBeforePrice = await lineSnapshot(page, "sales-quote");
  await page.getByTestId("sales-quote-line-price").fill("17");
  const quoteAfterTypedPrice = await lineSnapshot(page, "sales-quote");
  assertMaterialIdentityUnchanged(quoteBeforePrice, quoteAfterTypedPrice, "sales quote typed price");
  assert(Number(quoteAfterTypedPrice.price) === 17, "sales quote typed price must update only unit price", quoteAfterTypedPrice);
  const pricePaste = await nativeSingleCellPaste(page, "sales-quote-line-price", "19");
  const quoteAfterPrice = await lineSnapshot(page, "sales-quote");
  assert(!pricePaste.defaultPrevented, "sales quote price single-cell paste must remain native", pricePaste);
  assertMaterialIdentityUnchanged(quoteAfterTypedPrice, quoteAfterPrice, "sales quote pasted price");
  assert(Number(quoteAfterPrice.price) === 19, "sales quote price paste must update only unit price", quoteAfterPrice);

  await openForm(page, "销售管理", "sales-order-form", "sales");
  const orderWarehouse = await assertWarehousePasteIsolation(page, "sales");
  const structuredText = [
    `${product.code}\tCK-001\t2\t11`,
    `${product.code}\tCK-002\t3\t12`
  ].join("\n");
  const structuredPrevented = await structuredPaste(page, "sales-line-product", structuredText);
  assert(structuredPrevented, "structured paste from product column must be handled");
  await page.getByText("已粘贴 2 行分录").waitFor({ state: "visible", timeout: 10000 });
  assert(await page.getByTestId("sales-entry-row").count() === 2, "structured paste must retain the existing multi-row capability");

  await clickNewDocument(page);
  const delayedSelectorStarted = deferred();
  const delayedSelectorRelease = deferred();
  const delayedSelectorCompleted = deferred();
  productListGate = {
    keyword: "A186-DELAYED-SELECTOR",
    started: delayedSelectorStarted,
    release: delayedSelectorRelease,
    completed: delayedSelectorCompleted
  };
  const delayedInput = page.getByTestId("sales-line-product");
  await delayedInput.focus();
  await delayedInput.fill("A186-DELAYED-SELECTOR");
  await delayedSelectorStarted.promise;
  await page.getByTestId("sales-line-insert").click();
  await page.getByTestId("sales-line-delete").click();
  delayedSelectorRelease.resolve();
  await delayedSelectorCompleted.promise;
  await settleUi(page);
  assert(await page.getByTestId("sales-entry-row").count() === 1, "delayed selector insert/delete must leave one stable row");
  assert(await page.getByTestId("sales-line-product").inputValue() === "", "stale selector response must not refill deleted target row");
  assert(await page.getByTestId("sales-entry-row").first().locator(".master-selector__menu").count() === 0, "stale selector menu must remain closed after row replacement");
  productListGate = null;

  const delayedPasteStarted = deferred();
  const delayedPasteRelease = deferred();
  const delayedPasteCompleted = deferred();
  productListGate = {
    keyword: "",
    started: delayedPasteStarted,
    release: delayedPasteRelease,
    completed: delayedPasteCompleted
  };
  const delayedPastePrevented = await structuredPaste(page, "sales-line-product", structuredText);
  assert(delayedPastePrevented, "delayed structured paste must be owned by entry paste parser");
  await delayedPasteStarted.promise;
  await clickNewDocument(page);
  delayedPasteRelease.resolve();
  await delayedPasteCompleted.promise;
  await settleUi(page);
  assert(await page.getByTestId("sales-entry-row").count() === 1, "new document must replace delayed paste target rows");
  assert(await page.getByTestId("sales-line-product").inputValue() === "", "delayed paste must not cross into a new document");
  assert(await page.getByText("已粘贴 2 行分录").count() === 0, "stale delayed paste must not publish a success message");
  productListGate = null;

  const editedPasteStarted = deferred();
  const editedPasteRelease = deferred();
  const editedPasteCompleted = deferred();
  productListGate = {
    keyword: "",
    started: editedPasteStarted,
    release: editedPasteRelease,
    completed: editedPasteCompleted
  };
  assert(await structuredPaste(page, "sales-line-product", structuredText), "edited-target structured paste must be handled while references load");
  await editedPasteStarted.promise;
  await page.getByTestId("sales-line-price").fill("88");
  editedPasteRelease.resolve();
  await editedPasteCompleted.promise;
  await settleUi(page);
  assert(await page.getByTestId("sales-line-product").inputValue() === "", "older generic paste must not overwrite a later line edit");
  assert(Number(await page.getByTestId("sales-line-price").inputValue()) === 88, "later generic line edit must win over an in-flight paste");
  assert(await page.getByText("已粘贴 2 行分录").count() === 0, "cancelled generic paste must not publish success");
  productListGate = null;

  await clickNewDocument(page);
  await selectInlineParty(page, "sales");
  const bulkRows = [
    `${product.code}\tCK-001\t1\t10`,
    `${product.code}\tCK-001\t1\t20`,
    `${product.code}\tCK-001\t1\t30`
  ].join("\n");
  assert(await structuredPaste(page, "sales-line-product", bulkRows), "bulk-price setup paste must be handled");
  await page.getByText("已粘贴 3 行分录").waitFor({ state: "visible", timeout: 10000 });
  assert(await page.getByTestId("sales-entry-row").count() === 3, "bulk-price setup must create three stable targets");
  await page.getByTestId("sales-line-price").fill("10");
  await page.getByTestId("sales-line-price-2").fill("20");
  await page.getByTestId("sales-line-price-3").fill("30");
  const bulkStarted = deferred();
  const bulkRelease = deferred();
  const bulkCompleted = deferred();
  bulkPriceGate = { started: bulkStarted, release: bulkRelease, completed: bulkCompleted };
  await page.getByTestId("entry-column-bulk-unitPrice").click();
  await page.getByTestId("entry-column-bulk-dialog").waitFor({ state: "visible", timeout: 10000 });
  await page.getByTestId("entry-bulk-price-source").selectOption("defaultPrice");
  await page.getByTestId("entry-bulk-price-operator").selectOption("+");
  await page.getByTestId("entry-bulk-price-factor").fill("0");
  await page.getByTestId("entry-bulk-price-ok").click();
  await bulkStarted.promise;
  await page.getByTestId("sales-line-price-2").fill("77");
  await page.getByTestId("sales-entry-row").nth(2).hover();
  await page.getByTestId("sales-line-delete-3").click();
  await page.getByTestId("sales-entry-row").nth(1).hover();
  await page.getByTestId("sales-line-insert-2").click();
  bulkRelease.resolve();
  await bulkCompleted.promise;
  await settleUi(page);
  assert(Number(await page.getByTestId("sales-line-price").inputValue()) === 55, "unchanged bulk-price target must receive the selected source price");
  assert(Number(await page.getByTestId("sales-line-price-2").inputValue()) === 77, "manual price entered while bulk request is pending must win");
  assert(await page.getByTestId("sales-line-product-3").inputValue() === "", "replacement row must not inherit deleted bulk-price target material");
  assert(Number(await page.getByTestId("sales-line-price-3").inputValue()) === 0, "replacement row must not receive deleted bulk-price target value");
  bulkPriceGate = null;

  await clickNewDocument(page);
  await selectInlineParty(page, "sales");
  assert(await structuredPaste(page, "sales-line-product", `${product.code}\tCK-001\t1\t10`), "bulk-then-paste setup must create one priced row");
  await page.getByText("已粘贴 1 行分录").waitFor({ state: "visible", timeout: 10000 });
  const olderBulkStarted = deferred();
  const olderBulkRelease = deferred();
  const olderBulkCompleted = deferred();
  bulkPriceGate = { started: olderBulkStarted, release: olderBulkRelease, completed: olderBulkCompleted };
  await page.getByTestId("entry-column-bulk-unitPrice").click();
  await page.getByTestId("entry-bulk-price-ok").click();
  await olderBulkStarted.promise;
  const newerPasteStarted = deferred();
  const newerPasteRelease = deferred();
  const newerPasteCompleted = deferred();
  productListGate = {
    keyword: "",
    started: newerPasteStarted,
    release: newerPasteRelease,
    completed: newerPasteCompleted
  };
  assert(await structuredPaste(page, "sales-line-product", `${product.code}\tCK-002\t2\t66`), "newer structured paste must start while bulk price is pending");
  await newerPasteStarted.promise;
  olderBulkRelease.resolve();
  await olderBulkCompleted.promise;
  newerPasteRelease.resolve();
  await newerPasteCompleted.promise;
  await settleUi(page);
  assert(await page.getByTestId("sales-line-product").inputValue() === product.code, "newer paste must preserve its material after older bulk result");
  assert(await page.getByTestId("sales-line-warehouse").inputValue() === "CK-002", "newer paste warehouse must win over older bulk result");
  assert(Number(await page.getByTestId("sales-line-qty").inputValue()) === 2, "newer paste quantity must win over older bulk result");
  assert(Number(await page.getByTestId("sales-line-price").inputValue()) === 66, "newer paste price must win over older bulk result");
  bulkPriceGate = null;
  productListGate = null;

  await page.getByTestId("save-sales-order").click();
  await page.waitForFunction((billNo) => document.querySelector('[data-testid="sales-bill-no"]')?.value === billNo,
    mockSalesOrderBillNo);
  assert(await page.getByText("有未保存改动").count() === 0, "mock-saved sales order must establish a clean draft before bulk pricing");
  const cleanBulkStarted = deferred();
  const cleanBulkRelease = deferred();
  const cleanBulkCompleted = deferred();
  bulkPriceGate = { started: cleanBulkStarted, release: cleanBulkRelease, completed: cleanBulkCompleted };
  await page.getByTestId("entry-column-bulk-unitPrice").click();
  await page.getByTestId("entry-bulk-price-ok").click();
  await cleanBulkStarted.promise;
  cleanBulkRelease.resolve();
  await cleanBulkCompleted.promise;
  await settleUi(page);
  assert(Number(await page.getByTestId("sales-line-price").inputValue()) === 55, "saved clean draft must receive the bulk source price");
  assert(await page.getByText("有未保存改动").isVisible(), "bulk price applied to a saved clean draft must mark it dirty");
  bulkPriceGate = null;

  await clickNewDocument(page);
  await selectInlineParty(page, "sales");
  await selectInlineProduct(page, "sales");
  await page.getByTestId("sales-line-warehouse").fill("CK-001");
  await page.getByTestId("sales-line-qty").fill("1");
  await page.getByTestId("sales-line-price").fill("10");
  const olderPasteStarted = deferred();
  const olderPasteRelease = deferred();
  const olderPasteCompleted = deferred();
  productListGate = {
    keyword: "",
    started: olderPasteStarted,
    release: olderPasteRelease,
    completed: olderPasteCompleted
  };
  assert(await structuredPaste(page, "sales-line-product", `${product.code}\tCK-003\t9\t99`), "older paste must begin before a newer bulk action");
  await olderPasteStarted.promise;
  const newerBulkStarted = deferred();
  const newerBulkRelease = deferred();
  const newerBulkCompleted = deferred();
  bulkPriceGate = { started: newerBulkStarted, release: newerBulkRelease, completed: newerBulkCompleted };
  await page.getByTestId("entry-column-bulk-unitPrice").click();
  await page.getByTestId("entry-bulk-price-ok").click();
  await newerBulkStarted.promise;
  newerBulkRelease.resolve();
  await newerBulkCompleted.promise;
  olderPasteRelease.resolve();
  await olderPasteCompleted.promise;
  await settleUi(page);
  assert(await page.getByTestId("sales-line-product").inputValue() === product.code, "newer bulk must preserve the original material when cancelling an older paste");
  assert(await page.getByTestId("sales-line-warehouse").inputValue() === "CK-001", "older paste must not replace warehouse after newer bulk starts");
  assert(Number(await page.getByTestId("sales-line-qty").inputValue()) === 1, "older paste must not replace quantity after newer bulk starts");
  assert(Number(await page.getByTestId("sales-line-price").inputValue()) === 55, "newer bulk price must win over an older in-flight paste");
  assert(await page.getByText("已粘贴 1 行分录").count() === 0, "cancelled older paste must not publish a success message");
  productListGate = null;
  bulkPriceGate = null;

  await clickNewDocument(page);
  await selectInlineParty(page, "sales");
  const genericManualStarted = deferred();
  const genericManualRelease = deferred();
  const genericManualCompleted = deferred();
  salesPriceGate = {
    productCode: product.code,
    started: genericManualStarted,
    release: genericManualRelease,
    completed: genericManualCompleted
  };
  await selectInlineProduct(page, "sales");
  await genericManualStarted.promise;
  await page.getByTestId("sales-line-price").fill("77");
  genericManualRelease.resolve();
  await genericManualCompleted.promise;
  await settleUi(page);
  assert(Number(await page.getByTestId("sales-line-price").inputValue()) === 77, "manual generic sales-order price must win over an older asynchronous quote");
  salesPriceGate = null;

  await clickNewDocument(page);
  await selectInlineParty(page, "sales");
  const genericRemovedStarted = deferred();
  const genericRemovedRelease = deferred();
  const genericRemovedCompleted = deferred();
  salesPriceGate = {
    productCode: product.code,
    started: genericRemovedStarted,
    release: genericRemovedRelease,
    completed: genericRemovedCompleted
  };
  await selectInlineProduct(page, "sales");
  await genericRemovedStarted.promise;
  await page.getByTestId("sales-line-insert").click();
  await page.getByTestId("sales-line-delete").click();
  genericRemovedRelease.resolve();
  await genericRemovedCompleted.promise;
  await settleUi(page);
  assert(await page.getByTestId("sales-line-product").inputValue() === "", "generic sales-order quote must not cross into a replacement row");
  assert(Number(await page.getByTestId("sales-line-price").inputValue()) === 0, "generic replacement row must keep its own default price");
  salesPriceGate = null;

  await openForm(page, "销售管理", "delivery-notice-form", "delivery-notice");
  const deliveryWarehouse = await assertWarehousePasteIsolation(page, "delivery-notice");

  await openForm(page, "采购管理", "purchase-order-form", "purchase");
  const purchaseWarehouse = await assertWarehousePasteIsolation(page, "purchase");

  await openForm(page, "库存管理", "stock-transfer-form", "stock-transfer");
  const transferWarehouse = await assertWarehousePasteIsolation(page, "stock-transfer");
  const transferBeforeTarget = await lineSnapshot(page, "stock-transfer");
  const targetPaste = await nativeSingleCellPaste(page, "stock-transfer-line-target-warehouse", "CK-003");
  const transferAfterTarget = await lineSnapshot(page, "stock-transfer");
  assert(!targetPaste.defaultPrevented, "target warehouse single-cell paste must remain native", targetPaste);
  assert(transferAfterTarget.productCode === transferBeforeTarget.productCode, "target warehouse paste must preserve product", { transferBeforeTarget, transferAfterTarget });
  assert(await page.getByTestId("stock-transfer-line-target-warehouse").inputValue() === "CK-003", "target warehouse paste must update target warehouse only");

  await openForm(page, "销售管理", "sales-out-form", "sales-out");
  await selectInlineParty(page, "sales-out");
  const manualPriceStarted = deferred();
  const manualPriceRelease = deferred();
  const manualPriceCompleted = deferred();
  salesPriceGate = {
    productCode: product.code,
    started: manualPriceStarted,
    release: manualPriceRelease,
    completed: manualPriceCompleted
  };
  await selectInlineProduct(page, "sales-out");
  await manualPriceStarted.promise;
  await page.getByTestId("sales-out-line-price").fill("77");
  manualPriceRelease.resolve();
  await manualPriceCompleted.promise;
  await settleUi(page);
  const salesOutManualPrice = await lineSnapshot(page, "sales-out");
  assert(Number(salesOutManualPrice.price) === 77, "manual sales-out price must win over an older asynchronous quote", salesOutManualPrice);
  assert(salesOutManualPrice.productCode === product.code && salesOutManualPrice.productName === product.name, "manual price protection must preserve selected sales-out material", salesOutManualPrice);
  salesPriceGate = null;

  await clickNewDocument(page);
  await selectInlineParty(page, "sales-out");
  const removedPriceStarted = deferred();
  const removedPriceRelease = deferred();
  const removedPriceCompleted = deferred();
  salesPriceGate = {
    productCode: product.code,
    started: removedPriceStarted,
    release: removedPriceRelease,
    completed: removedPriceCompleted
  };
  await selectInlineProduct(page, "sales-out");
  await removedPriceStarted.promise;
  await page.getByTestId("sales-out-line-insert").click();
  await page.getByTestId("sales-out-line-delete").click();
  removedPriceRelease.resolve();
  await removedPriceCompleted.promise;
  await settleUi(page);
  assert(await page.getByTestId("sales-out-entry-row").count() === 1, "sales-out delayed price target removal must leave one row");
  assert(await page.getByTestId("sales-out-line-product").inputValue() === "", "sales-out price response must not cross into replacement row");
  assert(Number(await page.getByTestId("sales-out-line-price").inputValue()) === 0, "replacement sales-out row must keep its own default price");
  salesPriceGate = null;

  await clickNewDocument(page);
  const salesOutSelectorStarted = deferred();
  const salesOutSelectorRelease = deferred();
  const salesOutSelectorCompleted = deferred();
  productListGate = {
    keyword: "A186-SALES-OUT-DELAYED",
    started: salesOutSelectorStarted,
    release: salesOutSelectorRelease,
    completed: salesOutSelectorCompleted
  };
  await page.getByTestId("sales-out-line-product").fill("A186-SALES-OUT-DELAYED");
  await salesOutSelectorStarted.promise;
  await page.getByTestId("sales-out-line-insert").click();
  await page.getByTestId("sales-out-line-delete").click();
  salesOutSelectorRelease.resolve();
  await salesOutSelectorCompleted.promise;
  await settleUi(page);
  assert(await page.getByTestId("sales-out-line-product").inputValue() === "", "stale sales-out selector must not refill a replacement row");
  productListGate = null;

  const salesOutPasteStarted = deferred();
  const salesOutPasteRelease = deferred();
  const salesOutPasteCompleted = deferred();
  productListGate = {
    keyword: "",
    started: salesOutPasteStarted,
    release: salesOutPasteRelease,
    completed: salesOutPasteCompleted
  };
  assert(await structuredPaste(page, "sales-out-line-product", structuredText), "sales-out delayed structured paste must be handled");
  await salesOutPasteStarted.promise;
  await page.getByTestId("sales-out-line-price").fill("88");
  salesOutPasteRelease.resolve();
  await salesOutPasteCompleted.promise;
  await settleUi(page);
  assert(await page.getByTestId("sales-out-line-product").inputValue() === "", "older sales-out paste must not overwrite a later line edit");
  assert(Number(await page.getByTestId("sales-out-line-price").inputValue()) === 88, "later sales-out line edit must win over an in-flight paste");
  assert(await page.getByTestId("sales-out-entry-row").count() === 1, "sales-out edited paste target must remain one stable row");
  productListGate = null;

  await page.getByTestId("module-委外管理").hover();
  await page.getByTestId("entry-outsourcing-issue-list").click();
  await page.getByTestId("list-page-outsourcing-issue-list").waitFor({ state: "visible", timeout: 10000 });
  await page.getByTestId("list-create").click();
  await page.getByTestId("outsourcing-issue-form").waitFor({ state: "visible", timeout: 10000 });
  await page.getByTestId("outsourcing-issue-source-select").click();
  await page.getByTestId("outsourcing-issue-source-selector-dialog").waitFor({ state: "visible", timeout: 10000 });
  await page.getByTestId(`outsourcing-issue-source-line-${outsourcingSource.billNo}-1-${product.code}`).check();
  const outsourcingStarted = deferred();
  const outsourcingRelease = deferred();
  const outsourcingCompleted = deferred();
  outsourcingDetailGate = { started: outsourcingStarted, release: outsourcingRelease, completed: outsourcingCompleted };
  await page.getByTestId("outsourcing-issue-source-selector-ok").click();
  await outsourcingStarted.promise;
  await page.getByTestId("outsourcing-issue-source-selector-cancel").click();
  outsourcingRelease.resolve();
  await outsourcingCompleted.promise;
  await settleUi(page);
  assert(await page.getByTestId("outsourcing-issue-source-bill-no").inputValue() === "", "cancelled outsourcing source detail must not refill the document");
  assert(await page.getByTestId("outsourcing-issue-line-product").inputValue() === "", "cancelled outsourcing source lines must not refill the document");
  outsourcingDetailGate = null;

  await page.getByTestId("module-生产管理").hover();
  await page.getByTestId("entry-production-plan-list").click();
  await page.getByTestId("list-page-production-plan-list").waitFor({ state: "visible", timeout: 10000 });
  await page.getByTestId("list-create").click();
  await page.getByTestId("production-plan-form").waitFor({ state: "visible", timeout: 10000 });

  bomMode = "error";
  await selectProductionPlanProduct(page);
  await page.getByText(/当前 BOM 加载失败/).waitFor({ state: "visible", timeout: 10000 });
  assert(await page.getByText(/没有已审核、启用的当前 BOM/).count() === 0, "BOM transport failure must not be presented as an empty result");

  await clickNewDocument(page);
  bomMode = "empty";
  await selectProductionPlanProduct(page);
  await page.getByText(/没有已审核、启用的当前 BOM/).waitFor({ state: "visible", timeout: 10000 });

  await clickNewDocument(page);
  bomMode = "success";
  await selectProductionPlanProduct(page);
  await page.waitForFunction((expectedBom) => {
    const row = document.querySelector('[data-testid="production-plan-entry-row"]');
    return Boolean(row?.textContent?.includes(expectedBom));
  }, bom.code);
  assert(await page.getByTestId("production-plan-product-code-1").inputValue() === product.code, "current BOM success must keep selected product");
  assert(await page.getByTestId("production-plan-warehouse-code-1").inputValue() === "CK-001", "current BOM success must backfill product warehouse");
  await page.getByTestId("save-sales-order").click();
  await page.waitForFunction((expectedBillNo) => document.querySelector('[data-testid="production-plan-bill-no"]')?.value === expectedBillNo,
    `SCJHA186${runShort.toUpperCase()}`);
  assert(await page.getByTestId("audit-sales-order").isEnabled(), "saved clean production plan draft must initially allow audit");

  bomMode = "emptyFull";
  await page.getByTestId("production-plan-select-product-1").click();
  await page.getByTestId("master-selector-source-selector-dialog").waitFor({ state: "visible", timeout: 10000 });
  await page.getByTestId(`master-selector-source-line-${raceProductB.code}`).click();
  await page.getByText(new RegExp(`物料 ${raceProductB.code} 没有已审核、启用的当前 BOM`)).waitFor({ state: "visible", timeout: 10000 });
  assert(await page.getByTestId("production-plan-product-code-1").inputValue() === raceProductB.code, "full selector empty BOM must leave the attempted B code, not stale A code");
  assert(await page.getByTestId("production-plan-warehouse-code-1").inputValue() === "", "full selector empty BOM must clear stale A warehouse");
  const emptyFullRow = (await page.getByTestId("production-plan-entry-row").innerText()).replaceAll(/\s+/g, " ").trim();
  assert(!emptyFullRow.includes(product.name) && !emptyFullRow.includes(bom.code), "full selector empty BOM must clear stale A material and BOM fields", emptyFullRow);
  assert(await page.getByTestId("audit-sales-order").isDisabled(), "saved draft changed to an invalid no-BOM product must disable audit");
  assert(await page.getByText("有未保存改动").isVisible(), "saved draft changed to an invalid no-BOM product must remain visibly dirty");
  await page.getByTestId("master-selector-source-selector-cancel").click();
  await page.getByTestId("master-selector-source-selector-dialog").waitFor({ state: "hidden", timeout: 10000 });

  await clickNewDocument(page);
  bomMode = "race";
  const bomRaceStarted = deferred();
  const bomRaceRelease = deferred();
  const bomRaceCompleted = deferred();
  bomRaceGate = { started: bomRaceStarted, release: bomRaceRelease, completed: bomRaceCompleted };
  await selectProductionPlanProduct(page, raceProductA);
  await bomRaceStarted.promise;
  await selectProductionPlanProduct(page, raceProductB);
  await page.waitForFunction(({ productCode, bomCode }) => {
    const input = document.querySelector('[data-testid="production-plan-product-code-1"]');
    const row = document.querySelector('[data-testid="production-plan-entry-row"]');
    return input?.value === productCode && Boolean(row?.textContent?.includes(bomCode));
  }, { productCode: raceProductB.code, bomCode: raceBomB.code });
  bomRaceRelease.resolve();
  await bomRaceCompleted.promise;
  await settleUi(page);
  assert(await page.getByTestId("production-plan-product-code-1").inputValue() === raceProductB.code, "late A BOM response must not overwrite newer B product");
  const raceRow = (await page.getByTestId("production-plan-entry-row").innerText()).replaceAll(/\s+/g, " ").trim();
  assert(raceRow.includes(raceProductB.name) && raceRow.includes(raceBomB.code), "late A response must preserve B material and BOM", raceRow);
  assert(!raceRow.includes(raceProductA.name) && !raceRow.includes(raceBomA.code), "late A response must remain discarded", raceRow);
  bomRaceGate = null;

  await clickNewDocument(page);
  await page.getByTestId("production-plan-add-line").click();
  bomMode = "race";
  const parallelStarted = deferred();
  const parallelRelease = deferred();
  const parallelCompleted = deferred();
  bomRaceGate = { started: parallelStarted, release: parallelRelease, completed: parallelCompleted };
  await selectProductionPlanProduct(page, raceProductA, 1);
  await parallelStarted.promise;
  await selectProductionPlanProduct(page, raceProductB, 2);
  await page.waitForFunction(({ productCode, bomCode }) => {
    const input = document.querySelector('[data-testid="production-plan-product-code-2"]');
    const rows = Array.from(document.querySelectorAll('[data-testid="production-plan-entry-row"]'));
    return input?.value === productCode && Boolean(rows[1]?.textContent?.includes(bomCode));
  }, { productCode: raceProductB.code, bomCode: raceBomB.code });
  parallelRelease.resolve();
  await parallelCompleted.promise;
  await settleUi(page);
  const parallelRows = await page.getByTestId("production-plan-entry-row").allInnerTexts();
  assert(await page.getByTestId("production-plan-product-code-1").inputValue() === raceProductA.code && parallelRows[0]?.includes(raceBomA.code), "row A request must survive an independent row B selection", parallelRows);
  assert(await page.getByTestId("production-plan-product-code-2").inputValue() === raceProductB.code && parallelRows[1]?.includes(raceBomB.code), "row B request must remain independently applied", parallelRows);
  bomRaceGate = null;

  const screenshot = `a186-selector-bom-${runShort}.png`;
  await page.screenshot({ path: path.join(screenshotDir, screenshot), fullPage: true });
  evidence.screenshots.push(`verification/playwright/${screenshot}`);
  evidence.checks = {
    quoteWarehouse,
    quotePrice: { before: quoteBeforePrice, afterTyped: quoteAfterTypedPrice, afterPaste: quoteAfterPrice, paste: pricePaste },
    orderWarehouse,
    structuredPaste: { prevented: structuredPrevented, rows: 2 },
    deliveryWarehouse,
    purchaseWarehouse,
    transferWarehouse,
    transferTargetWarehouse: { before: transferBeforeTarget, after: transferAfterTarget, paste: targetPaste },
    delayedGenericTargets: {
      selectorInsertDelete: true,
      pasteNewDocument: true,
      pasteLastEditWins: true,
      autoPriceManualAndReplacement: true,
      bulkPriceStableTargets: true,
      newerPasteWinsOverOlderBulk: true,
      newerBulkCancelsOlderPaste: true,
      savedCleanBulkMarksDirty: true
    },
    salesOutAsyncPrice: {
      manualPrice: salesOutManualPrice.price,
      removedTarget: true,
      selectorAndPasteTargets: true,
      pasteLastEditWins: true
    },
    outsourcingCancelInvalidation: true,
    bomStates: {
      error: true,
      empty: true,
      success: true,
      savedDraftDirtyAfterFullSelectorEmpty: true,
      fullSelectorEmpty: true,
      inverseResponse: true,
      parallelRows: true,
      code: bom.code
    }
  };
  assert(JSON.stringify(evidence.requests.mockedBusinessWrites) === JSON.stringify([
    "POST /api/sales-orders/draft",
    "POST /api/production/plans"
  ]), "regression may only mock the two saves used to establish clean drafts", evidence.requests.mockedBusinessWrites);
  assert(evidence.requests.blockedUnexpectedWrites.length === 0, "regression must not attempt real business writes", evidence.requests.blockedUnexpectedWrites);
  evidence.ok = true;
} catch (error) {
  primaryError = error;
  evidence.error = errorText(error);
} finally {
  try {
    await browser?.close();
  } catch (error) {
    closeError = error;
  }
  evidence.completedAt = new Date().toISOString();
  await writeFile(resultPath, JSON.stringify(evidence, null, 2));
}

console.log(JSON.stringify(evidence, null, 2));
if (primaryError || closeError) {
  throw new AggregateError([primaryError, closeError].filter(Boolean), "A186 selector/BOM regression failed");
}
