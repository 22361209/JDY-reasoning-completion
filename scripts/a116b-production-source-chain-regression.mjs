import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { installApiSession } from "./helpers/regression-auth.mjs";

const rootDir = path.resolve(import.meta.dirname, "..");
const verificationDir = path.join(rootDir, "verification");
const resultPath = path.join(verificationDir, "a116b-production-source-chain-regression.json");
const apiBase = "http://127.0.0.1:8080";

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
  const update = await request(`/api/master-data/product/${encodeURIComponent(code)}`, {
    method: "PUT",
    body: { code, ...payload }
  });
  if (update.response.status === 404) {
    await requireJson("/api/master-data/product", {
      method: "POST",
      body: { code, ...payload }
    });
  } else if (!update.response.ok) {
    throw new Error(`product ${code} update failed ${update.response.status}: ${update.text}`);
  }
  await requireJson(`/api/master-data/product/${encodeURIComponent(code)}/audit`, { method: "POST" });
}

async function seedStock(lines) {
  const billNo = `QTRK-A116B-${batch}`;
  await requireJson("/api/other-stock-ins/draft", {
    method: "POST",
    body: {
      billNo,
      supplierCode: "GYS-001",
      billDate: "2026-06-29",
      department: "仓储部",
      ownerName: "A116B回归",
      lines
    }
  });
  return requireJson(`/api/other-stock-ins/${encodeURIComponent(billNo)}/audit`, { method: "POST" });
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

const planNoResult = await requireJson("/api/production/plans/next-number", { method: "POST" });
const plan = await requireJson("/api/production/plans", {
  method: "POST",
  body: {
    billNo: planNoResult.billNo,
    productCode: parentCode,
    qty: 5,
    planDeliveryDate: "2026-07-15",
    sourceType: "SELF"
  }
});

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

assert(Number(bomV2.versionNo) > Number(bomV1.versionNo), "second BOM save should create a newer history version");
assert(Number(plan.bomVersionNo) === Number(bomV1.versionNo), "production plan should snapshot BOM version before later BOM edits");
assert(plan.departmentCode === "HJ", "production plan should inherit parent material default workshop");

await seedStock([
  { productCode: materialA, warehouseCode: "CK-002", sourceLineNo: 1, qty: 200, unitPrice: 2.5, lineRemark: "A116B回归备料" },
  { productCode: materialB, warehouseCode: "CK-002", sourceLineNo: 2, qty: 200, unitPrice: 4, lineRemark: "A116B回归备料" }
]);

const pushDown = await requireJson(`/api/production/plans/${encodeURIComponent(plan.billNo)}/push-down`, { method: "POST" });
assert(Array.isArray(pushDown.productionTasks) && pushDown.productionTasks.length === 1, "pushdown should create one production task from single-parent plan");
assert(Array.isArray(pushDown.purchaseRequisitions) && pushDown.purchaseRequisitions.length === 2, "pushdown should split purchase requisitions by material default supplier");

const task = pushDown.productionTasks[0];
assert(task.departmentCode === "HJ", "production task should keep production plan workshop snapshot");
assert(Number(task.bomVersionNo) === Number(bomV1.versionNo), "production task should use the plan BOM history version, not the newer current BOM");

const supplierOneLines = await selectableRequisitionLines("GYS-001");
const sourceLine = supplierOneLines.find((line) => line.productCode === materialA && Number(line.remainingQty) === 10);
assert(sourceLine, "supplier GYS-001 should expose a selectable purchase requisition line with BOM V1 quantity");

const purchaseOrderNo = `CGDD-A116B-${batch}`;
await requireJson("/api/purchase-orders/draft", {
  method: "POST",
  body: {
    billNo: purchaseOrderNo,
    supplierCode: "GYS-001",
    billDate: "2026-06-29",
    department: "采购部",
    ownerName: "A116B回归",
    isTaxInclusive: false,
    lines: [
      {
        productCode: sourceLine.productCode,
        warehouseCode: sourceLine.warehouseCode || "CK-002",
        qty: Number(sourceLine.remainingQty),
        unitPrice: Number(sourceLine.unitPrice ?? 0),
        taxRate: Number(sourceLine.taxRate ?? 13),
        supplierMaterialCode: sourceLine.supplierMaterialCode || "",
        sourceOrderNo: sourceLine.billNo,
        sourceLineNo: Number(sourceLine.lineNo),
        planDeliveryDate: sourceLine.planDeliveryDate || "2026-07-15"
      }
    ]
  }
});
await requireJson(`/api/purchase-orders/${encodeURIComponent(purchaseOrderNo)}/audit`, { method: "POST" });
const afterOrderLines = await selectableRequisitionLines("GYS-001");
const consumedLine = afterOrderLines.find((line) => line.billNo === sourceLine.billNo && Number(line.lineNo) === Number(sourceLine.lineNo));
assert(!consumedLine, "audited purchase order should consume the selected purchase requisition line");

const issue = await requireJson(`/api/production/tasks/${encodeURIComponent(task.billNo)}/issue`, {
  method: "POST",
  body: { billNo: `SCLL-A116B-${batch}`, materialWarehouseCode: "CK-002" }
});
assert(issue.status === "AUDITED", "task issue should create an audited material issue");

const completion = await requireJson(`/api/production/material-issues/${encodeURIComponent(issue.billNo)}/push-product-in`, { method: "POST" });
assert(completion.billNo, "material issue pushdown should return product-in bill number");
assert(completion.sourceOrderNo === task.billNo, "product-in should keep source production task number");
assert(completion.sourceIssueNo === issue.billNo, "product-in pushdown should keep source material issue number");

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
  purchaseOrderNo,
  materialIssueNo: issue.billNo,
  productInNo: completion.billNo,
  checks: {
    bomHistorySnapshot: Number(task.bomVersionNo) === Number(bomV1.versionNo),
    defaultWorkshop: task.departmentCode === "HJ",
    splitPurchaseRequisitions: pushDown.purchaseRequisitions.length === 2,
    purchaseRequisitionConsumed: !consumedLine,
    materialIssuePushProductIn: productInDetail.document.status === "AUDITED"
  }
};

await writeFile(resultPath, JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));
