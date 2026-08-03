import { chromium } from "playwright";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { loginAs as sharedLoginAs, logout as sharedLogout, openPasswordChange } from "./helpers/regression-auth.mjs";

const rootDir = path.resolve(import.meta.dirname, "..");
const verificationDir = path.join(rootDir, "verification");
const screenshotDir = path.join(verificationDir, "playwright");
const resultPath = path.join(verificationDir, "a73-password-reset-notification-outbox-regression.json");
const frontendUrl = "http://127.0.0.1:5173/";
const batch = new Date().toISOString().replace(/\D/g, "").slice(0, 14);
const suffix = batch.slice(8);
const resetUsername = `a73done${suffix}`;
const rejectUsername = `a73reject${suffix}`;
const oldPassword = `A73-Old-${suffix}!`;
const newPassword = `A73-New-${suffix}!`;

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

async function createUser(page, username, displayName) {
  const response = await browserFetch(page, "/api/system/managed-users", {
    method: "POST",
    body: {
      username,
      displayName,
      roleCode: "WAREHOUSE",
      password: oldPassword,
      enabled: true
    }
  });
  assert(response.status === 200, `admin should create ${username}, got ${response.status}: ${response.text}`);
}

async function submitResetRequest(page, username, contactNote) {
  await page.getByTestId("login-username").fill(username);
  await page.getByTestId("forgot-password-open").click();
  await page.getByTestId("password-reset-request-dialog").waitFor({ state: "visible" });
  await page.getByTestId("password-reset-contact").fill(contactNote);
  await page.getByTestId("password-reset-submit").click();
  await page.getByTestId("password-reset-message").filter({ hasText: "已提交找回申请" }).waitFor({ state: "visible" });
  await page.getByTestId("password-reset-cancel").click();
}

const browser = await chromium.launch({ headless: true });
let notificationScreenshot = "";
try {
  const page = await browser.newPage({ viewport: { width: 1366, height: 768 } });
  await page.goto(frontendUrl, { waitUntil: "networkidle" });

  await sharedLoginAs(page, "admin", "admin123", "系统管理员");
  await createUser(page, resetUsername, "A73 通知重置员工");
  await createUser(page, rejectUsername, "A73 通知驳回员工");

  await sharedLogout(page);
  await page.reload({ waitUntil: "networkidle" });

  await submitResetRequest(page, resetUsername, "A73 重置通知核验 13800000001");
  await submitResetRequest(page, rejectUsername, "A73 驳回通知核验 13800000002");

  await sharedLoginAs(page, "admin", "admin123", "系统管理员");
  await page.getByTestId("module-系统设置").hover();
  await page.getByTestId("entry-user-role-list").click();
  await page.getByTestId("password-reset-admin-panel").waitFor({ state: "visible" });

  await page.getByTestId(`password-reset-request-${resetUsername}`).click();
  await page.getByTestId("managed-user-password").fill(newPassword);
  await page.getByTestId("managed-user-reset-password").click();
  await page.getByTestId("user-management-message").filter({ hasText: "密码已重置" }).waitFor({ state: "visible" });

  await page.getByTestId(`password-reset-request-${rejectUsername}`).click();
  await page.getByTestId("password-reset-handle-note").fill("A73 身份核验未通过");
  await page.getByTestId("password-reset-reject").click();
  await page.getByTestId("user-management-message").filter({ hasText: "找回申请已驳回" }).waitFor({ state: "visible" });

  await page.getByTestId("password-reset-notification-panel").waitFor({ state: "visible" });
  await page.getByTestId(`password-reset-notice-${resetUsername}-PASSWORD_RESET_DONE`).waitFor({ state: "visible" });
  await page.getByTestId(`password-reset-notice-${rejectUsername}-PASSWORD_RESET_REJECTED`).waitFor({ state: "visible" });
  notificationScreenshot = `a73-password-reset-notification-outbox-${batch}.png`;
  await page.screenshot({ path: path.join(screenshotDir, notificationScreenshot), fullPage: true });

  const managedUsers = await browserFetch(page, "/api/system/managed-users");
  assert(managedUsers.status === 200, `managed-users should load, got ${managedUsers.status}: ${managedUsers.text}`);
  const managedPayload = JSON.parse(managedUsers.text);
  const notifications = managedPayload.notificationOutbox ?? [];
  const doneNotices = notifications.filter((notice) => notice.recipientUsername === resetUsername && notice.templateCode === "PASSWORD_RESET_DONE" && notice.status === "SENT");
  const rejectedNotices = notifications.filter((notice) => notice.recipientUsername === rejectUsername && notice.templateCode === "PASSWORD_RESET_REJECTED" && notice.status === "SENT");
  assert(doneNotices.length >= 1, `expected sent reset notification for ${resetUsername}, got ${doneNotices.length}`);
  assert(rejectedNotices.length >= 1, `expected sent reject notification for ${rejectUsername}, got ${rejectedNotices.length}`);

  const logResponse = await browserFetch(page, `/api/lists/operation-log-list?scope=platform&keyword=${encodeURIComponent("SEND_PASSWORD_RESET_NOTICE")}&page=1&pageSize=200`);
  assert(logResponse.status === 200, `operation log list should load, got ${logResponse.status}`);
  const logPayload = JSON.parse(logResponse.text);
  const noticeAuditRows = (logPayload.rows ?? []).filter((row) => row.action === "SEND_PASSWORD_RESET_NOTICE" && row.status === "成功");
  assert(noticeAuditRows.length >= 2, `expected at least 2 password reset notice audit rows, got ${noticeAuditRows.length}`);

  const result = {
    batch,
    generatedAt: new Date().toISOString(),
    resetUsername,
    rejectUsername,
    doneNoticeCount: doneNotices.length,
    rejectedNoticeCount: rejectedNotices.length,
    noticeAuditRows: noticeAuditRows.length,
    screenshots: [
      `verification/playwright/${notificationScreenshot}`
    ]
  };
  await writeFile(resultPath, JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
} finally {
  await browser.close();
}
