import { chromium } from "playwright";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { installApiSession } from "./helpers/regression-auth.mjs";

const rootDir = path.resolve(import.meta.dirname, "..");
const verificationDir = path.join(rootDir, "verification");
const screenshotDir = path.join(verificationDir, "playwright");
const resultPath = path.join(verificationDir, "a53-production-red-source-print-regression.json");
const apiBase = "http://127.0.0.1:8080";
const apiCookie = await installApiSession(apiBase);
const batch = new Date().toISOString().replace(/\D/g, "").slice(0, 14);
const bomIssueMethod = `A53-${batch}`;

await mkdir(screenshotDir, { recursive: true });

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function generatedBillNo(row, label) {
  const billNo = String(row?.billNo ?? "");
  if (!billNo) {
    throw new Error(`${label} did not return billNo: ${JSON.stringify(row)}`);
  }
  return billNo;
}

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

async function auditBomAllowNewVersion(code) {
  const preview = await requireJson(`/api/production/boms/${encodeURIComponent(code)}/audit-preview`);
  const body = preview.requiresConfirmation
    ? {
        confirmNewVersion: true,
        latestBomCode: preview.latestBomCode,
        latestVersionNo: preview.latestVersionNo
      }
    : undefined;
  return requireJson(`/api/production/boms/${encodeURIComponent(code)}/audit`, { method: "POST", body });
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
    for (const warehouseCode of ["CK-001", "CK-002", "CK-003"]) {
      await requireJson("/api/inventory/adjustments", {
        method: "POST",
        body: {
          productCode,
          warehouseCode,
          qtyDelta: 4000,
          txnType: "A53_PRODUCTION_RED_SOURCE_SEED",
          sourceBillType: `A53_RED_SOURCE:${batch}`
        }
      });
    }
  }
}

async function createProductionPairs() {
  await seedStock();
  const bomCode = `BOM-A53-${batch}`;

  await requireJson("/api/production/boms", {
    method: "POST",
    body: {
      code: bomCode,
      productCode: "CP-001",
      qty: 1,
      lines: [
        { materialCode: "CP-001", qty: 1 },
        { materialCode: "PJ-014", qty: 2 },
        { materialCode: "CP-T413874", qty: 3, issueWarehouseCode: "CK-001", issueMethod: bomIssueMethod }
      ]
    }
  });
  await auditBomAllowNewVersion(bomCode);
  const issueTaskNo = generatedBillNo(await requireJson("/api/production/tasks", {
    method: "POST",
    body: { bomCode, warehouseCode: "CK-001", qty: 3 }
  }), "生产任务领料红冲打印样本");
  const completeTaskNo = generatedBillNo(await requireJson("/api/production/tasks", {
    method: "POST",
    body: { bomCode, warehouseCode: "CK-001", qty: 10 }
  }), "生产任务完工红冲打印样本");
  await requireJson(`/api/production/tasks/${encodeURIComponent(issueTaskNo)}/audit`, { method: "POST" });
  await requireJson(`/api/production/tasks/${encodeURIComponent(completeTaskNo)}/audit`, { method: "POST" });
  const issueNo = generatedBillNo(await requireJson(`/api/production/tasks/${encodeURIComponent(issueTaskNo)}/issue`, {
    method: "POST",
    body: { materialWarehouseCode: "CK-002" }
  }), "生产领料红冲打印来源");
  await requireJson(`/api/production/material-issues/${encodeURIComponent(issueNo)}/audit`, { method: "POST" });
  const redIssue = await requireJson(`/api/production/material-issues/${encodeURIComponent(issueNo)}/red-reverse`, {
    method: "POST",
    body: {}
  });
  const completeIssueNo = generatedBillNo(await requireJson(`/api/production/tasks/${encodeURIComponent(completeTaskNo)}/issue`, {
    method: "POST",
    body: { materialWarehouseCode: "CK-002" }
  }), "完工任务领料红冲打印样本");
  await requireJson(`/api/production/material-issues/${encodeURIComponent(completeIssueNo)}/audit`, { method: "POST" });
  const productInNo = generatedBillNo(await requireJson(`/api/production/tasks/${encodeURIComponent(completeTaskNo)}/complete`, {
    method: "POST",
    body: {
      lines: [
        { productCode: "CP-001", warehouseCode: "CK-001", qty: 1, unitPrice: 10 },
        { productCode: "PJ-014", warehouseCode: "CK-002", qty: 2, unitPrice: 5 },
        { productCode: "CP-T413874", warehouseCode: "CK-003", qty: 3, unitPrice: 20 }
      ]
    }
  }), "产品入库红冲打印来源");
  await requireJson(`/api/production/product-ins/${encodeURIComponent(productInNo)}/audit`, { method: "POST" });
  const redProductIn = await requireJson(`/api/production/product-ins/${encodeURIComponent(productInNo)}/red-reverse`, {
    method: "POST",
    body: {}
  });

  return [
    {
      name: "生产领料单",
      documentType: "material-issue",
      detailPath: `/api/production/material-issues/${encodeURIComponent(redIssue.billNo)}`,
      sourceBillNo: issueNo,
      redBillNo: redIssue.billNo
    },
    {
      name: "产品入库单",
      documentType: "product-in",
      detailPath: `/api/production/product-ins/${encodeURIComponent(redProductIn.billNo)}`,
      sourceBillNo: productInNo,
      redBillNo: redProductIn.billNo
    }
  ];
}

async function assertHtml(document) {
  const response = await request(`/api/documents/${document.documentType}/${encodeURIComponent(document.redBillNo)}/print.html`);
  const html = await response.text();
  assert(response.ok, `${document.name} HTML endpoint failed ${response.status}: ${html}`);
  assert(html.includes(`来源原单：${document.sourceBillNo}`), `${document.name} HTML should include red source bill number`);
  assert(html.includes(document.redBillNo), `${document.name} HTML should include red bill number`);
  return {
    hasSourceBillNo: html.includes(document.sourceBillNo),
    hasRedBillNo: html.includes(document.redBillNo)
  };
}

async function assertPdf(document) {
  const response = await request(`/api/documents/${document.documentType}/${encodeURIComponent(document.redBillNo)}/print.pdf`);
  assert(response.ok, `${document.name} PDF endpoint failed ${response.status}`);
  assert(response.headers.get("content-type")?.includes("application/pdf"), `${document.name} PDF content type should be application/pdf`);
  const bytes = Buffer.from(await response.arrayBuffer());
  const ascii = bytes.toString("latin1");
  const pdfFileName = `a53-${document.documentType}-red-source-print.pdf`;
  await writeFile(path.join(verificationDir, pdfFileName), bytes);
  assert(ascii.startsWith("%PDF-1.4"), `${document.name} PDF should start with %PDF-1.4`);
  assert(ascii.includes(utf16beHex("来源原单：" + document.sourceBillNo)), `${document.name} PDF should include red source bill number`);
  assert(ascii.includes(utf16beHex(document.redBillNo)), `${document.name} PDF should include red bill number`);
  return {
    pdfPath: `verification/${pdfFileName}`,
    pdfSize: bytes.length,
    hasSourceBillNo: ascii.includes(utf16beHex(document.sourceBillNo)),
    hasRedBillNo: ascii.includes(utf16beHex(document.redBillNo))
  };
}

async function screenshotHtml(page, document) {
  await page.goto(`${apiBase}/api/documents/${document.documentType}/${encodeURIComponent(document.redBillNo)}/print.html`, { waitUntil: "networkidle" });
  await page.getByText(`来源原单：${document.sourceBillNo}`).waitFor({ state: "visible" });
  const screenshot = `a53-${document.documentType}-red-source-print-${batch}.png`;
  await page.screenshot({ path: path.join(screenshotDir, screenshot), fullPage: true });
  return `verification/playwright/${screenshot}`;
}

const documents = await createProductionPairs();
const checks = [];
for (const document of documents) {
  const detail = await requireJson(document.detailPath);
  assert(detail.document.redSourceBillNo === document.sourceBillNo, `${document.name} detail redSourceBillNo expected ${document.sourceBillNo}, got ${detail.document.redSourceBillNo}`);
  assert(detail.lines.length === 3, `${document.name} red detail should keep 3 lines, got ${detail.lines.length}`);
  checks.push({
    name: document.name,
    documentType: document.documentType,
    sourceBillNo: document.sourceBillNo,
    redBillNo: document.redBillNo,
    detail: {
      redSourceBillNo: detail.document.redSourceBillNo,
      lineCount: detail.lines.length,
      totalAmount: String(detail.document.totalAmount)
    },
    html: await assertHtml(document),
    pdf: await assertPdf(document)
  });
}

const browser = await chromium.launch({ headless: true });
try {
  const context = await browser.newContext({ viewport: { width: 1366, height: 768 } });
  const [cookieName, cookieValue] = apiCookie.split("=");
  await context.addCookies([{ name: cookieName, value: cookieValue, domain: "127.0.0.1", path: "/" }]);
  const page = await context.newPage();
  for (const check of checks) {
    check.screenshot = await screenshotHtml(page, check);
  }
} finally {
  await browser.close();
}

const result = {
  batch,
  generatedAt: new Date().toISOString(),
  checks
};
await writeFile(resultPath, JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));
