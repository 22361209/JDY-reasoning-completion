import { chromium } from "playwright";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { loginAs as sharedLoginAs, logout as sharedLogout, openPasswordChange } from "./helpers/regression-auth.mjs";

const rootDir = path.resolve(import.meta.dirname, "..");
const verificationDir = path.join(rootDir, "verification");
const screenshotDir = path.join(verificationDir, "playwright");
const resultPath = path.join(verificationDir, "a67-cross-tab-session-regression.json");
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

const browser = await chromium.launch({ headless: true });
let beforeScreenshot = "";
let afterScreenshot = "";
try {
  const context = await browser.newContext({ viewport: { width: 1366, height: 768 } });
  const pageA = await context.newPage();
  await pageA.goto(frontendUrl, { waitUntil: "networkidle" });
  await sharedLoginAs(pageA, "admin", "admin123", "系统管理员");

  const pageB = await context.newPage();
  await pageB.goto(frontendUrl, { waitUntil: "networkidle" });
  await pageB.getByTestId("session-user-role").filter({ hasText: "系统管理员" }).waitFor({ state: "visible" });
  const sessionBeforeLogout = await browserFetch(pageB, "/api/system/session");
  assert(sessionBeforeLogout.status === 200, `second tab session should load, got ${sessionBeforeLogout.status}`);
  const sessionPayload = JSON.parse(sessionBeforeLogout.text);
  assert(sessionPayload.authenticated === true, "second tab should be authenticated before logout");

  beforeScreenshot = `a67-cross-tab-before-logout-${batch}.png`;
  await pageB.screenshot({ path: path.join(screenshotDir, beforeScreenshot), fullPage: true });

  await sharedLogout(pageA);
  await pageB.getByTestId("login-page").waitFor({ state: "visible" });
  await pageB.getByTestId("login-message").filter({ hasText: "已退出登录" }).waitFor({ state: "visible" });

  const invalidationMessage = await pageB.getByTestId("login-message").textContent();
  afterScreenshot = `a67-cross-tab-after-logout-${batch}.png`;
  await pageB.screenshot({ path: path.join(screenshotDir, afterScreenshot), fullPage: true });

  const protectedAfterLogout = await browserFetch(pageB, "/api/system/managed-users");
  assert(protectedAfterLogout.status === 401, `second tab protected API should be 401 after logout, got ${protectedAfterLogout.status}`);

  const result = {
    batch,
    generatedAt: new Date().toISOString(),
    sessionBeforeLogoutAuthenticated: sessionPayload.authenticated,
    protectedAfterLogoutStatus: protectedAfterLogout.status,
    message: invalidationMessage,
    screenshots: [
      `verification/playwright/${beforeScreenshot}`,
      `verification/playwright/${afterScreenshot}`
    ]
  };
  await writeFile(resultPath, JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
  await context.close();
} finally {
  await browser.close();
}
