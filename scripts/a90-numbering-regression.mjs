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

function seq(billNo, prefix) {
  return Number(billNo.slice(prefix.length));
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
  const preview = await api("/api/numbering/salesOrder/next", { method: "GET" });
  assert(/^XSDD\d{6}$/.test(preview.billNo), `sales order preview should be XSDD000001 style, got ${preview.billNo}`);

  const first = await api("/api/sales-orders/draft", { body: salesOrderPayload("") });
  const second = await api("/api/sales-orders/draft", { body: salesOrderPayload("") });
  await api(`/api/sales-orders/${encodeURIComponent(first.billNo)}/audit`);
  const collision = await api("/api/sales-orders/draft", { body: salesOrderPayload(first.billNo) });

  assert(/^XSDD\d{6}$/.test(first.billNo), `first sales order bill no format invalid: ${first.billNo}`);
  assert(/^XSDD\d{6}$/.test(second.billNo), `second sales order bill no format invalid: ${second.billNo}`);
  assert(/^XSDD\d{6}$/.test(collision.billNo), `collision fallback bill no format invalid: ${collision.billNo}`);
  assert(seq(second.billNo, "XSDD") === seq(first.billNo, "XSDD") + 1, `sales order sequence should increment: ${first.billNo}, ${second.billNo}`);
  assert(collision.billNo !== first.billNo, `collision fallback should not reuse ${first.billNo}`);

  return { preview: preview.billNo, first: first.billNo, second: second.billNo, collision: collision.billNo };
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
    await page.getByTestId("new-document").click();
    await page.waitForFunction(() => {
      const input = document.querySelector('[data-testid="sales-out-bill-no"]');
      return input instanceof HTMLInputElement && /^XSCKD\d{6}$/.test(input.value);
    });
    const billNo = await page.getByTestId("sales-out-bill-no").inputValue();
    const sourceOrderNo = await page.getByTestId("sales-out-source-order-no").inputValue();
    const partyCode = await page.getByTestId("sales-out-party-code").inputValue();
    await page.screenshot({ path: path.join(screenshotDir, shot), fullPage: true });

    assert(/^XSCKD\d{6}$/.test(billNo), `sales out bill no format invalid: ${billNo}`);
    assert(sourceOrderNo === "", `direct sales out source order should be empty, got ${sourceOrderNo}`);
    assert(partyCode === "", `direct sales out customer should be empty, got ${partyCode}`);

    return { billNo, sourceOrderNo, partyCode, screenshot: `verification/playwright/${shot}` };
  } finally {
    await browser.close();
  }
}

const backend = await verifyBackendNumbering();
const salesOutDirect = await verifyDirectSalesOutNewForm();

const result = {
  batch,
  generatedAt: new Date().toISOString(),
  ok: true,
  backend,
  salesOutDirect,
  expectedFormat: "fixed prefix + 6-digit zero-padded sequence without hyphen"
};

await writeFile(resultPath, JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));
