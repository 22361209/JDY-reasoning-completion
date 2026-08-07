import { chromium } from "playwright";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { loginAsAdmin as sharedLoginAsAdmin } from "./helpers/regression-auth.mjs";

const rootDir = path.resolve(import.meta.dirname, "..");
const verificationDir = path.join(rootDir, "verification");
const screenshotDir = path.join(verificationDir, "playwright");
const resultPath = path.join(verificationDir, "a119-account-set-switch-ui-regression.json");
const frontendUrl = "http://127.0.0.1:5173/";
const targetAccountSetCode = "A119UI";
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
  await sharedLoginAsAdmin(page);
}

async function ensureTargetAccountSet(page) {
  const accountSetsResponse = await browserFetch(page, "/api/system/account-sets");
  assert(accountSetsResponse.status === 200, `account sets should load, got ${accountSetsResponse.status}`);
  const accountSetsPayload = JSON.parse(accountSetsResponse.text);
  const existing = accountSetsPayload.accountSets?.some((accountSet) => accountSet.code === targetAccountSetCode);
  if (existing) {
    return false;
  }
  const createResponse = await browserFetch(page, "/api/system/account-sets", {
    method: "POST",
    body: {
      code: targetAccountSetCode,
      name: "A119 前端切换回归账套",
      environment: "前端回归",
      accountingPeriod: "2026-06",
      businessPeriod: "2026-06"
    }
  });
  assert(createResponse.status === 200, `target account set create should be 200, got ${createResponse.status}: ${createResponse.text}`);
  return true;
}

async function selectTargetFromUserMenu(page) {
  await page.getByTestId("session-account-menu").click();
  const accountSetSelect = page.getByTestId("account-menu-account-set");
  if (!(await accountSetSelect.isVisible())) {
    await page.locator("details.user-menu").evaluate((element) => {
      element.setAttribute("open", "");
    });
  }
  await accountSetSelect.waitFor({ state: "visible" });
  await accountSetSelect.selectOption(targetAccountSetCode);
}

const browser = await chromium.launch({ headless: true });
let beforeScreenshot = "";
let afterScreenshot = "";
try {
  const page = await browser.newPage({ viewport: { width: 1366, height: 768 } });
  await page.goto(frontendUrl, { waitUntil: "networkidle" });
  await loginAsAdmin(page);
  const createdTarget = await ensureTargetAccountSet(page);
  if (createdTarget) {
    await page.reload({ waitUntil: "networkidle" });
    await page.getByTestId("session-user-role").filter({ hasText: "系统管理员" }).waitFor({ state: "visible" });
  }

  await page.getByTestId("module-销售管理").hover();
  await page.getByTestId("entry-sales-order-form").click();
  await page.getByTestId("tab-sales-order-form").filter({ hasText: "销售订单" }).waitFor({ state: "visible" });
  beforeScreenshot = `a119-account-set-switch-dirty-${batch}.png`;
  await page.screenshot({ path: path.join(screenshotDir, beforeScreenshot), fullPage: true });

  await selectTargetFromUserMenu(page);
  let cancelDialogMessage = "";
  page.once("dialog", async (dialog) => {
    cancelDialogMessage = dialog.message();
    await dialog.dismiss();
  });
  await page.getByTestId("account-menu-switch-account-set").click();
  assert(cancelDialogMessage.includes("未保存页签"), `cancel dialog should mention dirty tabs, got: ${cancelDialogMessage}`);
  await page.getByTestId("tab-sales-order-form").waitFor({ state: "visible" });
  const cancelSessionResponse = await browserFetch(page, "/api/system/session");
  const cancelSession = JSON.parse(cancelSessionResponse.text);
  assert(cancelSession.tenant?.code === "BLD-TEST", `cancel should keep BLD-TEST session, got ${cancelSession.tenant?.code}`);

  await selectTargetFromUserMenu(page);
  let acceptDialogMessage = "";
  page.once("dialog", async (dialog) => {
    acceptDialogMessage = dialog.message();
    await dialog.accept();
  });
  await page.getByTestId("account-menu-switch-account-set").click();
  await page.waitForLoadState("networkidle");
  await page.getByTestId("home-account-set-summary").filter({ hasText: targetAccountSetCode }).waitFor({ state: "visible" });
  await page.getByTestId("tab-sales-order-form").waitFor({ state: "detached" });
  assert(acceptDialogMessage.includes("未保存页签"), `accept dialog should mention dirty tabs, got: ${acceptDialogMessage}`);
  afterScreenshot = `a119-account-set-switch-target-${batch}.png`;
  await page.screenshot({ path: path.join(screenshotDir, afterScreenshot), fullPage: true });

  const result = {
    batch,
    generatedAt: new Date().toISOString(),
    targetAccountSetCode,
    createdTarget,
    cancelDialogMessage,
    acceptDialogMessage,
    assertions: {
      cancelKeepsDirtySalesOrderTab: true,
      cancelKeepsOriginalAccountSet: cancelSession.tenant?.code === "BLD-TEST",
      acceptRefreshesBusinessTabsToHome: true,
      homeShowsTargetAccountSet: true
    },
    screenshots: [
      `verification/playwright/${beforeScreenshot}`,
      `verification/playwright/${afterScreenshot}`
    ]
  };
  await writeFile(resultPath, JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
} finally {
  await browser.close();
}
