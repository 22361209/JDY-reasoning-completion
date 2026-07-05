import { chromium } from "playwright";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { installApiSession, loginAsAdmin } from "./helpers/regression-auth.mjs";
import { createSalesOutDraftViaDeliveryNotice } from "./helpers/sales-delivery-notice-flow.mjs";

const rootDir = path.resolve(import.meta.dirname, "..");
const verificationDir = path.join(rootDir, "verification");
const screenshotDir = path.join(verificationDir, "playwright");
const resultPath = path.join(verificationDir, "a46-document-print-template-regression.json");
const frontendUrl = "http://127.0.0.1:5173/";
const apiBase = "http://127.0.0.1:8080";
await installApiSession(apiBase);
const batch = new Date().toISOString().replace(/\D/g, "").slice(0, 14);
const bomIssueMethod = `A46-${batch}`;
const billDate = "2026-06-24";
const companyName = "博莱德机械测试账套";
const templateName = "标准套打模板";
const footerNote = "本单据由 JDY 推理补完 ERP 生成，请按公司制度完成签字、盖章与归档。";
const expectedTotal = "124.30";

const lines = [
  { productCode: "CP-001", warehouseCode: "CK-001", qty: 1, unitPrice: 10, lineRemark: "A46 套打备注：首行" },
  { productCode: "PJ-014", warehouseCode: "CK-002", qty: 2, unitPrice: 5, lineRemark: "A46 套打备注：第二行" },
  { productCode: "CP-T413874", warehouseCode: "CK-T413874", qty: 3, unitPrice: 30, lineRemark: "A46 套打备注：第三行" }
];

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

async function requireText(pathname) {
  const response = await request(pathname);
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`GET ${pathname} failed ${response.status}: ${text}`);
  }
  return text;
}

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
          txnType: "A46_PRINT_TEMPLATE_SEED",
          sourceBillType: `A46_PRINT_TEMPLATE:${batch}`
        }
      });
    }
  }
}

async function createCoreDocuments() {
  const salesOrderNo = generatedBillNo(await requireJson("/api/sales-orders/draft", {
    method: "POST",
    body: { customerCode: "KH-001", billDate, department: "销售部", ownerName: "本地管理员", lines }
  }), "销售订单套打样本");
  await requireJson(`/api/sales-orders/${encodeURIComponent(salesOrderNo)}/audit`, { method: "POST" });

  const purchaseOrderNo = generatedBillNo(await requireJson("/api/purchase-orders/draft", {
    method: "POST",
    body: { supplierCode: "GYS-001", billDate, department: "采购部", ownerName: "本地管理员", lines }
  }), "采购订单套打样本");
  await requireJson(`/api/purchase-orders/${encodeURIComponent(purchaseOrderNo)}/audit`, { method: "POST" });

  const salesOutFlow = await createSalesOutDraftViaDeliveryNotice((pathname, body) => requireJson(pathname, { method: "POST", body }), {
    sourceOrderNo: salesOrderNo,
    customerCode: "KH-001",
    billDate,
    department: "销售部",
    ownerName: "本地管理员",
    lines
  });
  const salesOutNo = salesOutFlow.salesOutNo;
  await requireJson(`/api/sales-outs/${encodeURIComponent(salesOutNo)}/audit`, { method: "POST" });

  const purchaseInNo = generatedBillNo(await requireJson("/api/purchase-ins/draft", {
    method: "POST",
    body: { supplierCode: "GYS-001", billDate, department: "采购部", ownerName: "本地管理员", lines }
  }), "采购入库套打样本");
  await requireJson(`/api/purchase-ins/${encodeURIComponent(purchaseInNo)}/audit`, { method: "POST" });

  return [
    { name: "销售订单", documentType: "sales-order", frontendType: "sales", module: "销售管理", entry: "sales-order-form", list: "sales-order-form-list", billNo: salesOrderNo, expectedTotal },
    { name: "采购订单", documentType: "purchase-order", frontendType: "purchase", module: "采购管理", entry: "purchase-order-form", list: "purchase-order-form-list", billNo: purchaseOrderNo, expectedTotal },
    { name: "销售出库单", documentType: "sales-out", frontendType: "sales-out", module: "销售管理", entry: "sales-out-form", list: "sales-out-form-list", billNo: salesOutNo, expectedTotal },
    { name: "采购入库单", documentType: "purchase-in", frontendType: "purchase-in", module: "采购管理", entry: "purchase-in-form", list: "purchase-in-form-list", billNo: purchaseInNo, expectedTotal }
  ];
}

async function createProductionDocuments() {
  const bomCode = `BOM-A46-${batch}`;

  await requireJson("/api/production/boms", {
    method: "POST",
    body: {
      code: bomCode,
      productCode: "CP-001",
      qty: 1,
      lines: [
        { materialCode: "CP-001", qty: 1 },
        { materialCode: "PJ-014", qty: 2, issueWarehouseCode: "CK-001" },
        { materialCode: "CP-T413874", qty: 3, issueMethod: bomIssueMethod }
      ]
    }
  });
  await auditBomAllowNewVersion(bomCode);
  const taskIssue = generatedBillNo(await requireJson("/api/production/tasks", {
    method: "POST",
    body: { bomCode, warehouseCode: "CK-001", qty: 3 }
  }), "生产任务领料套打样本");
  const taskComplete = generatedBillNo(await requireJson("/api/production/tasks", {
    method: "POST",
    body: { bomCode, warehouseCode: "CK-001", qty: 10 }
  }), "生产任务完工套打样本");
  await requireJson(`/api/production/tasks/${encodeURIComponent(taskIssue)}/audit`, { method: "POST" });
  await requireJson(`/api/production/tasks/${encodeURIComponent(taskComplete)}/audit`, { method: "POST" });
  const issueNo = generatedBillNo(await requireJson(`/api/production/tasks/${encodeURIComponent(taskIssue)}/issue`, {
    method: "POST",
    body: { materialWarehouseCode: "CK-002" }
  }), "生产领料套打样本");
  await requireJson(`/api/production/material-issues/${encodeURIComponent(issueNo)}/audit`, { method: "POST" });
  const completeIssueNo = generatedBillNo(await requireJson(`/api/production/tasks/${encodeURIComponent(taskComplete)}/issue`, {
    method: "POST",
    body: { materialWarehouseCode: "CK-002" }
  }), "完工任务领料套打样本");
  await requireJson(`/api/production/material-issues/${encodeURIComponent(completeIssueNo)}/audit`, { method: "POST" });
  const productInNo = generatedBillNo(await requireJson(`/api/production/tasks/${encodeURIComponent(taskComplete)}/complete`, {
    method: "POST",
    body: {
      lines: [
        { productCode: "CP-001", warehouseCode: "CK-001", qty: 1, unitPrice: 10 },
        { productCode: "PJ-014", warehouseCode: "CK-002", qty: 2, unitPrice: 5 },
        { productCode: "CP-T413874", warehouseCode: "CK-T413874", qty: 3, unitPrice: 20 }
      ]
    }
  }), "产品入库套打样本");
  await requireJson(`/api/production/product-ins/${encodeURIComponent(productInNo)}/audit`, { method: "POST" });

  return [
    { name: "生产领料单", documentType: "material-issue", frontendType: "material-issue", module: "生产管理", entry: "material-issue-form", list: "material-issue-form-list", billNo: issueNo, expectedTotal: "18.00" },
    { name: "产品入库单", documentType: "product-in", frontendType: "product-in", module: "生产管理", entry: "product-in-form", list: "product-in-form-list", billNo: productInNo, expectedTotal: "80.00" }
  ];
}

async function assertTemplate(document) {
  const template = await requireJson(`/api/documents/${document.documentType}/print-template`);
  assert(template.templateName === templateName, `${document.name} template name mismatch`);
  assert(template.companyName === companyName, `${document.name} company name mismatch`);
  assert(template.showSignature === true, `${document.name} signature should be enabled`);
  assert(template.showSeal === true, `${document.name} seal should be enabled`);
  return template;
}

async function assertHtml(document) {
  const html = await requireText(`/api/documents/${document.documentType}/${encodeURIComponent(document.billNo)}/print.html`);
  for (const expected of [companyName, templateName, footerNote, "制单：本地管理员", "审核：", "财务：", "仓管：", "公司章"]) {
    assert(html.includes(expected), `${document.name} HTML should include ${expected}`);
  }
  return {
    hasCompanyName: html.includes(companyName),
    hasTemplateName: html.includes(templateName),
    hasFooterNote: html.includes(footerNote),
    hasSignature: html.includes("制单：本地管理员") && html.includes("审核：") && html.includes("财务：") && html.includes("仓管："),
    hasSeal: html.includes("公司章")
  };
}

async function assertPdf(document) {
  const response = await request(`/api/documents/${document.documentType}/${encodeURIComponent(document.billNo)}/print.pdf`);
  assert(response.ok, `${document.name} PDF endpoint failed ${response.status}`);
  assert(response.headers.get("content-type")?.includes("application/pdf"), `${document.name} content type should be application/pdf`);
  const bytes = Buffer.from(await response.arrayBuffer());
  const ascii = bytes.toString("latin1");
  const pdfFileName = `a46-${document.documentType}-template-print.pdf`;
  await writeFile(path.join(verificationDir, pdfFileName), bytes);
  const expectedTexts = [companyName, templateName, document.name, document.billNo, document.expectedTotal, "制单：本地管理员", "审核：", "财务：", "仓管：", "公司章", footerNote];
  for (const expected of expectedTexts) {
    assert(ascii.includes(utf16beHex(expected)), `${document.name} PDF should include ${expected}`);
  }
  return {
    name: document.name,
    documentType: document.documentType,
    billNo: document.billNo,
    pdfPath: `verification/${pdfFileName}`,
    pdfSize: bytes.length,
    checks: {
      hasCompanyName: ascii.includes(utf16beHex(companyName)),
      hasTemplateName: ascii.includes(utf16beHex(templateName)),
      hasTitle: ascii.includes(utf16beHex(document.name)),
      hasBillNo: ascii.includes(utf16beHex(document.billNo)),
      hasTotalAmount: ascii.includes(utf16beHex(document.expectedTotal)),
      hasSignature: ["制单：本地管理员", "审核：", "财务：", "仓管："].every((value) => ascii.includes(utf16beHex(value))),
      hasSeal: ascii.includes(utf16beHex("公司章")),
      hasFooterNote: ascii.includes(utf16beHex(footerNote))
    }
  };
}

async function openAndPrint(page, document) {
  await page.goto(frontendUrl, { waitUntil: "networkidle" });
  await loginAsAdmin(page);
  await page.getByTestId(`module-${document.module}`).hover();
  await page.getByTestId(`query-${document.entry}`).click();
  await page.getByTestId(`tab-${document.list}`).waitFor({ state: "visible" });
  await page.getByTestId("list-keyword").fill(document.billNo);
  await page.getByTestId("list-query").click();
  await page.getByTestId(`open-document-${document.billNo}`).waitFor({ state: "visible", timeout: 10000 });
  await page.getByTestId(`open-document-${document.billNo}`).click();
  await page.getByTestId("document-status").waitFor({ state: "visible" });
  await page.waitForFunction(({ testId, billNo }) => {
    const input = document.querySelector(`[data-testid="${testId}"]`);
    return input instanceof HTMLInputElement && input.value === billNo;
  }, { testId: `${document.frontendType}-bill-no`, billNo: document.billNo });
  const rows = page.getByTestId(`${document.frontendType}-entry-row`);
  const rowCount = await rows.count();
  assert(rowCount === 3, `${document.name} detail row count expected 3, got ${rowCount}`);
  const popupPromise = page.waitForEvent("popup", { timeout: 3000 }).catch(() => null);
  await page.getByTestId("print-sales-order").click();
  const popup = await popupPromise;
  if (popup) {
    await popup.close();
  }
  await page.getByText("PDF 打印文件已生成").waitFor({ state: "visible" });
  const screenshot = `a46-${document.documentType}-template-print-${batch}.png`;
  await page.screenshot({ path: path.join(screenshotDir, screenshot), fullPage: true });
  return {
    name: document.name,
    billNo: document.billNo,
    rowCount,
    screenshot: `verification/playwright/${screenshot}`
  };
}

await seedStock();
const documents = [
  ...(await createCoreDocuments()),
  ...(await createProductionDocuments())
];

const checks = [];
for (const document of documents) {
  checks.push({
    name: document.name,
    template: await assertTemplate(document),
    html: await assertHtml(document),
    pdf: await assertPdf(document)
  });
}

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1366, height: 768 } });
let frontendCheck;
try {
  frontendCheck = await openAndPrint(page, documents[0]);
} finally {
  await browser.close();
}

const result = {
  batch,
  generatedAt: new Date().toISOString(),
  documents: documents.map(({ name, documentType, billNo }) => ({ name, documentType, billNo })),
  checks,
  frontendCheck
};
await writeFile(resultPath, JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));
