import { chromium } from "playwright";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { loginAs as sharedLoginAs, logout as sharedLogout, openPasswordChange } from "./helpers/regression-auth.mjs";

const rootDir = path.resolve(import.meta.dirname, "..");
const verificationDir = path.join(rootDir, "verification");
const screenshotDir = path.join(verificationDir, "playwright");
const resultPath = path.join(verificationDir, "a71-password-policy-settings-regression.json");
const frontendUrl = "http://127.0.0.1:5173/";
const batch = new Date().toISOString().replace(/\D/g, "").slice(0, 14);
const suffix = batch.slice(8);
const username = `a71u${suffix}`;
const oldPassword = `A71-Old-${suffix}!`;
const weakPassword = "A71abc1";
const validPassword = "A71abcdef1";

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

async function openSecuritySettings(page) {
  await page.getByTestId("module-系统设置").hover();
  await page.getByTestId("entry-security-settings").click();
  await page.getByTestId("security-settings-summary").waitFor({ state: "visible" });
  await page.getByTestId("security-current-password-policy").filter({ hasText: "至少" }).waitFor({ state: "visible" });
}

async function setNumberInput(page, testId, value) {
  const input = page.getByTestId(testId);
  await input.fill(String(value));
  await input.blur();
  await page.waitForFunction(
    ({ selector, expected }) => document.querySelector(selector)?.value === expected,
    { selector: `[data-testid='${testId}']`, expected: String(value) }
  );
}

async function setCheckbox(page, testId, checked) {
  const checkbox = page.getByTestId(testId);
  if (await checkbox.isChecked() !== checked) {
    await checkbox.click();
  }
}

async function savePasswordPolicy(page, policy) {
  await setNumberInput(page, "security-password-min-length", policy.minLength);
  await setCheckbox(page, "security-password-require-uppercase", policy.requireUppercase);
  await setCheckbox(page, "security-password-require-lowercase", policy.requireLowercase);
  await setCheckbox(page, "security-password-require-digit", policy.requireDigit);
  await setCheckbox(page, "security-password-require-symbol", policy.requireSymbol);
  await page.getByTestId("security-current-password").fill("admin123");
  const [response] = await Promise.all([
    page.waitForResponse((res) => res.url().includes("/api/system/security-settings") && res.request().method() === "PUT"),
    page.getByTestId("security-settings-save").click()
  ]);
  assert(response.status() === 200, `security settings save should return 200, got ${response.status()}`);
  const payload = JSON.parse(await response.text());
  assert(payload.passwordPolicy.minLength === policy.minLength, `minLength should be ${policy.minLength}, got ${payload.passwordPolicy.minLength}`);
  assert(payload.passwordPolicy.requireSymbol === policy.requireSymbol, `requireSymbol should be ${policy.requireSymbol}`);
  await page.getByTestId("security-settings-message").filter({ hasText: "安全设置已保存" }).waitFor({ state: "visible" });
  await page.waitForFunction(
    ({ expected }) => document.querySelector("[data-testid='security-current-password-policy']")?.textContent?.includes(expected),
    { expected: `至少 ${policy.minLength} 位` }
  );
}

const browser = await chromium.launch({ headless: true });
let configuredScreenshot = "";
let dialogScreenshot = "";
let resetScreenshot = "";
try {
  const adminContext = await browser.newContext({ viewport: { width: 1366, height: 768 } });
  const adminPage = await adminContext.newPage();
  await adminPage.goto(frontendUrl, { waitUntil: "networkidle" });
  await loginAs(adminPage, "admin", "admin123", "系统管理员");

  const createUser = await browserFetch(adminPage, "/api/system/managed-users", {
    method: "POST",
    body: {
      username,
      displayName: "A71 密码策略员工",
      roleCode: "WAREHOUSE",
      password: oldPassword,
      enabled: true
    }
  });
  assert(createUser.status === 200, `admin should create A71 user, got ${createUser.status}: ${createUser.text}`);

  await openSecuritySettings(adminPage);
  await savePasswordPolicy(adminPage, {
    minLength: 10,
    requireUppercase: true,
    requireLowercase: true,
    requireDigit: true,
    requireSymbol: false
  });
  configuredScreenshot = `a71-password-policy-configured-${batch}.png`;
  await adminPage.screenshot({ path: path.join(screenshotDir, configuredScreenshot), fullPage: true });

  const employeeContext = await browser.newContext({ viewport: { width: 1366, height: 768 } });
  const employeePage = await employeeContext.newPage();
  await employeePage.goto(frontendUrl, { waitUntil: "networkidle" });
  await loginAs(employeePage, username, oldPassword, "仓库员");

  const weakBackend = await browserFetch(employeePage, "/api/system/password", {
    method: "PUT",
    body: { currentPassword: oldPassword, newPassword: weakPassword }
  });
  assert(weakBackend.status === 400, `weak password should be rejected by backend, got ${weakBackend.status}: ${weakBackend.text}`);
  assert(weakBackend.text.includes("至少 10 位"), `weak password response should mention min length, got ${weakBackend.text}`);

  await openPasswordChange(employeePage);
  await employeePage.getByTestId("password-change-dialog").waitFor({ state: "visible" });
  await employeePage.getByTestId("password-current").fill(oldPassword);
  await employeePage.getByTestId("password-new").fill(weakPassword);
  await employeePage.getByTestId("password-confirm").fill(weakPassword);
  await employeePage.getByTestId("password-submit").click();
  await employeePage.getByTestId("password-message").filter({ hasText: "强度" }).waitFor({ state: "visible" });
  const rulesText = await employeePage.getByTestId("password-rules").textContent();
  assert(rulesText?.includes("至少 10 位"), `password dialog should show min length 10, got ${rulesText}`);
  assert(!rulesText?.includes("符号"), `password dialog should not require symbol after policy change, got ${rulesText}`);

  await employeePage.getByTestId("password-new").fill(validPassword);
  await employeePage.getByTestId("password-confirm").fill(validPassword);
  dialogScreenshot = `a71-password-policy-dialog-${batch}.png`;
  await employeePage.screenshot({ path: path.join(screenshotDir, dialogScreenshot), fullPage: true });
  await employeePage.getByTestId("password-submit").click();
  await employeePage.getByTestId("login-message").filter({ hasText: "密码已修改" }).waitFor({ state: "visible" });
  await loginAs(employeePage, username, validPassword, "仓库员");

  await openSecuritySettings(adminPage);
  await savePasswordPolicy(adminPage, {
    minLength: 8,
    requireUppercase: true,
    requireLowercase: true,
    requireDigit: true,
    requireSymbol: true
  });
  resetScreenshot = `a71-password-policy-reset-${batch}.png`;
  await adminPage.screenshot({ path: path.join(screenshotDir, resetScreenshot), fullPage: true });

  const settingsAfterReset = await browserFetch(adminPage, "/api/system/security-settings");
  assert(settingsAfterReset.status === 200, `settings should load after reset, got ${settingsAfterReset.status}`);
  const settingsPayload = JSON.parse(settingsAfterReset.text);
  assert(settingsPayload.passwordPolicy.minLength === 8, "password min length should reset to 8");
  assert(settingsPayload.passwordPolicy.requireSymbol === true, "password require symbol should reset to true");

  const logResponse = await browserFetch(adminPage, `/api/lists/operation-log-list?keyword=${encodeURIComponent("password_policy")}&page=1&pageSize=200`);
  assert(logResponse.status === 200, `operation log list should load, got ${logResponse.status}`);
  const logPayload = JSON.parse(logResponse.text);
  const policyRows = (logPayload.rows ?? []).filter((row) => row.action === "UPDATE_SECURITY_SETTING" && row.status === "成功");
  assert(policyRows.length >= 2, `expected at least 2 password policy audit rows, got ${policyRows.length}`);

  const result = {
    batch,
    generatedAt: new Date().toISOString(),
    username,
    weakBackendStatus: weakBackend.status,
    configuredPolicy: {
      minLength: 10,
      requireSymbol: false
    },
    resetPolicy: {
      minLength: settingsPayload.passwordPolicy.minLength,
      requireSymbol: settingsPayload.passwordPolicy.requireSymbol
    },
    passwordPolicyAuditRows: policyRows.length,
    screenshots: [
      `verification/playwright/${configuredScreenshot}`,
      `verification/playwright/${dialogScreenshot}`,
      `verification/playwright/${resetScreenshot}`
    ]
  };
  await writeFile(resultPath, JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));

  await employeeContext.close();
  await adminContext.close();
} finally {
  await browser.close();
}
