import { chromium } from "playwright";
import { randomBytes } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { installApiSession, loginApi, loginAsAdmin } from "./helpers/regression-auth.mjs";

const rootDir = path.resolve(import.meta.dirname, "..");
const screenshotDir = path.join(rootDir, "verification/playwright");
const resultPath = path.join(rootDir, "verification/a104-document-lock-regression.json");
const frontendUrl = "http://127.0.0.1:5173/";
const apiBase = "http://127.0.0.1:8080";
const batch = new Date().toISOString().replace(/\D/g, "").slice(0, 14);
const runSuffix = randomBytes(4).toString("hex");
let billNo = "";
const password = `A104-${randomBytes(8).toString("hex")}!`;
const editorA = `a104a${batch}${runSuffix}`;
const editorB = `a104b${batch}${runSuffix}`;
const nativeFetch = globalThis.fetch.bind(globalThis);
const userSpecs = [
  { username: editorA, displayName: "A104编辑A" },
  { username: editorB, displayName: "A104编辑B" }
];
const creationAttempts = new Set();
let usersConfirmedAbsent = false;
let sessionA = "";
let sessionB = "";
let freshSessionB = "";
let browser;
const cleanupState = { lockClear: false, loggedOutUsers: [], disabledUsers: [] };

await installApiSession(apiBase);
await mkdir(screenshotDir, { recursive: true });
await mkdir(path.dirname(resultPath), { recursive: true });

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function generatedSalesOrderNo(row, label) {
  const value = String(row?.billNo ?? "");
  assert(/^XSDD\d{6}$/.test(value), `${label} should return a system sales order number, got ${JSON.stringify(row)}`);
  return value;
}

async function api(pathname, options = {}) {
  const response = await fetch(`${apiBase}${pathname}`, {
    method: options.method ?? "POST",
    headers: options.body ? { "Content-Type": "application/json" } : undefined,
    body: options.body ? JSON.stringify(options.body) : undefined
  });
  const text = await response.text();
  const data = text ? JSON.parse(text) : null;
  if (!response.ok && !options.expectFailure) {
    throw new Error(`${options.method ?? "POST"} ${pathname} failed ${response.status}: ${text}`);
  }
  return { status: response.status, ok: response.ok, data, text };
}

async function createUser(username, displayName) {
  creationAttempts.add(username);
  const result = await api("/api/system/managed-users", {
    body: {
      username,
      displayName,
      roleCode: "ADMIN",
      password,
      enabled: true
    },
    expectFailure: true
  });
  if (result.status === 409) {
    throw new Error(`unique A104 user ${username} unexpectedly exists; refusing to reuse it: ${result.text}`);
  }
  assert(result.ok, `create user ${username} failed ${result.status}: ${result.text}`);
}

async function managedUsers() {
  const result = await api("/api/system/managed-users", { method: "GET" });
  assert(result.ok && Array.isArray(result.data?.users), `managed user list should load: ${result.status} ${result.text}`);
  return result.data.users;
}

async function assertRunUsersAbsent() {
  const users = await managedUsers();
  for (const { username } of userSpecs) {
    assert(!users.some((user) => user.username === username), `unique A104 user should not exist before creation: ${username}`);
  }
  usersConfirmedAbsent = true;
}

async function disableCreatedUser(username, displayName) {
  if (!usersConfirmedAbsent || !creationAttempts.has(username)) {
    return;
  }
  const before = await managedUsers();
  if (!before.some((user) => user.username === username)) {
    return;
  }
  const result = await api(`/api/system/managed-users/${encodeURIComponent(username)}`, {
    method: "PUT",
    body: { displayName, roleCode: "ADMIN", enabled: false }
  });
  assert(result.ok, `disable created user ${username} failed ${result.status}: ${result.text}`);
  const disabled = Array.isArray(result.data?.users)
    ? result.data.users.find((user) => user.username === username)
    : (await managedUsers()).find((user) => user.username === username);
  assert(disabled?.enabled === false, `created user ${username} should be disabled during cleanup`);
  assert(disabled?.activeSession === false, `disabled A104 user ${username} must not retain an active session`);
  cleanupState.disabledUsers.push(username);
}

async function logoutCreatedUser(username, sessionCookie) {
  if (!sessionCookie) {
    return;
  }
  const logout = await userFetch(sessionCookie, "/api/system/logout", { method: "POST" });
  assert(logout.ok && logout.data?.ok === true, `logout created user ${username} failed ${logout.status}: ${logout.text}`);
  const user = (await managedUsers()).find((item) => item.username === username);
  assert(user?.activeSession === false, `logout should clear the active session for ${username}`);
  cleanupState.loggedOutUsers.push(username);
}

async function userFetch(sessionCookie, pathname, options = {}) {
  const response = await nativeFetch(`${apiBase}${pathname}`, {
    method: options.method ?? "POST",
    headers: {
      Cookie: sessionCookie,
      ...(options.body ? { "Content-Type": "application/json" } : {})
    },
    body: options.body ? JSON.stringify(options.body) : undefined
  });
  const text = await response.text();
  return { status: response.status, ok: response.ok, data: text ? JSON.parse(text) : null, text };
}

async function finishCleanup(primaryError, cleanupTasks) {
  const cleanupErrors = [];
  for (const task of cleanupTasks) {
    try {
      await task();
    } catch (error) {
      cleanupErrors.push(error);
    }
  }
  if (cleanupErrors.length === 0) {
    return;
  }
  if (primaryError) {
    for (const error of cleanupErrors) {
      console.error(`A104 cleanup failed after primary error: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
    }
    return;
  }
  throw cleanupErrors[0];
}

async function cleanupDocumentLock() {
  if (!billNo) {
    cleanupState.lockClear = true;
    return;
  }
  const pathname = `/api/document-locks/salesOrder/${encodeURIComponent(billNo)}`;
  const releaseAttempts = [];
  const userSessions = [
    ["editor B", freshSessionB || sessionB],
    ["editor A", sessionA]
  ];
  for (const [label, sessionCookie] of userSessions) {
    if (!sessionCookie) {
      continue;
    }
    try {
      const release = await userFetch(sessionCookie, pathname, { method: "DELETE" });
      releaseAttempts.push({ label, status: release.status, released: release.data?.released === true });
    } catch (error) {
      releaseAttempts.push({ label, error: error instanceof Error ? error.message : String(error) });
    }
  }
  try {
    const release = await api(pathname, { method: "DELETE", expectFailure: true });
    releaseAttempts.push({ label: "admin", status: release.status, released: release.data?.released === true });
  } catch (error) {
    releaseAttempts.push({ label: "admin", error: error instanceof Error ? error.message : String(error) });
  }
  const status = await api(pathname, { method: "GET" });
  assert(
    status.ok && !status.data?.holderUsername && !status.data?.expiresAt,
    `A104 cleanup should leave no document lock: ${JSON.stringify({ status: status.data, releaseAttempts })}`
  );
  cleanupState.lockClear = true;
}

function salesOrderPayload(no, remark) {
  return {
    billNo: no,
    customerCode: "KH-001",
    billDate: "2026-06-26",
    department: "销售部",
    ownerName: "本地管理员",
    remark,
    lines: [{ productCode: "CP-001", warehouseCode: "CK-001", qty: 2, unitPrice: 86, lineRemark: remark }]
  };
}

const readonlyScreenshot = `a104-readonly-${batch}.png`;
const overrideScreenshot = `a104-override-${batch}.png`;
let result;
let primaryError;
try {
  await assertRunUsersAbsent();
  await createUser(editorA, "A104编辑A");
  await createUser(editorB, "A104编辑B");
  const seededOrder = await api("/api/sales-orders/draft", { body: salesOrderPayload(null, `seed-${batch}`) });
  assert(seededOrder.ok, `seed sales order should succeed: ${seededOrder.text}`);
  billNo = generatedSalesOrderNo(seededOrder.data, "A104 sales order");

  sessionA = await loginApi(apiBase, editorA, password);
  sessionB = await loginApi(apiBase, editorB, password);

  const acquireA = await userFetch(sessionA, `/api/document-locks/salesOrder/${encodeURIComponent(billNo)}/acquire`);
  assert(acquireA.ok && acquireA.data?.readOnly === false, `A should acquire editable lock: ${acquireA.text}`);

  const acquireB = await userFetch(sessionB, `/api/document-locks/salesOrder/${encodeURIComponent(billNo)}/acquire`);
  assert(acquireB.ok && acquireB.data?.readOnly === true, `B should be readonly: ${acquireB.text}`);
  assert(String(acquireB.data?.holderName ?? "").includes("A104编辑A"), `B readonly holder should be A: ${acquireB.text}`);

  const blockedSave = await userFetch(sessionB, "/api/sales-orders/draft", {
    body: salesOrderPayload(billNo, `blocked-${batch}`),
    expectFailure: true
  });
  assert(blockedSave.status === 423, `B save should be blocked with 423, got ${blockedSave.status}: ${blockedSave.text}`);
  assert(blockedSave.text.includes("锁已被A104编辑A夺取，已转只读"), `B save should report the document-lock owner: ${blockedSave.text}`);

  browser = await chromium.launch({ headless: true });
  const bContext = await browser.newContext({ viewport: { width: 1366, height: 768 } });
  const adminContext = await browser.newContext({ viewport: { width: 1366, height: 768 } });
  const bPage = await bContext.newPage();
  const adminPage = await adminContext.newPage();

  await bPage.goto(frontendUrl, { waitUntil: "networkidle" });
  await bPage.getByTestId("login-username").fill(editorB);
  await bPage.getByTestId("login-password").fill(password);
  await bPage.getByTestId("login-submit").click();
  await bPage.getByTestId("content-area").waitFor({ state: "visible", timeout: 10000 });
  await bPage.getByTestId("module-销售管理").hover();
  await bPage.getByTestId("query-sales-order-form").click();
  await bPage.getByTestId("list-keyword").fill(billNo);
  await bPage.getByTestId("list-query").click();
  await bPage.getByTestId(`open-document-${billNo}`).click();
  await bPage.getByTestId("lock-banner").waitFor({ state: "visible" });
  const bReadonlyBanner = await bPage.getByTestId("lock-banner").innerText();
  const bSaveDisabled = await bPage.getByTestId("save-sales-order").isDisabled();
  assert(bReadonlyBanner.includes("已被 A104编辑A 打开，只读"), `B readonly banner mismatch: ${bReadonlyBanner}`);
  assert(bSaveDisabled, "B readonly form should disable save");

  await adminPage.goto(frontendUrl, { waitUntil: "networkidle" });
  await loginAsAdmin(adminPage);
  await adminPage.getByTestId("module-销售管理").hover();
  await adminPage.getByTestId("query-sales-order-form").click();
  await adminPage.getByTestId("list-keyword").fill(billNo);
  await adminPage.getByTestId("list-query").click();
  await adminPage.getByTestId(`open-document-${billNo}`).click();
  await adminPage.getByTestId("lock-banner").waitFor({ state: "visible" });
  const readonlyBanner = await adminPage.getByTestId("lock-banner").innerText();
  const saveDisabled = await adminPage.getByTestId("save-sales-order").isDisabled();
  const auditDisabled = await adminPage.getByTestId("audit-sales-order").isDisabled();
  const deleteDisabled = await adminPage.getByTestId("delete-sales-order").isDisabled();
  const overrideVisible = await adminPage.getByTestId("override-document-lock").isVisible();
  assert(readonlyBanner.includes("已被 A104编辑A 打开，只读"), `readonly banner mismatch: ${readonlyBanner}`);
  assert(saveDisabled && auditDisabled && deleteDisabled, "readonly mode should disable write actions");
  assert(overrideVisible, "admin should see override button");
  await adminPage.screenshot({ path: path.join(screenshotDir, readonlyScreenshot), fullPage: true });

  await adminPage.getByTestId("override-document-lock").click();
  await adminPage.waitForFunction(() => !document.querySelector('[data-testid="lock-banner"]'));
  const saveEnabledAfterOverride = !(await adminPage.getByTestId("save-sales-order").isDisabled());
  assert(saveEnabledAfterOverride, "override should switch admin to editable mode");
  await adminPage.screenshot({ path: path.join(screenshotDir, overrideScreenshot), fullPage: true });

  freshSessionB = await loginApi(apiBase, editorB, password);
  const kickedAudit = await userFetch(freshSessionB, `/api/sales-orders/${encodeURIComponent(billNo)}/audit`, { expectFailure: true });
  assert(kickedAudit.status === 423, `kicked B audit should be blocked with 423, got ${kickedAudit.status}: ${kickedAudit.text}`);
  assert(kickedAudit.text.includes("锁已被本地管理员夺取，已转只读"), `kicked B message should report the admin lock owner: ${kickedAudit.text}`);

  const lockPath = `/api/document-locks/salesOrder/${encodeURIComponent(billNo)}`;
  const releaseAdmin = await api(lockPath, { method: "DELETE" });
  assert(releaseAdmin.ok && releaseAdmin.data?.released === true, `admin release should remove its lock: ${releaseAdmin.text}`);
  const reacquireB = await userFetch(freshSessionB, `${lockPath}/acquire`);
  assert(reacquireB.ok && reacquireB.data?.readOnly === false, `B should acquire after release: ${reacquireB.text}`);
  const releaseB = await userFetch(freshSessionB, lockPath, { method: "DELETE" });
  assert(releaseB.ok && releaseB.data?.released === true, `B final release should remove its lock: ${releaseB.text}`);

  result = {
    batch,
    generatedAt: new Date().toISOString(),
    ok: true,
    billNo,
    users: { editorA, editorB },
    assertions: [
      "B 打开被 A 持锁单据进入只读",
      "只读模式禁用保存/审核/删除等写动作",
      "管理员拥有 document.lock.override 时可踢走并夺锁",
      "被踢者再写入返回 423 并提示锁已被夺",
      "释放后其他用户可重新取锁编辑"
    ],
    api: {
      acquireA: acquireA.data,
      acquireB: acquireB.data,
      blockedSaveStatus: blockedSave.status,
      kickedAuditStatus: kickedAudit.status,
      releaseAdmin: releaseAdmin.data,
      reacquireB: reacquireB.data,
      releaseB: releaseB.data
    },
    cleanup: cleanupState,
    screenshots: [
      `verification/playwright/${readonlyScreenshot}`,
      `verification/playwright/${overrideScreenshot}`
    ]
  };
} catch (error) {
  primaryError = error;
  throw error;
} finally {
  await finishCleanup(primaryError, [
    async () => {
      if (browser) {
        await browser.close();
      }
    },
    cleanupDocumentLock,
    () => logoutCreatedUser(editorA, sessionA),
    () => logoutCreatedUser(editorB, freshSessionB || sessionB),
    () => disableCreatedUser(editorA, "A104编辑A"),
    () => disableCreatedUser(editorB, "A104编辑B")
  ]);
}

assert(result, "A104 result should exist after a successful lock flow");
assert(cleanupState.lockClear, "A104 cleanup should confirm the document lock is clear");
assert(cleanupState.loggedOutUsers.length === 2, `A104 cleanup should logout both created users: ${JSON.stringify(cleanupState.loggedOutUsers)}`);
assert(cleanupState.disabledUsers.length === 2, `A104 cleanup should disable both created users: ${JSON.stringify(cleanupState.disabledUsers)}`);
await writeFile(resultPath, JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));
