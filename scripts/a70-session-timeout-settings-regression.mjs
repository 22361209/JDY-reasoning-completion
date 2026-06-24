import { chromium } from "playwright";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const rootDir = path.resolve(import.meta.dirname, "..");
const verificationDir = path.join(rootDir, "verification");
const screenshotDir = path.join(verificationDir, "playwright");
const resultPath = path.join(verificationDir, "a70-session-timeout-settings-regression.json");
const frontendUrl = "http://127.0.0.1:5173/";
const batch = new Date().toISOString().replace(/\D/g, "").slice(0, 14);

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
  await page.getByTestId("login-username").selectOption("admin");
  await page.getByTestId("login-password").fill("admin123");
  await page.getByTestId("login-submit").click();
  await page.getByTestId("session-user-role").filter({ hasText: "系统管理员" }).waitFor({ state: "visible" });
}

async function openSecuritySettings(page) {
  await page.getByTestId("module-系统设置").hover();
  await page.getByTestId("entry-security-settings").click();
  await page.getByTestId("security-settings-summary").waitFor({ state: "visible" });
}

async function saveTimeout(page, minutes) {
  const timeoutInput = page.getByTestId("security-session-timeout-minutes");
  await timeoutInput.click();
  await page.keyboard.press(process.platform === "darwin" ? "Meta+A" : "Control+A");
  await page.keyboard.type(String(minutes));
  await timeoutInput.blur();
  const inputValue = await timeoutInput.inputValue();
  assert(inputValue === String(minutes), `timeout input should be ${minutes} before save, got ${inputValue}`);
  await page.getByTestId("security-current-password").fill("admin123");
  const [response] = await Promise.all([
    page.waitForResponse((response) => response.url().includes("/api/system/security-settings") && response.request().method() === "PUT"),
    page.getByTestId("security-settings-save").click()
  ]);
  assert(response.status() === 200, `security settings save should return 200, got ${response.status()}`);
  const payload = JSON.parse(await response.text());
  assert(payload.sessionTimeoutMinutes === minutes, `security settings save should return ${minutes} minutes, got ${payload.sessionTimeoutMinutes}`);
  await page.getByTestId("security-settings-message").filter({ hasText: "安全设置已保存" }).waitFor({ state: "visible" });
  await page.waitForFunction(
    ({ selector, expected }) => document.querySelector(selector)?.textContent?.includes(expected),
    { selector: "[data-testid='security-current-timeout']", expected: `${minutes} 分钟` }
  );
}


async function readJson(page, pathname) {
  const response = await browserFetch(page, pathname);
  assert(response.status === 200, `${pathname} should return 200, got ${response.status}: ${response.text}`);
  return JSON.parse(response.text);
}

const browser = await chromium.launch({ headless: true });
let configuredScreenshot = "";
let resetScreenshot = "";
try {
  const context = await browser.newContext({ viewport: { width: 1366, height: 768 } });
  const page = await context.newPage();
  await page.goto(frontendUrl, { waitUntil: "networkidle" });
  await loginAsAdmin(page);
  await openSecuritySettings(page);

  await saveTimeout(page, 7);
  configuredScreenshot = `a70-session-timeout-7-minutes-${batch}.png`;
  await page.screenshot({ path: path.join(screenshotDir, configuredScreenshot), fullPage: true });

  const settingsAfterSave = await readJson(page, "/api/system/security-settings");
  assert(settingsAfterSave.sessionTimeoutMinutes === 7, `settings timeout should be 7, got ${settingsAfterSave.sessionTimeoutMinutes}`);
  assert(settingsAfterSave.sessionTimeoutSeconds === 420, `settings timeout seconds should be 420, got ${settingsAfterSave.sessionTimeoutSeconds}`);

  const sessionAfterSave = await readJson(page, "/api/system/session");
  assert(sessionAfterSave.authenticated === true, "session should stay authenticated after timeout save");
  assert(sessionAfterSave.security?.sessionTimeoutMinutes === 7, `session security timeout should be 7, got ${sessionAfterSave.security?.sessionTimeoutMinutes}`);
  assert(sessionAfterSave.security?.sessionMaxInactiveSeconds === 420, `HttpSession max inactive should be 420, got ${sessionAfterSave.security?.sessionMaxInactiveSeconds}`);

  await saveTimeout(page, 30);
  resetScreenshot = `a70-session-timeout-reset-30-minutes-${batch}.png`;
  await page.screenshot({ path: path.join(screenshotDir, resetScreenshot), fullPage: true });

  const sessionAfterReset = await readJson(page, "/api/system/session");
  assert(sessionAfterReset.security?.sessionTimeoutMinutes === 30, `reset session timeout should be 30, got ${sessionAfterReset.security?.sessionTimeoutMinutes}`);
  assert(sessionAfterReset.security?.sessionMaxInactiveSeconds === 1800, `reset HttpSession max inactive should be 1800, got ${sessionAfterReset.security?.sessionMaxInactiveSeconds}`);

  const logResponse = await browserFetch(page, `/api/lists/operation-log-list?keyword=${encodeURIComponent("session_timeout_minutes")}&page=1&pageSize=200`);
  assert(logResponse.status === 200, `operation log list should load, got ${logResponse.status}`);
  const logPayload = JSON.parse(logResponse.text);
  const settingRows = (logPayload.rows ?? []).filter((row) => row.action === "UPDATE_SECURITY_SETTING" && row.status === "成功");
  assert(settingRows.length >= 2, `expected at least 2 session timeout setting logs, got ${settingRows.length}`);

  const result = {
    batch,
    generatedAt: new Date().toISOString(),
    configuredTimeout: {
      minutes: settingsAfterSave.sessionTimeoutMinutes,
      seconds: settingsAfterSave.sessionTimeoutSeconds,
      sessionMaxInactiveSeconds: sessionAfterSave.security.sessionMaxInactiveSeconds
    },
    resetTimeout: {
      minutes: sessionAfterReset.security.sessionTimeoutMinutes,
      sessionMaxInactiveSeconds: sessionAfterReset.security.sessionMaxInactiveSeconds
    },
    settingAuditRows: settingRows.length,
    screenshots: [
      `verification/playwright/${configuredScreenshot}`,
      `verification/playwright/${resetScreenshot}`
    ]
  };
  await writeFile(resultPath, JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));

  await context.close();
} finally {
  await browser.close();
}
