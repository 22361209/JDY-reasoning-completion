import { chromium } from "playwright";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { installApiSession, loginAsAdmin } from "./helpers/regression-auth.mjs";

const rootDir = path.resolve(import.meta.dirname, "..");
const screenshotDir = path.join(rootDir, "verification/playwright");
const pdfPath = path.join(rootDir, "verification/a38-sales-order-print.pdf");
const resultPath = path.join(rootDir, "verification/a38-document-pdf-output-regression.json");
const frontendUrl = "http://127.0.0.1:5173/";
const apiBase = "http://127.0.0.1:8080";
await installApiSession(apiBase);
const batch = new Date().toISOString().replace(/\D/g, "").slice(0, 14);
const billNo = `XSDD-A38-${batch}`;
const firstRemark = "PDF打印备注：样品";
const secondRemark = "PDF打印备注：补录";

await mkdir(screenshotDir, { recursive: true });
await mkdir(path.dirname(resultPath), { recursive: true });

async function request(pathname, options = {}) {
  const response = await fetch(`${apiBase}${pathname}`, {
    method: options.method ?? "GET",
    headers: options.body ? { "Content-Type": "application/json" } : undefined,
    body: options.body ? JSON.stringify(options.body) : undefined
  });
  return response;
}

async function requireJson(pathname, options = {}) {
  const response = await request(pathname, options);
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`${options.method ?? "GET"} ${pathname} failed ${response.status}: ${text}`);
  }
  return text ? JSON.parse(text) : {};
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function utf16beHex(value) {
  let hex = "";
  for (const char of value) {
    const codePoint = char.codePointAt(0);
    if (codePoint > 0xffff) {
      const high = Math.floor((codePoint - 0x10000) / 0x400) + 0xd800;
      const low = ((codePoint - 0x10000) % 0x400) + 0xdc00;
      hex += high.toString(16).padStart(4, "0") + low.toString(16).padStart(4, "0");
    } else {
      hex += codePoint.toString(16).padStart(4, "0");
    }
  }
  return hex.toUpperCase();
}

await requireJson("/api/sales-orders/draft", {
  method: "POST",
  body: {
    billNo,
    customerCode: "KH-001",
    billDate: "2026-06-24",
    department: "销售部",
    ownerName: "本地管理员",
    lines: [
      { productCode: "CP-001", warehouseCode: "CK-001", qty: 1, unitPrice: 0, lineRemark: firstRemark },
      { productCode: "PJ-014", warehouseCode: "CK-002", qty: 0, unitPrice: 5, lineRemark: secondRemark },
      { productCode: "CP-T413874", warehouseCode: "CK-001", qty: 2, unitPrice: 30, lineRemark: "" }
    ]
  }
});

const pdfResponse = await request(`/api/documents/sales-order/${encodeURIComponent(billNo)}/print.pdf`);
assert(pdfResponse.ok, `PDF endpoint failed ${pdfResponse.status}`);
assert(pdfResponse.headers.get("content-type")?.includes("application/pdf"), "PDF content type should be application/pdf");
const pdfBytes = Buffer.from(await pdfResponse.arrayBuffer());
await writeFile(pdfPath, pdfBytes);
const pdfAscii = pdfBytes.toString("latin1");
assert(pdfAscii.startsWith("%PDF-1.4"), "PDF should start with %PDF-1.4");
assert(pdfAscii.includes("/Type /Catalog"), "PDF should include catalog object");
assert(pdfAscii.includes("/BaseFont /STSong-Light"), "PDF should declare Chinese CID font");
assert(pdfAscii.includes(utf16beHex(billNo)), "PDF should include bill number");
assert(pdfAscii.includes(utf16beHex(firstRemark)), "PDF should include first line remark");
assert(pdfAscii.includes(utf16beHex(secondRemark)), "PDF should include second line remark");
assert(pdfAscii.includes(utf16beHex("60.00")), "PDF should include total amount");
assert(pdfBytes.length > 1200, `PDF should not be empty, got ${pdfBytes.length} bytes`);

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1366, height: 768 } });
const screenshots = [];
try {
  await page.goto(frontendUrl, { waitUntil: "networkidle" });
  await loginAsAdmin(page);
  await page.getByTestId("module-销售管理").hover();
  await page.getByTestId("query-sales-order-form").click();
  await page.getByTestId("tab-sales-order-form-list").waitFor({ state: "visible" });
  await page.getByTestId("list-keyword").fill(billNo);
  await page.getByTestId("list-keyword").press("Enter");
  await page.getByTestId(`open-document-${billNo}`).click();
  await page.getByTestId("document-status").waitFor({ state: "visible" });
  await page.getByTestId("print-sales-order").click();
  await page.getByText("PDF 打印文件已生成").waitFor({ state: "visible" });
  const screenshot = `a38-sales-order-pdf-print-${batch}.png`;
  await page.screenshot({ path: path.join(screenshotDir, screenshot), fullPage: true });
  screenshots.push(`verification/playwright/${screenshot}`);
} finally {
  await browser.close();
}

const result = {
  batch,
  generatedAt: new Date().toISOString(),
  billNo,
  pdfPath: "verification/a38-sales-order-print.pdf",
  pdfSize: pdfBytes.length,
  checks: {
    contentType: pdfResponse.headers.get("content-type"),
    startsWithPdf: pdfAscii.startsWith("%PDF-1.4"),
    hasCatalog: pdfAscii.includes("/Type /Catalog"),
    hasChineseFont: pdfAscii.includes("/BaseFont /STSong-Light"),
    hasBillNo: pdfAscii.includes(utf16beHex(billNo)),
    hasRemarks: pdfAscii.includes(utf16beHex(firstRemark)) && pdfAscii.includes(utf16beHex(secondRemark)),
    hasTotalAmount: pdfAscii.includes(utf16beHex("60.00"))
  },
  screenshots
};
await writeFile(resultPath, JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));
