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
const resultPath = path.join(verificationDir, "a142-sales-return-regression.json");
const runId = `${new Date().toISOString().replace(/\D/g, "").slice(0, 14)}-${randomUUID().slice(0, 8)}`;
const compactRunId = runId.replaceAll("-", "");
const fixturePrefix = `A142-${runId}`;
const userPrefix = `a142_${compactRunId}`;
const lowRoleCode = `A142_LOW_${compactRunId}`;
const billDate = "2026-07-14";

const users = {
  admin: { username: `${userPrefix}_admin`, password: `A142-${compactRunId}-admin`, role: "ADMIN", label: "系统管理员" },
  warehouse: { username: `${userPrefix}_warehouse`, password: `A142-${compactRunId}-warehouse`, role: "WAREHOUSE", label: "仓库员" },
  low: { username: `${userPrefix}_low`, password: `A142-${compactRunId}-low`, role: lowRoleCode, label: "" },
  replayAdmin: { username: `${userPrefix}_replay_admin`, password: `A142-${compactRunId}-replay-admin`, role: "ADMIN", label: "系统管理员" }
};

const codes = {
  customerA: `${fixturePrefix}-CA`,
  customerB: `${fixturePrefix}-CB`,
  bankCny: `${fixturePrefix}-BCNY`,
  bankUsd: `${fixturePrefix}-BUSD`,
  replayProduct: `${fixturePrefix}-PRODUCT`,
  isolatedWarehouse: `${fixturePrefix}-WH`,
  sameSource: `${fixturePrefix}-SAME-OUT`,
  sameReturn: `${fixturePrefix}-SAME-RETURN`
};

const artifacts = {
  returns: { public: [], replay: [] },
  receipts: [],
  salesOrders: [],
  deliveryNotices: [],
  salesOuts: [],
  directSources: { public: [], replay: [] },
  redDrafts: []
};

const evidence = {
  runId,
  generatedAt: new Date().toISOString(),
  ok: false,
  contract: {
    task: "A142",
    permission: "sales.out.audit",
    currencies: ["CNY", "USD"],
    saveShape: ["billNo?", "version?", "billDate", "remark", "lines[sourceOutNo,sourceLineNo,qty,lineRemark]"]
  },
  environment: {},
  coverage: {},
  requests: [],
  assertions: [],
  permissions: [],
  chains: [],
  lifecycle: {},
  finance: {},
  concurrency: {},
  guards: {},
  lists: {},
  tenantIsolation: {},
  browser: [],
  operationLogs: [],
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
let cookies = {};
let fixtureIds = null;
let sharedStockBaseline = null;
let sharedStockCleanupAuthorized = true;
let mainReturn = null;
let controlledInventoryCapability = false;

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

function schemaTable(schema, table) {
  return `${sqlIdentifier(schema)}.${sqlIdentifier(table)}`;
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
  return { status: response.status, ok: response.ok, text, data, headers: response.headers };
}

function expectStatus(label, response, expected) {
  const statuses = Array.isArray(expected) ? expected : [expected];
  evidence.requests.push({ label, expected: statuses, actual: response.status });
  assert(statuses.includes(response.status), `${label} HTTP 状态不符合合同`, {
    expected: statuses,
    actual: response.status,
    body: response.text.slice(0, 800)
  });
}

async function requireControlledInventoryFixture() {
  const health = await request("", "/api/system/health");
  expectStatus("A142 controlled inventory fixture health", health, 200);
  assert(
    health.data?.testInventoryAdjustmentApi === true,
    "A142 只允许在 local/test/regression + 显式库存测试开关 + BLD-TEST allowlist 下运行",
    health.data
  );
  controlledInventoryCapability = true;
  evidence.environment.controlledInventoryFixture = true;
}

async function requireApi(cookie, label, pathname, { method = "POST", body = undefined, expected = 200 } = {}) {
  const response = await request(cookie, pathname, { method, body });
  expectStatus(label, response, expected);
  return response;
}

async function list(cookie, listKey, { keyword = fixturePrefix, view = "header", columnFilters = undefined, pageSize = 500 } = {}) {
  const query = new URLSearchParams({ keyword, view, page: "1", pageSize: String(pageSize) });
  if (columnFilters) query.set("columnFilters", JSON.stringify(columnFilters));
  return request(cookie, `/api/lists/${encodeURIComponent(listKey)}?${query}`);
}

function rowsFrom(response) {
  return Array.isArray(response.data?.rows) ? response.data.rows
    : Array.isArray(response.data?.data) ? response.data.data
      : Array.isArray(response.data) ? response.data
        : [];
}

function parseCsvRow(row) {
  const fields = [];
  let field = "";
  let quoted = false;
  for (let index = 0; index < row.length; index += 1) {
    const character = row[index];
    if (character === '"') {
      if (quoted && row[index + 1] === '"') {
        field += '"';
        index += 1;
      } else {
        quoted = !quoted;
      }
    } else if (character === "," && !quoted) {
      fields.push(field);
      field = "";
    } else {
      field += character;
    }
  }
  fields.push(field);
  assert(!quoted, "CSV 明细行不得包含未闭合引号", row);
  return fields;
}

function generatedBill(response, prefix, label) {
  const billNo = String(response.data?.billNo ?? response.data?.document?.billNo ?? "");
  assert(new RegExp(`^${prefix}\\d{6}$`).test(billNo), `${label} 必须生成 ${prefix} 单号`, response.data);
  return billNo;
}

function returnPayload(sourceOutNo, qty, options = {}) {
  const body = {
    billDate: options.billDate ?? billDate,
    remark: options.remark ?? `${fixturePrefix}-return`,
    lines: [{
      sourceOutNo,
      sourceLineNo: options.sourceLineNo ?? 1,
      qty,
      lineRemark: options.lineRemark ?? `${fixturePrefix}-line`
    }]
  };
  if (options.billNo) body.billNo = options.billNo;
  if (options.version !== undefined) body.version = options.version;
  return body;
}

async function createReturn(sourceOutNo, qty, options = {}) {
  const response = await requireApi(
    options.cookie ?? cookies.admin,
    options.label ?? `create sales return for ${sourceOutNo}`,
    "/api/sales-returns/draft",
    { expected: options.expected ?? 201, body: options.body ?? returnPayload(sourceOutNo, qty, options) }
  );
  if (response.status === 201) {
    const billNo = generatedBill(response, "XSTH", options.label ?? "sales return");
    (options.schema === "replay" ? artifacts.returns.replay : artifacts.returns.public).push(billNo);
  }
  return response;
}

function returnPostingHistory(schema, billNo) {
  const actualSchema = schema === "replay" ? replayTenant?.schemaName : schema;
  if (!actualSchema) return null;
  const accountSetCode = actualSchema === "public" ? "BLD-TEST" : replayTenant?.code;
  if (!accountSetCode) return null;
  const t = (name) => schemaTable(actualSchema, name);
  return dbJson(`
    WITH account_set AS (
      SELECT id FROM public.sys_account_set WHERE code=${sqlLiteral(accountSetCode)} AND enabled=TRUE
    ), header AS (
      SELECT id, bill_date FROM ${t("sales_return")} WHERE bill_no=${sqlLiteral(billNo)}
    ), lines AS (
      SELECT line.id, line.product_id, line.warehouse_id
      FROM ${t("sales_return_line")} line
      JOIN header ON header.id=line.bill_id
    ), candidates AS (
      SELECT txn.*
      FROM ${t("inv_stock_txn")} txn
      JOIN header ON txn.source_bill_id=header.id OR txn.source_bill_no=${sqlLiteral(billNo)}
    ), canonical AS (
      SELECT txn.*
      FROM candidates txn
      JOIN header ON TRUE
      WHERE txn.source_bill_type='SALES_RETURN'
        AND txn.source_bill_no=${sqlLiteral(billNo)}
        AND txn.source_bill_id=header.id
        AND txn.account_set_id=(SELECT id FROM account_set)
        AND txn.source_bill_date=header.bill_date
        AND txn.trace_quality='EXACT'
        AND EXISTS (
          SELECT 1 FROM lines line
          WHERE line.id=txn.source_bill_line_id
            AND line.product_id=txn.product_id
            AND line.warehouse_id=txn.warehouse_id
        )
    )
    SELECT jsonb_build_object(
      'headerCount', (SELECT count(*) FROM header),
      'accountSetCount', (SELECT count(*) FROM account_set),
      'lineCount', (SELECT count(*) FROM lines),
      'candidateCount', (SELECT count(*) FROM candidates),
      'canonicalCount', (SELECT count(*) FROM canonical),
      'forwardCount', (
        SELECT count(*) FROM canonical
        WHERE txn_type='SALES_RETURN' AND posting_action='AUDIT' AND reversal_of_txn_id IS NULL
      ),
      'reverseCount', (
        SELECT count(*) FROM canonical
        WHERE txn_type='SALES_RETURN_REVERSE' AND posting_action='REVERSE' AND reversal_of_txn_id IS NOT NULL
      ),
      'pairedReverseCount', (
        SELECT count(*) FROM canonical reverse_txn
        JOIN canonical forward_txn ON forward_txn.id=reverse_txn.reversal_of_txn_id
        WHERE reverse_txn.txn_type='SALES_RETURN_REVERSE'
          AND reverse_txn.posting_action='REVERSE'
          AND forward_txn.txn_type='SALES_RETURN'
          AND forward_txn.posting_action='AUDIT'
          AND forward_txn.reversal_of_txn_id IS NULL
          AND forward_txn.account_set_id=reverse_txn.account_set_id
          AND forward_txn.product_id=reverse_txn.product_id
          AND forward_txn.warehouse_id=reverse_txn.warehouse_id
          AND forward_txn.source_bill_type=reverse_txn.source_bill_type
          AND forward_txn.source_bill_no=reverse_txn.source_bill_no
          AND forward_txn.source_bill_id=reverse_txn.source_bill_id
          AND forward_txn.source_bill_line_id=reverse_txn.source_bill_line_id
          AND forward_txn.source_bill_date=reverse_txn.source_bill_date
      )
    )::text
  `);
}

function assertReturnDeleteHistory(schema, billNo, expectedHistory) {
  const history = returnPostingHistory(schema, billNo);
  assert(history?.headerCount === 1 && history.accountSetCount === 1 && history.lineCount > 0, `销售退货 ${billNo} 删除前必须存在唯一账套、单头及明细`, history);
  if (!expectedHistory) {
    assert(history.candidateCount === 0, `从未审核的销售退货 ${billNo} 不得产生库存过账历史`, history);
    return history;
  }
  assert(
    history.candidateCount === history.lineCount * 2
      && history.canonicalCount === history.candidateCount
      && history.forwardCount === history.lineCount
      && history.reverseCount === history.lineCount
      && history.pairedReverseCount === history.lineCount,
    `已审核再反审核的销售退货 ${billNo} 必须保留完整 forward/reverse EXACT pair`,
    history
  );
  return history;
}

async function returnAction(billNo, action, {
  cookie = cookies.admin,
  expected = undefined,
  schema = "public",
  expectPostingHistory = undefined
} = {}) {
  const method = action === "detail" ? "GET" : action === "delete" ? "DELETE" : "POST";
  const route = action === "detail" || action === "delete"
    ? `/api/sales-returns/${encodeURIComponent(billNo)}`
    : `/api/sales-returns/${encodeURIComponent(billNo)}/${action}`;
  let deleteHistory = null;
  if (action === "delete") {
    assert(typeof expectPostingHistory === "boolean", `销售退货 ${billNo} DELETE 必须由调用点显式声明是否曾过账`);
    deleteHistory = assertReturnDeleteHistory(schema, billNo, expectPostingHistory);
  }
  const response = await requireApi(cookie, `sales return ${billNo} ${action} (${schema})`, route, {
    method,
    expected: expected ?? (expectPostingHistory ? 409 : 200)
  });
  if (action === "delete" && expectPostingHistory) {
    assert(response.text.includes("库存过账历史"), `精确追溯销售退货 ${billNo} 必须禁止物理删除`, response.text);
  }
  if (deleteHistory) evidence.lifecycle[`deleteHistory:${schema}:${billNo}`] = deleteHistory;
  return response;
}

function receiptPayload({ receivableId, customerId, accountId, currency, amount, remark }) {
  return {
    partyId: customerId,
    billDate,
    currency,
    amount,
    remark: remark ?? `${fixturePrefix}-receipt`,
    fundLines: [{
      lineNo: 1,
      accountId,
      paymentMethod: "BANK_TRANSFER",
      amount,
      fee: 0,
      transactionNo: `${fixturePrefix}-SECRET-${randomUUID().slice(0, 6)}`,
      remark: `${fixturePrefix}-receipt-fund`
    }],
    allocations: [{ lineNo: 1, sourceId: receivableId, settlementAmount: amount, remark: `${fixturePrefix}-receipt-allocation` }]
  };
}

async function createReceipt(payload) {
  const response = await requireApi(cookies.admin, "create receipt draft", "/api/finance/receipts/draft", { expected: 201, body: payload });
  const billNo = String(response.data?.billNo ?? "");
  assert(/^SKD\d{6}$/.test(billNo), "正式收款必须生成 SKD 单号", response.data);
  artifacts.receipts.push(billNo);
  return billNo;
}

async function receiptAction(billNo, action, expected = 200) {
  const method = action === "delete" ? "DELETE" : "POST";
  const route = action === "delete"
    ? `/api/finance/receipts/${encodeURIComponent(billNo)}`
    : `/api/finance/receipts/${encodeURIComponent(billNo)}/${action}`;
  return requireApi(cookies.admin, `receipt ${billNo} ${action}`, route, { method, expected });
}

function sourceFacts(schema, billNo) {
  return dbJson(`
    SELECT row_to_json(source_row)::text FROM (
      SELECT so.id::text AS id, so.bill_no AS "billNo", c.code AS "customerCode", c.name AS customer,
             so.currency, so.status, sol.id::text AS "lineId", sol.line_no AS "lineNo",
             p.code AS "productCode", p.name AS "productName", w.code AS "warehouseCode",
             sol.qty::text AS qty, sol.unit_price::text AS "unitPrice", sol.tax_rate::text AS "taxRate",
             sol.price_tax_total::text AS "priceTaxTotal"
      FROM ${schemaTable(schema, "sales_out")} so
      JOIN ${schemaTable(schema, "sales_out_line")} sol ON sol.bill_id=so.id
      JOIN ${schemaTable(schema, "md_customer")} c ON c.id=so.customer_id
      JOIN ${schemaTable(schema, "md_product")} p ON p.id=sol.product_id
      JOIN ${schemaTable(schema, "md_warehouse")} w ON w.id=sol.warehouse_id
      WHERE so.bill_no=${sqlLiteral(billNo)} AND sol.line_no=1
    ) source_row
  `);
}

function receivableState(schema, sourceOutNo) {
  return dbJson(`
    SELECT row_to_json(ar_row)::text FROM (
      SELECT id::text AS id, bill_no AS "billNo", source_bill_no AS "sourceBillNo", currency,
             amount::text AS amount, received_amount::text AS "receivedAmount",
             return_offset_amount::text AS "returnOffsetAmount", status
      FROM ${schemaTable(schema, "ar_receivable")}
      WHERE source_bill_no=${sqlLiteral(sourceOutNo)} AND amount > 0
    ) ar_row
  `);
}

function receivableAnyState(schema, sourceOutNo) {
  return dbJson(`
    SELECT row_to_json(ar_row)::text FROM (
      SELECT id::text AS id, bill_no AS "billNo", source_bill_no AS "sourceBillNo", currency,
             amount::text AS amount, received_amount::text AS "receivedAmount",
             return_offset_amount::text AS "returnOffsetAmount", status
      FROM ${schemaTable(schema, "ar_receivable")}
      WHERE source_bill_no=${sqlLiteral(sourceOutNo)}
      ORDER BY id LIMIT 1
    ) ar_row
  `);
}

function receivableLedgerState(schema, sourceOutNo) {
  return dbJson(`
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
      'id', id::text,
      'billNo', bill_no,
      'sourceBillNo', source_bill_no,
      'currency', currency,
      'amount', amount::text,
      'receivedAmount', received_amount::text,
      'returnOffsetAmount', return_offset_amount::text,
      'status', status
    ) ORDER BY bill_no), '[]'::jsonb)::text
    FROM ${schemaTable(schema, "ar_receivable")}
    WHERE source_bill_no=${sqlLiteral(sourceOutNo)}
  `) ?? [];
}

function returnDbState(schema, billNo) {
  return dbJson(`
    SELECT row_to_json(return_row)::text FROM (
      SELECT sr.id::text AS id, sr.bill_no AS "billNo", sr.status, sr.currency,
             sr.total_amount::text AS "totalAmount", sr.version::text AS version,
             COALESCE((SELECT sum(a.offset_amount) FROM ${schemaTable(schema, "sales_return_finance_allocation")} a WHERE a.sales_return_id=sr.id), 0)::text AS "offsetAmount",
             COALESCE((SELECT sum(a.pending_refund_amount) FROM ${schemaTable(schema, "sales_return_finance_allocation")} a WHERE a.sales_return_id=sr.id), 0)::text AS "pendingRefundAmount",
             COALESCE((SELECT sum(a.refunded_amount) FROM ${schemaTable(schema, "sales_return_finance_allocation")} a WHERE a.sales_return_id=sr.id), 0)::text AS "refundedAmount"
      FROM ${schemaTable(schema, "sales_return")} sr WHERE sr.bill_no=${sqlLiteral(billNo)}
    ) return_row
  `);
}

function businessStatus(schema, table, billNo) {
  return dbScalar(`SELECT COALESCE((SELECT status FROM ${schemaTable(schema, table)} WHERE bill_no=${sqlLiteral(billNo)}), '')`);
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

function stockSnapshot(warehouseCode = "CK-001") {
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
    WHERE p.code='CP-001' AND w.code=${sqlLiteral(warehouseCode)} AND a.code='BLD-TEST'
  `);
}

function stockState(warehouseCode = "CK-001") {
  return stockSnapshot(warehouseCode)?.state ?? null;
}

function decimalDelta(after, before) {
  return {
    onHand: Number(after.onHand) - Number(before.onHand),
    available: Number(after.available) - Number(before.available),
    reserved: Number(after.reserved) - Number(before.reserved)
  };
}

function insertBaseFixtures(schema) {
  const t = (name) => schemaTable(schema, name);
  const label = schema === "public" ? "PUBLIC" : "TENANT";
  const tenantProduct = schema === "public" ? "" : `
    INSERT INTO ${t("md_product")} (
      code, name, spec, unit, enabled, category, product_type, is_inventory, is_sale,
      audit_status, product_category_id, unit_id, remark
    ) SELECT
      ${sqlLiteral(codes.replayProduct)}, 'A142 TENANT 隔离物料', 'A142', unit.code, TRUE,
      '成品总成', '成品', TRUE, TRUE, 'AUDITED', category.id, unit.id, ${sqlLiteral(fixturePrefix)}
    FROM ${t("md_product_category")} category, ${t("md_unit")} unit
    WHERE category.code='FINISHED' AND unit.code='PCS';
  `;
  dbScalar(`
    BEGIN;
    INSERT INTO ${t("md_customer")} (code, name, enabled, audit_status, remark) VALUES
      (${sqlLiteral(codes.customerA)}, ${sqlLiteral(`A142 ${label} 客户 A`)}, TRUE, 'AUDITED', ${sqlLiteral(fixturePrefix)}),
      (${sqlLiteral(codes.customerB)}, ${sqlLiteral(`A142 ${label} 客户 B`)}, TRUE, 'AUDITED', ${sqlLiteral(fixturePrefix)});
    INSERT INTO ${t("md_financial_account")} (
      code, name, account_type, bank_name, account_no, account_holder, currency, remark, enabled, audit_status
    ) VALUES
      (${sqlLiteral(codes.bankCny)}, ${sqlLiteral(`A142 ${label} CNY 银行`)}, 'BANK', 'A142 Bank', ${sqlLiteral(`CNY${compactRunId}`)}, 'A142', 'CNY', ${sqlLiteral(fixturePrefix)}, TRUE, 'AUDITED'),
      (${sqlLiteral(codes.bankUsd)}, ${sqlLiteral(`A142 ${label} USD Bank`)}, 'BANK', 'A142 Bank', ${sqlLiteral(`USD${compactRunId}`)}, 'A142', 'USD', ${sqlLiteral(fixturePrefix)}, TRUE, 'AUDITED');
    ${tenantProduct}
    COMMIT;
  `);
}

function resolveFixtureIds(schema) {
  const t = (name) => schemaTable(schema, name);
  const productPredicate = schema === "public"
    ? "code='CP-001'"
    : `code=${sqlLiteral(codes.replayProduct)}`;
  return dbJson(`
    SELECT jsonb_build_object(
      'customerA', (SELECT id::text FROM ${t("md_customer")} WHERE code=${sqlLiteral(codes.customerA)}),
      'customerB', (SELECT id::text FROM ${t("md_customer")} WHERE code=${sqlLiteral(codes.customerB)}),
      'bankCny', (SELECT id::text FROM ${t("md_financial_account")} WHERE code=${sqlLiteral(codes.bankCny)}),
      'bankUsd', (SELECT id::text FROM ${t("md_financial_account")} WHERE code=${sqlLiteral(codes.bankUsd)}),
      'product', (SELECT id::text FROM ${t("md_product")} WHERE ${productPredicate} ORDER BY CASE WHEN code='CP-001' THEN 0 ELSE 1 END, code LIMIT 1),
      'productCode', (SELECT code FROM ${t("md_product")} WHERE ${productPredicate} ORDER BY CASE WHEN code='CP-001' THEN 0 ELSE 1 END, code LIMIT 1),
      'warehouse', (SELECT id::text FROM ${t("md_warehouse")} WHERE code='CK-001')
    )::text
  `);
}

function setupFixtures() {
  assert(controlledInventoryCapability, "A142 写入夹具前必须通过受控库存能力门禁");
  assert(new URL(apiBase).hostname === "127.0.0.1" && new URL(frontendUrl).hostname === "127.0.0.1", "A142 只允许访问本机服务");
  assert(dbScalar("SELECT current_schema()") === "public", "A142 主夹具只允许准备在 public 测试 schema");
  const primaryAccount = dbJson(`
    SELECT row_to_json(a)::text FROM (
      SELECT id::text AS id, code, name, schema_name AS "schemaName", enabled
      FROM public.sys_account_set WHERE code='BLD-TEST'
    ) a
  `);
  assert(primaryAccount?.enabled === true && primaryAccount.schemaName === "public", "BLD-TEST 必须是启用的 public 测试账套", primaryAccount);
  replayTenant = dbJson(`
    SELECT row_to_json(a)::text FROM (
      SELECT id::text AS id, code, name, schema_name AS "schemaName"
      FROM public.sys_account_set
      WHERE enabled=TRUE AND code <> 'BLD-TEST' AND code LIKE 'A119%' AND schema_name <> 'public'
      ORDER BY CASE WHEN code='A119UI' THEN 0 ELSE 1 END, code LIMIT 1
    ) a
  `);
  assert(replayTenant?.code && replayTenant?.schemaName, "A142 双租户验收需要启用的 A119 测试账套", replayTenant);
  const requiredTables = ["sales_return", "sales_return_line", "sales_return_finance_allocation", "ar_receivable", "sales_out", "sales_out_line"];
  const ready = Number(dbScalar(`
    SELECT count(*) FROM information_schema.tables
    WHERE table_schema=${sqlLiteral(replayTenant.schemaName)}
      AND table_name IN (${requiredTables.map(sqlLiteral).join(",")})
  `));
  assert(ready === requiredTables.length, "A142 replay tenant 必须已同步 V103 三张表", { ready, expected: requiredTables.length });
  const existing = Number(dbScalar(`
    SELECT (SELECT count(*) FROM public.sys_user WHERE username LIKE ${sqlLiteral(`${userPrefix}%`)})
         + (SELECT count(*) FROM public.md_customer WHERE code LIKE ${sqlLiteral(`${fixturePrefix}%`)})
         + (SELECT count(*) FROM public.sales_return WHERE remark LIKE ${sqlLiteral(`${fixturePrefix}%`)})
         + (SELECT count(*) FROM public.sales_out WHERE remark LIKE ${sqlLiteral(`${fixturePrefix}%`)})
  `));
  assert(existing === 0, "A142 唯一夹具前缀不得已有残留", { existing });

  const userValues = Object.values(users)
    .map((user) => `(${sqlLiteral(user.username)}, ${sqlLiteral(user.password)}, ${sqlLiteral(user.role)})`)
    .join(",");
  dbScalar(`
    BEGIN;
    INSERT INTO public.sys_role (code, name, enabled) VALUES (${sqlLiteral(lowRoleCode)}, 'A142 无退货权限角色', TRUE);
    INSERT INTO public.sys_permission (role_id, permission_code, enabled)
      SELECT id, 'sales.order.audit', TRUE FROM public.sys_role WHERE code=${sqlLiteral(lowRoleCode)};
    CREATE TEMP TABLE a142_users (username text, password text, role_code text) ON COMMIT DROP;
    INSERT INTO a142_users VALUES ${userValues};
    INSERT INTO public.sys_user (username, display_name, password_hash, enabled, default_account_set_id)
      SELECT u.username, 'A142 '||u.role_code, '{noop}'||u.password, TRUE, a.id
      FROM a142_users u JOIN public.sys_account_set a ON a.code='BLD-TEST' AND a.enabled=TRUE;
    INSERT INTO public.sys_user_role (user_id, role_id)
      SELECT u.id, r.id FROM a142_users f
      JOIN public.sys_user u ON u.username=f.username
      JOIN public.sys_role r ON r.code=f.role_code AND r.enabled=TRUE;
    INSERT INTO public.sys_user_account_set (user_id, account_set_id, role_code, is_default, enabled)
      SELECT u.id, a.id, f.role_code, TRUE, TRUE FROM a142_users f
      JOIN public.sys_user u ON u.username=f.username
      JOIN public.sys_account_set a ON a.code='BLD-TEST' AND a.enabled=TRUE;
    INSERT INTO public.sys_user_account_set (user_id, account_set_id, role_code, is_default, enabled)
      SELECT u.id, a.id, f.role_code, FALSE, TRUE FROM a142_users f
      JOIN public.sys_user u ON u.username=f.username
      JOIN public.sys_account_set a ON a.code=${sqlLiteral(replayTenant.code)} AND a.enabled=TRUE
      WHERE f.username=${sqlLiteral(users.replayAdmin.username)};
    INSERT INTO public.md_warehouse (code, name, allow_negative_stock, enabled, audit_status, remark)
      VALUES (${sqlLiteral(codes.isolatedWarehouse)}, 'A142 独立库存守卫仓', FALSE, TRUE, 'AUDITED', ${sqlLiteral(fixturePrefix)});
    COMMIT;
  `);
  insertBaseFixtures("public");
  insertBaseFixtures(replayTenant.schemaName);
  fixtureIds = { public: resolveFixtureIds("public"), replay: resolveFixtureIds(replayTenant.schemaName) };
  assert(Object.values(fixtureIds.public).every(Boolean) && Object.values(fixtureIds.replay).every(Boolean), "A142 双账套基础夹具 ID 必须完整", fixtureIds);
  evidence.environment = { ...evidence.environment, primaryAccount, replayTenant, lowRoleCode };
}

async function loginFixtures() {
  cookies.admin = await loginApi(apiBase, users.admin.username, users.admin.password, "BLD-TEST");
  cookies.warehouse = await loginApi(apiBase, users.warehouse.username, users.warehouse.password, "BLD-TEST");
  cookies.low = await loginApi(apiBase, users.low.username, users.low.password, "BLD-TEST");
  cookies.replayAdmin = await loginApi(apiBase, users.replayAdmin.username, users.replayAdmin.password, replayTenant.code);
}

function sourceAmount(qty, unitPrice, taxRate) {
  const net = Math.round(Number(qty) * Number(unitPrice) * 100) / 100;
  const tax = Math.round(net * Number(taxRate)) / 100;
  return { net: net.toFixed(2), tax: tax.toFixed(2), total: (net + tax).toFixed(2) };
}

function insertDirectSource(schema, config) {
  const t = (name) => schemaTable(schema, name);
  const customerCode = config.customerCode ?? codes.customerA;
  const productCode = config.productCode ?? "CP-001";
  const warehouseCode = config.warehouseCode ?? "CK-001";
  const currency = config.currency ?? "CNY";
  const qty = config.qty ?? 1;
  const unitPrice = config.unitPrice ?? 100;
  const taxRate = config.taxRate ?? 13;
  const amount = sourceAmount(qty, unitPrice, taxRate);
  const arBillNo = `${fixturePrefix}-AR-${artifacts.directSources[schema === "public" ? "public" : "replay"].length + 1}`;
  dbScalar(`
    BEGIN;
    INSERT INTO ${t("sales_out")} (
      bill_no, customer_id, bill_date, department, status, total_amount, currency, owner_name, remark, version
    ) VALUES (
      ${sqlLiteral(config.billNo)},
      (SELECT id FROM ${t("md_customer")} WHERE code=${sqlLiteral(customerCode)}),
      DATE ${sqlLiteral(billDate)}, 'A142销售部', 'AUDITED', ${sqlLiteral(amount.total)}::numeric,
      ${sqlLiteral(currency)}, 'A142边界夹具', ${sqlLiteral(`${fixturePrefix}-${config.label ?? "direct"}`)}, 1
    );
    INSERT INTO ${t("sales_out_line")} (
      bill_id, line_no, product_id, warehouse_id, qty, unit_price, amount,
      tax_rate, tax_amount, price_tax_total, line_remark,
      product_code_snapshot, product_name_snapshot, product_spec_snapshot,
      product_unit_snapshot, net_weight_snapshot, gross_weight_snapshot
    ) SELECT
      so.id, 1, p.id, w.id, ${sqlLiteral(qty)}::numeric, ${sqlLiteral(unitPrice)}::numeric, ${sqlLiteral(amount.net)}::numeric,
      ${sqlLiteral(taxRate)}::numeric, ${sqlLiteral(amount.tax)}::numeric, ${sqlLiteral(amount.total)}::numeric,
      ${sqlLiteral(`${fixturePrefix}-${config.label ?? "direct"}-line`)},
      p.code, p.name, p.spec, p.unit, p.net_weight, p.gross_weight
    FROM ${t("sales_out")} so, ${t("md_product")} p, ${t("md_warehouse")} w
    WHERE so.bill_no=${sqlLiteral(config.billNo)} AND p.code=${sqlLiteral(productCode)} AND w.code=${sqlLiteral(warehouseCode)};
    INSERT INTO ${t("ar_receivable")} (
      bill_no, source_bill_no, customer_id, bill_date, currency, amount, received_amount, return_offset_amount, status
    ) VALUES (
      ${sqlLiteral(arBillNo)}, ${sqlLiteral(config.billNo)},
      (SELECT id FROM ${t("md_customer")} WHERE code=${sqlLiteral(customerCode)}),
      DATE ${sqlLiteral(billDate)}, ${sqlLiteral(currency)}, ${sqlLiteral(amount.total)}::numeric, 0, 0, 'OPEN'
    );
    COMMIT;
  `);
  const bucket = schema === "public" ? artifacts.directSources.public : artifacts.directSources.replay;
  bucket.push(config.billNo);
  return { ...config, schema, customerCode, productCode, warehouseCode, currency, qty, unitPrice, taxRate, amount, arBillNo };
}

function prepareDirectSources() {
  const publicSources = {
    cas: insertDirectSource("public", { billNo: `${fixturePrefix}-OUT-CAS`, label: "cas", qty: 2, unitPrice: 17.25 }),
    partial: insertDirectSource("public", { billNo: `${fixturePrefix}-OUT-PART`, label: "partial", qty: 2, unitPrice: 100 }),
    customerB: insertDirectSource("public", { billNo: `${fixturePrefix}-OUT-CB`, label: "customer-b", customerCode: codes.customerB }),
    usd: insertDirectSource("public", { billNo: `${fixturePrefix}-OUT-MIX-USD`, label: "mixed-usd", currency: "USD" }),
    race: insertDirectSource("public", { billNo: `${fixturePrefix}-OUT-RACE`, label: "race", qty: 1 }),
    lifo: insertDirectSource("public", { billNo: `${fixturePrefix}-OUT-LIFO`, label: "lifo", qty: 2 }),
    red: insertDirectSource("public", { billNo: `${fixturePrefix}-OUT-RED`, label: "red" }),
    guard: insertDirectSource("public", { billNo: `${fixturePrefix}-OUT-GUARD`, label: "guard" }),
    browser: insertDirectSource("public", { billNo: `${fixturePrefix}-OUT-BROWSER`, label: "browser" }),
    arRace: insertDirectSource("public", { billNo: `${fixturePrefix}-OUT-AR-RACE`, label: "ar-race" }),
    isolatedInventory: insertDirectSource("public", { billNo: `${fixturePrefix}-OUT-INV`, label: "inventory-guard", warehouseCode: codes.isolatedWarehouse })
  };
  publicSources.zeroAmount = insertDirectSource("public", { billNo: `${fixturePrefix}-OUT-ZERO`, label: "zero-amount", unitPrice: 0 });
  publicSources.same = insertDirectSource("public", { billNo: codes.sameSource, label: "same-public", customerCode: codes.customerA, currency: "CNY" });
  const replaySame = insertDirectSource(replayTenant.schemaName, {
    billNo: codes.sameSource,
    label: "same-tenant",
    customerCode: codes.customerB,
    currency: "USD",
    qty: 2,
    unitPrice: 71,
    productCode: fixtureIds.replay.productCode
  });
  return { public: publicSources, replaySame };
}

function captureSharedStockBaseline() {
  const snapshot = stockSnapshot();
  assert(snapshot?.state && /^\d+$/.test(snapshot.version), "A142 真实链开始前必须取得 CP-001/CK-001 完整库存基线", snapshot);
  assert(Number(snapshot.state.available) >= 4, "A142 CNY/USD 与两组来源并发真实链至少需要 4 个可用库存", snapshot.state);
  sharedStockBaseline = snapshot;
  sharedStockCleanupAuthorized = false;
  evidence.cleanup.recovery.stock = {
    baseline: snapshot.state,
    baselineVersion: snapshot.version,
    afterApiRecovery: null,
    final: null,
    exactRestore: null
  };
}

function expectedSharedStockState() {
  const baseline = sharedStockBaseline?.state;
  assert(baseline, "A142 计算共享库存状态前必须有基线");
  return dbJson(`
    WITH posting_delta AS (
      SELECT COALESCE(SUM(txn.qty_delta), 0::numeric) AS on_hand_delta
      FROM public.inv_stock_txn txn
      JOIN public.md_product product ON product.id=txn.product_id
      JOIN public.md_warehouse warehouse ON warehouse.id=txn.warehouse_id
      JOIN public.sys_account_set account_set ON account_set.id=txn.account_set_id
      WHERE product.code='CP-001' AND warehouse.code='CK-001' AND account_set.code='BLD-TEST'
        AND (${inventoryPredicate("txn")})
    ), notice_reservation AS (
      SELECT COALESCE(SUM(line.qty), 0::numeric) AS reserved_qty
      FROM public.delivery_notice document
      JOIN public.delivery_notice_line line ON line.bill_id=document.id
      JOIN public.md_product product ON product.id=line.product_id
      JOIN public.md_warehouse warehouse ON warehouse.id=line.warehouse_id
      WHERE document.status='AUDITED'
        AND document.bill_no IN (${inValues(artifacts.deliveryNotices)})
        AND product.code='CP-001' AND warehouse.code='CK-001'
    ), shipped_reservation AS (
      SELECT COALESCE(SUM(line.qty), 0::numeric) AS shipped_qty
      FROM public.sales_out document
      JOIN public.sales_out_line line ON line.bill_id=document.id
      JOIN public.md_product product ON product.id=line.product_id
      JOIN public.md_warehouse warehouse ON warehouse.id=line.warehouse_id
      WHERE document.status='AUDITED'
        AND document.bill_no IN (${inValues(artifacts.salesOuts)})
        AND line.source_delivery_notice_no IN (${inValues(artifacts.deliveryNotices)})
        AND product.code='CP-001' AND warehouse.code='CK-001'
    )
    SELECT jsonb_build_object(
      'onHand', (${sqlLiteral(baseline.onHand)}::numeric + posting_delta.on_hand_delta)::text,
      'reserved', (${sqlLiteral(baseline.reserved)}::numeric + notice_reservation.reserved_qty - shipped_reservation.shipped_qty)::text,
      'available', (${sqlLiteral(baseline.available)}::numeric + posting_delta.on_hand_delta - notice_reservation.reserved_qty + shipped_reservation.shipped_qty)::text
    )::text
    FROM posting_delta CROSS JOIN notice_reservation CROSS JOIN shipped_reservation
  `);
}

async function createSalesChain(currency) {
  const line = { productCode: "CP-001", warehouseCode: "CK-001", qty: 1, unitPrice: currency === "USD" ? 10 : 20, taxRate: 13, lineRemark: `${fixturePrefix}-${currency}` };
  const orderDraft = await requireApi(cookies.admin, `${currency} sales order draft`, "/api/sales-orders/draft", {
    expected: 201,
    body: {
      customerCode: codes.customerA,
      billDate,
      department: "A142销售部",
      ownerName: "A142管理员",
      remark: `${fixturePrefix}-sales-order-${currency}`,
      currency,
      lines: [line]
    }
  });
  const orderNo = generatedBill(orderDraft, "XSDD", `${currency} sales order`);
  artifacts.salesOrders.push(orderNo);
  await requireApi(cookies.admin, `${currency} sales order audit`, `/api/sales-orders/${encodeURIComponent(orderNo)}/audit`);

  const noticeDraft = await requireApi(cookies.admin, `${currency} delivery notice draft`, "/api/delivery-notices/draft", {
    expected: 201,
    body: {
      sourceOrderNo: orderNo,
      customerCode: codes.customerA,
      billDate,
      department: "A142销售部",
      ownerName: "A142管理员",
      remark: `${fixturePrefix}-delivery-${currency}`,
      currency,
      lines: [{ ...line, sourceOrderNo: orderNo, sourceLineNo: 1 }]
    }
  });
  const noticeNo = generatedBill(noticeDraft, "FHTZD", `${currency} delivery notice`);
  artifacts.deliveryNotices.push(noticeNo);
  await requireApi(cookies.admin, `${currency} delivery notice audit`, `/api/delivery-notices/${encodeURIComponent(noticeNo)}/audit`);

  const outDraft = await requireApi(cookies.admin, `${currency} sales out draft`, "/api/sales-outs/draft", {
    expected: 201,
    body: {
      sourceOrderNo: noticeNo,
      customerCode: codes.customerA,
      billDate,
      department: "A142销售部",
      ownerName: "A142管理员",
      remark: `${fixturePrefix}-sales-out-${currency}`,
      currency,
      lines: [{ ...line, sourceOrderNo: noticeNo, sourceLineNo: 1, sourceDeliveryNoticeNo: noticeNo, sourceDeliveryLineNo: 1 }]
    }
  });
  const outNo = generatedBill(outDraft, "XSCKD", `${currency} sales out`);
  artifacts.salesOuts.push(outNo);
  await requireApi(cookies.admin, `${currency} sales out audit`, `/api/sales-outs/${encodeURIComponent(outNo)}/audit`);
  const [orderDetail, noticeDetail, outDetail] = await Promise.all([
    returnActionProxy(`/api/sales-orders/${encodeURIComponent(orderNo)}`),
    returnActionProxy(`/api/delivery-notices/${encodeURIComponent(noticeNo)}`),
    returnActionProxy(`/api/sales-outs/${encodeURIComponent(outNo)}`)
  ]);
  const headers = [orderDetail, noticeDetail, outDetail].map((response) => response.data?.document ?? response.data?.order ?? response.data);
  assert(headers.every((header) => header?.currency === currency), `${currency} 必须从销售订单到销售出库逐级继承原币`, headers);
  const receivable = receivableState("public", outNo);
  assert(receivable?.currency === currency && Number(receivable.amount) > 0, `${currency} 销售出库审核必须生成同币种普通正应收`, receivable);
  const chain = { currency, orderNo, noticeNo, outNo, receivable };
  evidence.chains.push(chain);
  return chain;
}

async function returnActionProxy(pathname) {
  const response = await request(cookies.admin, pathname);
  expectStatus(`GET ${pathname}`, response, 200);
  return response;
}

async function verifyPermissions(source) {
  const payload = returnPayload(source.billNo, 0.25, { remark: `${fixturePrefix}-permission` });
  for (const [role, cookie, expected] of [
    ["anonymous", "", 401],
    ["low", cookies.low, 403]
  ]) {
    const create = await request(cookie, "/api/sales-returns/draft", { method: "POST", body: payload });
    expectStatus(`${role} sales return create`, create, expected);
    const selector = await list(cookie, "sales-out-return-source-selector", { keyword: source.billNo });
    expectStatus(`${role} sales return selector`, selector, expected);
    const formalList = await list(cookie, "sales-return-form-list", { keyword: fixturePrefix });
    expectStatus(`${role} sales return list`, formalList, expected);
    evidence.permissions.push({ role, create: create.status, selector: selector.status, list: formalList.status });
  }

  for (const [role, cookie] of [["admin", cookies.admin], ["warehouse", cookies.warehouse]]) {
    const selector = await list(cookie, "sales-out-return-source-selector", { keyword: source.billNo });
    expectStatus(`${role} sales return selector`, selector, 200);
    assert(rowsFrom(selector).some((row) => row.billNo === source.billNo), `${role} 必须按 sales.out.audit 看见可退来源`, rowsFrom(selector));
    const created = await createReturn(source.billNo, 0.25, { cookie, label: `${role} permission return` });
    const billNo = generatedBill(created, "XSTH", `${role} permission return`);
    const detail = await returnAction(billNo, "detail", { cookie });
    assert(detail.data?.document?.status === "DRAFT", `${role} 必须可查看自己新建的退货草稿`, detail.data);
    await returnAction(billNo, "delete", { cookie, expectPostingHistory: false });
    evidence.permissions.push({ role, selector: selector.status, create: created.status, detail: detail.status, delete: 200 });
  }
  const unknown = await list(cookies.admin, `${fixturePrefix}-unknown-list`, { keyword: "" });
  expectStatus("unknown list key fail closed", unknown, 404);
  evidence.coverage.permissions = true;
}

async function verifyDraftCasNarrowCopy(source) {
  const sourceBefore = sourceFacts("public", source.billNo);
  const arBefore = receivableState("public", source.billNo);
  const stockBefore = stockState();
  const newWithVersion = await request(cookies.admin, "/api/sales-returns/draft", {
    method: "POST",
    body: returnPayload(source.billNo, 0.5, { version: "0", remark: `${fixturePrefix}-new-version` })
  });
  expectStatus("new sales return rejects version", newWithVersion, 400);

  const maliciousBody = {
    customerCode: codes.customerB,
    currency: "USD",
    ownerName: "CLIENT-MUST-NOT-WIN",
    department: "CLIENT-MUST-NOT-WIN",
    billDate,
    remark: `${fixturePrefix}-cas-copy`,
    lines: [{
      sourceOutNo: source.billNo,
      sourceLineNo: 1,
      qty: 0.5,
      lineRemark: `${fixturePrefix}-copied-line`,
      productCode: "CLIENT-PRODUCT",
      warehouseCode: "CLIENT-WAREHOUSE",
      unitPrice: 999999,
      taxRate: 0
    }]
  };
  const created = await createReturn(source.billNo, 0.5, { body: maliciousBody, label: "narrow copy draft" });
  const billNo = generatedBill(created, "XSTH", "narrow copy draft");
  const detail = await returnAction(billNo, "detail");
  const document = detail.data?.document;
  const line = detail.data?.lines?.[0];
  assert(document?.customerCode === sourceBefore.customerCode && document.currency === sourceBefore.currency, "客户端自报客户和币种不得覆盖来源事实", { document, sourceBefore });
  assert(
    line?.productCode === sourceBefore.productCode
      && line?.warehouseCode === sourceBefore.warehouseCode
      && Number(line?.unitPrice) === Number(sourceBefore.unitPrice)
      && Number(line?.taxRate) === Number(sourceBefore.taxRate),
    "后端必须复制来源商品/仓库/单价/税率，忽略客户端展示字段",
    { line, sourceBefore }
  );
  assert(Number(line?.sourceQty) === Number(sourceBefore.qty) && Number(line?.remainingQty) === Number(sourceBefore.qty), "详情必须返回来源数量、已退量和剩余可退量", line);
  assert(same(stockState(), stockBefore) && same(receivableState("public", source.billNo), arBefore), "保存草稿必须保持零库存、零财务副作用");

  for (const [label, version, expected] of [
    ["numeric version", 0, 400],
    ["non canonical version", "00", 400],
    ["overflow version", "9223372036854775808", 400]
  ]) {
    const response = await request(cookies.admin, "/api/sales-returns/draft", {
      method: "POST",
      body: returnPayload(source.billNo, 0.75, { billNo, version, remark: `${fixturePrefix}-${label}` })
    });
    expectStatus(`draft CAS rejects ${label}`, response, expected);
  }
  const updated = await requireApi(cookies.admin, "canonical CAS update", "/api/sales-returns/draft", {
    expected: 201,
    body: returnPayload(source.billNo, 0.75, { billNo, version: "0", remark: `${fixturePrefix}-cas-updated` })
  });
  assert(updated.data?.document?.billNo === billNo && updated.data?.document?.version === "1", "规范 version 更新必须保持单号并递增版本", updated.data);
  const stale = await request(cookies.admin, "/api/sales-returns/draft", {
    method: "POST",
    body: returnPayload(source.billNo, 1, { billNo, version: "0", remark: `${fixturePrefix}-stale` })
  });
  expectStatus("stale CAS update", stale, 409);
  const afterStale = await returnAction(billNo, "detail");
  assert(Number(afterStale.data?.lines?.[0]?.qty) === 0.75 && afterStale.data?.document?.remark === `${fixturePrefix}-cas-updated`, "旧版本 409 必须保留当前草稿原值", afterStale.data);
  await returnAction(billNo, "delete", { expectPostingHistory: false });
  evidence.lifecycle.cas = { billNo, initialVersion: "0", updatedVersion: "1", staleStatus: stale.status };
  evidence.coverage.draftCasNarrowCopy = true;
}

async function verifyValidationGuards(sources) {
  const cases = [
    ["zero quantity", returnPayload(sources.cas.billNo, 0), 400],
    ["negative quantity", returnPayload(sources.cas.billNo, -1), 400],
    ["quantity scale", returnPayload(sources.cas.billNo, 0.12345), 400],
    ["over return", returnPayload(sources.cas.billNo, 99), 409],
    ["duplicate source line", {
      billDate,
      remark: `${fixturePrefix}-duplicate`,
      lines: [
        { sourceOutNo: sources.cas.billNo, sourceLineNo: 1, qty: 0.25, lineRemark: "one" },
        { sourceOutNo: sources.cas.billNo, sourceLineNo: 1, qty: 0.25, lineRemark: "two" }
      ]
    }, 400],
    ["mixed customer", {
      billDate,
      remark: `${fixturePrefix}-mixed-customer`,
      lines: [
        { sourceOutNo: sources.cas.billNo, sourceLineNo: 1, qty: 0.25, lineRemark: "a" },
        { sourceOutNo: sources.customerB.billNo, sourceLineNo: 1, qty: 0.25, lineRemark: "b" }
      ]
    }, 409],
    ["mixed currency", {
      billDate,
      remark: `${fixturePrefix}-mixed-currency`,
      lines: [
        { sourceOutNo: sources.cas.billNo, sourceLineNo: 1, qty: 0.25, lineRemark: "cny" },
        { sourceOutNo: sources.usd.billNo, sourceLineNo: 1, qty: 0.25, lineRemark: "usd" }
      ]
    }, 409]
  ];
  const results = [];
  for (const [label, body, expected] of cases) {
    const response = await request(cookies.admin, "/api/sales-returns/draft", { method: "POST", body });
    expectStatus(label, response, expected);
    results.push({ label, status: response.status, reason: response.data?.reason ?? response.data?.message ?? response.text.slice(0, 200) });
  }
  evidence.guards.validation = results;
  evidence.coverage.validationGuards = true;
}

async function verifyZeroAmountAuditRollback(source) {
  const stockBefore = stockState();
  const arBefore = receivableAnyState("public", source.billNo);
  assert(Number(arBefore?.amount) === 0 && Number(arBefore?.returnOffsetAmount) === 0, "零价来源夹具必须是零金额且无退货冲销的历史兼容 AR", arBefore);
  const created = await createReturn(source.billNo, 1, { remark: `${fixturePrefix}-zero-amount-return` });
  const billNo = generatedBill(created, "XSTH", "zero amount return");
  assert(Number(created.data?.document?.totalAmount) === 0 && created.data?.document?.status === "DRAFT", "零价来源允许保存 total=0 的退货草稿", created.data);
  const successAuditBefore = Number(dbScalar(`
    SELECT count(*) FROM public.sys_operation_log
    WHERE target_type='sales_return' AND target_no=${sqlLiteral(billNo)} AND action_code='AUDIT' AND success=TRUE
  `));
  const rejected = await returnAction(billNo, "audit", { expected: 409 });
  const successAuditAfter = Number(dbScalar(`
    SELECT count(*) FROM public.sys_operation_log
    WHERE target_type='sales_return' AND target_no=${sqlLiteral(billNo)} AND action_code='AUDIT' AND success=TRUE
  `));
  assert(rejected.text.includes("金额") && rejected.text.includes("大于 0"), "零金额草稿审核必须以稳定业务原因 409", rejected.text);
  assert(returnDbState("public", billNo)?.status === "DRAFT", "零金额审核失败必须保持草稿状态");
  assert(same(stockState(), stockBefore), "零金额审核失败必须回滚此前尝试的库存回补", { before: stockBefore, after: stockState() });
  assert(same(receivableAnyState("public", source.billNo), arBefore), "零金额审核失败必须保持 AR 完整不变", { before: arBefore, after: receivableAnyState("public", source.billNo) });
  assert(successAuditAfter === successAuditBefore, "零金额审核失败不得留下成功审核日志", { successAuditBefore, successAuditAfter });
  await returnAction(billNo, "delete", { expectPostingHistory: false });
  evidence.guards.zeroAmount = { billNo, totalAmount: 0, auditStatus: rejected.status, stockBefore, arBefore };
  evidence.coverage.zeroAmountRollback = true;
}

async function verifySaveVsSourceConcurrency() {
  const reverseChain = await createSalesChain("CNY");
  const reverseStockBefore = stockState();
  const reverseArBefore = receivableLedgerState("public", reverseChain.outNo);
  assert(reverseArBefore.length === 1 && Number(reverseArBefore[0].amount) > 0, "反审核竞态开始前必须只有一笔普通正应收", reverseArBefore);
  const reverseReturnRemark = `${fixturePrefix}-save-vs-reverse`;
  const [reverseSave, reverseAction] = await Promise.all([
    request(cookies.admin, "/api/sales-returns/draft", {
      method: "POST",
      body: returnPayload(reverseChain.outNo, 0.25, { remark: reverseReturnRemark })
    }),
    request(cookies.admin, `/api/sales-outs/${encodeURIComponent(reverseChain.outNo)}/reverse`, { method: "POST" })
  ]);
  const reverseReturnNo = reverseSave.status === 201
    ? generatedBill(reverseSave, "XSTH", "save-vs-reverse return winner")
    : "";
  if (reverseReturnNo) artifacts.returns.public.push(reverseReturnNo);
  expectStatus("concurrent return save vs source reverse: save", reverseSave, [201, 409]);
  expectStatus("concurrent return save vs source reverse: reverse", reverseAction, [200, 409]);
  const reverseSaveWon = reverseSave.status === 201 && reverseAction.status === 409;
  const reverseWon = reverseSave.status === 409 && reverseAction.status === 200;
  assert(reverseSaveWon || reverseWon, "退货保存与源出库反审核并发必须恰好一方成功、一方 409", {
    save: { status: reverseSave.status, body: reverseSave.text.slice(0, 300) },
    reverse: { status: reverseAction.status, body: reverseAction.text.slice(0, 300) }
  });
  if (reverseSaveWon) {
    assert(businessStatus("public", "sales_out", reverseChain.outNo) === "AUDITED" && returnDbState("public", reverseReturnNo)?.status === "DRAFT", "保存胜出时只能是源已审核 + 退货草稿终态");
    assert(same(stockState(), reverseStockBefore) && same(receivableLedgerState("public", reverseChain.outNo), reverseArBefore), "保存胜出、反审核 409 时库存和完整 AR 台账必须零副作用");
    await returnAction(reverseReturnNo, "delete", { expectPostingHistory: false });
  } else {
    const returnResidue = Number(dbScalar(`SELECT count(*) FROM public.sales_return WHERE remark=${sqlLiteral(reverseReturnRemark)}`));
    assert(businessStatus("public", "sales_out", reverseChain.outNo) === "DRAFT" && !reverseSave.data?.document && returnResidue === 0, "反审核胜出时源只能落 DRAFT，退货保存不得留下单据", { sourceStatus: businessStatus("public", "sales_out", reverseChain.outNo), save: reverseSave.data, returnResidue });
    const reverseArAfter = receivableLedgerState("public", reverseChain.outNo);
    const originalAr = reverseArAfter.find((row) => row.billNo === `YS-${reverseChain.outNo}`);
    const reversingAr = reverseArAfter.find((row) => row.billNo === `YS-CX-${reverseChain.outNo}`);
    assert(
      reverseArAfter.length === 2
        && same(originalAr, reverseArBefore[0])
        && reversingAr?.currency === reverseArBefore[0].currency
        && Number(reversingAr?.amount) === -Number(reverseArBefore[0].amount)
        && Number(reversingAr?.receivedAmount) === 0
        && Number(reversingAr?.returnOffsetAmount) === 0
        && reverseArAfter.reduce((sum, row) => sum + Number(row.amount), 0) === 0
        && reverseArAfter.reduce((sum, row) => sum + Number(row.receivedAmount), 0) === 0
        && reverseArAfter.reduce((sum, row) => sum + Number(row.returnOffsetAmount), 0) === 0,
      "源出库反审核胜出时 AR 必须保留原正项并新增等额负项，净金额/实收/退货冲销均为 0",
      { before: reverseArBefore, after: reverseArAfter }
    );
    assert(same(decimalDelta(stockState(), reverseStockBefore), { onHand: 1, available: 0, reserved: 1 }), "源出库反审核胜出必须完整恢复已发库存并恢复发货通知预留", { before: reverseStockBefore, after: stockState() });
  }

  const redChain = await createSalesChain("CNY");
  const redStockBefore = stockState();
  const redArBefore = receivableLedgerState("public", redChain.outNo);
  const redReturnRemark = `${fixturePrefix}-save-vs-red`;
  const [redSave, redAction] = await Promise.all([
    request(cookies.admin, "/api/sales-returns/draft", {
      method: "POST",
      body: returnPayload(redChain.outNo, 0.25, { remark: redReturnRemark })
    }),
    request(cookies.admin, `/api/sales-outs/${encodeURIComponent(redChain.outNo)}/red-reverse`, {
      method: "POST",
      body: { billDate, ownerName: "A142管理员" }
    })
  ]);
  const redReturnNo = redSave.status === 201
    ? generatedBill(redSave, "XSTH", "save-vs-red return winner")
    : "";
  if (redReturnNo) artifacts.returns.public.push(redReturnNo);
  const redBillNo = redAction.status === 201
    ? generatedBill(redAction, "XSCKD", "save-vs-red red winner")
    : "";
  if (redBillNo) {
    artifacts.salesOuts.push(redBillNo);
    artifacts.redDrafts.push(redBillNo);
  }
  expectStatus("concurrent return save vs source red: save", redSave, [201, 409]);
  expectStatus("concurrent return save vs source red: red", redAction, [201, 409]);
  const redSaveWon = redSave.status === 201 && redAction.status === 409;
  const redWon = redSave.status === 409 && redAction.status === 201;
  assert(redSaveWon || redWon, "退货保存与源出库红冲创建并发必须恰好一方成功、一方 409", {
    save: { status: redSave.status, body: redSave.text.slice(0, 300) },
    red: { status: redAction.status, body: redAction.text.slice(0, 300) }
  });
  if (redSaveWon) {
    const redResidue = Number(dbScalar(`
      SELECT count(*) FROM public.sales_out red
      JOIN public.sales_out source ON source.id=red.red_source_bill_id
      WHERE source.bill_no=${sqlLiteral(redChain.outNo)} AND red.status <> 'VOID'
    `));
    assert(returnDbState("public", redReturnNo)?.status === "DRAFT" && redResidue === 0, "退货保存胜出时只能保留退货草稿，红冲不得留下半成品", { redResidue });
    await returnAction(redReturnNo, "delete", { expectPostingHistory: false });
  } else {
    const returnResidue = Number(dbScalar(`SELECT count(*) FROM public.sales_return WHERE remark=${sqlLiteral(redReturnRemark)}`));
    assert(businessStatus("public", "sales_out", redBillNo) === "DRAFT" && returnResidue === 0, "红冲胜出时只能保留红字草稿，退货保存不得留下半成品", { returnResidue });
    await requireApi(cookies.admin, "delete concurrent red winner", `/api/sales-outs/${encodeURIComponent(redBillNo)}`, { method: "DELETE" });
  }
  assert(same(stockState(), redStockBefore) && same(receivableLedgerState("public", redChain.outNo), redArBefore), "保存/红冲草稿并发无论谁胜出都不得改变库存或完整 AR 台账", { before: { stock: redStockBefore, ar: redArBefore }, after: { stock: stockState(), ar: receivableLedgerState("public", redChain.outNo) } });
  evidence.concurrency.saveVsSource = {
    reverse: { outNo: reverseChain.outNo, saveStatus: reverseSave.status, actionStatus: reverseAction.status, winner: reverseSaveWon ? "return-draft" : "source-reverse", returnNo: reverseReturnNo },
    red: { outNo: redChain.outNo, saveStatus: redSave.status, actionStatus: redAction.status, winner: redSaveWon ? "return-draft" : "red-draft", returnNo: redReturnNo, redBillNo }
  };
  evidence.coverage.saveVsSourceConcurrency = true;
}

async function verifyMainCnyChain(chain) {
  const beforeDraftStock = stockState();
  const beforeAr = receivableState("public", chain.outNo);
  const created = await createReturn(chain.outNo, 0.5, { remark: `${fixturePrefix}-main-cny`, lineRemark: `${fixturePrefix}-main-cny-line` });
  const billNo = generatedBill(created, "XSTH", "CNY main return");
  assert(same(stockState(), beforeDraftStock) && same(receivableState("public", chain.outNo), beforeAr), "CNY 退货草稿必须零库存零财务副作用");
  const audited = await returnAction(billNo, "audit");
  const afterAuditStock = stockState();
  const afterAuditAr = receivableState("public", chain.outNo);
  const expectedAmount = Number(audited.data?.document?.totalAmount);
  assert(audited.data?.document?.currency === "CNY" && expectedAmount > 0, "CNY 退货必须继承 CNY 且原币金额为正", audited.data);
  assert(same(decimalDelta(afterAuditStock, beforeDraftStock), { onHand: 0.5, available: 0.5, reserved: 0 }), "CNY 退货审核只回补现存量和可用量，不恢复预留量", { beforeDraftStock, afterAuditStock });
  assert(Number(afterAuditAr.returnOffsetAmount) === expectedAmount && Number(afterAuditAr.receivedAmount) === 0, "未收来源退货必须全额冲应收且不伪装成收款", afterAuditAr);
  assert(Number(audited.data?.document?.receivableOffsetAmount) === expectedAmount && Number(audited.data?.document?.pendingRefundAmount) === 0, "未收来源必须全冲应收、零待退款", audited.data?.document);

  const auditLogBefore = Number(dbScalar(`SELECT count(*) FROM public.sys_operation_log WHERE target_type='sales_return' AND target_no=${sqlLiteral(billNo)} AND action_code='AUDIT' AND success=TRUE`));
  const idempotent = await returnAction(billNo, "audit");
  const auditLogAfter = Number(dbScalar(`SELECT count(*) FROM public.sys_operation_log WHERE target_type='sales_return' AND target_no=${sqlLiteral(billNo)} AND action_code='AUDIT' AND success=TRUE`));
  assert(idempotent.data?.document?.status === "AUDITED" && same(stockState(), afterAuditStock) && same(receivableState("public", chain.outNo), afterAuditAr), "重复审核必须幂等且不重复库存/财务副作用");
  assert(auditLogAfter === auditLogBefore, "重复审核不得新增成功审核日志", { auditLogBefore, auditLogAfter });
  mainReturn = { billNo, chain, beforeDraftStock, beforeAr, audited: audited.data };
  evidence.finance.unreceived = { billNo, amount: expectedAmount, beforeAr, afterAuditAr };
  evidence.coverage.cnyUnreceived = true;
}

async function verifyUsdFullyReceivedChain(chain) {
  const ar = receivableState("public", chain.outNo);
  const receiptNo = await createReceipt(receiptPayload({
    receivableId: ar.id,
    customerId: fixtureIds.public.customerA,
    accountId: fixtureIds.public.bankUsd,
    currency: "USD",
    amount: Number(ar.amount),
    remark: `${fixturePrefix}-usd-full-receipt`
  }));
  await receiptAction(receiptNo, "audit");
  assert(Number(receivableState("public", chain.outNo).receivedAmount) === Number(ar.amount), "USD 来源必须经正式收款达到全额已收");
  const created = await createReturn(chain.outNo, 1, { remark: `${fixturePrefix}-usd-full-return` });
  const billNo = generatedBill(created, "XSTH", "USD whole-line return");
  const audited = await returnAction(billNo, "audit");
  const amount = Number(audited.data?.document?.totalAmount);
  assert(audited.data?.document?.currency === "USD", "USD 退货必须原币继承且不折算", audited.data);
  assert(Number(audited.data?.document?.receivableOffsetAmount) === 0 && Number(audited.data?.document?.pendingRefundAmount) === amount, "全额收款来源退货必须全额形成待退款", audited.data?.document);
  const reverseBlocked = await receiptAction(receiptNo, "reverse", 409);
  assert(reverseBlocked.text.includes("销售退货"), "已有有效退货分配时收款反审核必须明确 409", reverseBlocked.text);
  await returnAction(billNo, "reverse");
  await receiptAction(receiptNo, "reverse");
  await receiptAction(receiptNo, "delete");
  await returnAction(billNo, "delete", { expectPostingHistory: true });
  evidence.finance.fullyReceived = { billNo, receiptNo, currency: "USD", amount, reverseGuardStatus: 409 };
  evidence.coverage.usdFullyReceived = true;
}

async function verifyPartiallyReceived(source) {
  const ar = receivableState("public", source.billNo);
  const receiptAmount = Number(ar.amount) / 2;
  const receiptNo = await createReceipt(receiptPayload({
    receivableId: ar.id,
    customerId: fixtureIds.public.customerA,
    accountId: fixtureIds.public.bankCny,
    currency: "CNY",
    amount: receiptAmount,
    remark: `${fixturePrefix}-partial-receipt`
  }));
  await receiptAction(receiptNo, "audit");
  const created = await createReturn(source.billNo, 1.5, { remark: `${fixturePrefix}-partial-return` });
  const billNo = generatedBill(created, "XSTH", "partially received return");
  const audited = await returnAction(billNo, "audit");
  const amount = Number(audited.data?.document?.totalAmount);
  const offset = Number(audited.data?.document?.receivableOffsetAmount);
  const pending = Number(audited.data?.document?.pendingRefundAmount);
  assert(offset === receiptAmount && pending === amount - receiptAmount && offset + pending === amount, "部分收款来源必须精确拆分冲应收与待退款", { amount, offset, pending, receiptAmount });
  assert(Number(receivableState("public", source.billNo).receivedAmount) === receiptAmount, "退货审核不得改写真实 received_amount");
  const selector = await list(cookies.admin, "sales-out-return-source-selector", { keyword: source.billNo });
  expectStatus("selector after partial return", selector, 200);
  const row = rowsFrom(selector).find((item) => item.billNo === source.billNo);
  assert(Number(row?.returnedQty) === 1.5 && Number(row?.remainingQty) === 0.5, "来源选择器必须展示正式已退量与剩余可退量", row);
  await returnAction(billNo, "reverse");
  await returnAction(billNo, "delete", { expectPostingHistory: true });
  await receiptAction(receiptNo, "reverse");
  await receiptAction(receiptNo, "delete");
  evidence.finance.partiallyReceived = { billNo, receiptNo, amount, offset, pending, selectorRow: row };
  evidence.coverage.partiallyReceived = true;
}

async function verifyConcurrentReturnAudit(source) {
  const first = await createReturn(source.billNo, 0.75, { remark: `${fixturePrefix}-race-first` });
  const second = await createReturn(source.billNo, 0.75, { remark: `${fixturePrefix}-race-second` });
  const firstNo = generatedBill(first, "XSTH", "race first return");
  const secondNo = generatedBill(second, "XSTH", "race second return");
  const before = {
    stock: stockState(),
    ar: receivableState("public", source.billNo)
  };
  const responses = await Promise.all([
    request(cookies.admin, `/api/sales-returns/${encodeURIComponent(firstNo)}/audit`, { method: "POST" }),
    request(cookies.admin, `/api/sales-returns/${encodeURIComponent(secondNo)}/audit`, { method: "POST" })
  ]);
  const statuses = responses.map((response) => response.status).sort((a, b) => a - b);
  assert(same(statuses, [200, 409]), "两个竞争草稿审核同一来源时必须恰好一个成功、一个 409", { statuses, bodies: responses.map((row) => row.text.slice(0, 300)) });
  const winner = responses[0].status === 200 ? firstNo : secondNo;
  const loser = winner === firstNo ? secondNo : firstNo;
  const after = {
    stock: stockState(),
    ar: receivableState("public", source.billNo),
    winner: returnDbState("public", winner),
    loser: returnDbState("public", loser)
  };
  assert(after.winner?.status === "AUDITED" && after.loser?.status === "DRAFT", "并发审核失败方必须保持完整草稿", after);
  assert(same(decimalDelta(after.stock, before.stock), { onHand: 0.75, available: 0.75, reserved: 0 }), "并发审核只能产生一次库存回补", { before, after });
  assert(Number(after.ar.returnOffsetAmount) === Number(after.winner.totalAmount), "并发审核只能产生一次应收冲销", after);
  await returnAction(winner, "reverse");
  await returnAction(winner, "delete", { expectPostingHistory: true });
  await returnAction(loser, "delete", { expectPostingHistory: false });
  evidence.concurrency.returnAudit = { firstNo, secondNo, statuses, winner, loser, before, after };
  evidence.coverage.concurrentReturnAudit = true;
}

async function verifyArLockConcurrency(source) {
  const ar = receivableState("public", source.billNo);
  const receiptNo = await createReceipt(receiptPayload({
    receivableId: ar.id,
    customerId: fixtureIds.public.customerA,
    accountId: fixtureIds.public.bankCny,
    currency: "CNY",
    amount: Number(ar.amount) / 2,
    remark: `${fixturePrefix}-ar-lock-race`
  }));
  const created = await createReturn(source.billNo, 0.5, { remark: `${fixturePrefix}-ar-lock-return` });
  const returnNo = generatedBill(created, "XSTH", "AR lock return");
  const [receiptAudit, returnAudit] = await Promise.all([
    request(cookies.admin, `/api/finance/receipts/${encodeURIComponent(receiptNo)}/audit`, { method: "POST" }),
    request(cookies.admin, `/api/sales-returns/${encodeURIComponent(returnNo)}/audit`, { method: "POST" })
  ]);
  expectStatus("concurrent receipt audit", receiptAudit, 200);
  expectStatus("concurrent return audit", returnAudit, 200);
  const finalAr = receivableState("public", source.billNo);
  const finalReturn = returnDbState("public", returnNo);
  assert(
    Number(finalAr.receivedAmount) + Number(finalAr.returnOffsetAmount) === Number(finalAr.amount)
      && Number(finalReturn.offsetAmount) === Number(finalReturn.totalAmount)
      && Number(finalReturn.pendingRefundAmount) === 0,
    "收款审核与退货审核必须按同一 AR 锁串行并基于最新余额落账",
    { finalAr, finalReturn }
  );
  await receiptAction(receiptNo, "reverse", 409);
  await returnAction(returnNo, "reverse");
  await receiptAction(receiptNo, "reverse");
  await returnAction(returnNo, "delete", { expectPostingHistory: true });
  await receiptAction(receiptNo, "delete");
  evidence.concurrency.arLock = { receiptNo, returnNo, receiptStatus: receiptAudit.status, returnStatus: returnAudit.status, finalAr, finalReturn };
  evidence.coverage.arLockConcurrency = true;
}

async function verifyLifoReverseGuard(source) {
  const first = await createReturn(source.billNo, 0.5, { remark: `${fixturePrefix}-lifo-first` });
  const second = await createReturn(source.billNo, 0.5, { remark: `${fixturePrefix}-lifo-second` });
  const firstNo = generatedBill(first, "XSTH", "LIFO first return");
  const secondNo = generatedBill(second, "XSTH", "LIFO second return");
  await returnAction(firstNo, "audit");
  await new Promise((resolve) => setTimeout(resolve, 5));
  await returnAction(secondNo, "audit");
  const blocked = await returnAction(firstNo, "reverse", { expected: 409 });
  assert(blocked.text.includes("后续") || blocked.text.includes("先反审核"), "较早退货越过后续退货反审核必须给出 LIFO 原因", blocked.text);
  assert(returnDbState("public", firstNo)?.status === "AUDITED" && returnDbState("public", secondNo)?.status === "AUDITED", "LIFO 409 必须保持两张退货已审核状态");
  await returnAction(secondNo, "reverse");
  await returnAction(firstNo, "reverse");
  await returnAction(secondNo, "delete", { expectPostingHistory: true });
  await returnAction(firstNo, "delete", { expectPostingHistory: true });
  evidence.guards.lifo = { firstNo, secondNo, blockedStatus: blocked.status };
  evidence.coverage.lifo = true;
}

async function verifyRedAndSourceGuards(sources) {
  const redDraft = await requireApi(cookies.admin, "create red sales out draft", `/api/sales-outs/${encodeURIComponent(sources.red.billNo)}/red-reverse`, {
    expected: 201,
    body: { billDate, ownerName: "A142管理员" }
  });
  const redBillNo = generatedBill(redDraft, "XSCKD", "red sales out");
  artifacts.redDrafts.push(redBillNo);
  artifacts.salesOuts.push(redBillNo);
  const redBlocked = await request(cookies.admin, "/api/sales-returns/draft", { method: "POST", body: returnPayload(sources.red.billNo, 0.25, { remark: `${fixturePrefix}-red-blocked` }) });
  expectStatus("red source cannot return", redBlocked, 409);
  assert(redBlocked.text.includes("红字") || redBlocked.text.includes("红冲"), "已有非作废红字来源必须给出红字互斥原因", redBlocked.text);
  await requireApi(cookies.admin, "delete red draft", `/api/sales-outs/${encodeURIComponent(redBillNo)}`, { method: "DELETE" });

  const guardDraft = await createReturn(sources.guard.billNo, 0.25, { remark: `${fixturePrefix}-source-guard` });
  const guardNo = generatedBill(guardDraft, "XSTH", "source guard return");
  const reverseBlocked = await requireApi(cookies.admin, "source reverse blocked by non-void return", `/api/sales-outs/${encodeURIComponent(sources.guard.billNo)}/reverse`, { expected: 409 });
  const createRedBlocked = await requireApi(cookies.admin, "source red blocked by non-void return", `/api/sales-outs/${encodeURIComponent(sources.guard.billNo)}/red-reverse`, {
    expected: 409,
    body: { billDate, ownerName: "A142管理员" }
  });
  assert(reverseBlocked.text.includes("销售退货") && createRedBlocked.text.includes("销售退货"), "已有非 VOID 退货必须同时阻断源出库反审核与红冲", { reverse: reverseBlocked.text, red: createRedBlocked.text });
  await returnAction(guardNo, "delete", { expectPostingHistory: false });
  evidence.guards.red = { redBillNo, redBlocked: redBlocked.status, guardNo, sourceReverse: reverseBlocked.status, sourceRed: createRedBlocked.status };
  evidence.coverage.redSourceConflict = true;
}

async function verifyInventoryAndRefundGuards(source) {
  const ar = receivableState("public", source.billNo);
  const receiptNo = await createReceipt(receiptPayload({
    receivableId: ar.id,
    customerId: fixtureIds.public.customerA,
    accountId: fixtureIds.public.bankCny,
    currency: "CNY",
    amount: Number(ar.amount),
    remark: `${fixturePrefix}-inventory-guard-full-receipt`
  }));
  await receiptAction(receiptNo, "audit");
  const created = await createReturn(source.billNo, 1, { remark: `${fixturePrefix}-inventory-refund-guards` });
  const billNo = generatedBill(created, "XSTH", "inventory guard return");
  const audited = await returnAction(billNo, "audit");
  assert(Number(audited.data?.document?.receivableOffsetAmount) === 0 && Number(audited.data?.document?.pendingRefundAmount) === Number(audited.data?.document?.totalAmount), "退款消费守卫夹具必须先形成全额待退款事实", audited.data?.document);
  const afterAudit = stockSnapshot(codes.isolatedWarehouse);
  assert(Number(afterAudit?.state?.onHand) === 1 && Number(afterAudit?.state?.available) === 1, "独立库存守卫仓审核后必须精确回补 1", afterAudit);
  dbScalar(`
    UPDATE public.inv_stock_balance b
    SET qty_on_hand=0, qty_available=0, updated_at=clock_timestamp(), version=b.version+1
    FROM public.md_product p, public.md_warehouse w, public.sys_account_set a
    WHERE b.product_id=p.id AND b.warehouse_id=w.id AND b.account_set_id=a.id
      AND p.code='CP-001' AND w.code=${sqlLiteral(codes.isolatedWarehouse)} AND a.code='BLD-TEST'
      AND b.qty_on_hand=1 AND b.qty_available=1
  `);
  const insufficient = await returnAction(billNo, "reverse", { expected: 409 });
  assert(returnDbState("public", billNo)?.status === "AUDITED", "库存不足反审核 409 必须保持退货已审核");
  dbScalar(`
    UPDATE public.inv_stock_balance b
    SET qty_on_hand=${sqlLiteral(afterAudit.balance.qty_on_hand)}::numeric,
        qty_available=${sqlLiteral(afterAudit.balance.qty_available)}::numeric,
        qty_reserved=${sqlLiteral(afterAudit.balance.qty_reserved)}::numeric,
        unit_cost=${nullableSql(afterAudit.balance.unit_cost)},
        amount=${nullableSql(afterAudit.balance.amount)},
        updated_at=${nullableSql(afterAudit.balance.updated_at, "timestamptz")},
        version=${sqlLiteral(afterAudit.balance.version)}::bigint
    WHERE b.id=${sqlLiteral(afterAudit.balance.id)}::uuid AND b.qty_on_hand=0 AND b.qty_available=0
  `);
  dbScalar(`
    UPDATE public.sales_return_finance_allocation a
    SET refunded_amount=1, updated_at=clock_timestamp()
    FROM public.sales_return sr
    WHERE a.sales_return_id=sr.id AND sr.bill_no=${sqlLiteral(billNo)} AND a.refunded_amount=0
  `);
  const refunded = await returnAction(billNo, "reverse", { expected: 409 });
  assert(refunded.text.includes("退款") && returnDbState("public", billNo)?.status === "AUDITED", "待退款已消费时反审核必须 409 且保持已审核", refunded.text);
  dbScalar(`
    UPDATE public.sales_return_finance_allocation a
    SET refunded_amount=0, updated_at=clock_timestamp()
    FROM public.sales_return sr
    WHERE a.sales_return_id=sr.id AND sr.bill_no=${sqlLiteral(billNo)} AND a.refunded_amount=1
  `);
  await returnAction(billNo, "reverse");
  await returnAction(billNo, "delete", { expectPostingHistory: true });
  await receiptAction(receiptNo, "reverse");
  await receiptAction(receiptNo, "delete");
  evidence.guards.inventoryAndRefund = { billNo, receiptNo, insufficientStatus: insufficient.status, refundedStatus: refunded.status };
  evidence.coverage.inventoryAndRefundGuards = true;
}

async function verifyVoid(source) {
  const created = await createReturn(source.billNo, 0.25, { cookie: cookies.warehouse, remark: `${fixturePrefix}-void` });
  const billNo = generatedBill(created, "XSTH", "void return");
  const response = await requireApi(cookies.warehouse, "void sales return", `/api/document-lifecycle/salesReturn/${encodeURIComponent(billNo)}/void`, {
    body: { reason: `${fixturePrefix}-void-reason`, username: users.warehouse.username, password: users.warehouse.password }
  });
  assert(response.data?.status === "VOID" && returnDbState("public", billNo)?.status === "VOID", "销售退货作废必须走统一受控作废并落 VOID", response.data);
  evidence.lifecycle.void = { billNo, status: response.status };
  evidence.coverage.void = true;
}

function insertSameNumberReturn(schema, source, customerCode, currency, qty) {
  const t = (name) => schemaTable(schema, name);
  dbScalar(`
    BEGIN;
    INSERT INTO ${t("sales_return")} (
      bill_no, customer_id, bill_date, status, total_amount, currency, owner_name, remark, version
    ) SELECT
      ${sqlLiteral(codes.sameReturn)}, c.id, DATE ${sqlLiteral(billDate)}, 'DRAFT',
      round(${sqlLiteral(qty)}::numeric * sol.unit_price, 2)
        + round(round(${sqlLiteral(qty)}::numeric * sol.unit_price, 2) * sol.tax_rate / 100, 2),
      ${sqlLiteral(currency)}, ${sqlLiteral(`A142-${schema}`)}, ${sqlLiteral(`${fixturePrefix}-same-return-${schema}`)}, 0
    FROM ${t("md_customer")} c
    JOIN ${t("sales_out")} so ON so.bill_no=${sqlLiteral(source.billNo)} AND so.customer_id=c.id
    JOIN ${t("sales_out_line")} sol ON sol.bill_id=so.id AND sol.line_no=1
    WHERE c.code=${sqlLiteral(customerCode)};
    INSERT INTO ${t("sales_return_line")} (
      bill_id, line_no, source_out_line_id, source_out_no, source_line_no,
      product_id, product_code_snapshot, product_name_snapshot, product_spec_snapshot,
      product_unit_snapshot, net_weight_snapshot, gross_weight_snapshot, warehouse_id,
      qty, unit_price, amount, tax_rate, tax_amount, price_tax_total, line_remark
    ) SELECT
      sr.id, 1, sol.id, so.bill_no, sol.line_no,
      sol.product_id, COALESCE(sol.product_code_snapshot,p.code), COALESCE(sol.product_name_snapshot,p.name), COALESCE(sol.product_spec_snapshot,p.spec),
      COALESCE(sol.product_unit_snapshot,p.unit), COALESCE(sol.net_weight_snapshot,p.net_weight), COALESCE(sol.gross_weight_snapshot,p.gross_weight), sol.warehouse_id,
      ${sqlLiteral(qty)}::numeric, sol.unit_price,
      round(${sqlLiteral(qty)}::numeric * sol.unit_price, 2), sol.tax_rate,
      round(round(${sqlLiteral(qty)}::numeric * sol.unit_price, 2) * sol.tax_rate / 100, 2),
      round(${sqlLiteral(qty)}::numeric * sol.unit_price, 2)
        + round(round(${sqlLiteral(qty)}::numeric * sol.unit_price, 2) * sol.tax_rate / 100, 2),
      ${sqlLiteral(`${fixturePrefix}-same-line-${schema}`)}
    FROM ${t("sales_return")} sr
    JOIN ${t("sales_out")} so ON so.bill_no=${sqlLiteral(source.billNo)}
    JOIN ${t("sales_out_line")} sol ON sol.bill_id=so.id AND sol.line_no=1
    JOIN ${t("md_product")} p ON p.id=sol.product_id
    WHERE sr.bill_no=${sqlLiteral(codes.sameReturn)};
    COMMIT;
  `);
  (schema === "public" ? artifacts.returns.public : artifacts.returns.replay).push(codes.sameReturn);
}

async function verifyTenantIsolation(publicSource, replaySource) {
  insertSameNumberReturn("public", publicSource, codes.customerA, "CNY", 0.25);
  insertSameNumberReturn(replayTenant.schemaName, replaySource, codes.customerB, "USD", 0.5);
  const publicDetail = await returnAction(codes.sameReturn, "detail", { cookie: cookies.admin, schema: "public" });
  const replayDetail = await returnAction(codes.sameReturn, "detail", { cookie: cookies.replayAdmin, schema: "replay" });
  assert(
    publicDetail.data?.document?.customerCode === codes.customerA
      && publicDetail.data?.document?.currency === "CNY"
      && Number(publicDetail.data?.lines?.[0]?.qty) === 0.25,
    "public 同号退货必须命中 public 客户/CNY/数量事实",
    publicDetail.data
  );
  assert(
    replayDetail.data?.document?.customerCode === codes.customerB
      && replayDetail.data?.document?.currency === "USD"
      && Number(replayDetail.data?.lines?.[0]?.qty) === 0.5,
    "tenant 同号退货必须命中 tenant 客户/USD/数量事实",
    replayDetail.data
  );
  const [publicList, replayList] = await Promise.all([
    list(cookies.admin, "sales-return-form-list", { keyword: codes.sameReturn }),
    list(cookies.replayAdmin, "sales-return-form-list", { keyword: codes.sameReturn })
  ]);
  expectStatus("public same-number list", publicList, 200);
  expectStatus("tenant same-number list", replayList, 200);
  assert(rowsFrom(publicList).length === 1 && rowsFrom(replayList).length === 1, "双账套同号列表必须各返回且只返回本租户一张", { public: rowsFrom(publicList), replay: rowsFrom(replayList) });
  await returnAction(codes.sameReturn, "delete", { cookie: cookies.admin, schema: "public", expectPostingHistory: false });
  await returnAction(codes.sameReturn, "delete", { cookie: cookies.replayAdmin, schema: "replay", expectPostingHistory: false });
  evidence.tenantIsolation = {
    billNo: codes.sameReturn,
    public: publicDetail.data,
    replay: replayDetail.data,
    listCounts: [rowsFrom(publicList).length, rowsFrom(replayList).length]
  };
  evidence.coverage.tenantIsolation = true;
}

async function verifyListsAndOutput() {
  assert(mainReturn?.billNo, "列表/输出验收前必须保留一张已审核主退货单");
  const billNo = mainReturn.billNo;
  const header = await list(cookies.admin, "sales-return-form-list", { keyword: billNo, view: "header" });
  const detail = await list(cookies.admin, "sales-return-form-list", { keyword: billNo, view: "detail" });
  expectStatus("sales return header list", header, 200);
  expectStatus("sales return detail list", detail, 200);
  const headerRow = rowsFrom(header).find((row) => row.billNo === billNo);
  const detailRow = rowsFrom(detail).find((row) => row.billNo === billNo);
  assert(
    headerRow?.currency === "CNY"
      && Number(headerRow?.qty) === 0.5
      && Number(headerRow?.receivableOffsetAmount) > 0
      && Number(headerRow?.pendingRefundAmount) === 0,
    "正式整单列表必须返回币种、冲应收和待退款摘要",
    headerRow
  );
  assert(
    detailRow?.sourceBillNo === mainReturn.chain.outNo
      && Number(detailRow?.sourceLineNo) === 1
      && Number(detailRow?.qty) === 0.5
      && detailRow?.productCode === "CP-001",
    "正式明细列表必须返回来源追溯和物料明细",
    detailRow
  );
  const selector = await list(cookies.admin, "sales-out-return-source-selector", { keyword: mainReturn.chain.outNo });
  expectStatus("sales return source selector", selector, 200);
  const selectorRow = rowsFrom(selector).find((row) => row.billNo === mainReturn.chain.outNo);
  assert(Number(selectorRow?.returnedQty) === 0.5 && Number(selectorRow?.remainingQty) === 0.5, "选择器必须按已审核退货计算正式剩余可退量", selectorRow);
  const receivableSelector = await list(cookies.admin, "ar-receivable-settlement-source-selector", { keyword: mainReturn.chain.outNo });
  expectStatus("A141 receivable selector after return offset", receivableSelector, 200);
  const receivableRow = rowsFrom(receivableSelector).find((row) => row.sourceBillNo === mainReturn.chain.outNo);
  const ar = receivableState("public", mainReturn.chain.outNo);
  assert(
    Number(receivableRow?.returnOffsetAmount) === Number(ar.returnOffsetAmount)
      && Number(receivableRow?.unsettledAmount) === Number(ar.amount) - Number(ar.receivedAmount) - Number(ar.returnOffsetAmount),
    "A141 收款来源选择器必须从实时未收余额扣除销售退货 return_offset",
    { receivableRow, ar }
  );

  const outputPaths = {
    csv: `/api/documents/sales-return/${encodeURIComponent(billNo)}/export.csv`,
    html: `/api/documents/sales-return/${encodeURIComponent(billNo)}/print.html`,
    pdf: `/api/documents/sales-return/${encodeURIComponent(billNo)}/print.pdf`
  };
  const outputResponses = {};
  const outputPermissions = {};
  for (const [role, cookie, expected] of [
    ["anonymous", "", 401],
    ["low", cookies.low, 403],
    ["warehouse", cookies.warehouse, 200],
    ["admin", cookies.admin, 200]
  ]) {
    const responses = Object.fromEntries(await Promise.all(Object.entries(outputPaths).map(async ([format, pathname]) => [format, await request(cookie, pathname)])));
    outputResponses[role] = responses;
    outputPermissions[role] = {};
    for (const [format, response] of Object.entries(responses)) {
      expectStatus(`sales return ${format.toUpperCase()} output as ${role}`, response, expected);
      outputPermissions[role][format] = response.status;
    }
  }
  const { csv, html, pdf } = outputResponses.admin;
  assert(csv.text.includes("销售退货单") && csv.text.includes(billNo) && csv.text.includes(mainReturn.chain.outNo), "CSV 引出必须包含正式名称、单号和来源追溯", csv.text.slice(0, 500));
  const csvDetail = csv.text.split(/\r?\n/).find((row) => row.includes(mainReturn.chain.outNo) && row.includes("CP-001"));
  assert(csvDetail && parseCsvRow(csvDetail)[6] === "0.5", "CSV 引出必须保留主退货分数数量 0.5，不能格式化为 1", csvDetail);
  assert(html.text.includes("销售退货单") && html.text.includes(billNo), "打印 HTML 必须包含正式名称和单号");
  assert(pdf.text.startsWith("%PDF"), "打印 PDF 必须返回 PDF 字节签名", pdf.text.slice(0, 20));
  evidence.lists = { billNo, header: headerRow, detail: detailRow, selector: selectorRow, receivableSelector: receivableRow, outputPermissions };
  evidence.coverage.outputPermissions = true;
  evidence.coverage.listsSelectorsOutput = true;
}

function assertNoPageOverflow(data, label) {
  assert(data.scrollWidth <= data.clientWidth + 1 && data.bodyWidth <= data.clientWidth + 1, `${label} 不得出现页面级横向溢出`, data);
}

async function pageOverflow(page) {
  return page.evaluate(() => ({
    clientWidth: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
    bodyWidth: document.body.scrollWidth
  }));
}

async function verifyBrowser(source) {
  browser = await chromium.launch({ headless: true });
  const context1366 = await browser.newContext({ viewport: { width: 1366, height: 768 }, acceptDownloads: true });
  const page = await context1366.newPage();
  await page.goto(frontendUrl, { waitUntil: "networkidle" });
  await loginAs(page, users.warehouse.username, users.warehouse.password, users.warehouse.label, "BLD-TEST");
  await page.getByTestId("module-销售管理").hover();
  await page.getByTestId("entry-sales-return-form").click();
  await page.getByTestId("sales-return-party-code").waitFor({ state: "visible", timeout: 10000 });
  await page.getByRole("heading", { name: "销售退货单", exact: true }).waitFor({ state: "visible", timeout: 10000 });
  await page.getByTestId("sales-return-open-source-selector").click();
  await page.getByTestId("sales-return-source-selector-dialog").waitFor({ state: "visible", timeout: 10000 });
  await page.getByTestId("sales-return-source-selector-search").fill(source.billNo);
  await page.getByTestId("sales-return-source-selector-query").click();
  const checkbox = page.getByTestId(`sales-return-source-line-${source.billNo}:1`);
  await checkbox.waitFor({ state: "visible", timeout: 10000 });
  await checkbox.check();
  await page.getByTestId("sales-return-source-selector-ok").click();
  await page.getByTestId("sales-return-line-product").waitFor({ state: "visible", timeout: 10000 });
  for (const testId of ["sales-return-line-product", "sales-return-line-warehouse", "sales-return-line-price", "sales-return-line-tax-rate"]) {
    assert(await page.getByTestId(testId).isDisabled(), `来源锁定字段 ${testId} 必须禁用`);
  }
  assert(!(await page.getByTestId("sales-return-line-qty").isDisabled()) && !(await page.getByTestId("sales-return-line-remark").isDisabled()), "草稿只允许编辑退货数量和行备注");
  assert(await page.getByTestId("sales-return-currency").inputValue() === "CNY", "浏览器选源后币种必须只读继承 CNY");
  const saveRequestPromise = page.waitForRequest((request) => request.url().endsWith("/api/sales-returns/draft") && request.method() === "POST");
  await page.getByTestId("save-sales-order").click();
  const saveRequest = await saveRequestPromise;
  const saveBody = saveRequest.postDataJSON();
  assert(same(Object.keys(saveBody).sort(), ["billDate", "lines", "remark"].sort()), "浏览器首存头载荷必须保持窄序列化", saveBody);
  assert(saveBody.lines.length === 1 && same(Object.keys(saveBody.lines[0]).sort(), ["sourceOutNo", "sourceLineNo", "qty", "lineRemark"].sort()), "浏览器首存行载荷只允许来源、数量和备注", saveBody.lines);
  await page.waitForFunction(() => {
    const input = document.querySelector('[data-testid="sales-return-bill-no"]');
    return input instanceof HTMLInputElement && /^XSTH\d{6}$/.test(input.value);
  }, undefined, { timeout: 10000 });
  const billNo = await page.getByTestId("sales-return-bill-no").inputValue();
  artifacts.returns.public.push(billNo);
  await page.getByTestId("sales-return-remark").fill(`${fixturePrefix}-browser-second-save`);
  const secondSaveRequestPromise = page.waitForRequest((request) => request.url().endsWith("/api/sales-returns/draft") && request.method() === "POST");
  const secondSaveResponsePromise = page.waitForResponse((response) => response.url().endsWith("/api/sales-returns/draft") && response.request().method() === "POST");
  const secondReloadResponsePromise = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return url.pathname === `/api/sales-returns/${billNo}` && response.request().method() === "GET";
  });
  await page.getByTestId("save-sales-order").click();
  const [secondSaveRequest, secondSaveResponse, secondReloadResponse] = await Promise.all([
    secondSaveRequestPromise,
    secondSaveResponsePromise,
    secondReloadResponsePromise
  ]);
  assert(secondSaveResponse.status() === 201, "浏览器二次草稿保存必须等待 201 完成后再跳转列表", { status: secondSaveResponse.status(), body: await secondSaveResponse.text() });
  assert(secondReloadResponse.status() === 200, "浏览器二次草稿保存后必须重新读取正式详情", { status: secondReloadResponse.status(), body: await secondReloadResponse.text() });
  const secondSaveBody = secondSaveRequest.postDataJSON();
  assert(same(Object.keys(secondSaveBody).sort(), ["billNo", "version", "billDate", "remark", "lines"].sort()), "浏览器二次草稿保存只允许增加 billNo/version CAS 字段", secondSaveBody);
  assert(secondSaveBody.billNo === billNo && /^(0|[1-9]\d*)$/.test(String(secondSaveBody.version)), "浏览器二次保存必须提交同单号和规范字符串 version", secondSaveBody);
  assert(same(Object.keys(secondSaveBody.lines[0]).sort(), ["sourceOutNo", "sourceLineNo", "qty", "lineRemark"].sort()), "浏览器二次保存行载荷仍须保持窄序列化", secondSaveBody.lines);
  const sourceTrace = page.getByTestId("sales-return-line-source-order-no-open");
  await sourceTrace.first().waitFor({ state: "visible", timeout: 10000 });
  const sourceTraceTexts = (await sourceTrace.allTextContents()).map((value) => value.trim());
  assert(sourceTraceTexts.length >= 1 && sourceTraceTexts.every((value) => value === source.billNo), "保存后必须保留源销售出库单追溯入口", { expected: source.billNo, actual: sourceTraceTexts });
  const overflow1366 = await pageOverflow(page);
  assertNoPageOverflow(overflow1366, "销售退货表单 1366x768");
  const formScreenshot = `a142-sales-return-1366x768-${runId}.png`;
  await page.screenshot({ path: path.join(screenshotDir, formScreenshot), fullPage: true });
  evidence.screenshots.push(`verification/playwright/${formScreenshot}`);

  await page.getByTestId("module-销售管理").hover();
  await page.getByTestId("query-sales-return-form").click();
  await page.getByTestId("list-page-sales-return-form-list").waitFor({ state: "visible", timeout: 10000 });
  await page.getByTestId("list-keyword").fill(billNo);
  await page.getByTestId("list-keyword").press("Enter");
  await page.getByTestId(`open-document-${billNo}`).waitFor({ state: "visible", timeout: 10000 });
  const reopenLockAcquireResponsePromise = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return url.pathname === `/api/document-locks/salesReturn/${billNo}/acquire`
      && response.request().method() === "POST";
  });
  await page.getByTestId(`open-document-${billNo}`).click();
  const reopenLockAcquireResponse = await reopenLockAcquireResponsePromise;
  assert(reopenLockAcquireResponse.status() === 200, "从列表重开销售退货草稿必须等待编辑锁取得成功", {
    status: reopenLockAcquireResponse.status(),
    body: await reopenLockAcquireResponse.text()
  });
  await page.getByTestId("sales-return-party-code").waitFor({ state: "visible", timeout: 10000 });
  assert(await page.getByTestId("sales-return-bill-no").inputValue() === billNo && Number(await page.getByTestId("sales-return-line-qty").inputValue()) === 1, "首次保存后从列表重开必须恢复同一草稿和来源行");
  cookies.warehouse = (await context1366.cookies()).map((cookie) => `${cookie.name}=${cookie.value}`).join("; ");
  const warehouseLockRelease = await request(cookies.warehouse, `/api/document-locks/salesReturn/${encodeURIComponent(billNo)}`, { method: "DELETE" });
  expectStatus("WAREHOUSE release browser sales return lock", warehouseLockRelease, 200);
  assert(warehouseLockRelease.data?.released === true, "浏览器验收结束必须由 WAREHOUSE 正式释放自己持有的销售退货编辑锁", warehouseLockRelease.data);
  await context1366.close();

  const context1920 = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
  const wide = await context1920.newPage();
  await wide.goto(frontendUrl, { waitUntil: "networkidle" });
  await loginAs(wide, users.admin.username, users.admin.password, users.admin.label, "BLD-TEST");
  await wide.getByTestId("module-销售管理").hover();
  await wide.getByTestId("query-sales-return-form").click();
  await wide.getByTestId("list-page-sales-return-form-list").waitFor({ state: "visible", timeout: 10000 });
  await wide.getByTestId("list-keyword").fill(mainReturn.billNo);
  await wide.getByTestId("list-keyword").press("Enter");
  await wide.getByTestId(`open-document-${mainReturn.billNo}`).waitFor({ state: "visible", timeout: 10000 });
  const toggleBefore = (await wide.getByTestId("list-detail-view-toggle").innerText()).trim();
  await wide.getByTestId("list-detail-view-toggle").click();
  const toggleAfter = (await wide.getByTestId("list-detail-view-toggle").innerText()).trim();
  assert(toggleBefore !== toggleAfter, "销售退货列表必须可切换整单/明细视图", { toggleBefore, toggleAfter });
  await wide.getByTestId("column-settings").click();
  await wide.getByTestId("column-settings-dialog").waitFor({ state: "visible", timeout: 10000 });
  await wide.getByTestId("column-settings-ok").click();
  const overflow1920 = await pageOverflow(wide);
  assertNoPageOverflow(overflow1920, "销售退货列表 1920x1080");
  const listScreenshot = `a142-sales-return-list-1920x1080-${runId}.png`;
  await wide.screenshot({ path: path.join(screenshotDir, listScreenshot), fullPage: true });
  evidence.screenshots.push(`verification/playwright/${listScreenshot}`);
  await context1920.close();

  const lowContext = await browser.newContext({ viewport: { width: 1366, height: 768 } });
  const lowPage = await lowContext.newPage();
  await lowPage.goto(frontendUrl, { waitUntil: "networkidle" });
  await loginAs(lowPage, users.low.username, users.low.password, users.low.label, "BLD-TEST");
  const salesModule = lowPage.getByTestId("module-销售管理");
  assert(await salesModule.isVisible(), "低权限角色保留销售订单权限时必须仍可见销售模块");
  await salesModule.hover();
  assert(await lowPage.getByTestId("entry-sales-return-form").count() === 0 && await lowPage.getByTestId("query-sales-return-form").count() === 0, "无 sales.out.audit 角色必须隐藏销售退货新增和查询入口");
  await lowContext.close();
  await browser.close();
  browser = null;
  // Browser login rotates the same user's single active session. Refresh the
  // API cookie before lifecycle closure and failure-safe cleanup.
  cookies.admin = await loginApi(apiBase, users.admin.username, users.admin.password, "BLD-TEST");
  evidence.browser = [
    { viewport: "1366x768", billNo, saveBody, secondSaveBody, overflow: overflow1366, screenshot: `verification/playwright/${formScreenshot}` },
    { viewport: "1920x1080", billNo: mainReturn.billNo, toggleBefore, toggleAfter, overflow: overflow1920, screenshot: `verification/playwright/${listScreenshot}` },
    { role: "low", entryVisible: false, queryVisible: false }
  ];
  evidence.coverage.browser = true;
}

async function closeMainReturn() {
  assert(mainReturn?.billNo, "主 CNY 退货不存在");
  const stockBeforeReverse = stockState();
  await returnAction(mainReturn.billNo, "reverse");
  const stockAfterReverse = stockState();
  assert(same(decimalDelta(stockAfterReverse, stockBeforeReverse), { onHand: -0.5, available: -0.5, reserved: 0 }), "CNY 退货反审核必须只精确扣回本单回补的现存量和可用量", { before: stockBeforeReverse, after: stockAfterReverse });
  assert(same(receivableState("public", mainReturn.chain.outNo), mainReturn.beforeAr), "CNY 退货反审核必须精确恢复应收冲销且不改真实收款", { expected: mainReturn.beforeAr, actual: receivableState("public", mainReturn.chain.outNo) });
  await returnAction(mainReturn.billNo, "delete", { expectPostingHistory: true });
  evidence.lifecycle.mainReverse = { billNo: mainReturn.billNo, stockBeforeReverse, stockAfterReverse, delta: decimalDelta(stockAfterReverse, stockBeforeReverse), receivable: receivableState("public", mainReturn.chain.outNo) };
  evidence.coverage.reverseRestoration = true;
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
  const success = rows.filter((row) => row.success && row.targetType === "sales_return");
  const actions = new Set(success.map((row) => row.action));
  for (const action of ["CREATE_DRAFT", "UPDATE_DRAFT", "AUDIT", "REVERSE", "DELETE", "VOID"]) {
    assert(actions.has(action), `销售退货操作日志必须包含成功动作 ${action}`, [...actions]);
  }
  assert(success.every((row) => [users.admin.username, users.warehouse.username].includes(row.actor) && row.accountSetCode === "BLD-TEST"), "销售退货成功日志必须记录真实用户和账套", success);
  const auditRows = success.filter((row) => row.action === "AUDIT");
  assert(auditRows.some((row) => row.after?.status === "AUDITED"
    && row.after?.currency
    && Number(row.after?.amount) > 0
    && Number(row.after?.quantity) > 0
    && Number(row.after?.sourceCount) > 0
    && Number(row.after?.settledAmount) >= 0
    && Number(row.after?.outstandingAmount) >= 0), "审核成功日志必须包含 actor/accountSet/状态/币种/数量/金额/冲应收/待退款摘要", auditRows);
  const failures = rows.filter((row) => !row.success);
  assert(failures.length > 0 && failures.every((row) => row.failureReason), "权限/CAS/超退/冲突失败必须进入统一脱敏失败日志", failures);
  assert(!JSON.stringify(rows).includes(`${fixturePrefix}-SECRET`), "操作日志不得记录收款交易号原值");
  evidence.operationLogs = rows;
  evidence.coverage.operationLogs = true;
}

function inventoryPredicate(alias = "txn") {
  const pairs = [
    ...artifacts.deliveryNotices.flatMap((billNo) => [
      ["DELIVERY_NOTICE_RESERVE", "DELIVERY_NOTICE", billNo, "delivery_notice", "RESERVE", null],
      ["DELIVERY_NOTICE_RESERVE_REVERSE", "DELIVERY_NOTICE", billNo, "delivery_notice", "RELEASE", "DELIVERY_NOTICE_RESERVE"]
    ]),
    ...artifacts.salesOuts.flatMap((billNo) => [
      ["SALES_OUT", "SALES_OUT", billNo, "sales_out", "AUDIT", null],
      ["SALES_OUT_REVERSE", "SALES_OUT", billNo, "sales_out", "REVERSE", "SALES_OUT"]
    ]),
    ...artifacts.returns.public.flatMap((billNo) => [
      ["SALES_RETURN", "SALES_RETURN", billNo, "sales_return", "AUDIT", null],
      ["SALES_RETURN_REVERSE", "SALES_RETURN", billNo, "sales_return", "REVERSE", "SALES_RETURN"]
    ])
  ];
  return [...new Map(pairs.map((pair) => [pair.join("\0"), pair])).values()]
    .map(([txnType, sourceBillType, sourceBillNo, sourceTable, postingAction, originalTxnType]) => `(
      ${alias}.txn_type=${sqlLiteral(txnType)}
      AND ${alias}.source_bill_type=${sqlLiteral(sourceBillType)}
      AND ${alias}.source_bill_no=${sqlLiteral(sourceBillNo)}
      AND ${alias}.source_bill_id=(SELECT id FROM public.${sqlIdentifier(sourceTable)} WHERE bill_no=${sqlLiteral(sourceBillNo)})
      AND EXISTS (
        SELECT 1 FROM public.${sqlIdentifier(`${sourceTable}_line`)} line
        WHERE line.bill_id=${alias}.source_bill_id
          AND line.id=${alias}.source_bill_line_id
          AND line.product_id=${alias}.product_id
          AND line.warehouse_id=${alias}.warehouse_id
      )
      AND ${alias}.source_bill_date=(SELECT bill_date FROM public.${sqlIdentifier(sourceTable)} WHERE bill_no=${sqlLiteral(sourceBillNo)})
      AND ${alias}.account_set_id=(SELECT id FROM public.sys_account_set WHERE code='BLD-TEST' AND enabled=TRUE)
      AND ${alias}.trace_quality='EXACT'
      AND ${alias}.posting_action=${sqlLiteral(postingAction)}
      ${originalTxnType ? `AND EXISTS (
        SELECT 1
        FROM public.inv_stock_txn original
        WHERE original.id=${alias}.reversal_of_txn_id
          AND original.txn_type=${sqlLiteral(originalTxnType)}
          AND original.posting_action=${sqlLiteral(postingAction === "RELEASE" ? "RESERVE" : "AUDIT")}
          AND original.account_set_id=${alias}.account_set_id
          AND original.product_id=${alias}.product_id
          AND original.warehouse_id=${alias}.warehouse_id
          AND original.source_bill_type=${alias}.source_bill_type
          AND original.source_bill_no=${alias}.source_bill_no
          AND original.source_bill_id=${alias}.source_bill_id
          AND original.source_bill_line_id=${alias}.source_bill_line_id
          AND original.source_bill_date=${alias}.source_bill_date
          AND original.trace_quality='EXACT'
          AND original.reversal_of_txn_id IS NULL
      )` : `AND ${alias}.reversal_of_txn_id IS NULL`}
    )`)
    .join(" OR ") || "FALSE";
}

function inventoryOwnershipPredicate(alias = "txn") {
  const sources = [
    ...artifacts.deliveryNotices.map((billNo) => [billNo, "delivery_notice"]),
    ...artifacts.salesOuts.map((billNo) => [billNo, "sales_out"]),
    ...artifacts.returns.public.map((billNo) => [billNo, "sales_return"])
  ];
  return [...new Map(sources.map((source) => [source.join("\0"), source])).values()]
    .map(([billNo, sourceTable]) => `(
      ${alias}.source_bill_no=${sqlLiteral(billNo)}
      OR ${alias}.source_bill_id=(SELECT id FROM public.${sqlIdentifier(sourceTable)} WHERE bill_no=${sqlLiteral(billNo)})
    )`)
    .join(" OR ") || "FALSE";
}

function normalizedStockTransactionSql(alias) {
  return `(to_jsonb(${alias}) || jsonb_build_object(
    'qty_delta', ${alias}.qty_delta::text,
    'unit_cost', ${alias}.unit_cost::text,
    'amount', ${alias}.amount::text
  ))`;
}

function ownedSharedStockTransactions() {
  return dbJson(`
    SELECT COALESCE(jsonb_agg(${normalizedStockTransactionSql("txn")} ORDER BY txn.occurred_at, txn.id::text), '[]'::jsonb)::text
    FROM public.inv_stock_txn txn
    JOIN public.md_product p ON p.id=txn.product_id
    JOIN public.md_warehouse w ON w.id=txn.warehouse_id
    JOIN public.sys_account_set a ON a.id=txn.account_set_id
    WHERE p.code='CP-001' AND w.code='CK-001' AND a.code='BLD-TEST'
      AND (${inventoryOwnershipPredicate("txn")})
  `) ?? [];
}

function canonicalSharedStockTransactions() {
  return dbJson(`
    SELECT COALESCE(jsonb_agg(${normalizedStockTransactionSql("txn")} ORDER BY txn.occurred_at, txn.id::text), '[]'::jsonb)::text
    FROM public.inv_stock_txn txn
    JOIN public.md_product p ON p.id=txn.product_id
    JOIN public.md_warehouse w ON w.id=txn.warehouse_id
    JOIN public.sys_account_set a ON a.id=txn.account_set_id
    WHERE p.code='CP-001' AND w.code='CK-001' AND a.code='BLD-TEST'
      AND (${inventoryPredicate("txn")})
  `) ?? [];
}

async function recoveryRequest(cookie, label, pathname, method = "POST", body = undefined, allowedStatuses = [200, 404]) {
  try {
    const response = await request(cookie, pathname, { method, body });
    const action = { label, method, pathname, status: response.status };
    evidence.cleanup.recovery.actions.push(action);
    if (!allowedStatuses.includes(response.status)) {
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

function unique(values) {
  return [...new Set(values)];
}

async function recoverReturns(schema, cookie, billNos) {
  for (const billNo of unique(billNos).reverse()) {
    let status = businessStatus(schema, "sales_return", billNo);
    let traceProtected = false;
    if (status === "AUDITED") {
      await recoveryRequest(cookie, `${schema} sales return ${billNo} reverse`, `/api/sales-returns/${encodeURIComponent(billNo)}/reverse`);
      status = businessStatus(schema, "sales_return", billNo);
    }
    if (status === "DRAFT") {
      const hasHistory = Number(returnPostingHistory(schema, billNo)?.candidateCount ?? 0) > 0;
      const response = await recoveryRequest(
        cookie,
        `${schema} sales return ${billNo} delete`,
        `/api/sales-returns/${encodeURIComponent(billNo)}`,
        "DELETE",
        undefined,
        hasHistory ? [200, 404, 409] : [200, 404]
      );
      traceProtected = Boolean(
        hasHistory
        && response?.status === 409
        && response.text.includes("库存过账历史")
      );
      if (hasHistory && response?.status === 409 && !traceProtected) {
        evidence.cleanup.recovery.errors.push({
          label: `${schema} sales return ${billNo} trace-protected delete reason`,
          expected: "库存过账历史",
          actual: response.text.slice(0, 500)
        });
      }
      status = businessStatus(schema, "sales_return", billNo);
    }
    if (status && status !== "VOID" && !(traceProtected && status === "DRAFT")) {
      evidence.cleanup.recovery.errors.push({ label: `${schema} sales return ${billNo} lifecycle recovery`, expected: "removed or VOID", actual: status });
    }
  }
}

async function recoverReceipts() {
  for (const billNo of unique(artifacts.receipts).reverse()) {
    let status = businessStatus("public", "ar_receipt", billNo);
    if (status === "AUDITED") {
      await recoveryRequest(cookies.admin, `receipt ${billNo} reverse`, `/api/finance/receipts/${encodeURIComponent(billNo)}/reverse`);
      status = businessStatus("public", "ar_receipt", billNo);
    }
    if (status === "DRAFT") {
      await recoveryRequest(cookies.admin, `receipt ${billNo} delete`, `/api/finance/receipts/${encodeURIComponent(billNo)}`, "DELETE");
      status = businessStatus("public", "ar_receipt", billNo);
    }
    if (status) evidence.cleanup.recovery.errors.push({ label: `receipt ${billNo} lifecycle recovery`, expected: null, actual: status });
  }
}

async function recoverBusinessDocuments(table, collection, billNos) {
  for (const billNo of unique(billNos).reverse()) {
    let status = businessStatus("public", table, billNo);
    if (status === "AUDITED") {
      await recoveryRequest(cookies.admin, `${collection} ${billNo} reverse`, `/api/${collection}/${encodeURIComponent(billNo)}/reverse`);
      status = businessStatus("public", table, billNo);
    }
    if (status === "DRAFT") {
      await recoveryRequest(cookies.admin, `${collection} ${billNo} delete`, `/api/${collection}/${encodeURIComponent(billNo)}`, "DELETE");
      status = businessStatus("public", table, billNo);
    }
    if (status) evidence.cleanup.recovery.errors.push({ label: `${collection} ${billNo} lifecycle recovery`, expected: null, actual: status });
  }
}

function restoreSharedStockBaseline() {
  if (!sharedStockBaseline) return;
  const stockEvidence = evidence.cleanup.recovery.stock;
  const current = stockSnapshot();
  const currentTransactions = ownedSharedStockTransactions();
  const canonicalTransactions = canonicalSharedStockTransactions();
  const expectedCurrentState = expectedSharedStockState();
  stockEvidence.afterApiRecovery = current?.state ?? null;
  stockEvidence.expectedAfterApiRecovery = expectedCurrentState;
  if (!same(current?.state, expectedCurrentState)) {
    throw new Error(`A142 API 恢复后共享库存三量与本次精确追溯链不一致，拒绝删除流水或覆盖 balance ${JSON.stringify({
      baseline: sharedStockBaseline.state,
      expectedCurrentState,
      actual: current?.state ?? null
    })}`);
  }
  if (!current?.balance) throw new Error("A142 共享库存精确恢复找不到当前 balance");
  if (!same(currentTransactions, canonicalTransactions)) {
    throw new Error(`A142 本次业务链存在非 canonical EXACT 库存事实，拒绝按被测字段掩盖异常 ${JSON.stringify({ currentTransactions, canonicalTransactions })}`);
  }
  const before = sharedStockBaseline.balance;
  dbScalar(`
    BEGIN;
    DO $a142_inventory_cleanup$
    DECLARE
      baseline_balance jsonb := ${jsonbSql(before)};
      expected_current_balance jsonb := ${jsonbSql(current.balance)};
      expected_current_txns jsonb := ${jsonbSql(currentTransactions)};
      locked_balance jsonb;
      locked_txns jsonb;
      owned_posting_count bigint;
      deleted_count bigint;
    BEGIN
      PERFORM 1 FROM public.inv_stock_balance WHERE id=${sqlLiteral(before.id)}::uuid FOR UPDATE;
      IF NOT FOUND THEN RAISE EXCEPTION 'A142 inventory cleanup refused: balance row disappeared before lock'; END IF;
      SELECT ${normalizedStockBalanceSql("balance")} INTO locked_balance
      FROM public.inv_stock_balance balance WHERE balance.id=${sqlLiteral(before.id)}::uuid;
      IF locked_balance IS DISTINCT FROM expected_current_balance THEN
        RAISE EXCEPTION 'A142 inventory cleanup refused: complete balance state changed before row lock';
      END IF;
      SELECT COALESCE(jsonb_agg(${normalizedStockTransactionSql("candidate")} ORDER BY candidate.occurred_at, candidate.id::text), '[]'::jsonb), count(*)
      INTO locked_txns, owned_posting_count
      FROM public.inv_stock_txn candidate
      JOIN public.sys_account_set account_set ON account_set.id=candidate.account_set_id
      JOIN public.md_product product ON product.id=candidate.product_id
      JOIN public.md_warehouse warehouse ON warehouse.id=candidate.warehouse_id
      WHERE account_set.code='BLD-TEST' AND product.code='CP-001' AND warehouse.code='CK-001'
        AND (${inventoryOwnershipPredicate("candidate")});
      IF locked_txns IS DISTINCT FROM expected_current_txns THEN
        RAISE EXCEPTION 'A142 inventory cleanup refused: owned transaction set changed before row lock';
      END IF;
      IF locked_balance->'id' IS DISTINCT FROM baseline_balance->'id'
        OR locked_balance->'account_set_id' IS DISTINCT FROM baseline_balance->'account_set_id'
        OR locked_balance->'product_id' IS DISTINCT FROM baseline_balance->'product_id'
        OR locked_balance->'warehouse_id' IS DISTINCT FROM baseline_balance->'warehouse_id'
        OR locked_balance->'unit_cost' IS DISTINCT FROM baseline_balance->'unit_cost'
        OR locked_balance->'amount' IS DISTINCT FROM baseline_balance->'amount'
        OR locked_balance->'created_at' IS DISTINCT FROM baseline_balance->'created_at' THEN
        RAISE EXCEPTION 'A142 inventory cleanup refused: non-test balance fields changed';
      END IF;
      IF (locked_balance->>'version')::bigint IS DISTINCT FROM (baseline_balance->>'version')::bigint + owned_posting_count THEN
        RAISE EXCEPTION 'A142 inventory cleanup refused: version delta does not equal owned postings';
      END IF;
      DELETE FROM public.inv_stock_txn candidate
      USING public.sys_account_set account_set, public.md_product product, public.md_warehouse warehouse
      WHERE account_set.id=candidate.account_set_id AND product.id=candidate.product_id AND warehouse.id=candidate.warehouse_id
        AND account_set.code='BLD-TEST' AND product.code='CP-001' AND warehouse.code='CK-001'
        AND (${inventoryOwnershipPredicate("candidate")});
      GET DIAGNOSTICS deleted_count = ROW_COUNT;
      IF deleted_count IS DISTINCT FROM owned_posting_count THEN
        RAISE EXCEPTION 'A142 inventory cleanup refused: deleted owned transaction count mismatch';
      END IF;
      UPDATE public.inv_stock_balance SET
        qty_on_hand=${nullableSql(before.qty_on_hand)},
        qty_available=${nullableSql(before.qty_available)},
        qty_reserved=${nullableSql(before.qty_reserved)},
        unit_cost=${nullableSql(before.unit_cost)},
        amount=${nullableSql(before.amount)},
        created_at=${nullableSql(before.created_at, "timestamptz")},
        updated_at=${nullableSql(before.updated_at, "timestamptz")},
        version=${nullableSql(before.version, "bigint")}
      WHERE id=${sqlLiteral(before.id)}::uuid;
      IF NOT FOUND THEN RAISE EXCEPTION 'A142 inventory cleanup refused: exact baseline restore updated zero rows'; END IF;
    END;
    $a142_inventory_cleanup$;
    COMMIT;
  `);
  const finalSnapshot = stockSnapshot();
  const finalTransactions = ownedSharedStockTransactions();
  stockEvidence.exactRestore = { ownedTransactionCount: currentTransactions.length, balanceRestored: same(finalSnapshot, sharedStockBaseline), transactionsRestored: finalTransactions.length === 0 };
  stockEvidence.final = finalSnapshot?.state ?? null;
  if (!same(finalSnapshot, sharedStockBaseline) || finalTransactions.length !== 0) {
    throw new Error(`A142 共享库存完整快照恢复失败 ${JSON.stringify({ sharedStockBaseline, finalSnapshot, finalTransactions })}`);
  }
  sharedStockCleanupAuthorized = true;
}

async function recoverFailureSafeState() {
  evidence.cleanup.recovery.attempted = true;
  try {
    if (cookies.admin) {
      cookies.admin = await loginApi(apiBase, users.admin.username, users.admin.password, "BLD-TEST");
    }
    if (cookies.replayAdmin && replayTenant?.code) {
      cookies.replayAdmin = await loginApi(apiBase, users.replayAdmin.username, users.replayAdmin.password, replayTenant.code);
    }
    const releasedFixtureLocks = dbJson(`
      WITH deleted AS (
        DELETE FROM public.doc_edit_lock lock
        USING public.sys_user user_account
        WHERE lock.holder_user_id=user_account.id
          AND user_account.username LIKE ${sqlLiteral(`${userPrefix}%`)}
        RETURNING lock.document_type AS "documentType", lock.bill_no AS "billNo", lock.holder_username AS "holderUsername"
      )
      SELECT COALESCE(jsonb_agg(to_jsonb(deleted)), '[]'::jsonb)::text FROM deleted
    `) ?? [];
    evidence.cleanup.recovery.actions.push({ label: "release fixture-owned document locks fallback", count: releasedFixtureLocks.length, locks: releasedFixtureLocks });
    dbScalar(`
      UPDATE public.sales_return_finance_allocation a SET refunded_amount=0
      FROM public.sales_return sr
      WHERE a.sales_return_id=sr.id AND sr.remark LIKE ${sqlLiteral(`${fixturePrefix}%`)} AND a.refunded_amount <> 0;
      UPDATE public.inv_stock_balance b SET qty_on_hand=GREATEST(b.qty_on_hand, 1), qty_available=GREATEST(b.qty_available, 1)
      FROM public.md_product p, public.md_warehouse w, public.sys_account_set a
      WHERE b.product_id=p.id AND b.warehouse_id=w.id AND b.account_set_id=a.id
        AND p.code='CP-001' AND w.code=${sqlLiteral(codes.isolatedWarehouse)} AND a.code='BLD-TEST';
    `);
    if (cookies.admin) await recoverReturns("public", cookies.admin, artifacts.returns.public);
    if (cookies.replayAdmin && replayTenant?.schemaName) await recoverReturns(replayTenant.schemaName, cookies.replayAdmin, artifacts.returns.replay);
    if (cookies.admin) {
      await recoverReceipts();
    }
  } catch (error) {
    evidence.cleanup.recovery.errors.push({ label: "unexpected API recovery failure", error: error instanceof Error ? error.message : String(error) });
  } finally {
    restoreSharedStockBaseline();
  }
  if (evidence.cleanup.recovery.errors.length > 0) {
    throw new Error(`A142 API 恢复存在未闭环动作 ${JSON.stringify(evidence.cleanup.recovery.errors)}`);
  }
}

function inValues(values) {
  const normalized = unique(values.filter(Boolean));
  return normalized.length ? normalized.map(sqlLiteral).join(",") : "NULL";
}

async function logoutSessions() {
  await Promise.all(Object.values(cookies).filter(Boolean).map((cookie) => fetch(`${apiBase}/api/system/logout`, {
    method: "POST",
    headers: { Cookie: cookie }
  }).catch(() => null)));
}

function cleanupSchema(schema) {
  if (schema === "public" && !sharedStockCleanupAuthorized) {
    throw new Error("A142 共享库存尚未通过 API 恢复与完整快照校验，拒绝直接清理业务夹具");
  }
  const t = (name) => schemaTable(schema, name);
  const isPublic = schema === "public";
  const returnBills = isPublic ? artifacts.returns.public : artifacts.returns.replay;
  const receiptBills = isPublic ? artifacts.receipts : [];
  const directSources = isPublic ? artifacts.directSources.public : artifacts.directSources.replay;
  const allSalesOuts = isPublic ? [...directSources, ...artifacts.salesOuts] : directSources;
  const publicOnly = isPublic ? `
    DELETE FROM ${t("inv_stock_txn")} txn
    USING ${t("md_warehouse")} warehouse
    WHERE txn.warehouse_id=warehouse.id AND warehouse.code=${sqlLiteral(codes.isolatedWarehouse)};
    DELETE FROM ${t("inv_stock_balance")} balance
    USING ${t("md_warehouse")} warehouse
    WHERE balance.warehouse_id=warehouse.id AND warehouse.code=${sqlLiteral(codes.isolatedWarehouse)};
    DELETE FROM ${t("md_warehouse")} WHERE code=${sqlLiteral(codes.isolatedWarehouse)};
    DELETE FROM ${t("delivery_notice_line")} WHERE bill_id IN (
      SELECT id FROM ${t("delivery_notice")} WHERE bill_no IN (${inValues(artifacts.deliveryNotices)})
    );
    DELETE FROM ${t("delivery_notice")} WHERE bill_no IN (${inValues(artifacts.deliveryNotices)});
    DELETE FROM ${t("sales_order_line")} WHERE order_id IN (
      SELECT id FROM ${t("sales_order")} WHERE bill_no IN (${inValues(artifacts.salesOrders)})
    );
    DELETE FROM ${t("sales_order")} WHERE bill_no IN (${inValues(artifacts.salesOrders)});
  ` : `DELETE FROM ${t("md_product")} WHERE code=${sqlLiteral(codes.replayProduct)};`;
  dbScalar(`
    BEGIN;
    DELETE FROM ${t("sys_operation_log")}
    WHERE actor_username LIKE ${sqlLiteral(`${userPrefix}%`)}
       OR target_no IN (${inValues([...returnBills, ...allSalesOuts, ...receiptBills])})
       OR COALESCE(failure_reason, '') LIKE ${sqlLiteral(`%${fixturePrefix}%`)};
    DELETE FROM ${t("sales_return_finance_allocation")} WHERE sales_return_id IN (
      SELECT id FROM ${t("sales_return")}
      WHERE bill_no IN (${inValues(returnBills)}) OR remark LIKE ${sqlLiteral(`${fixturePrefix}%`)}
    );
    DELETE FROM ${t("sales_return_line")} WHERE bill_id IN (
      SELECT id FROM ${t("sales_return")}
      WHERE bill_no IN (${inValues(returnBills)}) OR remark LIKE ${sqlLiteral(`${fixturePrefix}%`)}
    );
    DELETE FROM ${t("sales_return")}
      WHERE bill_no IN (${inValues(returnBills)}) OR remark LIKE ${sqlLiteral(`${fixturePrefix}%`)};
    DELETE FROM ${t("ar_receipt_fund_line")} WHERE receipt_id IN (
      SELECT id FROM ${t("ar_receipt")} WHERE bill_no IN (${inValues(receiptBills)}) OR remark LIKE ${sqlLiteral(`${fixturePrefix}%`)}
    );
    DELETE FROM ${t("ar_receipt_allocation")} WHERE receipt_id IN (
      SELECT id FROM ${t("ar_receipt")} WHERE bill_no IN (${inValues(receiptBills)}) OR remark LIKE ${sqlLiteral(`${fixturePrefix}%`)}
    );
    DELETE FROM ${t("ar_receipt")} WHERE bill_no IN (${inValues(receiptBills)}) OR remark LIKE ${sqlLiteral(`${fixturePrefix}%`)};
    DELETE FROM ${t("ar_receivable")}
      WHERE source_bill_no IN (${inValues(allSalesOuts)}) OR bill_no LIKE ${sqlLiteral(`${fixturePrefix}%`)};
    DELETE FROM ${t("sales_out_line")} WHERE bill_id IN (
      SELECT id FROM ${t("sales_out")}
      WHERE bill_no IN (${inValues(allSalesOuts)}) OR remark LIKE ${sqlLiteral(`${fixturePrefix}%`)}
    );
    DELETE FROM ${t("sales_out")}
      WHERE bill_no IN (${inValues(allSalesOuts)}) OR remark LIKE ${sqlLiteral(`${fixturePrefix}%`)};
    ${publicOnly}
    DELETE FROM ${t("md_financial_account")} WHERE code IN (${sqlLiteral(codes.bankCny)}, ${sqlLiteral(codes.bankUsd)});
    DELETE FROM ${t("md_customer")} WHERE code IN (${sqlLiteral(codes.customerA)}, ${sqlLiteral(codes.customerB)});
    COMMIT;
  `);
}

function cleanupUsersAndRole() {
  dbScalar(`
    BEGIN;
    DELETE FROM public.doc_edit_lock WHERE holder_user_id IN (
      SELECT id FROM public.sys_user WHERE username LIKE ${sqlLiteral(`${userPrefix}%`)}
    );
    DELETE FROM public.sys_user_account_set WHERE user_id IN (
      SELECT id FROM public.sys_user WHERE username LIKE ${sqlLiteral(`${userPrefix}%`)}
    );
    DELETE FROM public.sys_user_role WHERE user_id IN (
      SELECT id FROM public.sys_user WHERE username LIKE ${sqlLiteral(`${userPrefix}%`)}
    );
    DELETE FROM public.sys_user WHERE username LIKE ${sqlLiteral(`${userPrefix}%`)};
    DELETE FROM public.sys_permission WHERE role_id IN (
      SELECT id FROM public.sys_role WHERE code=${sqlLiteral(lowRoleCode)}
    );
    DELETE FROM public.sys_role WHERE code=${sqlLiteral(lowRoleCode)};
    COMMIT;
  `);
}

function residueCounts() {
  const replaySchema = replayTenant?.schemaName;
  const publicReturnBills = inValues(artifacts.returns.public);
  const publicSources = inValues([...artifacts.directSources.public, ...artifacts.salesOuts]);
  const replayReturnBills = inValues(artifacts.returns.replay);
  const replaySources = inValues(artifacts.directSources.replay);
  const publicCounts = dbJson(`
    SELECT jsonb_build_object(
      'users', (SELECT count(*) FROM public.sys_user WHERE username LIKE ${sqlLiteral(`${userPrefix}%`)}),
      'roles', (SELECT count(*) FROM public.sys_role WHERE code=${sqlLiteral(lowRoleCode)}),
      'customers', (SELECT count(*) FROM public.md_customer WHERE code IN (${sqlLiteral(codes.customerA)}, ${sqlLiteral(codes.customerB)})),
      'accounts', (SELECT count(*) FROM public.md_financial_account WHERE code IN (${sqlLiteral(codes.bankCny)}, ${sqlLiteral(codes.bankUsd)})),
      'returns', (SELECT count(*) FROM public.sales_return WHERE bill_no IN (${publicReturnBills}) OR remark LIKE ${sqlLiteral(`${fixturePrefix}%`)}),
      'returnLines', (SELECT count(*) FROM public.sales_return_line l JOIN public.sales_return h ON h.id=l.bill_id WHERE h.bill_no IN (${publicReturnBills}) OR h.remark LIKE ${sqlLiteral(`${fixturePrefix}%`)}),
      'returnAllocations', (SELECT count(*) FROM public.sales_return_finance_allocation a JOIN public.sales_return h ON h.id=a.sales_return_id WHERE h.bill_no IN (${publicReturnBills}) OR h.remark LIKE ${sqlLiteral(`${fixturePrefix}%`)}),
      'salesOuts', (SELECT count(*) FROM public.sales_out WHERE bill_no IN (${publicSources}) OR remark LIKE ${sqlLiteral(`${fixturePrefix}%`)}),
      'receivables', (SELECT count(*) FROM public.ar_receivable WHERE source_bill_no IN (${publicSources}) OR bill_no LIKE ${sqlLiteral(`${fixturePrefix}%`)}),
      'receipts', (SELECT count(*) FROM public.ar_receipt WHERE bill_no IN (${inValues(artifacts.receipts)}) OR remark LIKE ${sqlLiteral(`${fixturePrefix}%`)}),
      'warehouse', (SELECT count(*) FROM public.md_warehouse WHERE code=${sqlLiteral(codes.isolatedWarehouse)}),
      'sharedStockTransactions', (SELECT count(*) FROM public.inv_stock_txn txn WHERE ${inventoryOwnershipPredicate("txn")}),
      'logs', (SELECT count(*) FROM public.sys_operation_log WHERE actor_username LIKE ${sqlLiteral(`${userPrefix}%`)} OR COALESCE(failure_reason, '') LIKE ${sqlLiteral(`%${fixturePrefix}%`)})
    )::text
  `);
  const replayCounts = replaySchema ? dbJson(`
    SELECT jsonb_build_object(
      'customers', (SELECT count(*) FROM ${schemaTable(replaySchema, "md_customer")} WHERE code IN (${sqlLiteral(codes.customerA)}, ${sqlLiteral(codes.customerB)})),
      'accounts', (SELECT count(*) FROM ${schemaTable(replaySchema, "md_financial_account")} WHERE code IN (${sqlLiteral(codes.bankCny)}, ${sqlLiteral(codes.bankUsd)})),
      'products', (SELECT count(*) FROM ${schemaTable(replaySchema, "md_product")} WHERE code=${sqlLiteral(codes.replayProduct)}),
      'returns', (SELECT count(*) FROM ${schemaTable(replaySchema, "sales_return")} WHERE bill_no IN (${replayReturnBills}) OR remark LIKE ${sqlLiteral(`${fixturePrefix}%`)}),
      'salesOuts', (SELECT count(*) FROM ${schemaTable(replaySchema, "sales_out")} WHERE bill_no IN (${replaySources}) OR remark LIKE ${sqlLiteral(`${fixturePrefix}%`)}),
      'receivables', (SELECT count(*) FROM ${schemaTable(replaySchema, "ar_receivable")} WHERE source_bill_no IN (${replaySources}) OR bill_no LIKE ${sqlLiteral(`${fixturePrefix}%`)}),
      'logs', (SELECT count(*) FROM ${schemaTable(replaySchema, "sys_operation_log")} WHERE actor_username LIKE ${sqlLiteral(`${userPrefix}%`)} OR COALESCE(failure_reason, '') LIKE ${sqlLiteral(`%${fixturePrefix}%`)})
    )::text
  `) : {};
  return { public: publicCounts, replay: replayCounts };
}

async function cleanup() {
  evidence.cleanup.attempted = true;
  if (browser) {
    await browser.close().catch(() => null);
    browser = null;
  }
  const errors = [];
  if (controlledInventoryCapability) {
    try {
      await recoverFailureSafeState();
    } catch (error) {
      errors.push({ phase: "recovery", message: error instanceof Error ? error.message : String(error) });
    }
  }
  await logoutSessions();
  if (controlledInventoryCapability) {
    for (const [phase, action] of [
      ["replay schema cleanup", () => { if (replayTenant?.schemaName) cleanupSchema(replayTenant.schemaName); }],
      ["public schema cleanup", () => cleanupSchema("public")],
      ["fixture user cleanup", () => cleanupUsersAndRole()]
    ]) {
      try {
        action();
      } catch (error) {
        errors.push({ phase, message: error instanceof Error ? error.message : String(error) });
      }
    }
  }
  try {
    evidence.cleanup.remaining = residueCounts();
  } catch (error) {
    errors.push({ phase: "residue count", message: error instanceof Error ? error.message : String(error) });
    evidence.cleanup.remaining = null;
  }
  const remaining = Object.values(evidence.cleanup.remaining?.public ?? {}).reduce((sum, value) => sum + Number(value), 0)
    + Object.values(evidence.cleanup.remaining?.replay ?? {}).reduce((sum, value) => sum + Number(value), 0);
  if (remaining !== 0) {
    errors.push({ phase: "residue assertion", message: "A142 所有业务夹具、库存流水和临时用户最终必须清理为 0", remaining: evidence.cleanup.remaining });
  }
  if (errors.length > 0) {
    evidence.cleanup.phaseErrors = errors;
    throw new Error(`A142 cleanup 完成所有可执行阶段后仍存在错误 ${JSON.stringify(errors)}`);
  }
}

async function run() {
  await mkdir(screenshotDir, { recursive: true });
  await requireControlledInventoryFixture();
  setupFixtures();
  await loginFixtures();
  const sources = prepareDirectSources();
  await verifyPermissions(sources.public.cas);
  await verifyDraftCasNarrowCopy(sources.public.cas);
  await verifyValidationGuards(sources.public);
  captureSharedStockBaseline();
  await verifyZeroAmountAuditRollback(sources.public.zeroAmount);
  const cnyChain = await createSalesChain("CNY");
  const usdChain = await createSalesChain("USD");
  await verifyMainCnyChain(cnyChain);
  await verifyUsdFullyReceivedChain(usdChain);
  await verifyPartiallyReceived(sources.public.partial);
  await verifyConcurrentReturnAudit(sources.public.race);
  await verifyArLockConcurrency(sources.public.arRace);
  await verifyLifoReverseGuard(sources.public.lifo);
  await verifyRedAndSourceGuards(sources.public);
  await verifyInventoryAndRefundGuards(sources.public.isolatedInventory);
  await verifySaveVsSourceConcurrency();
  await verifyVoid(sources.public.guard);
  await verifyTenantIsolation(sources.public.same, sources.replaySame);
  await verifyListsAndOutput();
  await verifyBrowser(sources.public.browser);
  await closeMainReturn();
  verifyOperationLogs();
}

let runError = null;
try {
  await run();
} catch (error) {
  runError = error;
  evidence.failure = { message: error instanceof Error ? error.message : String(error), stack: error instanceof Error ? error.stack : undefined };
}

try {
  await cleanup();
} catch (error) {
  evidence.cleanup.error = error instanceof Error ? error.message : String(error);
  if (!runError) runError = error;
}

evidence.ok = !runError;
evidence.completedAt = new Date().toISOString();
await mkdir(verificationDir, { recursive: true });
await writeFile(resultPath, JSON.stringify(evidence, null, 2));

if (runError) {
  console.error(JSON.stringify({ ok: false, resultPath: path.relative(rootDir, resultPath), failure: evidence.failure, cleanup: evidence.cleanup }, null, 2));
  throw runError;
}

console.log(JSON.stringify({ ok: true, resultPath: path.relative(rootDir, resultPath), coverage: evidence.coverage, cleanup: evidence.cleanup }, null, 2));
