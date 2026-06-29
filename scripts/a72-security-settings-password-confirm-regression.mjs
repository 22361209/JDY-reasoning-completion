import { chromium } from "playwright";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const rootDir = path.resolve(import.meta.dirname, "..");
const verificationDir = path.join(rootDir, "verification");
const screenshotDir = path.join(verificationDir, "playwright");
const resultPath = path.join(verificationDir, "a72-security-settings-password-confirm-regression.json");
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
  await page.getByTestId("login-username").fill("admin");
  await page.getByTestId("login-password").fill("admin123");
  await page.getByTestId("login-submit").click();
  await page.getByTestId("session-user-role").filter({ hasText: "系统管理员" }).waitFor({ state: "visible" });
}

async function openSecuritySettings(page) {
  await page.getByTestId("module-系统设置").hover();
  await page.getByTestId("entry-security-settings").click();
  await page.getByTestId("security-settings-summary").waitFor({ state: "visible" });
}

async function savePolicyWithPassword(page, policy, password) {
  if (policy === "ALLOW_CONCURRENT") {
    await page.getByTestId("security-policy-allow-concurrent").click();
  } else {
    await page.getByTestId("security-policy-single-active").click();
  }
  await page.getByTestId("security-repeated-login-policy").selectOption(policy);
  await page.getByTestId("security-current-password").fill(password);
  const [response] = await Promise.all([
    page.waitForResponse((res) => res.url().includes("/api/system/security-settings") && res.request().method() === "PUT"),
    page.getByTestId("security-settings-save").click()
  ]);
  return {
    status: response.status(),
    text: await response.text()
  };
}

async function readSettings(page) {
  const response = await browserFetch(page, "/api/system/security-settings");
  assert(response.status === 200, `security settings should load, got ${response.status}: ${response.text}`);
  return JSON.parse(response.text);
}

const browser = await chromium.launch({ headless: true });
let rejectedScreenshot = "";
let acceptedScreenshot = "";
try {
  const context = await browser.newContext({ viewport: { width: 1366, height: 768 } });
  const page = await context.newPage();
  await page.goto(frontendUrl, { waitUntil: "networkidle" });
  await loginAsAdmin(page);
  await openSecuritySettings(page);

  const initialSettings = await readSettings(page);
  if (initialSettings.repeatedLoginPolicy !== "SINGLE_ACTIVE") {
    const resetResponse = await savePolicyWithPassword(page, "SINGLE_ACTIVE", "admin123");
    assert(resetResponse.status === 200, `reset policy should succeed, got ${resetResponse.status}: ${resetResponse.text}`);
  }

  const wrongPasswordResponse = await savePolicyWithPassword(page, "ALLOW_CONCURRENT", "wrong-admin-password");
  assert(wrongPasswordResponse.status === 400, `wrong current password should return 400, got ${wrongPasswordResponse.status}: ${wrongPasswordResponse.text}`);
  await page.getByTestId("security-settings-message").filter({ hasText: "当前密码不正确" }).waitFor({ state: "visible" });
  const settingsAfterWrong = await readSettings(page);
  assert(settingsAfterWrong.repeatedLoginPolicy === "SINGLE_ACTIVE", `policy should stay SINGLE_ACTIVE after wrong password, got ${settingsAfterWrong.repeatedLoginPolicy}`);
  rejectedScreenshot = `a72-security-settings-wrong-password-${batch}.png`;
  await page.screenshot({ path: path.join(screenshotDir, rejectedScreenshot), fullPage: true });

  const correctPasswordResponse = await savePolicyWithPassword(page, "ALLOW_CONCURRENT", "admin123");
  assert(correctPasswordResponse.status === 200, `correct current password should save, got ${correctPasswordResponse.status}: ${correctPasswordResponse.text}`);
  await page.getByTestId("security-settings-message").filter({ hasText: "安全设置已保存" }).waitFor({ state: "visible" });
  const settingsAfterCorrect = await readSettings(page);
  assert(settingsAfterCorrect.repeatedLoginPolicy === "ALLOW_CONCURRENT", `policy should save as ALLOW_CONCURRENT, got ${settingsAfterCorrect.repeatedLoginPolicy}`);
  acceptedScreenshot = `a72-security-settings-correct-password-${batch}.png`;
  await page.screenshot({ path: path.join(screenshotDir, acceptedScreenshot), fullPage: true });

  const restoreResponse = await savePolicyWithPassword(page, "SINGLE_ACTIVE", "admin123");
  assert(restoreResponse.status === 200, `restore policy should succeed, got ${restoreResponse.status}: ${restoreResponse.text}`);
  const restoredSettings = await readSettings(page);
  assert(restoredSettings.repeatedLoginPolicy === "SINGLE_ACTIVE", "policy should restore to SINGLE_ACTIVE");

  const logResponse = await browserFetch(page, `/api/lists/operation-log-list?keyword=${encodeURIComponent("repeated_login_policy")}&page=1&pageSize=200`);
  assert(logResponse.status === 200, `operation log list should load, got ${logResponse.status}`);
  const logPayload = JSON.parse(logResponse.text);
  const settingRows = (logPayload.rows ?? []).filter((row) => row.action === "UPDATE_SECURITY_SETTING" && row.status === "成功");
  assert(settingRows.length >= 2, `expected at least 2 repeated_login_policy audit rows, got ${settingRows.length}`);

  const result = {
    batch,
    generatedAt: new Date().toISOString(),
    wrongPasswordStatus: wrongPasswordResponse.status,
    policyAfterWrongPassword: settingsAfterWrong.repeatedLoginPolicy,
    correctPasswordStatus: correctPasswordResponse.status,
    policyAfterCorrectPassword: settingsAfterCorrect.repeatedLoginPolicy,
    restoredPolicy: restoredSettings.repeatedLoginPolicy,
    settingAuditRows: settingRows.length,
    screenshots: [
      `verification/playwright/${rejectedScreenshot}`,
      `verification/playwright/${acceptedScreenshot}`
    ]
  };
  await writeFile(resultPath, JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));

  await context.close();
} finally {
  await browser.close();
}
