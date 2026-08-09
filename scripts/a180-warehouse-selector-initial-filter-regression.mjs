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

const [documentModule, salesOutDocument, entryTable] = await Promise.all([
  source("frontend/src/modules/documents/useDocumentModule.ts"),
  source("frontend/src/modules/sales/sales-out/useSalesOutDocument.ts"),
  source("frontend/src/components/EntryTable.vue")
]);

const warehouseDialogStartsUnfiltered = /function openMasterSelectorDialog\(type: string, selectorId: string, keywordValue: string\)[\s\S]*?masterSelectorDialogKeyword\.value = type === "warehouse" \? "" : keywordValue;/.test(documentModule);
assert(
  warehouseDialogStartsUnfiltered,
  "A180: shared document warehouse dialogs must not use the current line warehouse as the initial filter"
);

const salesOutWarehouseDialogStartsUnfiltered = /function openMasterSelectorDialog\(type: string, selectorId: string, keywordValue: string\)[\s\S]*?masterSelectorDialogKeyword\.value = type === "warehouse" \? "" : keywordValue;/.test(salesOutDocument);
assert(
  salesOutWarehouseDialogStartsUnfiltered,
  "A180: sales-out warehouse dialogs must not use the current line warehouse as the initial filter"
);

assert(
  entryTable.includes("line.warehouseCode") && entryTable.includes("line.targetWarehouseCode || ''"),
  "A180: clearing the dialog filter must not clear the warehouse value stored on the document line"
);

console.log(JSON.stringify({
  ok: true,
  initialWarehouseKeyword: "",
  preservedLineValue: true,
  paths: ["shared-documents", "sales-out"]
}));
