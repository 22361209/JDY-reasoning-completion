import { chromium } from "playwright";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { installApiSession, loginAsAdmin } from "./helpers/regression-auth.mjs";

const rootDir = path.resolve(import.meta.dirname, "..");
const screenshotDir = path.join(rootDir, "verification/playwright");
const resultPath = path.join(rootDir, "verification/a25-entry-paste-conflict-keyboard-regression.json");
const frontendUrl = "http://127.0.0.1:5173/";
const apiBase = "http://127.0.0.1:8080";
await installApiSession(apiBase);
const batch = new Date().toISOString().replace(/\D/g, "").slice(0, 14);

const conflictName = `A25键盘候选${batch}`;
const products = [
  {
    code: `A25-A-${batch}`,
    name: conflictName,
    spec: "左旋 / 加长",
    category: "成品总成",
    unit: "只",
    status: "启用"
  },
  {
    code: `A25-B-${batch}`,
    name: conflictName,
    spec: "右旋 / 短款",
    category: "成品总成",
    unit: "只",
    status: "启用"
  }
];
const pasteText = [
  "商品名称\t规格型号\t仓库\t数量\t单价",
  `${conflictName}\t\t成品仓\t4\t28`
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
    return created.data;
  }
  if (created.status === 409) {
    return requireApi(`/api/master-data/product/${encodeURIComponent(product.code)}`, { method: "PUT", body: product });
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

async function openSalesOrderForm(page) {
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
  return billNo;
}

async function candidateCodes(page) {
  const buttons = page.locator(".entry-paste-candidate");
  const count = await buttons.count();
  const codes = [];
  for (let index = 0; index < count; index += 1) {
    codes.push((await buttons.nth(index).locator("strong").innerText()).trim());
  }
  return codes;
}

async function activeCandidateCode(page) {
  return (await page.locator(".entry-paste-candidate.active strong").innerText()).trim();
}

async function readFirstLine(page) {
  return {
    productCode: await page.getByTestId("sales-line-product").inputValue(),
    productName: (await page.getByTestId("sales-entry-row").first().locator("td").nth(1).innerText()).trim(),
    spec: (await page.getByTestId("sales-entry-row").first().locator("td").nth(2).innerText()).trim(),
    warehouseCode: await page.getByTestId("sales-line-warehouse").inputValue(),
    qty: Number(await page.getByTestId("sales-line-qty").inputValue()),
    unitPrice: Number(await page.getByTestId("sales-line-price").inputValue()),
    amount: (await page.getByTestId("sales-line-amount").innerText()).trim()
  };
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

for (const product of products) {
  await upsertProduct(product);
}

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1366, height: 768 } });

try {
  const billNo = await openSalesOrderForm(page);

  await dispatchPaste(page, "sales-line-product", pasteText);
  await page.getByTestId("entry-paste-conflict-dialog").waitFor({ state: "visible" });
  const firstDialogCodes = await candidateCodes(page);
  if (firstDialogCodes.length < 2) {
    throw new Error(`expected at least 2 candidates, got ${firstDialogCodes.join(",")}`);
  }
  const firstActiveCode = await activeCandidateCode(page);
  assertEqual("initial active candidate", firstActiveCode, firstDialogCodes[0]);
  await page.keyboard.press("Escape");
  await page.getByTestId("entry-paste-conflict-dialog").waitFor({ state: "hidden" });
  await page.getByText("已取消本次粘贴。").waitFor({ state: "visible" });

  await dispatchPaste(page, "sales-line-product", pasteText);
  await page.getByTestId("entry-paste-conflict-dialog").waitFor({ state: "visible" });
  const dialogCodes = await candidateCodes(page);
  const selectedByKeyboard = dialogCodes[1];
  await page.keyboard.press("ArrowDown");
  const activeAfterDown = await activeCandidateCode(page);
  assertEqual("active candidate after ArrowDown", activeAfterDown, selectedByKeyboard);
  const dialogScreenshot = `a25-entry-paste-conflict-keyboard-dialog-${batch}.png`;
  await page.screenshot({ path: path.join(screenshotDir, dialogScreenshot), fullPage: true });
  await page.keyboard.press("Enter");
  await page.getByTestId("entry-paste-conflict-dialog").waitFor({ state: "hidden" });
  await page.getByText("已粘贴 1 行分录").waitFor({ state: "visible" });

  const selectedProduct = products.find((product) => product.code === selectedByKeyboard);
  if (!selectedProduct) {
    throw new Error(`selected candidate ${selectedByKeyboard} is not in seeded products`);
  }
  const lineAfterPaste = await readFirstLine(page);
  assertDeepEqual("line after keyboard paste", lineAfterPaste, {
    productCode: selectedProduct.code,
    productName: selectedProduct.name,
    spec: selectedProduct.spec,
    warehouseCode: "CK-001",
    qty: 4,
    unitPrice: 28,
    amount: "112.00"
  });
  const totalAfterPaste = (await page.getByTestId("document-total-amount").innerText()).trim();
  assertEqual("total after paste", totalAfterPaste, "112.00");

  await page.getByTestId("save-sales-order").click();
  await page.getByText("草稿已保存").waitFor({ state: "visible" });
  const detail = await requireApi(`/api/sales-orders/${encodeURIComponent(billNo)}`);
  const savedLines = detail.lines.map((line) => ({
    productCode: String(line.productCode ?? ""),
    warehouseCode: String(line.warehouseCode ?? ""),
    qty: Number(line.qty ?? 0),
    unitPrice: Number(line.unitPrice ?? 0)
  }));
  assertDeepEqual("saved line", savedLines, [
    { productCode: selectedProduct.code, warehouseCode: "CK-001", qty: 4, unitPrice: 28 }
  ]);

  const formScreenshot = `a25-entry-paste-conflict-keyboard-form-${batch}.png`;
  await page.screenshot({ path: path.join(screenshotDir, formScreenshot), fullPage: true });

  const result = {
    batch,
    generatedAt: new Date().toISOString(),
    billNo,
    products,
    firstDialogCodes,
    firstActiveCode,
    dialogCodes,
    selectedByKeyboard,
    activeAfterDown,
    lineAfterPaste,
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
