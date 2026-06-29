import { chromium } from "playwright";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const rootDir = path.resolve(import.meta.dirname, "..");
const verificationDir = path.join(rootDir, "verification");
const screenshotDir = path.join(verificationDir, "playwright");
const resultPath = path.join(verificationDir, "a57-session-user-switch-regression.json");
const frontendUrl = "http://127.0.0.1:5173/";
const batch = new Date().toISOString().replace(/\D/g, "").slice(0, 14);
const billNo = `A57-XSDD-${batch}`;

await mkdir(screenshotDir, { recursive: true });

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
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

async function loginAs(page, username, password, expectedRole) {
  await page.getByTestId("login-page").waitFor({ state: "visible" });
  await page.getByTestId("login-username").fill(username);
  await page.getByTestId("login-password").fill(password);
  await page.getByTestId("login-submit").click();
  await page.getByTestId("session-user-role").filter({ hasText: expectedRole }).waitFor({ state: "visible" });
}

async function logout(page) {
  await page.getByTestId("session-logout").click();
  await page.getByTestId("login-page").waitFor({ state: "visible" });
}

const browser = await chromium.launch({ headless: true });
let screenshot = "";
try {
  const page = await browser.newPage({ viewport: { width: 1366, height: 768 } });
  await page.goto(frontendUrl, { waitUntil: "networkidle" });
  await loginAs(page, "admin", "admin123", "系统管理员");

  const draftResponse = await browserFetch(page, "/api/sales-orders/draft", {
    method: "POST",
    body: {
      billNo,
      customerCode: "KH-001",
      billDate: "2026-06-24",
      department: "销售部",
      ownerName: "A57 正式登录权限回归",
      lines: [
        { productCode: "CP-001", warehouseCode: "CK-001", qty: 1, unitPrice: 12, lineRemark: "正式登录草稿" }
      ]
    }
  });
  assert(draftResponse.status >= 200 && draftResponse.status < 300, `admin should create sales order draft, got ${draftResponse.status}`);

  await logout(page);
  await loginAs(page, "warehouse", "warehouse123", "仓库员");

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

  await logout(page);
  await loginAs(page, "admin", "admin123", "系统管理员");
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
    loginFlow: "formal-login",
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
