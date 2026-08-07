import { chromium } from "playwright";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { installApiSession, loginAsAdmin } from "./helpers/regression-auth.mjs";
import { upsertMasterDataFixture } from "./helpers/master-data-actions.mjs";

const rootDir = path.resolve(import.meta.dirname, "..");
const verificationDir = path.join(rootDir, "verification");
const screenshotDir = path.join(verificationDir, "playwright");
const resultPath = path.join(verificationDir, "a168-production-plan-entry-ux-regression.json");
const frontendUrl = process.env.JDY_WEB_BASE || "http://127.0.0.1:5173/";
const apiBase = process.env.JDY_API_BASE || "http://127.0.0.1:8080";
const batch = new Date().toISOString().replace(/\D/g, "").slice(0, 14);

await installApiSession(apiBase);
await mkdir(screenshotDir, { recursive: true });

function assert(condition, message, details) {
  if (!condition) {
    const suffix = details === undefined ? "" : `: ${JSON.stringify(details)}`;
    throw new Error(`${message}${suffix}`);
  }
}

async function requireJson(pathname, options = {}) {
  const response = await fetch(`${apiBase}${pathname}`, {
    method: options.method || "GET",
    headers: options.body === undefined ? undefined : { "Content-Type": "application/json" },
    body: options.body === undefined ? undefined : JSON.stringify(options.body)
  });
  const text = await response.text();
  let data = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { text };
  }
  if (!response.ok) {
    throw new Error(`${options.method || "GET"} ${pathname} failed ${response.status}: ${text}`);
  }
  return data;
}

async function createParentProduct(code, name, warehouseCode, workshopCode) {
  return upsertMasterDataFixture({
    apiBase,
    type: "product",
    audit: true,
    payload: {
      code,
      name,
      spec: "A168 / 分录联想",
      category: "成品总成",
      unit: "只",
      defaultWarehouseCode: warehouseCode,
      defaultWorkshop: workshopCode,
      isPurchase: false,
      isSale: true,
      isInventory: true,
      isProduce: true,
      status: "启用"
    }
  });
}

function rowAt(page, lineNo) {
  return page.locator(`[data-testid="production-plan-entry-row"][data-line-no="${lineNo}"]`);
}

async function chooseInline(page, lineNo, product, selectionKey) {
  const input = page.getByTestId(`production-plan-product-code-${lineNo}`);
  await input.focus();
  await input.fill(product.code);
  const option = page.getByTestId(`production-plan-product-option-${lineNo}-1`);
  await option.waitFor({ state: "visible", timeout: 10000 });
  await page.keyboard.press("ArrowDown");
  assert(await option.evaluate((node) => node.classList.contains("selected")), `line ${lineNo} cursor should select a candidate`);
  await page.keyboard.press(selectionKey);
  await page.waitForFunction(
    ({ warehouseTestId, expectedActiveTestId, productCodeTestId, expectedCode }) => {
      const productInput = document.querySelector(`[data-testid="${productCodeTestId}"]`);
      const warehouseInput = document.querySelector(`[data-testid="${warehouseTestId}"]`);
      return productInput?.value === expectedCode
        && Boolean(warehouseInput?.value)
        && document.activeElement?.getAttribute("data-testid") === expectedActiveTestId;
    },
    {
      warehouseTestId: `production-plan-warehouse-code-${lineNo}`,
      expectedActiveTestId: `production-plan-warehouse-code-${lineNo}`,
      productCodeTestId: `production-plan-product-code-${lineNo}`,
      expectedCode: product.code
    }
  );
  assert(
    await page.evaluate(() => document.activeElement?.getAttribute("data-testid")) === `production-plan-warehouse-code-${lineNo}`,
    `line ${lineNo} selection should focus its warehouse field`
  );
}

const productA = await createParentProduct(
  `A168-FG-A-${batch}`,
  `A168联想母件A-${batch}`,
  "CK-002",
  "CY"
);
const productB = await createParentProduct(
  `A168-FG-B-${batch}`,
  `A168联想母件B-${batch}`,
  "CK-003",
  "HJ"
);
const material = await upsertMasterDataFixture({
  apiBase,
  type: "product",
  audit: true,
  payload: {
    code: `A168-RM-${batch}`,
    name: `A168联想回归原料-${batch}`,
    spec: "A168 / 单耗1",
    category: "零配件",
    unit: "件",
    defaultWarehouseCode: "CK-001",
    isPurchase: false,
    isSale: false,
    isInventory: true,
    isProduce: false,
    status: "启用"
  }
});
const bomCodes = [`BOM-A168-A-${batch}`, `BOM-A168-B-${batch}`];
for (const [index, product] of [productA, productB].entries()) {
  await requireJson("/api/production/boms", {
    method: "POST",
    body: {
      code: bomCodes[index],
      productCode: product.code,
      qty: 1,
      lines: [{ materialCode: material.code, qty: 1, issueWarehouseCode: "CK-001" }]
    }
  });
  await requireJson(`/api/production/boms/${encodeURIComponent(bomCodes[index])}/audit`, { method: "POST" });
}

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1803, height: 900 } });
const screenshots = [];

try {
  await page.goto(frontendUrl, { waitUntil: "networkidle" });
  await loginAsAdmin(page);
  await page.getByTestId("module-生产管理").hover();
  await page.getByTestId("entry-production-plan-list").click();
  await page.getByTestId("list-page-production-plan-list").waitFor({ state: "visible" });
  await page.getByTestId("list-create").click();
  await page.getByTestId("production-plan-form").waitFor({ state: "visible" });

  const firstRow = rowAt(page, 1);
  assert(await firstRow.count() === 1, "a new production plan should start with one entry row");
  const insertOne = page.getByTestId("production-plan-insert-line-1");
  const removeOne = page.getByTestId("production-plan-remove-line-1");
  assert(await insertOne.evaluate((node) => node.closest("td") === node.closest("tr")?.querySelector("td")), "insert action must be inside the row-number cell");
  assert(await removeOne.evaluate((node) => node.closest("td") === node.closest("tr")?.querySelector("td")), "remove action must be inside the row-number cell");
  assert(await removeOne.isDisabled(), "the only entry row must not be removable");

  const dimensions = await page.evaluate((testIds) => testIds.map((testId) => {
    const input = document.querySelector(`[data-testid="${testId}"]`);
    const cell = input?.closest("td");
    if (!(input instanceof HTMLInputElement) || !(cell instanceof HTMLTableCellElement)) {
      return { testId, missing: true };
    }
    const inputRect = input.getBoundingClientRect();
    const cellRect = cell.getBoundingClientRect();
    return {
      testId,
      inputWidth: inputRect.width,
      inputHeight: inputRect.height,
      cellWidth: cellRect.width,
      cellHeight: cellRect.height
    };
  }), [
    "production-plan-product-code-1",
    "production-plan-warehouse-code-1",
    "production-plan-department-code-1",
    "production-plan-qty-1",
    "production-plan-delivery-date-1"
  ]);
  for (const dimension of dimensions) {
    assert(!dimension.missing, "entry input should exist", dimension);
    assert(dimension.inputWidth >= dimension.cellWidth - 5, "entry input should fill its table cell width", dimension);
    assert(dimension.inputHeight >= 28, "entry input should use the shared 28px entry height", dimension);
  }

  const firstInput = page.getByTestId("production-plan-product-code-1");
  await firstInput.focus();
  await firstInput.fill(productA.code.slice(0, 12));
  await page.getByTestId("production-plan-product-suggestions-1").waitFor({ state: "visible" });
  const lookupScreenshot = `a168-production-plan-lookup-${batch}.png`;
  await page.screenshot({ path: path.join(screenshotDir, lookupScreenshot), fullPage: true });
  screenshots.push(`verification/playwright/${lookupScreenshot}`);
  await page.keyboard.press("Escape");
  assert(await page.getByTestId("production-plan-product-suggestions-1").count() === 0, "Escape should close inline product suggestions");

  await firstInput.fill("");
  await chooseInline(page, 1, productA, "Enter");
  assert(await page.getByTestId("production-plan-product-code-1").inputValue() === productA.code, "Enter should select product A");
  assert((await firstRow.locator("td").nth(2).innerText()).includes(productA.name), "product A name should be backfilled");
  assert((await firstRow.locator("td").nth(3).innerText()).includes("A168 / 分录联想"), "product A spec should be backfilled");
  assert((await firstRow.locator("td").nth(6).innerText()).includes("只"), "product A unit should be backfilled");
  assert((await firstRow.locator("td").nth(4).innerText()).includes(bomCodes[0]), "product A current BOM should be backfilled");
  assert(await page.getByTestId("production-plan-warehouse-code-1").inputValue() === "CK-002", "product A default warehouse should be backfilled");
  assert(await page.getByTestId("production-plan-department-code-1").inputValue() === "CY", "product A default workshop should be backfilled");

  await firstRow.hover();
  await page.getByTestId("production-plan-select-product-1").click();
  await page.getByTestId("master-selector-source-selector-dialog").waitFor({ state: "visible" });
  await page.getByTestId("master-selector-source-selector-cancel").click();
  await page.getByTestId("master-selector-source-selector-dialog").waitFor({ state: "hidden" });

  await firstRow.hover();
  await insertOne.click();
  assert(await rowAt(page, 2).count() === 1, "row-number plus action should insert the second model row");
  await chooseInline(page, 2, productB, "Tab");
  assert(await page.getByTestId("production-plan-product-code-2").inputValue() === productB.code, "Tab should select product B");
  assert((await rowAt(page, 2).locator("td").nth(4).innerText()).includes(bomCodes[1]), "product B current BOM should be backfilled");
  assert(await page.getByTestId("production-plan-warehouse-code-2").inputValue() === "CK-003", "product B default warehouse should be backfilled");
  assert(await page.getByTestId("production-plan-department-code-2").inputValue() === "HJ", "product B default workshop should be backfilled");

  const secondRow = rowAt(page, 2);
  await secondRow.hover();
  await page.getByTestId("production-plan-insert-line-2").click();
  assert(await rowAt(page, 3).count() === 1, "row-number plus action should insert below the current row");
  await rowAt(page, 3).hover();
  await page.getByTestId("production-plan-remove-line-3").click();
  assert(await rowAt(page, 3).count() === 0 && await rowAt(page, 2).count() === 1, "row-number minus action should remove only the targeted row");

  const finalScreenshot = `a168-production-plan-two-models-${batch}.png`;
  await page.screenshot({ path: path.join(screenshotDir, finalScreenshot), fullPage: true });
  screenshots.push(`verification/playwright/${finalScreenshot}`);

  const saveButton = page.getByTestId("save-sales-order");
  assert(await saveButton.isEnabled(), "two selected models should enable production-plan save");
  await saveButton.click();
  await page.waitForFunction(() => {
    const input = document.querySelector('[data-testid="production-plan-bill-no"]');
    return input instanceof HTMLInputElement && Boolean(input.value);
  });
  const billNo = await page.getByTestId("production-plan-bill-no").inputValue();
  const detail = await requireJson(`/api/production/plans/${encodeURIComponent(billNo)}`);
  const savedLines = detail.lines.map((line) => ({
    productId: String(line.productId ?? ""),
    productCode: String(line.productCode ?? ""),
    warehouseCode: String(line.warehouseCode ?? ""),
    departmentCode: String(line.departmentCode ?? ""),
    qty: Number(line.qty ?? 0)
  }));
  assert(savedLines.length === 2, "saved production plan should keep both model rows", savedLines);
  assert(savedLines[0].productId === String(productA.id) && savedLines[0].productCode === productA.code, "saved line 1 should keep product A stable id", savedLines[0]);
  assert(savedLines[1].productId === String(productB.id) && savedLines[1].productCode === productB.code, "saved line 2 should keep product B stable id", savedLines[1]);

  const result = {
    batch,
    generatedAt: new Date().toISOString(),
    frontendUrl,
    apiBase,
    billNo,
    products: [productA.code, productB.code],
    bomCodes,
    checks: {
      rowActionsInsideRowNumber: true,
      singleRowRemoveDisabled: true,
      fullCellInputs: dimensions,
      escapeClosedLookup: true,
      enterSelectedFirstModel: true,
      tabSelectedSecondModel: true,
      fullSelectorFallbackOpened: true,
      insertedAndRemovedTargetRow: true,
      savedStableProductIds: savedLines
    },
    screenshots
  };
  await writeFile(resultPath, JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
} finally {
  await browser.close();
}
