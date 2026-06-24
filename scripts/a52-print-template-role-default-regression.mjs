import { chromium } from "playwright";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { installApiSession, loginAsAdmin } from "./helpers/regression-auth.mjs";

const rootDir = path.resolve(import.meta.dirname, "..");
const verificationDir = path.join(rootDir, "verification");
const screenshotDir = path.join(verificationDir, "playwright");
const resultPath = path.join(verificationDir, "a52-print-template-role-default-regression.json");
const frontendUrl = "http://127.0.0.1:5173/";
const apiBase = "http://127.0.0.1:8080";
await installApiSession(apiBase);
const batch = new Date().toISOString().replace(/\D/g, "").slice(0, 14);
const billDate = "2026-06-24";
const billNo = `XSDD-A52-${batch}`;
const roleCode = "ADMIN";
const customTemplate = {
  templateName: `A52销售ADMIN模板-${batch}`,
  companyName: `A52角色模板公司-${batch}`,
  headerNote: `A52 ADMIN 专用页眉-${batch}`,
  footerNote: `A52 ADMIN 专用页脚-${batch}`,
  showSignature: true,
  showSeal: false,
  isDefault: true
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
  isDefault: true
};
const lines = [
  { productCode: "CP-001", warehouseCode: "CK-001", qty: 2, unitPrice: 15, lineRemark: "A52 角色模板第一行" },
  { productCode: "PJ-014", warehouseCode: "CK-002", qty: 3, unitPrice: 8, lineRemark: "A52 角色模板第二行" },
  { productCode: "CP-T413874", warehouseCode: "CK-T413874", qty: 4, unitPrice: 20, lineRemark: "A52 角色模板第三行" }
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

async function demoteRoleTemplate(templateCode) {
  if (!templateCode) {
    return null;
  }
  return requireJson("/api/documents/sales-order/print-template", {
    method: "PUT",
    body: {
      templateCode,
      roleCode,
      ...customTemplate,
      isDefault: false
    }
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
let copiedTemplateCode;
try {
  await page.goto(frontendUrl, { waitUntil: "networkidle" });
  await loginAsAdmin(page);
  await page.getByTestId("module-系统设置").hover();
  await page.getByTestId("entry-print-template-settings").click();
  await page.getByTestId("tab-print-template-settings").waitFor({ state: "visible" });
  await page.getByTestId("print-template-document-type").selectOption("sales-order");
  await page.getByTestId("print-template-copy").click();
  await page.getByTestId("print-template-message").getByText("模板副本已保存").waitFor({ state: "visible" });
  copiedTemplateCode = await page.getByTestId("print-template-code").inputValue();
  assert(copiedTemplateCode.startsWith("COPY-"), "copied template code should be generated");

  await page.getByTestId("print-template-role-code").selectOption(roleCode);
  await page.getByTestId("print-template-name").fill(customTemplate.templateName);
  await page.getByTestId("print-template-company").fill(customTemplate.companyName);
  await page.getByTestId("print-template-header-note").fill(customTemplate.headerNote);
  await page.getByTestId("print-template-footer-note").fill(customTemplate.footerNote);
  const sealCheckbox = page.getByTestId("print-template-show-seal");
  if (await sealCheckbox.isChecked()) {
    await sealCheckbox.uncheck();
  }
  const defaultCheckbox = page.getByTestId("print-template-is-default");
  if (!(await defaultCheckbox.isChecked())) {
    await defaultCheckbox.check();
  }
  await page.getByTestId("print-template-save").click();
  await page.getByTestId("print-template-message").getByText("打印模板已保存").waitFor({ state: "visible" });
  await page.getByTestId("print-template-code").locator("option", { hasText: `${customTemplate.templateName}（${roleCode}）（默认）` }).waitFor({ state: "attached" });
  screenshot = `a52-print-template-role-default-${batch}.png`;
  await page.screenshot({ path: path.join(screenshotDir, screenshot), fullPage: true });
} finally {
  await browser.close();
}

const roleDefault = await requireJson("/api/documents/sales-order/print-template");
assert(roleDefault.templateCode === copiedTemplateCode, "print-template API should return ADMIN role default");
assert(roleDefault.roleCode === roleCode, "print-template API should expose ADMIN role code");
assert(roleDefault.companyName === customTemplate.companyName, "ADMIN role default should use custom company");

await createSalesOrder();
const html = await requireText(`/api/documents/sales-order/${encodeURIComponent(billNo)}/print.html`);
assert(html.includes(customTemplate.companyName), "HTML should use ADMIN role template company");
assert(html.includes(customTemplate.templateName), "HTML should use ADMIN role template name");
assert(!html.includes("公司章"), "HTML should hide seal from ADMIN role template");

const pdfResponse = await request(`/api/documents/sales-order/${encodeURIComponent(billNo)}/print.pdf`);
assert(pdfResponse.ok, `PDF endpoint failed ${pdfResponse.status}`);
const pdfBytes = Buffer.from(await pdfResponse.arrayBuffer());
const pdfText = pdfBytes.toString("latin1");
assert(pdfText.includes(utf16beHex(customTemplate.companyName)), "PDF should use ADMIN role template company");
assert(pdfText.includes(utf16beHex(customTemplate.templateName)), "PDF should use ADMIN role template name");
assert(!pdfText.includes(utf16beHex("公司章")), "PDF should hide seal from ADMIN role template");

const demotedRoleTemplate = await demoteRoleTemplate(copiedTemplateCode);
const restoredTemplate = await restoreDefaultTemplate();
const restoredDefault = await requireJson("/api/documents/sales-order/print-template");
assert(restoredDefault.templateCode === "STANDARD", "STANDARD should win after ADMIN role template is demoted");
assert(restoredDefault.roleCode === "", "restored default should be general");

const result = {
  batch,
  generatedAt: new Date().toISOString(),
  billNo,
  roleCode,
  copiedTemplateCode,
  customTemplate,
  roleDefault,
  demotedRoleTemplate,
  restoredTemplate,
  restoredDefault,
  checks: {
    frontendSavedRoleDefault: true,
    apiReturnsRoleDefault: roleDefault.templateCode === copiedTemplateCode && roleDefault.roleCode === roleCode,
    htmlUsesRoleDefault: html.includes(customTemplate.companyName) && html.includes(customTemplate.templateName),
    pdfUsesRoleDefault: pdfText.includes(utf16beHex(customTemplate.companyName)) && pdfText.includes(utf16beHex(customTemplate.templateName)),
    restoredGeneralDefault: restoredDefault.templateCode === "STANDARD" && restoredDefault.roleCode === ""
  },
  screenshots: [`verification/playwright/${screenshot}`]
};

await writeFile(resultPath, JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));
