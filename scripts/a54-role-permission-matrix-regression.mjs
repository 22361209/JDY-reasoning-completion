import { chromium } from "playwright";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { installApiSession, loginAsAdmin } from "./helpers/regression-auth.mjs";

const rootDir = path.resolve(import.meta.dirname, "..");
const verificationDir = path.join(rootDir, "verification");
const screenshotDir = path.join(verificationDir, "playwright");
const resultPath = path.join(verificationDir, "a54-role-permission-matrix-regression.json");
const frontendUrl = "http://127.0.0.1:5173/";
const apiBase = "http://127.0.0.1:8080";
await installApiSession(apiBase);
const batch = new Date().toISOString().replace(/\D/g, "").slice(0, 14);
const targetRoleCode = "WAREHOUSE";
const toggledPermission = "finance.settle";

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

function role(matrix, roleCode) {
  const found = matrix.roles.find((item) => item.code === roleCode);
  assert(found, `role ${roleCode} should exist`);
  return found;
}

function nextPermissions(originalPermissions) {
  const current = new Set(originalPermissions);
  if (current.has(toggledPermission)) {
    current.delete(toggledPermission);
  } else {
    current.add(toggledPermission);
  }
  return Array.from(current);
}

async function saveRolePermissions(roleCode, permissionCodes) {
  return requireJson(`/api/system/roles/${encodeURIComponent(roleCode)}/permissions`, {
    method: "PUT",
    body: { permissionCodes }
  });
}

const originalMatrix = await requireJson("/api/system/role-permissions");
assert(originalMatrix.permissions.some((item) => item.permissionCode === toggledPermission), "permission catalog should include finance.settle");
const originalRole = role(originalMatrix, targetRoleCode);
const originalPermissions = [...originalRole.permissionCodes];
const desiredPermissions = nextPermissions(originalPermissions);

const browser = await chromium.launch({ headless: true });
let savedMatrix;
let screenshot;
try {
  const page = await browser.newPage({ viewport: { width: 1366, height: 768 } });
  await page.goto(frontendUrl, { waitUntil: "networkidle" });
  await loginAsAdmin(page);
  await page.getByTestId("module-系统设置").hover();
  await page.getByTestId("entry-role-permission-settings").click();
  await page.getByTestId("role-permission-role-WAREHOUSE").click();
  const checkbox = page.getByTestId(`permission-check-${toggledPermission}`);
  await checkbox.waitFor({ state: "visible" });
  const beforeChecked = await checkbox.isChecked();
  assert(beforeChecked === originalPermissions.includes(toggledPermission), "frontend checkbox should match original role permissions");
  await checkbox.setChecked(!beforeChecked);
  await page.getByTestId("role-permission-save").click();
  await page.getByText("权限矩阵已保存").waitFor({ state: "visible" });

  savedMatrix = await requireJson("/api/system/role-permissions");
  const savedRole = role(savedMatrix, targetRoleCode);
  assert(savedRole.permissionCodes.includes(toggledPermission) === desiredPermissions.includes(toggledPermission), "saved permissions should persist toggled finance.settle");
  assert(savedRole.permissionCodes.length === desiredPermissions.length, "saved permission count should match desired permissions");

  screenshot = `a54-role-permission-matrix-${batch}.png`;
  await page.screenshot({ path: path.join(screenshotDir, screenshot), fullPage: true });
} finally {
  await browser.close();
  await saveRolePermissions(targetRoleCode, originalPermissions);
}

const restoredMatrix = await requireJson("/api/system/role-permissions");
const restoredRole = role(restoredMatrix, targetRoleCode);
assert(restoredRole.permissionCodes.length === originalPermissions.length, "role permissions should be restored after regression");
for (const permissionCode of originalPermissions) {
  assert(restoredRole.permissionCodes.includes(permissionCode), `restored permissions should include ${permissionCode}`);
}

const result = {
  batch,
  generatedAt: new Date().toISOString(),
  targetRoleCode,
  toggledPermission,
  originalPermissions,
  savedPermissions: role(savedMatrix, targetRoleCode).permissionCodes,
  restoredPermissions: restoredRole.permissionCodes,
  permissionCatalogCount: restoredMatrix.permissions.length,
  screenshot: `verification/playwright/${screenshot}`
};
await writeFile(resultPath, JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));
