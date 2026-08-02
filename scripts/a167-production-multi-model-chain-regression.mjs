import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { installApiSession } from "./helpers/regression-auth.mjs";
import { upsertMasterDataFixture } from "./helpers/master-data-actions.mjs";

const rootDir = path.resolve(import.meta.dirname, "..");
const verificationDir = path.join(rootDir, "verification");
const resultPath = path.join(verificationDir, "a167-production-multi-model-chain-regression.json");
const apiBase = process.env.JDY_API_BASE || "http://127.0.0.1:8080";

await installApiSession(apiBase);
await mkdir(verificationDir, { recursive: true });

const batch = new Date().toISOString().replace(/\D/g, "").slice(0, 14);
const billDate = new Date().toISOString().slice(0, 10);
const parentA = "A167-FG-CY-" + batch;
const parentB = "A167-FG-HJ-" + batch;
const materialA = "A167-RM-CY-" + batch;
const materialB = "A167-RM-HJ-" + batch;
const bomA = "BOM-A167-CY-" + batch;
const bomB = "BOM-A167-HJ-" + batch;

function assert(condition, message, details) {
  if (!condition) {
    const suffix = details === undefined ? "" : ": " + JSON.stringify(details);
    throw new Error(message + suffix);
  }
}

function numberOf(value) {
  const number = Number(value);
  assert(Number.isFinite(number), "expected finite number", value);
  return number;
}

async function request(pathname, options = {}) {
  const response = await fetch(apiBase + pathname, {
    method: options.method || "GET",
    headers: options.body === undefined ? undefined : { "Content-Type": "application/json" },
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
    throw new Error((options.method || "GET") + " " + pathname + " failed " + result.response.status + ": " + result.text);
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

async function seedStock(lines) {
  const draft = await requireJson("/api/other-stock-ins/draft", {
    method: "POST",
    body: {
      supplierCode: "GYS-001",
      billDate,
      department: "仓储部",
      ownerName: "A167多型号整链回归",
      lines
    }
  });
  return requireJson("/api/other-stock-ins/" + encodeURIComponent(draft.billNo) + "/audit", { method: "POST" });
}

async function listRows(listKey, keyword) {
  const query = new URLSearchParams({
    keyword: keyword || "",
    page: "1",
    pageSize: "1000",
    view: "detail"
  });
  const data = await requireJson("/api/lists/" + listKey + "?" + query);
  return Array.isArray(data.rows) ? data.rows : [];
}

const parentARow = await upsertProduct(parentA, {
  name: "A167冲压多型号总成",
  category: "成品总成",
  unit: "只",
  spec: "A167 / 冲压",
  defaultWarehouseCode: "CK-002",
  defaultWorkshop: "CY",
  isSale: "true",
  isInventory: "true",
  isProduce: "true",
  isPurchase: "false",
  taxRate: "13",
  status: "启用"
});
const parentBRow = await upsertProduct(parentB, {
  name: "A167焊接多型号总成",
  category: "成品总成",
  unit: "只",
  spec: "A167 / 焊接",
  defaultWarehouseCode: "CK-003",
  defaultWorkshop: "HJ",
  isSale: "true",
  isInventory: "true",
  isProduce: "true",
  isPurchase: "false",
  taxRate: "13",
  status: "启用"
});
await upsertProduct(materialA, {
  name: "A167冲压原料",
  category: "零配件",
  unit: "件",
  spec: "A167 / 单耗2",
  defaultWarehouseCode: "CK-001",
  isPurchase: "false",
  isInventory: "true",
  isProduce: "false",
  taxRate: "13",
  status: "启用"
});
await upsertProduct(materialB, {
  name: "A167焊接原料",
  category: "零配件",
  unit: "件",
  spec: "A167 / 单耗3",
  defaultWarehouseCode: "CK-004",
  isPurchase: "false",
  isInventory: "true",
  isProduce: "false",
  taxRate: "13",
  status: "启用"
});

await requireJson("/api/production/boms", {
  method: "POST",
  body: {
    code: bomA,
    productCode: parentA,
    qty: 1,
    lines: [{ materialCode: materialA, qty: 2, issueWarehouseCode: "CK-001" }]
  }
});
await requireJson("/api/production/boms/" + encodeURIComponent(bomA) + "/audit", { method: "POST" });
await requireJson("/api/production/boms", {
  method: "POST",
  body: {
    code: bomB,
    productCode: parentB,
    qty: 1,
    lines: [{ materialCode: materialB, qty: 3, issueWarehouseCode: "CK-004" }]
  }
});
await requireJson("/api/production/boms/" + encodeURIComponent(bomB) + "/audit", { method: "POST" });

await seedStock([
  {
    productCode: materialA,
    warehouseCode: "CK-001",
    sourceLineNo: 1,
    qty: 20,
    unitPrice: 1,
    lineRemark: "A167冲压备料"
  },
  {
    productCode: materialB,
    warehouseCode: "CK-004",
    sourceLineNo: 2,
    qty: 20,
    unitPrice: 1,
    lineRemark: "A167焊接备料"
  }
]);

const planPayload = {
  sourceType: "SELF",
  lines: [
    {
      productId: parentARow.id,
      productCode: parentA,
      bomCode: bomA,
      warehouseCode: "CK-002",
      departmentCode: "CY",
      qty: 3,
      planDeliveryDate: billDate,
      expandMultilevelTasks: false,
      generatePurchaseRequisition: false
    },
    {
      productId: parentBRow.id,
      productCode: parentB,
      bomCode: bomB,
      warehouseCode: "CK-003",
      departmentCode: "HJ",
      qty: 2,
      planDeliveryDate: billDate,
      expandMultilevelTasks: false,
      generatePurchaseRequisition: false
    }
  ]
};
const createdPlan = await requireJson("/api/production/plans", { method: "POST", body: planPayload });
assert(createdPlan.status === "DRAFT", "multi-model plan must be saved as draft", createdPlan);
assert(Array.isArray(createdPlan.lines) && createdPlan.lines.length === 2, "plan must persist two lines", createdPlan.lines);
assert(createdPlan.lines[0].productId === parentARow.id, "line 1 must keep selected parent product id", createdPlan.lines[0]);
assert(createdPlan.lines[1].productId === parentBRow.id, "line 2 must keep selected parent product id", createdPlan.lines[1]);
const originalLineIds = createdPlan.lines.map((line) => line.id);

const savedAgain = await requireJson("/api/production/plans", {
  method: "POST",
  body: { ...planPayload, billNo: createdPlan.billNo }
});
assert(savedAgain.lines.map((line) => line.id).join(",") === originalLineIds.join(","), "editing a plan must keep stable line ids", savedAgain.lines);

const reopenedPlan = await requireJson("/api/production/plans/" + encodeURIComponent(createdPlan.billNo));
assert(reopenedPlan.lines.length === 2, "reopened plan must still contain two lines", reopenedPlan.lines);
assert(reopenedPlan.lines[0].productCode === parentA && reopenedPlan.lines[1].productCode === parentB, "reopened plan products must not cross lines", reopenedPlan.lines);

const auditedPlan = await requireJson("/api/production/plans/" + encodeURIComponent(createdPlan.billNo) + "/audit", { method: "POST" });
assert(auditedPlan.status === "AUDITED", "plan audit must succeed", auditedPlan);

const pushed = await requireJson("/api/production/plans/" + encodeURIComponent(createdPlan.billNo) + "/push-down", { method: "POST" });
assert(Array.isArray(pushed.productionTasks) && pushed.productionTasks.length === 2, "two plan lines must create exactly two tasks", pushed);
assert(Array.isArray(pushed.purchaseRequisitions) && pushed.purchaseRequisitions.length === 0, "non-purchase BOM materials must not create requisitions", pushed);
const tasks = [...pushed.productionTasks].sort((left, right) => numberOf(left.planLineNo) - numberOf(right.planLineNo));
const taskA = tasks[0];
const taskB = tasks[1];
assert(numberOf(taskA.planLineNo) === 1 && numberOf(taskB.planLineNo) === 2, "tasks must trace distinct plan lines", tasks);

const duplicatePush = await request("/api/production/plans/" + encodeURIComponent(createdPlan.billNo) + "/push-down", { method: "POST" });
assert(duplicatePush.response.status === 409, "duplicate plan pushdown must be blocked", duplicatePush.data);

const taskADetail = await requireJson("/api/production/tasks/" + encodeURIComponent(taskA.billNo));
const taskBDetail = await requireJson("/api/production/tasks/" + encodeURIComponent(taskB.billNo));
assert(taskADetail.document.planLineNo === 1 && taskADetail.productInfo.productCode === parentA, "task A must trace plan line 1 and parent A", taskADetail);
assert(taskBDetail.document.planLineNo === 2 && taskBDetail.productInfo.productCode === parentB, "task B must trace plan line 2 and parent B", taskBDetail);
assert(numberOf(taskADetail.lines[0].qty) === 6, "task A material snapshot must be 3 x 2", taskADetail.lines);
assert(numberOf(taskBDetail.lines[0].qty) === 6, "task B material snapshot must be 2 x 3", taskBDetail.lines);

const resavedTaskA = await requireJson("/api/production/plans/" + encodeURIComponent(createdPlan.billNo) + "/tasks", {
  method: "POST",
  body: {
    billNo: taskA.billNo,
    planLineNo: 1,
    qty: 3
  }
});
assert(resavedTaskA.billNo === taskA.billNo && numberOf(resavedTaskA.qty) === 3, "editing task must exclude itself from assigned plan qty", resavedTaskA);

await requireJson("/api/production/tasks/" + encodeURIComponent(taskA.billNo) + "/audit", { method: "POST" });
await requireJson("/api/production/tasks/" + encodeURIComponent(taskB.billNo) + "/audit", { method: "POST" });

const issueA = await requireJson("/api/production/tasks/" + encodeURIComponent(taskA.billNo) + "/issue", {
  method: "POST",
  body: { materialWarehouseCode: "CK-001" }
});
const issueB = await requireJson("/api/production/tasks/" + encodeURIComponent(taskB.billNo) + "/issue", {
  method: "POST",
  body: { materialWarehouseCode: "CK-004" }
});
const issueADetail = await requireJson("/api/production/material-issues/" + encodeURIComponent(issueA.billNo));
const issueBDetail = await requireJson("/api/production/material-issues/" + encodeURIComponent(issueB.billNo));
assert(numberOf(issueADetail.lines[0].qty) === 6 && issueADetail.lines[0].productCode === materialA, "task A must generate its own six-unit issue", issueADetail.lines);
assert(numberOf(issueBDetail.lines[0].qty) === 6 && issueBDetail.lines[0].productCode === materialB, "task B must generate its own six-unit issue", issueBDetail.lines);
await requireJson("/api/production/material-issues/" + encodeURIComponent(issueA.billNo) + "/audit", { method: "POST" });
await requireJson("/api/production/material-issues/" + encodeURIComponent(issueB.billNo) + "/audit", { method: "POST" });

const productInSelectorRows = await listRows("product-in-task-source-selector", taskB.billNo);
const taskBSource = productInSelectorRows.find((row) => row.billNo === taskB.billNo);
assert(taskBSource, "fully issued task B must appear in product-in task selector", productInSelectorRows);
assert(taskBSource.productId === parentBRow.id && numberOf(taskBSource.completableQty) === 2, "product-in selector must expose parent B and completable qty 2", taskBSource);

const mismatchedProduct = await request("/api/production/product-ins/draft", {
  method: "POST",
  body: {
    sourceOrderNo: taskB.billNo,
    lines: [
      {
        productId: parentARow.id,
        productCode: parentA,
        warehouseCode: "CK-003",
        qty: 2,
        unitPrice: 1
      }
    ]
  }
});
assert(mismatchedProduct.response.status === 409, "product-in must reject a mother product that differs from its source task", mismatchedProduct.data);

const completionA = await requireJson("/api/production/material-issues/" + encodeURIComponent(issueA.billNo) + "/push-product-in", { method: "POST" });
const completionB = await requireJson("/api/production/product-ins/draft", {
  method: "POST",
  body: {
    sourceOrderNo: taskB.billNo,
    lines: [
      {
        productId: taskBSource.productId,
        productCode: taskBSource.productCode,
        warehouseCode: taskBSource.warehouseCode,
        qty: taskBSource.completableQty,
        unitPrice: 1
      }
    ]
  }
});
assert(completionA.sourceIssueNo === issueA.billNo, "issue-pushed product-in must keep source issue trace", completionA);
assert(completionB.sourceOrderNo === taskB.billNo, "direct product-in must keep source task trace", completionB);
await requireJson("/api/production/product-ins/" + encodeURIComponent(completionA.billNo) + "/audit", { method: "POST" });
await requireJson("/api/production/product-ins/" + encodeURIComponent(completionB.billNo) + "/audit", { method: "POST" });

const reverseIssueAfterReceipt = await request("/api/production/material-issues/" + encodeURIComponent(issueA.billNo) + "/reverse", { method: "POST" });
assert(reverseIssueAfterReceipt.response.status === 409, "an issue with downstream product-in must not be reversed", reverseIssueAfterReceipt.data);

const completionADetail = await requireJson("/api/production/product-ins/" + encodeURIComponent(completionA.billNo));
const completionBDetail = await requireJson("/api/production/product-ins/" + encodeURIComponent(completionB.billNo));
assert(completionADetail.document.status === "AUDITED" && numberOf(completionADetail.lines[0].qty) === 3, "parent A product-in must be audited for qty 3", completionADetail);
assert(completionADetail.document.sourceIssueNo === issueA.billNo, "parent A product-in detail must expose source issue", completionADetail.document);
assert(completionBDetail.document.status === "AUDITED" && numberOf(completionBDetail.lines[0].qty) === 2, "parent B product-in must be audited for qty 2", completionBDetail);

const taskListRows = await listRows("production-task-list", createdPlan.billNo);
const taskARow = taskListRows.find((row) => row.billNo === taskA.billNo);
const taskBRow = taskListRows.find((row) => row.billNo === taskB.billNo);
assert(taskARow && numberOf(taskARow.issuedQty) === 3 && numberOf(taskARow.completedQty) === 3, "task A must report issued/completed sets as 3/3", taskARow);
assert(taskBRow && numberOf(taskBRow.issuedQty) === 2 && numberOf(taskBRow.completedQty) === 2, "task B must report issued/completed sets as 2/2", taskBRow);

const finalPlan = await requireJson("/api/production/plans/" + encodeURIComponent(createdPlan.billNo));
assert(numberOf(finalPlan.lines[0].assignedQty) === 3 && numberOf(finalPlan.lines[1].assignedQty) === 2, "plan lines must each show their assigned task qty", finalPlan.lines);

const result = {
  ok: true,
  apiBase,
  batch,
  fixtures: {
    parentA,
    parentB,
    materialA,
    materialB,
    bomA,
    bomB
  },
  planNo: createdPlan.billNo,
  taskNos: [taskA.billNo, taskB.billNo],
  materialIssueNos: [issueA.billNo, issueB.billNo],
  productInNos: [completionA.billNo, completionB.billNo],
  checks: {
    stableProductIds: true,
    stablePlanLineIds: true,
    planLineCount: finalPlan.lines.length,
    taskCount: tasks.length,
    duplicatePushBlocked: true,
    materialIssueQty: [numberOf(issueADetail.lines[0].qty), numberOf(issueBDetail.lines[0].qty)],
    issuedSets: [numberOf(taskARow.issuedQty), numberOf(taskBRow.issuedQty)],
    completedQty: [numberOf(taskARow.completedQty), numberOf(taskBRow.completedQty)],
    mismatchBlocked: true,
    issueReverseBlockedAfterReceipt: true,
    productInSelectorCompletableQty: numberOf(taskBSource.completableQty)
  }
};

await writeFile(resultPath, JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));
