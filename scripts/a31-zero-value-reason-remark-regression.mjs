import { chromium } from "playwright";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { installApiSession, loginAsAdmin } from "./helpers/regression-auth.mjs";

const rootDir = path.resolve(import.meta.dirname, "..");
const screenshotDir = path.join(rootDir, "verification/playwright");
const resultPath = path.join(rootDir, "verification/a31-zero-value-reason-remark-regression.json");
const frontendUrl = "http://127.0.0.1:5173/";
const apiBase = "http://127.0.0.1:8080";
await installApiSession(apiBase);
const batch = new Date().toISOString().replace(/\D/g, "").slice(0, 14);

await mkdir(screenshotDir, { recursive: true });
await mkdir(path.dirname(resultPath), { recursive: true });

async function requireApi(pathname) {
  const response = await fetch(`${apiBase}${pathname}`);
  const text = await response.text();
  const data = text ? JSON.parse(text) : {};
  if (!response.ok) {
    throw new Error(`GET ${pathname} failed ${response.status}: ${JSON.stringify(data)}`);
  }
  return data;
}

function assertEqual(name, actual, expected) {
  if (actual !== expected) {
    throw new Error(`${name} expected ${expected}, got ${actual}`);
  }
}

function assertDeepEqual(name, actual, expected) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${name} expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

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

  await page.getByTestId("sales-line-product").fill("CP-001");
  await page.getByTestId("sales-line-warehouse").fill("CK-001");
  await page.getByTestId("sales-line-qty").fill("1");
  await page.getByTestId("sales-line-price").fill("0");

  await page.getByRole("button", { name: "+ 增加明细行" }).click();
  await page.getByTestId("sales-line-product-2").fill("PJ-014");
  await page.getByTestId("sales-line-warehouse-2").fill("CK-002");
  await page.getByTestId("sales-line-qty-2").fill("0");
  await page.getByTestId("sales-line-price-2").fill("5");

  await page.getByRole("button", { name: "+ 增加明细行" }).click();
  await page.getByTestId("sales-line-product-3").fill("CP-T413874");
  await page.getByTestId("sales-line-warehouse-3").fill("CK-001");
  await page.getByTestId("sales-line-qty-3").fill("2");
  await page.getByTestId("sales-line-price-3").fill("30");

  await page.getByTestId("save-sales-order").click();
  await page.getByTestId("entry-zero-confirm-dialog").waitFor({ state: "visible" });
  await page.getByTestId("entry-zero-reason").selectOption("样品");
  await page.getByTestId("entry-zero-reason-2").selectOption("补录");
  const reasonScreenshot = `a31-zero-value-reason-dialog-${batch}.png`;
  await page.screenshot({ path: path.join(screenshotDir, reasonScreenshot), fullPage: true });

  await page.getByTestId("entry-zero-confirm").click();
  const saveMessage = "草稿已保存，已确认 2 行零值分录";
  await page.getByText(saveMessage).waitFor({ state: "visible" });
  const firstRemark = await page.getByTestId("sales-line-remark").inputValue();
  const secondRemark = await page.getByTestId("sales-line-remark-2").inputValue();
  assertEqual("first remark", firstRemark, "零值原因：样品（单价为 0）");
  assertEqual("second remark", secondRemark, "零值原因：补录（数量为 0）");

  const detail = await requireApi(`/api/sales-orders/${encodeURIComponent(billNo)}`);
  const savedRemarks = detail.lines.map((line) => String(line.lineRemark ?? ""));
  assertDeepEqual("saved remarks", savedRemarks, [
    "零值原因：样品（单价为 0）",
    "零值原因：补录（数量为 0）",
    ""
  ]);
  const savedLines = detail.lines.map((line) => ({
    productCode: String(line.productCode ?? ""),
    warehouseCode: String(line.warehouseCode ?? ""),
    qty: Number(line.qty ?? 0),
    unitPrice: Number(line.unitPrice ?? 0),
    lineRemark: String(line.lineRemark ?? "")
  }));

  const savedScreenshot = `a31-zero-value-reason-saved-${batch}.png`;
  await page.screenshot({ path: path.join(screenshotDir, savedScreenshot), fullPage: true });

  const result = {
    batch,
    generatedAt: new Date().toISOString(),
    billNo,
    saveMessage,
    firstRemark,
    secondRemark,
    savedLines,
    screenshots: [
      `verification/playwright/${reasonScreenshot}`,
      `verification/playwright/${savedScreenshot}`
    ]
  };
  await writeFile(resultPath, JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
} finally {
  await browser.close();
}
