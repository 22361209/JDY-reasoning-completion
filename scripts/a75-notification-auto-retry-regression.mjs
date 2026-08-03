import { chromium } from "playwright";
import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { loginAs as sharedLoginAs, logout as sharedLogout, openPasswordChange } from "./helpers/regression-auth.mjs";

const rootDir = path.resolve(import.meta.dirname, "..");
const verificationDir = path.join(rootDir, "verification");
const screenshotDir = path.join(verificationDir, "playwright");
const resultPath = path.join(verificationDir, "a75-notification-auto-retry-regression.json");
const frontendUrl = "http://127.0.0.1:5173/";
const batch = new Date().toISOString().replace(/\D/g, "").slice(0, 14);
const suffix = batch.slice(8);
const username = `a75auto${suffix}`;
const oldPassword = `A75-Old-${suffix}!`;
const newPassword = `A75-New-${suffix}!`;

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

async function openUserRolePanel(page) {
  if (await page.getByTestId("notification-status-filter").isVisible({ timeout: 800 }).catch(() => false)) {
    return;
  }
  if (await page.getByTestId("password-reset-admin-panel").isVisible({ timeout: 800 }).catch(() => false)) {
    return;
  }
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await page.getByTestId("module-系统设置").hover();
    const entry = page.getByTestId("entry-user-role-list");
    await entry.waitFor({ state: "visible", timeout: 5000 });
    await entry.click();
    if (await page.getByTestId("password-reset-admin-panel").isVisible({ timeout: 5000 }).catch(() => false)) {
      return;
    }
    if (await page.getByTestId("notification-status-filter").isVisible({ timeout: 1000 }).catch(() => false)) {
      return;
    }
  }
  throw new Error("password reset admin panel did not open");
}

async function markNoticeFailedAndDue(notificationId) {
  const sql = `
    UPDATE sys_notification_outbox
    SET status = 'FAILED',
        failure_reason = 'A75 模拟供应商超时',
        retry_count = 0,
        sent_at = NULL,
        last_attempt_at = now() - interval '1 minute'
    WHERE id = '${notificationId.replaceAll("'", "''")}'::uuid;
  `;
  execFileSync("docker", ["exec", "jdy-erp-postgres", "psql", "-U", "jdy", "-d", "jdy_erp", "-v", "ON_ERROR_STOP=1", "-c", sql]);
}

async function waitForAutoRetry(page, notificationId) {
  const deadline = Date.now() + 15000;
  let lastNotice = null;
  while (Date.now() < deadline) {
    const response = await browserFetch(page, "/api/system/notification-outbox");
    if (response.status === 401) {
      await loginAsAdmin(page);
      await page.waitForTimeout(500);
      continue;
    }
    assert(response.status === 200, `notification list should load, got ${response.status}: ${response.text}`);
    const payload = JSON.parse(response.text);
    lastNotice = (payload.notificationOutbox ?? []).find((item) => item.id === notificationId) ?? null;
    if (lastNotice?.status === "SENT" && (lastNotice.retryCount ?? 0) >= 1 && !lastNotice.failureReason) {
      return lastNotice;
    }
    await page.waitForTimeout(1000);
  }
  throw new Error(`notification ${notificationId} was not auto retried, last=${JSON.stringify(lastNotice)}`);
}

const browser = await chromium.launch({ headless: true });
let autoRetryScreenshot = "";
try {
  const page = await browser.newPage({ viewport: { width: 1366, height: 768 } });
  await page.goto(frontendUrl, { waitUntil: "networkidle" });
  await loginAsAdmin(page);

  const createUser = await browserFetch(page, "/api/system/managed-users", {
    method: "POST",
    body: {
      username,
      displayName: "A75 自动重试员工",
      roleCode: "WAREHOUSE",
      password: oldPassword,
      enabled: true
    }
  });
  assert(createUser.status === 200, `admin should create A75 user, got ${createUser.status}: ${createUser.text}`);

  await sharedLogout(page);
  await page.reload({ waitUntil: "networkidle" });
  await page.getByTestId("login-username").fill(username);
  await page.getByTestId("forgot-password-open").click();
  await page.getByTestId("password-reset-request-dialog").waitFor({ state: "visible" });
  await page.getByTestId("password-reset-contact").fill("A75 自动重试核验 13800000004");
  await page.getByTestId("password-reset-submit").click();
  await page.getByTestId("password-reset-message").filter({ hasText: "已提交找回申请" }).waitFor({ state: "visible" });
  await page.getByTestId("password-reset-cancel").click();

  await loginAsAdmin(page);
  await openUserRolePanel(page);
  await page.getByTestId(`password-reset-request-${username}`).click();
  await page.getByTestId("managed-user-password").fill(newPassword);
  await page.getByTestId("managed-user-reset-password").click();
  await page.getByTestId("user-management-message").filter({ hasText: "密码已重置" }).waitFor({ state: "visible" });

  const sentNotices = await browserFetch(page, "/api/system/notification-outbox?status=SENT");
  assert(sentNotices.status === 200, `sent notification list should load, got ${sentNotices.status}: ${sentNotices.text}`);
  const sentPayload = JSON.parse(sentNotices.text);
  const notice = (sentPayload.notificationOutbox ?? []).find((item) => item.recipientUsername === username && item.templateCode === "PASSWORD_RESET_DONE");
  assert(notice, `expected sent reset notification for ${username}`);

  await markNoticeFailedAndDue(notice.id);
  const autoRetriedNotice = await waitForAutoRetry(page, notice.id);

  await loginAsAdmin(page);
  await openUserRolePanel(page);
  await page.getByTestId("notification-status-filter").selectOption("SENT");
  await page.getByTestId(`password-reset-notice-${username}-PASSWORD_RESET_DONE`).waitFor({ state: "visible" });
  autoRetryScreenshot = `a75-notification-auto-retry-${batch}.png`;
  await page.screenshot({ path: path.join(screenshotDir, autoRetryScreenshot), fullPage: true });

  const logResponse = await browserFetch(page, `/api/lists/operation-log-list?scope=platform&keyword=${encodeURIComponent("AUTO_RETRY_NOTIFICATION")}&page=1&pageSize=200`);
  assert(logResponse.status === 200, `operation log list should load, got ${logResponse.status}`);
  const logPayload = JSON.parse(logResponse.text);
  const autoRetryAuditRows = (logPayload.rows ?? []).filter((row) => row.action === "AUTO_RETRY_NOTIFICATION" && row.status === "成功");
  assert(autoRetryAuditRows.length >= 1, `expected at least 1 auto retry audit row, got ${autoRetryAuditRows.length}`);

  const result = {
    batch,
    generatedAt: new Date().toISOString(),
    username,
    notificationId: notice.id,
    statusAfterAutoRetry: autoRetriedNotice.status,
    retryCountAfterAutoRetry: autoRetriedNotice.retryCount,
    autoRetryAuditRows: autoRetryAuditRows.length,
    screenshots: [
      `verification/playwright/${autoRetryScreenshot}`
    ]
  };
  await writeFile(resultPath, JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
} finally {
  await browser.close();
}
