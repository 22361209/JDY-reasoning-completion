#!/usr/bin/env node

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { installApiSession, loginApi } from "./helpers/regression-auth.mjs";
import { upsertMasterDataFixture } from "./helpers/master-data-actions.mjs";

const rootDir = path.resolve(import.meta.dirname, "..");
const verificationDir = path.join(rootDir, "verification");
const resultPath = path.join(verificationDir, "a170-multilevel-production-procurement-regression.json");
const apiBase = process.env.JDY_API_BASE || "http://127.0.0.1:8080";

await installApiSession(apiBase);
await mkdir(verificationDir, { recursive: true });

const batch = new Date().toISOString().replace(/\D/g, "").slice(0, 14);
const billDate = new Date().toISOString().slice(0, 10);
const rootProduct = `A170-FG-ROOT-${batch}`;
const midProduct = `A170-SA-MID-${batch}`;
const purchaseOnlyRoot = `A170-FG-PUR-${batch}`;
const taskOnlyRoot = `A170-FG-TASK-${batch}`;
const materialA = `A170-RM-A-${batch}`;
const materialB = `A170-RM-B-${batch}`;
const materialC = `A170-RM-C-${batch}`;
const rootBom = `BOM-A170-ROOT-${batch}`;
const midBom = `BOM-A170-MID-${batch}`;
const purchaseOnlyBom = `BOM-A170-PUR-${batch}`;
const taskOnlyBom = `BOM-A170-TASK-${batch}`;

function assert(condition, message, details = undefined) {
  if (!condition) {
    throw new Error(`${message}${details === undefined ? "" : `: ${JSON.stringify(details)}`}`);
  }
}

function numberOf(value) {
  const number = Number(value);
  assert(Number.isFinite(number), "expected finite number", value);
  return number;
}

async function request(pathname, options = {}) {
  const response = await fetch(`${apiBase}${pathname}`, {
    method: options.method || "GET",
    headers: options.headers || (options.body === undefined ? undefined : { "Content-Type": "application/json" }),
    body: options.body === undefined ? undefined : JSON.stringify(options.body)
  });
  const text = await response.text();
  let data = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { text };
  }
  return { response, data, text };
}

async function requireJson(pathname, options = {}) {
  const result = await request(pathname, options);
  if (!result.response.ok) {
    throw new Error(`${options.method || "GET"} ${pathname} failed ${result.response.status}: ${result.text}`);
  }
  return result.data;
}

async function upsertProduct(code, payload) {
  return upsertMasterDataFixture({
    apiBase,
    type: "product",
    payload: { code, ...payload },
    audit: true
  });
}

async function saveAndAuditBom(code, productCode, lines) {
  const saved = await requireJson("/api/production/boms", {
    method: "POST",
    body: { code, productCode, qty: 1, lines }
  });
  await requireJson(`/api/production/boms/${encodeURIComponent(code)}/audit`, { method: "POST" });
  return saved;
}

async function listRows(listKey, keyword = "") {
  const query = new URLSearchParams({ keyword, page: "1", pageSize: "500", view: "header" });
  const result = await requireJson(`/api/lists/${listKey}?${query}`);
  return Array.isArray(result.rows) ? result.rows : [];
}

const session = await requireJson("/api/system/session");
assert(session.tenant?.code === "BLD-TEST" && session.tenant?.schemaName === "public", "A170 may only write BLD-TEST/public", session.tenant);

const commonFinishedProduct = {
  category: "成品总成",
  unit: "只",
  defaultWarehouseCode: "CK-002",
  defaultWorkshop: "HJ",
  isSale: "true",
  isInventory: "true",
  isProduce: "true",
  isPurchase: "false",
  taxRate: "13",
  status: "启用"
};

const rootRow = await upsertProduct(rootProduct, {
  ...commonFinishedProduct,
  name: "A170多层任务总成",
  spec: "A170 / 多层"
});
await upsertProduct(midProduct, {
  ...commonFinishedProduct,
  name: "A170自制中间件",
  spec: "A170 / 中间件",
  defaultWarehouseCode: "CK-003",
  defaultWorkshop: "CY"
});
const purchaseOnlyRow = await upsertProduct(purchaseOnlyRoot, {
  ...commonFinishedProduct,
  name: "A170仅采购下推总成",
  spec: "A170 / 仅采购"
});
const taskOnlyRow = await upsertProduct(taskOnlyRoot, {
  ...commonFinishedProduct,
  name: "A170仅根任务总成",
  spec: "A170 / 仅根任务"
});

await upsertProduct(materialA, {
  name: "A170默认供应商一零件",
  category: "零配件",
  unit: "件",
  spec: "A170 / A",
  defaultWarehouseCode: "CK-001",
  defaultSupplierCode: "GYS-001",
  isPurchase: "true",
  isInventory: "true",
  isProduce: "false",
  purchasePrice: "2.50",
  taxRate: "13",
  status: "启用"
});
await upsertProduct(materialB, {
  name: "A170待补供应商零件",
  category: "零配件",
  unit: "件",
  spec: "A170 / B",
  defaultWarehouseCode: "CK-004",
  defaultSupplierCode: "",
  isPurchase: "true",
  isInventory: "true",
  isProduce: "false",
  purchasePrice: "3.50",
  taxRate: "13",
  status: "启用"
});
await upsertProduct(materialC, {
  name: "A170可删除采购零件",
  category: "零配件",
  unit: "件",
  spec: "A170 / C",
  defaultWarehouseCode: "CK-002",
  defaultSupplierCode: "GYS-002",
  isPurchase: "true",
  isInventory: "true",
  isProduce: "false",
  purchasePrice: "4.50",
  taxRate: "13",
  status: "启用"
});

await saveAndAuditBom(midBom, midProduct, [
  { materialCode: materialA, qty: 2, issueWarehouseCode: "CK-001" },
  { materialCode: materialB, qty: 3, issueWarehouseCode: "CK-004" }
]);
await saveAndAuditBom(rootBom, rootProduct, [
  { materialCode: midProduct, qty: 4, childBomCode: midBom, issueWarehouseCode: "CK-003" }
]);
await saveAndAuditBom(purchaseOnlyBom, purchaseOnlyRoot, [
  { materialCode: materialC, qty: 1, issueWarehouseCode: "CK-002" }
]);
await saveAndAuditBom(taskOnlyBom, taskOnlyRoot, [
  { materialCode: materialC, qty: 1, issueWarehouseCode: "CK-002" }
]);

const plan = await requireJson("/api/production/plans", {
  method: "POST",
  body: {
    sourceType: "SELF",
    lines: [
      {
        productId: rootRow.id,
        productCode: rootProduct,
        bomCode: rootBom,
        warehouseCode: "CK-002",
        departmentCode: "HJ",
        qty: 2,
        planDeliveryDate: billDate,
        expandMultilevelTasks: true,
        generatePurchaseRequisition: true
      },
      {
        productId: purchaseOnlyRow.id,
        productCode: purchaseOnlyRoot,
        bomCode: purchaseOnlyBom,
        warehouseCode: "CK-002",
        departmentCode: "HJ",
        qty: 5,
        planDeliveryDate: billDate,
        expandMultilevelTasks: false,
        generatePurchaseRequisition: true
      },
      {
        productId: taskOnlyRow.id,
        productCode: taskOnlyRoot,
        bomCode: taskOnlyBom,
        warehouseCode: "CK-002",
        departmentCode: "HJ",
        qty: 7,
        planDeliveryDate: billDate,
        expandMultilevelTasks: false,
        generatePurchaseRequisition: false
      }
    ]
  }
});
assert(plan.lines.length === 3, "one production plan must persist three models", plan.lines);
assert(plan.lines[0].expandMultilevelTasks === true && plan.lines[0].generatePurchaseRequisition === true, "line one switches must persist", plan.lines[0]);
assert(plan.lines[1].expandMultilevelTasks === false && plan.lines[1].generatePurchaseRequisition === true, "line two switches must persist independently", plan.lines[1]);
assert(plan.lines[2].expandMultilevelTasks === false && plan.lines[2].generatePurchaseRequisition === false, "line three switches must persist independently", plan.lines[2]);
await requireJson(`/api/production/plans/${encodeURIComponent(plan.billNo)}/audit`, { method: "POST" });

const pushed = await requireJson(`/api/production/plans/${encodeURIComponent(plan.billNo)}/push-down`, { method: "POST" });
assert(pushed.productionTasks?.length === 4, "three root tasks plus one selected BOM child task must be generated", pushed.productionTasks);
const lineOneTasks = pushed.productionTasks.filter((task) => numberOf(task.planLineNo) === 1);
const lineTwoTasks = pushed.productionTasks.filter((task) => numberOf(task.planLineNo) === 2);
const lineThreeTasks = pushed.productionTasks.filter((task) => numberOf(task.planLineNo) === 3);
assert(lineOneTasks.length === 2, "line one must expand to root and child task", lineOneTasks);
assert(lineTwoTasks.length === 1 && lineThreeTasks.length === 1, "unchecked lines must create root tasks only", pushed.productionTasks);
const rootTask = lineOneTasks.find((task) => task.sourceKind === "PLAN_ROOT");
const childTask = lineOneTasks.find((task) => task.sourceKind === "BOM_CHILD");
assert(rootTask && childTask && numberOf(childTask.sourceLevel) === 1, "child task must expose BOM source and level", lineOneTasks);
const childTaskDetail = await requireJson(`/api/production/tasks/${encodeURIComponent(childTask.billNo)}`);
assert(childTaskDetail.document.parentTaskNo === rootTask.billNo, "child task must point to its root parent task", childTaskDetail.document);
assert(childTaskDetail.document.rootTaskNo === rootTask.billNo, "child task must preserve root task trace", childTaskDetail.document);

assert(pushed.purchaseRequisitions?.length === 1, "all selected plan lines must generate one editable requisition", pushed.purchaseRequisitions);
const requisitionNo = pushed.purchaseRequisitions[0].billNo;
let requisition = await requireJson(`/api/purchase-requisitions/${encodeURIComponent(requisitionNo)}`);
assert(requisition.document.status === "DRAFT" && requisition.lines.length === 3, "generated requisition must be draft with three selected demand lines", requisition);
const lineA = requisition.lines.find((line) => line.productCode === materialA);
const lineB = requisition.lines.find((line) => line.productCode === materialB);
const lineC = requisition.lines.find((line) => line.productCode === materialC);
assert(lineA?.supplierCode === "GYS-001" && numberOf(lineA.qty) === 16, "nested line A must default supplier and calculate 2*4*2", lineA);
assert(!lineB?.supplierCode && numberOf(lineB?.qty) === 24, "nested line B must expose missing supplier and calculate 3*4*2", lineB);
assert(lineC?.supplierCode === "GYS-002" && numberOf(lineC.qty) === 5, "line two purchase switch must create its own demand", lineC);

requisition = await requireJson("/api/purchase-requisitions/draft", {
  method: "POST",
  body: {
    billNo: requisitionNo,
    version: numberOf(requisition.document.version),
    lines: [
      { id: lineA.id, qty: 15, supplierCode: "GYS-001" },
      { id: lineB.id, qty: 24, supplierCode: "" }
    ]
  }
});
assert(requisition.lines.length === 2, "draft save must allow deleting the selected C line", requisition.lines);
assert(numberOf(requisition.lines.find((line) => line.productCode === materialA)?.qty) === 15, "draft save must allow changing line quantity", requisition.lines);
await requireJson(`/api/purchase-requisitions/${encodeURIComponent(requisitionNo)}/audit`, { method: "POST" });

const missingSupplierPush = await request(`/api/purchase-requisitions/${encodeURIComponent(requisitionNo)}/push-down`, { method: "POST" });
assert(missingSupplierPush.response.status === 409, "missing line supplier must block purchase plan pushdown", missingSupplierPush.data);
const missingMessage = String(missingSupplierPush.data.reason || missingSupplierPush.data.message || missingSupplierPush.text);
assert(missingMessage.includes(materialB) && missingMessage.includes("供应商"), "missing supplier failure must identify the material line", missingMessage);

requisition = await requireJson(`/api/purchase-requisitions/${encodeURIComponent(requisitionNo)}/reverse`, { method: "POST" });
const revisedLines = requisition.lines.map((line) => ({
  id: line.id,
  qty: numberOf(line.qty),
  supplierCode: line.productCode === materialB ? "GYS-002" : line.supplierCode
}));
requisition = await requireJson("/api/purchase-requisitions/draft", {
  method: "POST",
  body: {
    billNo: requisitionNo,
    version: numberOf(requisition.document.version),
    lines: revisedLines
  }
});
assert(requisition.lines.find((line) => line.productCode === materialB)?.supplierCode === "GYS-002", "reversed draft must accept a replacement supplier", requisition.lines);
await requireJson(`/api/purchase-requisitions/${encodeURIComponent(requisitionNo)}/audit`, { method: "POST" });
const planned = await requireJson(`/api/purchase-requisitions/${encodeURIComponent(requisitionNo)}/push-down`, { method: "POST" });
assert(planned.purchasePlans?.length === 2, "two line suppliers must generate two purchase plans", planned.purchasePlans);

const purchasePlanDetails = await Promise.all(planned.purchasePlans.map((planRow) => (
  requireJson(`/api/purchase-plans/${encodeURIComponent(planRow.billNo)}`)
)));
const supplierOnePlan = purchasePlanDetails.find((detail) => detail.document.supplierCode === "GYS-001");
const supplierTwoPlan = purchasePlanDetails.find((detail) => detail.document.supplierCode === "GYS-002");
assert(supplierOnePlan?.document.status === "DRAFT" && numberOf(supplierOnePlan.document.totalQty) === 15, "supplier one plan must be a 15-unit draft", supplierOnePlan);
assert(supplierTwoPlan?.document.status === "DRAFT" && numberOf(supplierTwoPlan.document.totalQty) === 24, "supplier two plan must be a 24-unit draft", supplierTwoPlan);

const planOneNo = supplierOnePlan.document.billNo;
const auditedPlan = await requireJson(`/api/purchase-plans/${encodeURIComponent(planOneNo)}/audit`, { method: "POST" });
assert(auditedPlan.document.status === "AUDITED", "purchase plan must support audit", auditedPlan.document);
const reversedPlan = await requireJson(`/api/purchase-plans/${encodeURIComponent(planOneNo)}/reverse`, { method: "POST" });
assert(reversedPlan.document.status === "DRAFT", "purchase plan must support reverse audit", reversedPlan.document);

const requisitionRows = await listRows("purchase-requisition-list", requisitionNo);
assert(requisitionRows.length === 1 && numberOf(requisitionRows[0].lineCount) === 2, "requisition list must show one header row and current line count", requisitionRows);
const purchasePlanRows = await listRows("purchase-plan-list", requisitionNo);
assert(purchasePlanRows.length === 2, "purchase plan list must show both supplier-grouped plans", purchasePlanRows);
for (const supplierCode of ["GYS-001", "GYS-002"]) {
  const directOrderLines = await requireJson(`/api/purchase-orders/selectable-requisition-lines?supplierCode=${encodeURIComponent(supplierCode)}`);
  assert(!(directOrderLines.lines || []).some((line) => line.billNo === requisitionNo), "planned requisition lines must not be selectable directly for purchase order", { supplierCode, lines: directOrderLines.lines });
}

const warehouseCookie = await loginApi(apiBase, "warehouse", "warehouse123", "BLD-TEST");
const denied = await request(`/api/purchase-requisitions/${encodeURIComponent(requisitionNo)}`, {
  headers: { Cookie: warehouseCookie }
});
assert(denied.response.status === 403, "warehouse role must not bypass purchase planning permission", denied.data);

const result = {
  ok: true,
  batch,
  planNo: plan.billNo,
  productionTaskNos: pushed.productionTasks.map((task) => task.billNo),
  purchaseRequisitionNo: requisitionNo,
  purchasePlanNos: planned.purchasePlans.map((planRow) => planRow.billNo),
  checks: {
    perLineTaskSwitches: true,
    perLinePurchaseSwitches: true,
    nestedTaskTrace: true,
    nestedBomQuantities: true,
    defaultSupplier: true,
    removeLineAndEditQty: true,
    missingSupplierBlocked: true,
    supplierGroupedPlans: true,
    plannedLinesExcludedFromDirectOrder: true,
    purchasePermissionFailClosed: true
  }
};

await writeFile(resultPath, `${JSON.stringify(result, null, 2)}\n`);
console.log(JSON.stringify(result, null, 2));
