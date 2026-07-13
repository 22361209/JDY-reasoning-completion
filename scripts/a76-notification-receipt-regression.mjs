import { chromium } from "playwright";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { loginAs as sharedLoginAs, logout as sharedLogout, openPasswordChange } from "./helpers/regression-auth.mjs";

const rootDir = path.resolve(import.meta.dirname, "..");
const verificationDir = path.join(rootDir, "verification");
const screenshotDir = path.join(verificationDir, "playwright");
const resultPath = path.join(verificationDir, "a76-notification-receipt-regression.json");
const frontendUrl = "http://127.0.0.1:5173/";
const batch = new Date().toISOString().replace(/\D/g, "").slice(0, 14);
const suffix = batch.slice(8);
const deliveredUsername = `a76ok${suffix}`;
const failedUsername = `a76fail${suffix}`;

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

async function loginAsAdmin(page) {
  await sharedLoginAs(page, "admin", "admin123", "系统管理员");
}

async function createResetNotification(page, username, displayName, oldPassword, newPassword) {
  const createUser = await browserFetch(page, "/api/system/managed-users", {
    method: "POST",
    body: {
      username,
      displayName,
      roleCode: "WAREHOUSE",
      password: oldPassword,
      enabled: true
    }
  });
  assert(createUser.status === 200, `admin should create ${username}, got ${createUser.status}: ${createUser.text}`);

  await sharedLogout(page);
  await page.reload({ waitUntil: "networkidle" });
  await page.getByTestId("login-username").fill(username);
  await page.getByTestId("forgot-password-open").click();
  await page.getByTestId("password-reset-request-dialog").waitFor({ state: "visible" });
  await page.getByTestId("password-reset-contact").fill(`A76 回执核验 ${username}`);
  await page.getByTestId("password-reset-submit").click();
  await page.getByTestId("password-reset-message").filter({ hasText: "已提交找回申请" }).waitFor({ state: "visible" });
  await page.getByTestId("password-reset-cancel").click();

  await loginAsAdmin(page);
  await page.getByTestId("module-系统设置").hover();
  await page.getByTestId("entry-user-role-list").click();
  await page.getByTestId("password-reset-admin-panel").waitFor({ state: "visible" });
  await page.getByTestId(`password-reset-request-${username}`).click();
  await page.getByTestId("managed-user-password").fill(newPassword);
  await page.getByTestId("managed-user-reset-password").click();
  await page.getByTestId("user-management-message").filter({ hasText: "密码已重置" }).waitFor({ state: "visible" });

  const sentNotices = await browserFetch(page, "/api/system/notification-outbox?status=SENT");
  assert(sentNotices.status === 200, `sent notification list should load, got ${sentNotices.status}: ${sentNotices.text}`);
  const sentPayload = JSON.parse(sentNotices.text);
  const notice = (sentPayload.notificationOutbox ?? []).find((item) => item.recipientUsername === username && item.templateCode === "PASSWORD_RESET_DONE");
  assert(notice, `expected reset notification for ${username}`);
  return notice;
}

async function findNotice(page, notificationId) {
  const allNotices = await browserFetch(page, "/api/system/notification-outbox");
  assert(allNotices.status === 200, `notification list should load, got ${allNotices.status}: ${allNotices.text}`);
  const payload = JSON.parse(allNotices.text);
  return (payload.notificationOutbox ?? []).find((item) => item.id === notificationId);
}

async function waitForNoticeReceipt(page, notificationId, expectedStatus, expectedReceiptStatus) {
  const deadline = Date.now() + 10000;
  let lastNotice = null;
  while (Date.now() < deadline) {
    lastNotice = await findNotice(page, notificationId);
    if (lastNotice?.status === expectedStatus && lastNotice?.providerReceiptStatus === expectedReceiptStatus) {
      return lastNotice;
    }
    await page.waitForTimeout(300);
  }
  throw new Error(`notification ${notificationId} did not reach ${expectedStatus}/${expectedReceiptStatus}, last=${JSON.stringify(lastNotice)}`);
}

const browser = await chromium.launch({ headless: true });
let receiptScreenshot = "";
try {
  const page = await browser.newPage({ viewport: { width: 1366, height: 768 } });
  await page.goto(frontendUrl, { waitUntil: "networkidle" });
  await loginAsAdmin(page);

  const deliveredNotice = await createResetNotification(
    page,
    deliveredUsername,
    "A76 回执成功员工",
    `A76-Ok-Old-${suffix}!`,
    `A76-Ok-New-${suffix}!`
  );
  const failedNotice = await createResetNotification(
    page,
    failedUsername,
    "A76 回执失败员工",
    `A76-Fail-Old-${suffix}!`,
    `A76-Fail-New-${suffix}!`
  );

  await page.getByTestId("notification-status-filter").selectOption("SENT");
  await page.getByTestId(`password-reset-notice-${deliveredUsername}-PASSWORD_RESET_DONE`).waitFor({ state: "visible" });
  await page.getByTestId(`notification-receipt-delivered-${deliveredUsername}`).click();
  await page.getByTestId("user-management-message").filter({ hasText: "通知回执已同步" }).waitFor({ state: "visible" });
  const deliveredAfterReceipt = await waitForNoticeReceipt(page, deliveredNotice.id, "SENT", "DELIVERED");
  assert(deliveredAfterReceipt, "delivered receipt notice should still exist");
  assert(deliveredAfterReceipt.status === "SENT", `delivered receipt should keep SENT, got ${deliveredAfterReceipt.status}`);
  assert(deliveredAfterReceipt.providerReceiptStatus === "DELIVERED", `expected DELIVERED receipt, got ${deliveredAfterReceipt.providerReceiptStatus}`);
  assert(Boolean(deliveredAfterReceipt.providerReceiptAt), "delivered receipt should write providerReceiptAt");

  await page.getByTestId(`password-reset-notice-${failedUsername}-PASSWORD_RESET_DONE`).waitFor({ state: "visible" });
  await page.getByTestId(`notification-receipt-failed-${failedUsername}`).click();
  const failedAfterReceipt = await waitForNoticeReceipt(page, failedNotice.id, "FAILED", "FAILED");
  assert(failedAfterReceipt, "failed receipt notice should still exist");
  assert(failedAfterReceipt.status === "FAILED", `failed receipt should become FAILED, got ${failedAfterReceipt.status}`);
  assert(failedAfterReceipt.providerReceiptStatus === "FAILED", `expected FAILED receipt, got ${failedAfterReceipt.providerReceiptStatus}`);
  assert(Boolean(failedAfterReceipt.providerReceiptAt), "failed receipt should write providerReceiptAt");
  assert((failedAfterReceipt.failureReason ?? "").includes("本地供应商回执失败"), `failed receipt should keep reason, got ${failedAfterReceipt.failureReason}`);

  await page.waitForTimeout(6000);
  const failedAfterSchedulerWindow = await findNotice(page, failedNotice.id);
  assert(failedAfterSchedulerWindow, "failed receipt notice should still exist after scheduler window");
  assert(failedAfterSchedulerWindow.status === "FAILED", `failed receipt should not be auto retried, got ${failedAfterSchedulerWindow.status}`);
  assert(failedAfterSchedulerWindow.providerReceiptStatus === "FAILED", `failed receipt status should remain FAILED, got ${failedAfterSchedulerWindow.providerReceiptStatus}`);

  receiptScreenshot = `a76-notification-receipt-sync-${batch}.png`;
  await page.screenshot({ path: path.join(screenshotDir, receiptScreenshot), fullPage: true });

  const logResponse = await browserFetch(page, `/api/lists/operation-log-list?scope=platform&keyword=${encodeURIComponent("SYNC_NOTIFICATION_RECEIPT")}&page=1&pageSize=200`);
  assert(logResponse.status === 200, `operation log list should load, got ${logResponse.status}`);
  const logPayload = JSON.parse(logResponse.text);
  const receiptAuditRows = (logPayload.rows ?? []).filter((row) => row.action === "SYNC_NOTIFICATION_RECEIPT" && row.status === "成功");
  assert(receiptAuditRows.length >= 2, `expected at least 2 receipt audit rows, got ${receiptAuditRows.length}`);

  const result = {
    batch,
    generatedAt: new Date().toISOString(),
    deliveredUsername,
    failedUsername,
    deliveredNotificationId: deliveredNotice.id,
    failedNotificationId: failedNotice.id,
    delivered: {
      status: deliveredAfterReceipt.status,
      providerReceiptStatus: deliveredAfterReceipt.providerReceiptStatus,
      providerReceiptAt: deliveredAfterReceipt.providerReceiptAt
    },
    failed: {
      status: failedAfterSchedulerWindow.status,
      providerReceiptStatus: failedAfterSchedulerWindow.providerReceiptStatus,
      providerReceiptAt: failedAfterSchedulerWindow.providerReceiptAt,
      failureReason: failedAfterSchedulerWindow.failureReason,
      schedulerWindowSeconds: 6
    },
    receiptAuditRows: receiptAuditRows.length,
    screenshots: [
      `verification/playwright/${receiptScreenshot}`
    ]
  };
  await writeFile(resultPath, JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
} finally {
  await browser.close();
}
