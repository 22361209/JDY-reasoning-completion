import { chromium } from "playwright";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { installApiSession, loginApi, loginAsAdmin } from "./helpers/regression-auth.mjs";

const rootDir = path.resolve(import.meta.dirname, "..");
const screenshotDir = path.join(rootDir, "verification/playwright");
const resultPath = path.join(rootDir, "verification/a104-document-lock-regression.json");
const frontendUrl = "http://127.0.0.1:5173/";
const apiBase = "http://127.0.0.1:8080";
const batch = new Date().toISOString().replace(/\D/g, "").slice(0, 14);
const billNo = `XSDD-A104-${batch}`;
const password = "A104pass123!";
const editorA = `a104a${batch.slice(-6)}`;
const editorB = `a104b${batch.slice(-6)}`;
const nativeFetch = globalThis.fetch.bind(globalThis);

await installApiSession(apiBase);
await mkdir(screenshotDir, { recursive: true });
await mkdir(path.dirname(resultPath), { recursive: true });

function assert(condition, message) {
  if (!condition) throw new Error(message);
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
  if (![200, 409].includes(result.status)) {
    throw new Error(`create user ${username} failed ${result.status}: ${result.text}`);
  }
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

await createUser(editorA, "A104编辑A");
await createUser(editorB, "A104编辑B");
await api("/api/sales-orders/draft", { body: salesOrderPayload(billNo, `seed-${batch}`) });

const sessionA = await loginApi(apiBase, editorA, password);
const sessionB = await loginApi(apiBase, editorB, password);

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

const browser = await chromium.launch({ headless: true });
const bContext = await browser.newContext({ viewport: { width: 1366, height: 768 } });
const adminContext = await browser.newContext({ viewport: { width: 1366, height: 768 } });
const bPage = await bContext.newPage();
const adminPage = await adminContext.newPage();
const readonlyScreenshot = `a104-readonly-${batch}.png`;
const overrideScreenshot = `a104-override-${batch}.png`;

try {
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
} finally {
  await browser.close();
}

const freshSessionB = await loginApi(apiBase, editorB, password);
const kickedAudit = await userFetch(freshSessionB, `/api/sales-orders/${encodeURIComponent(billNo)}/audit`, { expectFailure: true });
assert(kickedAudit.status === 423, `kicked B audit should be blocked with 423, got ${kickedAudit.status}: ${kickedAudit.text}`);
assert(kickedAudit.text.includes("锁已被"), `kicked B message should mention lock takeover: ${kickedAudit.text}`);

const releaseAdmin = await api(`/api/document-locks/salesOrder/${encodeURIComponent(billNo)}`, { method: "DELETE" });
assert(releaseAdmin.ok, `admin release should succeed: ${releaseAdmin.text}`);
const reacquireB = await userFetch(freshSessionB, `/api/document-locks/salesOrder/${encodeURIComponent(billNo)}/acquire`);
assert(reacquireB.ok && reacquireB.data?.readOnly === false, `B should acquire after release: ${reacquireB.text}`);
await userFetch(freshSessionB, `/api/document-locks/salesOrder/${encodeURIComponent(billNo)}`, { method: "DELETE" });

const result = {
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
    reacquireB: reacquireB.data
  },
  screenshots: [
    `verification/playwright/${readonlyScreenshot}`,
    `verification/playwright/${overrideScreenshot}`
  ]
};
await writeFile(resultPath, JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));
