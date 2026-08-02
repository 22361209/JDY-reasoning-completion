import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { installApiSession } from "./helpers/regression-auth.mjs";
import { upsertMasterDataFixture } from "./helpers/master-data-actions.mjs";

const rootDir = path.resolve(import.meta.dirname, "..");
const verificationDir = path.join(rootDir, "verification");
const resultPath = path.join(verificationDir, "a116b-production-source-chain-regression.json");
const apiBase = process.env.JDY_API_BASE || "http://127.0.0.1:8080";

await installApiSession(apiBase);
await mkdir(verificationDir, { recursive: true });

const batch = new Date().toISOString().replace(/\D/g, "").slice(0, 14);
const parentCode = `CP-A116B-${batch}`;
const materialA = `PJ-A116B-A-${batch}`;
const materialB = `PJ-A116B-B-${batch}`;
const bomCode = `BOM-A116B-${batch}`;

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

async function request(pathname, options = {}) {
  const response = await fetch(`${apiBase}${pathname}`, {
    method: options.method ?? "GET",
    headers: options.body ? { "Content-Type": "application/json" } : undefined,
    body: options.body ? JSON.stringify(options.body) : undefined
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
  const { response, data, text } = await request(pathname, options);
  if (!response.ok) {
    throw new Error(`${options.method ?? "GET"} ${pathname} failed ${response.status}: ${text}`);
  }
  return data;
}

async function upsertProduct(code, payload) {
  return upsertMasterDataFixture({ apiBase, type: "product", payload: { code, ...payload }, audit: true });
}

async function seedStock(lines) {
  const draft = await requireJson("/api/other-stock-ins/draft", {
    method: "POST",
    body: {
      supplierCode: "GYS-001",
      billDate: "2026-06-29",
      department: "仓储部",
      ownerName: "A116B回归",
      lines
    }
  });
  return requireJson(`/api/other-stock-ins/${encodeURIComponent(draft.billNo)}/audit`, { method: "POST" });
}

async function selectableRequisitionLines(supplierCode) {
  const result = await requireJson(`/api/purchase-orders/selectable-requisition-lines?supplierCode=${encodeURIComponent(supplierCode)}`);
  return Array.isArray(result.lines) ? result.lines : [];
}

await upsertProduct(parentCode, {
  name: "A116B测试总成",
  category: "成品总成",
  unit: "只",
  spec: "A116B / 快照",
  defaultWarehouseCode: "CK-001",
  defaultWorkshop: "HJ",
  isSale: "true",
  isInventory: "true",
  isProduce: "true",
  isPurchase: "false",
  taxRate: "13",
  status: "启用"
});

await upsertProduct(materialA, {
  name: "A116B供应商一原料",
  category: "零配件",
  unit: "件",
  spec: "供应商一",
  defaultWarehouseCode: "CK-002",
  defaultSupplierCode: "GYS-001",
  isPurchase: "true",
  isInventory: "true",
  isProduce: "false",
  purchasePrice: "2.50",
  taxRate: "13",
  status: "启用"
});

await upsertProduct(materialB, {
  name: "A116B供应商二原料",
  category: "零配件",
  unit: "件",
  spec: "供应商二",
  defaultWarehouseCode: "CK-002",
  defaultSupplierCode: "GYS-002",
  isPurchase: "true",
  isInventory: "true",
  isProduce: "false",
  purchasePrice: "4.00",
  taxRate: "13",
  status: "启用"
});

const bomV1 = await requireJson("/api/production/boms", {
  method: "POST",
  body: {
    code: bomCode,
    productCode: parentCode,
    qty: 1,
    lines: [
      { materialCode: materialA, qty: 2 },
      { materialCode: materialB, qty: 3 }
    ]
  }
});
await requireJson(`/api/production/boms/${encodeURIComponent(bomCode)}/audit`, { method: "POST" });

const plan = await requireJson("/api/production/plans", {
  method: "POST",
  body: {
    productCode: parentCode,
    qty: 5,
    planDeliveryDate: "2026-07-15",
    sourceType: "SELF"
  }
});
await requireJson(`/api/production/plans/${encodeURIComponent(plan.billNo)}/audit`, { method: "POST" });

const bomV2 = await requireJson("/api/production/boms", {
  method: "POST",
  body: {
    code: bomCode,
    productCode: parentCode,
    qty: 1,
    lines: [
      { materialCode: materialA, qty: 99 }
    ]
  }
});
await requireJson(`/api/production/boms/${encodeURIComponent(bomCode)}/audit`, {
  method: "POST",
  body: {
    confirmNewVersion: true,
    latestBomCode: bomCode,
    latestVersionNo: bomV1.versionNo
  }
});

assert(Number(bomV2.versionNo) > Number(bomV1.versionNo), "second BOM save should create a newer history version");
assert(Number(plan.bomVersionNo) === Number(bomV1.versionNo), "production plan should snapshot BOM version before later BOM edits");
assert(plan.departmentCode === "HJ", "production plan should inherit parent material default workshop");

await seedStock([
  { productCode: materialA, warehouseCode: "CK-002", sourceLineNo: 1, qty: 200, unitPrice: 2.5, lineRemark: "A116B回归备料" },
  { productCode: materialB, warehouseCode: "CK-002", sourceLineNo: 2, qty: 200, unitPrice: 4, lineRemark: "A116B回归备料" }
]);

const pushDown = await requireJson(`/api/production/plans/${encodeURIComponent(plan.billNo)}/push-down`, { method: "POST" });
assert(Array.isArray(pushDown.productionTasks) && pushDown.productionTasks.length === 1, "pushdown should create one production task from single-parent plan");
assert(Array.isArray(pushDown.purchaseRequisitions) && pushDown.purchaseRequisitions.length === 1, "one plan pushdown should create one editable purchase requisition");

const task = pushDown.productionTasks[0];
assert(task.departmentCode === "HJ", "production task should keep production plan workshop snapshot");
assert(Number(task.bomVersionNo) === Number(bomV1.versionNo), "production task should use the plan BOM history version, not the newer current BOM");
await requireJson(`/api/production/tasks/${encodeURIComponent(task.billNo)}/audit`, { method: "POST" });

const requisitionNo = pushDown.purchaseRequisitions[0].billNo;
const requisition = await requireJson(`/api/purchase-requisitions/${encodeURIComponent(requisitionNo)}`);
assert(requisition.document.status === "DRAFT", "generated purchase requisition must be editable draft");
assert(requisition.lines.length === 2, "one purchase requisition must preserve both BOM demand lines");
const requisitionLineA = requisition.lines.find((line) => line.productCode === materialA);
const requisitionLineB = requisition.lines.find((line) => line.productCode === materialB);
assert(requisitionLineA?.supplierCode === "GYS-001" && Number(requisitionLineA.qty) === 10, "line A must use its default supplier and BOM V1 quantity");
assert(requisitionLineB?.supplierCode === "GYS-002" && Number(requisitionLineB.qty) === 15, "line B must use its default supplier and BOM V1 quantity");
await requireJson(`/api/purchase-requisitions/${encodeURIComponent(requisitionNo)}/audit`, { method: "POST" });
const planned = await requireJson(`/api/purchase-requisitions/${encodeURIComponent(requisitionNo)}/push-down`, { method: "POST" });
assert(Array.isArray(planned.purchasePlans) && planned.purchasePlans.length === 2, "purchase requisition should generate one purchase plan per supplier");
const purchasePlanNos = planned.purchasePlans.map((item) => item.billNo).sort();
const purchasePlanDetails = await Promise.all(purchasePlanNos.map((billNo) => requireJson(`/api/purchase-plans/${encodeURIComponent(billNo)}`)));
assert(purchasePlanDetails.every((detail) => detail.document.status === "DRAFT"), "generated purchase plans must remain draft");
const supplierOnePlan = purchasePlanDetails.find((detail) => detail.document.supplierCode === "GYS-001");
assert(supplierOnePlan && Number(supplierOnePlan.document.totalQty) === 10, "supplier one plan must total 10");
assert(purchasePlanDetails.some((detail) => detail.document.supplierCode === "GYS-002" && Number(detail.document.totalQty) === 15), "supplier two plan must total 15");
const afterDraftPlanLines = await selectableRequisitionLines("GYS-001");
const draftPlannedLine = afterDraftPlanLines.find((line) => line.billNo === requisitionNo);
assert(Number(draftPlannedLine?.remainingQty) === 10, "draft purchase plan must not occupy the requisition line");
await requireJson(`/api/purchase-plans/${encodeURIComponent(supplierOnePlan.document.billNo)}/audit`, { method: "POST" });
const afterAuditedPlanLines = await selectableRequisitionLines("GYS-001");
const auditedPlannedLine = afterAuditedPlanLines.find((line) => line.billNo === requisitionNo);
assert(!auditedPlannedLine, "audited purchase plan must occupy the requisition line");
await requireJson(`/api/purchase-plans/${encodeURIComponent(supplierOnePlan.document.billNo)}/reverse`, { method: "POST" });
const afterReversedPlanLines = await selectableRequisitionLines("GYS-001");
const reversedPlannedLine = afterReversedPlanLines.find((line) => line.billNo === requisitionNo);
assert(Number(reversedPlannedLine?.remainingQty) === 10, "reversed purchase plan must release the requisition line");

const issue = await requireJson(`/api/production/tasks/${encodeURIComponent(task.billNo)}/issue`, {
  method: "POST",
  body: { materialWarehouseCode: "CK-002" }
});
assert(issue.status === "DRAFT", "task issue pushdown should create a draft material issue");
await requireJson(`/api/production/material-issues/${encodeURIComponent(issue.billNo)}/audit`, { method: "POST" });

const completion = await requireJson(`/api/production/material-issues/${encodeURIComponent(issue.billNo)}/push-product-in`, { method: "POST" });
assert(completion.billNo, "material issue pushdown should return product-in bill number");
assert(completion.sourceOrderNo === task.billNo, "product-in should keep source production task number");
assert(completion.sourceIssueNo === issue.billNo, "product-in pushdown should keep source material issue number");
assert(completion.status === "DRAFT", "material issue pushdown should create a draft product-in");
await requireJson(`/api/production/product-ins/${encodeURIComponent(completion.billNo)}/audit`, { method: "POST" });

const productInDetail = await requireJson(`/api/production/product-ins/${encodeURIComponent(completion.billNo)}`);
assert(productInDetail.document.status === "AUDITED", "generated product-in should be audited");
assert(Number(productInDetail.lines?.[0]?.qty ?? 0) === 5, "product-in qty should equal remaining production task qty");

const result = {
  ok: true,
  batch,
  parentCode,
  materialA,
  materialB,
  bomCode,
  bomV1: bomV1.versionNo,
  bomV2: bomV2.versionNo,
  planNo: plan.billNo,
  productionTaskNo: task.billNo,
  purchaseRequisitionNo: requisitionNo,
  purchasePlanNos,
  materialIssueNo: issue.billNo,
  productInNo: completion.billNo,
  checks: {
    bomHistorySnapshot: Number(task.bomVersionNo) === Number(bomV1.versionNo),
    defaultWorkshop: task.departmentCode === "HJ",
    singleEditablePurchaseRequisition: pushDown.purchaseRequisitions.length === 1,
    supplierGroupedPurchasePlans: purchasePlanNos.length === 2,
    draftPurchasePlanDoesNotOccupy: Number(draftPlannedLine?.remainingQty) === 10,
    auditedPurchasePlanOccupies: !auditedPlannedLine,
    reversedPurchasePlanReleases: Number(reversedPlannedLine?.remainingQty) === 10,
    materialIssuePushProductIn: productInDetail.document.status === "AUDITED"
  }
};

await writeFile(resultPath, JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));
