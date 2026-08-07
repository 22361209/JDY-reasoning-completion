import { chromium } from "playwright";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { installApiSession, loginAs, logout } from "./helpers/regression-auth.mjs";

const rootDir = path.resolve(import.meta.dirname, "..");
const verificationDir = path.join(rootDir, "verification");
const screenshotDir = path.join(verificationDir, "playwright");
const resultPath = path.join(verificationDir, "a55-permission-driven-ui-regression.json");
const frontendUrl = "http://127.0.0.1:5173/";
const apiBase = "http://127.0.0.1:8080";
await installApiSession(apiBase);
const batch = new Date().toISOString().replace(/\D/g, "").slice(0, 14);
const roleCode = "WAREHOUSE";
const username = "warehouse";
const password = "warehouse123";
const expectedRoleName = "仓库员";
const allowedPermission = "sales.out.audit";
const deniedPermissions = ["sales.order.audit", "system.print_template.manage"];

await mkdir(screenshotDir, { recursive: true });

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

async function request(pathname, options = {}) {
  return fetch(`${apiBase}${pathname}`, {
    method: options.method ?? "GET",
    headers: options.body ? { "Content-Type": "application/json" } : undefined,
    body: options.body ? JSON.stringify(options.body) : undefined
  });
}

async function requireJson(pathname, options = {}) {
  const response = await request(pathname, options);
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`${options.method ?? "GET"} ${pathname} failed ${response.status}: ${text}`);
  }
  return text ? JSON.parse(text) : {};
}

function findRole(matrix, code) {
  const role = matrix.roles.find((item) => item.code === code);
  assert(role, `role ${code} should exist`);
  return role;
}

function samePermissionSet(left, right) {
  return JSON.stringify([...new Set(left)].sort()) === JSON.stringify([...new Set(right)].sort());
}

const originalMatrix = await requireJson("/api/system/role-permissions");
const originalAdminPermissions = [...findRole(originalMatrix, "ADMIN").permissionCodes];
const rolePermissions = [...findRole(originalMatrix, roleCode).permissionCodes];
assert(rolePermissions.includes(allowedPermission), `${roleCode} should include ${allowedPermission}`);
for (const permissionCode of deniedPermissions) {
  assert(originalAdminPermissions.includes(permissionCode), `original ADMIN permissions should include ${permissionCode}`);
  assert(!rolePermissions.includes(permissionCode), `${roleCode} should not include ${permissionCode}`);
}

let screenshot = "";
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1366, height: 768 } });
  await page.goto(frontendUrl, { waitUntil: "networkidle" });
  await loginAs(page, username, password, expectedRoleName, "BLD-TEST");
  const session = await page.evaluate(async () => {
    const response = await fetch("/api/system/session");
    return response.json();
  });
  assert(session?.authenticated === true, `${roleCode} browser session should be authenticated`);
  assert(session?.user?.username === username && session?.user?.roleCode === roleCode, `${roleCode} browser session identity mismatch`);
  assert(session?.tenant?.code === "BLD-TEST" && session?.tenant?.schemaName === "public", `${roleCode} browser session must stay in BLD-TEST/public`);
  assert(session.user.permissionCodes.includes(allowedPermission), `session should include ${allowedPermission}`);
  for (const permissionCode of deniedPermissions) {
    assert(!session.user.permissionCodes.includes(permissionCode), `session should not include ${permissionCode}`);
  }

  await page.getByTestId("module-销售管理").hover();
  await page.getByTestId("module-panel").waitFor({ state: "visible" });
  await page.getByTestId("entry-sales-out-form").waitFor({ state: "visible" });
  await page.getByTestId("entry-sales-order-form").waitFor({ state: "detached" });
  await page.getByTestId("module-系统设置").hover();
  await page.locator("[data-testid='module-panel'] .module-panel__header h1").filter({ hasText: "系统设置" }).waitFor({ state: "visible" });
  await page.getByTestId("entry-role-permission-settings").waitFor({ state: "detached" });
  await page.getByTestId("entry-print-template-settings").waitFor({ state: "detached" });
  screenshot = `a55-permission-driven-ui-${batch}.png`;
  await page.screenshot({ path: path.join(screenshotDir, screenshot), fullPage: true });
  await logout(page);
} finally {
  await browser.close();
}

const finalMatrix = await requireJson("/api/system/role-permissions");
const finalAdminPermissions = findRole(finalMatrix, "ADMIN").permissionCodes;
const finalRolePermissions = findRole(finalMatrix, roleCode).permissionCodes;
assert(samePermissionSet(finalAdminPermissions, originalAdminPermissions), "A55 must not change shared ADMIN permissions");
assert(samePermissionSet(finalRolePermissions, rolePermissions), `A55 must not change shared ${roleCode} permissions`);

const result = {
  batch,
  generatedAt: new Date().toISOString(),
  roleCode,
  username,
  allowedPermission,
  deniedPermissions,
  rolePermissionCount: rolePermissions.length,
  adminPermissionCount: originalAdminPermissions.length,
  sharedPermissionMatrixUnchanged: true,
  screenshot: `verification/playwright/${screenshot}`
};
await writeFile(resultPath, JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));
