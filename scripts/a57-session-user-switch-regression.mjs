import { chromium } from "playwright";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const rootDir = path.resolve(import.meta.dirname, "..");
const verificationDir = path.join(rootDir, "verification");
const screenshotDir = path.join(verificationDir, "playwright");
const resultPath = path.join(verificationDir, "a57-session-user-switch-regression.json");
const frontendUrl = "http://127.0.0.1:5173/";
const apiBase = "http://127.0.0.1:8080";
const batch = new Date().toISOString().replace(/\D/g, "").slice(0, 14);
const billNo = `A57-XSDD-${batch}`;

await mkdir(screenshotDir, { recursive: true });

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

async function request(pathname, options = {}) {
  const response = await fetch(`${apiBase}${pathname}`, {
    method: options.method ?? "GET",
    headers: options.body ? { "Content-Type": "application/json" } : undefined,
    body: options.body ? JSON.stringify(options.body) : undefined
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`${options.method ?? "GET"} ${pathname} failed ${response.status}: ${text}`);
  }
  return text ? JSON.parse(text) : {};
}

async function browserFetch(page, pathname, options = {}) {
  return page.evaluate(async ({ pathname, options }) => {
    const response = await fetch(pathname, {
      method: options.method ?? "GET",
      headers: options.body ? { "Content-Type": "application/json" } : undefined,
      body: options.body ? JSON.stringify(options.body) : undefined
    });
    return {
      status: response.status,
      ok: response.ok,
      text: await response.text()
    };
  }, { pathname, options });
}

await request("/api/sales-orders/draft", {
  method: "POST",
  body: {
    billNo,
    customerCode: "KH-001",
    billDate: "2026-06-24",
    department: "销售部",
    ownerName: "A57 会话权限回归",
    lines: [
      { productCode: "CP-001", warehouseCode: "CK-001", qty: 1, unitPrice: 12, lineRemark: "会话切换草稿" }
    ]
  }
});

const browser = await chromium.launch({ headless: true });
let screenshot = "";
try {
  const page = await browser.newPage({ viewport: { width: 1366, height: 768 } });
  await page.goto(frontendUrl, { waitUntil: "networkidle" });
  await page.getByTestId("session-user-select").selectOption("warehouse");
  await page.getByTestId("session-switch").click();
  await page.getByTestId("session-user-role").filter({ hasText: "仓库员" }).waitFor({ state: "visible" });

  const warehouseSession = await browserFetch(page, "/api/system/session");
  assert(warehouseSession.status === 200, "warehouse session should load");
  const warehousePayload = JSON.parse(warehouseSession.text);
  assert(warehousePayload.user.username === "warehouse", "browser session should switch to warehouse");
  assert(warehousePayload.user.roleCode === "WAREHOUSE", "warehouse role code should be WAREHOUSE");
  assert(!warehousePayload.user.permissionCodes.includes("sales.order.audit"), "warehouse should not have sales.order.audit");

  await page.getByTestId("module-销售管理").hover();
  await page.getByTestId("entry-sales-out-form").waitFor({ state: "visible" });
  await page.getByTestId("entry-sales-order-form").waitFor({ state: "detached" });

  const blockedAudit = await browserFetch(page, `/api/sales-orders/${encodeURIComponent(billNo)}/audit`, { method: "POST" });
  assert(blockedAudit.status === 403, `warehouse direct sales order audit should be 403, got ${blockedAudit.status}`);

  await page.getByTestId("session-user-select").selectOption("admin");
  await page.getByTestId("session-switch").click();
  await page.getByTestId("session-user-role").filter({ hasText: "系统管理员" }).waitFor({ state: "visible" });
  await page.getByTestId("module-销售管理").hover();
  await page.getByTestId("entry-sales-order-form").waitFor({ state: "visible" });

  const allowedAudit = await browserFetch(page, `/api/sales-orders/${encodeURIComponent(billNo)}/audit`, { method: "POST" });
  assert(allowedAudit.status === 200, `admin sales order audit should succeed, got ${allowedAudit.status}`);
  const auditedPayload = JSON.parse(allowedAudit.text);
  assert(auditedPayload.status === "AUDITED", "admin audit should return AUDITED");

  screenshot = `a57-session-user-switch-${batch}.png`;
  await page.screenshot({ path: path.join(screenshotDir, screenshot), fullPage: true });

  const result = {
    batch,
    generatedAt: new Date().toISOString(),
    billNo,
    warehouse: {
      username: warehousePayload.user.username,
      roleCode: warehousePayload.user.roleCode,
      permissionCount: warehousePayload.user.permissionCodes.length,
      blockedAuditStatus: blockedAudit.status
    },
    admin: {
      allowedAuditStatus: allowedAudit.status,
      auditedStatus: auditedPayload.status
    },
    screenshot: `verification/playwright/${screenshot}`
  };
  await writeFile(resultPath, JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
} finally {
  await browser.close();
}
