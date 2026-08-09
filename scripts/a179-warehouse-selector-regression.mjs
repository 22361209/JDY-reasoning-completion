#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import path from "node:path";

const rootDir = path.resolve(import.meta.dirname, "..");

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function source(relativePath) {
  return readFile(path.join(rootDir, relativePath), "utf8");
}

const [
  contracts,
  provider,
  documentModel,
  documentModule,
  salesOutDocument,
  outsourcingForm,
  registry,
  productFields,
  salesQuoteDocument,
  salesOrderDocument,
  purchaseOrderDocument,
  purchaseInDocument
] = await Promise.all([
  source("backend/src/main/java/com/jdy/erp/system/application/list/ListQueryContractRegistry.java"),
  source("backend/src/main/java/com/jdy/erp/system/application/list/StubListSeedRowsProvider.java"),
  source("frontend/src/app/documentModel.ts"),
  source("frontend/src/modules/documents/useDocumentModule.ts"),
  source("frontend/src/modules/sales/sales-out/useSalesOutDocument.ts"),
  source("frontend/src/modules/outsourcing/OutsourcingDocumentForm.vue"),
  source("frontend/src/modules/master-data/registry.ts"),
  source("frontend/src/modules/master-data/product/fields.ts"),
  source("frontend/src/modules/sales/sales-quote/useSalesQuoteDocument.ts"),
  source("frontend/src/modules/sales/sales-order/useSalesOrderDocument.ts"),
  source("frontend/src/modules/purchase/purchase-order/usePurchaseOrderDocument.ts"),
  source("frontend/src/modules/purchase/purchase-in/usePurchaseInDocument.ts")
]);

assert(
  /MASTER_SELECTOR_KEYS[\s\S]*?"warehouse-master-selector"/.test(contracts)
    && /warehouse[\s\S]*?List\.of\("code", "name", "warehouseType", "manager"\)/.test(contracts),
  "A179: warehouse selector must be an explicit list contract searchable by code, name, type and manager"
);
assert(
  /case "warehouse-master-list" -> realWarehouseRows\(false\);\s*case "warehouse-master-selector" -> realWarehouseRows\(true\);/.test(provider),
  "A179: warehouse maintenance and business selector queries must remain separate"
);
assert(
  /realWarehouseRows\(boolean selectorOnly\)[\s\S]*?WHERE enabled = TRUE AND audit_status = 'AUDITED'/.test(provider),
  "A179: business warehouse candidates must be audited and enabled"
);
assert(
  !documentModel.includes("knownWarehouseOptions"),
  "A179: static CK warehouse candidates must not remain available for business selectors"
);
assert(
  documentModule.includes('warehouse: "warehouse-master-selector"')
    && documentModule.includes('fetchListRows("warehouse-master-selector"')
    && !documentModule.includes("knownWarehouseOptions"),
  "A179: shared business documents and paste matching must use only the live warehouse selector"
);
for (const [label, wrapper] of [
  ["sales quote", salesQuoteDocument],
  ["sales order", salesOrderDocument],
  ["purchase order", purchaseOrderDocument],
  ["purchase in", purchaseInDocument]
]) {
  assert(wrapper.includes("useDocumentModule"), `A179: ${label} must remain on the shared warehouse selector path`);
}
assert(
  salesOutDocument.includes('warehouse: "warehouse-master-selector"')
    && salesOutDocument.includes('fetchListRows("warehouse-master-selector"')
    && !salesOutDocument.includes("knownWarehouseOptions"),
  "A179: sales-out warehouse entry and paste matching must use the live selector"
);
assert(
  outsourcingForm.includes('type === "warehouse" ? "warehouse-master-selector"'),
  "A179: outsourcing warehouse entry must use the live selector"
);
assert(
  registry.includes('masterDataDefinitions["warehouse-master-selector"]')
    && registry.includes('warehouse: "warehouse-master-selector"'),
  "A179: the full-list warehouse dialog must resolve the selector definition"
);
assert(
  productFields.includes('listKey: "warehouse-master-selector"'),
  "A179: default-warehouse lookup must not bypass audited-enabled candidates"
);

console.log(JSON.stringify({
  ok: true,
  selector: "warehouse-master-selector",
  forms: ["sales-quote", "sales-order", "purchase-order", "purchase-in", "sales-out", "outsourcing"]
}));
