import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { installApiSession } from "./helpers/regression-auth.mjs";

const rootDir = path.resolve(import.meta.dirname, "..");
const verificationDir = path.join(rootDir, "verification");
const resultPath = path.join(verificationDir, "a116-production-plan-pushdown-regression.json");
const apiBase = "http://127.0.0.1:8080";
await installApiSession(apiBase);
await mkdir(verificationDir, { recursive: true });

const batch = new Date().toISOString().replace(/\D/g, "").slice(0, 14);
const parentCode = `CP-A116-${batch}`;
const bomCode = `BOM-A116-${batch}`;

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

await upsertProduct(parentCode, {
  name: "A116计划下推总成",
  category: "成品总成",
  unit: "只",
  spec: "A116 / 当前BOM",
  defaultWarehouseCode: "CK-001",
  defaultWorkshop: "SCB",
  isSale: "true",
  isInventory: "true",
  isProduce: "true",
  isPurchase: "false",
  taxRate: "13",
  status: "启用"
});

await upsertProduct("PJ-014", {
  name: "衬套",
  category: "零配件",
  unit: "件",
  spec: "65mm / 加强",
  defaultWarehouseCode: "CK-002",
  defaultSupplierCode: "GYS-001",
  isPurchase: "true",
  isInventory: "true",
  isProduce: "false",
  purchasePrice: "3.20",
  taxRate: "13",
  status: "启用"
});

const bom = await requireJson("/api/production/boms", {
  method: "POST",
  body: {
    code: bomCode,
    productCode: parentCode,
    qty: 1,
    lines: [
      { materialCode: "PJ-014", qty: 2 }
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

assert(/^SCJH\d{6}$/.test(plan.billNo), "production plan should generate SCJH number on first save");
assert(plan.bomCode === bomCode, "plan should resolve current BOM from product code");
assert(String(plan.departmentCode ?? "") === "SCB", "plan should inherit default workshop code");
assert(plan.status === "DRAFT", "saved production plan should stay draft before audit");

const draftPushDown = await request(`/api/production/plans/${encodeURIComponent(plan.billNo)}/push-down`, { method: "POST" });
assert(draftPushDown.response.status === 400, "draft production plan must not be pushed down");

const auditedPlan = await requireJson(`/api/production/plans/${encodeURIComponent(plan.billNo)}/audit`, { method: "POST" });
assert(auditedPlan.status === "AUDITED", "production plan should become audited before pushdown");

const pushDown = await requireJson(`/api/production/plans/${encodeURIComponent(plan.billNo)}/push-down`, { method: "POST" });
assert(Array.isArray(pushDown.productionTasks) && pushDown.productionTasks.length === 1, "pushdown should create one production task");
assert(Array.isArray(pushDown.purchaseRequisitions) && pushDown.purchaseRequisitions.length === 1, "pushdown should create one purchase requisition");

const requisitionNo = pushDown.purchaseRequisitions[0].billNo;
const requisitionList = await requireJson(`/api/lists/purchase-requisition-list?keyword=${encodeURIComponent(requisitionNo)}&pageSize=200`);
const requisitionRow = requisitionList.rows.find((row) => row.billNo === requisitionNo);
assert(requisitionRow, "purchase requisition list should show generated requisition");
assert(Number(requisitionRow.qty) === 10, "purchase requisition qty should equal BOM unit qty * plan qty");
assert(requisitionRow.supplierCode === "GYS-001", "purchase requisition should group by material default supplier");

const duplicate = await request(`/api/production/plans/${encodeURIComponent(plan.billNo)}/push-down`, { method: "POST" });
assert(duplicate.response.status === 409, "duplicate pushdown should be blocked after all plan qty is assigned");
const reverseAfterPushdown = await request(`/api/production/plans/${encodeURIComponent(plan.billNo)}/reverse`, { method: "POST" });
assert(reverseAfterPushdown.response.status === 409, "pushed-down production plan must not be reversed");

const result = {
  ok: true,
  batch,
  parentCode,
  bomCode: bom.code,
  bomVersionNo: bom.versionNo,
  planNo: plan.billNo,
  productionTaskNo: pushDown.productionTasks[0].billNo,
  purchaseRequisitionNo: requisitionNo,
  checks: {
    generatedPlanNo: /^SCJH\d{6}$/.test(plan.billNo),
    draftBeforeAudit: plan.status === "DRAFT",
    draftPushdownBlocked: draftPushDown.response.status === 400,
    auditedBeforePushdown: auditedPlan.status === "AUDITED",
    planUsesCurrentBom: plan.bomCode === bomCode,
    defaultWorkshop: plan.departmentCode === "SCB",
    purchaseQty: Number(requisitionRow.qty),
    duplicatePushdownBlocked: duplicate.response.status === 409,
    reverseAfterPushdownBlocked: reverseAfterPushdown.response.status === 409
  }
};

await writeFile(resultPath, JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));
