import { chromium } from "playwright";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const rootDir = path.resolve(import.meta.dirname, "..");
const verificationDir = path.join(rootDir, "verification");
const screenshotDir = path.join(verificationDir, "playwright");
const resultPath = path.join(verificationDir, "a59-formal-login-regression.json");
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

async function loginAs(page, username, password, expectedRole) {
  await page.getByTestId("login-page").waitFor({ state: "visible" });
  await page.getByTestId("login-username").selectOption(username);
  await page.getByTestId("login-password").fill(password);
  await page.getByTestId("login-submit").click();
  await page.getByTestId("session-user-role").filter({ hasText: expectedRole }).waitFor({ state: "visible" });
}

const browser = await chromium.launch({ headless: true });
let adminScreenshot = "";
let loginScreenshot = "";
let warehouseScreenshot = "";
try {
  const page = await browser.newPage({ viewport: { width: 1366, height: 768 } });
  await page.goto(frontendUrl, { waitUntil: "networkidle" });
  await page.getByTestId("login-page").waitFor({ state: "visible" });
  loginScreenshot = `a59-formal-login-page-${batch}.png`;
  await page.screenshot({ path: path.join(screenshotDir, loginScreenshot), fullPage: true });

  const preLoginManagedUsers = await browserFetch(page, "/api/system/managed-users");
  assert(preLoginManagedUsers.status === 401, `pre-login managed-users should be 401, got ${preLoginManagedUsers.status}`);

  await loginAs(page, "admin", "admin123", "系统管理员");
  await page.getByTestId("module-系统设置").hover();
  await page.getByTestId("entry-user-role-list").waitFor({ state: "visible" });
  const adminManagedUsers = await browserFetch(page, "/api/system/managed-users");
  assert(adminManagedUsers.status === 200, `admin managed-users should be 200, got ${adminManagedUsers.status}`);
  adminScreenshot = `a59-formal-login-admin-${batch}.png`;
  await page.screenshot({ path: path.join(screenshotDir, adminScreenshot), fullPage: true });

  await page.getByTestId("session-account-menu").click();
  await page.getByTestId("session-logout").click();
  await page.getByTestId("login-page").waitFor({ state: "visible" });
  const postLogoutManagedUsers = await browserFetch(page, "/api/system/managed-users");
  assert(postLogoutManagedUsers.status === 401, `post-logout managed-users should be 401, got ${postLogoutManagedUsers.status}`);

  await loginAs(page, "warehouse", "warehouse123", "仓库员");
  await page.getByTestId("module-系统设置").hover();
  await page.getByTestId("entry-user-role-list").waitFor({ state: "detached" });
  const warehouseManagedUsers = await browserFetch(page, "/api/system/managed-users");
  assert(warehouseManagedUsers.status === 403, `warehouse managed-users should be 403, got ${warehouseManagedUsers.status}`);
  warehouseScreenshot = `a59-formal-login-warehouse-${batch}.png`;
  await page.screenshot({ path: path.join(screenshotDir, warehouseScreenshot), fullPage: true });

  const result = {
    batch,
    generatedAt: new Date().toISOString(),
    preLoginManagedUsersStatus: preLoginManagedUsers.status,
    adminManagedUsersStatus: adminManagedUsers.status,
    postLogoutManagedUsersStatus: postLogoutManagedUsers.status,
    warehouseManagedUsersStatus: warehouseManagedUsers.status,
    screenshots: [
      `verification/playwright/${loginScreenshot}`,
      `verification/playwright/${adminScreenshot}`,
      `verification/playwright/${warehouseScreenshot}`
    ]
  };
  await writeFile(resultPath, JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
} finally {
  await browser.close();
}
