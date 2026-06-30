import { chromium } from "playwright";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { loginAs as sharedLoginAs, logout as sharedLogout, openPasswordChange } from "./helpers/regression-auth.mjs";

const rootDir = path.resolve(import.meta.dirname, "..");
const verificationDir = path.join(rootDir, "verification");
const screenshotDir = path.join(verificationDir, "playwright");
const resultPath = path.join(verificationDir, "a65-password-reset-request-regression.json");
const frontendUrl = "http://127.0.0.1:5173/";
const batch = new Date().toISOString().replace(/\D/g, "").slice(0, 14);
const suffix = batch.slice(8);
const username = `a65u${suffix}`;
const oldPassword = `A65-Old-${suffix}!`;
const newPassword = `A65-New-${suffix}!`;

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

async function loginAs(page, usernameValue, passwordValue, expectedRole) {
  await sharedLoginAs(page, usernameValue, passwordValue, expectedRole);
}

const browser = await chromium.launch({ headless: true });
let requestScreenshot = "";
let adminScreenshot = "";
let loginScreenshot = "";
try {
  const page = await browser.newPage({ viewport: { width: 1366, height: 768 } });
  await page.goto(frontendUrl, { waitUntil: "networkidle" });

  await loginAs(page, "admin", "admin123", "系统管理员");
  const createUser = await browserFetch(page, "/api/system/managed-users", {
    method: "POST",
    body: {
      username,
      displayName: "A65 找回员工",
      roleCode: "WAREHOUSE",
      password: oldPassword,
      enabled: true
    }
  });
  assert(createUser.status === 200, `admin should create A65 user, got ${createUser.status}: ${createUser.text}`);

  await sharedLogout(page);
  await page.reload({ waitUntil: "networkidle" });

  await page.getByTestId("login-username").fill(username);
  await page.getByTestId("forgot-password-open").click();
  await page.getByTestId("password-reset-request-dialog").waitFor({ state: "visible" });
  await page.getByTestId("password-reset-contact").fill("A65 电话核验 13800000000");
  await page.getByTestId("password-reset-submit").click();
  await page.getByTestId("password-reset-message").filter({ hasText: "已提交找回申请" }).waitFor({ state: "visible" });
  requestScreenshot = `a65-password-reset-request-submitted-${batch}.png`;
  await page.screenshot({ path: path.join(screenshotDir, requestScreenshot), fullPage: true });
  await page.getByTestId("password-reset-cancel").click();

  await loginAs(page, "admin", "admin123", "系统管理员");
  await page.getByTestId("module-系统设置").hover();
  await page.getByTestId("entry-user-role-list").click();
  await page.getByTestId("password-reset-admin-panel").waitFor({ state: "visible" });
  await page.getByTestId(`password-reset-request-${username}`).click();
  await page.getByTestId("password-reset-selected").waitFor({ state: "visible" });
  await page.getByTestId("managed-user-password").fill(newPassword);
  await page.getByTestId("managed-user-reset-password").click();
  await page.getByTestId("user-management-message").filter({ hasText: "密码已重置" }).waitFor({ state: "visible" });
  await page.getByTestId(`password-reset-request-${username}`).waitFor({ state: "detached" });
  adminScreenshot = `a65-password-reset-admin-handled-${batch}.png`;
  await page.screenshot({ path: path.join(screenshotDir, adminScreenshot), fullPage: true });

  const managedUsers = await browserFetch(page, "/api/system/managed-users");
  assert(managedUsers.status === 200, `managed-users should load after reset, got ${managedUsers.status}`);
  const managedPayload = JSON.parse(managedUsers.text);
  const targetUser = (managedPayload.users ?? []).find((user) => user.username === username);
  assert(targetUser && targetUser.pendingPasswordReset === false, "target user should no longer have a pending password reset");
  const pendingRequests = (managedPayload.passwordResetRequests ?? []).filter((request) => request.username === username && request.status === "PENDING");
  assert(pendingRequests.length === 0, `expected no pending reset request, got ${pendingRequests.length}`);

  const logResponse = await browserFetch(page, `/api/lists/operation-log-list?keyword=${encodeURIComponent(username)}&page=1&pageSize=200`);
  assert(logResponse.status === 200, `operation log list should load, got ${logResponse.status}`);
  const logPayload = JSON.parse(logResponse.text);
  const rows = logPayload.rows ?? [];
  const requestLogs = rows.filter((row) => row.action === "PASSWORD_RESET_REQUEST" && row.status === "成功");
  const resetLogs = rows.filter((row) => row.action === "RESET_PASSWORD" && row.status === "成功");
  assert(requestLogs.length >= 1, `expected password reset request audit log, got ${requestLogs.length}`);
  assert(resetLogs.length >= 1, `expected reset password audit log, got ${resetLogs.length}`);

  await sharedLogout(page);
  await page.getByTestId("login-username").fill(username);
  await page.getByTestId("login-password").fill(newPassword);
  await page.getByTestId("login-submit").click();
  await page.getByTestId("session-user-role").filter({ hasText: "仓库员" }).waitFor({ state: "visible" });
  loginScreenshot = `a65-password-reset-new-login-${batch}.png`;
  await page.screenshot({ path: path.join(screenshotDir, loginScreenshot), fullPage: true });

  const result = {
    batch,
    generatedAt: new Date().toISOString(),
    username,
    pendingRequestsAfterReset: pendingRequests.length,
    requestAuditRows: requestLogs.length,
    resetAuditRows: resetLogs.length,
    screenshots: [
      `verification/playwright/${requestScreenshot}`,
      `verification/playwright/${adminScreenshot}`,
      `verification/playwright/${loginScreenshot}`
    ]
  };
  await writeFile(resultPath, JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
} finally {
  await browser.close();
}
