#!/usr/bin/env node

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";

import {
  createIsolatedAdminSessionFixture,
  loginApi,
  logoutApiSession
} from "./helpers/regression-auth.mjs";

const rootDir = path.resolve(import.meta.dirname, "..");
const apiBase = "http://127.0.0.1:8080";
const frontendUrl = "http://127.0.0.1:5173/";
const verificationDir = path.join(rootDir, "verification");
const screenshotDir = path.join(verificationDir, "playwright");
const resultPath = path.join(verificationDir, "a162-purchase-publication-regression.json");
const batch = new Date().toISOString().replace(/\D/g, "").slice(0, 14);

const documents = [
  { id: "purchase-order-form", listId: "purchase-order-form-list", api: "/api/purchase-orders", permission: "purchase.order.audit", controller: "backend/src/main/java/com/jdy/erp/purchase/api/PurchaseOrderController.java", actions: ["saveDraft", "audit"] },
  { id: "purchase-in-form", listId: "purchase-in-form-list", api: "/api/purchase-ins", permission: "purchase.in.audit", controller: "backend/src/main/java/com/jdy/erp/purchase/api/PurchaseInController.java", actions: ["saveDraft", "audit", "reverse", "delete", "voidBill", "redReverse"] },
  { id: "purchase-return-form", listId: "purchase-return-form-list", api: "/api/purchase-returns", permission: "purchase.return.audit", controller: "backend/src/main/java/com/jdy/erp/purchase/api/PurchaseReturnController.java", actions: ["saveDraft", "audit", "reverse", "delete", "voidBill"] }
];

await mkdir(verificationDir, { recursive: true });
await mkdir(screenshotDir, { recursive: true });
const identity = createIsolatedAdminSessionFixture(apiBase, {
  label: "a162",
  // This flow owns both API and browser sessions for its unique fixture
  // identity. Browser shutdown may legitimately leave that identity's Redis
  // session for the fixture closer to remove; it must not turn an otherwise
  // complete, ownership-scoped cleanup into a false regression failure.
  allowForcedRedisRelease: true
});
let deniedRoleCookie = "";
let evidence = null;
let primaryError = null;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function request(cookie, pathname, options = {}) {
  const headers = new Headers(options.body === undefined ? undefined : { "Content-Type": "application/json" });
  if (cookie) headers.set("Cookie", cookie);
  const response = await fetch(`${apiBase}${pathname}`, {
    method: options.method ?? "GET",
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body)
  });
  return { status: response.status, text: await response.text() };
}

async function requireJson(pathname, options = {}) {
  const response = await fetch(`${apiBase}${pathname}`, {
    method: options.method ?? "GET",
    headers: options.body === undefined ? undefined : { "Content-Type": "application/json" },
    body: options.body === undefined ? undefined : JSON.stringify(options.body)
  });
  const text = await response.text();
  assert(response.ok, `${options.method ?? "GET"} ${pathname} failed ${response.status}: ${text}`);
  return text ? JSON.parse(text) : {};
}

function billNo(row, prefix, label) {
  const value = String(row?.billNo ?? "");
  assert(new RegExp(`^${prefix}\\d{6}$`).test(value), `${label} must return a ${prefix} system bill number: ${JSON.stringify(row)}`);
  return value;
}

async function assertLifecycleLog(document, targetType, targetNo, actions) {
  const query = new URLSearchParams({ keyword: targetNo, page: "1", pageSize: "100" });
  const response = await requireJson(`/api/lists/operation-log-list?${query}`);
  const rows = (response.rows ?? []).filter((row) => row.targetNo === targetNo && row.targetType === targetType && row.status === "成功");
  for (const action of actions) {
    assert(rows.some((row) => row.action === action), `${document} operation log missing ${action} for ${targetNo}: ${JSON.stringify(rows)}`);
  }
  return rows.map((row) => row.action);
}

async function ensureBrowserSession(page) {
  await page.goto(frontendUrl, { waitUntil: "networkidle" });
  const session = await page.evaluate(async () => {
    const response = await fetch("/api/system/session");
    return { status: response.status, body: await response.json() };
  }).catch((error) => ({ error: String(error) }));
  assert(
    session.status === 200
      && session.body?.authenticated === true
      && session.body?.user?.username === identity.username
      && session.body?.user?.roleCode === "ADMIN"
      && session.body?.tenant?.code === "BLD-TEST"
      && session.body?.tenant?.schemaName === "public",
    `purchase browser session mismatch: ${JSON.stringify(session)}`
  );
  assert(
    await page.getByTestId("content-area").isVisible({ timeout: 10000 }).catch(() => false),
    `purchase browser session did not render workspace: ${JSON.stringify(session)}`
  );
  return {
    username: session.body.user.username,
    roleCode: session.body.user.roleCode,
    accountSetCode: session.body.tenant.code,
    schemaName: session.body.tenant.schemaName
  };
}

async function openDocumentList(page, document) {
  const module = page.getByTestId("module-采购管理");
  await module.hover().catch(() => module.click());
  await page.getByTestId(`query-${document.id}`).click();
  await page.getByTestId(`tab-${document.listId}`).waitFor({ state: "visible", timeout: 10000 });
  await page.getByTestId("list-keyword").waitFor({ state: "visible", timeout: 10000 });
}

try {
await identity.installForApi("BLD-TEST");
evidence = { batch, generatedAt: new Date().toISOString(), staticGuards: [], deniedWrites: [], businessChain: {}, browser: [] };
deniedRoleCookie = await loginApi(apiBase, "finance", "finance123", "BLD-TEST");
for (const document of documents) {
  const source = await readFile(path.join(rootDir, document.controller), "utf8");
  for (const action of document.actions) {
    const permission = document.permission.replaceAll(".", "\\.");
    assert(new RegExp(`@RequirePermission\\(\\"${permission}\\"\\)[\\s\\S]{0,320}?\\b${action}\\s*\\(`).test(source), `${document.id} ${action} must require ${document.permission}`);
  }
  evidence.staticGuards.push({ id: document.id, permission: document.permission, actions: document.actions });

  const deniedDraft = await request(deniedRoleCookie, `${document.api}/draft`, { method: "POST", body: {} });
  const deniedAudit = await request(deniedRoleCookie, `${document.api}/A162-NOT-FOUND-${batch}/audit`, { method: "POST" });
  for (const [label, response] of [["draft", deniedDraft], ["audit", deniedAudit]]) {
    assert(response.status === 403, `${document.id} unauthorized ${label} must return 403, got ${response.status}: ${response.text}`);
    assert(response.text.includes(document.permission), `${document.id} denied ${label} must identify ${document.permission}`);
  }
  evidence.deniedWrites.push({ id: document.id, draftStatus: deniedDraft.status, auditStatus: deniedAudit.status });
}

const orderNo = billNo(await requireJson("/api/purchase-orders/draft", {
  method: "POST",
  body: {
    supplierCode: "GYS-001", billDate: "2026-06-30", department: "采购部", ownerName: "A162采购闭环",
    lines: [{ productCode: "CP-001", warehouseCode: "CK-001", qty: 2, unitPrice: 7, taxRate: 13, lineRemark: `A162-${batch}` }]
  }
}), "CGDD", "A162 purchase order");
await requireJson(`/api/purchase-orders/${encodeURIComponent(orderNo)}/audit`, { method: "POST" });
const inNo = billNo(await requireJson("/api/purchase-ins/draft", {
  method: "POST",
  body: {
    supplierCode: "GYS-001", billDate: "2026-06-30", department: "采购部", ownerName: "A162采购闭环", currency: "CNY",
    lines: [{ productCode: "CP-001", warehouseCode: "CK-001", sourceOrderNo: orderNo, sourceLineNo: 1, qty: 2, unitPrice: 7, taxRate: 13, lineRemark: `A162-${batch}` }]
  }
}), "CGRK", "A162 purchase in");
const orderBeforeInAudit = await requireJson(`/api/purchase-orders/${encodeURIComponent(orderNo)}`);
assert(Number(orderBeforeInAudit.lines?.[0]?.receivedQty) === 0, "purchase-in draft must not occupy purchase-order received quantity");
await requireJson(`/api/purchase-ins/${encodeURIComponent(inNo)}/audit`, { method: "POST" });
const orderAfterInAudit = await requireJson(`/api/purchase-orders/${encodeURIComponent(orderNo)}`);
assert(Number(orderAfterInAudit.lines?.[0]?.receivedQty) === 2 && Number(orderAfterInAudit.lines?.[0]?.remainingQty) === 0, "audited purchase-in must occupy exactly its source quantity");
const returnNo = billNo(await requireJson("/api/purchase-returns/draft", {
  method: "POST",
  body: {
    supplierCode: "GYS-001", billDate: "2026-06-30", department: "采购部", ownerName: "A162采购闭环", remark: `A162-${batch}`,
    lines: [{ productCode: "CP-001", warehouseCode: "CK-001", sourceOrderNo: inNo, sourceLineNo: 1, qty: 1, unitPrice: 7, taxRate: 13, lineRemark: `A162-${batch}` }]
  }
}), "CGTH", "A162 purchase return");
await requireJson(`/api/purchase-returns/${encodeURIComponent(returnNo)}/audit`, { method: "POST" });
await requireJson(`/api/purchase-returns/${encodeURIComponent(returnNo)}/reverse`, { method: "POST" });
const returnSelectable = await requireJson(`/api/purchase-returns/selectable-lines?supplierCode=${encodeURIComponent("GYS-001")}`);
const returnedSource = (returnSelectable.lines ?? []).find((line) => line.billNo === inNo && Number(line.lineNo) === 1);
assert(Number(returnedSource?.remainingQty) === 2, "purchase-return reverse must restore its source available quantity exactly once");
const blockedInReverse = await request("", `/api/purchase-ins/${encodeURIComponent(inNo)}/reverse`, { method: "POST" });
assert(blockedInReverse.status === 409 && blockedInReverse.text.includes("采购退货下游"), "audited-history purchase return must block purchase-in reverse even after return reverse");
evidence.businessChain = {
  orderNo, inNo, returnNo,
  sourceQuantities: { beforeInAudit: Number(orderBeforeInAudit.lines?.[0]?.receivedQty), afterInAudit: Number(orderAfterInAudit.lines?.[0]?.receivedQty), returnRemainingAfterReverse: Number(returnedSource?.remainingQty) },
  blockedInReverseStatus: blockedInReverse.status,
  operationLogs: {
    purchaseOrder: await assertLifecycleLog("purchase order", "purchase_order", orderNo, ["AUDIT"]),
    purchaseIn: await assertLifecycleLog("purchase in", "purchase_in", inNo, ["AUDIT"]),
    purchaseReturn: await assertLifecycleLog("purchase return", "purchase_return", returnNo, ["AUDIT", "REVERSE"])
  }
};

for (const viewport of [{ width: 1440, height: 900, name: "wide" }, { width: 390, height: 844, name: "narrow" }]) {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: viewport.width, height: viewport.height } });
  let browserCookie = "";
  let browserPrimaryError = null;
  try {
    browserCookie = await identity.installInBrowser(context, "BLD-TEST");
    for (const document of documents) {
      const page = await context.newPage();
      let pagePrimaryError = null;
      try {
        const session = await ensureBrowserSession(page);
        await openDocumentList(page, document);
        const screenshot = `a162-${viewport.name}-${document.id}-${batch}.png`;
        await page.screenshot({ path: path.join(screenshotDir, screenshot) });
        evidence.browser.push({ id: document.id, viewport: `${viewport.width}x${viewport.height}`, session, screenshot: `verification/playwright/${screenshot}` });
      } catch (error) {
        pagePrimaryError = error;
      }
      let pageCloseError = null;
      try {
        await page.close();
      } catch (error) {
        pageCloseError = error;
      }
      if (pagePrimaryError && pageCloseError) {
        throw new AggregateError(
          [pagePrimaryError, pageCloseError],
          `A162 page regression failed: ${pagePrimaryError instanceof Error ? pagePrimaryError.message : String(pagePrimaryError)}; close failed: ${pageCloseError instanceof Error ? pageCloseError.message : String(pageCloseError)}`
        );
      }
      if (pagePrimaryError) throw pagePrimaryError;
      if (pageCloseError) throw pageCloseError;
    }
  } catch (error) {
    browserPrimaryError = error;
  }
  const browserCleanupErrors = [];
  if (browserCookie) {
    try {
      await identity.logout(browserCookie);
    } catch (error) {
      browserCleanupErrors.push(error instanceof Error ? error.message : String(error));
    }
  }
  try {
    await browser.close();
  } catch (error) {
    browserCleanupErrors.push(error instanceof Error ? error.message : String(error));
  }
  if (browserPrimaryError) {
    if (browserCleanupErrors.length > 0) {
      throw new AggregateError(
        [browserPrimaryError, ...browserCleanupErrors.map((message) => new Error(message))],
        `A162 browser regression failed: ${browserPrimaryError instanceof Error ? browserPrimaryError.message : String(browserPrimaryError)}; cleanup failed: ${browserCleanupErrors.join("; ")}`
      );
    }
    throw browserPrimaryError;
  }
  if (browserCleanupErrors.length > 0) throw new Error(`A162 browser session cleanup failed: ${browserCleanupErrors.join("; ")}`);
}

} catch (error) {
  primaryError = error;
}

const cleanupErrors = [];
if (deniedRoleCookie) {
  try {
    await logoutApiSession(apiBase, deniedRoleCookie);
  } catch (error) {
    cleanupErrors.push(error instanceof Error ? error.message : String(error));
  }
}
try {
  await identity.cleanup();
} catch (error) {
  cleanupErrors.push(error instanceof Error ? error.message : String(error));
}
if (primaryError) {
  if (cleanupErrors.length > 0) {
    throw new AggregateError(
      [primaryError, ...cleanupErrors.map((message) => new Error(message))],
      `A162 regression failed: ${primaryError instanceof Error ? primaryError.message : String(primaryError)}; cleanup failed: ${cleanupErrors.join("; ")}`
    );
  }
  throw primaryError;
}
if (cleanupErrors.length > 0) throw new Error(`A162 session cleanup failed: ${cleanupErrors.join("; ")}`);
assert(evidence, "A162 regression completed without result evidence");
await writeFile(resultPath, JSON.stringify(evidence, null, 2));
console.log(JSON.stringify(evidence, null, 2));
