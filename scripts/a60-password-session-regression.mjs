import { chromium } from "playwright";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const rootDir = path.resolve(import.meta.dirname, "..");
const verificationDir = path.join(rootDir, "verification");
const screenshotDir = path.join(verificationDir, "playwright");
const resultPath = path.join(verificationDir, "a60-password-session-regression.json");
const frontendUrl = "http://127.0.0.1:5173/";
const batch = new Date().toISOString().replace(/\D/g, "").slice(0, 14);
const username = `a60u${batch.slice(8)}`;
const oldPassword = `A60-${batch.slice(8)}-old`;
const newPassword = `A60-${batch.slice(8)}-new`;

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
let dialogScreenshot = "";
let expiredScreenshot = "";
try {
  const page = await browser.newPage({ viewport: { width: 1366, height: 768 } });
  await page.goto(frontendUrl, { waitUntil: "networkidle" });

  await loginAs(page, "admin", "admin123", "系统管理员");
  const createUser = await browserFetch(page, "/api/system/managed-users", {
    method: "POST",
    body: {
      username,
      displayName: "A60 改密员工",
      roleCode: "WAREHOUSE",
      password: oldPassword,
      enabled: true
    }
  });
  assert(createUser.status === 200, `admin should create A60 user, got ${createUser.status}: ${createUser.text}`);
  const weakReset = await browserFetch(page, `/api/system/managed-users/${encodeURIComponent(username)}/password`, {
    method: "PUT",
    body: { password: "weak" }
  });
  assert(weakReset.status === 400, `weak reset should be rejected with 400, got ${weakReset.status}`);

  await page.getByTestId("session-logout").click();
  await page.getByTestId("login-page").waitFor({ state: "visible" });
  await page.reload({ waitUntil: "networkidle" });
  await loginAs(page, username, oldPassword, "仓库员");
  await page.getByTestId("session-password-change").click();
  await page.getByTestId("password-change-dialog").waitFor({ state: "visible" });
  await page.getByTestId("password-current").fill(oldPassword);
  await page.getByTestId("password-new").fill("weak");
  await page.getByTestId("password-confirm").fill("weak");
  await page.getByTestId("password-submit").click();
  await page.getByTestId("password-message").filter({ hasText: "强度" }).waitFor({ state: "visible" });
  await page.getByTestId("password-new").fill(newPassword);
  await page.getByTestId("password-confirm").fill(newPassword);
  dialogScreenshot = `a60-password-dialog-${batch}.png`;
  await page.screenshot({ path: path.join(screenshotDir, dialogScreenshot), fullPage: true });
  await page.getByTestId("password-submit").click();
  await page.getByTestId("login-message").filter({ hasText: "密码已修改" }).waitFor({ state: "visible" });

  await page.getByTestId("login-username").selectOption(username);
  await page.getByTestId("login-password").fill(oldPassword);
  await page.getByTestId("login-submit").click();
  await page.getByTestId("login-message").filter({ hasText: "账号或密码不正确" }).waitFor({ state: "visible" });

  await loginAs(page, username, newPassword, "仓库员");
  await browserFetch(page, "/api/system/logout", { method: "POST" });
  const expiredProbe = await browserFetch(page, "/api/system/managed-users");
  assert(expiredProbe.status === 401, `expired protected API should be 401, got ${expiredProbe.status}`);
  await page.getByTestId("login-message").filter({ hasText: "登录已过期" }).waitFor({ state: "visible" });
  expiredScreenshot = `a60-session-expired-${batch}.png`;
  await page.screenshot({ path: path.join(screenshotDir, expiredScreenshot), fullPage: true });

  const result = {
    batch,
    generatedAt: new Date().toISOString(),
    username,
    weakResetStatus: weakReset.status,
    expiredProbeStatus: expiredProbe.status,
    screenshots: [
      `verification/playwright/${dialogScreenshot}`,
      `verification/playwright/${expiredScreenshot}`
    ]
  };
  await writeFile(resultPath, JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
} finally {
  await browser.close();
}
