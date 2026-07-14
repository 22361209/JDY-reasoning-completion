#!/usr/bin/env node

import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");

async function text(relativePath) {
  return readFile(path.join(root, relativePath), "utf8");
}

async function javaSources(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry) => {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) return javaSources(absolute);
    return entry.isFile() && entry.name.endsWith(".java") ? [absolute] : [];
  }));
  return nested.flat();
}

const mainRoot = path.join(root, "backend/src/main/java");
const formalPostingFiles = [
  "backend/src/main/java/com/jdy/erp/sales/application/DeliveryNoticeAppService.java",
  "backend/src/main/java/com/jdy/erp/sales/application/SalesOutAppService.java",
  "backend/src/main/java/com/jdy/erp/sales/application/SalesReturnAppService.java",
  "backend/src/main/java/com/jdy/erp/purchase/application/PurchaseInAppService.java",
  "backend/src/main/java/com/jdy/erp/purchase/application/PurchaseReturnAppService.java",
  "backend/src/main/java/com/jdy/erp/production/application/MaterialIssueAppService.java",
  "backend/src/main/java/com/jdy/erp/production/application/ProductInAppService.java",
  "backend/src/main/java/com/jdy/erp/inventory/application/OtherStockInAppService.java",
  "backend/src/main/java/com/jdy/erp/inventory/application/OtherStockOutAppService.java",
  "backend/src/main/java/com/jdy/erp/inventory/application/StockCountGainAppService.java",
  "backend/src/main/java/com/jdy/erp/inventory/application/StockCountLossAppService.java",
  "backend/src/main/java/com/jdy/erp/inventory/application/StockTransferAppService.java",
  "backend/src/main/java/com/jdy/erp/outsourcing/application/OutsourcingDocumentAppService.java"
];

const lifecycleMatrixContracts = {
  "backend/src/test/java/com/jdy/erp/system/tenant/TenantSalesChainIsolationTest.java": [
    'fact("DELIVERY_NOTICE_RESERVE", "RESERVE"',
    'reversal("DELIVERY_NOTICE_RESERVE_REVERSE", "RELEASE"',
    'reversal("SALES_OUT_REVERSE", "REVERSE"',
    'reversal("SALES_RETURN_REVERSE", "REVERSE"'
  ],
  "backend/src/test/java/com/jdy/erp/system/tenant/TenantPurchaseChainIsolationTest.java": [
    'reversal("PURCHASE_IN_REVERSE", "REVERSE"',
    'reversal("PURCHASE_RETURN_REVERSE", "REVERSE"'
  ],
  "backend/src/test/java/com/jdy/erp/system/tenant/TenantProductionChainIsolationTest.java": [
    'reversal("PRODUCTION_COMPLETE_REVERSE", "REVERSE"'
  ],
  "backend/src/test/java/com/jdy/erp/system/tenant/TenantOutsourcingChainIsolationTest.java": [
    'reversal("OUTSOURCING_ISSUE_REVERSE", "REVERSE"',
    'reversal("OUTSOURCING_RECEIPT_REVERSE", "REVERSE"',
    'reversal("OUTSOURCING_RETURN_REVERSE", "REVERSE"',
    'reversal("OUTSOURCING_SCRAP_REVERSE", "REVERSE"'
  ],
  "backend/src/test/java/com/jdy/erp/shared/application/RedReverseTransactionIntegrationTest.java": [
    'reversal("SALES_OUT_RED_REVERSE", "RED_REVERSE"',
    'reversal("PURCHASE_IN_RED_REVERSE", "RED_REVERSE"'
  ],
  "backend/src/test/java/com/jdy/erp/production/application/MaterialIssueInventoryTraceIntegrationTest.java": [
    'reversal("PRODUCTION_ISSUE_REVERSE", "REVERSE"',
    "concurrentAuditKeepsLoserDraftAndWritesExactReversibleFactsOnce"
  ],
  "backend/src/test/java/com/jdy/erp/inventory/application/InventoryFormalPostingTraceIntegrationTest.java": [
    'assertReversibleTrace(otherIn, "OTHER_STOCK_IN", "OTHER_STOCK_IN_REVERSE"',
    'assertReversibleTrace(otherOut, "OTHER_STOCK_OUT", "OTHER_STOCK_OUT_REVERSE"',
    'assertReversibleTrace(countGain, "STOCK_COUNT_GAIN", "STOCK_COUNT_GAIN_REVERSE"',
    'assertReversibleTrace(countLoss, "STOCK_COUNT_LOSS", "STOCK_COUNT_LOSS_REVERSE"',
    'assertReversibleTrace(transfer, "STOCK_TRANSFER_OUT", "STOCK_TRANSFER_OUT_REVERSE"',
    'assertReversibleTrace(transfer, "STOCK_TRANSFER_IN", "STOCK_TRANSFER_IN_REVERSE"'
  ]
};

const formalPostingContracts = {
  "backend/src/main/java/com/jdy/erp/sales/application/DeliveryNoticeAppService.java": {
    commandCount: 2,
    queryMarkers: [
      'SELECT dn.id::text AS "sourceBillId"',
      'l.id::text AS "sourceBillLineId"',
      'dn.bill_date AS "sourceBillDate"'
    ],
    actions: ["RESERVE", "RELEASE"]
  },
  "backend/src/main/java/com/jdy/erp/sales/application/SalesOutAppService.java": {
    commandCount: 4,
    queryMarkers: [
      'SELECT so.id::text AS "sourceBillId"',
      'l.id::text AS "sourceBillLineId"',
      'so.bill_date AS "sourceBillDate"'
    ],
    actions: ["AUDIT", "REVERSE", "RED_AUDIT", "RED_REVERSE"]
  },
  "backend/src/main/java/com/jdy/erp/sales/application/SalesReturnAppService.java": {
    commandCount: 2,
    queryMarkers: [
      "FROM sales_return",
      'return_line.id::text AS "sourceBillLineId"',
      'bill_date AS "billDate"'
    ],
    actions: ["AUDIT", "REVERSE"]
  },
  "backend/src/main/java/com/jdy/erp/purchase/application/PurchaseInAppService.java": {
    commandCount: 1,
    queryMarkers: [
      'SELECT pi.id::text AS "sourceBillId"',
      'l.id::text AS "sourceBillLineId"',
      'pi.bill_date AS "sourceBillDate"'
    ],
    actions: ["AUDIT", "REVERSE", "RED_AUDIT", "RED_REVERSE"]
  },
  "backend/src/main/java/com/jdy/erp/purchase/application/PurchaseReturnAppService.java": {
    commandCount: 1,
    queryMarkers: [
      'SELECT pr.id::text AS "sourceBillId"',
      'l.id::text AS "sourceBillLineId"',
      'pr.bill_date AS "sourceBillDate"'
    ],
    actions: ["AUDIT", "REVERSE"]
  },
  "backend/src/main/java/com/jdy/erp/production/application/MaterialIssueAppService.java": {
    commandCount: 1,
    queryMarkers: [
      'SELECT i.id::text AS "sourceBillId"',
      'l.id::text AS "sourceBillLineId"',
      '(i.created_at AT TIME ZONE \'Asia/Shanghai\')::date AS "sourceBillDate"'
    ],
    actions: ["AUDIT", "REVERSE", "RED_AUDIT", "RED_REVERSE"]
  },
  "backend/src/main/java/com/jdy/erp/production/application/ProductInAppService.java": {
    commandCount: 1,
    queryMarkers: [
      'SELECT c.id::text AS "sourceBillId"',
      'l.id::text AS "sourceBillLineId"',
      '(c.created_at AT TIME ZONE \'Asia/Shanghai\')::date AS "sourceBillDate"'
    ],
    actions: ["AUDIT", "REVERSE", "RED_AUDIT", "RED_REVERSE"]
  },
  "backend/src/main/java/com/jdy/erp/inventory/application/OtherStockInAppService.java": {
    commandCount: 2,
    queryMarkers: [
      'SELECT b.id::text AS "sourceBillId", l.id::text AS "sourceBillLineId"',
      'b.bill_date AS "sourceBillDate"'
    ],
    actions: ["AUDIT", "REVERSE"]
  },
  "backend/src/main/java/com/jdy/erp/inventory/application/OtherStockOutAppService.java": {
    commandCount: 2,
    queryMarkers: [
      'SELECT b.id::text AS "sourceBillId", l.id::text AS "sourceBillLineId"',
      'b.bill_date AS "sourceBillDate"'
    ],
    actions: ["AUDIT", "REVERSE"]
  },
  "backend/src/main/java/com/jdy/erp/inventory/application/StockCountGainAppService.java": {
    commandCount: 2,
    queryMarkers: [
      'SELECT b.id::text AS "sourceBillId", l.id::text AS "sourceBillLineId"',
      'b.bill_date AS "sourceBillDate"'
    ],
    actions: ["AUDIT", "REVERSE"]
  },
  "backend/src/main/java/com/jdy/erp/inventory/application/StockCountLossAppService.java": {
    commandCount: 2,
    queryMarkers: [
      'SELECT b.id::text AS "sourceBillId", l.id::text AS "sourceBillLineId"',
      'b.bill_date AS "sourceBillDate"'
    ],
    actions: ["AUDIT", "REVERSE"]
  },
  "backend/src/main/java/com/jdy/erp/inventory/application/StockTransferAppService.java": {
    commandCount: 1,
    queryMarkers: [
      'SELECT b.id::text AS "sourceBillId", l.id::text AS "sourceBillLineId"',
      'b.bill_no AS "sourceBillNo", b.bill_date AS "sourceBillDate"'
    ],
    actions: ["AUDIT", "REVERSE"]
  },
  "backend/src/main/java/com/jdy/erp/outsourcing/application/OutsourcingDocumentAppService.java": {
    commandCount: 1,
    queryMarkers: [
      'RETURNING id::text AS id, bill_no AS "billNo", bill_date AS "billDate"',
      'SELECT id::text AS id,'
    ],
    actions: ["AUDIT", "REVERSE"]
  }
};

const lineReplacementContracts = {
  "backend/src/main/java/com/jdy/erp/sales/application/DeliveryNoticeAppService.java": ["DELIVERY_NOTICE", "DELETE FROM delivery_notice_line", "if (bills.isEmpty())"],
  "backend/src/main/java/com/jdy/erp/sales/application/SalesOutAppService.java": ["SALES_OUT", "DELETE FROM sales_out_line", "if (bills.isEmpty())"],
  "backend/src/main/java/com/jdy/erp/sales/application/SalesReturnAppService.java": ["SALES_RETURN", "DELETE FROM sales_return_line", "if (updated.isEmpty())"],
  "backend/src/main/java/com/jdy/erp/purchase/application/PurchaseInAppService.java": ["PURCHASE_IN", "DELETE FROM purchase_in_line", "if (bills.isEmpty())"],
  "backend/src/main/java/com/jdy/erp/purchase/application/PurchaseReturnAppService.java": ["PURCHASE_RETURN", "DELETE FROM purchase_return_line", "if (bills.isEmpty())"],
  "backend/src/main/java/com/jdy/erp/production/application/MaterialIssueAppService.java": ["PRODUCTION_MATERIAL_ISSUE", "DELETE FROM production_material_issue_line", "if (issueRows.isEmpty())"],
  "backend/src/main/java/com/jdy/erp/production/application/ProductInAppService.java": ["PRODUCTION_COMPLETION", "DELETE FROM production_completion_line", "if (completionRows.isEmpty())"],
  "backend/src/main/java/com/jdy/erp/inventory/application/OtherStockInAppService.java": ["OTHER_STOCK_IN", "DELETE FROM other_stock_in_line", "if (bills.isEmpty())"],
  "backend/src/main/java/com/jdy/erp/inventory/application/OtherStockOutAppService.java": ["OTHER_STOCK_OUT", "DELETE FROM other_stock_out_line", "if (bills.isEmpty())"],
  "backend/src/main/java/com/jdy/erp/inventory/application/StockCountGainAppService.java": ["STOCK_COUNT_GAIN", "DELETE FROM stock_count_gain_line", "if (bills.isEmpty())"],
  "backend/src/main/java/com/jdy/erp/inventory/application/StockCountLossAppService.java": ["STOCK_COUNT_LOSS", "DELETE FROM stock_count_loss_line", "if (bills.isEmpty())"],
  "backend/src/main/java/com/jdy/erp/inventory/application/StockTransferAppService.java": ["STOCK_TRANSFER", "DELETE FROM stock_transfer_line", "if (bills.isEmpty())"]
};

function balancedCalls(source, signature) {
  const calls = [];
  let cursor = 0;
  while ((cursor = source.indexOf(signature, cursor)) >= 0) {
    const start = cursor;
    const open = source.indexOf("(", start + signature.length - 1);
    let depth = 0;
    let quote = null;
    let escaped = false;
    let end = open;
    for (; end < source.length; end += 1) {
      const character = source[end];
      if (quote !== null) {
        if (escaped) escaped = false;
        else if (character === "\\") escaped = true;
        else if (character === quote) quote = null;
        continue;
      }
      if (character === '"' || character === "'") {
        quote = character;
      } else if (character === "(") {
        depth += 1;
      } else if (character === ")") {
        depth -= 1;
        if (depth === 0) {
          end += 1;
          break;
        }
      }
    }
    assert.equal(depth, 0, `unbalanced ${signature} call`);
    calls.push(source.slice(start, end));
    cursor = end;
  }
  return calls;
}

const [command, service, context, hook, opening, adjustment, v106, v107, ...formalSources] = await Promise.all([
  text("backend/src/main/java/com/jdy/erp/inventory/application/InventoryPostingCommand.java"),
  text("backend/src/main/java/com/jdy/erp/inventory/application/InventoryPostingService.java"),
  text("backend/src/main/java/com/jdy/erp/shared/application/PostingContext.java"),
  text("backend/src/main/java/com/jdy/erp/shared/application/InventoryPostingHook.java"),
  text("backend/src/main/java/com/jdy/erp/inventory/application/OpeningStockService.java"),
  text("backend/src/main/java/com/jdy/erp/inventory/api/InventoryAdjustmentController.java"),
  text("backend/src/main/resources/db/migration/V106__inventory_source_trace.sql"),
  text("backend/src/main/resources/db/migration/V107__inventory_source_trace_reaudit_fix.sql"),
  ...formalPostingFiles.map(text)
]);
const [traceLifecycle, billLifecycle, formalTraceTest, materialTraceTest, migrationRegression] = await Promise.all([
  text("backend/src/main/java/com/jdy/erp/inventory/application/InventoryTraceLifecycleService.java"),
  text("backend/src/main/java/com/jdy/erp/shared/application/BillLifecycleService.java"),
  text("backend/src/test/java/com/jdy/erp/inventory/application/InventoryFormalPostingTraceIntegrationTest.java"),
  text("backend/src/test/java/com/jdy/erp/production/application/MaterialIssueInventoryTraceIntegrationTest.java"),
  text("scripts/a147-inventory-source-trace-migration-regression.mjs")
]);
const formalSourceByPath = new Map(
  formalPostingFiles.map((relativePath, index) => [relativePath, formalSources[index]])
);

for (const field of [
  "UUID sourceBillId",
  "UUID sourceBillLineId",
  "String sourceBillNo",
  "LocalDate sourceBillDate",
  "PostingAction postingAction",
  "TraceQuality traceQuality"
]) {
  assert(command.includes(field), `typed inventory command is missing ${field}`);
}
for (const action of ["AUDIT", "REVERSE", "RED_AUDIT", "RED_REVERSE", "RESERVE", "RELEASE"]) {
  assert(command.includes(action), `typed inventory command is missing action ${action}`);
}
assert(command.includes("TraceQuality.EXACT"), "formal document factory must mark exact trace quality");
assert(!command.includes("randomUUID"), "typed inventory command must never invent source ids");

assert(!service.includes("gen_random_uuid()"), "inventory posting service must not generate source ids in SQL");
assert(!service.includes("UUID.randomUUID"), "inventory posting service must not generate source ids in Java");
assert(service.includes("qty_on_hand_after"), "inventory posting service must persist the returned running balance");
assert(service.includes("reversal_of_txn_id"), "inventory posting service must link immutable reverse facts");
assert(service.includes("0, clock_timestamp()"), "inventory facts must timestamp after balance serialization, not at transaction start");
assert(!service.includes("DEFAULT now()"), "inventory posting must not rely on a transaction-start timestamp default");
assert(service.includes("pg_advisory_xact_lock"), "exact posting facts must be serialized before duplicate checks");
assert(service.includes("assertNoActiveForwardFact"), "active exact posting facts must be idempotency guarded");
assert(service.includes("NOT EXISTS"), "reverse lookup must ignore facts already reversed");
const exactReversalLookupIndex = service.indexOf("var exactRows = jdbcTemplate.queryForList");
const historicalReversalLookupIndex = service.indexOf("var historicalRows = jdbcTemplate.queryForList");
assert(exactReversalLookupIndex >= 0, "reverse lookup must retain the exact source-line path");
assert(
  historicalReversalLookupIndex > exactReversalLookupIndex,
  "migrated header-only fallback must run only after exact source-line lookup"
);
for (const marker of [
  'historicalBillSuffix = ":" + command.sourceBillNo().trim()',
  "historicalForwardDocumentPrefix = originalAction == PostingAction.RED_AUDIT",
  "historicalReverseDocumentPrefix = command.postingAction() == PostingAction.RED_REVERSE",
  "historicalForwardTxnSourceType = originalTxnType + historicalBillSuffix",
  "historicalForwardDocumentSourceType = historicalForwardDocumentPrefix + historicalBillSuffix",
  "historicalReverseTxnSourceType = command.txnType() + historicalBillSuffix",
  "historicalReverseDocumentSourceType = historicalReverseDocumentPrefix + historicalBillSuffix",
  "original.account_set_id = ?::uuid",
  "original.source_bill_id = ?::uuid",
  "original.source_bill_line_id IS NULL",
  "original.source_bill_type IN (?, ?)",
  "original.source_bill_no = ?",
  "original.source_bill_date = ?",
  "original.product_id = ?::uuid",
  "original.warehouse_id = ?::uuid",
  "original.posting_action = ?",
  "original.txn_type = ?",
  "original.qty_delta = ?",
  "original.trace_quality = 'HEADER_ONLY'",
  "LIMIT 2",
  "historicalRows.size() != 1"
]) {
  assert(service.includes(marker), `migrated reversal fallback dropped fail-closed marker: ${marker}`);
}
assert(
  service.includes("historical_reversal.occurred_at >= original.occurred_at"),
  "migrated fallback must reject a forward fact already followed by historical reversal"
);
assert(!/UPDATE\s+inv_stock_txn/i.test(service), "posted inventory facts must never be overwritten");
assert(!/DELETE\s+FROM\s+inv_stock_txn/i.test(service), "posted inventory facts must never be deleted");
assert(!service.includes("@Deprecated"), "production inventory posting service must not retain legacy overloads");
for (const method of ["post", "reserve", "releaseReservation", "shipReserved", "reverseShipReserved"]) {
  assert(
    !new RegExp(`public\\s+Map<String, Object>\\s+${method}\\s*\\(\\s*String`).test(service),
    `production inventory posting service retains legacy ${method}(String, ...)`
  );
}

for (const field of [
  "UUID sourceBillId",
  "UUID sourceBillLineId",
  "PostingAction postingAction",
  "TraceQuality traceQuality"
]) {
  assert(context.includes(field), `posting context is missing ${field}`);
}
assert(!context.includes("INVENTORY_TEST_CHANNEL"), "production PostingContext must not synthesize test inventory identity");
assert(!context.includes("deterministicTestId"), "production PostingContext must not retain its legacy test constructor");
assert(!context.includes("public PostingContext("), "production PostingContext must not retain nullable legacy constructors");
assert(context.includes("public static PostingContext finance("), "finance callers must use an explicit non-inventory factory");
for (const accessor of [
  "context.sourceBillId()",
  "context.sourceBillLineId()",
  "context.sourceBillNo()",
  "context.billDate()",
  "context.postingAction()",
  "context.traceQuality()"
]) {
  assert(hook.includes(accessor), `inventory posting hook drops ${accessor}`);
}
assert(!hook.includes("matches("), "inventory posting hook must not infer trace quality from source strings");

assert(traceLifecycle.includes("Propagation.MANDATORY"), "trace metadata downgrade must join the locked draft transaction");
const traceDowngrade = traceLifecycle.match(/UPDATE\s+inv_stock_txn[\s\S]*?WHERE[\s\S]*?trace_quality\s*=\s*'EXACT'/i)?.[0];
assert(traceDowngrade, "line replacement must downgrade matching exact inventory history");
assert(traceDowngrade.includes("trace_quality = 'HEADER_ONLY'"), "old exact history must become header-only");
assert(traceDowngrade.includes("source_bill_line_id = NULL"), "old exact history must drop only its stale line identity");
for (const forbiddenAssignment of [
  "qty_delta =", "product_id =", "warehouse_id =", "posting_action =",
  "reversal_of_txn_id =", "occurred_at =", "source_bill_id = NULL", "source_bill_no = NULL"
]) {
  assert(!traceDowngrade.includes(forbiddenAssignment), `trace downgrade must preserve immutable fact field: ${forbiddenAssignment}`);
}

formalSources.forEach((source, index) => {
  const relativePath = formalPostingFiles[index];
  const contract = formalPostingContracts[relativePath];
  const calls = balancedCalls(source, "InventoryPostingCommand.document(");
  assert.equal(calls.length, contract.commandCount, `${relativePath} typed command call count changed`);
  calls.forEach((call, callIndex) => {
    assert(
      call.includes('line.get("sourceBillId")') || call.includes('header.get("id")'),
      `${relativePath} command ${callIndex + 1} drops its persisted header id`
    );
    assert(
      call.includes('line.get("sourceBillLineId")') || call.includes('line.get("id")'),
      `${relativePath} command ${callIndex + 1} drops its persisted line id`
    );
    assert(
      call.includes("billNo") || call.includes("BillNo") || call.includes('header.get("billNo")'),
      `${relativePath} command ${callIndex + 1} drops its real bill number`
    );
    assert(
      call.includes('line.get("sourceBillDate")') || call.includes('header.get("billDate")'),
      `${relativePath} command ${callIndex + 1} drops its business date`
    );
    assert(
      call.includes("PostingAction.") || call.includes("postingAction"),
      `${relativePath} command ${callIndex + 1} drops its lifecycle action`
    );
  });
  for (const marker of contract.queryMarkers) {
    assert(source.includes(marker), `${relativePath} does not select persisted posting field: ${marker}`);
  }
  for (const action of contract.actions) {
    assert(source.includes(`PostingAction.${action}`), `${relativePath} does not map lifecycle action ${action}`);
  }
  assert(
    source.includes('"sourceBillId"') || source.includes('header.get("id")'),
    `${relativePath} must query the real header id`
  );
  assert(
    source.includes('"sourceBillLineId"') || source.includes('line.get("id")'),
    `${relativePath} must query the real line id`
  );
  assert(
    source.includes('"sourceBillDate"') || source.includes('header.get("billDate")'),
    `${relativePath} must query the real business date`
  );
  assert(source.includes("PostingAction."), `${relativePath} must declare the lifecycle posting action`);
  assert(!source.includes("gen_random_uuid()"), `${relativePath} must not invent inventory source ids`);
});

for (const [relativePath, [sourceBillType, deleteMarker, guardMarker]] of Object.entries(lineReplacementContracts)) {
  const source = formalSourceByPath.get(relativePath);
  const downgradeMarker = `prepareForLineReplacement("${sourceBillType}"`;
  const downgradeIndex = source.indexOf(downgradeMarker);
  const guardIndex = source.lastIndexOf(guardMarker, downgradeIndex);
  const deleteIndex = source.indexOf(deleteMarker, downgradeIndex);
  assert(downgradeIndex >= 0, `${relativePath} must degrade stale exact line identity before replacement`);
  assert(guardIndex >= 0 && guardIndex < downgradeIndex, `${relativePath} must confirm its locked DRAFT guard before degrading history`);
  assert(deleteIndex > downgradeIndex, `${relativePath} must degrade history before deleting persisted source lines`);
  assert(source.includes("InventoryTraceLifecycleService"), `${relativePath} must use the shared trace lifecycle guard`);
}

for (const [relativePath, headerTable, rowsVariable] of [
  ["backend/src/main/java/com/jdy/erp/sales/application/DeliveryNoticeAppService.java", "delivery_notice", "bills"],
  ["backend/src/main/java/com/jdy/erp/sales/application/SalesOutAppService.java", "sales_out", "bills"],
  ["backend/src/main/java/com/jdy/erp/purchase/application/PurchaseInAppService.java", "purchase_in", "bills"],
  ["backend/src/main/java/com/jdy/erp/purchase/application/PurchaseReturnAppService.java", "purchase_return", "bills"]
]) {
  const source = formalSourceByPath.get(relativePath);
  assert(source.includes(`var ${rowsVariable} = jdbcTemplate.queryForList`), `${relativePath} save must expose an empty atomic-upsert result`);
  assert(source.includes(`WHERE ${headerTable}.status = 'DRAFT'`), `${relativePath} save must atomically guard DRAFT in its upsert`);
  assert(/if \(bills\.isEmpty\(\)\)[\s\S]{0,220}?HttpStatus\.CONFLICT/.test(source), `${relativePath} audited direct-save must return an explicit 409`);
}

for (const relativePath of [
  "backend/src/main/java/com/jdy/erp/inventory/application/OtherStockInAppService.java",
  "backend/src/main/java/com/jdy/erp/inventory/application/OtherStockOutAppService.java",
  "backend/src/main/java/com/jdy/erp/inventory/application/StockCountGainAppService.java",
  "backend/src/main/java/com/jdy/erp/inventory/application/StockCountLossAppService.java",
  "backend/src/main/java/com/jdy/erp/inventory/application/StockTransferAppService.java"
]) {
  const source = formalSourceByPath.get(relativePath);
  assert(source.includes("var bills = jdbcTemplate.queryForList"), `${relativePath} guarded upsert must not leak EmptyResultDataAccessException as 500`);
  assert(/if \(bills\.isEmpty\(\)\)[\s\S]{0,220}?HttpStatus\.CONFLICT/.test(source), `${relativePath} guarded save must map a lost DRAFT race to 409`);
}

const lifecycleDeleteStart = billLifecycle.indexOf("public Map<String, Object> deleteDraft(");
const lifecycleDeleteEnd = billLifecycle.indexOf("public Map<String, Object> closeBill(", lifecycleDeleteStart);
const lifecycleDelete = billLifecycle.slice(lifecycleDeleteStart, lifecycleDeleteEnd);
assert(lifecycleDelete.includes("FOR UPDATE"), "shared hard delete must lock the DRAFT header");
assert(lifecycleDelete.includes("inventoryTraceLifecycleService.assertNoPostingHistory"), "shared hard delete must reject any inventory history");
assert(
  lifecycleDelete.indexOf("assertNoPostingHistory") < lifecycleDelete.indexOf("DELETE FROM %s"),
  "shared hard delete must check history before deleting lines"
);
assert(lifecycleDelete.includes("WHERE id = ?::uuid AND status = 'DRAFT'"), "shared hard delete must repeat the DRAFT predicate on final header delete");
assert(lifecycleDelete.includes("if (deleted != 1)"), "shared hard delete must reject a lost final-delete race");

const salesReturn = formalSourceByPath.get("backend/src/main/java/com/jdy/erp/sales/application/SalesReturnAppService.java");
const salesReturnDeleteStart = salesReturn.indexOf("public Map<String, Object> deleteDraft(");
const salesReturnDeleteEnd = salesReturn.indexOf("public Map<String, Object> voidBill(", salesReturnDeleteStart);
const salesReturnDelete = salesReturn.slice(salesReturnDeleteStart, salesReturnDeleteEnd);
assert(salesReturnDelete.includes("lockHeader(normalizedBillNo)"), "sales return hard delete must lock its header");
assert(salesReturnDelete.includes("inventoryTraceLifecycleService.assertNoPostingHistory"), "sales return hard delete must reject any inventory history");
assert(salesReturnDelete.includes("AND status = 'DRAFT'"), "sales return final hard delete must retain a DRAFT predicate");

const lifecycleAssertions = await text(
  "backend/src/test/java/com/jdy/erp/testsupport/InventoryTraceAssertions.java"
);
const formalTraceRegression = await text(
  "backend/src/test/java/com/jdy/erp/inventory/application/InventoryFormalPostingTraceIntegrationTest.java"
);
for (const marker of [
  "migratedHeaderOnlyPostingCanBeReversedWithoutGuessingItsOldLine",
  "migratedHeaderOnlyReservationUsesItsLegacyDeliveryPrefix",
  "migratedReservationAlreadyFollowedByLegacyReleaseIsNotReleasedTwice",
  "ambiguousMigratedHeaderOnlyPostingsFailClosedAndRollbackTheDocument",
  "migratedHeaderOnlyFallbackNeverCrossesAccountSetScope",
  "exactPostingRemainsPreferredOverAmbiguousMigratedHistory",
  "migratedForwardAlreadyFollowedByHistoricalReverseIsNotReversedTwice"
]) {
  assert(formalTraceRegression.includes(marker), `migrated reversal dynamic coverage dropped: ${marker}`);
}
for (const marker of [
  'containsEntry("accountSetId", expectedInventoryScopeId)',
  'containsEntry("sourceBillId", source.get("sourceBillId"))',
  'containsEntry("sourceBillLineId", source.get("sourceBillLineId"))',
  'containsEntry("sourceBillNo", source.get("sourceBillNo"))',
  'containsEntry("sourceBillDate", source.get("sourceBillDate"))',
  'containsEntry("postingAction", expected.action())',
  'containsEntry("traceQuality", "EXACT")',
  'isEqualTo(facts.get(expected.reversalOfIndex()).get("id"))'
]) {
  assert(
    lifecycleAssertions.includes(marker),
    `dynamic lifecycle assertion helper dropped exact trace proof: ${marker}`
  );
}

const lifecycleMatrixEntries = await Promise.all(
  Object.entries(lifecycleMatrixContracts).map(async ([relativePath, markers]) => ({
    relativePath,
    markers,
    source: await text(relativePath)
  }))
);
for (const { relativePath, markers, source } of lifecycleMatrixEntries) {
  for (const marker of markers) {
    assert(source.includes(marker), `${relativePath} dropped lifecycle matrix case: ${marker}`);
  }
  if (!relativePath.endsWith("InventoryFormalPostingTraceIntegrationTest.java")) {
    assert(
      source.includes("assertExactLifecycle("),
      `${relativePath} must use the shared exact lifecycle assertion`
    );
  }
}
assert(
  lifecycleMatrixEntries
    .filter(({ relativePath }) => relativePath.includes("system/tenant/"))
    .every(({ source }) => (
      source.includes("var tenantA = createManagedAccountSet(")
      && source.includes("var tenantB = createManagedAccountSet(")
    )),
  "tenant lifecycle matrix must retain two-tenant isolation coverage"
);
assert(
  lifecycleMatrixEntries
    .filter(({ relativePath }) => !relativePath.endsWith("InventoryFormalPostingTraceIntegrationTest.java"))
    .every(({ source }) => /fact\([\s\S]{0,500}?reversal\([\s\S]{0,500}?,\s*0\)[\s\S]{0,500}?fact\(/.test(source)),
  "formal lifecycle matrix must retain audit -> exact reversal -> re-audit coverage"
);

assert(opening.includes("RETURNING id::text AS id"), "opening stock must use the persisted adjustment row id");
assert(opening.includes("opening.get(\"id\"), opening.get(\"id\")"), "opening stock must bind its real adjustment row as header and line identity");
assert(opening.includes("qty_on_hand_after"), "opening stock must persist its running balance");
assert(opening.includes("ON CONFLICT (account_set_id, product_id, warehouse_id) DO NOTHING"), "opening save must ensure the balance row before locking it");
assert(/FROM inv_stock_balance[\s\S]{0,260}?FOR UPDATE/.test(opening), "opening save must read its old absolute balance under row lock");
assert(opening.includes("qty.subtract(oldReserved)"), "opening save must preserve reservations when recomputing availability");
assert(opening.includes("qty.compareTo(oldReserved) < 0"), "opening save must reject an absolute quantity below reserved stock");
assert(opening.includes("期初数量不能小于已预留数量"), "opening reservation conflict must remain precise");
assert(!opening.includes("qty_reserved = 0"), "opening save must never erase an existing reservation");
assert(opening.includes("FROM (SELECT clock_timestamp() AS occurred_at) fact_clock"), "opening fact must use one post-lock wall-clock instant");
assert(opening.includes("(fact_clock.occurred_at AT TIME ZONE 'Asia/Shanghai')::date"), "opening business date must derive from the same fact instant in Shanghai");
assert(!opening.includes("gen_random_uuid()"), "opening stock must not invent source ids");
assert(adjustment.includes("InventoryPostingCommand.testAdjustment"), "A134 adjustment endpoint must remain an explicit test posting seam");

const mainFiles = await javaSources(mainRoot);
const mainEntries = await Promise.all(mainFiles.map(async (absolutePath) => ({
  absolutePath,
  source: await readFile(absolutePath, "utf8")
})));
const directTxnWriters = mainEntries
  .filter(({ source }) => /INSERT\s+INTO\s+inv_stock_txn/i.test(source))
  .map(({ absolutePath }) => path.relative(root, absolutePath))
  .sort();
assert.deepEqual(directTxnWriters, [
  "backend/src/main/java/com/jdy/erp/inventory/application/InventoryPostingService.java",
  "backend/src/main/java/com/jdy/erp/inventory/application/OpeningStockService.java"
], "inventory facts may only be written by the typed posting service or controlled opening stock service");

for (const { absolutePath, source } of mainEntries) {
  const relativePath = path.relative(root, absolutePath);
  if (relativePath !== "backend/src/main/java/com/jdy/erp/shared/application/PostingContext.java") {
    assert(
      !/new\s+PostingContext\s*\(/.test(source),
      `${relativePath} must use the explicit inventory/finance PostingContext factories`
    );
    assert(
      !/new\s+PostingContext\s*\(\s*InventoryPostingHook\.CHANNEL/.test(source),
      `${relativePath} must not use the lossy legacy inventory PostingContext constructor`
    );
  }
  if (relativePath !== "backend/src/main/java/com/jdy/erp/inventory/application/InventoryPostingService.java") {
    assert(
      !/inventoryPostingService\.(?:post|reserve|releaseReservation|shipReserved|reverseShipReserved)\(\s*"/.test(source),
      `${relativePath} must not call a legacy five-argument inventory posting overload`
    );
  }
}

for (const column of [
  "source_bill_no VARCHAR(80)",
  "source_bill_date DATE",
  "posting_action VARCHAR(24)",
  "qty_on_hand_after NUMERIC(18, 4)",
  "trace_quality VARCHAR(24)",
  "reversal_of_txn_id UUID"
]) {
  assert(v106.includes(column), `published V106 is missing ${column}`);
}
assert(v106.includes("trace_quality = 'HEADER_ONLY'"), "published V106 must mark uniquely resolved historical headers");
assert(v106.includes("ELSE 'LEGACY'"), "published V106 must mark unresolved historical rows");
assert(v106.includes("THEN 'TEST'"), "published V106 must isolate A-number historical test rows");
assert(v106.includes("sys_account_set_backup"), "published V106 must evolve historical backup schemas");
assert(v106.includes("CREATE UNIQUE INDEX IF NOT EXISTS uq_inv_stock_txn_exact_posting_fact"), "published V106 content must retain its applied unique index");
assert(v107.includes("DROP INDEX IF EXISTS %I.%I"), "V107 must remove the published unique exact-fact index in every target schema");
assert(v107.includes("uq_inv_stock_txn_exact_posting_fact"), "V107 must name the published unique index explicitly");
assert(v107.includes("CREATE INDEX %I ON %I.inv_stock_txn"), "V107 must install a non-unique exact-fact index");
assert(!v107.includes("CREATE UNIQUE INDEX"), "V107 must not recreate a cycle-blocking unique index");
assert(v107.includes("sys_account_set_backup"), "V107 must correct registered backup schemas");
assert(v107.includes("'PRODUCTION_COMPLETE', 'production_completion'"), "V107 must backfill the historical product-in source prefix");
assert(v107.includes("(created_at AT TIME ZONE ''Asia/Shanghai'')::date"), "V107 LEGACY production backfill must use the fixed Shanghai date");
assert(v107.includes("txn.trace_quality = 'HEADER_ONLY'"), "V107 must repair already-resolved production header-only dates");
assert(v107.includes("SET source_bill_date = (header.created_at AT TIME ZONE 'Asia/Shanghai')::date"), "V107 must forward-correct V106 session-dependent production dates");
assert(!/SET[\s\S]{0,300}source_bill_line_id\s*=/i.test(v106 + "\n" + v107), "inventory trace migrations must never guess a historical line id");
for (const index of [
  "idx_inv_stock_txn_scope_business_time",
  "idx_inv_stock_txn_exact_source",
  "idx_inv_stock_txn_reversal"
]) {
  assert(v106.includes(index), `published V106 is missing required index ${index}`);
}
assert(v107.includes("idx_inv_stock_txn_exact_posting_fact"), "V107 is missing the final non-unique exact-fact index");
assert(v106.includes("jdy_sync_tenant_schema"), "published V106 must preserve tenant-managed table topology");

for (const relativePath of [
  "backend/src/main/java/com/jdy/erp/production/application/MaterialIssueAppService.java",
  "backend/src/main/java/com/jdy/erp/production/application/ProductInAppService.java"
]) {
  const source = formalSourceByPath.get(relativePath);
  assert(source.includes("created_at AT TIME ZONE 'Asia/Shanghai'"), `${relativePath} exact trace date must be session-independent`);
  assert(source.includes("to_char(") && source.includes("AT TIME ZONE 'Asia/Shanghai', 'YYYY-MM-DD') AS \"billDate\""), `${relativePath} detail date must match its trace date`);
}

for (const marker of [
  "concurrentAbsoluteOpeningSavesSerializeBalanceAndLedger",
  "postingFactClockFollowsBalanceSerializationNotTransactionStart",
  "openingPreservesReservationsUsesShanghaiFactDateAndRejectsBelowReserved",
  "reversedDraftLineReplacementDowngradesOldFactsWithoutRetargeting",
  "auditedDeliverySaveIsZeroMutationAndPostingHistoryBlocksPhysicalDelete",
  "deliveryDeleteVersusAuditNeverLeavesOrphanInventoryHistory"
]) {
  assert(formalTraceTest.includes(marker), `dynamic A147 P1 proof is missing: ${marker}`);
}
assert(formalTraceTest.includes("HEADER_ONLY"), "line replacement proof must assert historical header-only degradation");
assert(formalTraceTest.includes("sourceBillLineId\", null"), "line replacement proof must assert stale line identity is cleared");
assert(materialTraceTest.includes("TIMESTAMPTZ '2026-07-13 16:30:00+00'"), "exact production trace test must cross the Shanghai date boundary");
assert(materialTraceTest.includes('isEqualTo("2026-07-14")'), "exact production trace test must expect the Shanghai business date");
assert(migrationRegression.includes("America/Los_Angeles"), "migration upgrade proof must use a non-Shanghai database session time zone");
assert(migrationRegression.includes("TIMESTAMPTZ '2026-07-13 16:30:00+00'"), "migration fixture must cross the Shanghai date boundary");
assert(migrationRegression.includes("|2026-07-14|AUDIT|HEADER_ONLY"), "migration proof must assert the corrected production date");

console.log("A147 inventory source trace regression passed");
