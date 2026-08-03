import { chromium } from "playwright";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fillRegressionAdminPassword, loginAsAdmin, logout as sharedLogout, openPasswordChange } from "./helpers/regression-auth.mjs";

const rootDir = path.resolve(import.meta.dirname, "..");
const verificationDir = path.join(rootDir, "verification");
const screenshotDir = path.join(verificationDir, "playwright");
const resultPath = path.join(verificationDir, "a77-notification-provider-settings-regression.json");
const frontendUrl = "http://127.0.0.1:5173/";
const batch = new Date().toISOString().replace(/\D/g, "").slice(0, 14);
const suffix = batch.slice(8);
const username = `a77provider${suffix}`;
const oldPassword = `A77-Old-${suffix}!`;
const newPassword = `A77-New-${suffix}!`;

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

const browser = await chromium.launch({ headless: true });
let settingsScreenshot = "";
try {
  const page = await browser.newPage({ viewport: { width: 1366, height: 768 } });
  await page.goto(frontendUrl, { waitUntil: "networkidle" });
  await loginAsAdmin(page);

  await page.getByTestId("module-系统设置").hover();
  await page.getByTestId("entry-notification-provider-settings").click();
  await page.getByTestId("notification-provider-summary").waitFor({ state: "visible" });
  await page.getByTestId("notification-provider-current-code").filter({ hasText: /LOCAL|SIMULATED_HTTP|SIMULATED_SMTP/ }).waitFor({ state: "visible" });
  await page.getByTestId("notification-provider-code").selectOption("SIMULATED_HTTP");
  await page.getByTestId("notification-provider-sender-name").fill("A77 模拟短信网关");
  await page.getByTestId("notification-provider-endpoint-url").fill("https://provider.example.test/a77/send");
  await page.getByTestId("notification-provider-webhook-secret").fill(`a77-secret-${suffix}`);
  await page.getByTestId("notification-provider-dry-run").check();
  await fillRegressionAdminPassword(page.getByTestId("notification-provider-current-password"));
  await page.getByTestId("notification-provider-save").click();
  await page.getByTestId("notification-provider-message").filter({ hasText: "通知供应商设置已保存" }).waitFor({ state: "visible" });

  const settingsResponse = await browserFetch(page, "/api/system/notification-provider-settings");
  assert(settingsResponse.status === 200, `provider settings should load, got ${settingsResponse.status}: ${settingsResponse.text}`);
  const settings = JSON.parse(settingsResponse.text);
  assert(settings.providerCode === "SIMULATED_HTTP", `provider should be SIMULATED_HTTP, got ${settings.providerCode}`);
  assert(settings.senderName === "A77 模拟短信网关", `sender should persist, got ${settings.senderName}`);
  assert(settings.endpointUrl === "https://provider.example.test/a77/send", `endpoint should persist, got ${settings.endpointUrl}`);
  assert(settings.webhookSecretConfigured === true, "webhook secret should be marked configured");
  assert(settings.dryRun === true, "dryRun should stay true");

  const createUser = await browserFetch(page, "/api/system/managed-users", {
    method: "POST",
    body: {
      username,
      displayName: "A77 供应商设置员工",
      roleCode: "WAREHOUSE",
      password: oldPassword,
      enabled: true
    }
  });
  assert(createUser.status === 200, `admin should create A77 user, got ${createUser.status}: ${createUser.text}`);

  await sharedLogout(page);
  await page.reload({ waitUntil: "networkidle" });
  await page.getByTestId("login-username").fill(username);
  await page.getByTestId("forgot-password-open").click();
  await page.getByTestId("password-reset-request-dialog").waitFor({ state: "visible" });
  await page.getByTestId("password-reset-contact").fill(`A77 供应商设置核验 ${username}`);
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
  assert(sentNotices.status === 200, `notification list should load, got ${sentNotices.status}: ${sentNotices.text}`);
  const sentPayload = JSON.parse(sentNotices.text);
  const notice = (sentPayload.notificationOutbox ?? []).find((item) => item.recipientUsername === username && item.templateCode === "PASSWORD_RESET_DONE");
  assert(notice, `expected reset notification for ${username}`);
  assert(notice.provider === "SIMULATED_HTTP", `notice provider should follow settings, got ${notice.provider}`);

  await page.getByTestId("module-系统设置").hover();
  await page.getByTestId("entry-notification-provider-settings").click();
  await page.getByTestId("notification-provider-current-code").filter({ hasText: "SIMULATED_HTTP" }).waitFor({ state: "visible" });
  settingsScreenshot = `a77-notification-provider-settings-${batch}.png`;
  await page.screenshot({ path: path.join(screenshotDir, settingsScreenshot), fullPage: true });

  const logResponse = await browserFetch(page, `/api/lists/operation-log-list?scope=platform&keyword=${encodeURIComponent("UPDATE_NOTIFICATION_PROVIDER_SETTING")}&page=1&pageSize=200`);
  assert(logResponse.status === 200, `operation log list should load, got ${logResponse.status}`);
  const logPayload = JSON.parse(logResponse.text);
  const settingAuditRows = (logPayload.rows ?? []).filter((row) => row.action === "UPDATE_NOTIFICATION_PROVIDER_SETTING" && row.status === "成功");
  assert(settingAuditRows.length >= 1, `expected at least 1 provider setting audit row, got ${settingAuditRows.length}`);

  const result = {
    batch,
    generatedAt: new Date().toISOString(),
    username,
    notificationId: notice.id,
    providerCode: settings.providerCode,
    senderName: settings.senderName,
    endpointUrl: settings.endpointUrl,
    webhookSecretConfigured: settings.webhookSecretConfigured,
    dryRun: settings.dryRun,
    notificationProvider: notice.provider,
    settingAuditRows: settingAuditRows.length,
    screenshots: [
      `verification/playwright/${settingsScreenshot}`
    ]
  };
  await writeFile(resultPath, JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
} finally {
  await browser.close();
}
