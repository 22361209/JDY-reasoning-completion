#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";

import { loginAsAdmin } from "./helpers/regression-auth.mjs";

const rootDir = path.resolve(import.meta.dirname, "..");
const verificationDir = path.join(rootDir, "verification");
const screenshotDir = path.join(verificationDir, "playwright");
const resultPath = path.join(verificationDir, "a186-permission-masterdata-regression.json");
const frontendUrl = process.env.JDY_WEB_BASE || "http://127.0.0.1:5173/";
const runId = randomUUID();
const runShort = runId.replaceAll("-", "").slice(0, 12).toUpperCase();
const roleCode = `A186_SETTLE_${runShort}`;
const roleName = `A186 仅结算 ${runShort}`;
const username = `a186ui${runShort.toLowerCase()}`;
const supplier = {
  id: randomUUID(),
  systemNo: `A186-SYS-LEAK-${runShort}`,
  code: `GYS-A186-${runShort}`,
  name: `A186 供应商 ${runShort}`,
  contact: `A186-CONTACT-LEAK-${runShort}`,
  phone: "13900000000",
  status: "启用",
  auditStatus: "已审核"
};

await mkdir(verificationDir, { recursive: true });
await mkdir(screenshotDir, { recursive: true });

function assert(condition, message, details) {
  if (!condition) {
    const suffix = details === undefined ? "" : `: ${JSON.stringify(details)}`;
    throw new Error(`${message}${suffix}`);
  }
}

function errorText(error) {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

function deferred(label) {
  let resolve;
  let released = false;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return {
    label,
    promise,
    release(value) {
      if (!released) {
        released = true;
        resolve(value);
      }
    }
  };
}

async function fulfillJson(route, payload, status = 200) {
  await route.fulfill({
    status,
    contentType: "application/json",
    body: JSON.stringify(payload)
  });
}

function listPayload(rows, url) {
  return {
    page: Number(url.searchParams.get("page") || 1),
    pageSize: Number(url.searchParams.get("pageSize") || 100),
    total: rows.length,
    rows
  };
}

async function currentSession(page) {
  return page.evaluate(async () => {
    const response = await fetch("/api/system/session");
    if (!response.ok) {
      throw new Error(`session request failed: ${response.status}`);
    }
    return response.json();
  });
}

async function openEntry(page, moduleName, entryId) {
  await page.getByTestId(`module-${moduleName}`).hover();
  await page.getByTestId(`entry-${entryId}`).click();
  await page.getByTestId(`tab-${entryId}`).waitFor({ state: "visible", timeout: 10000 });
  // App intentionally suppresses module navigation for 250ms after every open.
  await page.waitForTimeout(275);
}

function roleMatrix(includeCreatedRole = false) {
  const permissions = [
    { permissionCode: "finance.settle", moduleName: "资金", permissionName: "收付款结算", sortNo: 10 },
    { permissionCode: "master.data.manage", moduleName: "基础资料", permissionName: "基础资料维护", sortNo: 20 },
    { permissionCode: "system.role_permission.manage", moduleName: "系统", permissionName: "角色权限维护", sortNo: 30 }
  ];
  const roles = [
    {
      id: randomUUID(),
      code: "ADMIN",
      name: "系统管理员",
      enabled: true,
      permissionCodes: permissions.map((permission) => permission.permissionCode)
    },
    {
      id: randomUUID(),
      code: "WAREHOUSE",
      name: "仓库",
      enabled: true,
      permissionCodes: []
    }
  ];
  if (includeCreatedRole) {
    roles.push({
      id: randomUUID(),
      code: roleCode,
      name: roleName,
      enabled: true,
      permissionCodes: ["finance.settle"]
    });
  }
  return { permissions, roles };
}

function managedUsersPayload(accountSetCode, includeCreatedUser) {
  const alternateCode = accountSetCode === "UAT20260810" ? "BLD-TEST" : "UAT20260810";
  const accountSets = [
    { code: alternateCode, name: `非当前账套 ${alternateCode}`, environment: "TEST", initialized: true },
    { code: accountSetCode, name: `当前账套 ${accountSetCode}`, environment: "TEST", initialized: true }
  ];
  const users = [{
    id: randomUUID(),
    username: "admin",
    displayName: "管理员",
    roleCode: "ADMIN",
    roleName: "系统管理员",
    enabled: true,
    accountSetCodes: accountSets.map((item) => item.code).join(","),
    defaultAccountSetCode: accountSetCode,
    failedLoginCount: 0,
    locked: false,
    activeSession: true
  }];
  if (includeCreatedUser) {
    users.push({
      id: randomUUID(),
      username,
      displayName: `A186 仅结算用户 ${runShort}`,
      roleCode,
      roleName,
      enabled: true,
      accountSetCodes: accountSetCode,
      defaultAccountSetCode: accountSetCode,
      failedLoginCount: 0,
      locked: false,
      activeSession: false
    });
  }
  return {
    users,
    roles: [
      { code: "ADMIN", name: "系统管理员", enabled: true },
      { code: "WAREHOUSE", name: "仓库", enabled: true },
      { code: roleCode, name: roleName, enabled: true }
    ],
    accountSets,
    passwordResetRequests: [],
    notificationOutbox: []
  };
}

const refreshSeen = deferred("role refresh request");
const refreshRelease = deferred("role refresh release");
const evidence = {
  taskId: "A186-4",
  runId,
  generatedAt: new Date().toISOString(),
  ok: false,
  accountSetCode: "",
  checks: {},
  requests: {
    rolePermissionGets: 0,
    roleCreates: [],
    managedUserCreates: [],
    supplierSelectorGets: 0,
    unexpectedWrites: []
  },
  screenshots: [],
  error: ""
};

let browser;
let primaryError;
let closeError;

try {
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1803, height: 960 } });
  const page = await context.newPage();
  await page.goto(frontendUrl, { waitUntil: "networkidle" });
  await loginAsAdmin(page);
  const session = await currentSession(page);
  const accountSetCode = String(session?.tenant?.code ?? "").trim();
  assert(accountSetCode, "authenticated session must expose the current account set", session);
  evidence.accountSetCode = accountSetCode;

  let roleCreated = false;
  let userCreated = false;

  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const method = request.method();

    if (method === "GET" && url.pathname === "/api/system/role-permissions") {
      evidence.requests.rolePermissionGets += 1;
      if (evidence.requests.rolePermissionGets === 2) {
        refreshSeen.release(true);
        await refreshRelease.promise;
      }
      await fulfillJson(route, roleMatrix(roleCreated));
      return;
    }
    if (method === "POST" && url.pathname === "/api/system/roles") {
      const body = request.postDataJSON();
      evidence.requests.roleCreates.push(body);
      roleCreated = true;
      await fulfillJson(route, roleMatrix(true), 201);
      return;
    }
    if (method === "GET" && url.pathname === "/api/system/managed-users") {
      await fulfillJson(route, managedUsersPayload(accountSetCode, userCreated));
      return;
    }
    if (method === "POST" && url.pathname === "/api/system/managed-users") {
      const body = request.postDataJSON();
      const { password, ...safeBody } = body;
      evidence.requests.managedUserCreates.push({
        ...safeBody,
        passwordLength: String(password ?? "").length
      });
      userCreated = true;
      await fulfillJson(route, managedUsersPayload(accountSetCode, true));
      return;
    }
    if (method === "GET" && url.pathname === "/api/system/current-account-employee-links") {
      await fulfillJson(route, { employeeLinks: [] });
      return;
    }
    if (method === "GET" && url.pathname === "/api/system/notification-outbox") {
      await fulfillJson(route, { notificationOutbox: [] });
      return;
    }
    if (method === "GET" && url.pathname.startsWith("/api/lists/")) {
      await fulfillJson(route, listPayload([], url));
      return;
    }
    if (method === "GET" || method === "HEAD") {
      await route.continue();
      return;
    }
    evidence.requests.unexpectedWrites.push(`${method} ${url.pathname}`);
    await route.abort("blockedbyclient");
  });

  await openEntry(page, "系统设置", "role-permission-settings");
  await page.getByTestId("role-permission-role-ADMIN").waitFor({ state: "visible", timeout: 10000 });
  await page.getByTestId("role-permission-new").click();
  await page.getByTestId("role-create-code").waitFor({ state: "visible", timeout: 10000 });
  assert(await page.getByTestId("role-create-code").evaluate((element) => document.activeElement === element),
    "role code must receive focus when create starts");
  await page.getByTestId("role-create-code").fill(roleCode);
  await page.getByTestId("role-create-name").fill(roleName);
  await page.getByTestId("permission-check-finance.settle").check();
  await page.getByTestId("role-permission-refresh").click();
  await refreshSeen.promise;
  assert((await page.getByTestId("role-permission-summary").innerText()).includes("CREATE"),
    "create mode must remain visible while refresh is pending");
  assert(await page.getByTestId("permission-check-finance.settle").isChecked(),
    "refresh must not copy ADMIN permissions over the create draft");
  refreshRelease.release(true);
  await page.waitForFunction(() => !(document.querySelector('[data-testid="role-permission-refresh"]')?.disabled));
  assert((await page.getByTestId("role-permission-summary").innerText()).includes("CREATE"),
    "refresh completion must preserve create mode");
  assert(await page.getByTestId("permission-check-finance.settle").isChecked(),
    "refresh completion must preserve the selected minimal permission");
  assert(!(await page.getByTestId("permission-check-master.data.manage").isChecked()),
    "refresh completion must not copy ADMIN master permission");
  await page.getByTestId("role-permission-save").click();
  await page.getByTestId(`role-permission-role-${roleCode}`).waitFor({ state: "visible", timeout: 10000 });
  assert((await page.getByTestId("role-permission-summary").innerText()).includes(roleCode),
    "created role must become the selected edit role");
  assert(evidence.requests.roleCreates.length === 1, "role create must issue exactly one write", evidence.requests.roleCreates);
  assert(JSON.stringify(evidence.requests.roleCreates[0]) === JSON.stringify({
    code: roleCode,
    name: roleName,
    permissionCodes: ["finance.settle"]
  }), "role create payload must contain only finance.settle", evidence.requests.roleCreates[0]);
  evidence.checks.minimalRoleCreate = true;
  evidence.checks.createRefreshDoesNotCloneAdmin = true;

  await openEntry(page, "系统设置", "user-role-list");
  await page.getByTestId("managed-user-admin").waitFor({ state: "visible", timeout: 10000 });
  await page.getByTestId("user-management-new").click();
  await page.getByTestId("managed-user-username").waitFor({ state: "visible", timeout: 10000 });
  assert(await page.getByTestId("managed-user-username").evaluate((element) => document.activeElement === element),
    "managed username must receive focus when create starts");
  assert(await page.getByTestId(`managed-user-account-set-${accountSetCode}`).isChecked(),
    "new user must default to the current account set", accountSetCode);
  const alternateAccountSetCode = accountSetCode === "UAT20260810" ? "BLD-TEST" : "UAT20260810";
  assert(!(await page.getByTestId(`managed-user-account-set-${alternateAccountSetCode}`).isChecked()),
    "new user must not default to an unrelated account set", alternateAccountSetCode);
  assert(await page.getByTestId("managed-user-default-account-set").inputValue() === accountSetCode,
    "new user default account set must match the current account set");
  const coreFields = page.getByTestId("user-management-core-fields");
  for (const testId of [
    "managed-user-username",
    "managed-user-display-name",
    "managed-user-role",
    "managed-user-enabled",
    "managed-user-account-sets",
    "managed-user-default-account-set",
    "managed-user-password"
  ]) {
    assert(await coreFields.getByTestId(testId).count() === 1,
      "managed user create controls must stay grouped in the core field section", testId);
  }
  await page.getByTestId("managed-user-username").fill(username);
  await page.getByTestId("managed-user-display-name").fill(`A186 仅结算用户 ${runShort}`);
  await page.getByTestId("managed-user-role").selectOption(roleCode);
  await page.getByTestId("managed-user-password").fill("A186-Ui-123!");
  await page.getByTestId("user-management-save").click();
  await page.getByTestId(`managed-user-${username}`).waitFor({ state: "visible", timeout: 10000 });
  assert(evidence.requests.managedUserCreates.length === 1,
    "managed user create must issue exactly one write", evidence.requests.managedUserCreates);
  const userPayload = evidence.requests.managedUserCreates[0];
  assert(userPayload.roleCode === roleCode, "managed user must use the new minimal role", userPayload);
  assert(JSON.stringify(userPayload.accountSetCodes) === JSON.stringify([accountSetCode]),
    "managed user must receive only the current account set", userPayload);
  assert(userPayload.defaultAccountSetCode === accountSetCode,
    "managed user default account set must be current", userPayload);
  assert(userPayload.passwordLength === 12 && !("password" in userPayload),
    "managed user evidence must prove a password was supplied without persisting it", userPayload);
  evidence.checks.userFieldsVisibleAndFocused = true;
  evidence.checks.currentAccountSetDefaulted = true;

  const extraSystemEntries = [
    "account-set-settings",
    "numbering-rule-settings",
    "security-settings",
    "notification-provider-settings",
    "operation-log-list",
    "print-template-settings"
  ];
  for (const entryId of extraSystemEntries) {
    await openEntry(page, "系统设置", entryId);
  }
  const masterEntries = [
    "product-master-list",
    "product-name-list",
    "product-category-list",
    "unit-master-list",
    "customer-master-list",
    "supplier-master-list",
    "warehouse-master-list",
    "production-department-list",
    "employee-master-list"
  ];
  for (const entryId of masterEntries) {
    await openEntry(page, "基础资料", entryId);
  }
  await openEntry(page, "库存管理", "inventory-query-list");
  await openEntry(page, "基础资料", "financial-account-master-list");
  assert(await page.getByTestId("work-tabs").locator(".work-tab").count() === 20,
    "fixture must reach the exact 20-tab limit");
  await page.getByTestId("list-create").click();
  await page.getByTestId("tab-overflow-modal").waitFor({ state: "visible", timeout: 10000 });
  assert(await page.getByTestId("tab-financial-account-master-list").getAttribute("class").then((value) => value?.includes("active")),
    "overflow must keep the financial account list active");
  assert(await page.getByTestId("tab-financial-account-master-list:create").count() === 0,
    "overflow must not create a hidden master record tab");
  assert(await page.getByTestId("master-record-page").count() === 0,
    "overflow must not render a ghost master record");
  const overflowScreenshot = path.join(screenshotDir, `a186-tab-overflow-${runShort}.png`);
  await page.screenshot({ path: overflowScreenshot, fullPage: true });
  evidence.screenshots.push(path.relative(rootDir, overflowScreenshot));
  await page.getByTestId("tab-overflow-modal").getByRole("button", { name: "确定" }).click();
  await page.getByTestId("close-role-permission-settings").click();
  await page.getByTestId("tab-role-permission-settings").waitFor({ state: "detached", timeout: 10000 });
  await page.getByTestId("list-create").click();
  await page.getByTestId("tab-financial-account-master-list:create").waitFor({ state: "visible", timeout: 10000 });
  await page.getByTestId("master-record-page").waitFor({ state: "visible", timeout: 10000 });
  assert(await page.getByTestId("tab-overflow-modal").count() === 0,
    "retry after freeing a tab must not reopen overflow");
  evidence.checks.twentyTabOverflowHasNoGhost = true;
  evidence.checks.retryAfterFreeingTabOpensMasterRecord = true;

  const shellScreenshot = path.join(screenshotDir, `a186-permission-masterdata-${runShort}.png`);
  await page.screenshot({ path: shellScreenshot, fullPage: true });
  evidence.screenshots.push(path.relative(rootDir, shellScreenshot));
  await page.close();

  const selectorPage = await context.newPage();
  await selectorPage.goto(frontendUrl, { waitUntil: "networkidle" });
  await loginAsAdmin(selectorPage);
  await selectorPage.route("**/api/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (request.method() === "GET" && url.pathname === "/api/lists/supplier-master-selector") {
      evidence.requests.supplierSelectorGets += 1;
      await fulfillJson(route, listPayload([supplier], url));
      return;
    }
    if (request.method() === "GET" && url.pathname.startsWith("/api/lists/")) {
      await fulfillJson(route, listPayload([], url));
      return;
    }
    if (request.method() === "GET" || request.method() === "HEAD") {
      await route.continue();
      return;
    }
    evidence.requests.unexpectedWrites.push(`${request.method()} ${url.pathname}`);
    await route.abort("blockedbyclient");
  });
  await openEntry(selectorPage, "采购管理", "purchase-order-form");
  await selectorPage.getByTestId("purchase-party-open-selector").click();
  const selectorDialog = selectorPage.getByTestId("master-selector-source-selector-dialog");
  await selectorDialog.waitFor({ state: "visible", timeout: 10000 });
  await selectorPage.getByTestId(`master-selector-source-line-${supplier.code}`).waitFor({ state: "visible", timeout: 10000 });
  const tableCore = selectorPage.getByTestId("master-selector-source-selector-table-core");
  const columnFields = await tableCore.locator("[data-column-field]").evaluateAll((nodes) =>
    nodes.map((node) => node.getAttribute("data-column-field")));
  assert(JSON.stringify(columnFields) === JSON.stringify(["selection", "code", "name"]),
    "supplier selector must render one selection control plus exactly code and name business columns", columnFields);
  const businessColumnFields = columnFields.filter((field) => field !== "selection");
  assert(JSON.stringify(businessColumnFields) === JSON.stringify(["code", "name"]),
    "supplier selector business columns must be exactly code and name", businessColumnFields);
  const headerText = (await tableCore.locator(".vxe-table--header-wrapper").innerText()).replaceAll(/\s+/g, " ").trim();
  assert(headerText.includes("供应商编码") && headerText.includes("供应商名称"),
    "supplier selector must expose code and name columns", headerText);
  assert(!headerText.includes("联系人") && !headerText.includes("电话") && !headerText.includes("系统编号"),
    "supplier selector must not expose inherited sensitive or unavailable columns", headerText);
  assert(await selectorPage.getByTestId("master-selector-source-selector-column-filter-code").count() === 1,
    "supplier selector must expose the code filter");
  assert(await selectorPage.getByTestId("master-selector-source-selector-column-filter-name").count() === 1,
    "supplier selector must expose the name filter");
  for (const field of ["systemNo", "contact", "phone"]) {
    assert(await selectorPage.getByTestId(`master-selector-source-selector-column-filter-${field}`).count() === 0,
      "supplier selector must not expose a filter for an inherited field", field);
  }
  const dialogText = await selectorDialog.innerText();
  for (const leak of [supplier.systemNo, supplier.contact, supplier.phone]) {
    assert(!dialogText.includes(leak), "supplier selector must not render sensitive bait fields", leak);
  }
  assert(evidence.requests.supplierSelectorGets >= 1, "supplier dialog must request supplier-master-selector");
  evidence.checks.supplierSelectorMinimalColumns = { columnFields, businessColumnFields, headerText };
  const selectorScreenshot = path.join(screenshotDir, `a186-supplier-selector-${runShort}.png`);
  await selectorPage.screenshot({ path: selectorScreenshot, fullPage: true });
  evidence.screenshots.push(path.relative(rootDir, selectorScreenshot));
  await selectorPage.close();

  assert(evidence.requests.unexpectedWrites.length === 0,
    "browser regression must not leak unmocked writes", evidence.requests.unexpectedWrites);
  evidence.ok = true;
} catch (error) {
  primaryError = error;
  evidence.error = errorText(error);
} finally {
  refreshRelease.release(true);
  if (browser) {
    try {
      await browser.close();
    } catch (error) {
      closeError = error;
      evidence.error = evidence.error || errorText(error);
    }
  }
  evidence.completedAt = new Date().toISOString();
  await writeFile(resultPath, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
}

if (primaryError || closeError) {
  throw new AggregateError([primaryError, closeError].filter(Boolean), evidence.error || "A186 permission/master-data regression failed");
}

console.log(JSON.stringify({ ok: true, resultPath, runId, checks: evidence.checks }, null, 2));
