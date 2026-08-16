import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { installApiSession } from "./helpers/regression-auth.mjs";
import { upsertMasterDataFixture } from "./helpers/master-data-actions.mjs";

const rootDir = path.resolve(import.meta.dirname, "..");
const verificationDir = path.join(rootDir, "verification");
const resultPath = path.join(verificationDir, "a116-production-plan-pushdown-regression.json");
const apiBase = process.env.JDY_API_BASE || "http://127.0.0.1:8080";
await installApiSession(apiBase);
await mkdir(verificationDir, { recursive: true });

const batch = new Date().toISOString().replace(/\D/g, "").slice(0, 14);
const parentCode = `CP-A116-${batch}`;
const componentCode = "RM-A116-COMPONENT";
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
  return upsertMasterDataFixture({ apiBase, type: "product", payload: { code, ...payload }, audit: true });
}

async function findExactProduct(code) {
  const query = new URLSearchParams({ keyword: code, page: "1", pageSize: "200" });
  const result = await requireJson(`/api/lists/product-master-list?${query}`);
  const exact = Array.isArray(result.rows)
    ? result.rows.filter((row) => String(row?.code ?? "") === code)
    : [];
  assert(exact.length <= 1, `reusable A116 component expected at most one exact row, got ${exact.length}`);
  return exact[0] ?? null;
}

let component = await findExactProduct(componentCode);
const componentCreated = component === null;
if (componentCreated) {
  component = await upsertProduct(componentCode, {
    name: "A116计划采购子件",
    category: "零配件",
    unit: "件",
    spec: "A116 / 可复用采购前置",
    defaultWarehouseCode: "CK-002",
    defaultSupplierCode: "GYS-001",
    isPurchase: "true",
    isInventory: "true",
    isProduce: "false",
    status: "启用"
  });
}
assert(component.name === "A116计划采购子件", "reusable A116 component must keep its dedicated name");
assert(component.category === "零配件", "reusable A116 component must keep its category");
assert(component.unit === "件", "reusable A116 component must keep its unit snapshot source");
assert(component.spec === "A116 / 可复用采购前置", "reusable A116 component must keep its specification");
assert(component.auditStatus === "已审核", "reusable A116 component prerequisite must stay audited");
assert(component.status === "启用", "reusable A116 component prerequisite must stay enabled");
assert(component.isPurchase === "是" && component.isInventory === "是" && component.isProduce === "否", "reusable A116 component must remain purchase-only inventory");
assert(component.defaultWarehouseCode === "CK-002", "reusable A116 component must keep its default warehouse");
assert(component.defaultSupplierCode === "GYS-001", "reusable A116 component must keep the expected default supplier");

await upsertProduct(parentCode, {
  name: "A116计划下推总成",
  category: "成品总成",
  unit: "只",
  spec: "A116 / 当前BOM",
  defaultWarehouseCode: "CK-001",
  defaultWorkshop: "CY",
  isSale: "true",
  isInventory: "true",
  isProduce: "true",
  isPurchase: "false",
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
      { materialCode: componentCode, qty: 2 }
    ]
  }
});
assert(Array.isArray(bom.lines) && bom.lines.length === 1, "production BOM should persist exactly one component line");
assert(bom.lines[0]?.materialCode === componentCode, "production BOM should persist the reusable A116 component prerequisite");
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
assert(String(plan.departmentCode ?? "") === "CY", "plan should inherit the audited factory workshop code");
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
assert(Number(requisitionRow.totalQty) === 10, "purchase requisition total qty should equal BOM unit qty * plan qty");
assert(Number(requisitionRow.lineCount) === 1, "purchase requisition list should expose one header row with one line");
const requisitionDetail = await requireJson(`/api/purchase-requisitions/${encodeURIComponent(requisitionNo)}`);
assert(requisitionDetail.document.status === "DRAFT", "generated purchase requisition should remain editable draft");
assert(Array.isArray(requisitionDetail.lines) && requisitionDetail.lines.length === 1, "generated purchase requisition should contain exactly one line");
assert(Number(requisitionDetail.lines[0]?.qty) === 10, "purchase requisition detail should keep BOM demand quantity");
assert(requisitionDetail.lines[0]?.productCode === componentCode, "purchase requisition should keep the reusable A116 BOM component");
assert(requisitionDetail.lines[0]?.productName === component.name, "purchase requisition should snapshot the reusable component name");
assert(requisitionDetail.lines[0]?.spec === component.spec, "purchase requisition should snapshot the reusable component specification");
assert(requisitionDetail.lines[0]?.unit === component.unit, "purchase requisition should snapshot the reusable component unit");
assert(requisitionDetail.lines[0]?.supplierCode === "GYS-001", "purchase requisition line should default the product supplier");

const duplicate = await request(`/api/production/plans/${encodeURIComponent(plan.billNo)}/push-down`, { method: "POST" });
assert(duplicate.response.status === 409, "duplicate pushdown should be blocked after all plan qty is assigned");
const reverseAfterPushdown = await request(`/api/production/plans/${encodeURIComponent(plan.billNo)}/reverse`, { method: "POST" });
assert(reverseAfterPushdown.response.status === 409, "pushed-down production plan must not be reversed");

const result = {
  ok: true,
  batch,
  parentCode,
  componentCode,
  componentCreated,
  componentSnapshot: {
    name: component.name,
    category: component.category,
    unit: component.unit,
    spec: component.spec,
    auditStatus: component.auditStatus,
    status: component.status,
    defaultWarehouseCode: component.defaultWarehouseCode,
    defaultSupplierCode: component.defaultSupplierCode
  },
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
    componentPrerequisiteValidated: true,
    bomComponentCode: bom.lines[0]?.materialCode,
    defaultWorkshop: plan.departmentCode === "CY",
    requisitionComponentCode: requisitionDetail.lines[0]?.productCode,
    requisitionComponentName: requisitionDetail.lines[0]?.productName,
    requisitionComponentSpec: requisitionDetail.lines[0]?.spec,
    requisitionComponentUnit: requisitionDetail.lines[0]?.unit,
    purchaseQty: Number(requisitionRow.totalQty),
    duplicatePushdownBlocked: duplicate.response.status === 409,
    reverseAfterPushdownBlocked: reverseAfterPushdown.response.status === 409
  }
};

await writeFile(resultPath, JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));
