#!/usr/bin/env node

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const rootDir = path.resolve(import.meta.dirname, "..");
const resultPath = path.join(rootDir, "verification/a176-purchase-plan-order-closure-regression.json");
const result = { ok: false, generatedAt: new Date().toISOString(), assertions: [] };

function assert(condition, message) {
  if (!condition) throw new Error(message);
  result.assertions.push(message);
}

try {
  const [migration, planService, orderService, planController, planForm, planningApi, documentApi, documentModule, purchaseOrderDocument, appVue] = await Promise.all([
    readFile(path.join(rootDir, "backend/src/main/resources/db/migration/V115__purchase_plan_to_order_source_trace.sql"), "utf8"),
    readFile(path.join(rootDir, "backend/src/main/java/com/jdy/erp/purchase/application/PurchasePlanAppService.java"), "utf8"),
    readFile(path.join(rootDir, "backend/src/main/java/com/jdy/erp/purchase/application/PurchaseOrderAppService.java"), "utf8"),
    readFile(path.join(rootDir, "backend/src/main/java/com/jdy/erp/purchase/api/PurchasePlanController.java"), "utf8"),
    readFile(path.join(rootDir, "frontend/src/modules/purchase/purchase-plan/PurchasePlanForm.vue"), "utf8"),
    readFile(path.join(rootDir, "frontend/src/services/purchasePlanningApi.ts"), "utf8"),
    readFile(path.join(rootDir, "frontend/src/services/documentApi.ts"), "utf8"),
    readFile(path.join(rootDir, "frontend/src/modules/documents/useDocumentModule.ts"), "utf8"),
    readFile(path.join(rootDir, "frontend/src/modules/purchase/purchase-order/usePurchaseOrderDocument.ts"), "utf8"),
    readFile(path.join(rootDir, "frontend/src/app/App.vue"), "utf8")
  ]);

  assert(migration.includes("ordered_qty NUMERIC(18, 4) NOT NULL DEFAULT 0"), "migration must add purchase-plan ordered quantity");
  assert(migration.includes("source_purchase_plan_id UUID"), "migration must store purchase-plan header trace");
  assert(migration.includes("source_purchase_plan_line_id UUID"), "migration must store purchase-plan line trace");
  assert(migration.includes("source_purchase_plan_no VARCHAR(80)"), "migration must store plan bill number trace");
  assert(migration.includes("source_purchase_plan_line_no INTEGER"), "migration must store plan line number trace");
  assert(migration.includes("idx_purchase_order_line_source_plan"), "migration must index purchase-plan order trace");
  assert(planController.includes("/{billNo}/push-down-order"), "purchase-plan controller must expose push-down-order endpoint");
  assert(orderService.includes("public Map<String, Object> reverse(String billNo)"), "purchase-order service must support reverse audit");
  assert(orderService.includes("requireNoAuditedPurchaseIn"), "purchase-order reverse must block after audited purchase-in");
  assert(orderService.includes("releasePurchasePlanOrdered(planSources)"), "purchase-order reverse must release plan ordered quantity");
  assert(orderService.includes("refreshPurchaseRequisitionQuantities(requisitionSources"), "purchase-order reverse must refresh direct requisition occupation");
  assert(planService.includes("public Map<String, Object> pushDownOrder(String billNo)"), "purchase-plan service must implement order pushdown");
  assert(planService.includes("只有已审核采购计划可以下推采购订单"), "pushdown must require audited plan");
  assert(planService.includes("line.qty - COALESCE(line.ordered_qty, 0) > 0"), "pushdown must only carry remaining plan quantity");
  assert(planService.includes("未指定有效仓库，不能下推采购订单"), "pushdown must reject plan rows without a warehouse");
  assert(planService.includes("purchaseOrderAppService.saveDraft"), "pushdown must create a purchase-order draft through the order service");
  assert(orderService.includes("source_purchase_plan_id"), "purchase-order persistence must retain plan source ids");
  assert(orderService.includes("source_purchase_plan_no IS NULL"), "plan-derived orders must not double-count requisition ordered quantity");
  assert(orderService.includes("lockPurchasePlanSources"), "purchase-order audit must lock plan sources");
  assert(orderService.includes("FOR UPDATE OF plan, plan_line"), "plan source validation must use row locks");
  assert(orderService.includes("采购订单数量不能超过采购计划剩余可订数量"), "audit must reject plan over-ordering");
  assert(orderService.includes("markPurchasePlanOrdered(planSources)"), "auditing an order must occupy plan ordered quantity");
  assert(orderService.includes("new HashMap<String, PurchasePlanDemand>()"), "duplicate plan source lines must be grouped before audit");
  assert(orderService.includes("采购计划来源标识与源单行不一致"), "audit must reject forged plan source ids");
  assert(planningApi.includes("pushDownPurchaseOrder"), "frontend API must expose plan-to-order pushdown");
  assert(planForm.includes('push-down-label="下推采购订单"'), "plan form must show explicit pushdown action");
  assert(planForm.includes("hasRemainingOrderQty"), "plan form must disable pushdown after all planned quantity is ordered");
  assert(appVue.includes("openPurchaseOrderFromPurchasePlan"), "application shell must open the generated purchase order");
  assert(documentApi.includes("sourcePurchasePlanNo"), "purchase-order API model must preserve plan trace on draft save");
  assert(documentModule.includes("sourcePurchasePlanLineId"), "purchase-order form model must round-trip plan source ids");
  assert(purchaseOrderDocument.includes("reversible: true"), "purchase-order UI must expose reverse audit for a plan-derived order");
  result.ok = true;
} catch (error) {
  result.error = error instanceof Error ? error.message : String(error);
} finally {
  await mkdir(path.dirname(resultPath), { recursive: true });
  await writeFile(resultPath, `${JSON.stringify(result, null, 2)}\n`);
}

if (!result.ok) {
  throw new Error(result.error || "A176 purchase-plan order closure regression failed");
}

console.log(JSON.stringify(result));
