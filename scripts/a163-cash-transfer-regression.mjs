#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
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
const batch = `${new Date().toISOString().replace(/\D/g, "").slice(0, 14)}-${randomUUID().replaceAll("-", "").slice(0, 8)}`;
const resultPath = path.join(rootDir, "verification/a163-cash-transfer-regression.json");
const screenshotDir = path.join(rootDir, "verification/playwright");
const accountCodes = { cnySource: `A163-CNY-S-${batch}`, cnyTarget: `A163-CNY-T-${batch}`, usd: `A163-USD-${batch}` };
const snapshotCodes = Object.fromEntries(["A", "B", "C", "D"].map((suffix) => [suffix.toLowerCase(), `A184-SNAP-${batch}-${suffix}`]));
const tenantCode = "A119OPS-49F5546B";
const tenantCodes = { source: `A163-T-S-${batch}`, target: `A163-T-T-${batch}` };
const transferOnlyFixture = {
  roleCode: `A183CT-${batch}`,
  username: `a183ct-${batch}`,
  password: `A183ct-${batch}!`
};

function assert(condition, message) { if (!condition) throw new Error(message); }
async function request(cookie, pathname, options = {}) {
  const headers = new Headers(options.body === undefined ? undefined : { "Content-Type": "application/json" });
  if (cookie) headers.set("Cookie", cookie);
  const response = await fetch(`${apiBase}${pathname}`, { method: options.method ?? "GET", headers, body: options.body === undefined ? undefined : JSON.stringify(options.body) });
  const text = await response.text();
  return { status: response.status, text, data: text ? JSON.parse(text) : {} };
}
async function admin(pathname, options = {}) { const response = await request("", pathname, options); assert(response.status >= 200 && response.status < 300, `${options.method ?? "GET"} ${pathname} failed ${response.status}: ${response.text}`); return response.data; }
function scalar(sql) { return execFileSync("docker", ["exec", "jdy-erp-postgres", "psql", "-X", "-v", "ON_ERROR_STOP=1", "-U", "jdy", "-d", "jdy_erp", "-qAt", "-c", sql], { encoding: "utf8" }).trim(); }
function sqlLiteral(value) { return `'${String(value).replaceAll("'", "''")}'`; }
function schemaIdentifier(schema) { assert(/^[a-z][a-z0-9_]{0,62}$/.test(schema), `unsafe tenant schema: ${schema}`); return `"${schema}"`; }
function tenantScalar(schema, sql) { return scalar(`SET search_path TO ${schemaIdentifier(schema)}, public; ${sql}`).split("\n").at(-1); }
async function requireOk(cookie, pathname, options = {}) {
  const response = await request(cookie, pathname, options);
  assert(response.status >= 200 && response.status < 300, `${options.method ?? "GET"} ${pathname} failed ${response.status}: ${response.text}`);
  return response.data;
}
async function createAuditedAccount(cookie, code, name, currency, ownership) {
  const remark = `A163 ${batch}`;
  ownership.set(code, { id: "", remark });
  const created = await requireOk(cookie, "/api/master-data/financialAccount", { method: "POST", body: { code, name, accountType: "CASH", currency, remark } });
  const id = String(created.id ?? "");
  assert(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id), `created financial account must return an owned UUID: ${code}`);
  ownership.set(code, { id, remark });
  await requireOk(cookie, `/api/master-data/financialAccount/${encodeURIComponent(code)}/audit`, { method: "POST" });
  return id;
}
async function lifecycleLog(cookie, billNo, action) {
  const response = await requireOk(cookie, `/api/lists/operation-log-list?${new URLSearchParams({ keyword: billNo, page: "1", pageSize: "100" })}`);
  assert((response.rows ?? []).some((row) => row.targetNo === billNo && row.targetType === "cash_transfer" && row.action === action && row.status === "成功"), `operation log missing ${action} for ${billNo}`);
}

const globalActorOrphanBaseline = Number(scalar(`
  SELECT count(*)
  FROM public.sys_operation_log log_row
  LEFT JOIN public.sys_user user_row ON user_row.id=log_row.operated_by
  WHERE log_row.operated_by IS NOT NULL AND user_row.id IS NULL
`));
assert(globalActorOrphanBaseline === 0, `A163 global actor orphan baseline must be zero before fixture creation, got ${globalActorOrphanBaseline}`);
await mkdir(screenshotDir, { recursive: true });
const identity = createIsolatedAdminSessionFixture(apiBase, {
  label: "a163",
  accountSetCodes: ["BLD-TEST", tenantCode],
  defaultAccountSetCode: "BLD-TEST",
  // The fixture alone owns the cross-account-set sessions opened by this
  // regression; its closer may safely release only those Redis sessions.
  allowForcedRedisRelease: true
});
let warehouseCookie = "";
let transferOnlyCookie = "";
let tenantSchema = "";
const disabledAccounts = [];
const publicOwnedAccountIds = new Map();
const tenantOwnedAccountIds = new Map();
let permissionEvidence = null;
let transferOnlyOwnership = null;
let evidence = null;
let primaryError = null;
try {
await identity.installForApi("BLD-TEST");
const fixtureResidue = Number(scalar(`
  SELECT (SELECT count(*) FROM public.sys_role WHERE code=${sqlLiteral(transferOnlyFixture.roleCode)})
       + (SELECT count(*) FROM public.sys_user WHERE username=${sqlLiteral(transferOnlyFixture.username)})
`));
assert(fixtureResidue === 0, "A183 transfer-only role fixture must start without residue");
const fixtureRows = Number(scalar(`
  BEGIN;
  INSERT INTO public.sys_role (code, name, enabled)
  VALUES (${sqlLiteral(transferOnlyFixture.roleCode)}, 'A183 资金转账最小权限', TRUE);
  INSERT INTO public.sys_permission (role_id, permission_code, enabled)
  SELECT id, 'finance.cash_transfer.audit', TRUE
  FROM public.sys_role WHERE code=${sqlLiteral(transferOnlyFixture.roleCode)};
  INSERT INTO public.sys_user (username, display_name, password_hash, enabled, default_account_set_id)
  SELECT ${sqlLiteral(transferOnlyFixture.username)}, 'A183 资金转账最小权限用户', ${sqlLiteral(`{noop}${transferOnlyFixture.password}`)}, TRUE, id
  FROM public.sys_account_set WHERE code='BLD-TEST' AND enabled=TRUE;
  INSERT INTO public.sys_user_role (user_id, role_id)
  SELECT app_user.id, role_row.id
  FROM public.sys_user app_user
  JOIN public.sys_role role_row ON role_row.code=${sqlLiteral(transferOnlyFixture.roleCode)}
  WHERE app_user.username=${sqlLiteral(transferOnlyFixture.username)};
  INSERT INTO public.sys_user_account_set (user_id, account_set_id, role_code, is_default, enabled)
  SELECT app_user.id, account_set.id, ${sqlLiteral(transferOnlyFixture.roleCode)}, TRUE, TRUE
  FROM public.sys_user app_user
  JOIN public.sys_account_set account_set ON account_set.code='BLD-TEST' AND account_set.enabled=TRUE
  WHERE app_user.username=${sqlLiteral(transferOnlyFixture.username)};
  COMMIT;
  SELECT (SELECT count(*) FROM public.sys_role WHERE code=${sqlLiteral(transferOnlyFixture.roleCode)})
       + (SELECT count(*) FROM public.sys_permission permission_row JOIN public.sys_role role_row ON role_row.id=permission_row.role_id WHERE role_row.code=${sqlLiteral(transferOnlyFixture.roleCode)})
       + (SELECT count(*) FROM public.sys_user WHERE username=${sqlLiteral(transferOnlyFixture.username)})
       + (SELECT count(*) FROM public.sys_user_role role_link JOIN public.sys_user app_user ON app_user.id=role_link.user_id WHERE app_user.username=${sqlLiteral(transferOnlyFixture.username)})
       + (SELECT count(*) FROM public.sys_user_account_set grant_row JOIN public.sys_user app_user ON app_user.id=grant_row.user_id WHERE app_user.username=${sqlLiteral(transferOnlyFixture.username)});
`));
assert(fixtureRows === 5, `A183 transfer-only role fixture must create five closed rows, got ${fixtureRows}`);
const fixtureOwnershipText = scalar(`
  SELECT role_row.id::text || '|' || app_user.id::text
  FROM public.sys_role role_row
  JOIN public.sys_user app_user ON app_user.username=${sqlLiteral(transferOnlyFixture.username)}
  WHERE role_row.code=${sqlLiteral(transferOnlyFixture.roleCode)}
`);
const [fixtureRoleId, fixtureUserId] = fixtureOwnershipText.split("|");
assert(/^[0-9a-f-]{36}$/i.test(fixtureRoleId) && /^[0-9a-f-]{36}$/i.test(fixtureUserId), "A183 transfer-only fixture must capture exact role/user ownership UUIDs");
transferOnlyOwnership = { roleId: fixtureRoleId, userId: fixtureUserId };
transferOnlyCookie = await loginApi(apiBase, transferOnlyFixture.username, transferOnlyFixture.password, "BLD-TEST");
const controller = await readFile(path.join(rootDir, "backend/src/main/java/com/jdy/erp/finance/api/CashTransferController.java"), "utf8");
for (const action of ["detail", "saveDraft", "audit", "reverse"]) assert(new RegExp(`@RequirePermission\\(\\"finance\\.cash_transfer\\.audit\\"\\)[\\s\\S]{0,260}?\\b${action}\\s*\\(`).test(controller), `${action} must require finance.cash_transfer.audit`);
const cashTransferService = await readFile(path.join(rootDir, "backend/src/main/java/com/jdy/erp/finance/application/CashTransferAppService.java"), "utf8");
const cashTransferForm = await readFile(path.join(rootDir, "frontend/src/modules/finance/CashTransferForm.vue"), "utf8");
assert(cashTransferService.includes("catch (DataIntegrityViolationException exception)") && cashTransferService.includes("资金转账事实已发生变化"), "cash-transfer fact conflicts must become a safe business 409");
assert(/response\.status >= 500[\s\S]{0,180}?资金转账处理失败，请刷新单据后重试。/.test(cashTransferForm), "cash-transfer UI must not render unknown 5xx database details");

warehouseCookie = await loginApi(apiBase, "warehouse", "warehouse123", "BLD-TEST");
const deniedDraft = await request(warehouseCookie, "/api/cash-transfers/draft", { method: "POST", body: {} });
const deniedAudit = await request(warehouseCookie, `/api/cash-transfers/A163-${batch}/audit`, { method: "POST" });
const deniedDetail = await request(warehouseCookie, `/api/cash-transfers/A163-${batch}`);
for (const denied of [deniedDraft, deniedAudit, deniedDetail]) assert(denied.status === 403 && denied.text.includes("finance.cash_transfer.audit"), `cash-transfer permission must fail closed: ${denied.status} ${denied.text}`);
const warehouseSelector = await request(warehouseCookie, "/api/lists/financial-account-settlement-selector?keyword=&page=1&pageSize=200&view=header");
assert(warehouseSelector.status === 403, `role without settle/transfer permission must not read account candidates: ${warehouseSelector.status}`);

const sourceId = await createAuditedAccount("", accountCodes.cnySource, "A163 CNY 转出", "CNY", publicOwnedAccountIds);
const targetId = await createAuditedAccount("", accountCodes.cnyTarget, "A163 CNY 转入", "CNY", publicOwnedAccountIds);
const usdId = await createAuditedAccount("", accountCodes.usd, "A163 USD 账户", "USD", publicOwnedAccountIds);
const snapshotIds = {};
for (const suffix of ["a", "b", "c"]) {
  snapshotIds[suffix] = await createAuditedAccount("", snapshotCodes[suffix], `A184 快照账户 ${suffix.toUpperCase()}`, "CNY", publicOwnedAccountIds);
}
const snapshotQuery = (page, snapshotToken = "") => `/api/lists/financial-account-settlement-selector?${new URLSearchParams({
  keyword: `A184-SNAP-${batch}`,
  page: String(page),
  pageSize: "2",
  view: "header",
  ...(snapshotToken ? { snapshotToken } : {})
})}`;
const snapshotFirst = await request(transferOnlyCookie, snapshotQuery(1));
assert(snapshotFirst.status === 200 && snapshotFirst.data?.total === 3 && snapshotFirst.data?.rows?.length === 2 && typeof snapshotFirst.data?.snapshotToken === "string" && snapshotFirst.data.snapshotToken.length > 20, "snapshot selector first page must return 2/3 rows and an opaque token");
const snapshotMissingToken = await request(transferOnlyCookie, snapshotQuery(2));
assert(snapshotMissingToken.status === 409 && snapshotMissingToken.text.includes("快照标识"), "snapshot selector continuation without a token must fail closed");
const snapshotPermissionFirst = await request(warehouseCookie, snapshotQuery(2, "forged-token"));
assert(snapshotPermissionFirst.status === 403, "selector permission must be checked before a forged snapshot token");
await admin(`/api/master-data/financialAccount/${encodeURIComponent(snapshotCodes.a)}/status`, { method: "PATCH", body: { status: "禁用" } });
snapshotIds.d = await createAuditedAccount("", snapshotCodes.d, "A184 快照账户 D", "CNY", publicOwnedAccountIds);
const snapshotStale = await request(transferOnlyCookie, snapshotQuery(2, snapshotFirst.data.snapshotToken));
assert(snapshotStale.status === 409 && snapshotStale.text.includes("数据已变化"), "equal-count account replacement must invalidate the old snapshot token");
const snapshotFreshFirst = await request(transferOnlyCookie, snapshotQuery(1));
const snapshotFreshSecond = await request(transferOnlyCookie, snapshotQuery(2, snapshotFreshFirst.data?.snapshotToken));
const snapshotFreshRows = [...(snapshotFreshFirst.data?.rows ?? []), ...(snapshotFreshSecond.data?.rows ?? [])];
assert(snapshotFreshFirst.status === 200 && snapshotFreshSecond.status === 200 && snapshotFreshFirst.data?.total === 3 && snapshotFreshSecond.data?.total === 3, "fresh snapshot traversal must preserve the equal replacement total");
assert(snapshotFreshFirst.data.snapshotToken === snapshotFreshSecond.data.snapshotToken && snapshotFreshFirst.data.snapshotToken !== snapshotFirst.data.snapshotToken, "fresh traversal must use one new stable token");
assert(JSON.stringify(snapshotFreshRows.map((row) => row.code)) === JSON.stringify([snapshotCodes.b, snapshotCodes.c, snapshotCodes.d]), "fresh snapshot traversal must return B/C/D without stale A");
assert(new Set(snapshotFreshRows.map((row) => row.id)).size === 3, "fresh snapshot traversal must not duplicate or omit account UUIDs");
await admin(`/api/master-data/financialAccount/${encodeURIComponent(snapshotCodes.a)}/status`, { method: "PATCH", body: { status: "启用" } });
const snapshotPagingEvidence = {
  initialTotal: snapshotFirst.data.total,
  missingToken: snapshotMissingToken.status,
  permissionBeforeToken: snapshotPermissionFirst.status,
  equalReplacement: snapshotStale.status,
  freshTotal: snapshotFreshFirst.data.total,
  freshCodes: snapshotFreshRows.map((row) => row.code),
  tokenChanged: snapshotFreshFirst.data.snapshotToken !== snapshotFirst.data.snapshotToken
};
const transferSelectors = [];
for (const [code, id] of [[accountCodes.cnySource, sourceId], [accountCodes.cnyTarget, targetId]]) {
  const selector = await request(transferOnlyCookie, `/api/lists/financial-account-settlement-selector?${new URLSearchParams({ keyword: code, page: "1", pageSize: "20", view: "header" })}`);
  assert(selector.status === 200 && Array.isArray(selector.data?.rows), `transfer-only role must read the minimal account selector for ${code}: ${selector.status}`);
  assert(selector.data.rows.some((row) => String(row.id) === id && String(row.code) === code), `transfer-only selector must return exact owned account ${code}`);
  transferSelectors.push({ code, status: selector.status, rowCount: selector.data.rows.length });
}
const deniedMasterList = await request(transferOnlyCookie, "/api/lists/financial-account-master-list?keyword=&page=1&pageSize=200&view=header");
const deniedMasterSelector = await request(transferOnlyCookie, "/api/lists/financial-account-master-selector?keyword=&page=1&pageSize=200&view=header");
const deniedAccountCode = `A183-DENIED-${batch}`;
const deniedAccountCreate = await request(transferOnlyCookie, "/api/master-data/financialAccount", { method: "POST", body: { code: deniedAccountCode, name: "A183 不得创建", accountType: "CASH", currency: "CNY" } });
const deniedAccountPatch = await request(transferOnlyCookie, `/api/master-data/financialAccount/${encodeURIComponent(accountCodes.cnySource)}`, { method: "PATCH", body: { version: 0, changes: { remark: "A183 denied patch" } } });
const deniedAccountAudit = await request(transferOnlyCookie, `/api/master-data/financialAccount/${encodeURIComponent(accountCodes.cnySource)}/audit`, { method: "POST" });
const deniedAccountStatus = await request(transferOnlyCookie, `/api/master-data/financialAccount/${encodeURIComponent(accountCodes.cnySource)}/status`, { method: "PATCH", body: { status: "禁用" } });
for (const denied of [deniedMasterList, deniedMasterSelector, deniedAccountCreate, deniedAccountPatch, deniedAccountAudit, deniedAccountStatus]) {
  assert(denied.status === 403, `transfer-only role must not gain account maintenance access: ${denied.status} ${denied.text}`);
}
assert(scalar(`SELECT count(*) FROM public.md_financial_account WHERE code=${sqlLiteral(deniedAccountCode)}`) === "0", "denied account create must leave no row");
const transferOnlyDraft = await requireOk(transferOnlyCookie, "/api/cash-transfers/draft", { method: "POST", body: { billDate: "2026-07-16", sourceAccountId: sourceId, targetAccountId: targetId, amount: 2.5, remark: `A183 transfer-only ${batch}` } });
const transferOnlyBillNo = String(transferOnlyDraft.billNo);
await requireOk(transferOnlyCookie, `/api/cash-transfers/${encodeURIComponent(transferOnlyBillNo)}/audit`, { method: "POST" });
const transferOnlyDetail = await request(transferOnlyCookie, `/api/cash-transfers/${encodeURIComponent(transferOnlyBillNo)}`);
assert(transferOnlyDetail.status === 200 && transferOnlyDetail.data?.document?.billNo === transferOnlyBillNo, "transfer-only role must retain its own document lifecycle detail");
const deniedExistingDetail = await request(warehouseCookie, `/api/cash-transfers/${encodeURIComponent(transferOnlyBillNo)}`);
assert(deniedExistingDetail.status === 403 && deniedExistingDetail.text.includes("finance.cash_transfer.audit"), "role without cash-transfer permission must not read an existing same-tenant transfer");
const authorizedMissingDetail = await request(transferOnlyCookie, `/api/cash-transfers/A184-MISSING-${encodeURIComponent(batch)}`);
assert(authorizedMissingDetail.status === 404 && authorizedMissingDetail.text.includes("资金转账单不存在"), "authorized detail lookup must preserve the not-found contract");
await requireOk(transferOnlyCookie, `/api/cash-transfers/${encodeURIComponent(transferOnlyBillNo)}/reverse`, { method: "POST" });
assert(scalar(`SELECT coalesce(sum(amount_delta), 0)::text FROM public.cash_transfer_fact f JOIN public.cash_transfer t ON t.id=f.cash_transfer_id WHERE t.bill_no=${sqlLiteral(transferOnlyBillNo)}`) === "0.00", "transfer-only lifecycle must reverse to exact zero");
permissionEvidence = {
  roleCode: transferOnlyFixture.roleCode,
  selectors: transferSelectors,
  masterList: deniedMasterList.status,
  masterSelector: deniedMasterSelector.status,
  masterWrites: [deniedAccountCreate.status, deniedAccountPatch.status, deniedAccountAudit.status, deniedAccountStatus.status],
  neitherSelector: warehouseSelector.status,
  neitherDetail: deniedExistingDetail.status,
  authorizedMissingDetail: authorizedMissingDetail.status,
  lifecycleBillNo: transferOnlyBillNo
};
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
await admin(`/api/cash-transfers/${encodeURIComponent(billNo)}/audit`, { method: "POST" });
assert(scalar(`SELECT string_agg(DISTINCT posting_action || ':' || posting_version::text, ',' ORDER BY posting_action || ':' || posting_version::text) FROM public.cash_transfer_fact f JOIN public.cash_transfer t ON t.id=f.cash_transfer_id WHERE t.bill_no='${billNo}'`) === "AUDIT:1,AUDIT:3,REVERSE:2", "reaudit must append lifecycle-versioned facts");
assert(scalar(`SELECT coalesce(sum(amount_delta), 0)::text FROM public.cash_transfer_fact f JOIN public.cash_transfer t ON t.id=f.cash_transfer_id WHERE t.bill_no='${billNo}' AND f.account_id='${sourceId}'::uuid`) === "-12.50", "reaudit must restore the source account delta exactly once");
assert(scalar(`SELECT coalesce(sum(amount_delta), 0)::text FROM public.cash_transfer_fact f JOIN public.cash_transfer t ON t.id=f.cash_transfer_id WHERE t.bill_no='${billNo}' AND f.account_id='${targetId}'::uuid`) === "12.50", "reaudit must restore the target account delta exactly once");
await admin(`/api/cash-transfers/${encodeURIComponent(billNo)}/reverse`, { method: "POST" });
assert(scalar(`SELECT string_agg(DISTINCT posting_action || ':' || posting_version::text, ',' ORDER BY posting_action || ':' || posting_version::text) FROM public.cash_transfer_fact f JOIN public.cash_transfer t ON t.id=f.cash_transfer_id WHERE t.bill_no='${billNo}'`) === "AUDIT:1,AUDIT:3,REVERSE:2,REVERSE:4", "second reverse must append lifecycle version 4");
assert(scalar(`SELECT coalesce(sum(amount_delta), 0)::text FROM public.cash_transfer_fact f JOIN public.cash_transfer t ON t.id=f.cash_transfer_id WHERE t.bill_no='${billNo}'`) === "0.00", "second reverse must return both accounts to net zero");
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

const tenantCookie = await identity.login(tenantCode);
const tenantSession = await requireOk(tenantCookie, "/api/system/session");
tenantSchema = String(tenantSession.tenant?.schemaName ?? "");
const tenantSourceId = await createAuditedAccount(tenantCookie, tenantCodes.source, "A163 tenant CNY 转出", "CNY", tenantOwnedAccountIds);
const tenantTargetId = await createAuditedAccount(tenantCookie, tenantCodes.target, "A163 tenant CNY 转入", "CNY", tenantOwnedAccountIds);
const tenantTransfer = await requireOk(tenantCookie, "/api/cash-transfers/draft", { method: "POST", body: { billDate: "2026-07-16", sourceAccountId: tenantSourceId, targetAccountId: tenantTargetId, amount: 3, remark: `A163 tenant ${batch}` } });
const tenantBillNo = String(tenantTransfer.billNo);
await requireOk(tenantCookie, `/api/cash-transfers/${encodeURIComponent(tenantBillNo)}/audit`, { method: "POST" });
assert(tenantScalar(tenantSchema, `SELECT count(*) FROM cash_transfer_fact f JOIN cash_transfer t ON t.id=f.cash_transfer_id WHERE t.bill_no='${tenantBillNo}' AND posting_action='AUDIT'`) === "2", "tenant transfer must write its two facts inside the routed tenant");
assert(scalar(`SELECT count(*) FROM public.cash_transfer WHERE id='${String(tenantTransfer.id)}'::uuid`) === "0", "tenant transfer must not leak into public schema");
await requireOk(tenantCookie, `/api/cash-transfers/${encodeURIComponent(tenantBillNo)}/reverse`, { method: "POST" });

const browserEvidence = [];
let browserLifecycleBillNo = "";
for (const viewport of [{ width: 1440, height: 900, name: "wide" }, { width: 390, height: 844, name: "narrow" }]) {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: viewport.width, height: viewport.height } });
  let browserCookie = "";
  let browserPrimaryError = null;
  try {
    browserCookie = await identity.installInBrowser(context, "BLD-TEST");
    const page = await context.newPage();
    await page.goto(frontendUrl, { waitUntil: "networkidle" });
    const browserSession = await page.evaluate(async () => {
      const response = await fetch("/api/system/session");
      return { status: response.status, body: await response.json() };
    });
    assert(
      browserSession.status === 200
        && browserSession.body?.authenticated === true
        && browserSession.body?.user?.username === identity.username
        && browserSession.body?.user?.roleCode === "ADMIN"
        && browserSession.body?.tenant?.code === "BLD-TEST"
        && browserSession.body?.tenant?.schemaName === "public",
      `cash-transfer browser session mismatch: ${JSON.stringify(browserSession)}`
    );
    let selectorAttempts = 0;
    let selectorInjection = "pass";
    const selectorPattern = /\/api\/lists\/financial-account-settlement-selector\?/;
    if (viewport.name === "wide") {
      await page.route(selectorPattern, async (route) => {
        selectorAttempts += 1;
        if (selectorInjection === "failure") {
          selectorInjection = "pass";
          await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ message: "A183 simulated selector outage" }) });
          return;
        }
        if (selectorInjection === "empty") {
          selectorInjection = "pass";
          await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ page: 1, pageSize: 200, total: 0, snapshotToken: "a163-empty-snapshot-v1", rows: [] }) });
          return;
        }
        await route.continue();
      });
    }
    const initialSelectorResponsePromise = page.waitForResponse((response) => response.url().includes("/api/lists/financial-account-settlement-selector?"));
    await page.getByTestId("module-应收应付").hover().catch(() => page.getByTestId("module-应收应付").click());
    await page.getByTestId("entry-cash-transfer-form").click();
    const initialSelectorResponse = await initialSelectorResponsePromise;
    const initialSelectorPayload = await initialSelectorResponse.json();
    assert(initialSelectorResponse.status() === 200, `initial account selector request must succeed, got ${initialSelectorResponse.status()}`);
    assert(Array.isArray(initialSelectorPayload.rows) && Number(initialSelectorPayload.total) >= initialSelectorPayload.rows.length && typeof initialSelectorPayload.snapshotToken === "string" && initialSelectorPayload.snapshotToken.length > 20, "initial selector response must expose rows/total and an opaque snapshot token");
    const selectorHttp = {
      initial: { status: initialSelectorResponse.status(), rowCount: initialSelectorPayload.rows.length, total: Number(initialSelectorPayload.total) }
    };
    await page.getByTestId("cash-transfer-form").waitFor({ state: "visible" });
    const sourceSelect = page.getByTestId("cash-transfer-source-account");
    const targetSelect = page.getByTestId("cash-transfer-target-account");
    const waitForRunAccounts = () => page.waitForFunction(({ sourceAccountId, targetAccountId }) => {
      const source = document.querySelector('[data-testid="cash-transfer-source-account"]');
      const target = document.querySelector('[data-testid="cash-transfer-target-account"]');
      return source instanceof HTMLSelectElement
        && target instanceof HTMLSelectElement
        && Array.from(source.options).some((option) => option.value === sourceAccountId)
        && Array.from(target.options).some((option) => option.value === targetAccountId);
    }, { sourceAccountId: sourceId, targetAccountId: targetId });
    await waitForRunAccounts();
    if (viewport.name === "wide") {
      const initialSelectorAttempts = selectorAttempts;
      const expectedInitialPages = Math.max(1, Math.ceil(Number(initialSelectorPayload.total) / Number(initialSelectorPayload.pageSize || 200)));
      selectorHttp.initial.observedPages = initialSelectorAttempts;
      assert(initialSelectorAttempts === expectedInitialPages, `initial account load must issue one request per page without a duplicate mount reload: expected ${expectedInitialPages}, got ${initialSelectorAttempts}`);
      await sourceSelect.selectOption(sourceId);
      assert(!await targetSelect.locator(`option[value="${usdId}"]`).count(), "selecting a CNY source must remove the USD account from target candidates");
      await targetSelect.selectOption(sourceId);
      await page.getByTestId("save-sales-order").click();
      await page.getByTestId("form-message").filter({ hasText: "转出账户和转入账户不能相同" }).waitFor({ state: "visible" });
      await targetSelect.selectOption(targetId);
      assert(await page.getByTestId("cash-transfer-currency").inputValue() === "CNY", "initial successful selector load must support same-currency selection");
      selectorInjection = "failure";
      await page.getByTestId("new-document").click();
      const failedReloadResponsePromise = page.waitForResponse((response) => response.url().includes("/api/lists/financial-account-settlement-selector?"));
      await page.getByTestId("new-document-unsaved-confirm").click();
      const failedReloadResponse = await failedReloadResponsePromise;
      selectorHttp.reloadFailure = { status: failedReloadResponse.status(), rowCount: 0, total: 0 };
      assert(failedReloadResponse.status() === 503, `simulated account reload must return 503, got ${failedReloadResponse.status()}`);
      await page.getByTestId("cash-transfer-account-error").waitFor({ state: "visible" });
      assert(selectorAttempts === initialSelectorAttempts + 1, `new-document reload should add one failed request, got ${selectorAttempts - initialSelectorAttempts}`);
      assert(await sourceSelect.locator("option").count() === 1 && await targetSelect.locator("option").count() === 1, "failed account reload must clear all stale candidates");
      assert(await sourceSelect.inputValue() === "" && await targetSelect.inputValue() === "", "failed account reload must clear stale selections");
      assert(await page.getByTestId("cash-transfer-currency").inputValue() === "随账户确定", "failed account reload must clear the derived currency");
      selectorInjection = "empty";
      const emptyResponsePromise = page.waitForResponse((response) => response.url().includes("/api/lists/financial-account-settlement-selector?") && response.status() === 200);
      await page.getByTestId("cash-transfer-account-retry").click();
      const emptyResponse = await emptyResponsePromise;
      const emptyPayload = await emptyResponse.json();
      selectorHttp.empty = { status: emptyResponse.status(), rowCount: emptyPayload.rows?.length ?? -1, total: Number(emptyPayload.total) };
      assert(Array.isArray(emptyPayload.rows) && emptyPayload.rows.length === 0 && Number(emptyPayload.total) === 0, "successful empty selector response must use an exact zero rows/total contract");
      await page.getByTestId("cash-transfer-account-error").waitFor({ state: "hidden" });
      await page.getByTestId("cash-transfer-account-empty").waitFor({ state: "visible" });
      assert(await sourceSelect.locator("option").count() === 1 && await targetSelect.locator("option").count() === 1, "empty account result must render only placeholders");

      const recoveryResponsePromise = page.waitForResponse((response) => response.url().includes("/api/lists/financial-account-settlement-selector?") && response.status() === 200);
      await page.getByTestId("cash-transfer-account-retry").click();
      const recoveryResponse = await recoveryResponsePromise;
      const recoveryPayload = await recoveryResponse.json();
      selectorHttp.recovery = { status: recoveryResponse.status(), rowCount: recoveryPayload.rows?.length ?? -1, total: Number(recoveryPayload.total) };
      await page.getByTestId("cash-transfer-account-empty").waitFor({ state: "hidden" });
      await waitForRunAccounts();
      const expectedRecoveryPages = Math.max(1, Math.ceil(Number(recoveryPayload.total) / Number(recoveryPayload.pageSize || 200)));
      selectorHttp.recovery.observedPages = selectorAttempts - initialSelectorAttempts - 2;
      assert(selectorAttempts === initialSelectorAttempts + 2 + expectedRecoveryPages, `failure, empty and recovery path must add two injected responses plus ${expectedRecoveryPages} real pages, got ${selectorAttempts - initialSelectorAttempts}`);
    }
    const sourceOptionCount = await sourceSelect.locator("option").count();
    const targetOptionCount = await targetSelect.locator("option").count();
    assert(sourceOptionCount >= 3 && targetOptionCount >= 3, `cash-transfer selectors must render real candidates, got ${sourceOptionCount}/${targetOptionCount}`);

    if (viewport.name === "wide") {
      await sourceSelect.selectOption(sourceId);
      await targetSelect.selectOption(targetId);
      assert(await page.getByTestId("cash-transfer-currency").inputValue() === "CNY", "selecting same-currency accounts must set CNY");
      await page.getByTestId("cash-transfer-amount").fill("12.50");
      await page.getByTestId("cash-transfer-remark").fill(`A163 browser lifecycle ${batch}`);
      await page.getByTestId("save-sales-order").click();
      await page.getByTestId("form-message").filter({ hasText: "草稿已保存" }).waitFor({ state: "visible" });
      browserLifecycleBillNo = await page.getByTestId("cash-transfer-bill-no").inputValue();
      assert(/^ZJZZ\d{6}$/.test(browserLifecycleBillNo), `browser transfer bill no should match ZJZZ######, got ${JSON.stringify(browserLifecycleBillNo)}`);
      await page.getByTestId("audit-sales-order").click();
      await page.getByTestId("form-message").filter({ hasText: "审核成功" }).waitFor({ state: "visible" });
      await page.getByRole("button", { name: "反审核", exact: true }).click();
      await page.getByTestId("form-message").filter({ hasText: "反审核成功" }).waitFor({ state: "visible" });
      await page.getByTestId("audit-sales-order").click();
      await page.getByTestId("form-message").filter({ hasText: "审核成功" }).waitFor({ state: "visible" });
      await page.getByRole("button", { name: "反审核", exact: true }).click();
      await page.getByTestId("form-message").filter({ hasText: "反审核成功" }).waitFor({ state: "visible" });
    }
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
      selectorAttempts,
      selectorHttp,
      sourceOptionCount,
      targetOptionCount,
      lifecycleBillNo: viewport.name === "wide" ? browserLifecycleBillNo : "",
      screenshot: `verification/playwright/${screenshot}`
    });
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
        `A163 browser regression failed: ${browserPrimaryError instanceof Error ? browserPrimaryError.message : String(browserPrimaryError)}; cleanup failed: ${browserCleanupErrors.join("; ")}`
      );
    }
    throw browserPrimaryError;
  }
  if (browserCleanupErrors.length > 0) throw new Error(`A163 browser session cleanup failed: ${browserCleanupErrors.join("; ")}`);
}

assert(/^ZJZZ\d{6}$/.test(browserLifecycleBillNo), "wide browser run must complete the cash-transfer lifecycle");
assert(scalar(`SELECT string_agg(DISTINCT posting_action || ':' || posting_version::text, ',' ORDER BY posting_action || ':' || posting_version::text) FROM public.cash_transfer_fact f JOIN public.cash_transfer t ON t.id=f.cash_transfer_id WHERE t.bill_no='${browserLifecycleBillNo}'`) === "AUDIT:1,AUDIT:3,REVERSE:2,REVERSE:4", "browser lifecycle must append four versioned posting legs");
assert(scalar(`SELECT coalesce(sum(amount_delta), 0)::text FROM public.cash_transfer_fact f JOIN public.cash_transfer t ON t.id=f.cash_transfer_id WHERE t.bill_no='${browserLifecycleBillNo}'`) === "0.00", "browser lifecycle cleanup reverse must return both accounts to net zero");

evidence = { ok: true, batch, billNo, accounts: { ...accountCodes, snapshot: snapshotCodes }, snapshotPaging: snapshotPagingEvidence, deniedWrites: [deniedDraft.status, deniedAudit.status], permissions: permissionEvidence, facts: { audit: "-12.50,12.50", lifecycleVersions: [1, 2, 3, 4], netAfterSecondReverse: "0.00", concurrentAuditStatuses: concurrentAudits.map((response) => response.status).sort((left, right) => left - right) }, tenant: { code: tenantCode, billNo: tenantBillNo, schema: tenantSchema }, browserLifecycleBillNo, browser: browserEvidence, cleanup: { disabledAccounts } };
} catch (error) {
  primaryError = error;
}

const cleanupErrors = [];
try {
  const auditedBills = scalar(`
    SELECT coalesce(string_agg(bill_no, ',' ORDER BY bill_no), '')
    FROM public.cash_transfer
    WHERE status='AUDITED' AND COALESCE(remark, '') LIKE ${sqlLiteral(`%${batch}%`)}
  `).split(",").filter(Boolean);
  for (const cleanupBillNo of auditedBills) {
    try {
      await admin(`/api/cash-transfers/${encodeURIComponent(cleanupBillNo)}/reverse`, { method: "POST" });
    } catch (error) {
      cleanupErrors.push(`public transfer ${cleanupBillNo}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
} catch (error) {
  cleanupErrors.push(`public transfer discovery: ${error instanceof Error ? error.message : String(error)}`);
}
if (tenantSchema) {
  try {
    const tenantCleanupCookie = await identity.login(tenantCode);
    const auditedBills = tenantScalar(tenantSchema, `
      SELECT coalesce(string_agg(bill_no, ',' ORDER BY bill_no), '')
      FROM cash_transfer
      WHERE status='AUDITED' AND COALESCE(remark, '') LIKE ${sqlLiteral(`%${batch}%`)}
    `).split(",").filter(Boolean);
    for (const cleanupBillNo of auditedBills) {
      try {
        await requireOk(tenantCleanupCookie, `/api/cash-transfers/${encodeURIComponent(cleanupBillNo)}/reverse`, { method: "POST" });
      } catch (error) {
        cleanupErrors.push(`tenant transfer ${cleanupBillNo}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    for (const [code, ownership] of tenantOwnedAccountIds) {
      try {
        const state = tenantScalar(tenantSchema, `SELECT coalesce((SELECT id::text || '|' || enabled::text || '|' || COALESCE(remark, '') FROM md_financial_account WHERE code=${sqlLiteral(code)}), '')`);
        const [currentId, enabled, currentRemark] = state.split("|");
        if (!state && !ownership.id) continue;
        if (!state || (ownership.id && currentId !== ownership.id) || currentRemark !== ownership.remark) {
          cleanupErrors.push(`tenant account ${code}: ownership mismatch, expected ${ownership.id || "exact code+remark"}`);
          continue;
        }
        if (enabled === "true") await requireOk(tenantCleanupCookie, `/api/master-data/financialAccount/${encodeURIComponent(code)}/status`, { method: "PATCH", body: { status: "禁用" } });
        const finalState = tenantScalar(tenantSchema, `SELECT coalesce((SELECT id::text || '|' || enabled::text || '|' || COALESCE(remark, '') FROM md_financial_account WHERE code=${sqlLiteral(code)}), '')`);
        if (finalState === `${currentId}|false|${ownership.remark}`) disabledAccounts.push(code);
        else cleanupErrors.push(`tenant account ${code}: expected ${currentId}|false|owned-remark, got ${finalState || "missing"}`);
      } catch (error) {
        cleanupErrors.push(`tenant account ${code}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  } catch (error) {
    cleanupErrors.push(`tenant cleanup discovery: ${error instanceof Error ? error.message : String(error)}`);
  }
}
for (const [code, ownership] of publicOwnedAccountIds) {
  try {
    const state = scalar(`SELECT coalesce((SELECT id::text || '|' || enabled::text || '|' || COALESCE(remark, '') FROM public.md_financial_account WHERE code=${sqlLiteral(code)}), '')`);
    const [currentId, enabled, currentRemark] = state.split("|");
    if (!state && !ownership.id) continue;
    if (!state || (ownership.id && currentId !== ownership.id) || currentRemark !== ownership.remark) {
      cleanupErrors.push(`public account ${code}: ownership mismatch, expected ${ownership.id || "exact code+remark"}`);
      continue;
    }
    if (enabled === "true") await admin(`/api/master-data/financialAccount/${encodeURIComponent(code)}/status`, { method: "PATCH", body: { status: "禁用" } });
    const finalState = scalar(`SELECT coalesce((SELECT id::text || '|' || enabled::text || '|' || COALESCE(remark, '') FROM public.md_financial_account WHERE code=${sqlLiteral(code)}), '')`);
    if (finalState === `${currentId}|false|${ownership.remark}`) disabledAccounts.push(code);
    else cleanupErrors.push(`public account ${code}: expected ${currentId}|false|owned-remark, got ${finalState || "missing"}`);
  } catch (error) {
    cleanupErrors.push(`public account ${code}: ${error instanceof Error ? error.message : String(error)}`);
  }
}
if (evidence) {
  const expectedDisabledAccounts = [...Object.values(accountCodes), ...Object.values(snapshotCodes), ...Object.values(tenantCodes)].sort();
  const actualDisabledAccounts = [...new Set(disabledAccounts)].sort();
  if (JSON.stringify(actualDisabledAccounts) !== JSON.stringify(expectedDisabledAccounts)) {
    cleanupErrors.push(`disabled account closure mismatch: expected ${expectedDisabledAccounts.join(",")}, got ${actualDisabledAccounts.join(",")}`);
  }
}
if (warehouseCookie) {
  try {
    await logoutApiSession(apiBase, warehouseCookie);
  } catch (error) {
    cleanupErrors.push(error instanceof Error ? error.message : String(error));
  }
}
if (transferOnlyCookie) {
  try {
    await logoutApiSession(apiBase, transferOnlyCookie);
  } catch (error) {
    cleanupErrors.push(error instanceof Error ? error.message : String(error));
  }
}
try {
  await identity.cleanup();
} catch (error) {
  cleanupErrors.push(error instanceof Error ? error.message : String(error));
}
try {
  const discoveredOwnershipText = scalar(`
    SELECT coalesce((
             SELECT id::text FROM public.sys_role
             WHERE code=${sqlLiteral(transferOnlyFixture.roleCode)}
               AND name='A183 资金转账最小权限'
           ), '') || '|' || coalesce((
             SELECT id::text FROM public.sys_user
             WHERE username=${sqlLiteral(transferOnlyFixture.username)}
               AND display_name='A183 资金转账最小权限用户'
           ), '')
  `);
  const [discoveredRoleId, discoveredUserId] = discoveredOwnershipText.split("|");
  const cleanupOwnership = transferOnlyOwnership ?? (
    discoveredRoleId && discoveredUserId
      ? { roleId: discoveredRoleId, userId: discoveredUserId }
      : null
  );
  if (!cleanupOwnership) {
    const partialFixtureRows = Number(scalar(`
      SELECT (SELECT count(*) FROM public.sys_role WHERE code=${sqlLiteral(transferOnlyFixture.roleCode)})
           + (SELECT count(*) FROM public.sys_user WHERE username=${sqlLiteral(transferOnlyFixture.username)})
    `));
    assert(partialFixtureRows === 0, `transfer-only fixture ownership is incomplete: ${discoveredOwnershipText}`);
  } else {
    const residueText = scalar(`
      BEGIN;
      SET LOCAL lock_timeout='5s';
      SET LOCAL statement_timeout='30s';
      LOCK TABLE public.sys_user,
                 public.sys_role,
                 public.sys_user_role,
                 public.sys_permission,
                 public.sys_user_account_set,
                 public.sys_session_account_scope,
                 public.sys_operation_log
      IN SHARE ROW EXCLUSIVE MODE;
      DO $a163_guard$
      BEGIN
        IF (SELECT count(*) FROM public.sys_user
            WHERE id=${sqlLiteral(cleanupOwnership.userId)}::uuid
              AND username=${sqlLiteral(transferOnlyFixture.username)}
              AND display_name='A183 资金转账最小权限用户') <> 1 THEN
          RAISE EXCEPTION 'A163 transfer-only user ownership drifted';
        END IF;
        IF (SELECT count(*) FROM public.sys_role
            WHERE id=${sqlLiteral(cleanupOwnership.roleId)}::uuid
              AND code=${sqlLiteral(transferOnlyFixture.roleCode)}
              AND name='A183 资金转账最小权限') <> 1 THEN
          RAISE EXCEPTION 'A163 transfer-only role ownership drifted';
        END IF;
        IF (SELECT count(*) FROM public.sys_permission
            WHERE role_id=${sqlLiteral(cleanupOwnership.roleId)}::uuid) <> 1
           OR (SELECT count(*) FROM public.sys_permission
               WHERE role_id=${sqlLiteral(cleanupOwnership.roleId)}::uuid
                 AND permission_code='finance.cash_transfer.audit'
                 AND enabled=TRUE) <> 1 THEN
          RAISE EXCEPTION 'A163 transfer-only permission ownership drifted';
        END IF;
        IF (SELECT count(*) FROM public.sys_user_role
            WHERE user_id=${sqlLiteral(cleanupOwnership.userId)}::uuid
               OR role_id=${sqlLiteral(cleanupOwnership.roleId)}::uuid) <> 1
           OR (SELECT count(*) FROM public.sys_user_role
               WHERE user_id=${sqlLiteral(cleanupOwnership.userId)}::uuid
                 AND role_id=${sqlLiteral(cleanupOwnership.roleId)}::uuid) <> 1 THEN
          RAISE EXCEPTION 'A163 transfer-only role link ownership drifted';
        END IF;
        IF (SELECT count(*) FROM public.sys_user_account_set
            WHERE user_id=${sqlLiteral(cleanupOwnership.userId)}::uuid
               OR role_code=${sqlLiteral(transferOnlyFixture.roleCode)}) <> 1
           OR (SELECT count(*)
               FROM public.sys_user_account_set grant_row
               JOIN public.sys_account_set account_set ON account_set.id=grant_row.account_set_id
               WHERE grant_row.user_id=${sqlLiteral(cleanupOwnership.userId)}::uuid
                 AND account_set.code='BLD-TEST'
                 AND grant_row.role_code=${sqlLiteral(transferOnlyFixture.roleCode)}
                 AND grant_row.is_default=TRUE
                 AND grant_row.enabled=TRUE) <> 1 THEN
          RAISE EXCEPTION 'A163 transfer-only account-set grant ownership drifted';
        END IF;
        IF EXISTS (
          SELECT 1 FROM public.sys_operation_log
          WHERE (operated_by=${sqlLiteral(cleanupOwnership.userId)}::uuid
                 OR actor_username=${sqlLiteral(transferOnlyFixture.username)})
            AND (
              actor_type IS DISTINCT FROM 'USER'
              OR operated_by IS DISTINCT FROM ${sqlLiteral(cleanupOwnership.userId)}::uuid
              OR actor_username IS DISTINCT FROM ${sqlLiteral(transferOnlyFixture.username)}
              OR (actor_display_name IS NOT NULL
                  AND actor_display_name IS DISTINCT FROM 'A183 资金转账最小权限用户')
            )
        ) THEN
          RAISE EXCEPTION 'A163 transfer-only operation-log ownership drifted';
        END IF;
      END
      $a163_guard$;
      CREATE TEMP TABLE a163_owned_operation_logs ON COMMIT PRESERVE ROWS AS
      SELECT id
      FROM public.sys_operation_log
      WHERE actor_type='USER'
        AND operated_by=${sqlLiteral(cleanupOwnership.userId)}::uuid
        AND actor_username=${sqlLiteral(transferOnlyFixture.username)};
      DELETE FROM public.sys_operation_log
      WHERE id IN (SELECT id FROM a163_owned_operation_logs);
      DELETE FROM public.sys_user_account_set
      WHERE user_id=${sqlLiteral(cleanupOwnership.userId)}::uuid
        AND role_code=${sqlLiteral(transferOnlyFixture.roleCode)};
      DELETE FROM public.sys_session_account_scope
      WHERE user_id=${sqlLiteral(cleanupOwnership.userId)}::uuid;
      DELETE FROM public.sys_user_role
      WHERE user_id=${sqlLiteral(cleanupOwnership.userId)}::uuid
        AND role_id=${sqlLiteral(cleanupOwnership.roleId)}::uuid;
      DELETE FROM public.sys_user
      WHERE id=${sqlLiteral(cleanupOwnership.userId)}::uuid
        AND username=${sqlLiteral(transferOnlyFixture.username)}
        AND display_name='A183 资金转账最小权限用户';
      DELETE FROM public.sys_permission
      WHERE role_id=${sqlLiteral(cleanupOwnership.roleId)}::uuid
        AND permission_code='finance.cash_transfer.audit';
      DELETE FROM public.sys_role
      WHERE id=${sqlLiteral(cleanupOwnership.roleId)}::uuid
        AND code=${sqlLiteral(transferOnlyFixture.roleCode)}
        AND name='A183 资金转账最小权限';
      DO $a163_verify$
      BEGIN
        IF EXISTS (SELECT 1 FROM public.sys_role WHERE id=${sqlLiteral(cleanupOwnership.roleId)}::uuid)
           OR EXISTS (SELECT 1 FROM public.sys_user WHERE id=${sqlLiteral(cleanupOwnership.userId)}::uuid)
           OR EXISTS (SELECT 1 FROM public.sys_permission WHERE role_id=${sqlLiteral(cleanupOwnership.roleId)}::uuid)
           OR EXISTS (SELECT 1 FROM public.sys_user_role WHERE user_id=${sqlLiteral(cleanupOwnership.userId)}::uuid OR role_id=${sqlLiteral(cleanupOwnership.roleId)}::uuid)
           OR EXISTS (SELECT 1 FROM public.sys_user_account_set WHERE user_id=${sqlLiteral(cleanupOwnership.userId)}::uuid OR role_code=${sqlLiteral(transferOnlyFixture.roleCode)})
           OR EXISTS (SELECT 1 FROM public.sys_session_account_scope WHERE user_id=${sqlLiteral(cleanupOwnership.userId)}::uuid)
           OR EXISTS (SELECT 1 FROM public.sys_operation_log WHERE operated_by=${sqlLiteral(cleanupOwnership.userId)}::uuid OR actor_username=${sqlLiteral(transferOnlyFixture.username)}) THEN
          RAISE EXCEPTION 'A163 transfer-only fixture residue remains before commit';
        END IF;
      END
      $a163_verify$;
      COMMIT;
      SELECT (SELECT count(*) FROM public.sys_role WHERE id=${sqlLiteral(cleanupOwnership.roleId)}::uuid) || '|'
          || (SELECT count(*) FROM public.sys_user WHERE id=${sqlLiteral(cleanupOwnership.userId)}::uuid) || '|'
          || (SELECT count(*) FROM public.sys_permission WHERE role_id=${sqlLiteral(cleanupOwnership.roleId)}::uuid) || '|'
          || (SELECT count(*) FROM public.sys_user_role WHERE user_id=${sqlLiteral(cleanupOwnership.userId)}::uuid OR role_id=${sqlLiteral(cleanupOwnership.roleId)}::uuid) || '|'
          || (SELECT count(*) FROM public.sys_user_account_set WHERE user_id=${sqlLiteral(cleanupOwnership.userId)}::uuid OR role_code=${sqlLiteral(transferOnlyFixture.roleCode)}) || '|'
          || (SELECT count(*) FROM public.sys_session_account_scope WHERE user_id=${sqlLiteral(cleanupOwnership.userId)}::uuid) || '|'
          || (SELECT count(*) FROM public.sys_operation_log WHERE operated_by=${sqlLiteral(cleanupOwnership.userId)}::uuid OR actor_username=${sqlLiteral(transferOnlyFixture.username)}) || '|'
          || (SELECT count(*) FROM a163_owned_operation_logs);
      DROP TABLE a163_owned_operation_logs;
    `);
    const residueParts = residueText.split("|");
    assert(residueParts.length === 8 && residueParts.every((value) => /^\d+$/.test(value)), `invalid transfer-only cleanup evidence: ${residueText}`);
    const [role, user, permission, roleLink, grant, sessionScope, operationLog, deletedOperationLogs] = residueParts.map(Number);
    if (evidence) assert(deletedOperationLogs === 7, `transfer-only operation-log deletion count must be 7, got ${deletedOperationLogs}`);
    const fixtureResidue = { role, user, permission, roleLink, grant, sessionScope, operationLog };
    if (Object.values(fixtureResidue).some((count) => count !== 0)) cleanupErrors.push(`transfer-only fixture residue: ${JSON.stringify(fixtureResidue)}`);
    else if (evidence) {
      evidence.cleanup.transferOnlyFixtureResidue = fixtureResidue;
      evidence.cleanup.deletedOperationLogs = deletedOperationLogs;
    }
  }
} catch (error) {
  cleanupErrors.push(`transfer-only fixture cleanup: ${error instanceof Error ? error.message : String(error)}`);
}
try {
  const globalActorOrphanFinal = Number(scalar(`
    SELECT count(*)
    FROM public.sys_operation_log log_row
    LEFT JOIN public.sys_user user_row ON user_row.id=log_row.operated_by
    WHERE log_row.operated_by IS NOT NULL AND user_row.id IS NULL
  `));
  if (evidence) {
    evidence.cleanup.globalActorOrphans = {
      baseline: globalActorOrphanBaseline,
      final: globalActorOrphanFinal
    };
  }
  if (globalActorOrphanBaseline !== null && globalActorOrphanFinal !== globalActorOrphanBaseline) {
    cleanupErrors.push(`global actor orphan drift: baseline=${globalActorOrphanBaseline}, final=${globalActorOrphanFinal}`);
  }
} catch (error) {
  cleanupErrors.push(`global actor orphan verification: ${error instanceof Error ? error.message : String(error)}`);
}
if (primaryError) {
  if (cleanupErrors.length > 0) {
    throw new AggregateError(
      [primaryError, ...cleanupErrors.map((message) => new Error(message))],
      `A163 regression failed: ${primaryError instanceof Error ? primaryError.message : String(primaryError)}; cleanup failed: ${cleanupErrors.join("; ")}`
    );
  }
  throw primaryError;
}
if (cleanupErrors.length > 0) throw new Error(`A163 session cleanup failed: ${cleanupErrors.join("; ")}`);
assert(evidence, "A163 regression completed without result evidence");
await writeFile(resultPath, `${JSON.stringify(evidence, null, 2)}\n`);
console.log(JSON.stringify(evidence, null, 2));
