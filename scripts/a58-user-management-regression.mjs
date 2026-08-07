import { chromium } from "playwright";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { loginAs as sharedLoginAs, logout as sharedLogout, openPasswordChange } from "./helpers/regression-auth.mjs";

const rootDir = path.resolve(import.meta.dirname, "..");
const verificationDir = path.join(rootDir, "verification");
const screenshotDir = path.join(verificationDir, "playwright");
const resultPath = path.join(verificationDir, "a58-user-management-regression.json");
const frontendUrl = "http://127.0.0.1:5173/";
const batch = new Date().toISOString().replace(/\D/g, "").slice(0, 14);
const username = `a58u${batch.slice(8)}`;
const initialPassword = `A58-${batch.slice(8)}-old`;
const resetPassword = `A58-${batch.slice(8)}-new`;

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

async function logout(page) {
  await sharedLogout(page);
}

const browser = await chromium.launch({ headless: true });
let screenshot = "";
try {
  const page = await browser.newPage({ viewport: { width: 1366, height: 768 } });
  await page.goto(frontendUrl, { waitUntil: "networkidle" });
  await sharedLoginAs(page, "admin", "admin123", "系统管理员");
  await page.getByTestId("module-系统设置").hover();
  await page.getByTestId("entry-user-role-list").click();
  await page.getByTestId("user-management-new").click();
  await page.getByTestId("managed-user-username").fill(username);
  await page.getByTestId("managed-user-display-name").fill("A58 回归员工");
  await page.getByTestId("managed-user-role").selectOption("WAREHOUSE");
  await page.getByTestId("managed-user-password").fill(initialPassword);
  await page.getByTestId("user-management-save").click();
  await page.getByText("用户已保存").waitFor({ state: "visible" });
  await page.getByTestId(`managed-user-${username}`).waitFor({ state: "visible" });

  await logout(page);
  await page.reload({ waitUntil: "networkidle" });
  await sharedLoginAs(page, username, initialPassword, "仓库员");
  await page.getByTestId("session-user-name").filter({ hasText: "A58 回归员工" }).waitFor({ state: "visible" });
  const warehouseManagedUsers = await browserFetch(page, "/api/system/managed-users");
  assert(warehouseManagedUsers.status === 403, `managed user should not manage users, got ${warehouseManagedUsers.status}`);
  await page.getByTestId("module-系统设置").hover();
  await page.getByTestId("entry-user-role-list").waitFor({ state: "detached" });

  await logout(page);
  await sharedLoginAs(page, "admin", "admin123", "系统管理员");
  await page.getByTestId("module-系统设置").hover();
  await page.getByTestId("entry-user-role-list").click();
  await page.getByTestId(`managed-user-${username}`).click();
  await page.getByTestId("managed-user-password").fill(resetPassword);
  await page.getByTestId("managed-user-reset-password").click();
  await page.getByText("密码已重置").first().waitFor({ state: "visible" });

  await logout(page);
  await page.reload({ waitUntil: "networkidle" });
  await sharedLoginAs(page, username, resetPassword, "仓库员");
  await page.getByTestId("session-user-name").filter({ hasText: "A58 回归员工" }).waitFor({ state: "visible" });
  const switchedSession = await browserFetch(page, "/api/system/session");
  const sessionPayload = JSON.parse(switchedSession.text);
  assert(sessionPayload.user.username === username, "reset password should allow logging in as created user");
  assert(sessionPayload.user.roleCode === "WAREHOUSE", "created user should keep WAREHOUSE role");

  screenshot = `a58-user-management-${batch}.png`;
  await page.screenshot({ path: path.join(screenshotDir, screenshot), fullPage: true });

  const result = {
    batch,
    generatedAt: new Date().toISOString(),
    username,
    loginFlow: "formal-login",
    roleCode: sessionPayload.user.roleCode,
    warehouseManagedUsersStatus: warehouseManagedUsers.status,
    resetLoginUsername: sessionPayload.user.username,
    screenshot: `verification/playwright/${screenshot}`
  };
  await writeFile(resultPath, JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
} finally {
  await browser.close();
}
