import { chromium } from "playwright";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { installApiSession, loginAsAdmin } from "./helpers/regression-auth.mjs";

const rootDir = path.resolve(import.meta.dirname, "..");
const verificationDir = path.join(rootDir, "verification");
const screenshotDir = path.join(verificationDir, "playwright");
const resultPath = path.join(verificationDir, "a48-print-template-copy-regression.json");
const frontendUrl = "http://127.0.0.1:5173/";
const apiBase = "http://127.0.0.1:8080";
await installApiSession(apiBase);
const batch = new Date().toISOString().replace(/\D/g, "").slice(0, 14);
const billDate = "2026-06-24";
let billNo = "";
const customTemplate = {
  templateName: `A48销售副本-${batch}`,
  companyName: `A48模板公司-${batch}`,
  headerNote: `A48副本页眉-${batch}`,
  footerNote: `A48副本页脚-${batch}`,
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
const managedRoleCodes = new Set(["", "ADMIN"]);
const templateFields = [
  "documentType", "templateCode", "templateName", "roleCode", "companyName", "headerNote", "footerNote",
  "showSignature", "showSeal", "isDefault", "paperSize", "pageOrientation", "marginTopMm", "marginRightMm",
  "marginBottomMm", "marginLeftMm", "copyCount", "enabled"
];
const lines = [
  { productCode: "CP-001", warehouseCode: "CK-001", qty: 2, unitPrice: 10, lineRemark: "A48 模板副本第一行" },
  { productCode: "PJ-014", warehouseCode: "CK-002", qty: 3, unitPrice: 6, lineRemark: "A48 模板副本第二行" },
  { productCode: "CP-T413874", warehouseCode: "CK-003", qty: 4, unitPrice: 12, lineRemark: "A48 模板副本第三行" }
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

function generatedSalesOrderNo(row, label) {
  const value = String(row?.billNo ?? "");
  assert(/^XSDD\d{6}$/.test(value), `${label} should return a system sales order number, got ${JSON.stringify(row)}`);
  return value;
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

async function listPrintTemplates() {
  return requireJson("/api/documents/print-templates");
}

function templateRequest(template, isDefault = template.isDefault) {
  return {
    templateCode: template.templateCode,
    templateName: template.templateName,
    roleCode: template.roleCode || "",
    companyName: template.companyName,
    headerNote: template.headerNote,
    footerNote: template.footerNote,
    showSignature: template.showSignature,
    showSeal: template.showSeal,
    isDefault,
    paperSize: template.paperSize,
    pageOrientation: template.pageOrientation,
    marginTopMm: template.marginTopMm,
    marginRightMm: template.marginRightMm,
    marginBottomMm: template.marginBottomMm,
    marginLeftMm: template.marginLeftMm,
    copyCount: template.copyCount
  };
}

async function saveTemplate(template, isDefault = template.isDefault) {
  return requireJson("/api/documents/sales-order/print-template", {
    method: "PUT",
    body: templateRequest(template, isDefault)
  });
}

async function captureTemplateSnapshot() {
  const templates = await listPrintTemplates();
  const snapshot = templates.filter((template) =>
    template.documentType === "sales-order"
      && (template.templateCode === "STANDARD" || (template.isDefault && managedRoleCodes.has(template.roleCode || "")))
  );
  assert(snapshot.some((template) => template.templateCode === "STANDARD"), "sales-order STANDARD template should exist before A48");
  return snapshot;
}

async function demoteManagedDefaults() {
  const templates = await listPrintTemplates();
  for (const template of templates.filter((item) =>
    item.documentType === "sales-order" && item.isDefault && managedRoleCodes.has(item.roleCode || "")
  )) {
    await saveTemplate(template, false);
  }
}

async function establishKnownBaseline() {
  await demoteManagedDefaults();
  await requireJson("/api/documents/sales-order/print-template", { method: "PUT", body: defaultTemplate });
}

function comparableTemplate(template) {
  return Object.fromEntries(templateFields.map((field) => [field, template[field]]));
}

function defaultSignatures(templates) {
  return templates
    .filter((template) => template.documentType === "sales-order" && template.isDefault && managedRoleCodes.has(template.roleCode || ""))
    .map((template) => `${template.roleCode || "GENERAL"}|${template.templateCode}`)
    .sort();
}

async function restoreTemplateSnapshot(snapshot) {
  await demoteManagedDefaults();
  for (const template of snapshot) {
    await saveTemplate(template, false);
  }
  for (const template of snapshot.filter((item) => item.isDefault)) {
    await saveTemplate(template, true);
  }
  const restored = await listPrintTemplates();
  for (const expected of snapshot) {
    const actual = restored.find((item) => item.documentType === expected.documentType && item.templateCode === expected.templateCode);
    assert(actual, `${expected.templateCode} should exist after A48 cleanup`);
    assert(JSON.stringify(comparableTemplate(actual)) === JSON.stringify(comparableTemplate(expected)), `${expected.templateCode} should be restored exactly after A48`);
  }
  assert(JSON.stringify(defaultSignatures(restored)) === JSON.stringify(defaultSignatures(snapshot)), "A48 GENERAL/ADMIN defaults should match the pre-run snapshot");
}

async function finishCleanup(primaryError, cleanupTasks) {
  const cleanupErrors = [];
  for (const task of cleanupTasks) {
    try {
      await task();
    } catch (error) {
      cleanupErrors.push(error);
    }
  }
  if (cleanupErrors.length === 0) {
    return;
  }
  if (primaryError) {
    for (const error of cleanupErrors) {
      console.error(`A48 cleanup failed after primary error: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
    }
    return;
  }
  throw cleanupErrors[0];
}

async function createSalesOrder() {
  const saved = await requireJson("/api/sales-orders/draft", {
    method: "POST",
    body: {
      billNo: null,
      customerCode: "KH-001",
      billDate,
      department: "销售部",
      ownerName: "本地管理员",
      lines
    }
  });
  billNo = generatedSalesOrderNo(saved, "A48 sales order");
  await requireJson(`/api/sales-orders/${encodeURIComponent(billNo)}/audit`, { method: "POST" });
}

const templateSnapshot = await captureTemplateSnapshot();
let primaryError;
let copiedTemplateCode;
let browser;
let screenshot;
let copiedTemplate;
let standardAfterCopy;
let html;
let pdfText;
try {
  await establishKnownBaseline();
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1366, height: 768 } });
  await page.goto(frontendUrl, { waitUntil: "networkidle" });
  await loginAsAdmin(page);
  await page.getByTestId("module-系统设置").hover();
  await page.getByTestId("entry-print-template-settings").click();
  await page.getByTestId("tab-print-template-settings").waitFor({ state: "visible" });
  await page.getByTestId("print-template-document-type").selectOption("sales-order");
  await page.getByTestId("print-template-code").selectOption("STANDARD");
  await page.getByTestId("print-template-role-code").selectOption("");
  await page.getByTestId("print-template-copy").click();
  await page.getByTestId("print-template-message").getByText("模板副本已保存").waitFor({ state: "visible" });
  copiedTemplateCode = await page.getByTestId("print-template-code").inputValue();
  assert(copiedTemplateCode.startsWith("COPY-"), "copied template code should be generated");

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
  screenshot = `a48-print-template-copy-${batch}.png`;
  await page.screenshot({ path: path.join(screenshotDir, screenshot), fullPage: true });

  const templatesAfterSave = await listPrintTemplates();
  copiedTemplate = templatesAfterSave.find((template) => template.documentType === "sales-order" && template.templateCode === copiedTemplateCode);
  standardAfterCopy = templatesAfterSave.find((template) => template.documentType === "sales-order" && template.templateCode === "STANDARD");
  assert(copiedTemplate, "copied template should exist in template list");
  assert(copiedTemplate.isDefault === true, "copied template should become default after save");
  assert(copiedTemplate.companyName === customTemplate.companyName, "copied template should save custom company");
  assert(standardAfterCopy && standardAfterCopy.isDefault === false, "STANDARD should no longer be default after copied template is set default");

  await createSalesOrder();
  html = await requireText(`/api/documents/sales-order/${encodeURIComponent(billNo)}/print.html`);
  assert(html.includes(customTemplate.companyName), "HTML should use copied default template company");
  assert(html.includes(customTemplate.templateName), "HTML should use copied default template name");
  assert(!html.includes("公司章"), "HTML should hide seal from copied default template");

  const pdfResponse = await request(`/api/documents/sales-order/${encodeURIComponent(billNo)}/print.pdf`);
  assert(pdfResponse.ok, `PDF endpoint failed ${pdfResponse.status}`);
  const pdfBytes = Buffer.from(await pdfResponse.arrayBuffer());
  pdfText = pdfBytes.toString("latin1");
  assert(pdfText.includes(utf16beHex(customTemplate.companyName)), "PDF should use copied default template company");
  assert(pdfText.includes(utf16beHex(customTemplate.templateName)), "PDF should use copied default template name");
  assert(!pdfText.includes(utf16beHex("公司章")), "PDF should hide seal from copied default template");
} catch (error) {
  primaryError = error;
  throw error;
} finally {
  await finishCleanup(primaryError, [
    async () => {
      if (browser) {
        await browser.close();
      }
    },
    () => restoreTemplateSnapshot(templateSnapshot)
  ]);
}

const restoredTemplate = await requireJson("/api/documents/sales-order/print-template");
const templatesAfterRestore = await listPrintTemplates();
const copiedAfterRestore = templatesAfterRestore.find((template) => template.documentType === "sales-order" && template.templateCode === copiedTemplateCode);
assert(copiedAfterRestore && copiedAfterRestore.isDefault === false, "copied template should be non-default after restoring the original snapshot");

const result = {
  batch,
  generatedAt: new Date().toISOString(),
  billNo,
  copiedTemplateCode,
  customTemplate,
  copiedTemplate,
  restoredTemplate,
  checks: {
    frontendCopied: true,
    copiedTemplatePersisted: Boolean(copiedTemplate),
    copiedTemplateBecameDefault: copiedTemplate?.isDefault === true,
    standardDemoted: standardAfterCopy?.isDefault === false,
    htmlUsesCopiedDefault: html.includes(customTemplate.companyName) && html.includes(customTemplate.templateName),
    pdfUsesCopiedDefault: pdfText.includes(utf16beHex(customTemplate.companyName)) && pdfText.includes(utf16beHex(customTemplate.templateName)),
    restoredOriginalDefaults: true,
    copiedTemplateDemoted: copiedAfterRestore?.isDefault === false
  },
  screenshots: [`verification/playwright/${screenshot}`]
};

await writeFile(resultPath, JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));
