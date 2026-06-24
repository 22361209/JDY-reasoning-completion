import { chromium } from "playwright";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const rootDir = path.resolve(import.meta.dirname, "..");
const verificationDir = path.join(rootDir, "verification");
const screenshotDir = path.join(verificationDir, "playwright");
const resultPath = path.join(verificationDir, "a47-print-template-settings-regression.json");
const frontendUrl = "http://127.0.0.1:5173/";
const apiBase = "http://127.0.0.1:8080";
const batch = new Date().toISOString().replace(/\D/g, "").slice(0, 14);
const billDate = "2026-06-24";
const billNo = `XSDD-A47-${batch}`;
const customTemplate = {
  templateCode: "STANDARD",
  templateName: `A47销售套打-${batch}`,
  companyName: `A47测试公司-${batch}`,
  headerNote: `A47页眉-${batch}`,
  footerNote: `A47页脚-${batch}`,
  showSignature: true,
  showSeal: false
};
const defaultTemplate = {
  templateCode: "STANDARD",
  templateName: "标准套打模板",
  companyName: "博莱德机械测试账套",
  headerNote: "会计期间 2026-06 / 业务期间 2026-06",
  footerNote: "本单据由 JDY 推理补完 ERP 生成，请按公司制度完成签字、盖章与归档。",
  showSignature: true,
  showSeal: true
};
const lines = [
  { productCode: "CP-001", warehouseCode: "CK-001", qty: 1, unitPrice: 10, lineRemark: "A47 打印模板备注" },
  { productCode: "PJ-014", warehouseCode: "CK-002", qty: 2, unitPrice: 5, lineRemark: "A47 第二行" },
  { productCode: "CP-T413874", warehouseCode: "CK-T413874", qty: 3, unitPrice: 30, lineRemark: "A47 第三行" }
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

async function restoreDefaultTemplate() {
  return requireJson("/api/documents/sales-order/print-template", {
    method: "PUT",
    body: defaultTemplate
  });
}

async function createSalesOrder() {
  await requireJson("/api/sales-orders/draft", {
    method: "POST",
    body: {
      billNo,
      customerCode: "KH-001",
      billDate,
      department: "销售部",
      ownerName: "本地管理员",
      lines
    }
  });
  await requireJson(`/api/sales-orders/${encodeURIComponent(billNo)}/audit`, { method: "POST" });
}

await restoreDefaultTemplate();

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1366, height: 768 } });
let screenshot;
try {
  await page.goto(frontendUrl, { waitUntil: "networkidle" });
  await page.getByTestId("module-系统设置").hover();
  await page.getByTestId("entry-print-template-settings").click();
  await page.getByTestId("tab-print-template-settings").waitFor({ state: "visible" });
  await page.getByTestId("print-template-document-type").selectOption("sales-order");
  await page.getByTestId("print-template-name").fill(customTemplate.templateName);
  await page.getByTestId("print-template-company").fill(customTemplate.companyName);
  await page.getByTestId("print-template-header-note").fill(customTemplate.headerNote);
  await page.getByTestId("print-template-footer-note").fill(customTemplate.footerNote);
  const sealCheckbox = page.getByTestId("print-template-show-seal");
  if (await sealCheckbox.isChecked()) {
    await sealCheckbox.uncheck();
  }
  await page.getByTestId("print-template-save").click();
  await page.getByTestId("print-template-message").getByText("打印模板已保存").waitFor({ state: "visible" });
  screenshot = `a47-print-template-settings-${batch}.png`;
  await page.screenshot({ path: path.join(screenshotDir, screenshot), fullPage: true });
} finally {
  await browser.close();
}

const savedTemplate = await requireJson("/api/documents/sales-order/print-template");
assert(savedTemplate.companyName === customTemplate.companyName, "backend template should save company name");
assert(savedTemplate.templateName === customTemplate.templateName, "backend template should save template name");
assert(savedTemplate.footerNote === customTemplate.footerNote, "backend template should save footer note");
assert(savedTemplate.showSeal === false, "backend template should save seal switch");

await createSalesOrder();
const html = await requireText(`/api/documents/sales-order/${encodeURIComponent(billNo)}/print.html`);
assert(html.includes(customTemplate.companyName), "HTML should include custom company name");
assert(html.includes(customTemplate.templateName), "HTML should include custom template name");
assert(html.includes(customTemplate.footerNote), "HTML should include custom footer note");
assert(!html.includes("公司章"), "HTML should hide seal when switch is off");

const pdfResponse = await request(`/api/documents/sales-order/${encodeURIComponent(billNo)}/print.pdf`);
assert(pdfResponse.ok, `PDF endpoint failed ${pdfResponse.status}`);
const pdfBytes = Buffer.from(await pdfResponse.arrayBuffer());
const pdfText = pdfBytes.toString("latin1");
assert(pdfText.includes(utf16beHex(customTemplate.companyName)), "PDF should include custom company name");
assert(pdfText.includes(utf16beHex(customTemplate.templateName)), "PDF should include custom template name");
assert(pdfText.includes(utf16beHex(customTemplate.footerNote)), "PDF should include custom footer note");
assert(!pdfText.includes(utf16beHex("公司章")), "PDF should hide seal when switch is off");

const restoredTemplate = await restoreDefaultTemplate();
assert(restoredTemplate.companyName === defaultTemplate.companyName, "default template should be restored");
assert(restoredTemplate.showSeal === true, "default seal switch should be restored");

const result = {
  batch,
  generatedAt: new Date().toISOString(),
  billNo,
  customTemplate,
  savedTemplate,
  restoredTemplate,
  checks: {
    frontendSaved: true,
    backendSavedCompany: savedTemplate.companyName === customTemplate.companyName,
    htmlUsesCustomTemplate: html.includes(customTemplate.companyName) && html.includes(customTemplate.footerNote),
    pdfUsesCustomTemplate: pdfText.includes(utf16beHex(customTemplate.companyName)) && pdfText.includes(utf16beHex(customTemplate.footerNote)),
    sealHiddenInHtmlAndPdf: !html.includes("公司章") && !pdfText.includes(utf16beHex("公司章")),
    restoredDefault: restoredTemplate.companyName === defaultTemplate.companyName && restoredTemplate.showSeal === true
  },
  screenshots: [`verification/playwright/${screenshot}`]
};

await writeFile(resultPath, JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));
