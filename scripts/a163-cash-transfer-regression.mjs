#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";
import { installApiSession, installApiSessionInBrowser, loginApi } from "./helpers/regression-auth.mjs";

const rootDir = path.resolve(import.meta.dirname, "..");
const apiBase = "http://127.0.0.1:8080";
const frontendUrl = "http://127.0.0.1:5173/";
const batch = new Date().toISOString().replace(/\D/g, "").slice(0, 14);
const resultPath = path.join(rootDir, "verification/a163-cash-transfer-regression.json");
const screenshotDir = path.join(rootDir, "verification/playwright");
const accountCodes = { cnySource: `A163-CNY-S-${batch}`, cnyTarget: `A163-CNY-T-${batch}`, usd: `A163-USD-${batch}` };

function assert(condition, message) { if (!condition) throw new Error(message); }
async function request(cookie, pathname, options = {}) {
  const headers = new Headers(options.body === undefined ? undefined : { "Content-Type": "application/json" });
  if (cookie) headers.set("Cookie", cookie);
  const response = await fetch(`${apiBase}${pathname}`, { method: options.method ?? "GET", headers, body: options.body === undefined ? undefined : JSON.stringify(options.body) });
  const text = await response.text();
  return { status: response.status, text, data: text ? JSON.parse(text) : {} };
}
async function admin(pathname, options = {}) { const response = await request("", pathname, options); assert(response.status >= 200 && response.status < 300, `${options.method ?? "GET"} ${pathname} failed ${response.status}: ${response.text}`); return response.data; }
function scalar(sql) { return execFileSync("docker", ["exec", "jdy-erp-postgres", "psql", "-U", "jdy", "-d", "jdy_erp", "-At", "-c", sql], { encoding: "utf8" }).trim(); }
function schemaIdentifier(schema) { assert(/^[a-z][a-z0-9_]{0,62}$/.test(schema), `unsafe tenant schema: ${schema}`); return `"${schema}"`; }
function tenantScalar(schema, sql) { return scalar(`SET search_path TO ${schemaIdentifier(schema)}, public; ${sql}`).split("\n").at(-1); }
async function requireOk(cookie, pathname, options = {}) {
  const response = await request(cookie, pathname, options);
  assert(response.status >= 200 && response.status < 300, `${options.method ?? "GET"} ${pathname} failed ${response.status}: ${response.text}`);
  return response.data;
}
async function createAuditedAccount(cookie, code, name, currency) {
  const created = await requireOk(cookie, "/api/master-data/financialAccount", { method: "POST", body: { code, name, accountType: "CASH", currency, remark: `A163 ${batch}` } });
  await requireOk(cookie, `/api/master-data/financialAccount/${encodeURIComponent(code)}/audit`, { method: "POST" });
  return String(created.id);
}
async function lifecycleLog(cookie, billNo, action) {
  const response = await requireOk(cookie, `/api/lists/operation-log-list?${new URLSearchParams({ keyword: billNo, page: "1", pageSize: "100" })}`);
  assert((response.rows ?? []).some((row) => row.targetNo === billNo && row.targetType === "cash_transfer" && row.action === action && row.status === "成功"), `operation log missing ${action} for ${billNo}`);
}

await installApiSession(apiBase);
await mkdir(screenshotDir, { recursive: true });
const controller = await readFile(path.join(rootDir, "backend/src/main/java/com/jdy/erp/finance/api/CashTransferController.java"), "utf8");
for (const action of ["saveDraft", "audit", "reverse"]) assert(new RegExp(`@RequirePermission\\(\\"finance\\.cash_transfer\\.audit\\"\\)[\\s\\S]{0,260}?\\b${action}\\s*\\(`).test(controller), `${action} must require finance.cash_transfer.audit`);

const warehouseCookie = await loginApi(apiBase, "warehouse", "warehouse123", "BLD-TEST");
const deniedDraft = await request(warehouseCookie, "/api/cash-transfers/draft", { method: "POST", body: {} });
const deniedAudit = await request(warehouseCookie, `/api/cash-transfers/A163-${batch}/audit`, { method: "POST" });
for (const denied of [deniedDraft, deniedAudit]) assert(denied.status === 403 && denied.text.includes("finance.cash_transfer.audit"), `cash-transfer permission must fail closed: ${denied.status} ${denied.text}`);

const sourceId = await createAuditedAccount("", accountCodes.cnySource, "A163 CNY 转出", "CNY");
const targetId = await createAuditedAccount("", accountCodes.cnyTarget, "A163 CNY 转入", "CNY");
const usdId = await createAuditedAccount("", accountCodes.usd, "A163 USD 账户", "USD");
const zeroDraft = await admin("/api/cash-transfers/draft", { method: "POST", body: { billDate: "2026-07-16", sourceAccountId: sourceId, targetAccountId: targetId, amount: 0, remark: `A163 zero ${batch}` } });
const zeroNo = String(zeroDraft.billNo);
assert(scalar(`SELECT count(*) FROM public.cash_transfer_fact f JOIN public.cash_transfer t ON t.id=f.cash_transfer_id WHERE t.bill_no='${zeroNo}'`) === "0", "draft must not create cash facts");
const zeroAudit = await request("", `/api/cash-transfers/${encodeURIComponent(zeroNo)}/audit`, { method: "POST" });
assert(zeroAudit.status === 400 && zeroAudit.text.includes("必须大于 0"), `zero draft audit must be rejected: ${zeroAudit.text}`);
const crossCurrency = await request("", "/api/cash-transfers/draft", { method: "POST", body: { billDate: "2026-07-16", sourceAccountId: sourceId, targetAccountId: usdId, amount: 1 } });
assert(crossCurrency.status === 409 && crossCurrency.text.includes("同币种"), `cross-currency transfer must be rejected: ${crossCurrency.text}`);
const transfer = await admin("/api/cash-transfers/draft", { method: "POST", body: { billDate: "2026-07-16", sourceAccountId: sourceId, targetAccountId: targetId, amount: 12.5, remark: `A163 transfer ${batch}` } });
const billNo = String(transfer.billNo);
await admin(`/api/cash-transfers/${encodeURIComponent(billNo)}/audit`, { method: "POST" });
assert(scalar(`SELECT string_agg(amount_delta::text, ',' ORDER BY amount_delta) FROM public.cash_transfer_fact f JOIN public.cash_transfer t ON t.id=f.cash_transfer_id WHERE t.bill_no='${billNo}' AND posting_action='AUDIT'`) === "-12.50,12.50", "audit must create exact opposite same-currency facts");
const repeatAudit = await request("", `/api/cash-transfers/${encodeURIComponent(billNo)}/audit`, { method: "POST" });
assert(repeatAudit.status === 409, "repeated audit must be rejected");
await admin(`/api/cash-transfers/${encodeURIComponent(billNo)}/reverse`, { method: "POST" });
assert(scalar(`SELECT coalesce(sum(amount_delta), 0)::text FROM public.cash_transfer_fact f JOIN public.cash_transfer t ON t.id=f.cash_transfer_id WHERE t.bill_no='${billNo}'`) === "0.00", "reverse must restore the exact two-account net facts");
await lifecycleLog("", billNo, "AUDIT"); await lifecycleLog("", billNo, "REVERSE");

const concurrent = await admin("/api/cash-transfers/draft", { method: "POST", body: { billDate: "2026-07-16", sourceAccountId: sourceId, targetAccountId: targetId, amount: 7, remark: `A163 concurrent ${batch}` } });
const concurrentBillNo = String(concurrent.billNo);
const concurrentAudits = await Promise.all([
  request("", `/api/cash-transfers/${encodeURIComponent(concurrentBillNo)}/audit`, { method: "POST" }),
  request("", `/api/cash-transfers/${encodeURIComponent(concurrentBillNo)}/audit`, { method: "POST" })
]);
assert(concurrentAudits.map((response) => response.status).sort((left, right) => left - right).join(",") === "200,409", `concurrent audit must admit exactly one write: ${concurrentAudits.map((response) => response.status)}`);
assert(scalar(`SELECT count(*) FROM public.cash_transfer_fact f JOIN public.cash_transfer t ON t.id=f.cash_transfer_id WHERE t.bill_no='${concurrentBillNo}' AND posting_action='AUDIT'`) === "2", "concurrent audit must write exactly two facts once");
await admin(`/api/cash-transfers/${encodeURIComponent(concurrentBillNo)}/reverse`, { method: "POST" });

const tenantCode = "A119OPS-49F5546B";
const tenantCookie = await loginApi(apiBase, "admin", "admin123", tenantCode);
const tenantSession = await requireOk(tenantCookie, "/api/system/session");
const tenantSchema = String(tenantSession.tenant?.schemaName ?? "");
const tenantCodes = { source: `A163-T-S-${batch}`, target: `A163-T-T-${batch}` };
const tenantSourceId = await createAuditedAccount(tenantCookie, tenantCodes.source, "A163 tenant CNY 转出", "CNY");
const tenantTargetId = await createAuditedAccount(tenantCookie, tenantCodes.target, "A163 tenant CNY 转入", "CNY");
const tenantTransfer = await requireOk(tenantCookie, "/api/cash-transfers/draft", { method: "POST", body: { billDate: "2026-07-16", sourceAccountId: tenantSourceId, targetAccountId: tenantTargetId, amount: 3, remark: `A163 tenant ${batch}` } });
const tenantBillNo = String(tenantTransfer.billNo);
await requireOk(tenantCookie, `/api/cash-transfers/${encodeURIComponent(tenantBillNo)}/audit`, { method: "POST" });
assert(tenantScalar(tenantSchema, `SELECT count(*) FROM cash_transfer_fact f JOIN cash_transfer t ON t.id=f.cash_transfer_id WHERE t.bill_no='${tenantBillNo}' AND posting_action='AUDIT'`) === "2", "tenant transfer must write its two facts inside the routed tenant");
assert(scalar(`SELECT count(*) FROM public.cash_transfer WHERE id='${String(tenantTransfer.id)}'::uuid`) === "0", "tenant transfer must not leak into public schema");
await requireOk(tenantCookie, `/api/cash-transfers/${encodeURIComponent(tenantBillNo)}/reverse`, { method: "POST" });

const browserEvidence = [];
for (const viewport of [{ width: 1440, height: 900, name: "wide" }, { width: 390, height: 844, name: "narrow" }]) {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: viewport.width, height: viewport.height } });
  await installApiSessionInBrowser(context, apiBase, "admin", "admin123", "BLD-TEST");
  const page = await context.newPage();
  try {
    await page.goto(frontendUrl, { waitUntil: "networkidle" });
    const browserSession = await page.evaluate(async () => {
      const response = await fetch("/api/system/session");
      return { status: response.status, body: await response.json() };
    });
    assert(
      browserSession.status === 200
        && browserSession.body?.authenticated === true
        && browserSession.body?.user?.username === "admin"
        && browserSession.body?.user?.roleCode === "ADMIN"
        && browserSession.body?.tenant?.code === "BLD-TEST"
        && browserSession.body?.tenant?.schemaName === "public",
      `cash-transfer browser session mismatch: ${JSON.stringify(browserSession)}`
    );
    await page.getByTestId("module-应收应付").hover().catch(() => page.getByTestId("module-应收应付").click());
    await page.getByTestId("entry-cash-transfer-form").click();
    await page.getByTestId("cash-transfer-form").waitFor({ state: "visible" });
    const screenshot = `a163-${viewport.name}-cash-transfer-${batch}.png`;
    await page.screenshot({ path: path.join(screenshotDir, screenshot) });
    browserEvidence.push({
      viewport: `${viewport.width}x${viewport.height}`,
      session: {
        username: browserSession.body.user.username,
        roleCode: browserSession.body.user.roleCode,
        accountSetCode: browserSession.body.tenant.code,
        schemaName: browserSession.body.tenant.schemaName
      },
      screenshot: `verification/playwright/${screenshot}`
    });
  } finally { await browser.close(); }
}

const disabledAccounts = [];
for (const code of Object.values(accountCodes)) {
  await admin(`/api/master-data/financialAccount/${encodeURIComponent(code)}/status`, { method: "PATCH", body: { status: "禁用" } });
  assert(scalar(`SELECT enabled::text FROM public.md_financial_account WHERE code='${code}'`) === "false", `fixture account must be disabled after regression: ${code}`);
  disabledAccounts.push(code);
}
const tenantCleanupCookie = await loginApi(apiBase, "admin", "admin123", tenantCode);
for (const code of Object.values(tenantCodes)) {
  await requireOk(tenantCleanupCookie, `/api/master-data/financialAccount/${encodeURIComponent(code)}/status`, { method: "PATCH", body: { status: "禁用" } });
  assert(tenantScalar(tenantSchema, `SELECT enabled::text FROM md_financial_account WHERE code='${code}'`) === "false", `tenant fixture account must be disabled after regression: ${code}`);
  disabledAccounts.push(code);
}

const evidence = { ok: true, batch, billNo, accounts: accountCodes, deniedWrites: [deniedDraft.status, deniedAudit.status], facts: { audit: "-12.50,12.50", netAfterReverse: "0.00", concurrentAuditStatuses: concurrentAudits.map((response) => response.status).sort((left, right) => left - right) }, tenant: { code: tenantCode, billNo: tenantBillNo, schema: tenantSchema }, browser: browserEvidence, cleanup: { disabledAccounts } };
await writeFile(resultPath, `${JSON.stringify(evidence, null, 2)}\n`);
console.log(JSON.stringify(evidence, null, 2));
