import { chromium } from "playwright";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { installApiSession, loginAsAdmin } from "./helpers/regression-auth.mjs";

const rootDir = path.resolve(import.meta.dirname, "..");
const screenshotDir = path.join(rootDir, "verification/playwright");
const resultPath = path.join(rootDir, "verification/a17-entry-excel-paste-regression.json");
const frontendUrl = "http://127.0.0.1:5173/";
const apiBase = "http://127.0.0.1:8080";
await installApiSession(apiBase);
const batch = new Date().toISOString().replace(/\D/g, "").slice(0, 14);
const pasteText = [
  "CP-001\tCK-001\t2\t86",
  "CP-T413874\tCK-T413874\t3\t94",
  "PJ-014\tCK-002\t4\t12"
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
      warehouseCode: await page.getByTestId(`sales-line-warehouse${suffix}`).inputValue(),
      qty: Number(await page.getByTestId(`sales-line-qty${suffix}`).inputValue()),
      unitPrice: Number(await page.getByTestId(`sales-line-price${suffix}`).inputValue()),
      amount: (await page.getByTestId(`sales-line-amount${suffix}`).innerText()).trim()
    });
  }
  return lines;
}

function assertLines(name, actual, expected) {
  const simplified = actual.map((line) => ({
    productCode: line.productCode,
    warehouseCode: line.warehouseCode,
    qty: line.qty,
    unitPrice: line.unitPrice
  }));
  if (JSON.stringify(simplified) !== JSON.stringify(expected)) {
    throw new Error(`${name} expected ${JSON.stringify(expected)}, got ${JSON.stringify(simplified)}`);
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
  assertLines("pasted UI lines", linesAfterPaste, expectedLines);
  const totalAfterPaste = (await page.getByTestId("document-total-amount").innerText()).trim();
  if (totalAfterPaste !== "502.00") {
    throw new Error(`total expected 502.00, got ${totalAfterPaste}`);
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
  if (JSON.stringify(savedLines) !== JSON.stringify(expectedLines)) {
    throw new Error(`saved lines mismatch ${JSON.stringify(savedLines)}`);
  }

  const screenshot = `a17-entry-excel-paste-${batch}.png`;
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
