import { chromium } from "playwright";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const rootDir = path.resolve(import.meta.dirname, "..");
const verificationDir = path.join(rootDir, "verification");
const screenshotDir = path.join(verificationDir, "playwright");
const resultPath = path.join(verificationDir, "a55-permission-driven-ui-regression.json");
const frontendUrl = "http://127.0.0.1:5173/";
const apiBase = "http://127.0.0.1:8080";
const batch = new Date().toISOString().replace(/\D/g, "").slice(0, 14);
const roleCode = "ADMIN";
const removedPermissions = ["sales.order.audit", "system.print_template.manage"];

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

async function saveRolePermissions(code, permissionCodes) {
  return requireJson(`/api/system/roles/${encodeURIComponent(code)}/permissions`, {
    method: "PUT",
    body: { permissionCodes }
  });
}

const originalMatrix = await requireJson("/api/system/role-permissions");
const originalPermissions = [...findRole(originalMatrix, roleCode).permissionCodes];
for (const permissionCode of removedPermissions) {
  assert(originalPermissions.includes(permissionCode), `original ADMIN permissions should include ${permissionCode}`);
}
const reducedPermissions = originalPermissions.filter((permissionCode) => !removedPermissions.includes(permissionCode));

let screenshot = "";
try {
  await saveRolePermissions(roleCode, reducedPermissions);
  const session = await requireJson("/api/system/session");
  for (const permissionCode of removedPermissions) {
    assert(!session.user.permissionCodes.includes(permissionCode), `session should not include ${permissionCode}`);
  }

  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1366, height: 768 } });
    await page.goto(frontendUrl, { waitUntil: "networkidle" });
    await page.getByTestId("module-销售管理").hover();
    await page.getByTestId("module-panel").waitFor({ state: "visible" });
    await page.getByTestId("entry-sales-out-form").waitFor({ state: "visible" });
    await page.getByTestId("entry-sales-order-form").waitFor({ state: "detached" });
    await page.getByTestId("module-系统设置").hover();
    await page.getByTestId("entry-role-permission-settings").waitFor({ state: "visible" });
    await page.getByTestId("entry-print-template-settings").waitFor({ state: "detached" });
    screenshot = `a55-permission-driven-ui-${batch}.png`;
    await page.screenshot({ path: path.join(screenshotDir, screenshot), fullPage: true });
  } finally {
    await browser.close();
  }
} finally {
  await saveRolePermissions(roleCode, originalPermissions);
}

const restoredSession = await requireJson("/api/system/session");
for (const permissionCode of removedPermissions) {
  assert(restoredSession.user.permissionCodes.includes(permissionCode), `restored session should include ${permissionCode}`);
}

const result = {
  batch,
  generatedAt: new Date().toISOString(),
  roleCode,
  removedPermissions,
  originalPermissionCount: originalPermissions.length,
  reducedPermissionCount: reducedPermissions.length,
  restoredPermissionCount: restoredSession.user.permissionCodes.length,
  screenshot: `verification/playwright/${screenshot}`
};
await writeFile(resultPath, JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));
