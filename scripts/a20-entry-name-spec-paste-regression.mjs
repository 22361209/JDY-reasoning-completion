import { chromium } from "playwright";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { installApiSession, loginAsAdmin } from "./helpers/regression-auth.mjs";

const rootDir = path.resolve(import.meta.dirname, "..");
const screenshotDir = path.join(rootDir, "verification/playwright");
const resultPath = path.join(rootDir, "verification/a20-entry-name-spec-paste-regression.json");
const frontendUrl = "http://127.0.0.1:5173/";
const apiBase = "http://127.0.0.1:8080";
await installApiSession(apiBase);
const batch = new Date().toISOString().replace(/\D/g, "").slice(0, 14);
const pasteText = [
  "商品名称\t规格型号\t仓库\t数量\t单价",
  "控制臂总成\t左前 / 黑色\t成品仓\t2\t86",
  "验收商品总成\t左前 / 蓝色\tCK-T413874\t3\t94",
  "衬套\t65mm / 加强\t原材料仓\t4\t12"
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
  const lines = [];
  for (let index = 0; index < rows; index += 1) {
    const suffix = index === 0 ? "" : `-${index + 1}`;
    lines.push({
      productCode: await page.getByTestId(`sales-line-product${suffix}`).inputValue(),
      productName: (await page.getByTestId("sales-entry-row").nth(index).locator("td").nth(2).innerText()).trim(),
      spec: (await page.getByTestId("sales-entry-row").nth(index).locator("td").nth(3).innerText()).trim(),
      warehouseCode: await page.getByTestId(`sales-line-warehouse${suffix}`).inputValue(),
      qty: Number(await page.getByTestId(`sales-line-qty${suffix}`).inputValue()),
      unitPrice: Number(await page.getByTestId(`sales-line-price${suffix}`).inputValue()),
      amount: (await page.getByTestId(`sales-line-amount${suffix}`).innerText()).trim()
    });
  }
  return lines;
}

function simplify(lines) {
  return lines.map((line) => ({
    productCode: line.productCode,
    warehouseCode: line.warehouseCode,
    qty: line.qty,
    unitPrice: line.unitPrice
  }));
}

function assertDeepEqual(name, actual, expected) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${name} expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

const expectedLines = [
  { productCode: "CP-001", warehouseCode: "CK-001", qty: 2, unitPrice: 86 },
  { productCode: "CP-T413874", warehouseCode: "CK-T413874", qty: 3, unitPrice: 94 },
  { productCode: "PJ-014", warehouseCode: "CK-002", qty: 4, unitPrice: 12 }
];

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1366, height: 768 } });

try {
  await page.goto(frontendUrl, { waitUntil: "networkidle" });
  await loginAsAdmin(page);
  await page.getByTestId("module-销售管理").hover();
  await page.getByTestId("entry-sales-order-form").click();
  await page.getByTestId("sales-line-product").waitFor({ state: "visible" });
  await page.getByTestId("new-document").click();
  await page.waitForFunction(() => {
    const input = document.querySelector('[data-testid="sales-bill-no"]');
    return input instanceof HTMLInputElement && input.value.length > 0;
  });
  const billNo = await page.getByTestId("sales-bill-no").inputValue();
  await page.getByTestId("sales-party-code").fill("KH-001");

  await dispatchPaste(page, "sales-line-product", pasteText);
  await page.getByText("已粘贴 3 行分录").waitFor({ state: "visible" });
  const linesAfterPaste = await readLines(page);
  assertDeepEqual("pasted UI lines", simplify(linesAfterPaste), expectedLines);
  assertDeepEqual("pasted names", linesAfterPaste.map((line) => line.productName), ["控制臂总成", "验收商品总成", "衬套"]);
  assertDeepEqual("pasted specs", linesAfterPaste.map((line) => line.spec), ["左前 / 黑色", "左前 / 蓝色", "65mm / 加强"]);
  const totalAfterPaste = (await page.getByTestId("document-total-amount").innerText()).trim();
  if (totalAfterPaste !== "567.26") {
    throw new Error(`total expected 567.26, got ${totalAfterPaste}`);
  }

  await page.getByTestId("save-sales-order").click();
  await page.getByText("草稿已保存").waitFor({ state: "visible" });
  const detail = await requireApi(`/api/sales-orders/${encodeURIComponent(billNo)}`);
  const savedLines = detail.lines.map((line) => ({
    productCode: String(line.productCode ?? ""),
    warehouseCode: String(line.warehouseCode ?? ""),
    qty: Number(line.qty ?? 0),
    unitPrice: Number(line.unitPrice ?? 0)
  }));
  assertDeepEqual("saved lines", savedLines, expectedLines);

  const screenshot = `a20-entry-name-spec-paste-${batch}.png`;
  await page.screenshot({ path: path.join(screenshotDir, screenshot), fullPage: true });
  const result = {
    batch,
    generatedAt: new Date().toISOString(),
    billNo,
    linesAfterPaste,
    totalAfterPaste,
    savedLines,
    screenshot: `verification/playwright/${screenshot}`
  };
  await writeFile(resultPath, JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
} finally {
  await browser.close();
}
