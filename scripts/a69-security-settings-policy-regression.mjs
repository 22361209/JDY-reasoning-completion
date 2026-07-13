import { chromium } from "playwright";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const rootDir = path.resolve(import.meta.dirname, "..");
const verificationDir = path.join(rootDir, "verification");
const screenshotDir = path.join(verificationDir, "playwright");
const resultPath = path.join(verificationDir, "a69-security-settings-policy-regression.json");
const frontendUrl = "http://127.0.0.1:5173/";
const batch = new Date().toISOString().replace(/\D/g, "").slice(0, 14);
const username = `a69u${batch.slice(8)}`;
const password = `A69-${batch.slice(8)}-ok`;

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
  await page.getByTestId("login-page").waitFor({ state: "visible" });
  await page.getByTestId("login-username").fill(usernameValue);
  await page.getByTestId("login-password").fill(passwordValue);
  await page.getByTestId("login-submit").click();
  await page.getByTestId("session-user-role").filter({ hasText: expectedRole }).waitFor({ state: "visible" });
}

async function savePolicy(page, policy) {
  await page.getByTestId("module-系统设置").hover();
  await page.getByTestId("entry-security-settings").click();
  await page.getByTestId("security-current-policy").filter({ hasText: /ALLOW_CONCURRENT|SINGLE_ACTIVE/ }).waitFor({ state: "visible" });
  if (policy === "ALLOW_CONCURRENT") {
    await page.getByTestId("security-policy-allow-concurrent").click();
  } else {
    await page.getByTestId("security-policy-single-active").click();
  }
  await page.getByTestId("security-repeated-login-policy").selectOption(policy);
  await page.getByTestId("security-current-password").fill("admin123");
  await Promise.all([
    page.waitForResponse((response) => response.url().includes("/api/system/security-settings") && response.request().method() === "PUT"),
    page.getByTestId("security-settings-save").click()
  ]);
  await page.getByTestId("security-settings-message").filter({ hasText: "安全设置已保存" }).waitFor({ state: "visible" });
  await page.getByTestId("security-current-policy").filter({ hasText: policy }).waitFor({ state: "visible" });
}

const browser = await chromium.launch({ headless: true });
let allowScreenshot = "";
let singleScreenshot = "";
try {
  const adminContext = await browser.newContext({ viewport: { width: 1366, height: 768 } });
  const adminPage = await adminContext.newPage();
  await adminPage.goto(frontendUrl, { waitUntil: "networkidle" });
  await loginAs(adminPage, "admin", "admin123", "系统管理员");
  await savePolicy(adminPage, "ALLOW_CONCURRENT");
  allowScreenshot = `a69-policy-allow-concurrent-${batch}.png`;
  await adminPage.screenshot({ path: path.join(screenshotDir, allowScreenshot), fullPage: true });

  const createUser = await browserFetch(adminPage, "/api/system/managed-users", {
    method: "POST",
    body: {
      username,
      displayName: "A69 安全策略员工",
      roleCode: "WAREHOUSE",
      password,
      enabled: true
    }
  });
  assert(createUser.status === 200, `admin should create A69 user, got ${createUser.status}: ${createUser.text}`);

  const firstContext = await browser.newContext({ viewport: { width: 1366, height: 768 } });
  const firstPage = await firstContext.newPage();
  await firstPage.goto(frontendUrl, { waitUntil: "networkidle" });
  await loginAs(firstPage, username, password, "仓库员");

  const secondContext = await browser.newContext({ viewport: { width: 1366, height: 768 } });
  const secondPage = await secondContext.newPage();
  await secondPage.goto(frontendUrl, { waitUntil: "networkidle" });
  await loginAs(secondPage, username, password, "仓库员");

  const firstSessionAllow = await browserFetch(firstPage, "/api/system/session");
  assert(firstSessionAllow.status === 200, `first session endpoint should be public, got ${firstSessionAllow.status}`);
  const firstSessionAllowPayload = JSON.parse(firstSessionAllow.text);
  assert(firstSessionAllowPayload.authenticated === true, "ALLOW_CONCURRENT should keep first login authenticated after second login");
  const firstPeriodAllow = await browserFetch(firstPage, "/api/system/period");
  assert(firstPeriodAllow.status === 200, `ALLOW_CONCURRENT should keep old context protected API usable, got ${firstPeriodAllow.status}`);

  await savePolicy(adminPage, "SINGLE_ACTIVE");
  singleScreenshot = `a69-policy-single-active-${batch}.png`;
  await adminPage.screenshot({ path: path.join(screenshotDir, singleScreenshot), fullPage: true });

  const firstSessionSingle = await browserFetch(firstPage, "/api/system/session");
  assert(firstSessionSingle.status === 200, `first session endpoint should remain public, got ${firstSessionSingle.status}`);
  const firstSessionSinglePayload = JSON.parse(firstSessionSingle.text);
  assert(firstSessionSinglePayload.authenticated === false, "SINGLE_ACTIVE should invalidate older repeated login context");
  const firstPeriodSingle = await browserFetch(firstPage, "/api/system/period");
  assert(firstPeriodSingle.status === 401, `SINGLE_ACTIVE should block old context protected API, got ${firstPeriodSingle.status}`);
  const secondPeriodSingle = await browserFetch(secondPage, "/api/system/period");
  assert(secondPeriodSingle.status === 200, `SINGLE_ACTIVE should keep latest context usable, got ${secondPeriodSingle.status}`);

  const logResponse = await browserFetch(adminPage, `/api/lists/operation-log-list?scope=platform&keyword=${encodeURIComponent("UPDATE_SECURITY_SETTING")}&page=1&pageSize=200`);
  assert(logResponse.status === 200, `operation log list should load, got ${logResponse.status}`);
  const logPayload = JSON.parse(logResponse.text);
  const settingRows = (logPayload.rows ?? []).filter((row) => row.action === "UPDATE_SECURITY_SETTING" && row.status === "成功");
  assert(settingRows.length >= 2, `expected at least 2 UPDATE_SECURITY_SETTING rows, got ${settingRows.length}`);

  const result = {
    batch,
    generatedAt: new Date().toISOString(),
    username,
    allowConcurrent: {
      firstSessionAuthenticated: firstSessionAllowPayload.authenticated,
      firstProtectedStatus: firstPeriodAllow.status
    },
    singleActive: {
      firstSessionAuthenticated: firstSessionSinglePayload.authenticated,
      firstProtectedStatus: firstPeriodSingle.status,
      latestProtectedStatus: secondPeriodSingle.status
    },
    settingAuditRows: settingRows.length,
    screenshots: [
      `verification/playwright/${allowScreenshot}`,
      `verification/playwright/${singleScreenshot}`
    ]
  };
  await writeFile(resultPath, JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));

  await secondContext.close();
  await firstContext.close();
  await adminContext.close();
} finally {
  await browser.close();
}
