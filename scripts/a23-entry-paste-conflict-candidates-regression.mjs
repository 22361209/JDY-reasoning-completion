import { chromium } from "playwright";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { installApiSession, loginAsAdmin } from "./helpers/regression-auth.mjs";
import { clickNewDocument, saveDocument } from "./helpers/document-actions.mjs";

const rootDir = path.resolve(import.meta.dirname, "..");
const screenshotDir = path.join(rootDir, "verification/playwright");
const resultPath = path.join(rootDir, "verification/a23-entry-paste-conflict-candidates-regression.json");
const frontendUrl = "http://127.0.0.1:5173/";
const apiBase = "http://127.0.0.1:8080";
await installApiSession(apiBase);
const batch = new Date().toISOString().replace(/\D/g, "").slice(0, 14);

const conflictName = `A23候选商品${batch}`;
const productA = {
  code: `A23-A-${batch}`,
  name: conflictName,
  spec: "粗牙 / 左",
  category: "成品总成",
  unit: "只",
  status: "启用"
};
const productB = {
  code: `A23-B-${batch}`,
  name: conflictName,
  spec: "细牙 / 右",
  category: "成品总成",
  unit: "只",
  status: "启用"
};
const pasteText = [
  "物料名称\t规格型号\t仓库\t数量\t单价",
  `${conflictName}\t\t成品仓\t2\t31`,
  `${conflictName}\t细牙 / 右\tCK-001\t3\t37`
].join("\n");

await mkdir(screenshotDir, { recursive: true });
await mkdir(path.dirname(resultPath), { recursive: true });

async function api(pathname, options = {}) {
  const response = await fetch(`${apiBase}${pathname}`, {
    method: options.method ?? "GET",
    headers: options.body ? { "Content-Type": "application/json" } : undefined,
    body: options.body ? JSON.stringify(options.body) : undefined
  });
  const text = await response.text();
  const data = text ? JSON.parse(text) : {};
  return { ok: response.ok, status: response.status, data };
}

async function requireApi(pathname, options = {}) {
  const result = await api(pathname, options);
  if (!result.ok) {
    throw new Error(`${options.method ?? "GET"} ${pathname} failed ${result.status}: ${JSON.stringify(result.data)}`);
  }
  return result.data;
}

async function upsertProduct(product) {
  const created = await api("/api/master-data/product", { method: "POST", body: product });
  if (created.ok) {
    await requireApi(`/api/master-data/product/${encodeURIComponent(product.code)}/audit`, { method: "POST" });
    return created.data;
  }
  if (created.status === 409) {
    const updated = await requireApi(`/api/master-data/product/${encodeURIComponent(product.code)}`, { method: "PUT", body: product });
    await requireApi(`/api/master-data/product/${encodeURIComponent(product.code)}/audit`, { method: "POST" });
    return updated;
  }
  throw new Error(`create product ${product.code} failed ${created.status}: ${JSON.stringify(created.data)}`);
}

async function dispatchPaste(page, testId, text) {
  await page.getByTestId(testId).focus();
  await page.evaluate(
    ({ id, value }) => {
      const input = document.querySelector(`[data-testid="${id}"]`);
      if (!input) {
        throw new Error(`input not found: ${id}`);
      }
      const dataTransfer = new DataTransfer();
      dataTransfer.setData("text/plain", value);
      input.dispatchEvent(new ClipboardEvent("paste", {
        bubbles: true,
        cancelable: true,
        clipboardData: dataTransfer
      }));
    },
    { id: testId, value: text }
  );
}

async function readLines(page) {
  const rows = await page.getByTestId("sales-entry-row").count();
  const productNameIndex = await entryColumnIndex(page, "物料名称");
  const specIndex = await entryColumnIndex(page, "规格型号");
  const lines = [];
  for (let index = 0; index < rows; index += 1) {
    const suffix = index === 0 ? "" : `-${index + 1}`;
    const row = page.getByTestId("sales-entry-row").nth(index);
    lines.push({
      productCode: await page.getByTestId(`sales-line-product${suffix}`).inputValue(),
      productName: (await row.locator("td").nth(productNameIndex).innerText()).trim(),
      spec: (await row.locator("td").nth(specIndex).innerText()).trim(),
      warehouseCode: await page.getByTestId(`sales-line-warehouse${suffix}`).inputValue(),
      qty: Number(await page.getByTestId(`sales-line-qty${suffix}`).inputValue()),
      unitPrice: Number(await page.getByTestId(`sales-line-price${suffix}`).inputValue()),
      amount: (await page.getByTestId(`sales-line-amount${suffix}`).innerText()).trim()
    });
  }
  return lines;
}

async function entryColumnIndex(page, title) {
  const headers = await page.locator(".entry-table thead th:visible").evaluateAll((nodes) => nodes.map((node) => node.textContent?.trim() ?? ""));
  const index = headers.findIndex((text) => text.includes(title));
  if (index < 0) {
    throw new Error(`entry column not found: ${title}; headers=${JSON.stringify(headers)}`);
  }
  return index;
}

function assertDeepEqual(name, actual, expected) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${name} expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

await upsertProduct(productA);
await upsertProduct(productB);

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1366, height: 768 } });

try {
  await page.goto(frontendUrl, { waitUntil: "networkidle" });
  await loginAsAdmin(page);
  await page.getByTestId("module-销售管理").hover();
  await page.getByTestId("entry-sales-order-form").click();
  await page.getByTestId("sales-line-product").waitFor({ state: "visible" });
  await clickNewDocument(page);
  const billNoInput = page.getByTestId("sales-bill-no");
  assertDeepEqual("new sales order bill no", await billNoInput.inputValue(), "");
  assertDeepEqual("new sales order bill no editable", await billNoInput.isEditable(), false);
  await page.getByTestId("sales-party-code").fill("KH-001");

  await dispatchPaste(page, "sales-line-product", pasteText);
  await page.getByTestId("entry-paste-conflict-dialog").waitFor({ state: "visible" });
  const dialogText = await page.getByTestId("entry-paste-conflict-dialog").innerText();
  if (!dialogText.includes("第 1 行") || !dialogText.includes(conflictName)) {
    throw new Error(`conflict dialog text mismatch: ${dialogText}`);
  }
  await page.getByText(productA.code).waitFor({ state: "visible" });
  await page.getByText(productB.code).waitFor({ state: "visible" });
  const dialogScreenshot = `a23-entry-paste-conflict-dialog-${batch}.png`;
  await page.screenshot({ path: path.join(screenshotDir, dialogScreenshot), fullPage: true });

  const confirmButton = page.getByTestId("entry-paste-confirm");
  if (await confirmButton.isEnabled()) {
    throw new Error("confirm should stay disabled before choosing a candidate");
  }
  await page.getByTestId(`entry-paste-candidate-1-${productA.code}`).click();
  if (!(await confirmButton.isEnabled())) {
    throw new Error("confirm should be enabled after choosing a candidate");
  }
  await confirmButton.click();
  await page.getByText("已粘贴 2 行分录").waitFor({ state: "visible" });

  const linesAfterPaste = await readLines(page);
  const expectedLines = [
    { productCode: productA.code, productName: conflictName, spec: productA.spec, warehouseCode: "CK-001", qty: 2, unitPrice: 31, amount: "62.00" },
    { productCode: productB.code, productName: conflictName, spec: productB.spec, warehouseCode: "CK-001", qty: 3, unitPrice: 37, amount: "111.00" }
  ];
  assertDeepEqual("pasted UI lines", linesAfterPaste.slice(0, 2), expectedLines);
  const totalAfterPaste = (await page.getByTestId("document-total-amount").innerText()).trim();
  if (totalAfterPaste !== "195.49") {
    throw new Error(`total expected 195.49, got ${totalAfterPaste}`);
  }

  await saveDocument(page);
  await page.waitForFunction(() => {
    const input = document.querySelector('[data-testid="sales-bill-no"]');
    return input instanceof HTMLInputElement && /^XSDD\d{6}$/.test(input.value);
  });
  const billNo = await billNoInput.inputValue();
  if (!/^XSDD\d{6}$/.test(billNo)) {
    throw new Error(`saved sales order bill no should match XSDD######, got ${JSON.stringify(billNo)}`);
  }
  const detail = await requireApi(`/api/sales-orders/${encodeURIComponent(billNo)}`);
  const savedLines = detail.lines.map((line) => ({
    productCode: String(line.productCode ?? ""),
    warehouseCode: String(line.warehouseCode ?? ""),
    qty: Number(line.qty ?? 0),
    unitPrice: Number(line.unitPrice ?? 0)
  }));
  assertDeepEqual("saved lines", savedLines, [
    { productCode: productA.code, warehouseCode: "CK-001", qty: 2, unitPrice: 31 },
    { productCode: productB.code, warehouseCode: "CK-001", qty: 3, unitPrice: 37 }
  ]);

  const formScreenshot = `a23-entry-paste-conflict-form-${batch}.png`;
  await page.screenshot({ path: path.join(screenshotDir, formScreenshot), fullPage: true });

  const result = {
    batch,
    generatedAt: new Date().toISOString(),
    billNo,
    products: [productA, productB],
    linesAfterPaste,
    totalAfterPaste,
    savedLines,
    screenshots: [
      `verification/playwright/${dialogScreenshot}`,
      `verification/playwright/${formScreenshot}`
    ]
  };
  await writeFile(resultPath, JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
} finally {
  await browser.close();
}
