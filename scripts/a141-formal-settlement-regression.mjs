#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";

import { loginApi, loginAs } from "./helpers/regression-auth.mjs";

const rootDir = path.resolve(import.meta.dirname, "..");
const apiBase = "http://127.0.0.1:8080";
const frontendUrl = "http://127.0.0.1:5173/";
const verificationDir = path.join(rootDir, "verification");
const screenshotDir = path.join(verificationDir, "playwright");
const faultInjection = (process.env.A141_FAULT_INJECTION ?? "").trim();
const resultSuffix = faultInjection ? `-${faultInjection.replaceAll(/[^a-z0-9-]+/gi, "-")}` : "";
const resultPath = path.join(verificationDir, `a141-formal-settlement-regression${resultSuffix}.json`);
const runId = `${new Date().toISOString().replace(/\D/g, "").slice(0, 14)}-${randomUUID().slice(0, 8)}`;
const compactRunId = runId.replaceAll("-", "");
const fixturePrefix = `A141-${runId}`;
const userPrefix = `a141_${compactRunId}`;
const reportRoleCode = `A141_REPORT_${compactRunId}`;
const billDate = "2026-07-14";

const users = {
  admin: { username: `${userPrefix}_admin`, password: `A141-${compactRunId}-admin`, role: "ADMIN" },
  finance: { username: `${userPrefix}_finance`, password: `A141-${compactRunId}-finance`, role: "FINANCE" },
  replayAdmin: { username: `${userPrefix}_replay_admin`, password: `A141-${compactRunId}-replay-admin`, role: "ADMIN" },
  replayFinance: { username: `${userPrefix}_replay_finance`, password: `A141-${compactRunId}-replay-finance`, role: "FINANCE" },
  warehouse: { username: `${userPrefix}_warehouse`, password: `A141-${compactRunId}-warehouse`, role: "WAREHOUSE" },
  report: { username: `${userPrefix}_report`, password: `A141-${compactRunId}-report`, role: reportRoleCode }
};

const codes = {
  customerA: `${fixturePrefix}-CA`, customerB: `${fixturePrefix}-CB`,
  supplierA: `${fixturePrefix}-SA`, supplierB: `${fixturePrefix}-SB`,
  cashCny: `${fixturePrefix}-CASH`, bankCny: `${fixturePrefix}-BCNY`, bankUsd: `${fixturePrefix}-BUSD`,
  draftCny: `${fixturePrefix}-DRAFT`, disabledCny: `${fixturePrefix}-DISABLED`,
  ar1: `${fixturePrefix}-AR1`, ar2: `${fixturePrefix}-AR2`, arUsd: `${fixturePrefix}-ARUSD`,
  arWrong: `${fixturePrefix}-ARWRONG`, arSmall: `${fixturePrefix}-ARSMALL`, arRace: `${fixturePrefix}-ARRACE`,
  arAtomic1: `${fixturePrefix}-ARAT1`, arAtomic2: `${fixturePrefix}-ARAT2`, arLegacy: `${fixturePrefix}-ARLEG`,
  arDone: `${fixturePrefix}-ARDONE`,
  ap1: `${fixturePrefix}-AP1`, ap2: `${fixturePrefix}-AP2`, apUsd: `${fixturePrefix}-APUSD`,
  apWrong: `${fixturePrefix}-APWRONG`, apSmall: `${fixturePrefix}-APSMALL`, apLegacy: `${fixturePrefix}-APLEG`,
  apDone: `${fixturePrefix}-APDONE`,
  legacyReceipt: `${fixturePrefix}-SKLEG`, legacyPayment: `${fixturePrefix}-FKLEG`
};

const chainArtifacts = {
  salesOrders: [], deliveryNotices: [], salesOuts: [],
  purchaseOrders: [], purchaseIns: [], purchaseReturns: []
};

const evidence = {
  runId,
  generatedAt: new Date().toISOString(),
  ok: false,
  decisions: {
    ownership: "finance-owned formal receipt/payment",
    topology: "same-party multi-source and multi-account",
    currencies: ["CNY", "USD"],
    exchangeRate: "not supported"
  },
  coverage: {},
  environment: {},
  requests: [],
  assertions: [],
  permissions: [],
  selectors: {},
  lifecycle: {},
  concurrency: {},
  legacy: {},
  tenantIsolation: {},
  operationLogs: [],
  permissionBrowser: [],
  screenshots: [],
  cleanup: {
    attempted: false,
    remaining: null,
    recovery: { attempted: false, actions: [], errors: [], stock: null },
    error: ""
  },
  failure: null
};

let browser = null;
let replayTenant = null;
let ids = null;
let cookies = {};
let chainStockBaseline = null;
let directCleanupAuthorized = true;

function assert(condition, message, details = undefined) {
  if (!condition) {
    throw new Error(`${message}${details === undefined ? "" : ` ${JSON.stringify(details)}`}`);
  }
  evidence.assertions.push({ message, details });
}

function same(actual, expected) {
  return JSON.stringify(actual) === JSON.stringify(expected);
}

function sqlLiteral(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function nullableSql(value, type = "numeric") {
  return value == null ? `NULL::${type}` : `${sqlLiteral(value)}::${type}`;
}

function jsonbSql(value) {
  return `${sqlLiteral(JSON.stringify(value))}::jsonb`;
}

function sqlIdentifier(value) {
  const normalized = String(value);
  if (!/^[a-z_][a-z0-9_]*$/i.test(normalized)) throw new Error(`unsafe SQL identifier: ${normalized}`);
  return `"${normalized.replaceAll('"', '""')}"`;
}

function dbScalar(sql) {
  return execFileSync(
    "docker",
    ["exec", "jdy-erp-postgres", "psql", "-X", "-U", "jdy", "-d", "jdy_erp", "-v", "ON_ERROR_STOP=1", "-tAq", "-c", sql],
    { encoding: "utf8" }
  ).trim();
}

function dbJson(sql) {
  const text = dbScalar(sql);
  return text ? JSON.parse(text) : null;
}

async function request(cookie, pathname, options = {}) {
  const method = options.method ?? "GET";
  const headers = new Headers(options.body === undefined ? undefined : { "Content-Type": "application/json" });
  if (cookie) headers.set("Cookie", cookie);
  const response = await fetch(`${apiBase}${pathname}`, {
    method,
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body)
  });
  const text = await response.text();
  let data = null;
  if (text.trim()) {
    try { data = JSON.parse(text); } catch { data = null; }
  }
  return { status: response.status, ok: response.ok, text, data };
}

function expectStatus(label, response, expected) {
  const expectedStatuses = Array.isArray(expected) ? expected : [expected];
  evidence.requests.push({ label, expected: expectedStatuses, actual: response.status });
  assert(expectedStatuses.includes(response.status), `${label} HTTP 状态不符合合同`, {
    expected: expectedStatuses,
    actual: response.status,
    body: response.text.slice(0, 500)
  });
}

function schemaTable(schema, table) {
  return `${sqlIdentifier(schema)}.${sqlIdentifier(table)}`;
}

function sourceState(schema, kind, billNo) {
  const receipt = kind === "receipt";
  const table = receipt ? "ar_receivable" : "ap_payable";
  const settled = receipt ? "received_amount" : "paid_amount";
  return dbJson(`
    SELECT row_to_json(source_row)::text FROM (
      SELECT id::text AS id, bill_no AS "billNo", source_bill_no AS "sourceBillNo", currency,
             amount::text AS amount, ${settled}::text AS "settledAmount", status
      FROM ${schemaTable(schema, table)} WHERE bill_no = ${sqlLiteral(billNo)}
    ) source_row
  `);
}

function documentState(schema, kind, billNo) {
  const receipt = kind === "receipt";
  const header = receipt ? "ar_receipt" : "ap_payment";
  const fund = receipt ? "ar_receipt_fund_line" : "ap_payment_fund_line";
  const allocation = receipt ? "ar_receipt_allocation" : "ap_payment_allocation";
  const owner = receipt ? "receipt_id" : "payment_id";
  return dbJson(`
    SELECT row_to_json(document_row)::text FROM (
      SELECT h.id::text AS id, h.bill_no AS "billNo", h.currency, h.amount::text AS amount,
             h.status, h.version, h.legacy_imported AS legacy,
             (SELECT count(*) FROM ${schemaTable(schema, fund)} f WHERE f.${owner} = h.id) AS "fundCount",
             (SELECT count(*) FROM ${schemaTable(schema, allocation)} a WHERE a.${owner} = h.id) AS "allocationCount"
      FROM ${schemaTable(schema, header)} h WHERE h.bill_no = ${sqlLiteral(billNo)}
    ) document_row
  `);
}

function actionCount(schema, username, action, targetNo = "") {
  return Number(dbScalar(`
    SELECT count(*) FROM ${schemaTable(schema, "sys_operation_log")}
    WHERE actor_username = ${sqlLiteral(username)}
      AND action_code = ${sqlLiteral(action)}
      ${targetNo ? `AND target_no = ${sqlLiteral(targetNo)}` : ""}
  `));
}

async function list(cookie, listKey, { keyword = fixturePrefix, columnFilters = undefined, pageSize = 500 } = {}) {
  const query = new URLSearchParams({ keyword, page: "1", pageSize: String(pageSize) });
  if (columnFilters) query.set("columnFilters", JSON.stringify(columnFilters));
  return request(cookie, `/api/lists/${encodeURIComponent(listKey)}?${query}`);
}

function zeroPayload(kind, partyId, remark = `${fixturePrefix}-zero`) {
  return { partyId, billDate, currency: "CNY", amount: 0, remark: `${remark}-${kind}`, fundLines: [], allocations: [] };
}

function settlementPayload({ partyId, currency = "CNY", funds, allocations, remark }) {
  const amount = allocations.reduce((sum, row) => sum + Number(row.amount), 0);
  return {
    partyId,
    billDate,
    currency,
    amount,
    remark: remark ?? `${fixturePrefix}-formal`,
    fundLines: funds.map((row, index) => ({
      lineNo: index + 1,
      accountId: row.accountId,
      paymentMethod: row.method ?? "BANK_TRANSFER",
      amount: row.amount,
      fee: row.fee ?? 0,
      transactionNo: row.transactionNo ?? `${fixturePrefix}-SECRET-${index + 1}`,
      remark: `${fixturePrefix}-fund-${index + 1}`
    })),
    allocations: allocations.map((row, index) => ({
      lineNo: index + 1,
      sourceId: row.sourceId,
      settlementAmount: row.amount,
      remark: `${fixturePrefix}-allocation-${index + 1}`
    }))
  };
}

async function createDraft(kind, payload, expected = 201, cookie = cookies.finance, label = `${kind} create draft`) {
  const response = await request(cookie, `/api/finance/${kind === "receipt" ? "receipts" : "payments"}/draft`, { method: "POST", body: payload });
  expectStatus(label, response, expected);
  return response;
}

async function documentAction(kind, billNo, action, expected = 200, cookie = cookies.finance, body = undefined, label = `${kind} ${action}`) {
  const collection = kind === "receipt" ? "receipts" : "payments";
  const route = action === "detail" ? `/api/finance/${collection}/${encodeURIComponent(billNo)}`
    : action === "update" ? `/api/finance/${collection}/${encodeURIComponent(billNo)}/draft`
      : action === "delete" ? `/api/finance/${collection}/${encodeURIComponent(billNo)}`
        : `/api/finance/${collection}/${encodeURIComponent(billNo)}/${action}`;
  const method = action === "detail" ? "GET" : action === "update" ? "PUT" : action === "delete" ? "DELETE" : "POST";
  const response = await request(cookie, route, { method, body });
  expectStatus(label, response, expected);
  return response;
}

async function requireApi(cookie, label, pathname, { method = "POST", body = undefined, expected = 200 } = {}) {
  const response = await request(cookie, pathname, { method, body });
  expectStatus(label, response, expected);
  return response;
}

function requireGeneratedBill(response, prefix, label) {
  const billNo = String(response.data?.billNo ?? "");
  assert(new RegExp(`^${prefix}\\d{6}$`).test(billNo), `${label} 必须生成 ${prefix} 单号`, response.data);
  return billNo;
}

function fixtureIds(schema) {
  const table = (name) => schemaTable(schema, name);
  const value = (key) => sqlLiteral(codes[key]);
  return dbJson(`
    SELECT jsonb_build_object(
      'customerA', (SELECT id::text FROM ${table("md_customer")} WHERE code = ${value("customerA")}),
      'customerB', (SELECT id::text FROM ${table("md_customer")} WHERE code = ${value("customerB")}),
      'supplierA', (SELECT id::text FROM ${table("md_supplier")} WHERE code = ${value("supplierA")}),
      'supplierB', (SELECT id::text FROM ${table("md_supplier")} WHERE code = ${value("supplierB")}),
      'cashCny', (SELECT id::text FROM ${table("md_financial_account")} WHERE code = ${value("cashCny")}),
      'bankCny', (SELECT id::text FROM ${table("md_financial_account")} WHERE code = ${value("bankCny")}),
      'bankUsd', (SELECT id::text FROM ${table("md_financial_account")} WHERE code = ${value("bankUsd")}),
      'draftCny', (SELECT id::text FROM ${table("md_financial_account")} WHERE code = ${value("draftCny")}),
      'disabledCny', (SELECT id::text FROM ${table("md_financial_account")} WHERE code = ${value("disabledCny")}),
      'ar1', (SELECT id::text FROM ${table("ar_receivable")} WHERE bill_no = ${value("ar1")}),
      'ar2', (SELECT id::text FROM ${table("ar_receivable")} WHERE bill_no = ${value("ar2")}),
      'arUsd', (SELECT id::text FROM ${table("ar_receivable")} WHERE bill_no = ${value("arUsd")}),
      'arWrong', (SELECT id::text FROM ${table("ar_receivable")} WHERE bill_no = ${value("arWrong")}),
      'arSmall', (SELECT id::text FROM ${table("ar_receivable")} WHERE bill_no = ${value("arSmall")}),
      'arRace', (SELECT id::text FROM ${table("ar_receivable")} WHERE bill_no = ${value("arRace")}),
      'arAtomic1', (SELECT id::text FROM ${table("ar_receivable")} WHERE bill_no = ${value("arAtomic1")}),
      'arAtomic2', (SELECT id::text FROM ${table("ar_receivable")} WHERE bill_no = ${value("arAtomic2")}),
      'arLegacy', (SELECT id::text FROM ${table("ar_receivable")} WHERE bill_no = ${value("arLegacy")}),
      'ap1', (SELECT id::text FROM ${table("ap_payable")} WHERE bill_no = ${value("ap1")}),
      'ap2', (SELECT id::text FROM ${table("ap_payable")} WHERE bill_no = ${value("ap2")}),
      'apUsd', (SELECT id::text FROM ${table("ap_payable")} WHERE bill_no = ${value("apUsd")}),
      'apWrong', (SELECT id::text FROM ${table("ap_payable")} WHERE bill_no = ${value("apWrong")}),
      'apSmall', (SELECT id::text FROM ${table("ap_payable")} WHERE bill_no = ${value("apSmall")}),
      'apLegacy', (SELECT id::text FROM ${table("ap_payable")} WHERE bill_no = ${value("apLegacy")})
    )::text
  `);
}

function insertTenantFixtures(schema) {
  const t = (name) => schemaTable(schema, name);
  const tenantLabel = schema === "public" ? "PUBLIC" : "TENANT";
  dbScalar(`
    BEGIN;
    INSERT INTO ${t("md_customer")} (code, name, enabled, audit_status) VALUES
      (${sqlLiteral(codes.customerA)}, ${sqlLiteral(`A141 ${tenantLabel} 客户 A`)}, TRUE, 'AUDITED'),
      (${sqlLiteral(codes.customerB)}, ${sqlLiteral(`A141 ${tenantLabel} 客户 B`)}, TRUE, 'AUDITED');
    INSERT INTO ${t("md_supplier")} (code, name, enabled, audit_status) VALUES
      (${sqlLiteral(codes.supplierA)}, ${sqlLiteral(`A141 ${tenantLabel} 供应商 A`)}, TRUE, 'AUDITED'),
      (${sqlLiteral(codes.supplierB)}, ${sqlLiteral(`A141 ${tenantLabel} 供应商 B`)}, TRUE, 'AUDITED');

    INSERT INTO ${t("md_financial_account")} (
      code, name, account_type, bank_name, account_no, account_holder, currency, remark, enabled, audit_status
    ) VALUES
      (${sqlLiteral(codes.cashCny)}, ${sqlLiteral(`A141 ${tenantLabel} 现金`)}, 'CASH', NULL, NULL, NULL, 'CNY', ${sqlLiteral(fixturePrefix)}, TRUE, 'AUDITED'),
      (${sqlLiteral(codes.bankCny)}, ${sqlLiteral(`A141 ${tenantLabel} 人民币银行`)}, 'BANK', 'A141银行', ${sqlLiteral(`001${compactRunId}`)}, 'A141户名', 'CNY', ${sqlLiteral(fixturePrefix)}, TRUE, 'AUDITED'),
      (${sqlLiteral(codes.bankUsd)}, ${sqlLiteral(`A141 ${tenantLabel} 美元银行`)}, 'BANK', 'A141 USD Bank', ${sqlLiteral(`002${compactRunId}`)}, 'A141 USD Holder', 'USD', ${sqlLiteral(fixturePrefix)}, TRUE, 'AUDITED'),
      (${sqlLiteral(codes.draftCny)}, ${sqlLiteral(`A141 ${tenantLabel} 未审核账户`)}, 'CASH', NULL, NULL, NULL, 'CNY', ${sqlLiteral(fixturePrefix)}, TRUE, 'DRAFT'),
      (${sqlLiteral(codes.disabledCny)}, ${sqlLiteral(`A141 ${tenantLabel} 禁用账户`)}, 'CASH', NULL, NULL, NULL, 'CNY', ${sqlLiteral(fixturePrefix)}, FALSE, 'AUDITED');

    INSERT INTO ${t("ar_receivable")} (bill_no, source_bill_no, customer_id, bill_date, currency, amount, received_amount, status) VALUES
      (${sqlLiteral(codes.ar1)}, ${sqlLiteral(`${fixturePrefix}-SO1`)}, (SELECT id FROM ${t("md_customer")} WHERE code=${sqlLiteral(codes.customerA)}), DATE ${sqlLiteral(billDate)}, 'CNY', 100, 0, 'OPEN'),
      (${sqlLiteral(codes.ar2)}, ${sqlLiteral(`${fixturePrefix}-SO2`)}, (SELECT id FROM ${t("md_customer")} WHERE code=${sqlLiteral(codes.customerA)}), DATE ${sqlLiteral(billDate)}, 'CNY', 200, 0, 'OPEN'),
      (${sqlLiteral(codes.arUsd)}, ${sqlLiteral(`${fixturePrefix}-SOUSD`)}, (SELECT id FROM ${t("md_customer")} WHERE code=${sqlLiteral(codes.customerA)}), DATE ${sqlLiteral(billDate)}, 'USD', 120, 0, 'OPEN'),
      (${sqlLiteral(codes.arWrong)}, ${sqlLiteral(`${fixturePrefix}-SOWRONG`)}, (SELECT id FROM ${t("md_customer")} WHERE code=${sqlLiteral(codes.customerB)}), DATE ${sqlLiteral(billDate)}, 'CNY', 50, 0, 'OPEN'),
      (${sqlLiteral(codes.arSmall)}, ${sqlLiteral(`${fixturePrefix}-SOSMALL`)}, (SELECT id FROM ${t("md_customer")} WHERE code=${sqlLiteral(codes.customerA)}), DATE ${sqlLiteral(billDate)}, 'CNY', 10, 0, 'OPEN'),
      (${sqlLiteral(codes.arRace)}, ${sqlLiteral(`${fixturePrefix}-SORACE`)}, (SELECT id FROM ${t("md_customer")} WHERE code=${sqlLiteral(codes.customerA)}), DATE ${sqlLiteral(billDate)}, 'CNY', 100, 0, 'OPEN'),
      (${sqlLiteral(codes.arAtomic1)}, ${sqlLiteral(`${fixturePrefix}-SOAT1`)}, (SELECT id FROM ${t("md_customer")} WHERE code=${sqlLiteral(codes.customerA)}), DATE ${sqlLiteral(billDate)}, 'CNY', 100, 0, 'OPEN'),
      (${sqlLiteral(codes.arAtomic2)}, ${sqlLiteral(`${fixturePrefix}-SOAT2`)}, (SELECT id FROM ${t("md_customer")} WHERE code=${sqlLiteral(codes.customerA)}), DATE ${sqlLiteral(billDate)}, 'CNY', 100, 0, 'OPEN'),
      (${sqlLiteral(codes.arLegacy)}, ${sqlLiteral(`${fixturePrefix}-SOLEG`)}, (SELECT id FROM ${t("md_customer")} WHERE code=${sqlLiteral(codes.customerA)}), DATE ${sqlLiteral(billDate)}, 'CNY', 40, 20, 'PART_SETTLED'),
      (${sqlLiteral(codes.arDone)}, ${sqlLiteral(`${fixturePrefix}-SODONE`)}, (SELECT id FROM ${t("md_customer")} WHERE code=${sqlLiteral(codes.customerA)}), DATE ${sqlLiteral(billDate)}, 'CNY', 10, 10, 'SETTLED');

    INSERT INTO ${t("ap_payable")} (bill_no, source_bill_no, supplier_id, bill_date, currency, amount, paid_amount, status) VALUES
      (${sqlLiteral(codes.ap1)}, ${sqlLiteral(`${fixturePrefix}-PO1`)}, (SELECT id FROM ${t("md_supplier")} WHERE code=${sqlLiteral(codes.supplierA)}), DATE ${sqlLiteral(billDate)}, 'CNY', 100, 0, 'OPEN'),
      (${sqlLiteral(codes.ap2)}, ${sqlLiteral(`${fixturePrefix}-PO2`)}, (SELECT id FROM ${t("md_supplier")} WHERE code=${sqlLiteral(codes.supplierA)}), DATE ${sqlLiteral(billDate)}, 'CNY', 200, 0, 'OPEN'),
      (${sqlLiteral(codes.apUsd)}, ${sqlLiteral(`${fixturePrefix}-POUSD`)}, (SELECT id FROM ${t("md_supplier")} WHERE code=${sqlLiteral(codes.supplierA)}), DATE ${sqlLiteral(billDate)}, 'USD', 150, 0, 'OPEN'),
      (${sqlLiteral(codes.apWrong)}, ${sqlLiteral(`${fixturePrefix}-POWRONG`)}, (SELECT id FROM ${t("md_supplier")} WHERE code=${sqlLiteral(codes.supplierB)}), DATE ${sqlLiteral(billDate)}, 'CNY', 50, 0, 'OPEN'),
      (${sqlLiteral(codes.apSmall)}, ${sqlLiteral(`${fixturePrefix}-POSMALL`)}, (SELECT id FROM ${t("md_supplier")} WHERE code=${sqlLiteral(codes.supplierA)}), DATE ${sqlLiteral(billDate)}, 'CNY', 10, 0, 'OPEN'),
      (${sqlLiteral(codes.apLegacy)}, ${sqlLiteral(`${fixturePrefix}-POLEG`)}, (SELECT id FROM ${t("md_supplier")} WHERE code=${sqlLiteral(codes.supplierA)}), DATE ${sqlLiteral(billDate)}, 'CNY', 40, 20, 'PART_SETTLED'),
      (${sqlLiteral(codes.apDone)}, ${sqlLiteral(`${fixturePrefix}-PODONE`)}, (SELECT id FROM ${t("md_supplier")} WHERE code=${sqlLiteral(codes.supplierA)}), DATE ${sqlLiteral(billDate)}, 'CNY', 10, 10, 'SETTLED');

    INSERT INTO ${t("ar_receipt")} (
      bill_no, legacy_receivable_id, party_id, bill_date, currency, amount, status, version,
      remark, legacy_imported, created_at, updated_at, audited_at
    ) SELECT ${sqlLiteral(codes.legacyReceipt)}, id, customer_id, bill_date, currency, 20, 'AUDITED', 0,
             ${sqlLiteral(`${fixturePrefix}-legacy-receipt`)}, TRUE, now(), now(), now()
      FROM ${t("ar_receivable")} WHERE bill_no=${sqlLiteral(codes.arLegacy)};
    INSERT INTO ${t("ar_receipt_allocation")} (
      receipt_id, line_no, receivable_id, source_amount, settled_before, unsettled_before, settlement_amount, remark
    ) SELECT h.id, 1, s.id, 40, 0, 40, 20, ${sqlLiteral(`${fixturePrefix}-legacy-allocation`)}
      FROM ${t("ar_receipt")} h, ${t("ar_receivable")} s
      WHERE h.bill_no=${sqlLiteral(codes.legacyReceipt)} AND s.bill_no=${sqlLiteral(codes.arLegacy)};

    INSERT INTO ${t("ap_payment")} (
      bill_no, legacy_payable_id, party_id, bill_date, currency, amount, status, version,
      remark, legacy_imported, created_at, updated_at, audited_at
    ) SELECT ${sqlLiteral(codes.legacyPayment)}, id, supplier_id, bill_date, currency, 20, 'AUDITED', 0,
             ${sqlLiteral(`${fixturePrefix}-legacy-payment`)}, TRUE, now(), now(), now()
      FROM ${t("ap_payable")} WHERE bill_no=${sqlLiteral(codes.apLegacy)};
    INSERT INTO ${t("ap_payment_allocation")} (
      payment_id, line_no, payable_id, source_amount, settled_before, unsettled_before, settlement_amount, remark
    ) SELECT h.id, 1, s.id, 40, 0, 40, 20, ${sqlLiteral(`${fixturePrefix}-legacy-allocation`)}
      FROM ${t("ap_payment")} h, ${t("ap_payable")} s
      WHERE h.bill_no=${sqlLiteral(codes.legacyPayment)} AND s.bill_no=${sqlLiteral(codes.apLegacy)};
    COMMIT;
  `);
}

function setupFixtures() {
  assert(new URL(apiBase).hostname === "127.0.0.1" && new URL(frontendUrl).hostname === "127.0.0.1", "A141 只允许访问本机服务");
  const currentSchema = dbScalar("SELECT current_schema()");
  assert(currentSchema === "public", "A141 只允许在 public 测试账套准备主夹具", { currentSchema });
  const primaryAccount = dbJson(`
    SELECT row_to_json(row_value)::text FROM (
      SELECT id::text AS id, code, name, schema_name AS "schemaName", enabled
      FROM public.sys_account_set WHERE code='BLD-TEST'
    ) row_value
  `);
  assert(primaryAccount?.enabled === true && primaryAccount.schemaName === "public", "BLD-TEST 必须是启用的 public 测试账套", primaryAccount);
  replayTenant = dbJson(`
    SELECT row_to_json(row_value)::text FROM (
      SELECT id::text AS id, code, name, schema_name AS "schemaName"
      FROM public.sys_account_set
      WHERE enabled=TRUE AND code <> 'BLD-TEST' AND code LIKE 'A119%' AND schema_name <> 'public'
      ORDER BY CASE WHEN code='A119UI' THEN 0 ELSE 1 END, code LIMIT 1
    ) row_value
  `);
  assert(replayTenant?.code && replayTenant?.schemaName, "A141 租户隔离需要一个 A119 测试账套", replayTenant);
  const requiredTables = [
    "md_customer", "md_supplier", "md_financial_account", "ar_receivable", "ap_payable",
    "ar_receipt", "ar_receipt_fund_line", "ar_receipt_allocation",
    "ap_payment", "ap_payment_fund_line", "ap_payment_allocation", "sys_operation_log"
  ];
  const ready = Number(dbScalar(`
    SELECT count(*) FROM information_schema.tables
    WHERE table_schema=${sqlLiteral(replayTenant.schemaName)}
      AND table_name IN (${requiredTables.map(sqlLiteral).join(",")})
  `));
  assert(ready === requiredTables.length, "A119 测试账套必须已同步 V102 表", { ready, expected: requiredTables.length });
  const existing = Number(dbScalar(`
    SELECT (SELECT count(*) FROM public.sys_user WHERE username LIKE ${sqlLiteral(`${userPrefix}%`)})
         + (SELECT count(*) FROM public.md_customer WHERE code LIKE ${sqlLiteral(`${fixturePrefix}%`)})
         + (SELECT count(*) FROM public.md_supplier WHERE code LIKE ${sqlLiteral(`${fixturePrefix}%`)})
         + (SELECT count(*) FROM public.ar_receivable WHERE bill_no LIKE ${sqlLiteral(`${fixturePrefix}%`)})
  `));
  assert(existing === 0, "A141 唯一夹具前缀不得已有残留", { existing });

  const userValues = Object.values(users)
    .map((user) => `(${sqlLiteral(user.username)}, ${sqlLiteral(user.password)}, ${sqlLiteral(user.role)})`)
    .join(",");
  dbScalar(`
    BEGIN;
    INSERT INTO public.sys_role (code, name, enabled) VALUES (${sqlLiteral(reportRoleCode)}, 'A141 只读财务报表', TRUE);
    INSERT INTO public.sys_permission (role_id, permission_code, enabled)
      SELECT id, 'finance.report.view', TRUE FROM public.sys_role WHERE code=${sqlLiteral(reportRoleCode)};
    CREATE TEMP TABLE a141_users (username text, password text, role_code text) ON COMMIT DROP;
    INSERT INTO a141_users VALUES ${userValues};
    INSERT INTO public.sys_user (username, display_name, password_hash, enabled, default_account_set_id)
      SELECT u.username, 'A141 '||u.role_code, '{noop}'||u.password, TRUE, a.id
      FROM a141_users u JOIN public.sys_account_set a ON a.code='BLD-TEST' AND a.enabled=TRUE;
    INSERT INTO public.sys_user_role (user_id, role_id)
      SELECT u.id, r.id FROM a141_users f
      JOIN public.sys_user u ON u.username=f.username
      JOIN public.sys_role r ON r.code=f.role_code AND r.enabled=TRUE;
    INSERT INTO public.sys_user_account_set (user_id, account_set_id, role_code, is_default, enabled)
      SELECT u.id, a.id, f.role_code, TRUE, TRUE FROM a141_users f
      JOIN public.sys_user u ON u.username=f.username
      JOIN public.sys_account_set a ON a.code='BLD-TEST' AND a.enabled=TRUE;
    INSERT INTO public.sys_user_account_set (user_id, account_set_id, role_code, is_default, enabled)
      SELECT u.id, a.id, f.role_code, FALSE, TRUE FROM a141_users f
      JOIN public.sys_user u ON u.username=f.username
      JOIN public.sys_account_set a ON a.code=${sqlLiteral(replayTenant.code)} AND a.enabled=TRUE
      WHERE f.role_code IN ('ADMIN','FINANCE');
    COMMIT;
  `);
  insertTenantFixtures("public");
  insertTenantFixtures(replayTenant.schemaName);
  ids = { public: fixtureIds("public"), replay: fixtureIds(replayTenant.schemaName) };
  assert(Object.values(ids.public).every(Boolean) && Object.values(ids.replay).every(Boolean), "A141 双账套夹具 ID 必须完整", ids);
  evidence.environment = { primaryAccount, replayTenant, reportRoleCode, faultInjection: faultInjection || null };
}

async function loginFixtures() {
  cookies.admin = await loginApi(apiBase, users.admin.username, users.admin.password, "BLD-TEST");
  cookies.finance = await loginApi(apiBase, users.finance.username, users.finance.password, "BLD-TEST");
  cookies.warehouse = await loginApi(apiBase, users.warehouse.username, users.warehouse.password, "BLD-TEST");
  cookies.report = await loginApi(apiBase, users.report.username, users.report.password, "BLD-TEST");
  cookies.replayAdmin = await loginApi(apiBase, users.replayAdmin.username, users.replayAdmin.password, replayTenant.code);
  cookies.replayFinance = await loginApi(apiBase, users.replayFinance.username, users.replayFinance.password, replayTenant.code);
}

async function verifyPermissionsAndRetiredRoutes() {
  const zero = zeroPayload("receipt", ids.public.customerA, `${fixturePrefix}-permission-zero`);
  const formalCases = [
    ["anonymous", "", 401],
    ["warehouse", cookies.warehouse, 403],
    ["report", cookies.report, 403]
  ];
  for (const [role, cookie, expected] of formalCases) {
    const create = await createDraft("receipt", zero, expected, cookie, `${role} formal receipt create`);
    evidence.permissions.push({ role, operation: "formal-create", status: create.status });
  }

  const permissionDraft = await createDraft("receipt", zero, 201, cookies.finance, "finance formal receipt create");
  const permissionBill = permissionDraft.data.billNo;
  assert(/^SKD\d{6}$/.test(permissionBill), "正式收款单必须使用系统 SKD 单号", permissionDraft.data);
  for (const [role, cookie, expected] of [
    ["anonymous", "", 401], ["warehouse", cookies.warehouse, 403],
    ["report", cookies.report, 200], ["finance", cookies.finance, 200], ["admin", cookies.admin, 200]
  ]) {
    const detail = await documentAction("receipt", permissionBill, "detail", expected, cookie, undefined, `${role} receipt detail`);
    evidence.permissions.push({ role, operation: "formal-detail", status: detail.status });
  }
  for (const [role, cookie, expected] of [
    ["anonymous", "", 401], ["warehouse", cookies.warehouse, 403],
    ["report", cookies.report, 200], ["finance", cookies.finance, 200], ["admin", cookies.admin, 200]
  ]) {
    const response = await list(cookie, "ar-receipt-form-list", { keyword: permissionBill });
    expectStatus(`${role} formal receipt list`, response, expected);
    evidence.permissions.push({ role, operation: "formal-list", status: response.status });
  }
  for (const [role, cookie, expected] of [
    ["anonymous", "", 401], ["warehouse", cookies.warehouse, 403],
    ["report", cookies.report, 403], ["finance", cookies.finance, 200], ["admin", cookies.admin, 200]
  ]) {
    const source = await list(cookie, "ar-receivable-settlement-source-selector", { keyword: codes.ar1 });
    expectStatus(`${role} source selector`, source, expected);
    const account = await list(cookie, "financial-account-settlement-selector", { keyword: codes.bankCny });
    expectStatus(`${role} account selector`, account, expected);
    evidence.permissions.push({ role, operation: "selectors", statuses: [source.status, account.status] });
  }
  await documentAction("receipt", permissionBill, "delete", 200, cookies.finance, undefined, "permission draft delete");
  const adminDraft = await createDraft("payment", zeroPayload("payment", ids.public.supplierA, `${fixturePrefix}-admin-permission-zero`), 201, cookies.admin, "admin formal payment create");
  await documentAction("payment", adminDraft.data.billNo, "delete", 200, cookies.admin, undefined, "admin formal payment delete");

  const before = {
    ar: sourceState("public", "receipt", codes.ar1),
    ap: sourceState("public", "payment", codes.ap1),
    receiptCount: Number(dbScalar(`SELECT count(*) FROM public.ar_receipt WHERE remark LIKE ${sqlLiteral(`${fixturePrefix}%`)}`)),
    paymentCount: Number(dbScalar(`SELECT count(*) FROM public.ap_payment WHERE remark LIKE ${sqlLiteral(`${fixturePrefix}%`)}`)),
    receiveLogs: actionCount("public", users.finance.username, "RECEIVE"),
    payLogs: actionCount("public", users.finance.username, "PAY")
  };
  const retiredBody = { date: billDate, amount: 1 };
  for (const [role, cookie, expected] of [["anonymous", "", 401], ["warehouse", cookies.warehouse, 403], ["finance", cookies.finance, 410], ["admin", cookies.admin, 410]]) {
    const receipt = await request(cookie, `/api/finance/receivables/${encodeURIComponent(codes.ar1)}/receipt`, { method: "POST", body: retiredBody });
    const payment = await request(cookie, `/api/finance/payables/${encodeURIComponent(codes.ap1)}/payment`, { method: "POST", body: retiredBody });
    expectStatus(`${role} retired receipt`, receipt, expected);
    expectStatus(`${role} retired payment`, payment, expected);
    if (expected === 410) {
      assert(receipt.text.includes("/api/finance/receipts/draft"), "旧收款 410 必须提示正式入口", receipt.text);
      assert(payment.text.includes("/api/finance/payments/draft"), "旧付款 410 必须提示正式入口", payment.text);
    }
  }
  const after = {
    ar: sourceState("public", "receipt", codes.ar1),
    ap: sourceState("public", "payment", codes.ap1),
    receiptCount: Number(dbScalar(`SELECT count(*) FROM public.ar_receipt WHERE remark LIKE ${sqlLiteral(`${fixturePrefix}%`)}`)),
    paymentCount: Number(dbScalar(`SELECT count(*) FROM public.ap_payment WHERE remark LIKE ${sqlLiteral(`${fixturePrefix}%`)}`)),
    receiveLogs: actionCount("public", users.finance.username, "RECEIVE"),
    payLogs: actionCount("public", users.finance.username, "PAY")
  };
  assert(same(after, before), "旧接口 401/403/410 全部分支必须业务事实与成功日志零变化", { before, after });
  evidence.coverage.permissions = true;
  evidence.coverage.retiredRoutes = true;
}

async function verifyZeroDraftAndCas() {
  const negative = { ...zeroPayload("receipt", ids.public.customerA, `${fixturePrefix}-negative`), amount: -1 };
  const negativeResponse = await createDraft("receipt", negative, 400, cookies.finance, "negative draft rejected");
  assert(negativeResponse.text.includes("不能为负数"), "负数草稿必须给出明确原因", negativeResponse.text);

  const created = await createDraft("receipt", zeroPayload("receipt", ids.public.customerA, `${fixturePrefix}-cas`), 201, cookies.finance, "zero receipt draft");
  const billNo = created.data.billNo;
  assert(created.data.amount === "0.00" && created.data.status === "DRAFT" && created.data.version === "0", "0 元草稿应以精确字符串保存为 v0 DRAFT", created.data);
  assert(sourceState("public", "receipt", codes.ar1).settledAmount === "0.00", "0 元草稿不得占用来源");

  const winnerPayload = { ...zeroPayload("receipt", ids.public.customerA, `${fixturePrefix}-cas-winner`), version: 0 };
  const winner = await documentAction("receipt", billNo, "update", 200, cookies.finance, winnerPayload, "CAS winner");
  assert(winner.data.version === "1" && winner.data.remark.includes("cas-winner"), "CAS winner 必须以精确字符串递增版本并保存内容", winner.data);
  const stale = await documentAction("receipt", billNo, "update", 409, cookies.finance, { ...winnerPayload, remark: `${fixturePrefix}-cas-loser` }, "CAS stale loser");
  assert(stale.text.includes("版本"), "旧版本更新必须返回版本冲突", stale.text);
  const fractional = await documentAction("receipt", billNo, "update", 400, cookies.finance, { ...winnerPayload, version: 1.5 }, "fractional version rejected");
  assert(fractional.status === 400, "version 必须是严格整数");
  const detail = await documentAction("receipt", billNo, "detail", 200, cookies.finance, undefined, "CAS final detail");
  assert(detail.data.version === "1" && detail.data.remark.includes("cas-winner"), "CAS 失败不得覆盖 winner 或递增版本", detail.data);
  await documentAction("receipt", billNo, "audit", 400, cookies.finance, undefined, "zero draft audit rejected");
  await documentAction("receipt", billNo, "reverse", 409, cookies.finance, undefined, "draft reverse rejected");
  await documentAction("receipt", billNo, "delete", 200, cookies.finance, undefined, "zero draft delete");
  await documentAction("receipt", billNo, "detail", 404, cookies.finance, undefined, "deleted zero draft absent");
  evidence.lifecycle.zeroAndCas = { billNo, versions: [0, 1], statuses: { stale: 409, zeroAudit: 400, delete: 200 } };
  evidence.coverage.zeroDraftNegativeCas = true;
}

async function verifyExactJsonPrecision() {
  const maxMoney = "9999999999999999.99";
  const exactSourceBill = `${fixturePrefix}-AREXACT`;
  const exactSourceId = dbScalar(`
    INSERT INTO public.ar_receivable (
      bill_no, source_bill_no, customer_id, bill_date, currency, amount, received_amount, status
    ) VALUES (
      ${sqlLiteral(exactSourceBill)}, ${sqlLiteral(`${fixturePrefix}-SOEXACT`)}, ${sqlLiteral(ids.public.customerA)}::uuid,
      DATE ${sqlLiteral(billDate)}, 'USD', ${sqlLiteral(maxMoney)}::numeric, 0, 'OPEN'
    ) RETURNING id::text
  `);
  const exactPayload = {
    partyId: ids.public.customerA,
    billDate,
    currency: "USD",
    amount: maxMoney,
    remark: `${fixturePrefix}-exact-money`,
    fundLines: [{
      lineNo: 1,
      accountId: ids.public.bankUsd,
      paymentMethod: "BANK_TRANSFER",
      amount: maxMoney,
      fee: "0.00",
      transactionNo: `${fixturePrefix}-SECRET-EXACT`,
      remark: `${fixturePrefix}-exact-fund`
    }],
    allocations: [{ lineNo: 1, sourceId: exactSourceId, settlementAmount: maxMoney, remark: `${fixturePrefix}-exact-allocation` }]
  };
  const exact = await createDraft("receipt", exactPayload, 201, cookies.finance, "NUMERIC(18,2) exact draft");
  assert(exact.data.amount === maxMoney && typeof exact.data.amount === "string", "header amount 必须以精确十进制字符串返回", exact.data);
  assert(exact.data.version === "0" && typeof exact.data.version === "string", "version 必须以字符串返回", exact.data);
  assert(exact.data.fundLines[0].amount === maxMoney && exact.data.fundLines[0].fee === "0.00", "资金金额/手续费必须以精确字符串返回", exact.data.fundLines[0]);
  assert(exact.data.allocations[0].sourceAmount === maxMoney
    && exact.data.allocations[0].settlementAmount === maxMoney
    && exact.data.allocations[0].settledBefore === "0.00"
    && exact.data.allocations[0].unsettledBefore === maxMoney,
  "核销行 NUMERIC(18,2) 字段必须以精确字符串返回", exact.data.allocations[0]);
  const exactList = await list(cookies.finance, "ar-receipt-form-list", { keyword: exact.data.billNo });
  expectStatus("exact money formal receipt list", exactList, 200);
  assert(exactList.data.rows.some((row) => row.billNo === exact.data.billNo && row.amount === maxMoney), "正式单据列表也必须无损返回 NUMERIC(18,2) 最大金额", exactList.data.rows);
  await documentAction("receipt", exact.data.billNo, "delete", 200, cookies.finance, undefined, "exact money draft delete");

  const wide = await createDraft("receipt", zeroPayload("receipt", ids.public.customerA, `${fixturePrefix}-wide-version`), 201, cookies.finance, "wide version base draft");
  dbScalar(`UPDATE public.ar_receipt SET version=9007199254740993 WHERE bill_no=${sqlLiteral(wide.data.billNo)}`);
  const wideDetail = await documentAction("receipt", wide.data.billNo, "detail", 200, cookies.finance, undefined, "wide version detail");
  assert(wideDetail.data.version === "9007199254740993" && typeof wideDetail.data.version === "string", "超过 2^53 的 version 必须无损返回字符串", wideDetail.data);
  const wideUpdated = await documentAction("receipt", wide.data.billNo, "update", 200, cookies.finance, {
    ...zeroPayload("receipt", ids.public.customerA, `${fixturePrefix}-wide-version-updated`),
    version: "9007199254740993"
  }, "wide string version update");
  assert(wideUpdated.data.version === "9007199254740994", "超过 2^53 的规范字符串 version 必须精确 CAS+1", wideUpdated.data);
  for (const invalidVersion of ["01", "+1", "1.0", "1e3", "9223372036854775808"]) {
    await documentAction("receipt", wide.data.billNo, "update", 400, cookies.finance, {
      ...zeroPayload("receipt", ids.public.customerA, `${fixturePrefix}-invalid-version`),
      version: invalidVersion
    }, `invalid canonical version ${invalidVersion}`);
  }
  await documentAction("receipt", wide.data.billNo, "delete", 200, cookies.finance, undefined, "wide version draft delete");
  evidence.lifecycle.exactJson = { maxMoney, exactBillNo: exact.data.billNo, wideBillNo: wide.data.billNo, wideVersions: ["9007199254740993", "9007199254740994"] };
  evidence.coverage.exactMoneyAndWideVersion = true;
}

function mainReceiptPayload(remark = `${fixturePrefix}-main-receipt`) {
  return settlementPayload({
    partyId: ids.public.customerA,
    funds: [
      { accountId: ids.public.cashCny, method: "CASH", amount: 90 },
      { accountId: ids.public.bankCny, method: "BANK_TRANSFER", amount: 150 }
    ],
    allocations: [{ sourceId: ids.public.ar1, amount: 40 }, { sourceId: ids.public.ar2, amount: 200 }],
    remark
  });
}

function mainPaymentPayload(remark = `${fixturePrefix}-main-payment`) {
  return settlementPayload({
    partyId: ids.public.supplierA,
    funds: [
      { accountId: ids.public.cashCny, method: "CASH", amount: 100 },
      { accountId: ids.public.bankCny, method: "BANK_TRANSFER", amount: 150 }
    ],
    allocations: [{ sourceId: ids.public.ap1, amount: 50 }, { sourceId: ids.public.ap2, amount: 200 }],
    remark
  });
}

async function exerciseMainLifecycle(kind, payload, expectedSources) {
  const created = await createDraft(kind, payload, 201, cookies.finance, `${kind} CNY multi draft`);
  const billNo = created.data.billNo;
  const prefix = kind === "receipt" ? "SKD" : "FKD";
  assert(new RegExp(`^${prefix}\\d{6}$`).test(billNo), `${kind} 必须自动生成正式单号`, created.data);
  assert(created.data.currency === "CNY" && created.data.fundLines.length === 2 && created.data.allocations.length === 2, `${kind} 草稿必须保留两账户两来源`, created.data);
  for (const source of expectedSources) {
    const beforeAudit = sourceState("public", kind, source.billNo);
    assert(Number(beforeAudit.settledAmount) === 0 && beforeAudit.status === "OPEN", `${kind} 草稿不得提前占用 ${source.billNo}`, beforeAudit);
  }
  const audited = await documentAction(kind, billNo, "audit", 200, cookies.finance, undefined, `${kind} CNY audit`);
  assert(audited.data.status === "AUDITED" && audited.data.version === "1", `${kind} 审核必须转 AUDITED/v1 且 version 为精确字符串`, audited.data);
  for (const source of expectedSources) {
    const state = sourceState("public", kind, source.billNo);
    assert(Number(state.settledAmount) === source.settled && state.status === source.status, `${kind} 审核必须精确更新 ${source.billNo}`, state);
  }
  const auditAction = kind === "receipt" ? "AUDIT_RECEIPT" : "AUDIT_PAYMENT";
  const beforeReplayLogs = actionCount("public", users.finance.username, auditAction, billNo);
  const replay = await documentAction(kind, billNo, "audit", 200, cookies.finance, undefined, `${kind} audit idempotent replay`);
  const afterReplayLogs = actionCount("public", users.finance.username, auditAction, billNo);
  assert(replay.data.version === audited.data.version && afterReplayLogs === beforeReplayLogs, `${kind} 重复审核必须幂等且不重复成功日志`, { beforeReplayLogs, afterReplayLogs, replay: replay.data });
  const rejectedUpdate = { ...payload, version: audited.data.version, remark: `${fixturePrefix}-audited-update-rejected` };
  await documentAction(kind, billNo, "update", 409, cookies.finance, rejectedUpdate, `${kind} audited update rejected`);
  await documentAction(kind, billNo, "delete", 409, cookies.finance, undefined, `${kind} audited delete rejected`);
  const reversed = await documentAction(kind, billNo, "reverse", 200, cookies.finance, undefined, `${kind} multi-source reverse`);
  assert(reversed.data.status === "DRAFT" && reversed.data.version === "2", `${kind} 反审核必须回 DRAFT/v2 并保留明细`, reversed.data);
  for (const source of expectedSources) {
    const state = sourceState("public", kind, source.billNo);
    assert(Number(state.settledAmount) === 0 && state.status === "OPEN", `${kind} 反审核必须精确释放 ${source.billNo}`, state);
  }
  await documentAction(kind, billNo, "reverse", 409, cookies.finance, undefined, `${kind} draft second reverse rejected`);
  return billNo;
}

async function verifyCnyAndUsdLifecycles() {
  const receiptBill = await exerciseMainLifecycle("receipt", mainReceiptPayload(), [
    { billNo: codes.ar1, settled: 40, status: "PART_SETTLED" },
    { billNo: codes.ar2, settled: 200, status: "SETTLED" }
  ]);
  const paymentBill = await exerciseMainLifecycle("payment", mainPaymentPayload(), [
    { billNo: codes.ap1, settled: 50, status: "PART_SETTLED" },
    { billNo: codes.ap2, settled: 200, status: "SETTLED" }
  ]);

  const usdCases = [
    {
      kind: "receipt", partyId: ids.public.customerA, sourceId: ids.public.arUsd,
      sourceBillNo: codes.arUsd, amount: 60
    },
    {
      kind: "payment", partyId: ids.public.supplierA, sourceId: ids.public.apUsd,
      sourceBillNo: codes.apUsd, amount: 90
    }
  ];
  const usdBills = [];
  for (const fixture of usdCases) {
    const payload = settlementPayload({
      partyId: fixture.partyId,
      currency: "USD",
      funds: [{ accountId: ids.public.bankUsd, method: "BANK_TRANSFER", amount: fixture.amount }],
      allocations: [{ sourceId: fixture.sourceId, amount: fixture.amount }],
      remark: `${fixturePrefix}-usd-${fixture.kind}`
    });
    const created = await createDraft(fixture.kind, payload, 201, cookies.finance, `${fixture.kind} USD draft`);
    assert(created.data.currency === "USD" && created.data.amount === Number(fixture.amount).toFixed(2), `${fixture.kind} USD 草稿必须按精确字符串原币保存且无换算字段`, created.data);
    assert(!Object.keys(created.data).some((key) => /exchange|rate|converted/i.test(key)), `${fixture.kind} USD 响应不得出现汇率或换算字段`, created.data);
    await documentAction(fixture.kind, created.data.billNo, "audit", 200, cookies.finance, undefined, `${fixture.kind} USD audit`);
    const source = sourceState("public", fixture.kind, fixture.sourceBillNo);
    assert(source.currency === "USD" && Number(source.settledAmount) === fixture.amount, `${fixture.kind} USD 必须只更新 USD 原币来源`, source);
    await documentAction(fixture.kind, created.data.billNo, "reverse", 200, cookies.finance, undefined, `${fixture.kind} USD reverse`);
    await documentAction(fixture.kind, created.data.billNo, "delete", 200, cookies.finance, undefined, `${fixture.kind} USD draft delete`);
    usdBills.push(created.data.billNo);
  }
  evidence.lifecycle.cny = { receiptBill, paymentBill };
  evidence.lifecycle.usd = usdBills;
  evidence.coverage.cnyUsdReceiptPayment = true;
  evidence.coverage.multiSourceMultiAccount = true;
  return { receiptBill, paymentBill };
}

async function verifyValidationBoundaries() {
  const beforeDocuments = Number(dbScalar(`
    SELECT (SELECT count(*) FROM public.ar_receipt WHERE remark LIKE ${sqlLiteral(`${fixturePrefix}-invalid%`)})
         + (SELECT count(*) FROM public.ap_payment WHERE remark LIKE ${sqlLiteral(`${fixturePrefix}-invalid%`)})
  `));
  const base = {
    partyId: ids.public.customerA,
    funds: [{ accountId: ids.public.bankCny, method: "BANK_TRANSFER", amount: 10 }],
    allocations: [{ sourceId: ids.public.arSmall, amount: 10 }]
  };
  const cases = [
    ["different party", { ...base, allocations: [{ sourceId: ids.public.arWrong, amount: 10 }] }, 409],
    ["source currency mismatch", { ...base, allocations: [{ sourceId: ids.public.arUsd, amount: 10 }] }, 409],
    ["account currency mismatch", { ...base, funds: [{ accountId: ids.public.bankUsd, method: "BANK_TRANSFER", amount: 10 }] }, 409],
    ["draft account", { ...base, funds: [{ accountId: ids.public.draftCny, method: "CASH", amount: 10 }] }, 409],
    ["disabled account", { ...base, funds: [{ accountId: ids.public.disabledCny, method: "CASH", amount: 10 }] }, 409],
    ["cash account wrong method", { ...base, funds: [{ accountId: ids.public.cashCny, method: "BANK_TRANSFER", amount: 10 }] }, 409],
    ["bank account cash method", { ...base, funds: [{ accountId: ids.public.bankCny, method: "CASH", amount: 10 }] }, 409],
    ["nonzero fee", { ...base, funds: [{ accountId: ids.public.bankCny, method: "BANK_TRANSFER", amount: 10, fee: 0.01 }] }, 400],
    ["source overrun", { ...base, funds: [{ accountId: ids.public.bankCny, method: "BANK_TRANSFER", amount: 11 }], allocations: [{ sourceId: ids.public.arSmall, amount: 11 }] }, 409]
  ];
  const results = [];
  for (const [label, fixture, expected] of cases) {
    const payload = settlementPayload({ ...fixture, remark: `${fixturePrefix}-invalid-${label}` });
    const response = await createDraft("receipt", payload, expected, cookies.finance, `invalid ${label}`);
    results.push({ label, status: response.status });
  }
  const afterDocuments = Number(dbScalar(`
    SELECT (SELECT count(*) FROM public.ar_receipt WHERE remark LIKE ${sqlLiteral(`${fixturePrefix}-invalid%`)})
         + (SELECT count(*) FROM public.ap_payment WHERE remark LIKE ${sqlLiteral(`${fixturePrefix}-invalid%`)})
  `));
  assert(afterDocuments === beforeDocuments, "往来/币种/账户/手续费/超额失败不得残留单据", { beforeDocuments, afterDocuments });
  assert(Number(sourceState("public", "receipt", codes.arSmall).settledAmount) === 0, "全部校验失败不得修改来源余额");
  evidence.lifecycle.validationBoundaries = results;
  evidence.coverage.validationBoundaries = true;
}

async function verifyConcurrentAudit() {
  const payload = (suffix) => settlementPayload({
    partyId: ids.public.customerA,
    funds: [{ accountId: ids.public.bankCny, method: "BANK_TRANSFER", amount: 80 }],
    allocations: [{ sourceId: ids.public.arRace, amount: 80 }],
    remark: `${fixturePrefix}-race-${suffix}`
  });
  const first = await createDraft("receipt", payload("A"), 201, cookies.finance, "race draft A");
  const second = await createDraft("receipt", payload("B"), 201, cookies.finance, "race draft B");
  const outcomes = await Promise.all([
    request(cookies.finance, `/api/finance/receipts/${encodeURIComponent(first.data.billNo)}/audit`, { method: "POST" }),
    request(cookies.finance, `/api/finance/receipts/${encodeURIComponent(second.data.billNo)}/audit`, { method: "POST" })
  ]);
  outcomes.forEach((response, index) => evidence.requests.push({ label: `race audit ${index + 1}`, expected: [200, 409], actual: response.status }));
  assert(outcomes.map((row) => row.status).sort().join(",") === "200,409", "两张竞争草稿审核必须恰好一成一败", outcomes.map((row) => ({ status: row.status, body: row.text.slice(0, 200) })));
  const state = sourceState("public", "receipt", codes.arRace);
  assert(Number(state.settledAmount) === 80 && state.status === "PART_SETTLED", "并发审核不得超额、负余量或半截更新", state);
  const documents = [first.data.billNo, second.data.billNo].map((billNo) => documentState("public", "receipt", billNo));
  assert(documents.filter((row) => row.status === "AUDITED").length === 1 && documents.filter((row) => row.status === "DRAFT").length === 1, "并发后必须一张 AUDITED、一张 DRAFT", documents);
  const winner = documents.find((row) => row.status === "AUDITED").billNo;
  await documentAction("receipt", winner, "reverse", 200, cookies.finance, undefined, "race winner reverse");
  for (const billNo of [first.data.billNo, second.data.billNo]) await documentAction("receipt", billNo, "delete", 200, cookies.finance, undefined, `race cleanup ${billNo}`);
  assert(Number(sourceState("public", "receipt", codes.arRace).settledAmount) === 0, "并发 winner 反审核必须恢复来源");
  evidence.concurrency = { bills: [first.data.billNo, second.data.billNo], statuses: outcomes.map((row) => row.status), winner };
  evidence.coverage.concurrentAudit = true;
}

async function verifyReverseAtomicity() {
  const payload = settlementPayload({
    partyId: ids.public.customerA,
    funds: [{ accountId: ids.public.bankCny, method: "BANK_TRANSFER", amount: 40 }],
    allocations: [{ sourceId: ids.public.arAtomic1, amount: 20 }, { sourceId: ids.public.arAtomic2, amount: 20 }],
    remark: `${fixturePrefix}-reverse-atomic`
  });
  const created = await createDraft("receipt", payload, 201, cookies.finance, "reverse atomic draft");
  await documentAction("receipt", created.data.billNo, "audit", 200, cookies.finance, undefined, "reverse atomic audit");
  dbScalar(`UPDATE public.ar_receivable SET amount=101 WHERE bill_no=${sqlLiteral(codes.arAtomic2)}`);
  const before = {
    doc: documentState("public", "receipt", created.data.billNo),
    a: sourceState("public", "receipt", codes.arAtomic1),
    b: sourceState("public", "receipt", codes.arAtomic2)
  };
  await documentAction("receipt", created.data.billNo, "reverse", 409, cookies.finance, undefined, "reverse atomic mismatch rejected");
  const after = {
    doc: documentState("public", "receipt", created.data.billNo),
    a: sourceState("public", "receipt", codes.arAtomic1),
    b: sourceState("public", "receipt", codes.arAtomic2)
  };
  assert(same(after, before), "任一来源不一致时反审核必须整笔回滚，不能半截释放", { before, after });
  dbScalar(`UPDATE public.ar_receivable SET amount=100 WHERE bill_no=${sqlLiteral(codes.arAtomic2)}`);
  await documentAction("receipt", created.data.billNo, "reverse", 200, cookies.finance, undefined, "reverse atomic retry");
  await documentAction("receipt", created.data.billNo, "delete", 200, cookies.finance, undefined, "reverse atomic delete");
  evidence.lifecycle.reverseAtomicity = { billNo: created.data.billNo, rejected: 409, retry: 200 };
  evidence.coverage.reverseAtomicity = true;
}

async function exerciseLegacy(kind, billNo, partyId, sourceId, sourceBillNo) {
  const initial = await documentAction(kind, billNo, "detail", 200, cookies.finance, undefined, `${kind} legacy detail`);
  assert(initial.data.legacy === true && initial.data.status === "AUDITED" && initial.data.fundLines.length === 0 && initial.data.allocations.length === 1, `${kind} legacy 必须明确标记且不得伪造资金账户`, initial.data);
  const replayAction = kind === "receipt" ? "AUDIT_RECEIPT" : "AUDIT_PAYMENT";
  const beforeReplay = actionCount("public", users.finance.username, replayAction, billNo);
  const idempotent = await documentAction(kind, billNo, "audit", 200, cookies.finance, undefined, `${kind} audited legacy idempotent`);
  assert(idempotent.data.version === initial.data.version && actionCount("public", users.finance.username, replayAction, billNo) === beforeReplay, `${kind} legacy 已审核重放不得写审核日志`);
  const reversed = await documentAction(kind, billNo, "reverse", 200, cookies.finance, undefined, `${kind} legacy reverse`);
  assert(reversed.data.legacy === true && reversed.data.status === "DRAFT" && reversed.data.fundLines.length === 0, `${kind} legacy 反审核后应保留只读头/来源并等待补账户`, reversed.data);
  assert(Number(sourceState("public", kind, sourceBillNo).settledAmount) === 0, `${kind} legacy 反审核必须释放原影响`);
  await documentAction(kind, billNo, "audit", 400, cookies.finance, undefined, `${kind} legacy no-account audit rejected`);
  await documentAction(kind, billNo, "delete", 409, cookies.finance, undefined, `${kind} legacy physical delete rejected`);

  const accountId = ids.public.bankCny;
  const base = settlementPayload({
    partyId,
    funds: [{ accountId, method: "BANK_TRANSFER", amount: 20 }],
    allocations: [{ sourceId, amount: 20 }],
    remark: `${fixturePrefix}-legacy-updated-${kind}`
  });
  const immutableCases = [
    ["party", { ...base, partyId: kind === "receipt" ? ids.public.customerB : ids.public.supplierB }],
    ["currency", { ...base, currency: "USD", fundLines: base.fundLines.map((row) => ({ ...row, accountId: ids.public.bankUsd })) }],
    ["amount", { ...base, amount: 19, fundLines: base.fundLines.map((row) => ({ ...row, amount: 19 })), allocations: base.allocations.map((row) => ({ ...row, settlementAmount: 19 })) }]
  ];
  for (const [field, body] of immutableCases) {
    await documentAction(kind, billNo, "update", 409, cookies.finance, { ...body, version: reversed.data.version }, `${kind} legacy immutable ${field}`);
  }
  const unchanged = await documentAction(kind, billNo, "detail", 200, cookies.finance, undefined, `${kind} legacy unchanged after invalid updates`);
  assert(unchanged.data.version === reversed.data.version && unchanged.data.fundLines.length === 0, `${kind} legacy 非法修改必须零副作用`, unchanged.data);
  const updated = await documentAction(kind, billNo, "update", 200, cookies.finance, { ...base, version: reversed.data.version }, `${kind} legacy add real account`);
  assert(updated.data.legacy === true && updated.data.fundLines.length === 1 && updated.data.allocations.length === 1, `${kind} legacy 只能补真实同币种账户`, updated.data);
  const audited = await documentAction(kind, billNo, "audit", 200, cookies.finance, undefined, `${kind} legacy re-audit`);
  assert(audited.data.status === "AUDITED" && Number(sourceState("public", kind, sourceBillNo).settledAmount) === 20, `${kind} legacy 补账户后必须可重新审核`, audited.data);
  await documentAction(kind, billNo, "reverse", 200, cookies.finance, undefined, `${kind} legacy final reverse`);
  await documentAction(kind, billNo, "delete", 409, cookies.finance, undefined, `${kind} legacy draft still non-deletable`);
  return { billNo, versions: [initial.data.version, reversed.data.version, updated.data.version, audited.data.version] };
}

async function verifyLegacy() {
  const receipt = await exerciseLegacy("receipt", codes.legacyReceipt, ids.public.customerA, ids.public.arLegacy, codes.arLegacy);
  const payment = await exerciseLegacy("payment", codes.legacyPayment, ids.public.supplierA, ids.public.apLegacy, codes.apLegacy);
  evidence.legacy = { receipt, payment };
  evidence.coverage.legacy = true;
}

async function verifyListsAndSelectors(mainBills) {
  const filters = (partyId, currency) => ({
    partyId: { operator: "等于", value: partyId },
    currency: { operator: "等于", value: currency }
  });
  const receiptList = await list(cookies.finance, "ar-receipt-form-list", { keyword: mainBills.receiptBill });
  const paymentList = await list(cookies.report, "ap-payment-form-list", { keyword: mainBills.paymentBill });
  expectStatus("formal receipt list row", receiptList, 200);
  expectStatus("report formal payment list row", paymentList, 200);
  assert(receiptList.data.rows.some((row) => row.billNo === mainBills.receiptBill && row.sourceCount === 2 && row.accountCount === 2), "收款单列表必须显示正式单据与来源/账户计数", receiptList.data.rows);
  assert(paymentList.data.rows.some((row) => row.billNo === mainBills.paymentBill && row.sourceCount === 2 && row.accountCount === 2), "付款单列表必须允许 report-only 只读", paymentList.data.rows);

  const arCny = await list(cookies.finance, "ar-receivable-settlement-source-selector", { keyword: fixturePrefix, columnFilters: filters(ids.public.customerA, "CNY") });
  const apCny = await list(cookies.finance, "ap-payable-settlement-source-selector", { keyword: fixturePrefix, columnFilters: filters(ids.public.supplierA, "CNY") });
  const arUsd = await list(cookies.finance, "ar-receivable-settlement-source-selector", { keyword: fixturePrefix, columnFilters: filters(ids.public.customerA, "USD") });
  for (const [label, response] of [["AR CNY selector", arCny], ["AP CNY selector", apCny], ["AR USD selector", arUsd]]) expectStatus(label, response, 200);
  assert(arCny.data.rows.every((row) => row.partyId === ids.public.customerA && row.currency === "CNY" && Number(row.unsettledAmount) > 0), "应收 selector 必须只返回当前往来单位/CNY/正余量", arCny.data.rows);
  assert(apCny.data.rows.every((row) => row.partyId === ids.public.supplierA && row.currency === "CNY" && Number(row.unsettledAmount) > 0), "应付 selector 必须只返回当前往来单位/CNY/正余量", apCny.data.rows);
  assert(arUsd.data.rows.some((row) => row.billNo === codes.arUsd) && arUsd.data.rows.every((row) => row.currency === "USD"), "应收 selector 必须支持 USD 且不混入 CNY", arUsd.data.rows);
  assert(!arCny.data.rows.some((row) => [codes.arWrong, codes.arDone, codes.arUsd].includes(row.billNo)), "应收 selector 必须排除异往来、已结清和异币种来源", arCny.data.rows);

  const cnyAccounts = await list(cookies.finance, "financial-account-settlement-selector", {
    keyword: fixturePrefix,
    columnFilters: { currency: { operator: "等于", value: "CNY" } }
  });
  const usdAccounts = await list(cookies.finance, "financial-account-settlement-selector", {
    keyword: fixturePrefix,
    columnFilters: { currency: { operator: "等于", value: "USD" } }
  });
  expectStatus("CNY account selector", cnyAccounts, 200);
  expectStatus("USD account selector", usdAccounts, 200);
  assert([...cnyAccounts.data.rows, ...usdAccounts.data.rows].every((row) => !("accountNo" in row) && !("accountHolder" in row)), "结算专用账户 selector 不得泄露账号或户名", { cny: cnyAccounts.data.rows, usd: usdAccounts.data.rows });
  const cnyCodes = cnyAccounts.data.rows.map((row) => row.code);
  assert(cnyCodes.includes(codes.cashCny) && cnyCodes.includes(codes.bankCny), "账户 selector 必须包含已审核启用 CNY 账户", cnyCodes);
  assert(!cnyCodes.includes(codes.draftCny) && !cnyCodes.includes(codes.disabledCny) && !cnyCodes.includes(codes.bankUsd), "账户 selector 必须排除未审核、禁用和异币种账户", cnyCodes);
  assert(usdAccounts.data.rows.some((row) => row.code === codes.bankUsd) && usdAccounts.data.rows.every((row) => row.currency === "USD"), "账户 selector 必须精确支持 USD", usdAccounts.data.rows);
  evidence.selectors = {
    receiptCny: arCny.data.rows.length,
    paymentCny: apCny.data.rows.length,
    receiptUsd: arUsd.data.rows.length,
    cnyAccounts: cnyCodes,
    usdAccounts: usdAccounts.data.rows.map((row) => row.code)
  };
  evidence.coverage.listsAndSelectors = true;
}

async function verifyTenantIsolation() {
  const publicCollisionBefore = await documentAction(
    "receipt",
    codes.legacyReceipt,
    "detail",
    200,
    cookies.finance,
    undefined,
    "public exact same-number legacy detail"
  );
  const replayCollisionBefore = await documentAction(
    "receipt",
    codes.legacyReceipt,
    "detail",
    200,
    cookies.replayFinance,
    undefined,
    "replay exact same-number legacy detail"
  );
  const publicCollisionSourceBefore = sourceState("public", "receipt", codes.arLegacy);
  const replayCollisionSourceBefore = sourceState(replayTenant.schemaName, "receipt", codes.arLegacy);
  assert(
    publicCollisionBefore.data.billNo === codes.legacyReceipt
      && replayCollisionBefore.data.billNo === codes.legacyReceipt
      && publicCollisionBefore.data.partyName.includes("PUBLIC")
      && replayCollisionBefore.data.partyName.includes("TENANT")
      && publicCollisionBefore.data.status === "DRAFT"
      && replayCollisionBefore.data.status === "AUDITED",
    "两个 tenant 必须能以完全相同收款单号命中各自快照和状态",
    { public: publicCollisionBefore.data, replay: replayCollisionBefore.data }
  );
  await documentAction(
    "receipt",
    codes.legacyReceipt,
    "reverse",
    200,
    cookies.replayFinance,
    undefined,
    "replay exact same-number legacy reverse"
  );
  const publicCollisionAfter = await documentAction(
    "receipt",
    codes.legacyReceipt,
    "detail",
    200,
    cookies.finance,
    undefined,
    "public exact same-number legacy unchanged"
  );
  const replayCollisionAfter = await documentAction(
    "receipt",
    codes.legacyReceipt,
    "detail",
    200,
    cookies.replayFinance,
    undefined,
    "replay exact same-number legacy reversed"
  );
  const publicCollisionSourceAfter = sourceState("public", "receipt", codes.arLegacy);
  const replayCollisionSourceAfter = sourceState(replayTenant.schemaName, "receipt", codes.arLegacy);
  const collisionLogs = (schema) => dbJson(`
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
      'action', action_code,
      'targetNo', target_no,
      'actor', actor_username,
      'accountSetCode', account_set_code,
      'success', success
    ) ORDER BY operated_at, id), '[]'::jsonb)::text
    FROM ${schemaTable(schema, "sys_operation_log")}
    WHERE action_code='REVERSE_RECEIPT' AND target_no=${sqlLiteral(codes.legacyReceipt)}
  `) ?? [];
  const publicCollisionLogs = collisionLogs("public");
  const replayCollisionLogs = collisionLogs(replayTenant.schemaName);
  assert(
    publicCollisionAfter.data.status === "DRAFT"
      && replayCollisionAfter.data.status === "DRAFT"
      && publicCollisionSourceBefore.settledAmount === publicCollisionSourceAfter.settledAmount
      && replayCollisionSourceBefore.settledAmount === "20.00"
      && replayCollisionSourceAfter.settledAmount === "0.00",
    "同号单据在 replay 反审核时不得改变 public 单据或来源",
    {
      publicBefore: publicCollisionSourceBefore,
      publicAfter: publicCollisionSourceAfter,
      replayBefore: replayCollisionSourceBefore,
      replayAfter: replayCollisionSourceAfter
    }
  );
  assert(
    publicCollisionLogs.length > 0
      && publicCollisionLogs.every((row) => row.actor === users.finance.username && row.accountSetCode === "BLD-TEST" && row.success)
      && replayCollisionLogs.length === 1
      && replayCollisionLogs[0].actor === users.replayFinance.username
      && replayCollisionLogs[0].accountSetCode === replayTenant.code
      && replayCollisionLogs[0].success,
    "同号收款单的反审核日志必须分别落入各 tenant 且记录真实 actor/account set",
    { public: publicCollisionLogs, replay: replayCollisionLogs }
  );

  const createFor = async (scope, cookie, fixtureIdsValue) => {
    const payload = settlementPayload({
      partyId: fixtureIdsValue.customerA,
      funds: [{ accountId: fixtureIdsValue.bankCny, method: "BANK_TRANSFER", amount: 30 }],
      allocations: [{ sourceId: fixtureIdsValue.ar1, amount: 30 }],
      remark: `${fixturePrefix}-tenant-isolation`
    });
    const created = await createDraft("receipt", payload, 201, cookie, `${scope} tenant isolation draft`);
    await documentAction("receipt", created.data.billNo, "audit", 200, cookie, undefined, `${scope} tenant isolation audit`);
    return created.data.billNo;
  };
  const publicBill = await createFor("public", cookies.finance, ids.public);
  const replayBill = await createFor("replay", cookies.replayFinance, ids.replay);
  const publicDetail = await documentAction("receipt", publicBill, "detail", 200, cookies.finance, undefined, "public own detail");
  const replayDetail = await documentAction("receipt", replayBill, "detail", 200, cookies.replayFinance, undefined, "replay own detail");
  assert(publicDetail.data.partyName.includes("PUBLIC") && replayDetail.data.partyName.includes("TENANT"), "同码双账套详情必须返回各自往来单位快照", { public: publicDetail.data, replay: replayDetail.data });
  assert(Number(sourceState("public", "receipt", codes.ar1).settledAmount) === 30 && Number(sourceState(replayTenant.schemaName, "receipt", codes.ar1).settledAmount) === 30, "双账套必须各自只核销 30", { publicBill, replayBill });
  const publicSelector = await list(cookies.finance, "ar-receivable-settlement-source-selector", { keyword: codes.ar1 });
  const replaySelector = await list(cookies.replayFinance, "ar-receivable-settlement-source-selector", { keyword: codes.ar1 });
  expectStatus("public tenant source selector", publicSelector, 200);
  expectStatus("replay tenant source selector", replaySelector, 200);
  assert(publicSelector.data.rows.length === 1 && replaySelector.data.rows.length === 1, "同码来源 selector 每个账套只能返回一行", { public: publicSelector.data.rows, replay: replaySelector.data.rows });
  assert(publicSelector.data.rows[0].partyName.includes("PUBLIC") && replaySelector.data.rows[0].partyName.includes("TENANT"), "selector 不得跨账套串行", { public: publicSelector.data.rows[0], replay: replaySelector.data.rows[0] });
  await documentAction("receipt", publicBill, "reverse", 200, cookies.finance, undefined, "public tenant isolation reverse");
  await documentAction("receipt", replayBill, "reverse", 200, cookies.replayFinance, undefined, "replay tenant isolation reverse");
  await documentAction("receipt", publicBill, "delete", 200, cookies.finance, undefined, "public tenant isolation delete");
  await documentAction("receipt", replayBill, "delete", 200, cookies.replayFinance, undefined, "replay tenant isolation delete");
  assert(Number(sourceState("public", "receipt", codes.ar1).settledAmount) === 0 && Number(sourceState(replayTenant.schemaName, "receipt", codes.ar1).settledAmount) === 0, "双账套反审核必须独立恢复来源");
  evidence.tenantIsolation = {
    exactSameBillNoCollision: {
      billNo: codes.legacyReceipt,
      publicBefore: { status: publicCollisionBefore.data.status, partyName: publicCollisionBefore.data.partyName, settledAmount: publicCollisionSourceBefore.settledAmount },
      replayBefore: { status: replayCollisionBefore.data.status, partyName: replayCollisionBefore.data.partyName, settledAmount: replayCollisionSourceBefore.settledAmount },
      publicAfter: { status: publicCollisionAfter.data.status, settledAmount: publicCollisionSourceAfter.settledAmount },
      replayAfter: { status: replayCollisionAfter.data.status, settledAmount: replayCollisionSourceAfter.settledAmount },
      logs: { public: publicCollisionLogs, replay: replayCollisionLogs }
    },
    independentlyGeneratedBills: { publicBill, replayBill },
    tenant: replayTenant.code
  };
  evidence.coverage.tenantIsolation = true;
}

function payableFromPurchaseIn(billNo) {
  return dbJson(`
    SELECT row_to_json(row_value)::text FROM (
      SELECT id::text AS id, bill_no AS "billNo", source_bill_no AS "sourceBillNo", currency,
             amount::text AS amount, paid_amount::text AS "paidAmount", status
      FROM public.ap_payable WHERE source_bill_no=${sqlLiteral(billNo)} AND amount > 0
      ORDER BY created_at DESC LIMIT 1
    ) row_value
  `);
}

async function settleChainPayable(payable, currency, label) {
  assert(payable?.id && payable.currency === currency, `${label} 必须生成同币种应付`, payable);
  const amount = payable.amount;
  const payload = {
    partyId: ids.public.supplierA,
    billDate,
    currency,
    amount,
    remark: `${fixturePrefix}-chain-payment-${label}`,
    fundLines: [{
      lineNo: 1,
      accountId: currency === "USD" ? ids.public.bankUsd : ids.public.bankCny,
      paymentMethod: "BANK_TRANSFER",
      amount,
      fee: "0.00",
      transactionNo: `${fixturePrefix}-SECRET-CHAIN-${label}`,
      remark: `${fixturePrefix}-chain-fund`
    }],
    allocations: [{ lineNo: 1, sourceId: payable.id, settlementAmount: amount, remark: `${fixturePrefix}-chain-allocation` }]
  };
  const draft = await createDraft("payment", payload, 201, cookies.finance, `${label} formal payment draft`);
  await documentAction("payment", draft.data.billNo, "audit", 200, cookies.finance, undefined, `${label} formal payment audit`);
  assert(Number(payableFromPurchaseIn(payable.sourceBillNo)?.paidAmount) === Number(amount), `${label} 正式付款必须精确核销真实链应付`);
  await documentAction("payment", draft.data.billNo, "reverse", 200, cookies.finance, undefined, `${label} formal payment reverse`);
  await documentAction("payment", draft.data.billNo, "delete", 200, cookies.finance, undefined, `${label} formal payment delete`);
  return draft.data.billNo;
}

async function verifyPurchaseCurrencyAndReturnGuards() {
  const productCode = "CP-001";
  const warehouseCode = "CK-001";
  const createOrder = async (currency, suffix) => {
    const draft = await requireApi(cookies.admin, `${suffix} purchase order draft`, "/api/purchase-orders/draft", {
      expected: 201,
      body: {
        supplierCode: codes.supplierA,
        billDate,
        department: "A141采购部",
        ownerName: "A141管理员",
        currency,
        lines: [{ productCode, warehouseCode, qty: 5, unitPrice: 10, taxRate: 13, lineRemark: `${fixturePrefix}-${suffix}` }]
      }
    });
    const billNo = requireGeneratedBill(draft, "CGDD", `${suffix} purchase order`);
    chainArtifacts.purchaseOrders.push(billNo);
    await requireApi(cookies.admin, `${suffix} purchase order audit`, `/api/purchase-orders/${encodeURIComponent(billNo)}/audit`);
    const detail = await requireApi(cookies.admin, `${suffix} purchase order detail`, `/api/purchase-orders/${encodeURIComponent(billNo)}`, { method: "GET" });
    assert(detail.data.document.currency === currency, `${suffix} 采购订单必须显式保存 ${currency}`, detail.data.document);
    return billNo;
  };
  const createIn = async ({ currency, suffix, orderNo = "", audit = true }) => {
    const line = { productCode, warehouseCode, qty: 2, unitPrice: 10, taxRate: 13, lineRemark: `${fixturePrefix}-${suffix}` };
    if (orderNo) Object.assign(line, { sourceOrderNo: orderNo, sourceLineNo: 1 });
    const draft = await requireApi(cookies.admin, `${suffix} purchase in draft`, "/api/purchase-ins/draft", {
      expected: 201,
      body: {
        sourceOrderNo: orderNo,
        supplierCode: codes.supplierA,
        billDate,
        department: "A141采购部",
        ownerName: "A141管理员",
        currency,
        lines: [line]
      }
    });
    const billNo = requireGeneratedBill(draft, "CGRK", `${suffix} purchase in`);
    chainArtifacts.purchaseIns.push(billNo);
    if (audit) {
      await requireApi(cookies.admin, `${suffix} purchase in audit`, `/api/purchase-ins/${encodeURIComponent(billNo)}/audit`);
      if (faultInjection === "after-first-purchase-in-audit" && suffix === "CNY") {
        throw new Error("A141 intentional fault injection: after-first-purchase-in-audit");
      }
    }
    const detail = await requireApi(cookies.admin, `${suffix} purchase in detail`, `/api/purchase-ins/${encodeURIComponent(billNo)}`, { method: "GET" });
    assert(detail.data.document.currency === currency, `${suffix} 采购入库必须显式保存/继承 ${currency}`, detail.data.document);
    return billNo;
  };

  const cnyOrder = await createOrder("CNY", "CNY");
  const usdOrder = await createOrder("USD", "USD");
  const cnyIn = await createIn({ currency: "CNY", suffix: "CNY", orderNo: cnyOrder });
  const usdIn = await createIn({ currency: "USD", suffix: "USD", orderNo: usdOrder });
  const usdDirectIn = await createIn({ currency: "USD", suffix: "USD-DIRECT" });
  const draftIn = await createIn({ currency: "CNY", suffix: "DRAFT-SOURCE", audit: false });
  const cnyPayable = payableFromPurchaseIn(cnyIn);
  const usdPayable = payableFromPurchaseIn(usdIn);
  const directUsdPayable = payableFromPurchaseIn(usdDirectIn);
  assert(cnyPayable.currency === "CNY" && usdPayable.currency === "USD" && directUsdPayable.currency === "USD", "PO→PI→AP 与无来源 PI→AP 必须保持显式原币", { cnyPayable, usdPayable, directUsdPayable });
  const chainPayments = [
    await settleChainPayable(cnyPayable, "CNY", "CNY-chain"),
    await settleChainPayable(usdPayable, "USD", "USD-chain")
  ];

  const returnLine = (sourceOrderNo, qty = 1) => ({
    productCode, warehouseCode, sourceOrderNo, sourceLineNo: 1, qty, unitPrice: 10, taxRate: 13, lineRemark: `${fixturePrefix}-return`
  });
  const returnBody = (supplierCode, lines, suffix) => ({
    supplierCode,
    billDate,
    department: "A141采购部",
    ownerName: "A141管理员",
    remark: `${fixturePrefix}-return-${suffix}`,
    lines
  });
  const invalidReturns = [
    ["missing source", returnBody(codes.supplierA, [{ ...returnLine(""), sourceLineNo: null }], "missing"), 409],
    ["draft source", returnBody(codes.supplierA, [returnLine(draftIn)], "draft"), 409],
    ["wrong supplier", returnBody(codes.supplierB, [returnLine(cnyIn)], "supplier"), 409],
    ["mixed currency", returnBody(codes.supplierA, [returnLine(cnyIn), returnLine(usdIn)], "currency"), 409]
  ];
  for (const [label, body, expected] of invalidReturns) {
    await requireApi(cookies.admin, `purchase return ${label} rejected`, "/api/purchase-returns/draft", { expected, body });
  }
  const validReturn = await requireApi(cookies.admin, "valid sourced purchase return draft", "/api/purchase-returns/draft", {
    expected: 201,
    body: returnBody(codes.supplierA, [returnLine(cnyIn)], "valid")
  });
  const returnNo = requireGeneratedBill(validReturn, "CGTH", "valid purchase return");
  chainArtifacts.purchaseReturns.push(returnNo);
  const blockedReverse = await requireApi(cookies.admin, "source purchase in reverse blocked by non-VOID return", `/api/purchase-ins/${encodeURIComponent(cnyIn)}/reverse`, { expected: 409 });
  assert(blockedReverse.text.includes("采购退货下游"), "非 VOID 采购退货存在时来源采购入库反审核必须说明下游阻断", blockedReverse.text);
  await requireApi(cookies.admin, "delete blocking purchase return", `/api/purchase-returns/${encodeURIComponent(returnNo)}`, { method: "DELETE" });

  for (const billNo of [cnyIn, usdIn, usdDirectIn]) {
    await requireApi(cookies.admin, `reverse purchase in ${billNo}`, `/api/purchase-ins/${encodeURIComponent(billNo)}/reverse`);
    await requireApi(cookies.admin, `delete purchase in ${billNo}`, `/api/purchase-ins/${encodeURIComponent(billNo)}`, { method: "DELETE" });
  }
  await requireApi(cookies.admin, "delete draft source purchase in", `/api/purchase-ins/${encodeURIComponent(draftIn)}`, { method: "DELETE" });
  evidence.lifecycle.purchaseCurrencyChain = { cnyOrder, usdOrder, cnyIn, usdIn, usdDirectIn, payments: chainPayments };
  evidence.lifecycle.purchaseReturnGuards = { invalid: invalidReturns.map(([label, , status]) => ({ label, status })), returnNo, sourceReverseStatus: 409 };
  evidence.coverage.purchaseCurrencyChain = true;
  evidence.coverage.purchaseReturnGuards = true;
}

function receivableFromSalesOut(billNo) {
  return dbJson(`
    SELECT row_to_json(row_value)::text FROM (
      SELECT id::text AS id, bill_no AS "billNo", source_bill_no AS "sourceBillNo", currency,
             amount::text AS amount, received_amount::text AS "receivedAmount", status
      FROM public.ar_receivable WHERE source_bill_no=${sqlLiteral(billNo)} AND amount > 0
      ORDER BY created_at DESC LIMIT 1
    ) row_value
  `);
}

async function settleChainReceivable(receivable, currency, label) {
  assert(receivable?.id && receivable.currency === currency, `${label} 必须生成同币种应收`, receivable);
  const amount = receivable.amount;
  const payload = {
    partyId: ids.public.customerA,
    billDate,
    currency,
    amount,
    remark: `${fixturePrefix}-chain-receipt-${label}`,
    fundLines: [{
      lineNo: 1,
      accountId: currency === "USD" ? ids.public.bankUsd : ids.public.bankCny,
      paymentMethod: "BANK_TRANSFER",
      amount,
      fee: "0.00",
      transactionNo: `${fixturePrefix}-SECRET-CHAIN-${label}`,
      remark: `${fixturePrefix}-chain-fund`
    }],
    allocations: [{ lineNo: 1, sourceId: receivable.id, settlementAmount: amount, remark: `${fixturePrefix}-chain-allocation` }]
  };
  const draft = await createDraft("receipt", payload, 201, cookies.finance, `${label} formal receipt draft`);
  await documentAction("receipt", draft.data.billNo, "audit", 200, cookies.finance, undefined, `${label} formal receipt audit`);
  assert(Number(receivableFromSalesOut(receivable.sourceBillNo)?.receivedAmount) === Number(amount), `${label} 正式收款必须精确核销真实链应收`);
  await documentAction("receipt", draft.data.billNo, "reverse", 200, cookies.finance, undefined, `${label} formal receipt reverse`);
  await documentAction("receipt", draft.data.billNo, "delete", 200, cookies.finance, undefined, `${label} formal receipt delete`);
  return draft.data.billNo;
}

function normalizedStockBalanceSql(alias) {
  return `(to_jsonb(${alias}) || jsonb_build_object(
    'qty_on_hand', ${alias}.qty_on_hand::text,
    'qty_available', ${alias}.qty_available::text,
    'qty_reserved', ${alias}.qty_reserved::text,
    'unit_cost', ${alias}.unit_cost::text,
    'amount', ${alias}.amount::text,
    'version', ${alias}.version::text
  ))`;
}

function stockCleanupSnapshot(productCode = "CP-001", warehouseCode = "CK-001") {
  return dbJson(`
    SELECT jsonb_build_object(
      'balance', ${normalizedStockBalanceSql("b")},
      'state', jsonb_build_object(
        'onHand', b.qty_on_hand::text,
        'available', b.qty_available::text,
        'reserved', b.qty_reserved::text
      ),
      'version', b.version::text
    )::text
    FROM public.inv_stock_balance b
    JOIN public.md_product p ON p.id=b.product_id
    JOIN public.md_warehouse w ON w.id=b.warehouse_id
    JOIN public.sys_account_set a ON a.id=b.account_set_id
    WHERE p.code=${sqlLiteral(productCode)} AND w.code=${sqlLiteral(warehouseCode)} AND a.code='BLD-TEST'
  `);
}

function stockState(productCode = "CP-001", warehouseCode = "CK-001") {
  return stockCleanupSnapshot(productCode, warehouseCode)?.state ?? null;
}

function captureChainStockBaseline() {
  const snapshot = stockCleanupSnapshot();
  const state = snapshot?.state ?? null;
  const version = snapshot?.version ?? "";
  assert(state && /^\d+$/.test(version), "A141 必须在真实链开始前取得受保护的库存基线", { state, version });
  chainStockBaseline = snapshot;
  directCleanupAuthorized = false;
  evidence.cleanup.recovery.stock = {
    baseline: state,
    baselineVersion: version,
    afterApiRecovery: null,
    final: null,
    exactRestore: null
  };
}

async function verifySalesCurrencyChains() {
  const baseline = chainStockBaseline?.state ?? stockState();
  assert(baseline && Number(baseline.available) >= 2, "A141 销售真实链需要 CP-001/CK-001 至少 2 个可用库存", baseline);
  const flows = [];
  for (const currency of ["CNY", "USD"]) {
    const line = { productCode: "CP-001", warehouseCode: "CK-001", qty: 1, unitPrice: 10, taxRate: 13, lineRemark: `${fixturePrefix}-${currency}` };
    const orderDraft = await requireApi(cookies.admin, `${currency} sales order draft`, "/api/sales-orders/draft", {
      expected: 201,
      body: {
        customerCode: codes.customerA,
        billDate,
        department: "A141销售部",
        ownerName: "A141管理员",
        remark: `${fixturePrefix}-sales-order-${currency}`,
        currency,
        lines: [line]
      }
    });
    const orderNo = requireGeneratedBill(orderDraft, "XSDD", `${currency} sales order`);
    chainArtifacts.salesOrders.push(orderNo);
    await requireApi(cookies.admin, `${currency} sales order audit`, `/api/sales-orders/${encodeURIComponent(orderNo)}/audit`);

    const noticeDraft = await requireApi(cookies.admin, `${currency} delivery notice draft`, "/api/delivery-notices/draft", {
      expected: 201,
      body: {
        sourceOrderNo: orderNo,
        customerCode: codes.customerA,
        billDate,
        department: "A141销售部",
        ownerName: "A141管理员",
        remark: `${fixturePrefix}-delivery-${currency}`,
        currency,
        lines: [{ ...line, sourceOrderNo: orderNo, sourceLineNo: 1 }]
      }
    });
    const noticeNo = requireGeneratedBill(noticeDraft, "FHTZD", `${currency} delivery notice`);
    chainArtifacts.deliveryNotices.push(noticeNo);
    await requireApi(cookies.admin, `${currency} delivery notice audit`, `/api/delivery-notices/${encodeURIComponent(noticeNo)}/audit`);

    const outDraft = await requireApi(cookies.admin, `${currency} sales out draft`, "/api/sales-outs/draft", {
      expected: 201,
      body: {
        sourceOrderNo: noticeNo,
        customerCode: codes.customerA,
        billDate,
        department: "A141销售部",
        ownerName: "A141管理员",
        remark: `${fixturePrefix}-sales-out-${currency}`,
        currency,
        lines: [{ ...line, sourceOrderNo: noticeNo, sourceLineNo: 1, sourceDeliveryNoticeNo: noticeNo, sourceDeliveryLineNo: 1 }]
      }
    });
    const outNo = requireGeneratedBill(outDraft, "XSCKD", `${currency} sales out`);
    chainArtifacts.salesOuts.push(outNo);
    await requireApi(cookies.admin, `${currency} sales out audit`, `/api/sales-outs/${encodeURIComponent(outNo)}/audit`);
    if (faultInjection === "after-first-sales-out-audit" && currency === "CNY") {
      throw new Error("A141 intentional fault injection: after-first-sales-out-audit");
    }

    const [orderDetail, noticeDetail, outDetail] = await Promise.all([
      requireApi(cookies.admin, `${currency} sales order detail`, `/api/sales-orders/${encodeURIComponent(orderNo)}`, { method: "GET" }),
      requireApi(cookies.admin, `${currency} delivery notice detail`, `/api/delivery-notices/${encodeURIComponent(noticeNo)}`, { method: "GET" }),
      requireApi(cookies.admin, `${currency} sales out detail`, `/api/sales-outs/${encodeURIComponent(outNo)}`, { method: "GET" })
    ]);
    const orderHeader = orderDetail.data.order ?? orderDetail.data.document;
    const noticeHeader = noticeDetail.data.document ?? noticeDetail.data.order;
    const outHeader = outDetail.data.document ?? outDetail.data.order;
    assert([orderHeader, noticeHeader, outHeader].every((header) => header?.currency === currency), `${currency} 必须从销售订单→发货通知→销售出库逐级原币一致`, {
      order: orderHeader?.currency,
      notice: noticeHeader?.currency,
      out: outHeader?.currency
    });
    const receivable = receivableFromSalesOut(outNo);
    assert(receivable?.currency === currency, `${currency} 销售出库必须生成同币种应收`, receivable);
    const receiptBill = await settleChainReceivable(receivable, currency, `${currency}-chain`);

    await requireApi(cookies.admin, `${currency} sales out reverse`, `/api/sales-outs/${encodeURIComponent(outNo)}/reverse`);
    await requireApi(cookies.admin, `${currency} sales out delete`, `/api/sales-outs/${encodeURIComponent(outNo)}`, { method: "DELETE" });
    await requireApi(cookies.admin, `${currency} delivery reverse`, `/api/delivery-notices/${encodeURIComponent(noticeNo)}/reverse`);
    await requireApi(cookies.admin, `${currency} delivery delete`, `/api/delivery-notices/${encodeURIComponent(noticeNo)}`, { method: "DELETE" });
    await requireApi(cookies.admin, `${currency} sales order reverse`, `/api/sales-orders/${encodeURIComponent(orderNo)}/reverse`);
    await requireApi(cookies.admin, `${currency} sales order delete`, `/api/sales-orders/${encodeURIComponent(orderNo)}`, { method: "DELETE" });
    flows.push({ currency, orderNo, noticeNo, outNo, receivable: receivable.billNo, receiptBill });
  }
  const finalStock = stockState();
  assert(same(finalStock, baseline), "CNY/USD 销售真实链反审核/删除后库存三量必须恢复", { baseline, finalStock });
  evidence.lifecycle.salesCurrencyChains = flows;
  evidence.coverage.salesCurrencyChains = true;
}

async function captureFormalDocuments(mainBills) {
  await documentAction("receipt", mainBills.receiptBill, "audit", 200, cookies.finance, undefined, "browser receipt re-audit");
  await documentAction("payment", mainBills.paymentBill, "audit", 200, cookies.finance, undefined, "browser payment re-audit");
  browser = await chromium.launch({ headless: true });
  const financeContext = await browser.newContext({ viewport: { width: 1366, height: 768 } });
  const page = await financeContext.newPage();
  await page.goto(frontendUrl, { waitUntil: "networkidle" });
  await loginAs(page, users.finance.username, users.finance.password, "财务员", "BLD-TEST");

  const capture = async (kind, billNo, viewport) => {
    const entryId = kind === "receipt" ? "ar-receipt-form" : "ap-payment-form";
    const listKey = kind === "receipt" ? "ar-receipt-form-list" : "ap-payment-form-list";
    const prefix = kind === "receipt" ? "receipt" : "payment";
    await page.setViewportSize(viewport);
    await page.getByTestId("module-应收应付").hover();
    await page.getByTestId(`query-${entryId}`).click();
    await page.getByTestId(`list-page-${listKey}`).waitFor({ state: "visible", timeout: 10000 });
    await page.getByTestId("list-keyword").fill(billNo);
    await page.getByTestId("list-keyword").press("Enter");
    await page.getByTestId(`open-document-${billNo}`).waitFor({ state: "visible", timeout: 10000 });
    await page.getByTestId(`open-document-${billNo}`).click();
    await page.getByTestId(`${prefix}-form`).waitFor({ state: "visible", timeout: 10000 });
    await page.waitForFunction((testPrefix) => {
      const input = document.querySelector(`[data-testid="${testPrefix}-status-version"]`);
      return input instanceof HTMLInputElement && input.value.includes("已审核");
    }, prefix, { timeout: 10000 });
    assert(await page.getByTestId(`${prefix}-currency`).inputValue() === "CNY", `${kind} 浏览器详情必须显示 CNY`);
    assert((await page.getByTestId(`${prefix}-status-version`).inputValue()).includes("已审核"), `${kind} 浏览器详情必须显示已审核状态`);
    assert(await page.getByTestId(`${prefix}-fund-table`).isVisible() && await page.getByTestId(`${prefix}-allocation-table`).isVisible(), `${kind} 浏览器详情必须包含资金表和核销表`);
    assert(await page.getByTestId(`${prefix}-open-account-selector`).isDisabled(), `${kind} 已审核态账户选择必须禁用`);
    const titledFields = [
      `${prefix}-remark`,
      `${prefix}-fund-transaction-1`,
      `${prefix}-fund-remark-1`,
      `${prefix}-allocation-remark-1`
    ];
    for (const testId of titledFields) {
      const field = page.getByTestId(testId);
      const value = await field.inputValue();
      assert(value.length > 0, `${kind} ${testId} 必须有可识别原文`);
      assert(await field.getAttribute("title") === value, `${kind} ${testId} title 必须完整等于 inputValue`);
    }
    const outerOverflow = await page.evaluate(() => ({
      clientWidth: document.documentElement.clientWidth,
      scrollWidth: document.documentElement.scrollWidth,
      bodyWidth: document.body.scrollWidth
    }));
    assert(outerOverflow.scrollWidth <= outerOverflow.clientWidth + 1 && outerOverflow.bodyWidth <= outerOverflow.clientWidth + 1, `${kind} ${viewport.width}x${viewport.height} 不得页面级横向溢出`, outerOverflow);
    const fileName = `a141-${kind}-${viewport.width}x${viewport.height}-${runId}.png`;
    await page.screenshot({ path: path.join(screenshotDir, fileName), fullPage: true });
    evidence.screenshots.push(`verification/playwright/${fileName}`);
    return { kind, billNo, viewport, titledFields, outerOverflow, screenshot: `verification/playwright/${fileName}` };
  };
  const receipt = await capture("receipt", mainBills.receiptBill, { width: 1366, height: 768 });
  const payment = await capture("payment", mainBills.paymentBill, { width: 1920, height: 1080 });
  evidence.browser = [receipt, payment];

  for (const fixture of [
    { role: "admin", user: users.admin, roleLabel: "系统管理员", canSee: true, canMaintain: true },
    { role: "report", user: users.report, roleLabel: "", canSee: true, canMaintain: false },
    { role: "warehouse", user: users.warehouse, roleLabel: "仓库员", canSee: false, canMaintain: false }
  ]) {
    const context = await browser.newContext({ viewport: { width: 1366, height: 768 } });
    const rolePage = await context.newPage();
    await rolePage.goto(frontendUrl, { waitUntil: "networkidle" });
    await loginAs(rolePage, fixture.user.username, fixture.user.password, fixture.roleLabel, "BLD-TEST");
    const module = rolePage.getByTestId("module-应收应付");
    assert(await module.isVisible(), `${fixture.role} 必须看见统一模块导航壳层`);
    await module.hover();
    if (!fixture.canSee) {
      assert(await rolePage.getByTestId("query-ar-receipt-form").count() === 0, `${fixture.role} 菜单不得显示收款查询入口`);
      assert(await rolePage.getByTestId("query-ap-payment-form").count() === 0, `${fixture.role} 菜单不得显示付款查询入口`);
      evidence.permissionBrowser.push({ role: fixture.role, moduleVisible: true, settlementEntriesVisible: false, maintenanceVisible: false });
      await context.close();
      continue;
    }
    assert(await rolePage.getByTestId("query-ar-receipt-form").isVisible() && await rolePage.getByTestId("query-ap-payment-form").isVisible(), `${fixture.role} 必须看见收付款查询入口`);
    await rolePage.getByTestId("query-ar-receipt-form").click();
    await rolePage.getByTestId("list-page-ar-receipt-form-list").waitFor({ state: "visible" });
    await rolePage.getByTestId("list-keyword").fill(mainBills.receiptBill);
    await rolePage.getByTestId("list-keyword").press("Enter");
    await rolePage.getByTestId(`open-document-${mainBills.receiptBill}`).click();
    await rolePage.getByTestId("receipt-form").waitFor({ state: "visible" });
    const maintenanceVisible = await rolePage.getByTestId("new-document").count() > 0;
    assert(maintenanceVisible === fixture.canMaintain, `${fixture.role} 收款维护按钮可见性必须符合权限`, { maintenanceVisible, expected: fixture.canMaintain });
    if (!fixture.canMaintain) {
      for (const testId of ["save-sales-order", "audit-sales-order", "reverse-document", "delete-sales-order", "receipt-open-account-selector", "receipt-open-source-selector"]) {
        assert(await rolePage.getByTestId(testId).count() === 0, `${fixture.role} 不得显示维护动作 ${testId}`);
      }
    }
    evidence.permissionBrowser.push({ role: fixture.role, moduleVisible: true, settlementEntriesVisible: true, maintenanceVisible });
    await context.close();
  }
  await financeContext.close();
  await browser.close();
  browser = null;
  cookies.finance = await loginApi(apiBase, users.finance.username, users.finance.password, "BLD-TEST");
  await documentAction("receipt", mainBills.receiptBill, "reverse", 200, cookies.finance, undefined, "browser receipt reverse");
  await documentAction("payment", mainBills.paymentBill, "reverse", 200, cookies.finance, undefined, "browser payment reverse");
  evidence.coverage.browser = true;
}

function verifyOperationLogs() {
  const rows = dbJson(`
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
      'action', action_code,
      'targetType', target_type,
      'targetNo', target_no,
      'success', success,
      'actor', actor_username,
      'accountSetCode', account_set_code,
      'before', before_state,
      'after', after_state,
      'failureReason', failure_reason
    ) ORDER BY operated_at, id), '[]'::jsonb)::text
    FROM public.sys_operation_log
    WHERE actor_username LIKE ${sqlLiteral(`${userPrefix}%`)}
  `) ?? [];
  const successfulActions = new Set(rows.filter((row) => row.success).map((row) => row.action));
  for (const required of [
    "CREATE_RECEIPT_DRAFT", "UPDATE_RECEIPT_DRAFT", "AUDIT_RECEIPT", "REVERSE_RECEIPT", "DELETE_RECEIPT_DRAFT",
    "CREATE_PAYMENT_DRAFT", "UPDATE_PAYMENT_DRAFT", "AUDIT_PAYMENT", "REVERSE_PAYMENT", "DELETE_PAYMENT_DRAFT"
  ]) {
    assert(successfulActions.has(required), `A141 操作日志必须包含 ${required}`, [...successfulActions]);
  }
  const successRows = rows.filter((row) => row.success && /_(RECEIPT|PAYMENT)|^(CREATE|UPDATE|AUDIT|REVERSE|DELETE)_/.test(row.action));
  assert(successRows.every((row) => [users.finance.username, users.admin.username].includes(row.actor) && row.accountSetCode === "BLD-TEST"), "public 正式收付款成功日志必须记录真实财务/管理员用户和账套", successRows);
  const auditRows = successRows.filter((row) => ["AUDIT_RECEIPT", "AUDIT_PAYMENT"].includes(row.action));
  assert(auditRows.some((row) => row.after?.status === "AUDITED" && row.after?.currency && row.after?.amount && row.after?.version >= 1 && row.after?.sourceCount >= 1 && row.after?.accountCount >= 1), "审核日志必须包含状态/币种/金额/版本/来源数/账户数", auditRows);
  const raw = JSON.stringify(rows);
  assert(!raw.includes(`${fixturePrefix}-SECRET`), "操作日志不得记录交易号原值", rows);
  const failureRows = rows.filter((row) => !row.success);
  assert(failureRows.length > 0 && failureRows.every((row) => row.failureReason), "410/权限/CAS/校验失败必须进入统一脱敏失败审计", failureRows);
  evidence.operationLogs = rows;
  evidence.coverage.operationLogs = true;
}

function testSettlementRows(schema, kind) {
  const header = kind === "receipt" ? "ar_receipt" : "ap_payment";
  return dbJson(`
    SELECT COALESCE(jsonb_agg(row_to_json(test_row) ORDER BY test_row."billNo"), '[]'::jsonb)::text
    FROM (
      SELECT bill_no AS "billNo", status, legacy_imported AS legacy
      FROM ${schemaTable(schema, header)}
      WHERE bill_no LIKE ${sqlLiteral(`${fixturePrefix}%`)}
         OR remark LIKE ${sqlLiteral(`${fixturePrefix}%`)}
    ) test_row
  `) ?? [];
}

function businessDocumentStatus(table, billNo) {
  return dbScalar(`SELECT status FROM public.${sqlIdentifier(table)} WHERE bill_no=${sqlLiteral(billNo)}`);
}

function chainInventoryPredicate(alias = "txn") {
  const exactSources = [
    ...chainArtifacts.deliveryNotices.flatMap((billNo) => [
      ["DELIVERY_NOTICE_RESERVE", `DELIVERY_NOTICE:${billNo}`],
      ["DELIVERY_NOTICE_RESERVE_REVERSE", `DELIVERY_NOTICE_REVERSE:${billNo}`]
    ]),
    ...chainArtifacts.salesOuts.flatMap((billNo) => [
      ["SALES_OUT", `SALES_OUT:${billNo}`],
      ["SALES_OUT_REVERSE", `SALES_OUT_REVERSE:${billNo}`]
    ]),
    ...chainArtifacts.purchaseIns.flatMap((billNo) => [
      ["PURCHASE_IN", `PURCHASE_IN:${billNo}`],
      ["PURCHASE_IN_REVERSE", `PURCHASE_IN_REVERSE:${billNo}`]
    ]),
    ...chainArtifacts.purchaseReturns.flatMap((billNo) => [
      ["PURCHASE_RETURN", `PURCHASE_RETURN:${billNo}`],
      ["PURCHASE_RETURN_REVERSE", `PURCHASE_RETURN_REVERSE:${billNo}`]
    ])
  ];
  return exactSources.map(([txnType, sourceBillType]) => `(${alias}.txn_type=${sqlLiteral(txnType)} AND ${alias}.source_bill_type=${sqlLiteral(sourceBillType)})`).join(" OR ") || "FALSE";
}

function normalizedStockTransactionSql(alias) {
  return `(to_jsonb(${alias}) || jsonb_build_object(
    'qty_delta', ${alias}.qty_delta::text,
    'unit_cost', ${alias}.unit_cost::text,
    'amount', ${alias}.amount::text
  ))`;
}

function chainInventoryTransactions() {
  return dbJson(`
    SELECT COALESCE(jsonb_agg(${normalizedStockTransactionSql("txn")} ORDER BY txn.occurred_at, txn.id::text), '[]'::jsonb)::text
    FROM public.inv_stock_txn txn
    JOIN public.md_product p ON p.id=txn.product_id
    JOIN public.md_warehouse w ON w.id=txn.warehouse_id
    JOIN public.sys_account_set a ON a.id=txn.account_set_id
    WHERE p.code='CP-001' AND w.code='CK-001' AND a.code='BLD-TEST'
      AND (${chainInventoryPredicate("txn")})
  `) ?? [];
}

async function recoveryRequest(cookie, label, pathname, method = "POST") {
  try {
    const response = await request(cookie, pathname, { method });
    const action = { label, method, pathname, status: response.status };
    evidence.cleanup.recovery.actions.push(action);
    if (![200, 404].includes(response.status)) {
      evidence.cleanup.recovery.errors.push({ ...action, body: response.text.slice(0, 500) });
    }
    return response;
  } catch (error) {
    const action = { label, method, pathname, status: null, error: error instanceof Error ? error.message : String(error) };
    evidence.cleanup.recovery.actions.push(action);
    evidence.cleanup.recovery.errors.push(action);
    return null;
  }
}

async function recoverSettlements(schema, cookie) {
  for (const kind of ["receipt", "payment"]) {
    const collection = kind === "receipt" ? "receipts" : "payments";
    for (const row of testSettlementRows(schema, kind)) {
      let after = documentState(schema, kind, row.billNo);
      if (row.status === "AUDITED") {
        await recoveryRequest(
          cookie,
          `${schema} ${kind} ${row.billNo} reverse`,
          `/api/finance/${collection}/${encodeURIComponent(row.billNo)}/reverse`
        );
        after = documentState(schema, kind, row.billNo);
      }
      if (after?.status === "DRAFT" && !row.legacy) {
        await recoveryRequest(
          cookie,
          `${schema} ${kind} ${row.billNo} delete`,
          `/api/finance/${collection}/${encodeURIComponent(row.billNo)}`,
          "DELETE"
        );
        after = documentState(schema, kind, row.billNo);
      }
      const expectedStatus = row.legacy ? "DRAFT" : null;
      if ((after?.status ?? null) !== expectedStatus) {
        evidence.cleanup.recovery.errors.push({
          label: `${schema} ${kind} ${row.billNo} state after lifecycle recovery`,
          expected: expectedStatus,
          actual: after?.status ?? null
        });
      }
    }
  }
}

async function recoverBusinessDocuments(table, collection, billNos) {
  for (const billNo of [...billNos].reverse()) {
    let status = businessDocumentStatus(table, billNo);
    if (!status) continue;
    if (status === "AUDITED") {
      await recoveryRequest(
        cookies.admin,
        `${collection} ${billNo} reverse`,
        `/api/${collection}/${encodeURIComponent(billNo)}/reverse`
      );
      status = businessDocumentStatus(table, billNo);
    }
    if (status === "DRAFT") {
      await recoveryRequest(
        cookies.admin,
        `${collection} ${billNo} delete`,
        `/api/${collection}/${encodeURIComponent(billNo)}`,
        "DELETE"
      );
      status = businessDocumentStatus(table, billNo);
    }
    if (status) {
      evidence.cleanup.recovery.errors.push({
        label: `${collection} ${billNo} removed after recovery`,
        expected: null,
        actual: status
      });
    }
  }
}

function restoreChainStockBaseline() {
  if (!chainStockBaseline) return;
  const stockEvidence = evidence.cleanup.recovery.stock;
  const current = stockCleanupSnapshot();
  const currentTransactions = chainInventoryTransactions();
  stockEvidence.afterApiRecovery = current?.state ?? null;
  if (!same(current?.state, chainStockBaseline.state)) {
    throw new Error(`A141 API 恢复后库存三量未回基线，拒绝删除流水或覆盖 balance ${JSON.stringify({
      expected: chainStockBaseline.state,
      actual: current?.state ?? null
    })}`);
  }
  if (!current?.balance) throw new Error("A141 库存精确恢复找不到当前 balance");

  const before = chainStockBaseline.balance;
  dbScalar(`
    BEGIN;
    DO $a141_inventory_cleanup$
    DECLARE
      baseline_balance jsonb := ${jsonbSql(before)};
      expected_current_balance jsonb := ${jsonbSql(current.balance)};
      expected_current_txns jsonb := ${jsonbSql(currentTransactions)};
      locked_balance jsonb;
      locked_txns jsonb;
      owned_posting_count bigint;
      deleted_count bigint;
    BEGIN
      PERFORM 1
      FROM public.inv_stock_balance
      WHERE id=${sqlLiteral(before.id)}::uuid
      FOR UPDATE;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'A141 inventory cleanup refused: balance row disappeared before lock';
      END IF;

      SELECT ${normalizedStockBalanceSql("balance")}
      INTO locked_balance
      FROM public.inv_stock_balance balance
      WHERE balance.id=${sqlLiteral(before.id)}::uuid;
      IF locked_balance IS DISTINCT FROM expected_current_balance THEN
        RAISE EXCEPTION 'A141 inventory cleanup refused: complete balance state changed before row lock';
      END IF;

      SELECT COALESCE(jsonb_agg(${normalizedStockTransactionSql("candidate")} ORDER BY candidate.occurred_at, candidate.id::text), '[]'::jsonb),
             count(*)
      INTO locked_txns, owned_posting_count
      FROM public.inv_stock_txn candidate
      JOIN public.sys_account_set account_set ON account_set.id=candidate.account_set_id
      JOIN public.md_product product ON product.id=candidate.product_id
      JOIN public.md_warehouse warehouse ON warehouse.id=candidate.warehouse_id
      WHERE account_set.code='BLD-TEST'
        AND product.code='CP-001'
        AND warehouse.code='CK-001'
        AND (${chainInventoryPredicate("candidate")});
      IF locked_txns IS DISTINCT FROM expected_current_txns THEN
        RAISE EXCEPTION 'A141 inventory cleanup refused: owned transaction set changed before row lock';
      END IF;

      IF locked_balance->'id' IS DISTINCT FROM baseline_balance->'id'
        OR locked_balance->'account_set_id' IS DISTINCT FROM baseline_balance->'account_set_id'
        OR locked_balance->'product_id' IS DISTINCT FROM baseline_balance->'product_id'
        OR locked_balance->'warehouse_id' IS DISTINCT FROM baseline_balance->'warehouse_id'
        OR locked_balance->'unit_cost' IS DISTINCT FROM baseline_balance->'unit_cost'
        OR locked_balance->'amount' IS DISTINCT FROM baseline_balance->'amount'
        OR locked_balance->'created_at' IS DISTINCT FROM baseline_balance->'created_at' THEN
        RAISE EXCEPTION 'A141 inventory cleanup refused: non-test balance fields changed';
      END IF;
      IF (locked_balance->>'version')::bigint IS DISTINCT FROM (baseline_balance->>'version')::bigint + owned_posting_count THEN
        RAISE EXCEPTION 'A141 inventory cleanup refused: version delta does not equal owned postings';
      END IF;

      DELETE FROM public.inv_stock_txn candidate
      USING public.sys_account_set account_set, public.md_product product, public.md_warehouse warehouse
      WHERE account_set.id=candidate.account_set_id
        AND product.id=candidate.product_id
        AND warehouse.id=candidate.warehouse_id
        AND account_set.code='BLD-TEST'
        AND product.code='CP-001'
        AND warehouse.code='CK-001'
        AND (${chainInventoryPredicate("candidate")});
      GET DIAGNOSTICS deleted_count = ROW_COUNT;
      IF deleted_count IS DISTINCT FROM owned_posting_count THEN
        RAISE EXCEPTION 'A141 inventory cleanup refused: deleted owned transaction count mismatch';
      END IF;

      UPDATE public.inv_stock_balance
      SET qty_on_hand=${nullableSql(before.qty_on_hand)},
          qty_available=${nullableSql(before.qty_available)},
          qty_reserved=${nullableSql(before.qty_reserved)},
          unit_cost=${nullableSql(before.unit_cost)},
          amount=${nullableSql(before.amount)},
          created_at=${nullableSql(before.created_at, "timestamptz")},
          updated_at=${nullableSql(before.updated_at, "timestamptz")},
          version=${nullableSql(before.version, "bigint")}
      WHERE id=${sqlLiteral(before.id)}::uuid;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'A141 inventory cleanup refused: exact baseline restore updated zero rows';
      END IF;
    END;
    $a141_inventory_cleanup$;
    COMMIT;
  `);

  const finalSnapshot = stockCleanupSnapshot();
  const finalTransactions = chainInventoryTransactions();
  stockEvidence.exactRestore = {
    ownedTransactionCount: currentTransactions.length,
    balanceRestored: same(finalSnapshot, chainStockBaseline),
    transactionsRestored: finalTransactions.length === 0
  };
  stockEvidence.final = finalSnapshot?.state ?? null;
  if (!same(finalSnapshot, chainStockBaseline) || finalTransactions.length !== 0) {
    throw new Error(`A141 库存完整快照恢复失败 ${JSON.stringify({ baseline: chainStockBaseline, finalSnapshot, finalTransactions })}`);
  }
  directCleanupAuthorized = true;
}

async function recoverFailureSafeState() {
  evidence.cleanup.recovery.attempted = true;
  try {
    if (cookies.finance) await recoverSettlements("public", cookies.finance);
    if (replayTenant?.schemaName && cookies.replayFinance) await recoverSettlements(replayTenant.schemaName, cookies.replayFinance);

    if (cookies.admin) {
      await recoverBusinessDocuments("purchase_return", "purchase-returns", chainArtifacts.purchaseReturns);
      await recoverBusinessDocuments("purchase_in", "purchase-ins", chainArtifacts.purchaseIns);
      await recoverBusinessDocuments("sales_out", "sales-outs", chainArtifacts.salesOuts);
      await recoverBusinessDocuments("delivery_notice", "delivery-notices", chainArtifacts.deliveryNotices);
      await recoverBusinessDocuments("sales_order", "sales-orders", chainArtifacts.salesOrders);
    }
  } catch (error) {
    evidence.cleanup.recovery.errors.push({
      label: "unexpected API recovery failure",
      error: error instanceof Error ? error.message : String(error)
    });
  } finally {
    restoreChainStockBaseline();
  }
  if (evidence.cleanup.recovery.errors.length > 0) {
    throw new Error(`A141 API 恢复存在未闭环动作 ${JSON.stringify(evidence.cleanup.recovery.errors)}`);
  }
}

async function logoutSessions() {
  await Promise.all(Object.values(cookies).map((cookie) => fetch(`${apiBase}/api/system/logout`, { method: "POST", headers: { Cookie: cookie } }).catch(() => null)));
}

function cleanupSchema(schema) {
  const t = (name) => schemaTable(schema, name);
  const inValues = (values) => values.length ? values.map(sqlLiteral).join(",") : "NULL";
  const chainCleanup = schema === "public" ? `
    DELETE FROM ${t("ar_receivable")} WHERE source_bill_no IN (${inValues(chainArtifacts.salesOuts)});
    DELETE FROM ${t("ap_payable")} WHERE source_bill_no IN (${inValues([...chainArtifacts.purchaseIns, ...chainArtifacts.purchaseReturns])});
    DELETE FROM ${t("purchase_return_line")} WHERE bill_id IN (SELECT id FROM ${t("purchase_return")} WHERE bill_no IN (${inValues(chainArtifacts.purchaseReturns)}) OR remark LIKE ${sqlLiteral(`${fixturePrefix}%`)});
    DELETE FROM ${t("purchase_return")} WHERE bill_no IN (${inValues(chainArtifacts.purchaseReturns)}) OR remark LIKE ${sqlLiteral(`${fixturePrefix}%`)};
    DELETE FROM ${t("purchase_in_line")} WHERE bill_id IN (SELECT id FROM ${t("purchase_in")} WHERE bill_no IN (${inValues(chainArtifacts.purchaseIns)}));
    DELETE FROM ${t("purchase_in")} WHERE bill_no IN (${inValues(chainArtifacts.purchaseIns)});
    DELETE FROM ${t("purchase_order_line")} WHERE order_id IN (SELECT id FROM ${t("purchase_order")} WHERE bill_no IN (${inValues(chainArtifacts.purchaseOrders)}));
    DELETE FROM ${t("purchase_order")} WHERE bill_no IN (${inValues(chainArtifacts.purchaseOrders)});
    DELETE FROM ${t("sales_out_line")} WHERE bill_id IN (SELECT id FROM ${t("sales_out")} WHERE bill_no IN (${inValues(chainArtifacts.salesOuts)}));
    DELETE FROM ${t("sales_out")} WHERE bill_no IN (${inValues(chainArtifacts.salesOuts)});
    DELETE FROM ${t("delivery_notice_line")} WHERE bill_id IN (SELECT id FROM ${t("delivery_notice")} WHERE bill_no IN (${inValues(chainArtifacts.deliveryNotices)}));
    DELETE FROM ${t("delivery_notice")} WHERE bill_no IN (${inValues(chainArtifacts.deliveryNotices)});
    DELETE FROM ${t("sales_order_line")} WHERE order_id IN (SELECT id FROM ${t("sales_order")} WHERE bill_no IN (${inValues(chainArtifacts.salesOrders)}));
    DELETE FROM ${t("sales_order")} WHERE bill_no IN (${inValues(chainArtifacts.salesOrders)});
  ` : "";
  dbScalar(`
    BEGIN;
    DELETE FROM ${t("sys_operation_log")}
      WHERE actor_username LIKE ${sqlLiteral(`${userPrefix}%`)}
         OR target_no LIKE ${sqlLiteral(`${fixturePrefix}%`)}
         OR COALESCE(failure_reason,'') LIKE ${sqlLiteral(`%${fixturePrefix}%`)};
    DELETE FROM ${t("ar_receipt")} WHERE remark LIKE ${sqlLiteral(`${fixturePrefix}%`)} OR bill_no LIKE ${sqlLiteral(`${fixturePrefix}%`)};
    DELETE FROM ${t("ap_payment")} WHERE remark LIKE ${sqlLiteral(`${fixturePrefix}%`)} OR bill_no LIKE ${sqlLiteral(`${fixturePrefix}%`)};
    ${chainCleanup}
    DELETE FROM ${t("ar_receivable")} WHERE bill_no LIKE ${sqlLiteral(`${fixturePrefix}%`)} OR source_bill_no LIKE ${sqlLiteral(`${fixturePrefix}%`)};
    DELETE FROM ${t("ap_payable")} WHERE bill_no LIKE ${sqlLiteral(`${fixturePrefix}%`)} OR source_bill_no LIKE ${sqlLiteral(`${fixturePrefix}%`)};
    DELETE FROM ${t("md_financial_account")} WHERE code LIKE ${sqlLiteral(`${fixturePrefix}%`)};
    DELETE FROM ${t("md_customer")} WHERE code LIKE ${sqlLiteral(`${fixturePrefix}%`)};
    DELETE FROM ${t("md_supplier")} WHERE code LIKE ${sqlLiteral(`${fixturePrefix}%`)};
    COMMIT;
  `);
}

function cleanupFixtures() {
  evidence.cleanup.attempted = true;
  if (directCleanupAuthorized) {
    if (replayTenant?.schemaName) cleanupSchema(replayTenant.schemaName);
    cleanupSchema("public");
    dbScalar(`
      BEGIN;
      DELETE FROM public.sys_user_account_set WHERE user_id IN (SELECT id FROM public.sys_user WHERE username LIKE ${sqlLiteral(`${userPrefix}%`)});
      DELETE FROM public.sys_user_role WHERE user_id IN (SELECT id FROM public.sys_user WHERE username LIKE ${sqlLiteral(`${userPrefix}%`)});
      DELETE FROM public.sys_user WHERE username LIKE ${sqlLiteral(`${userPrefix}%`)};
      DELETE FROM public.sys_permission WHERE role_id IN (SELECT id FROM public.sys_role WHERE code=${sqlLiteral(reportRoleCode)});
      DELETE FROM public.sys_role WHERE code=${sqlLiteral(reportRoleCode)};
      COMMIT;
    `);
  }
  const schemaResidue = (schema) => {
    const t = (name) => schemaTable(schema, name);
    const inValues = (values) => values.length ? values.map(sqlLiteral).join(",") : "NULL";
    return {
      customers: Number(dbScalar(`SELECT count(*) FROM ${t("md_customer")} WHERE code LIKE ${sqlLiteral(`${fixturePrefix}%`)}`)),
      suppliers: Number(dbScalar(`SELECT count(*) FROM ${t("md_supplier")} WHERE code LIKE ${sqlLiteral(`${fixturePrefix}%`)}`)),
      accounts: Number(dbScalar(`SELECT count(*) FROM ${t("md_financial_account")} WHERE code LIKE ${sqlLiteral(`${fixturePrefix}%`)}`)),
      receivables: Number(dbScalar(`SELECT count(*) FROM ${t("ar_receivable")} WHERE bill_no LIKE ${sqlLiteral(`${fixturePrefix}%`)} OR source_bill_no LIKE ${sqlLiteral(`${fixturePrefix}%`)}`)),
      payables: Number(dbScalar(`SELECT count(*) FROM ${t("ap_payable")} WHERE bill_no LIKE ${sqlLiteral(`${fixturePrefix}%`)} OR source_bill_no LIKE ${sqlLiteral(`${fixturePrefix}%`)}`)),
      receipts: Number(dbScalar(`SELECT count(*) FROM ${t("ar_receipt")} WHERE remark LIKE ${sqlLiteral(`${fixturePrefix}%`)} OR bill_no LIKE ${sqlLiteral(`${fixturePrefix}%`)}`)),
      payments: Number(dbScalar(`SELECT count(*) FROM ${t("ap_payment")} WHERE remark LIKE ${sqlLiteral(`${fixturePrefix}%`)} OR bill_no LIKE ${sqlLiteral(`${fixturePrefix}%`)}`)),
      logs: Number(dbScalar(`SELECT count(*) FROM ${t("sys_operation_log")} WHERE actor_username LIKE ${sqlLiteral(`${userPrefix}%`)} OR target_no LIKE ${sqlLiteral(`${fixturePrefix}%`)}`)),
      chainBusiness: schema === "public" ? Number(dbScalar(`
        SELECT (SELECT count(*) FROM ${t("sales_order")} WHERE bill_no IN (${inValues(chainArtifacts.salesOrders)}))
             + (SELECT count(*) FROM ${t("delivery_notice")} WHERE bill_no IN (${inValues(chainArtifacts.deliveryNotices)}))
             + (SELECT count(*) FROM ${t("sales_out")} WHERE bill_no IN (${inValues(chainArtifacts.salesOuts)}))
             + (SELECT count(*) FROM ${t("purchase_order")} WHERE bill_no IN (${inValues(chainArtifacts.purchaseOrders)}))
             + (SELECT count(*) FROM ${t("purchase_in")} WHERE bill_no IN (${inValues(chainArtifacts.purchaseIns)}))
             + (SELECT count(*) FROM ${t("purchase_return")} WHERE bill_no IN (${inValues(chainArtifacts.purchaseReturns)}))
      `)) : 0,
      chainFinance: schema === "public" ? Number(dbScalar(`
        SELECT (SELECT count(*) FROM ${t("ar_receivable")} WHERE source_bill_no IN (${inValues(chainArtifacts.salesOuts)}))
             + (SELECT count(*) FROM ${t("ap_payable")} WHERE source_bill_no IN (${inValues([...chainArtifacts.purchaseIns, ...chainArtifacts.purchaseReturns])}))
      `)) : 0,
      chainTransactions: schema === "public" ? Number(dbScalar(`
        SELECT count(*) FROM ${t("inv_stock_txn")} txn
        WHERE ${chainInventoryPredicate("txn")}
      `)) : 0,
      chainStockBalance: schema === "public" && chainStockBaseline
        ? (same(stockCleanupSnapshot(), chainStockBaseline) ? 0 : 1)
        : 0
    };
  };
  const remaining = {
    public: schemaResidue("public"),
    replay: replayTenant?.schemaName ? schemaResidue(replayTenant.schemaName) : {},
    users: Number(dbScalar(`SELECT count(*) FROM public.sys_user WHERE username LIKE ${sqlLiteral(`${userPrefix}%`)}`)),
    roles: Number(dbScalar(`SELECT count(*) FROM public.sys_role WHERE code=${sqlLiteral(reportRoleCode)}`)),
    grants: Number(dbScalar(`SELECT count(*) FROM public.sys_user_account_set g JOIN public.sys_user u ON u.id=g.user_id WHERE u.username LIKE ${sqlLiteral(`${userPrefix}%`)}`))
  };
  evidence.cleanup.remaining = remaining;
  const values = [remaining.users, remaining.roles, remaining.grants, ...Object.values(remaining.public), ...Object.values(remaining.replay)];
  assert(values.every((value) => value === 0), "A141 finally 清理后全部测试残留必须为 0", remaining);
}

async function main() {
  await mkdir(verificationDir, { recursive: true });
  await mkdir(screenshotDir, { recursive: true });
  assert(
    ["", "after-first-sales-out-audit", "after-first-purchase-in-audit"].includes(faultInjection),
    "A141_FAULT_INJECTION 只允许两个受控故障点",
    faultInjection
  );
  setupFixtures();
  await loginFixtures();
  await verifyPermissionsAndRetiredRoutes();
  await verifyZeroDraftAndCas();
  await verifyExactJsonPrecision();
  const mainBills = await verifyCnyAndUsdLifecycles();
  await verifyValidationBoundaries();
  await verifyConcurrentAudit();
  await verifyReverseAtomicity();
  await verifyLegacy();
  await verifyListsAndSelectors(mainBills);
  await verifyTenantIsolation();
  captureChainStockBaseline();
  await verifySalesCurrencyChains();
  await verifyPurchaseCurrencyAndReturnGuards();
  await captureFormalDocuments(mainBills);
  verifyOperationLogs();
}

let failure = null;
try {
  await main();
} catch (error) {
  failure = error;
  evidence.failure = { message: error instanceof Error ? error.message : String(error), stack: error instanceof Error ? error.stack : "" };
} finally {
  if (browser) await browser.close().catch(() => null);
  const cleanupFailures = [];
  try {
    await recoverFailureSafeState();
  } catch (recoveryError) {
    cleanupFailures.push(recoveryError);
  }
  await logoutSessions().catch(() => null);
  try {
    cleanupFixtures();
  } catch (cleanupError) {
    cleanupFailures.push(cleanupError);
  }
  if (cleanupFailures.length > 0) {
    evidence.cleanup.error = cleanupFailures.map((error) => error instanceof Error ? error.message : String(error)).join(" | ");
    if (!failure) {
      failure = cleanupFailures[0];
      evidence.failure = {
        message: evidence.cleanup.error,
        stack: cleanupFailures[0] instanceof Error ? cleanupFailures[0].stack : ""
      };
    }
  }
  evidence.ok = failure === null;
  evidence.completedAt = new Date().toISOString();
  await mkdir(verificationDir, { recursive: true });
  await writeFile(resultPath, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
}

if (failure) throw failure;

console.log(JSON.stringify({ ok: true, resultPath, coverage: evidence.coverage, screenshots: evidence.screenshots, cleanup: evidence.cleanup.remaining }, null, 2));
