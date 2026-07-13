import { chromium } from "playwright";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { loginAs as sharedLoginAs, logout as sharedLogout, openPasswordChange } from "./helpers/regression-auth.mjs";

const rootDir = path.resolve(import.meta.dirname, "..");
const verificationDir = path.join(rootDir, "verification");
const screenshotDir = path.join(verificationDir, "playwright");
const resultPath = path.join(verificationDir, "a68-single-active-session-regression.json");
const frontendUrl = "http://127.0.0.1:5173/";
const batch = new Date().toISOString().replace(/\D/g, "").slice(0, 14);
const username = `a68u${batch.slice(8)}`;
const password = `A68-${batch.slice(8)}-ok`;

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

const browser = await chromium.launch({ headless: true });
let beforeScreenshot = "";
let afterScreenshot = "";
let adminScreenshot = "";
try {
  const adminContext = await browser.newContext({ viewport: { width: 1366, height: 768 } });
  const adminPage = await adminContext.newPage();
  await adminPage.goto(frontendUrl, { waitUntil: "networkidle" });
  await loginAs(adminPage, "admin", "admin123", "系统管理员");
  const createUser = await browserFetch(adminPage, "/api/system/managed-users", {
    method: "POST",
    body: {
      username,
      displayName: "A68 重复登录员工",
      roleCode: "WAREHOUSE",
      password,
      enabled: true
    }
  });
  assert(createUser.status === 200, `admin should create A68 user, got ${createUser.status}: ${createUser.text}`);
  const createdUser = (JSON.parse(createUser.text).users ?? []).find((user) => user.username === username);
  assert(createdUser?.id, `created A68 user UUID should be returned: ${createUser.text}`);
  await sharedLogout(adminPage);
  await adminContext.close();

  const firstContext = await browser.newContext({ viewport: { width: 1366, height: 768 } });
  const firstPage = await firstContext.newPage();
  await firstPage.goto(frontendUrl, { waitUntil: "networkidle" });
  await loginAs(firstPage, username, password, "仓库员");
  const firstSessionBefore = await browserFetch(firstPage, "/api/system/session");
  assert(firstSessionBefore.status === 200, `first session should load, got ${firstSessionBefore.status}`);
  const firstSessionPayload = JSON.parse(firstSessionBefore.text);
  assert(firstSessionPayload.authenticated === true, "first context should be authenticated before repeated login");
  beforeScreenshot = `a68-before-repeated-login-${batch}.png`;
  await firstPage.screenshot({ path: path.join(screenshotDir, beforeScreenshot), fullPage: true });

  const secondContext = await browser.newContext({ viewport: { width: 1366, height: 768 } });
  const secondPage = await secondContext.newPage();
  await secondPage.goto(frontendUrl, { waitUntil: "networkidle" });
  await loginAs(secondPage, username, password, "仓库员");
  const secondSession = await browserFetch(secondPage, "/api/system/session");
  assert(secondSession.status === 200, `second session should load, got ${secondSession.status}`);
  const secondSessionPayload = JSON.parse(secondSession.text);
  assert(secondSessionPayload.authenticated === true, "second context should be authenticated after repeated login");

  const firstSessionAfter = await browserFetch(firstPage, "/api/system/session");
  assert(firstSessionAfter.status === 200, `first session endpoint should stay public, got ${firstSessionAfter.status}`);
  const firstSessionAfterPayload = JSON.parse(firstSessionAfter.text);
  assert(firstSessionAfterPayload.authenticated === false, "first context should be invalidated after repeated login");

  const protectedAfterReplace = await browserFetch(firstPage, "/api/system/managed-users");
  assert(protectedAfterReplace.status === 401, `old context protected API should be 401 after repeated login, got ${protectedAfterReplace.status}`);
  await firstPage.evaluate(() => window.dispatchEvent(new Event("focus")));
  await firstPage.getByTestId("login-page").waitFor({ state: "visible" });
  await firstPage.getByTestId("login-message").waitFor({ state: "visible" });
  const invalidationMessage = await firstPage.getByTestId("login-message").textContent();
  assert(invalidationMessage?.includes("登录"), `old context should show a login invalidation message, got ${invalidationMessage}`);
  afterScreenshot = `a68-after-repeated-login-${batch}.png`;
  await firstPage.screenshot({ path: path.join(screenshotDir, afterScreenshot), fullPage: true });

  const auditContext = await browser.newContext({ viewport: { width: 1366, height: 768 } });
  const auditPage = await auditContext.newPage();
  await auditPage.goto(frontendUrl, { waitUntil: "networkidle" });
  await loginAs(auditPage, "admin", "admin123", "系统管理员");
  await auditPage.getByTestId("module-系统设置").hover();
  await auditPage.getByTestId("entry-user-role-list").click();
  await auditPage.getByTestId(`managed-user-${username}`).click();
  await auditPage.getByTestId("managed-user-active-session").filter({ hasText: "在线" }).waitFor({ state: "visible" });
  const replacedText = await auditPage.getByTestId("managed-user-session-replaced").textContent();
  assert(replacedText && replacedText.trim() !== "-", "managed user page should show last session replaced time");
  adminScreenshot = `a68-managed-user-session-${batch}.png`;
  await auditPage.screenshot({ path: path.join(screenshotDir, adminScreenshot), fullPage: true });

  const logResponse = await browserFetch(auditPage, `/api/lists/operation-log-list?scope=platform&keyword=${encodeURIComponent(createdUser.id)}&page=1&pageSize=200`);
  assert(logResponse.status === 200, `operation log list should load, got ${logResponse.status}`);
  const logPayload = JSON.parse(logResponse.text);
  const replacedRows = (logPayload.rows ?? []).filter((row) => row.action === "LOGIN_REPLACED" && row.status === "成功");
  assert(replacedRows.length >= 1, `expected at least 1 LOGIN_REPLACED audit row, got ${replacedRows.length}`);

  const result = {
    batch,
    generatedAt: new Date().toISOString(),
    username,
    userId: createdUser.id,
    firstSessionBeforeAuthenticated: firstSessionPayload.authenticated,
    secondSessionAuthenticated: secondSessionPayload.authenticated,
    firstSessionAfterAuthenticated: firstSessionAfterPayload.authenticated,
    protectedAfterReplaceStatus: protectedAfterReplace.status,
    message: invalidationMessage,
    loginReplacedAuditRows: replacedRows.length,
    screenshots: [
      `verification/playwright/${beforeScreenshot}`,
      `verification/playwright/${afterScreenshot}`,
      `verification/playwright/${adminScreenshot}`
    ]
  };
  await writeFile(resultPath, JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
  await auditContext.close();
  await secondContext.close();
  await firstContext.close();
} finally {
  await browser.close();
}
