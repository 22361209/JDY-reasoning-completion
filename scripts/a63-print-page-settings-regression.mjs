import { chromium } from "playwright";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const rootDir = path.resolve(import.meta.dirname, "..");
const verificationDir = path.join(rootDir, "verification");
const screenshotDir = path.join(verificationDir, "playwright");
const resultPath = path.join(verificationDir, "a63-print-page-settings-regression.json");
const pdfPath = path.join(verificationDir, "a63-sales-order-print-settings.pdf");
const frontendUrl = "http://127.0.0.1:5173/";
const batch = new Date().toISOString().replace(/\D/g, "").slice(0, 14);
const billNo = `XSDD-A63-${batch}`;
const customTemplate = {
  templateCode: "STANDARD",
  templateName: `A63打印参数-${batch}`,
  roleCode: "",
  companyName: `A63模板公司-${batch}`,
  headerNote: `A63页眉-${batch}`,
  footerNote: `A63页脚-${batch}`,
  showSignature: true,
  showSeal: true,
  isDefault: true,
  paperSize: "A4",
  pageOrientation: "LANDSCAPE",
  marginTopMm: "8",
  marginRightMm: "10",
  marginBottomMm: "12",
  marginLeftMm: "14",
  copyCount: 3
};
const defaultTemplate = {
  templateCode: "STANDARD",
  templateName: "标准套打模板",
  roleCode: "",
  companyName: "博莱德机械测试账套",
  headerNote: "会计期间 2026-06 / 业务期间 2026-06",
  footerNote: "本单据由 JDY 推理补完 ERP 生成，请按公司制度完成签字、盖章与归档。",
  showSignature: true,
  showSeal: true,
  isDefault: true,
  paperSize: "A4",
  pageOrientation: "PORTRAIT",
  marginTopMm: "12",
  marginRightMm: "12",
  marginBottomMm: "12",
  marginLeftMm: "12",
  copyCount: 1
};
const lines = [
  { productCode: "CP-001", warehouseCode: "CK-001", qty: 2, unitPrice: 10, lineRemark: "A63 第一行" },
  { productCode: "PJ-014", warehouseCode: "CK-002", qty: 3, unitPrice: 6, lineRemark: "A63 第二行" },
  { productCode: "CP-T413874", warehouseCode: "CK-T413874", qty: 4, unitPrice: 12, lineRemark: "A63 第三行" }
];

await mkdir(screenshotDir, { recursive: true });

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

async function browserFetch(page, pathname, options = {}) {
  return page.evaluate(async ({ pathname, options }) => {
    const response = await fetch(pathname, {
      method: options.method ?? "GET",
      headers: options.body ? { "Content-Type": "application/json" } : undefined,
      body: options.body ? JSON.stringify(options.body) : undefined
    });
    return { status: response.status, ok: response.ok, text: await response.text() };
  }, { pathname, options });
}

async function browserFetchBytes(page, pathname) {
  return page.evaluate(async (pathname) => {
    const response = await fetch(pathname);
    const bytes = Array.from(new Uint8Array(await response.arrayBuffer()));
    return { status: response.status, ok: response.ok, contentType: response.headers.get("content-type") ?? "", bytes };
  }, pathname);
}

async function requireJson(page, pathname, options = {}) {
  const response = await browserFetch(page, pathname, options);
  assert(response.ok, `${options.method ?? "GET"} ${pathname} failed ${response.status}: ${response.text}`);
  return response.text ? JSON.parse(response.text) : {};
}

async function requireText(page, pathname) {
  const response = await browserFetch(page, pathname);
  assert(response.ok, `GET ${pathname} failed ${response.status}: ${response.text}`);
  return response.text;
}

async function loginAsAdmin(page) {
  await page.getByTestId("login-page").waitFor({ state: "visible" });
  await page.getByTestId("login-username").selectOption("admin");
  await page.getByTestId("login-password").fill("admin123");
  await page.getByTestId("login-submit").click();
  await page.getByTestId("session-user-role").filter({ hasText: "系统管理员" }).waitFor({ state: "visible" });
}

async function createSalesOrder(page) {
  await requireJson(page, "/api/sales-orders/draft", {
    method: "POST",
    body: {
      billNo,
      customerCode: "KH-001",
      billDate: "2026-06-24",
      department: "销售部",
      ownerName: "本地管理员",
      lines
    }
  });
  await requireJson(page, `/api/sales-orders/${encodeURIComponent(billNo)}/audit`, { method: "POST" });
}

const browser = await chromium.launch({ headless: true });
let screenshot = "";
try {
  const page = await browser.newPage({ viewport: { width: 1366, height: 768 } });
  await page.goto(frontendUrl, { waitUntil: "networkidle" });
  await loginAsAdmin(page);

  await page.getByTestId("module-系统设置").hover();
  await page.getByTestId("entry-print-template-settings").click();
  await page.getByTestId("tab-print-template-settings").waitFor({ state: "visible" });
  await page.getByTestId("print-template-document-type").selectOption("sales-order");
  await page.getByTestId("print-template-name").fill(customTemplate.templateName);
  await page.getByTestId("print-template-company").fill(customTemplate.companyName);
  await page.getByTestId("print-template-header-note").fill(customTemplate.headerNote);
  await page.getByTestId("print-template-footer-note").fill(customTemplate.footerNote);
  await page.getByTestId("print-template-paper-size").selectOption(customTemplate.paperSize);
  await page.getByTestId("print-template-page-orientation").selectOption(customTemplate.pageOrientation);
  await page.getByTestId("print-template-copy-count").fill(String(customTemplate.copyCount));
  await page.getByTestId("print-template-margin-top").fill(customTemplate.marginTopMm);
  await page.getByTestId("print-template-margin-right").fill(customTemplate.marginRightMm);
  await page.getByTestId("print-template-margin-bottom").fill(customTemplate.marginBottomMm);
  await page.getByTestId("print-template-margin-left").fill(customTemplate.marginLeftMm);
  await page.getByTestId("print-template-save").click();
  await page.getByTestId("print-template-message").getByText("打印模板已保存").waitFor({ state: "visible" });
  screenshot = `a63-print-page-settings-${batch}.png`;
  await page.screenshot({ path: path.join(screenshotDir, screenshot), fullPage: true });

  const savedTemplate = await requireJson(page, "/api/documents/sales-order/print-template");
  assert(savedTemplate.paperSize === customTemplate.paperSize, "paper size should be saved");
  assert(savedTemplate.pageOrientation === customTemplate.pageOrientation, "page orientation should be saved");
  assert(Number(savedTemplate.copyCount) === customTemplate.copyCount, "copy count should be saved");
  assert(String(savedTemplate.marginTopMm) === customTemplate.marginTopMm, "top margin should be saved");
  assert(String(savedTemplate.marginLeftMm) === customTemplate.marginLeftMm, "left margin should be saved");

  await createSalesOrder(page);
  const html = await requireText(page, `/api/documents/sales-order/${encodeURIComponent(billNo)}/print.html`);
  for (const expected of ["@page", "A4 landscape", "8mm 10mm 12mm 14mm", "联次：3联", "第3联 / 共3联", customTemplate.templateName]) {
    assert(html.includes(expected), `HTML should include ${expected}`);
  }

  const pdfResponse = await browserFetchBytes(page, `/api/documents/sales-order/${encodeURIComponent(billNo)}/print.pdf`);
  assert(pdfResponse.ok, `PDF endpoint failed ${pdfResponse.status}`);
  assert(pdfResponse.contentType.includes("application/pdf"), "PDF content type should be application/pdf");
  const pdfBytes = Buffer.from(pdfResponse.bytes);
  await writeFile(pdfPath, pdfBytes);
  const pdfText = pdfBytes.toString("latin1");
  assert(pdfText.startsWith("%PDF-1.4"), "PDF should start with %PDF-1.4");
  assert(pdfText.includes("/Count 3"), "PDF should contain three pages for three copies");
  assert(pdfText.includes("/MediaBox [0 0 842 595]"), "PDF should use A4 landscape MediaBox");
  for (const expected of ["第1联 / 共3联", "第2联 / 共3联", "第3联 / 共3联", "纸张：A4", "方向：横向", "边距：8/10/12/14mm", customTemplate.templateName]) {
    assert(pdfText.includes(utf16beHex(expected)), `PDF should include ${expected}`);
  }

  const restoredTemplate = await requireJson(page, "/api/documents/sales-order/print-template", {
    method: "PUT",
    body: defaultTemplate
  });
  assert(restoredTemplate.pageOrientation === "PORTRAIT", "default orientation should be restored");
  assert(Number(restoredTemplate.copyCount) === 1, "default copy count should be restored");

  const result = {
    batch,
    generatedAt: new Date().toISOString(),
    billNo,
    savedTemplate,
    restoredTemplate,
    pdfPath: "verification/a63-sales-order-print-settings.pdf",
    screenshots: [`verification/playwright/${screenshot}`],
    checks: {
      frontendSaved: true,
      templateParamsPersisted: savedTemplate.paperSize === "A4" && savedTemplate.pageOrientation === "LANDSCAPE" && Number(savedTemplate.copyCount) === 3,
      htmlUsesPageSettings: html.includes("A4 landscape") && html.includes("8mm 10mm 12mm 14mm") && html.includes("第3联 / 共3联"),
      pdfUsesPageSettings: pdfText.includes("/Count 3") && pdfText.includes("/MediaBox [0 0 842 595]"),
      restoredDefault: restoredTemplate.pageOrientation === "PORTRAIT" && Number(restoredTemplate.copyCount) === 1
    }
  };
  await writeFile(resultPath, JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
} finally {
  await browser.close();
}
