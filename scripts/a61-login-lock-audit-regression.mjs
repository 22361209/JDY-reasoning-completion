import { chromium } from "playwright";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const rootDir = path.resolve(import.meta.dirname, "..");
const verificationDir = path.join(rootDir, "verification");
const screenshotDir = path.join(verificationDir, "playwright");
const resultPath = path.join(verificationDir, "a61-login-lock-audit-regression.json");
const frontendUrl = "http://127.0.0.1:5173/";
const batch = new Date().toISOString().replace(/\D/g, "").slice(0, 14);
const username = `a61u${batch.slice(8)}`;
const password = `A61-${batch.slice(8)}-ok`;
const wrongPassword = `A61-${batch.slice(8)}-bad`;

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
  await page.getByTestId("login-username").selectOption(usernameValue);
  await page.getByTestId("login-password").fill(passwordValue);
  await page.getByTestId("login-submit").click();
  await page.getByTestId("session-user-role").filter({ hasText: expectedRole }).waitFor({ state: "visible" });
}

const browser = await chromium.launch({ headless: true });
let lockedScreenshot = "";
try {
  const page = await browser.newPage({ viewport: { width: 1366, height: 768 } });
  await page.goto(frontendUrl, { waitUntil: "networkidle" });

  await loginAs(page, "admin", "admin123", "系统管理员");
  const createUser = await browserFetch(page, "/api/system/managed-users", {
    method: "POST",
    body: {
      username,
      displayName: "A61 锁定员工",
      roleCode: "WAREHOUSE",
      password,
      enabled: true
    }
  });
  assert(createUser.status === 200, `admin should create A61 user, got ${createUser.status}: ${createUser.text}`);

  await page.getByTestId("session-logout").click();
  await page.getByTestId("login-page").waitFor({ state: "visible" });
  await page.reload({ waitUntil: "networkidle" });
  await page.getByTestId("login-username").selectOption(username);
  await page.getByTestId("login-password").fill(wrongPassword);
  for (let index = 0; index < 4; index += 1) {
    await page.getByTestId("login-submit").click();
    await page.getByTestId("login-message").filter({ hasText: "密码" }).waitFor({ state: "visible" });
  }
  await page.getByTestId("login-submit").click();
  await page.getByTestId("login-message").filter({ hasText: "锁定" }).waitFor({ state: "visible" });
  lockedScreenshot = `a61-login-locked-${batch}.png`;
  await page.screenshot({ path: path.join(screenshotDir, lockedScreenshot), fullPage: true });

  await page.getByTestId("login-password").fill(password);
  await page.getByTestId("login-submit").click();
  await page.getByTestId("login-message").filter({ hasText: "锁定" }).waitFor({ state: "visible" });

  await page.getByTestId("login-username").selectOption("admin");
  await page.getByTestId("login-password").fill("admin123");
  await page.getByTestId("login-submit").click();
  await page.getByTestId("session-user-role").filter({ hasText: "系统管理员" }).waitFor({ state: "visible" });
  const logResponse = await browserFetch(page, `/api/lists/operation-log-list?keyword=${encodeURIComponent(username)}&page=1&pageSize=200`);
  assert(logResponse.status === 200, `operation log list should load, got ${logResponse.status}`);
  const logPayload = JSON.parse(logResponse.text);
  const rows = logPayload.rows ?? [];
  const loginFailures = rows.filter((row) => row.action === "LOGIN" && row.status === "失败");
  const lockRows = rows.filter((row) => row.action === "LOGIN_LOCKED" && row.status === "失败");
  assert(loginFailures.length >= 4, `expected at least 4 failed LOGIN rows, got ${loginFailures.length}`);
  assert(lockRows.length >= 1, `expected at least 1 LOGIN_LOCKED row, got ${lockRows.length}`);

  const result = {
    batch,
    generatedAt: new Date().toISOString(),
    username,
    failedLoginRows: loginFailures.length,
    lockedRows: lockRows.length,
    screenshot: `verification/playwright/${lockedScreenshot}`
  };
  await writeFile(resultPath, JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
} finally {
  await browser.close();
}
