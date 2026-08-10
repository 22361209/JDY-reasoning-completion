import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function assert(condition, message, details = undefined) {
  if (!condition) {
    throw new Error(`${message}${details === undefined ? "" : ` ${JSON.stringify(details)}`}`);
  }
}

function deterministicTestId(namespace, value) {
  const bytes = createHash("md5").update(`${namespace}:${value}`).digest();
  bytes[6] = (bytes[6] & 0x0f) | 0x30;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function sqlLiteral(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function jsonbSql(value) {
  return `${sqlLiteral(JSON.stringify(value))}::jsonb`;
}

export function dbScalar(sql, label = "A126 database command") {
  return execFileSync(
    "docker",
    ["exec", "jdy-erp-postgres", "psql", "-X", "-U", "jdy", "-d", "jdy_erp", "-v", "ON_ERROR_STOP=1", "-tAq", "-c", sql],
    { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 }
  ).trim();
}

export function dbJson(sql, label = "A126 database query") {
  const text = dbScalar(`${sql.trim()}\n`, label);
  return text ? JSON.parse(text) : null;
}

function normalizedBalanceSql(alias) {
  return `(to_jsonb(${alias}) || jsonb_build_object(
    'qty_on_hand', ${alias}.qty_on_hand::text,
    'qty_available', ${alias}.qty_available::text,
    'qty_reserved', ${alias}.qty_reserved::text,
    'unit_cost', ${alias}.unit_cost::text,
    'amount', ${alias}.amount::text,
    'version', ${alias}.version::text
  ))`;
}

function normalizedTransactionSql(alias) {
  return `(to_jsonb(${alias}) || jsonb_build_object(
    'qty_delta', ${alias}.qty_delta::text,
    'unit_cost', ${alias}.unit_cost::text,
    'amount', ${alias}.amount::text,
    'qty_on_hand_after', ${alias}.qty_on_hand_after::text
  ))`;
}

function transactionDigestSql(predicate = "TRUE") {
  return `(
    SELECT jsonb_build_object(
      'count', count(*),
      'rowDigest', encode(digest(COALESCE(string_agg(${normalizedTransactionSql("digest_txn")}::text, E'\\n' ORDER BY digest_txn.occurred_at, digest_txn.id::text), ''), 'sha256'), 'hex'),
      'idDigest', encode(digest(COALESCE(string_agg(digest_txn.id::text, E'\\n' ORDER BY digest_txn.id::text), ''), 'sha256'), 'hex')
    )
    FROM public.inv_stock_txn digest_txn, lookup
    WHERE digest_txn.account_set_id=lookup.account_set_id
      AND digest_txn.product_id=lookup.product_id
      AND digest_txn.warehouse_id=lookup.warehouse_id
      AND (${predicate})
  )`;
}

function lookupCte() {
  return `lookup AS (
    SELECT account_set.id AS account_set_id,
           product.id AS product_id,
           warehouse.id AS warehouse_id,
           customer.id AS customer_id
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
  )`;
}

export function captureA126Baseline() {
  const baseline = dbJson(`
    WITH ${lookupCte()}
    SELECT jsonb_build_object(
      'capturedAt', clock_timestamp(),
      'accountSetId', lookup.account_set_id::text,
      'productId', lookup.product_id::text,
      'warehouseId', lookup.warehouse_id::text,
      'customerId', lookup.customer_id::text,
      'balance', (
        SELECT ${normalizedBalanceSql("balance")}
        FROM public.inv_stock_balance balance
        WHERE balance.account_set_id=lookup.account_set_id
          AND balance.product_id=lookup.product_id
          AND balance.warehouse_id=lookup.warehouse_id
      ),
      'transactions', ${transactionDigestSql()}
    )::text
    FROM lookup
  `, "A126 baseline capture");
  assert(baseline && uuidPattern.test(String(baseline.accountSetId ?? "")), "A126 baseline route is unavailable");
  assert(baseline.balance && uuidPattern.test(String(baseline.balance.id ?? "")), "A126 requires one existing controlled stock balance");
  return baseline;
}

function runCtes(config) {
  const marker = sqlLiteral(config.marker);
  const seedPrefix = sqlLiteral(config.seedPrefix);
  const startsWithMarker = (expression) => `left(COALESCE(${expression}, ''), ${config.marker.length + 1})=${sqlLiteral(`${config.marker}:`)}`;
  const lineOwns = (alias) => `(${alias}.customer_order_no=${marker} OR ${alias}.line_remark=${marker})`;
  return `
    ${lookupCte()},
    owned_quotes AS (
      SELECT DISTINCT header.* FROM public.sales_quote header
      WHERE ${startsWithMarker("header.remark")}
         OR EXISTS (SELECT 1 FROM public.sales_quote_line line WHERE line.quote_id=header.id AND ${lineOwns("line")})
    ),
    owned_quote_lines AS (
      SELECT line.* FROM public.sales_quote_line line JOIN owned_quotes header ON header.id=line.quote_id
    ),
    owned_orders AS (
      SELECT DISTINCT header.* FROM public.sales_order header
      WHERE ${startsWithMarker("header.remark")}
         OR EXISTS (SELECT 1 FROM public.sales_order_line line WHERE line.order_id=header.id AND ${lineOwns("line")})
    ),
    owned_order_lines AS (
      SELECT line.* FROM public.sales_order_line line JOIN owned_orders header ON header.id=line.order_id
    ),
    owned_notices AS (
      SELECT DISTINCT header.* FROM public.delivery_notice header
      WHERE ${startsWithMarker("header.remark")}
         OR EXISTS (SELECT 1 FROM public.delivery_notice_line line WHERE line.bill_id=header.id AND ${lineOwns("line")})
    ),
    owned_notice_lines AS (
      SELECT line.* FROM public.delivery_notice_line line JOIN owned_notices header ON header.id=line.bill_id
    ),
    owned_outs AS (
      SELECT DISTINCT header.* FROM public.sales_out header
      WHERE ${startsWithMarker("header.remark")}
         OR EXISTS (SELECT 1 FROM public.sales_out_line line WHERE line.bill_id=header.id AND ${lineOwns("line")})
    ),
    owned_out_lines AS (
      SELECT line.* FROM public.sales_out_line line JOIN owned_outs header ON header.id=line.bill_id
    ),
    owned_bills AS (
      SELECT 'sales_quote'::text AS kind, id, bill_no FROM owned_quotes
      UNION ALL SELECT 'sales_order', id, bill_no FROM owned_orders
      UNION ALL SELECT 'delivery_notice', id, bill_no FROM owned_notices
      UNION ALL SELECT 'sales_out', id, bill_no FROM owned_outs
    ),
    owned_bill_lines AS (
      SELECT id FROM owned_quote_lines
      UNION ALL SELECT id FROM owned_order_lines
      UNION ALL SELECT id FROM owned_notice_lines
      UNION ALL SELECT id FROM owned_out_lines
    ),
    owned_receivables AS (
      SELECT receivable.* FROM public.ar_receivable receivable
      WHERE receivable.source_bill_no IN (SELECT bill_no FROM owned_outs)
    ),
    owned_transactions AS (
      SELECT txn.* FROM public.inv_stock_txn txn
      WHERE left(txn.source_bill_type, ${config.seedPrefix.length})=${seedPrefix}
         OR txn.source_bill_id IN (SELECT id FROM owned_bills)
         OR txn.source_bill_line_id IN (SELECT id FROM owned_bill_lines)
         OR txn.source_bill_no IN (SELECT bill_no FROM owned_bills)
    ),
    owned_logs AS (
      SELECT log.* FROM public.sys_operation_log log
      WHERE log.target_id IN (SELECT id FROM owned_bills)
         OR log.target_id IN (SELECT id FROM owned_receivables)
         OR log.target_no IN (SELECT bill_no FROM owned_bills)
         OR log.target_no IN (SELECT 'YS-' || source_bill_no FROM owned_receivables)
    ),
    owned_locks AS (
      SELECT lock.* FROM public.doc_edit_lock lock
      WHERE lock.bill_no IN (SELECT bill_no FROM owned_bills)
    )
  `;
}

function aggregateSql(table, alias, rowSql = `to_jsonb(${alias})`, orderSql = `${alias}.id::text`) {
  return `(SELECT COALESCE(jsonb_agg(${rowSql} ORDER BY ${orderSql}), '[]'::jsonb) FROM ${table} ${alias})`;
}

function runSnapshotExpression(config) {
  const userIds = `ARRAY[${config.userIds.map((value) => `${sqlLiteral(value)}::uuid`).join(",")}]`;
  return `jsonb_build_object(
    'balance', (SELECT ${normalizedBalanceSql("balance")} FROM public.inv_stock_balance balance, lookup
      WHERE balance.account_set_id=lookup.account_set_id AND balance.product_id=lookup.product_id AND balance.warehouse_id=lookup.warehouse_id),
    'quotes', ${aggregateSql("owned_quotes", "row")},
    'quoteLines', ${aggregateSql("owned_quote_lines", "row")},
    'orders', ${aggregateSql("owned_orders", "row")},
    'orderLines', ${aggregateSql("owned_order_lines", "row")},
    'notices', ${aggregateSql("owned_notices", "row")},
    'noticeLines', ${aggregateSql("owned_notice_lines", "row")},
    'outs', ${aggregateSql("owned_outs", "row")},
    'outLines', ${aggregateSql("owned_out_lines", "row")},
    'receivables', ${aggregateSql("owned_receivables", "row")},
    'transactions', ${aggregateSql("owned_transactions", "row", normalizedTransactionSql("row"), "row.occurred_at, row.id::text")},
    'logs', ${aggregateSql("owned_logs", "row", "to_jsonb(row)", "row.operated_at, row.id::text")},
    'locks', ${aggregateSql("owned_locks", "row", "to_jsonb(row)", "row.document_type, row.bill_no, row.holder_user_id::text")},
    'nonOwnedTransactions', ${transactionDigestSql("NOT EXISTS (SELECT 1 FROM owned_transactions owned WHERE owned.id=digest_txn.id)")},
    'external', jsonb_build_object(
      'salesOrders', (SELECT count(*) FROM public.sales_order_line line WHERE line.order_id NOT IN (SELECT id FROM owned_orders) AND line.source_order_no IN (SELECT bill_no FROM owned_quotes)),
      'deliveryNotices', (SELECT count(*) FROM public.delivery_notice_line line WHERE line.bill_id NOT IN (SELECT id FROM owned_notices) AND line.source_order_no IN (SELECT bill_no FROM owned_orders)),
      'salesOutHeaders', (SELECT count(*) FROM public.sales_out header WHERE header.id NOT IN (SELECT id FROM owned_outs) AND (header.source_order_id IN (SELECT id FROM owned_orders) OR header.source_delivery_notice_id IN (SELECT id FROM owned_notices))),
      'salesOuts', (SELECT count(*) FROM public.sales_out_line line WHERE line.bill_id NOT IN (SELECT id FROM owned_outs) AND (line.source_order_no IN (SELECT bill_no FROM owned_orders) OR line.source_delivery_notice_no IN (SELECT bill_no FROM owned_notices))),
      'redSalesOuts', (SELECT count(*) FROM public.sales_out header WHERE header.id NOT IN (SELECT id FROM owned_outs) AND header.red_source_bill_id IN (SELECT id FROM owned_outs)),
      'salesReturns', (SELECT count(*) FROM public.sales_return_line line WHERE line.source_out_line_id IN (SELECT id FROM owned_out_lines)),
      'legacyReceipts', (SELECT count(*) FROM public.ar_receipt receipt WHERE receipt.legacy_receivable_id IN (SELECT id FROM owned_receivables)),
      'receiptAllocations', (SELECT count(*) FROM public.ar_receipt_allocation allocation WHERE allocation.receivable_id IN (SELECT id FROM owned_receivables)),
      'returnAllocations', (SELECT count(*) FROM public.sales_return_finance_allocation allocation WHERE allocation.receivable_id IN (SELECT id FROM owned_receivables)),
      'outboxEvents', (SELECT count(*) FROM public.sys_outbox_event event WHERE event.aggregate_id IN (SELECT id FROM owned_bills) OR event.aggregate_id IN (SELECT id FROM owned_receivables)),
      'notifications', (SELECT count(*) FROM public.sys_notification_outbox notification WHERE notification.source_id IN (SELECT id FROM owned_bills) OR notification.source_id IN (SELECT id FROM owned_receivables)),
      'foreignLocks', (SELECT count(*) FROM owned_locks lock WHERE NOT (lock.holder_user_id=ANY(${userIds})))
    )
  )`;
}

function runSnapshotSql(config) {
  return `WITH ${runCtes(config)} SELECT ${runSnapshotExpression(config)} AS snapshot`;
}

export function captureA126RunSnapshot(config) {
  const envelope = dbJson(`
    WITH ${runCtes(config)}, frozen AS (
      SELECT ${runSnapshotExpression(config)} AS snapshot
    )
    SELECT jsonb_build_object(
      'snapshot', snapshot,
      'snapshotDigest', encode(digest(snapshot::text, 'sha256'), 'hex')
    )::text
    FROM frozen
  `, "A126 run snapshot");
  assert(envelope?.snapshot && /^[0-9a-f]{64}$/.test(String(envelope.snapshotDigest ?? "")),
    "A126 run snapshot did not return its database canonical digest", envelope);
  envelope.snapshot.snapshotDigest = envelope.snapshotDigest;
  return envelope.snapshot;
}

function numeric(value) {
  return value == null ? 0 : Number(value);
}

function byId(rows) {
  return new Map(rows.map((row) => [String(row.id), row]));
}

function isOwnedHeader(row, config, kind, userIds, customerId) {
  const expectedRemark = `${config.marker}:${kind}`;
  const red = kind === "out" && row.red_source_bill_id;
  return (userIds.has(String(row.created_by)) || (red && row.created_by == null))
    && String(row.customer_id) === customerId
    && String(row.bill_date) === config.billDate
    && new Date(row.created_at).getTime() >= new Date(config.startedAt).getTime()
    && (red ? (row.remark == null || row.remark === "") : row.remark === expectedRemark);
}

export function validateA126RunSnapshot({ baseline, snapshot, config }) {
  assert(snapshot?.balance, "A126 cleanup snapshot lost the controlled balance");
  const userIds = new Set(config.userIds.map(String));
  const customerId = String(baseline.customerId);
  const productId = String(baseline.productId);
  const warehouseId = String(baseline.warehouseId);
  const accountSetId = String(baseline.accountSetId);
  const documentSets = [
    ["quote", snapshot.quotes, snapshot.quoteLines, "quote_id"],
    ["order", snapshot.orders, snapshot.orderLines, "order_id"],
    ["notice", snapshot.notices, snapshot.noticeLines, "bill_id"],
    ["out", snapshot.outs, snapshot.outLines, "bill_id"]
  ];
  for (const [kind, headers, lines, parentKey] of documentSets) {
    const headerIds = new Set(headers.map((row) => String(row.id)));
    for (const header of headers) {
      assert(isOwnedHeader(header, config, kind, userIds, customerId), `A126 ${kind} ownership drifted`, header);
      assert(lines.some((line) => String(line[parentKey]) === String(header.id)), `A126 ${kind} has no owned line`, header);
    }
    for (const line of lines) {
      assert(headerIds.has(String(line[parentKey])), `A126 ${kind} line escaped its owned header`, line);
      assert(line.customer_order_no === config.marker && line.line_remark === config.marker, `A126 ${kind} line marker drifted`, line);
      assert(String(line.product_id) === productId && String(line.warehouse_id) === warehouseId, `A126 ${kind} line master-data boundary drifted`, line);
      assert(numeric(line.qty) !== 0, `A126 ${kind} line quantity must be non-zero`, line);
    }
  }

  const quotesByNo = new Map(snapshot.quotes.map((row) => [row.bill_no, row]));
  const ordersByNo = new Map(snapshot.orders.map((row) => [row.bill_no, row]));
  const noticesByNo = new Map(snapshot.notices.map((row) => [row.bill_no, row]));
  const outsById = byId(snapshot.outs);
  for (const line of snapshot.orderLines) {
    if (line.source_order_no) assert(quotesByNo.has(line.source_order_no), "A126 sales order references a foreign quote", line);
  }
  for (const line of snapshot.noticeLines) {
    assert(ordersByNo.has(line.source_order_no), "A126 delivery notice references a foreign order", line);
  }
  for (const line of snapshot.outLines) {
    assert(noticesByNo.has(line.source_delivery_notice_no), "A126 sales out references a foreign delivery notice", line);
    if (line.source_order_no) assert(ordersByNo.has(line.source_order_no), "A126 sales out references a foreign order", line);
  }
  for (const out of snapshot.outs) {
    if (out.red_source_bill_id) assert(outsById.has(String(out.red_source_bill_id)), "A126 red sales out references a foreign source", out);
  }
  assert(Object.values(snapshot.external ?? {}).every((value) => numeric(value) === 0), "A126 owned closure has an external consumer", snapshot.external);
  assert(JSON.stringify(snapshot.nonOwnedTransactions) === JSON.stringify(baseline.transactions), "A126 non-owned stock transaction digest changed", {
    baseline: baseline.transactions,
    current: snapshot.nonOwnedTransactions
  });

  const noticeLines = byId(snapshot.noticeLines);
  const outLines = byId(snapshot.outLines);
  let onHandDelta = 0;
  let reservedDelta = 0;
  let runningOnHand = numeric(baseline.balance.qty_on_hand);
  for (const txn of snapshot.transactions) {
    assert(String(txn.account_set_id) === accountSetId && String(txn.product_id) === productId && String(txn.warehouse_id) === warehouseId,
      "A126 stock transaction escaped the controlled route", txn);
    const qtyDelta = numeric(txn.qty_delta);
    let reservation = 0;
    if (String(txn.source_bill_type).startsWith(config.seedPrefix)) {
      const expectedHeaderId = deterministicTestId("TEST_HEADER", txn.source_bill_type);
      const expectedLineId = deterministicTestId("TEST_LINE", `${txn.source_bill_type}:${config.productCode}:${config.warehouseCode}`);
      assert(txn.txn_type === "A126_SEED" && txn.posting_action === "AUDIT" && txn.trace_quality === "TEST"
        && txn.source_bill_no === txn.source_bill_type
        && String(txn.source_bill_id) === expectedHeaderId
        && String(txn.source_bill_line_id) === expectedLineId
        && txn.reversal_of_txn_id == null,
      "A126 seed transaction is not canonical", txn);
    } else if (["DELIVERY_NOTICE_RESERVE", "DELIVERY_NOTICE_RESERVE_REVERSE"].includes(txn.txn_type)) {
      const line = noticeLines.get(String(txn.source_bill_line_id));
      assert(line && String(line.bill_id) === String(txn.source_bill_id) && txn.source_bill_no === snapshot.notices.find((row) => String(row.id) === String(line.bill_id))?.bill_no,
        "A126 reservation transaction source closure drifted", txn);
      if (txn.txn_type === "DELIVERY_NOTICE_RESERVE" && txn.posting_action === "RESERVE") reservation = Math.abs(numeric(line.qty));
      else if (txn.txn_type === "DELIVERY_NOTICE_RESERVE_REVERSE" && txn.posting_action === "RELEASE") reservation = -Math.abs(numeric(line.qty));
      else assert(false, "A126 reservation transaction action is not canonical", txn);
      assert(qtyDelta === 0 && txn.trace_quality === "EXACT", "A126 reservation transaction quantity/trace drifted", txn);
    } else {
      const line = outLines.get(String(txn.source_bill_line_id));
      assert(line && String(line.bill_id) === String(txn.source_bill_id) && txn.source_bill_no === snapshot.outs.find((row) => String(row.id) === String(line.bill_id))?.bill_no,
        "A126 sales-out transaction source closure drifted", txn);
      const quantity = Math.abs(numeric(line.qty));
      const key = `${txn.txn_type}/${txn.posting_action}`;
      const expected = new Map([
        ["SALES_OUT/AUDIT", [-quantity, -quantity]],
        ["SALES_OUT_REVERSE/REVERSE", [quantity, quantity]],
        ["SALES_OUT_RED/RED_AUDIT", [quantity, quantity]],
        ["SALES_OUT_RED_REVERSE/RED_REVERSE", [-quantity, -quantity]]
      ]).get(key);
      assert(expected && qtyDelta === expected[0] && txn.trace_quality === "EXACT", "A126 sales-out transaction action is not canonical", txn);
      reservation = expected[1];
    }
    onHandDelta += qtyDelta;
    reservedDelta += reservation;
    runningOnHand += qtyDelta;
    assert(numeric(txn.qty_on_hand_after) === runningOnHand, "A126 stock transaction running balance drifted", { txn, runningOnHand });
  }

  const before = baseline.balance;
  const current = snapshot.balance;
  const expected = {
    onHand: numeric(before.qty_on_hand) + onHandDelta,
    reserved: numeric(before.qty_reserved) + reservedDelta,
    available: numeric(before.qty_available) + onHandDelta - reservedDelta,
    version: numeric(before.version) + snapshot.transactions.length
  };
  assert(String(current.id) === String(before.id)
    && String(current.account_set_id) === String(before.account_set_id)
    && String(current.product_id) === String(before.product_id)
    && String(current.warehouse_id) === String(before.warehouse_id)
    && String(current.unit_cost) === String(before.unit_cost)
    && String(current.amount) === String(before.amount)
    && String(current.created_at) === String(before.created_at), "A126 controlled balance non-test fields drifted", { before, current });
  assert(numeric(current.qty_on_hand) === expected.onHand
    && numeric(current.qty_reserved) === expected.reserved
    && numeric(current.qty_available) === expected.available
    && numeric(current.version) === expected.version,
  "A126 controlled balance does not equal baseline plus the canonical owned transform", { before, current, expected });

  const outNos = new Set(snapshot.outs.map((row) => row.bill_no));
  for (const receivable of snapshot.receivables) {
    assert(outNos.has(receivable.source_bill_no) && receivable.status === "OPEN" && numeric(receivable.received_amount) === 0,
      "A126 receivable ownership drifted", receivable);
  }
  for (const lock of snapshot.locks) {
    assert(userIds.has(String(lock.holder_user_id)), "A126 edit lock is held by a foreign user", lock);
  }
  for (const log of snapshot.logs) {
    const ownedActor = userIds.has(String(log.operated_by));
    const systemActor = log.actor_type === "SYSTEM" && log.operated_by == null;
    assert(ownedActor || systemActor, "A126 business log has a foreign actor", log);
  }
  return {
    onHandDelta,
    reservedDelta,
    availableDelta: onHandDelta - reservedDelta,
    versionDelta: snapshot.transactions.length,
    counts: {
      quotes: snapshot.quotes.length,
      orders: snapshot.orders.length,
      notices: snapshot.notices.length,
      outs: snapshot.outs.length,
      receivables: snapshot.receivables.length,
      transactions: snapshot.transactions.length,
      logs: snapshot.logs.length,
      locks: snapshot.locks.length
    }
  };
}

function nullableSql(value, type = "numeric") {
  return value == null ? `NULL::${type}` : `${sqlLiteral(value)}::${type}`;
}

export function cleanupA126Run({ baseline, snapshot, config }) {
  const expectedDigest = String(snapshot?.snapshotDigest ?? "");
  assert(/^[0-9a-f]{64}$/.test(expectedDigest), "A126 cleanup requires a canonical frozen snapshot digest");
  const baselineJson = jsonbSql(baseline);
  const snapshotQuery = runSnapshotSql(config);
  const expectedCounts = {
    quotes: snapshot.quotes.length,
    orders: snapshot.orders.length,
    notices: snapshot.notices.length,
    outs: snapshot.outs.length,
    receivables: snapshot.receivables.length,
    transactions: snapshot.transactions.length,
    logs: snapshot.logs.length,
    locks: snapshot.locks.length
  };
  const result = dbJson(`
    BEGIN ISOLATION LEVEL SERIALIZABLE;
    SET LOCAL lock_timeout='5s';
    SET LOCAL statement_timeout='60s';
    LOCK TABLE public.sales_quote, public.sales_quote_line,
               public.sales_order, public.sales_order_line,
               public.delivery_notice, public.delivery_notice_line,
               public.sales_out, public.sales_out_line,
               public.sales_return_line, public.sales_return_finance_allocation,
               public.ar_receivable, public.ar_receipt, public.ar_receipt_allocation,
               public.inv_stock_balance, public.inv_stock_txn,
               public.doc_edit_lock, public.sys_operation_log,
               public.sys_outbox_event, public.sys_notification_outbox
      IN SHARE ROW EXCLUSIVE MODE;
    SELECT pg_advisory_xact_lock(hashtextextended('A126:BLD-TEST:CP-001:CK-001', 0));
    DO $a126_cleanup$
    DECLARE
      expected_digest text := ${sqlLiteral(expectedDigest)};
      baseline_snapshot jsonb := ${baselineJson};
      actual_snapshot jsonb;
      residue_count bigint;
      deleted_count bigint;
      expected_count bigint;
    BEGIN
      PERFORM 1 FROM public.inv_stock_balance
      WHERE id=(baseline_snapshot->'balance'->>'id')::uuid FOR UPDATE;
      IF NOT FOUND THEN RAISE EXCEPTION 'A126 cleanup refused: controlled balance disappeared'; END IF;
      SELECT snapshot INTO actual_snapshot FROM (${snapshotQuery}) frozen;
      IF encode(digest(actual_snapshot::text, 'sha256'), 'hex') IS DISTINCT FROM expected_digest THEN
        RAISE EXCEPTION 'A126 cleanup refused: owned snapshot changed before lock';
      END IF;

      DELETE FROM public.doc_edit_lock lock
      WHERE EXISTS (SELECT 1 FROM jsonb_array_elements(actual_snapshot->'locks') row
        WHERE lock.document_type=row->>'document_type' AND lock.bill_no=row->>'bill_no' AND lock.holder_user_id=(row->>'holder_user_id')::uuid);
      GET DIAGNOSTICS deleted_count = ROW_COUNT;
      IF deleted_count <> jsonb_array_length(actual_snapshot->'locks') THEN RAISE EXCEPTION 'A126 cleanup refused: edit-lock delete count drifted'; END IF;
      DELETE FROM public.sys_operation_log log
      WHERE log.id IN (SELECT (row->>'id')::uuid FROM jsonb_array_elements(actual_snapshot->'logs') row);
      GET DIAGNOSTICS deleted_count = ROW_COUNT;
      IF deleted_count <> jsonb_array_length(actual_snapshot->'logs') THEN RAISE EXCEPTION 'A126 cleanup refused: operation-log delete count drifted'; END IF;
      DELETE FROM public.ar_receivable receivable
      WHERE receivable.id IN (SELECT (row->>'id')::uuid FROM jsonb_array_elements(actual_snapshot->'receivables') row);
      GET DIAGNOSTICS deleted_count = ROW_COUNT;
      IF deleted_count <> jsonb_array_length(actual_snapshot->'receivables') THEN RAISE EXCEPTION 'A126 cleanup refused: receivable delete count drifted'; END IF;
      DELETE FROM public.inv_stock_txn txn
      WHERE txn.id IN (SELECT (row->>'id')::uuid FROM jsonb_array_elements(actual_snapshot->'transactions') row);
      GET DIAGNOSTICS deleted_count = ROW_COUNT;
      IF deleted_count <> jsonb_array_length(actual_snapshot->'transactions') THEN RAISE EXCEPTION 'A126 cleanup refused: stock-transaction delete count drifted'; END IF;
      DELETE FROM public.sales_out_line line
      WHERE line.id IN (SELECT (row->>'id')::uuid FROM jsonb_array_elements(actual_snapshot->'outLines') row);
      GET DIAGNOSTICS deleted_count = ROW_COUNT;
      IF deleted_count <> jsonb_array_length(actual_snapshot->'outLines') THEN RAISE EXCEPTION 'A126 cleanup refused: sales-out-line delete count drifted'; END IF;
      SELECT count(*) INTO expected_count
      FROM jsonb_array_elements(actual_snapshot->'outs') row
      WHERE row->>'red_source_bill_id' IS NOT NULL;
      DELETE FROM public.sales_out header
      WHERE header.id IN (SELECT (row->>'id')::uuid FROM jsonb_array_elements(actual_snapshot->'outs') row WHERE row->>'red_source_bill_id' IS NOT NULL);
      GET DIAGNOSTICS deleted_count = ROW_COUNT;
      IF deleted_count <> expected_count THEN RAISE EXCEPTION 'A126 cleanup refused: red sales-out delete count drifted'; END IF;
      DELETE FROM public.sales_out header
      WHERE header.id IN (SELECT (row->>'id')::uuid FROM jsonb_array_elements(actual_snapshot->'outs') row);
      GET DIAGNOSTICS deleted_count = ROW_COUNT;
      IF deleted_count <> jsonb_array_length(actual_snapshot->'outs') - expected_count THEN RAISE EXCEPTION 'A126 cleanup refused: ordinary sales-out delete count drifted'; END IF;
      DELETE FROM public.delivery_notice_line line
      WHERE line.id IN (SELECT (row->>'id')::uuid FROM jsonb_array_elements(actual_snapshot->'noticeLines') row);
      GET DIAGNOSTICS deleted_count = ROW_COUNT;
      IF deleted_count <> jsonb_array_length(actual_snapshot->'noticeLines') THEN RAISE EXCEPTION 'A126 cleanup refused: delivery-notice-line delete count drifted'; END IF;
      DELETE FROM public.delivery_notice header
      WHERE header.id IN (SELECT (row->>'id')::uuid FROM jsonb_array_elements(actual_snapshot->'notices') row);
      GET DIAGNOSTICS deleted_count = ROW_COUNT;
      IF deleted_count <> jsonb_array_length(actual_snapshot->'notices') THEN RAISE EXCEPTION 'A126 cleanup refused: delivery-notice delete count drifted'; END IF;
      DELETE FROM public.sales_order_line line
      WHERE line.id IN (SELECT (row->>'id')::uuid FROM jsonb_array_elements(actual_snapshot->'orderLines') row);
      GET DIAGNOSTICS deleted_count = ROW_COUNT;
      IF deleted_count <> jsonb_array_length(actual_snapshot->'orderLines') THEN RAISE EXCEPTION 'A126 cleanup refused: sales-order-line delete count drifted'; END IF;
      DELETE FROM public.sales_order header
      WHERE header.id IN (SELECT (row->>'id')::uuid FROM jsonb_array_elements(actual_snapshot->'orders') row);
      GET DIAGNOSTICS deleted_count = ROW_COUNT;
      IF deleted_count <> jsonb_array_length(actual_snapshot->'orders') THEN RAISE EXCEPTION 'A126 cleanup refused: sales-order delete count drifted'; END IF;
      DELETE FROM public.sales_quote_line line
      WHERE line.id IN (SELECT (row->>'id')::uuid FROM jsonb_array_elements(actual_snapshot->'quoteLines') row);
      GET DIAGNOSTICS deleted_count = ROW_COUNT;
      IF deleted_count <> jsonb_array_length(actual_snapshot->'quoteLines') THEN RAISE EXCEPTION 'A126 cleanup refused: sales-quote-line delete count drifted'; END IF;
      DELETE FROM public.sales_quote header
      WHERE header.id IN (SELECT (row->>'id')::uuid FROM jsonb_array_elements(actual_snapshot->'quotes') row);
      GET DIAGNOSTICS deleted_count = ROW_COUNT;
      IF deleted_count <> jsonb_array_length(actual_snapshot->'quotes') THEN RAISE EXCEPTION 'A126 cleanup refused: sales-quote delete count drifted'; END IF;

      UPDATE public.inv_stock_balance SET
        qty_on_hand=${nullableSql(baseline.balance.qty_on_hand)},
        qty_available=${nullableSql(baseline.balance.qty_available)},
        qty_reserved=${nullableSql(baseline.balance.qty_reserved)},
        unit_cost=${nullableSql(baseline.balance.unit_cost)},
        amount=${nullableSql(baseline.balance.amount)},
        created_at=${nullableSql(baseline.balance.created_at, "timestamptz")},
        updated_at=${nullableSql(baseline.balance.updated_at, "timestamptz")},
        version=${nullableSql(baseline.balance.version, "bigint")}
      WHERE id=(baseline_snapshot->'balance'->>'id')::uuid;
      IF NOT FOUND THEN RAISE EXCEPTION 'A126 cleanup refused: baseline restore updated zero rows'; END IF;

      SELECT count(*) INTO residue_count FROM (
        SELECT id FROM public.sales_quote WHERE id IN (SELECT (row->>'id')::uuid FROM jsonb_array_elements(actual_snapshot->'quotes') row)
        UNION ALL SELECT id FROM public.sales_quote_line WHERE id IN (SELECT (row->>'id')::uuid FROM jsonb_array_elements(actual_snapshot->'quoteLines') row)
        UNION ALL SELECT id FROM public.sales_order WHERE id IN (SELECT (row->>'id')::uuid FROM jsonb_array_elements(actual_snapshot->'orders') row)
        UNION ALL SELECT id FROM public.sales_order_line WHERE id IN (SELECT (row->>'id')::uuid FROM jsonb_array_elements(actual_snapshot->'orderLines') row)
        UNION ALL SELECT id FROM public.delivery_notice WHERE id IN (SELECT (row->>'id')::uuid FROM jsonb_array_elements(actual_snapshot->'notices') row)
        UNION ALL SELECT id FROM public.delivery_notice_line WHERE id IN (SELECT (row->>'id')::uuid FROM jsonb_array_elements(actual_snapshot->'noticeLines') row)
        UNION ALL SELECT id FROM public.sales_out WHERE id IN (SELECT (row->>'id')::uuid FROM jsonb_array_elements(actual_snapshot->'outs') row)
        UNION ALL SELECT id FROM public.sales_out_line WHERE id IN (SELECT (row->>'id')::uuid FROM jsonb_array_elements(actual_snapshot->'outLines') row)
        UNION ALL SELECT id FROM public.ar_receivable WHERE id IN (SELECT (row->>'id')::uuid FROM jsonb_array_elements(actual_snapshot->'receivables') row)
        UNION ALL SELECT id FROM public.inv_stock_txn WHERE id IN (SELECT (row->>'id')::uuid FROM jsonb_array_elements(actual_snapshot->'transactions') row)
        UNION ALL SELECT id FROM public.sys_operation_log WHERE id IN (SELECT (row->>'id')::uuid FROM jsonb_array_elements(actual_snapshot->'logs') row)
      ) residue;
      IF residue_count <> 0 THEN RAISE EXCEPTION 'A126 cleanup refused: exact owned residue remains'; END IF;
      IF EXISTS (
        SELECT 1 FROM public.doc_edit_lock lock
        WHERE EXISTS (SELECT 1 FROM jsonb_array_elements(actual_snapshot->'locks') row
          WHERE lock.document_type=row->>'document_type' AND lock.bill_no=row->>'bill_no' AND lock.holder_user_id=(row->>'holder_user_id')::uuid)
      ) THEN RAISE EXCEPTION 'A126 cleanup refused: exact owned edit-lock residue remains'; END IF;
      IF EXISTS (SELECT 1 FROM public.sales_quote_line WHERE customer_order_no=${sqlLiteral(config.marker)} OR line_remark=${sqlLiteral(config.marker)})
         OR EXISTS (SELECT 1 FROM public.sales_order_line WHERE customer_order_no=${sqlLiteral(config.marker)} OR line_remark=${sqlLiteral(config.marker)})
         OR EXISTS (SELECT 1 FROM public.delivery_notice_line WHERE customer_order_no=${sqlLiteral(config.marker)} OR line_remark=${sqlLiteral(config.marker)})
         OR EXISTS (SELECT 1 FROM public.sales_out_line WHERE customer_order_no=${sqlLiteral(config.marker)} OR line_remark=${sqlLiteral(config.marker)})
         OR EXISTS (SELECT 1 FROM public.inv_stock_txn WHERE left(source_bill_type, ${config.seedPrefix.length})=${sqlLiteral(config.seedPrefix)}) THEN
        RAISE EXCEPTION 'A126 cleanup refused: run marker residue remains';
      END IF;
      IF (SELECT ${normalizedBalanceSql("balance")} FROM public.inv_stock_balance balance WHERE balance.id=(baseline_snapshot->'balance'->>'id')::uuid)
           IS DISTINCT FROM baseline_snapshot->'balance' THEN
        RAISE EXCEPTION 'A126 cleanup refused: full balance baseline was not restored';
      END IF;
      IF ${transactionDigestSql()
        .replace("FROM public.inv_stock_txn digest_txn, lookup", "FROM public.inv_stock_txn digest_txn")
        .replaceAll("lookup.account_set_id", `(baseline_snapshot->>'accountSetId')::uuid`)
        .replaceAll("lookup.product_id", `(baseline_snapshot->>'productId')::uuid`)
        .replaceAll("lookup.warehouse_id", `(baseline_snapshot->>'warehouseId')::uuid`)}
           IS DISTINCT FROM baseline_snapshot->'transactions' THEN
        RAISE EXCEPTION 'A126 cleanup refused: stock transaction baseline digest was not restored';
      END IF;
    END;
    $a126_cleanup$;
    COMMIT;
    SELECT jsonb_build_object(
      'restored', TRUE,
      'snapshotDigest', ${sqlLiteral(expectedDigest)},
      'quotes', ${expectedCounts.quotes},
      'orders', ${expectedCounts.orders},
      'notices', ${expectedCounts.notices},
      'outs', ${expectedCounts.outs},
      'receivables', ${expectedCounts.receivables},
      'transactions', ${expectedCounts.transactions},
      'logs', ${expectedCounts.logs},
      'locks', ${expectedCounts.locks}
    )::text;
  `, "A126 exact run cleanup");
  assert(result?.restored === true, "A126 cleanup did not return a restored result", result);
  return result;
}
