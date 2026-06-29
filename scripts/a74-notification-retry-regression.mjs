import { chromium } from "playwright";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const execFileAsync = promisify(execFile);
const rootDir = path.resolve(import.meta.dirname, "..");
const verificationDir = path.join(rootDir, "verification");
const screenshotDir = path.join(verificationDir, "playwright");
const resultPath = path.join(verificationDir, "a74-notification-retry-regression.json");
const frontendUrl = "http://127.0.0.1:5173/";
const batch = new Date().toISOString().replace(/\D/g, "").slice(0, 14);
const suffix = batch.slice(8);
const username = `a74retry${suffix}`;
const oldPassword = `A74-Old-${suffix}!`;
const newPassword = `A74-New-${suffix}!`;

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
  await page.getByTestId("login-page").waitFor({ state: "visible" });
  await page.getByTestId("login-username").fill("admin");
  await page.getByTestId("login-password").fill("admin123");
  await page.getByTestId("login-submit").click();
  await page.getByTestId("session-user-role").filter({ hasText: "系统管理员" }).waitFor({ state: "visible" });
}

async function markNoticeFailed(notificationId) {
  const sql = `
    UPDATE sys_notification_outbox
    SET status = 'FAILED',
        failure_reason = 'A74 模拟供应商失败',
        retry_count = 0,
        sent_at = NULL,
        last_attempt_at = now()
    WHERE id = '${notificationId.replaceAll("'", "''")}'::uuid;
  `;
  await execFileAsync("docker", ["exec", "jdy-erp-postgres", "psql", "-U", "jdy", "-d", "jdy_erp", "-v", "ON_ERROR_STOP=1", "-c", sql]);
}

const browser = await chromium.launch({ headless: true });
let retryScreenshot = "";
try {
  const page = await browser.newPage({ viewport: { width: 1366, height: 768 } });
  await page.goto(frontendUrl, { waitUntil: "networkidle" });
  await loginAsAdmin(page);

  const createUser = await browserFetch(page, "/api/system/managed-users", {
    method: "POST",
    body: {
      username,
      displayName: "A74 通知重发员工",
      roleCode: "WAREHOUSE",
      password: oldPassword,
      enabled: true
    }
  });
  assert(createUser.status === 200, `admin should create A74 user, got ${createUser.status}: ${createUser.text}`);

  await page.getByTestId("session-logout").click();
  await page.getByTestId("login-page").waitFor({ state: "visible" });
  await page.reload({ waitUntil: "networkidle" });
  await page.getByTestId("login-username").fill(username);
  await page.getByTestId("forgot-password-open").click();
  await page.getByTestId("password-reset-request-dialog").waitFor({ state: "visible" });
  await page.getByTestId("password-reset-contact").fill("A74 通知重发核验 13800000003");
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
  assert(notice, `expected sent reset notification for ${username}`);

  await markNoticeFailed(notice.id);

  await page.getByTestId("notification-status-filter").selectOption("FAILED");
  await page.getByTestId(`password-reset-notice-${username}-PASSWORD_RESET_DONE`).waitFor({ state: "visible" });
  await page.getByTestId(`notification-resend-${username}`).click();
  await page.getByTestId("user-management-message").filter({ hasText: "通知已重发" }).waitFor({ state: "visible" });
  retryScreenshot = `a74-notification-retry-${batch}.png`;
  await page.screenshot({ path: path.join(screenshotDir, retryScreenshot), fullPage: true });

  const allNotices = await browserFetch(page, "/api/system/notification-outbox");
  assert(allNotices.status === 200, `notification list should load after resend, got ${allNotices.status}: ${allNotices.text}`);
  const allPayload = JSON.parse(allNotices.text);
  const resentNotice = (allPayload.notificationOutbox ?? []).find((item) => item.id === notice.id);
  assert(resentNotice, "resent notice should still exist");
  assert(resentNotice.status === "SENT", `resent notice should be SENT, got ${resentNotice.status}`);
  assert((resentNotice.retryCount ?? 0) >= 1, `resent notice retry count should increment, got ${resentNotice.retryCount}`);
  assert(!resentNotice.failureReason, `failure reason should clear after resend, got ${resentNotice.failureReason}`);

  const logResponse = await browserFetch(page, `/api/lists/operation-log-list?keyword=${encodeURIComponent("RESEND_NOTIFICATION")}&page=1&pageSize=200`);
  assert(logResponse.status === 200, `operation log list should load, got ${logResponse.status}`);
  const logPayload = JSON.parse(logResponse.text);
  const resendAuditRows = (logPayload.rows ?? []).filter((row) => row.action === "RESEND_NOTIFICATION" && row.status === "成功");
  assert(resendAuditRows.length >= 1, `expected at least 1 resend audit row, got ${resendAuditRows.length}`);

  const result = {
    batch,
    generatedAt: new Date().toISOString(),
    username,
    notificationId: notice.id,
    statusAfterResend: resentNotice.status,
    retryCountAfterResend: resentNotice.retryCount,
    resendAuditRows: resendAuditRows.length,
    screenshots: [
      `verification/playwright/${retryScreenshot}`
    ]
  };
  await writeFile(resultPath, JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
} finally {
  await browser.close();
}
