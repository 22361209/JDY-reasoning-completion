import { chromium } from "playwright";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const rootDir = path.resolve(import.meta.dirname, "..");
const verificationDir = path.join(rootDir, "verification");
const screenshotDir = path.join(verificationDir, "playwright");
const resultPath = path.join(verificationDir, "a40-production-document-pdf-regression.json");
const frontendUrl = "http://127.0.0.1:5173/";
const apiBase = "http://127.0.0.1:8080";
const batch = new Date().toISOString().replace(/\D/g, "").slice(0, 14);

const materialIssueTotal = "18.00";
const productInTotal = "80.00";

await mkdir(screenshotDir, { recursive: true });

async function request(pathname, options = {}) {
  return fetch(`${apiBase}${pathname}`, {
    method: options.method ?? "GET",
    headers: options.body ? { "Content-Type": "application/json" } : undefined,
    body: options.body ? JSON.stringify(options.body) : undefined
  });
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

async function seedStock() {
  for (const productCode of ["CP-001", "PJ-014", "CP-T413874"]) {
    for (const warehouseCode of ["CK-001", "CK-002", "CK-T413874"]) {
      await requireJson("/api/inventory/adjustments", {
        method: "POST",
        body: {
          productCode,
          warehouseCode,
          qtyDelta: 3000,
          txnType: "A40_PRODUCTION_PDF_SEED",
          sourceBillType: `A40_PDF:${batch}`
        }
      });
    }
  }
}

async function createDocuments() {
  await seedStock();
  const bomCode = `BOM-A40-${batch}`;
  const taskIssue = `SCRW-A40-I-${batch}`;
  const taskComplete = `SCRW-A40-C-${batch}`;
  const issueNo = `SCLL-A40-${batch}`;
  const productInNo = `CPRK-A40-${batch}`;

  await requireJson("/api/production/boms", {
    method: "POST",
    body: {
      code: bomCode,
      productCode: "CP-001",
      qty: 1,
      lines: [
        { materialCode: "CP-001", qty: 1 },
        { materialCode: "PJ-014", qty: 2 },
        { materialCode: "CP-T413874", qty: 3 }
      ]
    }
  });
  await requireJson("/api/production/tasks", {
    method: "POST",
    body: { billNo: taskIssue, bomCode, warehouseCode: "CK-001", qty: 3 }
  });
  await requireJson("/api/production/tasks", {
    method: "POST",
    body: { billNo: taskComplete, bomCode, warehouseCode: "CK-001", qty: 10 }
  });
  await requireJson(`/api/production/tasks/${encodeURIComponent(taskIssue)}/issue`, {
    method: "POST",
    body: { billNo: issueNo, materialWarehouseCode: "CK-002" }
  });
  await requireJson(`/api/production/tasks/${encodeURIComponent(taskComplete)}/complete`, {
    method: "POST",
    body: {
      billNo: productInNo,
      lines: [
        { productCode: "CP-001", warehouseCode: "CK-001", qty: 1, unitPrice: 10 },
        { productCode: "PJ-014", warehouseCode: "CK-002", qty: 2, unitPrice: 5 },
        { productCode: "CP-T413874", warehouseCode: "CK-T413874", qty: 3, unitPrice: 20 }
      ]
    }
  });

  return [
    {
      name: "生产领料单",
      documentType: "material-issue",
      frontendType: "material-issue",
      module: "生产管理",
      entry: "material-issue-form",
      list: "material-issue-form-list",
      billNo: issueNo,
      expectedTotal: materialIssueTotal
    },
    {
      name: "产品入库单",
      documentType: "product-in",
      frontendType: "product-in",
      module: "生产管理",
      entry: "product-in-form",
      list: "product-in-form-list",
      billNo: productInNo,
      expectedTotal: productInTotal
    }
  ];
}

async function assertPdf(document) {
  const response = await request(`/api/documents/${document.documentType}/${encodeURIComponent(document.billNo)}/print.pdf`);
  assert(response.ok, `${document.name} PDF endpoint failed ${response.status}`);
  assert(response.headers.get("content-type")?.includes("application/pdf"), `${document.name} content type should be application/pdf`);
  const bytes = Buffer.from(await response.arrayBuffer());
  const ascii = bytes.toString("latin1");
  const pdfFileName = `a40-${document.documentType}-print.pdf`;
  await writeFile(path.join(verificationDir, pdfFileName), bytes);
  assert(ascii.startsWith("%PDF-1.4"), `${document.name} PDF should start with %PDF-1.4`);
  assert(ascii.includes("/Type /Catalog"), `${document.name} PDF should include catalog object`);
  assert(ascii.includes("/BaseFont /STSong-Light"), `${document.name} PDF should declare Chinese CID font`);
  assert(ascii.includes(utf16beHex(document.name)), `${document.name} PDF should include title`);
  assert(ascii.includes(utf16beHex(document.billNo)), `${document.name} PDF should include bill number`);
  assert(ascii.includes(utf16beHex(document.expectedTotal)), `${document.name} PDF should include total amount`);
  return {
    name: document.name,
    documentType: document.documentType,
    billNo: document.billNo,
    pdfPath: `verification/${pdfFileName}`,
    pdfSize: bytes.length,
    checks: {
      contentType: response.headers.get("content-type"),
      startsWithPdf: ascii.startsWith("%PDF-1.4"),
      hasCatalog: ascii.includes("/Type /Catalog"),
      hasChineseFont: ascii.includes("/BaseFont /STSong-Light"),
      hasTitle: ascii.includes(utf16beHex(document.name)),
      hasBillNo: ascii.includes(utf16beHex(document.billNo)),
      hasTotalAmount: ascii.includes(utf16beHex(document.expectedTotal))
    }
  };
}

async function openAndPrint(page, document) {
  await page.goto(frontendUrl, { waitUntil: "networkidle" });
  await page.getByTestId(`module-${document.module}`).hover();
  await page.getByTestId(`query-${document.entry}`).click();
  await page.getByTestId(`tab-${document.list}`).waitFor({ state: "visible" });
  await page.getByTestId("list-keyword").fill(document.billNo);
  await page.getByTestId("list-keyword").press("Enter");
  await page.getByTestId(`open-document-${document.billNo}`).click();
  await page.getByTestId("document-status").waitFor({ state: "visible" });

  const rows = page.getByTestId(`${document.frontendType}-entry-row`);
  const rowCount = await rows.count();
  assert(rowCount === 3, `${document.name} detail row count expected 3, got ${rowCount}`);
  const totalText = (await page.getByTestId("document-total-amount").innerText()).replace(/,/g, "").trim();
  assert(totalText === document.expectedTotal, `${document.name} detail total expected ${document.expectedTotal}, got ${totalText}`);

  const popupPromise = page.waitForEvent("popup", { timeout: 3000 }).catch(() => null);
  await page.getByTestId("print-sales-order").click();
  const popup = await popupPromise;
  if (popup) {
    await popup.close();
  }
  await page.getByText("PDF 打印文件已生成").waitFor({ state: "visible" });
  const screenshot = `a40-${document.documentType}-pdf-print-${batch}.png`;
  await page.screenshot({ path: path.join(screenshotDir, screenshot), fullPage: true });
  return {
    name: document.name,
    billNo: document.billNo,
    rowCount,
    total: totalText,
    screenshot: `verification/playwright/${screenshot}`
  };
}

const documents = await createDocuments();
const pdfChecks = [];
for (const document of documents) {
  pdfChecks.push(await assertPdf(document));
}

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1366, height: 768 } });
const frontendChecks = [];
try {
  for (const document of documents) {
    frontendChecks.push(await openAndPrint(page, document));
  }
} finally {
  await browser.close();
}

const result = {
  batch,
  generatedAt: new Date().toISOString(),
  pdfChecks,
  frontendChecks
};
await writeFile(resultPath, JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));
