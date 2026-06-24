import { chromium } from "playwright";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const rootDir = path.resolve(import.meta.dirname, "..");
const verificationDir = path.join(rootDir, "verification");
const screenshotDir = path.join(verificationDir, "playwright");
const resultPath = path.join(verificationDir, "a62-user-unlock-regression.json");
const frontendUrl = "http://127.0.0.1:5173/";
const batch = new Date().toISOString().replace(/\D/g, "").slice(0, 14);
const username = `a62u${batch.slice(8)}`;
const password = `A62-${batch.slice(8)}-ok`;
const wrongPassword = `A62-${batch.slice(8)}-bad`;

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
    return { status: response.status, ok: response.ok, text: await response.text() };
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
let unlockedScreenshot = "";
try {
  const page = await browser.newPage({ viewport: { width: 1366, height: 768 } });
  await page.goto(frontendUrl, { waitUntil: "networkidle" });

  await loginAs(page, "admin", "admin123", "系统管理员");
  const createUser = await browserFetch(page, "/api/system/managed-users", {
    method: "POST",
    body: {
      username,
      displayName: "A62 解锁员工",
      roleCode: "WAREHOUSE",
      password,
      enabled: true
    }
  });
  assert(createUser.status === 200, `admin should create A62 user, got ${createUser.status}: ${createUser.text}`);
  await page.getByTestId("session-logout").click();
  await page.getByTestId("login-page").waitFor({ state: "visible" });
  await page.reload({ waitUntil: "networkidle" });

  await page.getByTestId("login-username").selectOption(username);
  await page.getByTestId("login-password").fill(wrongPassword);
  for (let index = 0; index < 5; index += 1) {
    await page.getByTestId("login-submit").click();
  }
  await page.getByTestId("login-message").filter({ hasText: "锁定" }).waitFor({ state: "visible" });

  await page.getByTestId("login-username").selectOption("admin");
  await page.getByTestId("login-password").fill("admin123");
  await page.getByTestId("login-submit").click();
  await page.getByTestId("session-user-role").filter({ hasText: "系统管理员" }).waitFor({ state: "visible" });
  await page.getByTestId("module-系统设置").hover();
  await page.getByTestId("entry-user-role-list").click();
  await page.getByTestId(`managed-user-${username}`).click();
  await page.getByTestId("managed-user-lock-state").filter({ hasText: "已锁定" }).waitFor({ state: "visible" });
  lockedScreenshot = `a62-user-locked-${batch}.png`;
  await page.screenshot({ path: path.join(screenshotDir, lockedScreenshot), fullPage: true });
  await page.getByTestId("managed-user-unlock").click();
  await page.getByTestId("user-management-message").filter({ hasText: "账号锁定已解除" }).waitFor({ state: "visible" });
  await page.getByTestId("managed-user-lock-state").filter({ hasText: "未锁定" }).waitFor({ state: "visible" });
  unlockedScreenshot = `a62-user-unlocked-${batch}.png`;
  await page.screenshot({ path: path.join(screenshotDir, unlockedScreenshot), fullPage: true });

  await page.getByTestId("session-logout").click();
  await page.reload({ waitUntil: "networkidle" });
  await loginAs(page, username, password, "仓库员");

  await page.getByTestId("session-logout").click();
  await loginAs(page, "admin", "admin123", "系统管理员");
  const logResponse = await browserFetch(page, `/api/lists/operation-log-list?keyword=${encodeURIComponent(username)}&page=1&pageSize=200`);
  assert(logResponse.status === 200, `operation log list should load, got ${logResponse.status}`);
  const logPayload = JSON.parse(logResponse.text);
  const unlockRows = (logPayload.rows ?? []).filter((row) => row.action === "UNLOCK_USER" && row.status === "成功");
  assert(unlockRows.length >= 1, `expected at least 1 UNLOCK_USER row, got ${unlockRows.length}`);

  const result = {
    batch,
    generatedAt: new Date().toISOString(),
    username,
    unlockRows: unlockRows.length,
    screenshots: [
      `verification/playwright/${lockedScreenshot}`,
      `verification/playwright/${unlockedScreenshot}`
    ]
  };
  await writeFile(resultPath, JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
} finally {
  await browser.close();
}
