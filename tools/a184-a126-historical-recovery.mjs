import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

const rootDir = path.resolve(import.meta.dirname, "..");
const verificationDir = path.join(rootDir, "verification");
const timestamp = new Date().toISOString().replace(/\D/g, "").slice(0, 14);
const dryRunPath = path.join(verificationDir, `a184-a126-historical-recovery-${timestamp}.json`);
const batchPattern = /^\d{14}$/;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function assert(condition, message, details = undefined) {
  if (!condition) throw new Error(`${message}${details === undefined ? "" : ` ${JSON.stringify(details)}`}`);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function manifestDigestPayload(manifest) {
  return {
    eligibleBatches: manifest.eligibleBatches,
    blockedBatches: manifest.blockedBatches,
    entries: manifest.entries,
    blockedEntries: manifest.blockedEntries,
    route: manifest.route,
    balance: manifest.balance,
    currentBalance: manifest.currentBalance,
    ledger: manifest.ledger,
    applyDisposition: manifest.applyDisposition,
    deltas: { onHand: manifest.deltas.onHand, reserved: manifest.deltas.reserved },
    projectedBalance: manifest.projectedBalance
  };
}

function calculateManifestDigest(manifest) {
  return sha256(JSON.stringify(manifestDigestPayload(manifest)));
}

function dbScalar(sql, label = "A184 A126 historical database command") {
  try {
    return execFileSync(
      "docker",
      ["exec", "-i", "jdy-erp-postgres", "psql", "-X", "-U", "jdy", "-d", "jdy_erp", "-v", "ON_ERROR_STOP=1", "-tAq"],
      { encoding: "utf8", input: `${sql.trim()}\n`, maxBuffer: 256 * 1024 * 1024 }
    ).trim();
  } catch (error) {
    throw new Error(`${label} failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function dbJson(sql, label) {
  const text = dbScalar(sql, label);
  return text ? JSON.parse(text) : null;
}

function envelope(alias) {
  return `jsonb_build_object(
    'id', ${alias}.id::text,
    'rowHash', encode(digest(to_jsonb(${alias})::text, 'sha256'), 'hex'),
    'data', to_jsonb(${alias})
  )`;
}

function aggregate(table, alias, order = `${alias}.id::text`) {
  return `(SELECT COALESCE(jsonb_agg(${envelope(alias)} ORDER BY ${order}), '[]'::jsonb) FROM ${table} ${alias})`;
}

function historicalCtes() {
  return `
    route AS MATERIALIZED (
      SELECT account_set.id AS account_set_id,
             account_set.code AS account_set_code,
             account_set.name AS account_set_name,
             account_set.schema_name,
             product.id AS product_id,
             product.code AS product_code,
             warehouse.id AS warehouse_id,
             warehouse.code AS warehouse_code,
             customer.id AS customer_id,
             customer.code AS customer_code
      FROM public.sys_account_set account_set
      JOIN public.md_product product ON product.code='CP-001'
      JOIN public.md_warehouse warehouse ON warehouse.code='CK-001'
      JOIN public.md_customer customer ON customer.code='KH-001'
      WHERE account_set.code='BLD-TEST'
        AND account_set.schema_name='public'
        AND account_set.enabled=TRUE
        AND product.enabled=TRUE
        AND warehouse.enabled=TRUE
        AND customer.enabled=TRUE
    ),
    seed_txns AS MATERIALIZED (
      SELECT txn.*,
             substring(txn.source_bill_type FROM '^A126_SEED:([0-9]{14}):[A-Za-z0-9_-]+$') AS batch
      FROM public.inv_stock_txn txn, route
      WHERE txn.source_bill_type ~ '^A126_SEED:[0-9]{14}:[A-Za-z0-9_-]+$'
        AND txn.account_set_id=route.account_set_id
        AND txn.product_id=route.product_id
        AND txn.warehouse_id=route.warehouse_id
    ),
    batches AS MATERIALIZED (
      SELECT DISTINCT batch FROM seed_txns WHERE batch IS NOT NULL
    ),
    quote_headers AS MATERIALIZED (
      SELECT DISTINCT header.*
      FROM public.sales_quote header
      JOIN public.sales_quote_line line ON line.quote_id=header.id
      JOIN batches batch ON line.customer_order_no='KH-A126-' || batch.batch
    ),
    quote_lines AS MATERIALIZED (
      SELECT line.* FROM public.sales_quote_line line JOIN quote_headers header ON header.id=line.quote_id
    ),
    order_headers AS MATERIALIZED (
      SELECT DISTINCT header.*
      FROM public.sales_order header
      JOIN public.sales_order_line line ON line.order_id=header.id
      JOIN batches batch ON line.customer_order_no='KH-A126-' || batch.batch
    ),
    order_lines AS MATERIALIZED (
      SELECT line.* FROM public.sales_order_line line JOIN order_headers header ON header.id=line.order_id
    ),
    notice_headers AS MATERIALIZED (
      SELECT DISTINCT header.*
      FROM public.delivery_notice header
      JOIN public.delivery_notice_line line ON line.bill_id=header.id
      JOIN batches batch ON line.customer_order_no='KH-A126-' || batch.batch
    ),
    notice_lines AS MATERIALIZED (
      SELECT line.* FROM public.delivery_notice_line line JOIN notice_headers header ON header.id=line.bill_id
    ),
    out_headers AS MATERIALIZED (
      SELECT DISTINCT header.*
      FROM public.sales_out header
      JOIN public.sales_out_line line ON line.bill_id=header.id
      JOIN batches batch ON line.customer_order_no='KH-A126-' || batch.batch
    ),
    out_lines AS MATERIALIZED (
      SELECT line.* FROM public.sales_out_line line JOIN out_headers header ON header.id=line.bill_id
    ),
    bills AS MATERIALIZED (
      SELECT 'sales_quote'::text AS kind, id, bill_no FROM quote_headers
      UNION ALL SELECT 'sales_order', id, bill_no FROM order_headers
      UNION ALL SELECT 'delivery_notice', id, bill_no FROM notice_headers
      UNION ALL SELECT 'sales_out', id, bill_no FROM out_headers
    ),
    lines AS MATERIALIZED (
      SELECT 'sales_quote_line'::text AS kind, id, quote_id AS header_id FROM quote_lines
      UNION ALL SELECT 'sales_order_line', id, order_id FROM order_lines
      UNION ALL SELECT 'delivery_notice_line', id, bill_id FROM notice_lines
      UNION ALL SELECT 'sales_out_line', id, bill_id FROM out_lines
    ),
    owned_txns AS MATERIALIZED (
      SELECT DISTINCT txn.*
      FROM public.inv_stock_txn txn, route
      WHERE txn.account_set_id=route.account_set_id
        AND txn.product_id=route.product_id
        AND txn.warehouse_id=route.warehouse_id
        AND (
          txn.id IN (SELECT id FROM seed_txns)
          OR txn.source_bill_id IN (SELECT id FROM bills)
          OR txn.source_bill_line_id IN (SELECT id FROM lines)
          OR txn.source_bill_no IN (SELECT bill_no FROM bills)
        )
    ),
    receivables AS MATERIALIZED (
      SELECT receivable.* FROM public.ar_receivable receivable
      WHERE receivable.source_bill_no IN (SELECT bill_no FROM out_headers)
    ),
    operation_logs AS MATERIALIZED (
      SELECT log.* FROM public.sys_operation_log log
      WHERE log.target_id IN (SELECT id FROM bills)
         OR log.target_id IN (SELECT id FROM receivables)
         OR log.target_no IN (SELECT bill_no FROM bills)
         OR log.target_no IN (SELECT 'YS-' || source_bill_no FROM receivables)
    )
  `;
}

function captureHistoricalSnapshot() {
  return dbJson(`
    WITH ${historicalCtes()}
    SELECT jsonb_build_object(
      'capturedAt', clock_timestamp(),
      'route', (SELECT to_jsonb(route) FROM route),
      'knownCreators', (SELECT COALESCE(jsonb_object_agg(user_row.id::text, user_row.username), '{}'::jsonb)
        FROM public.sys_user user_row
        WHERE user_row.username IN ('admin', 'warehouse') OR user_row.username LIKE 'r_full_%'),
      'batches', (SELECT COALESCE(jsonb_agg(batch ORDER BY batch), '[]'::jsonb) FROM batches),
      'balance', (SELECT ${envelope("balance")} FROM public.inv_stock_balance balance, route
        WHERE balance.account_set_id=route.account_set_id AND balance.product_id=route.product_id AND balance.warehouse_id=route.warehouse_id),
      'ledger', (SELECT jsonb_build_object(
          'count', count(*),
          'qtyDeltaSum', COALESCE(sum(txn.qty_delta), 0)::text,
          'latestId', (array_agg(txn.id::text ORDER BY txn.occurred_at DESC, txn.id DESC))[1],
          'latestAfter', (array_agg(txn.qty_on_hand_after::text ORDER BY txn.occurred_at DESC, txn.id DESC))[1]
        ) FROM public.inv_stock_txn txn, route
        WHERE txn.account_set_id=route.account_set_id AND txn.product_id=route.product_id AND txn.warehouse_id=route.warehouse_id),
      'seedTxns', ${aggregate("seed_txns", "row", "row.occurred_at, row.id::text")},
      'quotes', ${aggregate("quote_headers", "row")},
      'quoteLines', ${aggregate("quote_lines", "row")},
      'orders', ${aggregate("order_headers", "row")},
      'orderLines', ${aggregate("order_lines", "row")},
      'notices', ${aggregate("notice_headers", "row")},
      'noticeLines', ${aggregate("notice_lines", "row")},
      'outs', ${aggregate("out_headers", "row")},
      'outLines', ${aggregate("out_lines", "row")},
      'transactions', ${aggregate("owned_txns", "row", "row.occurred_at, row.id::text")},
      'receivables', ${aggregate("receivables", "row")},
      'logs', ${aggregate("operation_logs", "row", "row.operated_at, row.id::text")},
      'external', jsonb_build_object(
        'salesOrders', (SELECT count(*) FROM public.sales_order_line line WHERE line.order_id NOT IN (SELECT id FROM order_headers) AND line.source_order_no IN (SELECT bill_no FROM quote_headers)),
        'deliveryNotices', (SELECT count(*) FROM public.delivery_notice_line line WHERE line.bill_id NOT IN (SELECT id FROM notice_headers) AND line.source_order_no IN (SELECT bill_no FROM order_headers)),
        'salesOutLines', (SELECT count(*) FROM public.sales_out_line line WHERE line.bill_id NOT IN (SELECT id FROM out_headers) AND (line.source_order_no IN (SELECT bill_no FROM order_headers) OR line.source_delivery_notice_no IN (SELECT bill_no FROM notice_headers))),
        'salesOutHeaders', (SELECT count(*) FROM public.sales_out header WHERE header.id NOT IN (SELECT id FROM out_headers) AND (header.source_order_id IN (SELECT id FROM order_headers) OR header.source_delivery_notice_id IN (SELECT id FROM notice_headers))),
        'redSalesOuts', (SELECT count(*) FROM public.sales_out header WHERE header.id NOT IN (SELECT id FROM out_headers) AND header.red_source_bill_id IN (SELECT id FROM out_headers)),
        'salesReturns', (SELECT count(*) FROM public.sales_return_line line WHERE line.source_out_line_id IN (SELECT id FROM out_lines)),
        'returnAllocations', (SELECT count(*) FROM public.sales_return_finance_allocation allocation WHERE allocation.receivable_id IN (SELECT id FROM receivables)),
        'legacyReceipts', (SELECT count(*) FROM public.ar_receipt receipt WHERE receipt.legacy_receivable_id IN (SELECT id FROM receivables)),
        'receiptAllocations', (SELECT count(*) FROM public.ar_receipt_allocation allocation WHERE allocation.receivable_id IN (SELECT id FROM receivables)),
        'outboxEvents', (SELECT count(*) FROM public.sys_outbox_event event WHERE event.aggregate_id IN (SELECT id FROM bills) OR event.aggregate_id IN (SELECT id FROM receivables)),
        'notifications', (SELECT count(*) FROM public.sys_notification_outbox notification WHERE notification.source_id IN (SELECT id FROM bills) OR notification.source_id IN (SELECT id FROM receivables)),
        'editLocks', (SELECT count(*) FROM public.doc_edit_lock lock WHERE lock.bill_no IN (SELECT bill_no FROM bills)),
        'externalReversals', (SELECT count(*) FROM public.inv_stock_txn txn WHERE txn.reversal_of_txn_id IN (SELECT id FROM owned_txns) AND txn.id NOT IN (SELECT id FROM owned_txns)),
        'foreignReversalSources', (SELECT count(*) FROM owned_txns txn WHERE txn.reversal_of_txn_id IS NOT NULL AND txn.reversal_of_txn_id NOT IN (SELECT id FROM owned_txns)),
        'outsourcingSurfaceSources', (SELECT count(*) FROM public.outsourcing_surface_process row WHERE row.source_bill_no IN (SELECT bill_no FROM bills)),
        'outsourcingWorkOrderSources', (SELECT count(*) FROM public.outsourcing_work_order row WHERE row.source_bill_no IN (SELECT bill_no FROM bills)),
        'payableSources', (SELECT count(*) FROM public.ap_payable row WHERE row.source_bill_no IN (SELECT bill_no FROM bills))
      )
    )::text
  `, "A184 A126 historical dry-run snapshot");
}

function dataRows(envelopes) {
  return envelopes.map((row) => row.data);
}

function mapById(envelopes) {
  return new Map(envelopes.map((row) => [String(row.id), row]));
}

function batchFromMarker(value) {
  const match = /^KH-A126-(\d{14})$/.exec(String(value ?? ""));
  return match?.[1] ?? "";
}

function javaUnsignedBase36(value) {
  let hash = 0;
  for (const character of String(value)) hash = (Math.imul(hash, 31) + character.charCodeAt(0)) | 0;
  return (hash >>> 0).toString(36).toUpperCase();
}

function compactTimestampEpoch(value) {
  const match = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/.exec(String(value ?? ""));
  if (!match) return Number.NaN;
  return Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]), Number(match[4]), Number(match[5]), Number(match[6])) / 1000;
}

function databaseTimestampEpoch(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?/.exec(String(value ?? ""));
  if (!match) return Number.NaN;
  const milliseconds = Number(`0.${match[7] ?? "0"}`) * 1000;
  return (Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]), Number(match[4]), Number(match[5]), Number(match[6])) + milliseconds) / 1000;
}

function assignHeaderBatches(snapshot, headersKey, linesKey, parentKey, route, knownCreators, errorsByBatch) {
  const lines = dataRows(snapshot[linesKey]);
  const result = new Map();
  const rules = {
    quotes: { billPrefix: "XSBJ", remarks: new Set(["A126 报价源单"]), creators: /^(admin|r_full_)/ },
    orders: { billPrefix: "XSDD", remarks: new Set(["A126 销售订单", null]), creators: /^(admin|r_full_)/ },
    notices: { billPrefix: "FHTZ", remarks: new Set(["A126 发货通知", null]), creators: /^(admin|r_full_)/ },
    outs: { billPrefix: "XSCK", remarks: new Set(["A126 销售出库", null]), creators: /^warehouse$/ }
  }[headersKey];
  assert(rules, `A184 A126 historical header rules are unavailable for ${headersKey}`);
  for (const header of dataRows(snapshot[headersKey])) {
    const ownedLines = lines.filter((line) => String(line[parentKey]) === String(header.id));
    const batches = [...new Set(ownedLines.map((line) => batchFromMarker(line.customer_order_no)).filter(Boolean))];
    const batch = batches.length === 1 ? batches[0] : batches[0] ?? "UNKNOWN";
    if (!errorsByBatch.has(batch)) errorsByBatch.set(batch, []);
    const errors = errorsByBatch.get(batch);
    if (batches.length !== 1) errors.push(`${headersKey}:${header.id}:mixed-or-missing-batch`);
    if (String(header.customer_id) !== String(route.customer_id) || String(header.bill_date) !== "2026-07-01") {
      errors.push(`${headersKey}:${header.id}:customer-or-date-drift`);
    }
    const creator = header.created_by == null ? null : knownCreators[String(header.created_by)];
    const nullCreatorAllowed = headersKey === "outs" && header.red_source_bill_id != null;
    if ((!creator && !nullCreatorAllowed) || (creator && !rules.creators.test(creator))) {
      errors.push(`${headersKey}:${header.id}:creator-drift`);
    }
    if (!rules.remarks.has(header.remark ?? null) || !String(header.bill_no ?? "").startsWith(rules.billPrefix)) {
      errors.push(`${headersKey}:${header.id}:remark-or-billno-drift`);
    }
    const createdOffsetSeconds = databaseTimestampEpoch(header.created_at) - compactTimestampEpoch(batch);
    if (!Number.isFinite(createdOffsetSeconds) || createdOffsetSeconds < 0 || createdOffsetSeconds > 15) {
      errors.push(`${headersKey}:${header.id}:created-at-outside-batch-window=${createdOffsetSeconds}`);
    }
    if (ownedLines.length === 0) errors.push(`${headersKey}:${header.id}:missing-lines`);
    for (const line of ownedLines) {
      if (line.line_remark !== "A126 日常可用性验收"
        || String(line.product_id) !== String(route.product_id)
        || String(line.warehouse_id) !== String(route.warehouse_id)
        || batchFromMarker(line.customer_order_no) !== batch) {
        errors.push(`${linesKey}:${line.id}:marker-or-route-drift`);
      }
    }
    result.set(String(header.id), batch);
  }
  return result;
}

function sameDate(left, right) {
  return String(left ?? "") === String(right ?? "");
}

function postingBaseMatches(txn, header, { txnType, action, traceQuality, sourceBillType }) {
  return txn.txn_type === txnType
    && txn.posting_action === action
    && txn.trace_quality === traceQuality
    && txn.source_bill_type === sourceBillType
    && String(txn.source_bill_id) === String(header.id)
    && txn.source_bill_no === header.bill_no
    && sameDate(txn.source_bill_date, header.bill_date)
    && txn.reversal_of_txn_id == null;
}

function compareNumericMultiset(actualValues, expectedValues) {
  const normalized = (values) => values.map(Number).sort((left, right) => left - right);
  const actual = normalized(actualValues);
  const expected = normalized(expectedValues);
  return actual.length === expected.length && actual.every((value, index) => value === expected[index]);
}

function matchForwardPosting(actual, header, lines, { txnType, action, exactSourceBillType, headerSourceBillType, quantityForLine }) {
  const exactRows = actual.filter((txn) => postingBaseMatches(txn, header, {
    txnType,
    action,
    traceQuality: "EXACT",
    sourceBillType: exactSourceBillType
  }));
  const headerRows = actual.filter((txn) => postingBaseMatches(txn, header, {
    txnType,
    action,
    traceQuality: "HEADER_ONLY",
    sourceBillType: `${headerSourceBillType}:${header.bill_no}`
  }));

  const exactIds = new Set();
  let exactValid = exactRows.length === lines.length;
  for (const line of lines) {
    const matches = exactRows.filter((txn) => String(txn.source_bill_line_id) === String(line.id)
      && Number(txn.qty_delta) === quantityForLine(line));
    if (matches.length !== 1) exactValid = false;
    else exactIds.add(String(matches[0].id));
  }
  exactValid = exactValid && exactIds.size === exactRows.length;

  const headerValid = headerRows.length === lines.length
    && headerRows.every((txn) => txn.source_bill_line_id == null)
    && compareNumericMultiset(headerRows.map((txn) => txn.qty_delta), lines.map(quantityForLine));

  if (exactValid && headerRows.length === 0) return { valid: true, ids: [...exactIds], mode: "EXACT" };
  if (headerValid && exactRows.length === 0) return { valid: true, ids: headerRows.map((txn) => String(txn.id)), mode: "HEADER_ONLY" };
  return {
    valid: false,
    ids: [],
    mode: "INVALID",
    details: {
      exactRows: exactRows.map((txn) => String(txn.id)).sort(),
      headerRows: headerRows.map((txn) => String(txn.id)).sort(),
      lineIds: lines.map((line) => String(line.id)).sort()
    }
  };
}

function analyzeSnapshot(snapshot) {
  assert(snapshot?.route && snapshot?.balance, "A184 A126 historical route or balance is unavailable");
  assert(snapshot.route.account_set_code === "BLD-TEST" && snapshot.route.schema_name === "public", "A184 A126 historical route escaped BLD-TEST/public", snapshot.route);
  assert(Object.values(snapshot.external ?? {}).every((value) => Number(value) === 0), "A184 A126 historical snapshot has external consumers", snapshot.external);
  const errorsByBatch = new Map(snapshot.batches.map((batch) => [batch, []]));
  const quoteBatch = assignHeaderBatches(snapshot, "quotes", "quoteLines", "quote_id", snapshot.route, snapshot.knownCreators, errorsByBatch);
  const orderBatch = assignHeaderBatches(snapshot, "orders", "orderLines", "order_id", snapshot.route, snapshot.knownCreators, errorsByBatch);
  const noticeBatch = assignHeaderBatches(snapshot, "notices", "noticeLines", "bill_id", snapshot.route, snapshot.knownCreators, errorsByBatch);
  const outBatch = assignHeaderBatches(snapshot, "outs", "outLines", "bill_id", snapshot.route, snapshot.knownCreators, errorsByBatch);
  const billBatchById = new Map([...quoteBatch, ...orderBatch, ...noticeBatch, ...outBatch]);
  const billBatchByNo = new Map();
  for (const key of ["quotes", "orders", "notices", "outs"]) {
    for (const header of dataRows(snapshot[key])) billBatchByNo.set(header.bill_no, billBatchById.get(String(header.id)));
  }
  const lineBatchById = new Map();
  for (const [key, parentKey, headerMap] of [
    ["quoteLines", "quote_id", quoteBatch], ["orderLines", "order_id", orderBatch],
    ["noticeLines", "bill_id", noticeBatch], ["outLines", "bill_id", outBatch]
  ]) {
    for (const line of dataRows(snapshot[key])) lineBatchById.set(String(line.id), headerMap.get(String(line[parentKey])));
  }

  const quoteByNo = new Map(dataRows(snapshot.quotes).map((row) => [row.bill_no, row]));
  const orderByNo = new Map(dataRows(snapshot.orders).map((row) => [row.bill_no, row]));
  const noticeByNo = new Map(dataRows(snapshot.notices).map((row) => [row.bill_no, row]));
  const quoteById = new Map(dataRows(snapshot.quotes).map((row) => [String(row.id), row]));
  const orderById = new Map(dataRows(snapshot.orders).map((row) => [String(row.id), row]));
  const noticeById = new Map(dataRows(snapshot.notices).map((row) => [String(row.id), row]));
  const quoteLineKeys = new Set(dataRows(snapshot.quoteLines).map((line) => `${quoteById.get(String(line.quote_id))?.bill_no}\0${line.line_no}`));
  const orderLineKeys = new Set(dataRows(snapshot.orderLines).map((line) => `${orderById.get(String(line.order_id))?.bill_no}\0${line.line_no}`));
  const noticeLineKeys = new Set(dataRows(snapshot.noticeLines).map((line) => `${noticeById.get(String(line.bill_id))?.bill_no}\0${line.line_no}`));
  const validateStringSource = (batch, ownerKind, ownerId, sourceNo, sourceLineNo, sourceHeaders, sourceLineKeys) => {
    if (sourceNo == null || String(sourceNo).trim() === "") return;
    const source = sourceHeaders.get(String(sourceNo));
    const sourceBatch = source ? billBatchById.get(String(source.id)) : "";
    if (!source || sourceBatch !== batch || !sourceLineKeys.has(`${sourceNo}\0${sourceLineNo}`)) {
      errorsByBatch.get(batch).push(`${ownerKind}:${ownerId}:foreign-or-missing-source:${sourceNo}:${sourceLineNo}`);
    }
  };
  for (const line of dataRows(snapshot.orderLines)) {
    const batch = lineBatchById.get(String(line.id));
    validateStringSource(batch, "orderLine", line.id, line.source_order_no, line.source_line_no, quoteByNo, quoteLineKeys);
  }
  for (const line of dataRows(snapshot.noticeLines)) {
    const batch = lineBatchById.get(String(line.id));
    validateStringSource(batch, "noticeLine", line.id, line.source_order_no, line.source_line_no, orderByNo, orderLineKeys);
  }
  for (const line of dataRows(snapshot.outLines)) {
    const batch = lineBatchById.get(String(line.id));
    validateStringSource(batch, "outLineOrder", line.id, line.source_order_no, line.source_line_no, orderByNo, orderLineKeys);
    const deliveryNo = String(line.source_delivery_notice_no ?? "");
    if (deliveryNo) {
      const usesNotice = noticeByNo.has(deliveryNo);
      validateStringSource(batch, "outLineNotice", line.id, deliveryNo, line.source_delivery_line_no,
        usesNotice ? noticeByNo : orderByNo, usesNotice ? noticeLineKeys : orderLineKeys);
    }
  }
  for (const out of dataRows(snapshot.outs)) {
    const batch = outBatch.get(String(out.id));
    for (const [field, sourceMap, label] of [
      ["source_order_id", orderBatch, "order"],
      ["source_delivery_notice_id", noticeBatch, "notice"],
      ["red_source_bill_id", outBatch, "red-source"]
    ]) {
      if (out[field] != null && sourceMap.get(String(out[field])) !== batch) {
        errorsByBatch.get(batch).push(`out:${out.id}:foreign-${label}:${out[field]}`);
      }
    }
  }

  const txnBatch = new Map();
  const seedIds = new Set(snapshot.seedTxns.map((row) => row.id));
  for (const envelopeRow of snapshot.transactions) {
    const txn = envelopeRow.data;
    let batch = "";
    if (seedIds.has(envelopeRow.id)) batch = /^A126_SEED:(\d{14}):/.exec(txn.source_bill_type)?.[1] ?? "";
    else batch = lineBatchById.get(String(txn.source_bill_line_id))
      || billBatchById.get(String(txn.source_bill_id))
      || billBatchByNo.get(txn.source_bill_no)
      || "";
    assert(batchPattern.test(batch), "A184 A126 historical transaction cannot be assigned to one batch", txn);
    txnBatch.set(envelopeRow.id, batch);
  }

  const txnsByBatch = new Map(snapshot.batches.map((batch) => [batch, []]));
  for (const row of snapshot.transactions) txnsByBatch.get(txnBatch.get(row.id)).push(row.data);
  const noticeLinesById = new Map(dataRows(snapshot.noticeLines).map((row) => [String(row.id), row]));
  const outLinesById = new Map(dataRows(snapshot.outLines).map((row) => [String(row.id), row]));
  const noticesByBatch = new Map(snapshot.batches.map((batch) => [batch, []]));
  for (const row of dataRows(snapshot.notices)) noticesByBatch.get(noticeBatch.get(String(row.id))).push(row);
  const outsByBatch = new Map(snapshot.batches.map((batch) => [batch, []]));
  for (const row of dataRows(snapshot.outs)) outsByBatch.get(outBatch.get(String(row.id))).push(row);

  for (const batch of snapshot.batches) {
    const errors = errorsByBatch.get(batch);
    const actual = txnsByBatch.get(batch);
    const batchSeeds = snapshot.seedTxns.filter((row) => /^A126_SEED:(\d{14}):/.exec(row.data.source_bill_type)?.[1] === batch);
    const expectedTxnIds = new Set();
    for (const row of batchSeeds) {
      const seed = row.data;
      const knownLegacyShape = seed.txn_type === "A126_SEED"
        && ((seed.posting_action === "AUDIT" && seed.trace_quality === "TEST")
          || (seed.posting_action == null && seed.trace_quality == null))
        && Number(seed.qty_delta) > 0
        && seed.reversal_of_txn_id == null;
      if (!knownLegacyShape) errors.push(`seed:${row.id}:unsupported-shape`);
      else expectedTxnIds.add(String(row.id));
    }
    for (const notice of noticesByBatch.get(batch)) {
      const lines = [...noticeLinesById.values()].filter((line) => String(line.bill_id) === String(notice.id));
      if (notice.status === "AUDITED") {
        const match = matchForwardPosting(actual, notice, lines, {
          txnType: "DELIVERY_NOTICE_RESERVE",
          action: "RESERVE",
          exactSourceBillType: "DELIVERY_NOTICE",
          headerSourceBillType: "DELIVERY_NOTICE",
          quantityForLine: () => 0
        });
        if (!match.valid) errors.push(`notice:${notice.bill_no}:reserve-closure=${JSON.stringify(match.details)}`);
        else for (const id of match.ids) expectedTxnIds.add(id);
      }
    }
    for (const out of outsByBatch.get(batch)) {
      const lines = [...outLinesById.values()].filter((line) => String(line.bill_id) === String(out.id));
      const red = Boolean(out.red_source_bill_id);
      const requiresForwardFact = out.status === "AUDITED" || (red && out.status === "RED_REVERSED");
      if (requiresForwardFact) {
        const match = matchForwardPosting(actual, out, lines, {
          txnType: red ? "SALES_OUT_RED" : "SALES_OUT",
          action: red ? "RED_AUDIT" : "AUDIT",
          exactSourceBillType: "SALES_OUT",
          headerSourceBillType: red ? "SALES_OUT_RED" : "SALES_OUT",
          quantityForLine: (line) => red ? Math.abs(Number(line.qty)) : -Math.abs(Number(line.qty))
        });
        if (!match.valid) errors.push(`out:${out.bill_no}:${red ? "RED_AUDIT" : "AUDIT"}-closure=${JSON.stringify(match.details)}`);
        else for (const id of match.ids) expectedTxnIds.add(id);
      }
    }
    const extra = actual.filter((txn) => !expectedTxnIds.has(String(txn.id)));
    if (extra.length > 0) errors.push(`unexpected-postings:${extra.map((txn) => txn.id).sort().join(",")}`);
  }

  const tableBatch = new Map();
  for (const [key, mapping] of [["quotes", quoteBatch], ["orders", orderBatch], ["notices", noticeBatch], ["outs", outBatch]]) {
    for (const row of snapshot[key]) tableBatch.set(`${key}:${row.id}`, mapping.get(row.id));
  }
  for (const [key, parentKey, mapping] of [
    ["quoteLines", "quote_id", quoteBatch], ["orderLines", "order_id", orderBatch],
    ["noticeLines", "bill_id", noticeBatch], ["outLines", "bill_id", outBatch]
  ]) {
    for (const row of snapshot[key]) tableBatch.set(`${key}:${row.id}`, mapping.get(String(row.data[parentKey])));
  }
  for (const row of snapshot.transactions) tableBatch.set(`transactions:${row.id}`, txnBatch.get(row.id));
  const outByNo = new Map(dataRows(snapshot.outs).map((row) => [row.bill_no, row]));
  for (const row of snapshot.receivables) {
    const receivable = row.data;
    const batch = billBatchByNo.get(receivable.source_bill_no);
    if (!batchPattern.test(String(batch ?? ""))) {
      assert(false, "A184 A126 historical receivable cannot be assigned to one batch", row);
    }
    const sourceOut = outByNo.get(receivable.source_bill_no);
    const expectedReceivableNo = sourceOut?.red_source_bill_id == null
      ? `YS-${receivable.source_bill_no}`
      : `YS-HC-${javaUnsignedBase36(receivable.source_bill_no)}`;
    if (!sourceOut
      || String(receivable.customer_id) !== String(snapshot.route.customer_id)
      || receivable.bill_no !== expectedReceivableNo
      || String(receivable.bill_date) !== String(sourceOut.bill_date)
      || Number(receivable.amount) !== Number(sourceOut.total_amount)
      || receivable.currency !== "CNY"
      || receivable.status !== "OPEN"
      || Number(receivable.received_amount) !== 0
      || Number(receivable.return_offset_amount) !== 0) {
      errorsByBatch.get(batch).push(`receivable:${row.id}:route-or-lifecycle-drift`);
    }
    tableBatch.set(`receivables:${row.id}`, batch);
  }
  const targetBatchById = new Map([...billBatchById]);
  for (const row of snapshot.receivables) targetBatchById.set(row.id, billBatchByNo.get(row.data.source_bill_no));
  for (const row of snapshot.logs) {
    const log = row.data;
    const batch = targetBatchById.get(String(log.target_id)) || billBatchByNo.get(log.target_no);
    if (!batchPattern.test(String(batch ?? ""))) {
      assert(false, "A184 A126 historical operation log cannot be assigned to one batch", row);
    }
    const actorShapeValid = (log.actor_type === "HISTORICAL_UNKNOWN" && log.actor_username == null && log.operated_by == null)
      || (log.actor_type === "USER" && ["admin", "warehouse"].includes(log.actor_username));
    if (String(log.account_set_id) !== String(snapshot.route.account_set_id)
      || log.account_set_code !== "BLD-TEST"
      || !actorShapeValid) {
      errorsByBatch.get(batch).push(`log:${row.id}:tenant-or-actor-drift`);
    }
    tableBatch.set(`logs:${row.id}`, batch);
  }

  const eligibleBatches = snapshot.batches.filter((batch) => errorsByBatch.get(batch).length === 0).sort();
  const blockedBatches = snapshot.batches.filter((batch) => errorsByBatch.get(batch).length > 0).sort().map((batch) => ({
    batch,
    reason: "MISSING_OR_NONCANONICAL_POSTING_CLOSURE",
    details: errorsByBatch.get(batch).sort()
  }));
  const eligible = new Set(eligibleBatches);

  const kinds = ["quotes", "quoteLines", "orders", "orderLines", "notices", "noticeLines", "outs", "outLines", "transactions", "receivables", "logs"];
  const entries = [];
  const blockedEntries = [];
  for (const kind of kinds) {
    for (const row of snapshot[kind]) {
      const batch = tableBatch.get(`${kind}:${row.id}`);
      assert(batchPattern.test(String(batch ?? "")), `A184 A126 historical ${kind} row cannot be assigned to one batch`, row);
      const entry = {
        kind,
        id: row.id,
        rowHash: row.rowHash,
        batch,
        billNo: row.data.bill_no ?? row.data.source_bill_no ?? row.data.target_no ?? ""
      };
      (eligible.has(batch) ? entries : blockedEntries).push(entry);
    }
  }
  entries.sort((left, right) => `${left.kind}\0${left.id}`.localeCompare(`${right.kind}\0${right.id}`));
  blockedEntries.sort((left, right) => `${left.kind}\0${left.id}`.localeCompare(`${right.kind}\0${right.id}`));

  const eligibleTxns = snapshot.transactions.filter((row) => eligible.has(txnBatch.get(row.id))).map((row) => row.data);
  const onHandDelta = eligibleTxns.reduce((sum, txn) => sum + Number(txn.qty_delta), 0);
  let reservedDelta = 0;
  for (const notice of dataRows(snapshot.notices)) {
    if (eligible.has(noticeBatch.get(String(notice.id))) && notice.status === "AUDITED") {
      reservedDelta += [...noticeLinesById.values()]
        .filter((line) => String(line.bill_id) === String(notice.id))
        .reduce((sum, line) => sum + Math.abs(Number(line.qty)), 0);
    }
  }
  for (const txn of eligibleTxns) {
    if (txn.txn_type === "SALES_OUT" && txn.posting_action === "AUDIT") {
      reservedDelta += Number(txn.qty_delta);
    } else if (txn.txn_type === "SALES_OUT_RED" && txn.posting_action === "RED_AUDIT") {
      reservedDelta += Number(txn.qty_delta);
    } else if (txn.txn_type !== "DELIVERY_NOTICE_RESERVE" && !String(txn.source_bill_type).startsWith("A126_SEED:")) {
      assert(false, "A184 A126 eligible posting has an unsupported reservation action", txn);
    }
  }
  const balance = snapshot.balance.data;
  const projectedBalance = {
    qtyOnHand: Number(balance.qty_on_hand) - onHandDelta,
    qtyReserved: Number(balance.qty_reserved) - reservedDelta
  };
  projectedBalance.qtyAvailable = projectedBalance.qtyOnHand - projectedBalance.qtyReserved;
  assert([projectedBalance.qtyOnHand, projectedBalance.qtyReserved, projectedBalance.qtyAvailable].every((value) => Number.isFinite(value) && value >= 0),
    "A184 A126 historical projected balance is invalid", projectedBalance);
  const counts = Object.fromEntries(kinds.map((kind) => [kind, entries.filter((row) => row.kind === kind).length]));
  const blockedCounts = Object.fromEntries(kinds.map((kind) => [kind, blockedEntries.filter((row) => row.kind === kind).length]));
  const result = {
    route: snapshot.route,
    eligibleBatches,
    blockedBatches,
    entries,
    blockedEntries,
    counts,
    blockedCounts,
    deltas: { onHand: onHandDelta, reserved: reservedDelta, available: onHandDelta - reservedDelta },
    currentBalance: balance,
    ledger: snapshot.ledger,
    applyDisposition: {
      status: "BLOCKED_APPEND_ONLY_CONTRACT",
      reason: "Physical deletion would make the latest retained qty_on_hand_after differ from the projected balance; rewriting retained facts is forbidden.",
      requiredNextTask: "Design an append-only three-quantity recovery journal or authorize a separately archived historical-restatement migration."
    },
    balance: { id: snapshot.balance.id, rowHash: snapshot.balance.rowHash },
    projectedBalance,
    external: snapshot.external
  };
  return { ...result, manifestDigest: calculateManifestDigest(result) };
}

async function atomicWrite(filePath, value) {
  await mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.tmp`;
  await writeFile(tempPath, JSON.stringify(value, null, 2), { mode: 0o600 });
  await rename(tempPath, filePath);
}

function argumentValue(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? String(process.argv[index + 1] ?? "") : "";
}

function kindTable(kind) {
  return new Map([
    ["quotes", "sales_quote"], ["quoteLines", "sales_quote_line"],
    ["orders", "sales_order"], ["orderLines", "sales_order_line"],
    ["notices", "delivery_notice"], ["noticeLines", "delivery_notice_line"],
    ["outs", "sales_out"], ["outLines", "sales_out_line"],
    ["transactions", "inv_stock_txn"], ["receivables", "ar_receivable"],
    ["logs", "sys_operation_log"]
  ]).get(kind);
}

function validateHistoricalManifest(manifest) {
  assert(manifest?.mode === "dry-run", "A184 A126 apply requires a dry-run manifest");
  assert(Array.isArray(manifest.eligibleBatches) && Array.isArray(manifest.blockedBatches)
    && Array.isArray(manifest.entries) && Array.isArray(manifest.blockedEntries), "A184 A126 manifest arrays are invalid");
  assert(manifest.eligibleBatches.length === 76, "A184 A126 apply refuses a scope other than the reviewed 76 eligible batches", manifest.eligibleBatches.length);
  assert(manifest.blockedBatches.length === 1 && manifest.blockedBatches[0]?.batch === "20260714063721",
    "A184 A126 apply requires the known incomplete batch to remain the sole blocked batch", manifest.blockedBatches);
  assert(manifest.deltas?.onHand === 72112 && manifest.deltas?.reserved === 20950,
    "A184 A126 manifest inventory transform differs from the reviewed transform", manifest.deltas);
  const expectedCounts = {
    quotes: 74, quoteLines: 74, orders: 839, orderLines: 839, notices: 1120, noticeLines: 1252,
    outs: 576, outLines: 576, transactions: 1768, receivables: 432, logs: 2727
  };
  const expectedBlockedCounts = {
    quotes: 1, quoteLines: 1, orders: 12, orderLines: 12, notices: 16, noticeLines: 18,
    outs: 8, outLines: 8, transactions: 7, receivables: 6, logs: 46
  };
  const eligibleSet = new Set(manifest.eligibleBatches);
  const blockedSet = new Set(manifest.blockedBatches.map((row) => row.batch));
  assert(eligibleSet.size === 76 && [...eligibleSet].every((batch) => batchPattern.test(batch) && !blockedSet.has(batch)),
    "A184 A126 manifest batch ownership is invalid");
  assert(JSON.stringify([...manifest.eligibleBatches].sort()) === JSON.stringify(manifest.eligibleBatches)
    && sha256(JSON.stringify(manifest.eligibleBatches)) === "21c97f3e07873e6c18efd635415aeb303a34128b60481f0be5724e8772afc303",
  "A184 A126 eligible batch set differs from the independently reviewed allowlist");
  const seen = new Set();
  for (const [rows, expectedSet, label] of [[manifest.entries, eligibleSet, "eligible"], [manifest.blockedEntries, blockedSet, "blocked"]]) {
    for (const row of rows) {
      assert(kindTable(row.kind) && uuidPattern.test(String(row.id)) && /^[0-9a-f]{64}$/.test(String(row.rowHash))
        && expectedSet.has(row.batch), `A184 A126 ${label} manifest row is invalid`, row);
      const key = `${row.kind}\0${row.id}`;
      assert(!seen.has(key), "A184 A126 manifest row is duplicated", row);
      seen.add(key);
    }
  }
  for (const [kind, count] of Object.entries(expectedCounts)) {
    assert(manifest.entries.filter((row) => row.kind === kind).length === count && manifest.counts?.[kind] === count,
      `A184 A126 eligible ${kind} count differs from the reviewed allowlist`);
  }
  for (const [kind, count] of Object.entries(expectedBlockedCounts)) {
    assert(manifest.blockedEntries.filter((row) => row.kind === kind).length === count && manifest.blockedCounts?.[kind] === count,
      `A184 A126 blocked ${kind} count differs from the reviewed preserve set`);
  }
  assert(uuidPattern.test(String(manifest.balance?.id)) && /^[0-9a-f]{64}$/.test(String(manifest.balance?.rowHash)),
    "A184 A126 manifest balance identity is invalid", manifest.balance);
  assert(manifest.route?.account_set_code === "BLD-TEST" && manifest.route?.schema_name === "public"
    && manifest.route?.product_code === "CP-001" && manifest.route?.warehouse_code === "CK-001"
    && manifest.route?.customer_code === "KH-001", "A184 A126 manifest route escaped the reviewed test scope", manifest.route);
  assert(String(manifest.currentBalance?.id) === String(manifest.balance.id), "A184 A126 manifest balance payload identity drifted");
  assert(Object.values(manifest.external ?? {}).every((value) => Number(value) === 0), "A184 A126 manifest contains external consumers", manifest.external);
  assert(Number(manifest.currentBalance.qty_available) === Number(manifest.currentBalance.qty_on_hand) - Number(manifest.currentBalance.qty_reserved),
    "A184 A126 current balance invariant is invalid");
  assert(Number.isInteger(Number(manifest.ledger?.count)) && Number(manifest.ledger.count) > expectedCounts.transactions
    && uuidPattern.test(String(manifest.ledger?.latestId))
    && Number(manifest.ledger?.latestAfter) === Number(manifest.currentBalance.qty_on_hand),
  "A184 A126 manifest ledger tail does not match the controlled balance", manifest.ledger);
  assert(manifest.applyDisposition?.status === "BLOCKED_APPEND_ONLY_CONTRACT",
    "A184 A126 historical manifest must remain fail-closed until a separate recovery design is authorized", manifest.applyDisposition);
  assert(manifest.projectedBalance?.qtyOnHand === Number(manifest.currentBalance.qty_on_hand) - manifest.deltas.onHand
    && manifest.projectedBalance?.qtyReserved === Number(manifest.currentBalance.qty_reserved) - manifest.deltas.reserved
    && manifest.projectedBalance?.qtyAvailable === manifest.projectedBalance.qtyOnHand - manifest.projectedBalance.qtyReserved,
  "A184 A126 projected balance does not match the reviewed transform");
  assert(calculateManifestDigest(manifest) === manifest.manifestDigest, "A184 A126 manifest contents do not match their digest");
}

function applyHistoricalManifest(manifest, { verifyOnly = false } = {}) {
  validateHistoricalManifest(manifest);
  if (verifyOnly) {
    const current = analyzeSnapshot(captureHistoricalSnapshot());
    validateHistoricalManifest({ ...manifest, ...current, mode: "dry-run" });
    assert(current.manifestDigest === manifest.manifestDigest,
      "A184 A126 historical database state no longer matches the frozen manifest", {
        expected: manifest.manifestDigest,
        actual: current.manifestDigest
      });
    return {
      verified: true,
      digest: manifest.manifestDigest,
      eligibleBatchCount: manifest.eligibleBatches.length,
      blockedBatchCount: manifest.blockedBatches.length,
      applyDisposition: manifest.applyDisposition
    };
  }
  throw new Error("A184 A126 historical physical apply is blocked: deleting posted facts would break append-only qty_on_hand_after; authorize a separate append-only recovery journal or historical-restatement migration");
}

const applyRequested = process.argv.includes("--apply");
const verifyRequested = process.argv.includes("--verify-manifest");
assert(!(applyRequested && verifyRequested), "A184 A126 recovery accepts either --apply or --verify-manifest, not both");
if (!applyRequested && !verifyRequested) {
  const snapshot = captureHistoricalSnapshot();
  const analysis = analyzeSnapshot(snapshot);
  const artifact = {
    taskId: "A184",
    mode: "dry-run",
    generatedAt: new Date().toISOString(),
    route: snapshot.route,
    snapshotCapturedAt: snapshot.capturedAt,
    ...analysis
  };
  await atomicWrite(dryRunPath, artifact);
  console.log(JSON.stringify({
    ok: true,
    mode: "dry-run",
    manifestPath: path.relative(rootDir, dryRunPath),
    manifestDigest: artifact.manifestDigest,
    eligibleBatchCount: artifact.eligibleBatches.length,
    blockedBatches: artifact.blockedBatches,
    counts: artifact.counts,
    deltas: artifact.deltas,
    projectedBalance: artifact.projectedBalance
  }, null, 2));
} else {
  const manifestPath = argumentValue("--manifest");
  const suppliedDigest = argumentValue("--digest");
  assert(manifestPath && suppliedDigest, "A184 A126 apply requires --manifest <path> --digest <exact-digest>");
  const absoluteManifestPath = path.resolve(rootDir, manifestPath);
  assert(absoluteManifestPath.startsWith(`${verificationDir}${path.sep}`), "A184 A126 apply only accepts a verification manifest");
  const manifest = JSON.parse(await readFile(absoluteManifestPath, "utf8"));
  assert(manifest.manifestDigest === suppliedDigest, "A184 A126 supplied digest does not match the manifest");
  validateHistoricalManifest(manifest);
  const result = applyHistoricalManifest(manifest, { verifyOnly: verifyRequested });
  const resultPath = path.join(verificationDir, `a184-a126-historical-${verifyRequested ? "verify" : "apply"}-${timestamp}.json`);
  await atomicWrite(resultPath, {
    taskId: "A184",
    mode: verifyRequested ? "verify-manifest" : "apply",
    generatedAt: new Date().toISOString(),
    manifestPath: path.relative(rootDir, absoluteManifestPath),
    manifestDigest: suppliedDigest,
    result
  });
  console.log(JSON.stringify({ ok: true, resultPath: path.relative(rootDir, resultPath), result }, null, 2));
}
