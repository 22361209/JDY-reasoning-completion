import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";
import { installApiSession, loginAsAdmin } from "./helpers/regression-auth.mjs";

const rootDir = path.resolve(import.meta.dirname, "..");
const screenshotDir = path.join(rootDir, "verification/playwright");
const resultPath = path.join(rootDir, "verification/a90-numbering-regression.json");
const frontendUrl = "http://127.0.0.1:5173/";
const apiBase = "http://127.0.0.1:8080";
const batch = new Date().toISOString().replace(/\D/g, "").slice(0, 14);
const billDate = "2026-06-26";

await installApiSession(apiBase);
await mkdir(screenshotDir, { recursive: true });
await mkdir(path.dirname(resultPath), { recursive: true });

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

async function api(pathname, options = {}) {
  const response = await fetch(`${apiBase}${pathname}`, {
    method: options.method ?? "POST",
    headers: options.body ? { "Content-Type": "application/json" } : undefined,
    body: options.body ? JSON.stringify(options.body) : undefined
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`${options.method ?? "POST"} ${pathname} failed ${response.status}: ${text}`);
  }
  return text ? JSON.parse(text) : null;
}

async function apiStatus(pathname, options = {}) {
  const response = await fetch(`${apiBase}${pathname}`, {
    method: options.method ?? "POST",
    headers: options.body ? { "Content-Type": "application/json" } : undefined,
    body: options.body ? JSON.stringify(options.body) : undefined
  });
  return { status: response.status, text: await response.text() };
}

function seq(billNo, prefix) {
  return Number(billNo.slice(prefix.length));
}

async function clickNewDocument(page, { confirmUnsaved = false } = {}) {
  await page.getByTestId("new-document").click();
  const dialog = page.getByTestId("new-document-unsaved-dialog");
  if (await dialog.isVisible().catch(() => false)) {
    if (!confirmUnsaved) {
      throw new Error("Unexpected unsaved-new dialog");
    }
    await page.getByTestId("new-document-unsaved-confirm").click();
    await dialog.waitFor({ state: "hidden" });
  }
}

function salesOrderPayload(billNo) {
  return {
    billNo,
    customerCode: "KH-001",
    billDate,
    department: "销售部",
    ownerName: "本地管理员",
    lines: [{ productCode: "CP-001", warehouseCode: "CK-001", qty: 1, unitPrice: 86, lineRemark: `A90编号-${batch}` }]
  };
}

async function verifyBackendNumbering() {
  const preview = await apiStatus("/api/numbering/salesOrder/next", { method: "GET" });
  assert(preview.status === 410, `sales order next-number preview should be disabled, got ${preview.status}: ${preview.text}`);

  const first = await api("/api/sales-orders/draft", { body: salesOrderPayload("") });
  const second = await api("/api/sales-orders/draft", { body: salesOrderPayload("") });
  await api(`/api/sales-orders/${encodeURIComponent(first.billNo)}/audit`);
  const collision = await apiStatus("/api/sales-orders/draft", { body: salesOrderPayload(first.billNo) });
  const manual = await apiStatus("/api/sales-orders/draft", { body: salesOrderPayload(`MANUAL-${batch}`) });
  const deleteCandidate = await api("/api/sales-orders/draft", { body: salesOrderPayload("") });
  await api(`/api/sales-orders/${encodeURIComponent(deleteCandidate.billNo)}`, { method: "DELETE" });
  const afterDelete = await api("/api/sales-orders/draft", { body: salesOrderPayload("") });

  assert(/^XSDD\d{6}$/.test(first.billNo), `first sales order bill no format invalid: ${first.billNo}`);
  assert(/^XSDD\d{6}$/.test(second.billNo), `second sales order bill no format invalid: ${second.billNo}`);
  assert(/^XSDD\d{6}$/.test(deleteCandidate.billNo), `delete candidate bill no format invalid: ${deleteCandidate.billNo}`);
  assert(/^XSDD\d{6}$/.test(afterDelete.billNo), `after delete bill no format invalid: ${afterDelete.billNo}`);
  assert(seq(second.billNo, "XSDD") === seq(first.billNo, "XSDD") + 1, `sales order sequence should increment: ${first.billNo}, ${second.billNo}`);
  assert(collision.status === 409, `saving over audited bill no should be rejected, got ${collision.status}`);
  assert(manual.status === 409, `manual bill no should be rejected, got ${manual.status}`);
  assert(afterDelete.billNo !== deleteCandidate.billNo, `numbering should not reuse deleted draft ${deleteCandidate.billNo}`);
  assert(seq(afterDelete.billNo, "XSDD") > seq(deleteCandidate.billNo, "XSDD"), `numbering should advance after deleting ${deleteCandidate.billNo}, got ${afterDelete.billNo}`);

  return { previewStatus: preview.status, first: first.billNo, second: second.billNo, collisionStatus: collision.status, manualStatus: manual.status, deleteCandidate: deleteCandidate.billNo, afterDelete: afterDelete.billNo };
}

async function verifyDirectSalesOutNewForm() {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1366, height: 768 } });
  const shot = `a90-sales-out-direct-new-${batch}.png`;
  try {
    await page.goto(frontendUrl, { waitUntil: "networkidle" });
    await loginAsAdmin(page);
    await page.getByTestId("module-销售管理").hover();
    await page.getByTestId("entry-sales-out-form").click();
    await page.getByTestId("tab-sales-out-form").waitFor({ state: "visible" });
    await clickNewDocument(page, { confirmUnsaved: true });
    await page.getByTestId("sales-out-bill-no").waitFor({ state: "visible" });
    const billNo = await page.getByTestId("sales-out-bill-no").inputValue();
    const sourceOrderNo = await page.getByTestId("sales-out-source-order-no").count() === 0
      ? ""
      : await page.getByTestId("sales-out-source-order-no").inputValue();
    const partyCode = await page.getByTestId("sales-out-party-code").inputValue();
    const productCode = await page.getByTestId("sales-out-line-product").inputValue();
    const warehouseCode = await page.getByTestId("sales-out-line-warehouse").inputValue();
    const qty = await page.getByTestId("sales-out-line-qty").inputValue();
    const unitPrice = await page.getByTestId("sales-out-line-price").inputValue();
    await page.screenshot({ path: path.join(screenshotDir, shot), fullPage: true });

    assert(billNo === "", `sales out bill no should be blank before first save, got ${billNo}`);
    assert(sourceOrderNo === "", `direct sales out source order should be empty, got ${sourceOrderNo}`);
    assert(partyCode === "", `direct sales out customer should be empty, got ${partyCode}`);
    assert(productCode === "", `direct sales out first product should be blank, got ${productCode}`);
    assert(warehouseCode === "", `direct sales out first warehouse should be blank, got ${warehouseCode}`);
    assert(["", "0"].includes(qty), `direct sales out first qty should be blank/zero, got ${qty}`);
    assert(["", "0"].includes(unitPrice), `direct sales out first unit price should be blank/zero, got ${unitPrice}`);

    return { billNo, sourceOrderNo, partyCode, productCode, warehouseCode, qty, unitPrice, screenshot: `verification/playwright/${shot}` };
  } finally {
    await browser.close();
  }
}

async function verifySalesOrderNewFormBlankLine() {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1366, height: 768 } });
  const shot = `a90-sales-order-direct-new-${batch}.png`;
  try {
    await page.goto(frontendUrl, { waitUntil: "networkidle" });
    await loginAsAdmin(page);
    await page.getByTestId("module-销售管理").hover();
    await page.getByTestId("entry-sales-order-form").click();
    await page.getByTestId("tab-sales-order-form").waitFor({ state: "visible" });
    await clickNewDocument(page, { confirmUnsaved: true });
    await page.getByTestId("sales-bill-no").waitFor({ state: "visible" });
    const billNo = await page.getByTestId("sales-bill-no").inputValue();
    const productCode = await page.getByTestId("sales-line-product").inputValue();
    const warehouseCode = await page.getByTestId("sales-line-warehouse").inputValue();
    const qty = await page.getByTestId("sales-line-qty").inputValue();
    const unitPrice = await page.getByTestId("sales-line-price").inputValue();
    await page.getByTestId("sales-party-code").fill("KH-001");
    await page.getByTestId("new-document").click();
    const unsavedDialog = page.getByTestId("new-document-unsaved-dialog");
    await unsavedDialog.waitFor({ state: "visible" });
    await page.getByTestId("new-document-unsaved-cancel").click();
    await unsavedDialog.waitFor({ state: "hidden" });
    const partyAfterCancel = await page.getByTestId("sales-party-code").inputValue();
    await page.getByTestId("new-document").click();
    await unsavedDialog.waitFor({ state: "visible" });
    await page.getByTestId("new-document-unsaved-confirm").click();
    await unsavedDialog.waitFor({ state: "hidden" });
    await page.waitForFunction(() => {
      const input = document.querySelector('[data-testid="sales-bill-no"]');
      return input instanceof HTMLInputElement && input.value === "";
    });
    const billNoAfterConfirm = await page.getByTestId("sales-bill-no").inputValue();
    const partyAfterConfirm = await page.getByTestId("sales-party-code").inputValue();
    await page.screenshot({ path: path.join(screenshotDir, shot), fullPage: true });

    assert(productCode === "", `sales order first product should be blank, got ${productCode}`);
    assert(warehouseCode === "", `sales order first warehouse should be blank, got ${warehouseCode}`);
    assert(["", "0"].includes(qty), `sales order first qty should be blank/zero, got ${qty}`);
    assert(["", "0"].includes(unitPrice), `sales order first unit price should be blank/zero, got ${unitPrice}`);
    assert(partyAfterCancel === "KH-001", `canceling unsaved new should keep current form, got party ${partyAfterCancel}`);
    assert(billNo === "", `sales order bill no should be blank before first save, got ${billNo}`);
    assert(billNoAfterConfirm === "", `confirming unsaved new should keep bill no blank before save, got ${billNoAfterConfirm}`);
    assert(partyAfterConfirm === "", `confirming unsaved new should clear party, got ${partyAfterConfirm}`);

    return { billNo, productCode, warehouseCode, qty, unitPrice, partyAfterCancel, billNoAfterConfirm, partyAfterConfirm, screenshot: `verification/playwright/${shot}` };
  } finally {
    await browser.close();
  }
}

const backend = await verifyBackendNumbering();
const salesOutDirect = await verifyDirectSalesOutNewForm();
const salesOrderDirect = await verifySalesOrderNewFormBlankLine();

const result = {
  batch,
  generatedAt: new Date().toISOString(),
  ok: true,
  backend,
  salesOutDirect,
  salesOrderDirect,
  expectedFormat: "fixed prefix + 6-digit zero-padded sequence without hyphen"
};

await writeFile(resultPath, JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));
