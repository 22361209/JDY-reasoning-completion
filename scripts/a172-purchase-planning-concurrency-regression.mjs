import { execFileSync, spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { installApiSession } from "./helpers/regression-auth.mjs";

const rootDir = path.resolve(import.meta.dirname, "..");
const verificationDir = path.join(rootDir, "verification");
const resultPath = path.join(verificationDir, "a172-purchase-planning-concurrency-regression.json");
const apiBase = process.env.JDY_API_BASE || "http://127.0.0.1:8080";
const postgresContainer = process.env.JDY_POSTGRES_CONTAINER || "jdy-erp-postgres";
const postgresUser = process.env.JDY_POSTGRES_USER || "jdy";
const postgresDatabase = process.env.JDY_POSTGRES_DATABASE || "jdy_erp";
const batch = String(Date.now()).slice(-10);
const billDate = "2026-08-02";

await installApiSession(apiBase);
await mkdir(verificationDir, { recursive: true });

function assert(condition, message, context = {}) {
  if (!condition) {
    throw new Error(`${message}: ${JSON.stringify(context)}`);
  }
}

function literal(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function sqlText(sql) {
  return execFileSync(
    "docker",
    ["exec", postgresContainer, "psql", "-v", "ON_ERROR_STOP=1", "-U", postgresUser, "-d", postgresDatabase, "-tA", "-c", sql],
    { encoding: "utf8" }
  ).trim();
}

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function waitForSql(predicate, label, timeoutMs = 3_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) {
      return;
    }
    await wait(25);
  }
  throw new Error(`timed out waiting for ${label}`);
}

async function holdRequisitionLineLock(requisitionNo) {
  const applicationName = `a172_lock_${batch}`;
  const statement = `
    BEGIN;
    SELECT line.id
    FROM purchase_requisition requisition
    JOIN purchase_requisition_line line ON line.requisition_id = requisition.id
    WHERE requisition.bill_no = ${literal(requisitionNo)}
    ORDER BY line.id
    FOR UPDATE OF line;
    SELECT pg_sleep(2);
    COMMIT;
  `;
  const child = spawn("docker", [
    "exec", "-e", `PGAPPNAME=${applicationName}`, postgresContainer,
    "psql", "-v", "ON_ERROR_STOP=1", "-U", postgresUser,
    "-d", postgresDatabase, "-tA", "-c", statement
  ], { stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  let childError;
  child.stdout.on("data", (chunk) => { stdout += String(chunk); });
  child.stderr.on("data", (chunk) => { stderr += String(chunk); });
  const done = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`line-lock holder exited ${code}: ${stderr || stdout}`));
      }
    });
  });
  done.catch((error) => { childError = error; });
  await waitForSql(() => {
    if (childError) {
      throw childError;
    }
    return sqlText(`
      SELECT count(*)
      FROM pg_stat_activity
      WHERE application_name = ${literal(applicationName)}
        AND wait_event = 'PgSleep'
    `) === "1";
  }, "source-line lock holder");
  return { done };
}

function seedRequisition(requisitionNo, quantities) {
  const values = quantities.map((qty, index) => `(${index + 1}, ${Number(qty)})`).join(", ");
  sqlText(`
    WITH supplier AS (
        SELECT id, code, name FROM md_supplier WHERE code = 'GYS-001'
    ),
    product AS (
        SELECT id, code, name, spec, unit, net_weight, gross_weight
        FROM md_product
        WHERE code = 'CP-001'
    ),
    warehouse AS (
        SELECT id FROM md_warehouse WHERE code = 'CK-001'
    ),
    inserted AS (
        INSERT INTO purchase_requisition (
            bill_no, supplier_id, supplier_code_snapshot, supplier_name_snapshot,
            bill_date, department, status, owner_name
        )
        SELECT ${literal(requisitionNo)}, supplier.id, supplier.code, supplier.name,
               DATE ${literal(billDate)}, '采购部', 'AUDITED', 'A172并发回归'
        FROM supplier
        RETURNING id
    )
    INSERT INTO purchase_requisition_line (
        requisition_id, line_no, product_id, product_code_snapshot,
        product_name_snapshot, product_spec_snapshot, product_unit_snapshot,
        net_weight_snapshot, gross_weight_snapshot, warehouse_id,
        supplier_id, supplier_code_snapshot, supplier_name_snapshot,
        qty, ordered_qty, planned_qty, plan_delivery_date
    )
    SELECT inserted.id, requested.line_no, product.id, product.code,
           product.name, product.spec, product.unit, product.net_weight,
           product.gross_weight, warehouse.id, supplier.id, supplier.code,
           supplier.name, requested.qty, 0, 0, DATE ${literal(billDate)}
    FROM inserted, product, warehouse, supplier,
         (VALUES ${values}) AS requested(line_no, qty)
  `);
}

async function request(pathname, options = {}) {
  const startedAt = Date.now();
  const response = await fetch(`${apiBase}${pathname}`, {
    method: options.method ?? "GET",
    headers: options.body ? { "Content-Type": "application/json" } : undefined,
    body: options.body ? JSON.stringify(options.body) : undefined,
    signal: AbortSignal.timeout(options.timeoutMs ?? 10_000)
  });
  const text = await response.text();
  let data = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { text };
  }
  return { status: response.status, text, data, elapsedMs: Date.now() - startedAt };
}

async function requireJson(pathname, options = {}) {
  const result = await request(pathname, options);
  assert(result.status >= 200 && result.status < 300, `${options.method ?? "GET"} ${pathname} failed`, result);
  return result.data;
}

function purchaseOrderPayload(requisitionNo, quantities) {
  return {
    supplierCode: "GYS-001",
    billDate,
    department: "采购部",
    ownerName: "A172并发回归",
    lines: quantities.map((qty, index) => ({
      productCode: "CP-001",
      warehouseCode: "CK-001",
      sourceOrderNo: requisitionNo,
      sourceLineNo: index + 1,
      qty,
      unitPrice: 1,
      taxRate: 13,
      lineRemark: "A172采购规划并发回归"
    }))
  };
}

async function createPurchaseOrder(requisitionNo, quantities) {
  return requireJson("/api/purchase-orders/draft", {
    method: "POST",
    body: purchaseOrderPayload(requisitionNo, quantities)
  });
}

function requisitionSnapshot(requisitionNo) {
  const raw = sqlText(`
    SELECT json_build_object(
        'status', requisition.status,
        'orderedQty', COALESCE(SUM(line.ordered_qty), 0),
        'plannedQty', COALESCE(SUM(line.planned_qty), 0),
        'qty', COALESCE(SUM(line.qty), 0)
    )::text
    FROM purchase_requisition requisition
    JOIN purchase_requisition_line line ON line.requisition_id = requisition.id
    WHERE requisition.bill_no = ${literal(requisitionNo)}
    GROUP BY requisition.status
  `);
  return JSON.parse(raw);
}

function purchaseOrderStatus(billNo) {
  return sqlText(`SELECT status FROM purchase_order WHERE bill_no = ${literal(billNo)}`);
}

function purchasePlanStatus(billNo) {
  return sqlText(`SELECT status FROM purchase_plan WHERE bill_no = ${literal(billNo)}`);
}

function authoritativeOrderedQty(requisitionNo) {
  return Number(sqlText(`
    SELECT COALESCE(SUM(order_line.qty), 0)
    FROM purchase_order_line order_line
    JOIN purchase_order purchase_order ON purchase_order.id = order_line.order_id
    WHERE purchase_order.status = 'AUDITED'
      AND order_line.source_requisition_no = ${literal(requisitionNo)}
  `) || "0");
}

const session = await requireJson("/api/system/session");
assert(session.tenant?.code === "BLD-TEST" && session.tenant?.schemaName === "public",
  "A172 concurrency regression may only write BLD-TEST/public", session.tenant);

const evidence = {
  batch,
  overQuantityAudit: {},
  auditReverseRaces: [],
  forcedAuditWinner: {},
  auditedOrderDraftSaveGuard: {},
  draftPlanCancellation: {},
  multiLineSerialization: {}
};

const overQuantityRequisitionNo = `CGSQ-A172-O-${batch}`;
seedRequisition(overQuantityRequisitionNo, [10]);
const overOrderOne = await createPurchaseOrder(overQuantityRequisitionNo, [6]);
const overOrderTwo = await createPurchaseOrder(overQuantityRequisitionNo, [6]);
const overResults = await Promise.all([
  request(`/api/purchase-orders/${encodeURIComponent(overOrderOne.billNo)}/audit`, { method: "POST" }),
  request(`/api/purchase-orders/${encodeURIComponent(overOrderTwo.billNo)}/audit`, { method: "POST" })
]);
const overStatuses = overResults.map((result) => result.status).sort((left, right) => left - right);
const overSnapshot = requisitionSnapshot(overQuantityRequisitionNo);
assert(JSON.stringify(overStatuses) === JSON.stringify([200, 409]), "two over-quantity audits must serialize to one success and one conflict", { overResults });
assert(overResults.every((result) => result.elapsedMs < 10_000), "over-quantity audit must not deadlock", { overResults });
assert(Number(overSnapshot.orderedQty) === 6 && authoritativeOrderedQty(overQuantityRequisitionNo) === 6,
  "cached and authoritative ordered quantities must agree after concurrent audit", { overSnapshot });
assert([purchaseOrderStatus(overOrderOne.billNo), purchaseOrderStatus(overOrderTwo.billNo)].sort().join(",") === "AUDITED,DRAFT",
  "failed concurrent order audit must remain draft", { overOrderOne, overOrderTwo });
evidence.overQuantityAudit = {
  requisitionNo: overQuantityRequisitionNo,
  purchaseOrderNos: [overOrderOne.billNo, overOrderTwo.billNo],
  results: overResults.map(({ status, elapsedMs }) => ({ status, elapsedMs })),
  snapshot: overSnapshot
};

for (let index = 1; index <= 12; index += 1) {
  const suffix = String(index).padStart(2, "0");
  const requisitionNo = `CGSQ-A172-R-${batch}-${suffix}`;
  seedRequisition(requisitionNo, [1]);
  const order = await createPurchaseOrder(requisitionNo, [1]);
  const [auditResult, reverseResult] = await Promise.all([
    request(`/api/purchase-orders/${encodeURIComponent(order.billNo)}/audit`, { method: "POST" }),
    request(`/api/purchase-requisitions/${encodeURIComponent(requisitionNo)}/reverse`, { method: "POST" })
  ]);
  const statuses = [auditResult.status, reverseResult.status].sort((left, right) => left - right);
  const snapshot = requisitionSnapshot(requisitionNo);
  const orderStatus = purchaseOrderStatus(order.billNo);
  const authoritativeQty = authoritativeOrderedQty(requisitionNo);
  assert(JSON.stringify(statuses) === JSON.stringify([200, 409]), "order audit and requisition reverse must have exactly one winner", {
    index, auditResult, reverseResult, snapshot, orderStatus
  });
  assert(auditResult.elapsedMs < 10_000 && reverseResult.elapsedMs < 10_000, "audit/reverse race must not deadlock", {
    index, auditResult, reverseResult
  });
  if (auditResult.status === 200) {
    assert(snapshot.status === "AUDITED" && orderStatus === "AUDITED"
      && Number(snapshot.orderedQty) === 1 && authoritativeQty === 1,
    "order audit winner must leave an audited source with matching occupancy", { index, snapshot, orderStatus, authoritativeQty });
  } else {
    assert(snapshot.status === "DRAFT" && orderStatus === "DRAFT"
      && Number(snapshot.orderedQty) === 0 && authoritativeQty === 0,
    "requisition reverse winner must leave the order draft and source unoccupied", { index, snapshot, orderStatus, authoritativeQty });
  }
  evidence.auditReverseRaces.push({
    requisitionNo,
    purchaseOrderNo: order.billNo,
    auditStatus: auditResult.status,
    reverseStatus: reverseResult.status,
    snapshot,
    orderStatus
  });
}

const forcedWinnerRequisitionNo = `CGSQ-A172-W-${batch}`;
seedRequisition(forcedWinnerRequisitionNo, [1]);
const forcedWinnerOrder = await createPurchaseOrder(forcedWinnerRequisitionNo, [1]);
const forcedWinnerLineLock = await holdRequisitionLineLock(forcedWinnerRequisitionNo);
const forcedWinnerAuditPromise = request(`/api/purchase-orders/${encodeURIComponent(forcedWinnerOrder.billNo)}/audit`, { method: "POST" });
await waitForSql(() => Number(sqlText(`
  SELECT count(*)
  FROM pg_stat_activity
  WHERE datname = ${literal(postgresDatabase)}
    AND state = 'active'
    AND wait_event_type = 'Lock'
    AND query LIKE '%FROM purchase_requisition_line%'
    AND query LIKE '%FOR UPDATE%'
`)) >= 1, "purchase-order audit waiting behind the source-line lock");
const forcedWinnerReversePromise = request(`/api/purchase-requisitions/${encodeURIComponent(forcedWinnerRequisitionNo)}/reverse`, { method: "POST" });
const [forcedWinnerAudit, forcedWinnerReverse] = await Promise.all([
  forcedWinnerAuditPromise,
  forcedWinnerReversePromise,
  forcedWinnerLineLock.done
]).then(([auditResult, reverseResult]) => [auditResult, reverseResult]);
const forcedWinnerSnapshot = requisitionSnapshot(forcedWinnerRequisitionNo);
assert(forcedWinnerAudit.status === 200 && forcedWinnerReverse.status === 409,
  "a requisition reverse waiting behind an in-flight order audit must observe the committed audited order", {
    forcedWinnerAudit, forcedWinnerReverse, forcedWinnerSnapshot
  });
assert(forcedWinnerSnapshot.status === "AUDITED"
  && purchaseOrderStatus(forcedWinnerOrder.billNo) === "AUDITED"
  && Number(forcedWinnerSnapshot.orderedQty) === 1
  && authoritativeOrderedQty(forcedWinnerRequisitionNo) === 1,
  "forced audit-winner race must leave an audited source with matching authoritative occupancy", forcedWinnerSnapshot);
evidence.forcedAuditWinner = {
  requisitionNo: forcedWinnerRequisitionNo,
  purchaseOrderNo: forcedWinnerOrder.billNo,
  auditStatus: forcedWinnerAudit.status,
  reverseStatus: forcedWinnerReverse.status,
  snapshot: forcedWinnerSnapshot
};

const auditedOrderDraftSave = await request("/api/purchase-orders/draft", {
  method: "POST",
  body: {
    ...purchaseOrderPayload(forcedWinnerRequisitionNo, [1]),
    billNo: forcedWinnerOrder.billNo
  }
});
const guardedOrderSnapshot = requisitionSnapshot(forcedWinnerRequisitionNo);
assert(auditedOrderDraftSave.status === 409,
  "saving an already audited purchase order must fail instead of reverting it to draft", auditedOrderDraftSave);
assert(purchaseOrderStatus(forcedWinnerOrder.billNo) === "AUDITED"
  && Number(guardedOrderSnapshot.orderedQty) === 1
  && authoritativeOrderedQty(forcedWinnerRequisitionNo) === 1,
  "rejected stale draft save must preserve the audited order and matching source occupancy", guardedOrderSnapshot);
evidence.auditedOrderDraftSaveGuard = {
  requisitionNo: forcedWinnerRequisitionNo,
  purchaseOrderNo: forcedWinnerOrder.billNo,
  saveStatus: auditedOrderDraftSave.status,
  snapshot: guardedOrderSnapshot
};

const cancellationRequisitionNo = `CGSQ-A172-C-${batch}`;
seedRequisition(cancellationRequisitionNo, [10]);
const initialPush = await requireJson(`/api/purchase-requisitions/${encodeURIComponent(cancellationRequisitionNo)}/push-down`, { method: "POST" });
const initialPlanNo = initialPush.purchasePlans?.[0]?.billNo;
assert(initialPlanNo, "initial purchase plan must be generated", initialPush);
const directOrder = await createPurchaseOrder(cancellationRequisitionNo, [1]);
await requireJson(`/api/purchase-orders/${encodeURIComponent(directOrder.billNo)}/audit`, { method: "POST" });
const blockedPlanAudit = await request(`/api/purchase-plans/${encodeURIComponent(initialPlanNo)}/audit`, { method: "POST" });
assert(blockedPlanAudit.status === 409, "full-quantity draft plan must fail after direct order consumption", blockedPlanAudit);
const deletedPlan = await request(`/api/purchase-plans/${encodeURIComponent(initialPlanNo)}`, { method: "DELETE" });
assert([200, 204].includes(deletedPlan.status), "draft purchase plan must support deletion", deletedPlan);
const deleteOperationLogCount = Number(sqlText(`
  SELECT count(*)
  FROM sys_operation_log
  WHERE target_type = 'purchase_plan'
    AND target_no = ${literal(initialPlanNo)}
    AND action_code = 'DELETE_PURCHASE_PLAN_DRAFT'
    AND success = true
`));
assert(deleteOperationLogCount === 1, "draft purchase plan deletion must write exactly one success operation log", {
  initialPlanNo, deleteOperationLogCount
});
const missingDeletedPlan = await request(`/api/purchase-plans/${encodeURIComponent(initialPlanNo)}`);
assert(missingDeletedPlan.status === 404, "deleted draft plan must no longer exist", missingDeletedPlan);
const regenerated = await requireJson(`/api/purchase-requisitions/${encodeURIComponent(cancellationRequisitionNo)}/push-down`, { method: "POST" });
const regeneratedPlanNo = regenerated.purchasePlans?.[0]?.billNo;
assert(regeneratedPlanNo && Number(regenerated.purchasePlans[0].totalQty) === 9,
  "re-push after draft deletion must use the remaining requisition quantity", regenerated);
await requireJson(`/api/purchase-plans/${encodeURIComponent(regeneratedPlanNo)}/audit`, { method: "POST" });
const occupiedAfterPlanAudit = requisitionSnapshot(cancellationRequisitionNo);
assert(Number(occupiedAfterPlanAudit.orderedQty) === 1 && Number(occupiedAfterPlanAudit.plannedQty) === 9,
  "direct order and audited regenerated plan must share the source quantity exactly", occupiedAfterPlanAudit);
await requireJson(`/api/purchase-plans/${encodeURIComponent(regeneratedPlanNo)}/reverse`, { method: "POST" });
const releasedAfterPlanReverse = requisitionSnapshot(cancellationRequisitionNo);
assert(Number(releasedAfterPlanReverse.orderedQty) === 1 && Number(releasedAfterPlanReverse.plannedQty) === 0,
  "plan reversal must release only planned occupancy", releasedAfterPlanReverse);
evidence.draftPlanCancellation = {
  requisitionNo: cancellationRequisitionNo,
  deletedPlanNo: initialPlanNo,
  regeneratedPlanNo,
  directOrderNo: directOrder.billNo,
  blockedAuditStatus: blockedPlanAudit.status,
  deleteOperationLogCount,
  occupiedAfterPlanAudit,
  releasedAfterPlanReverse
};

const multiLineRequisitionNo = `CGSQ-A172-M-${batch}`;
seedRequisition(multiLineRequisitionNo, [5, 5]);
const multiLinePush = await requireJson(`/api/purchase-requisitions/${encodeURIComponent(multiLineRequisitionNo)}/push-down`, { method: "POST" });
const multiLinePlanNo = multiLinePush.purchasePlans?.[0]?.billNo;
assert(multiLinePlanNo && Number(multiLinePush.purchasePlans[0].lineCount) === 2, "multi-line plan fixture must contain two source lines", multiLinePush);
const multiLineOrder = await createPurchaseOrder(multiLineRequisitionNo, [5, 5]);
const [planAuditResult, orderAuditResult] = await Promise.all([
  request(`/api/purchase-plans/${encodeURIComponent(multiLinePlanNo)}/audit`, { method: "POST" }),
  request(`/api/purchase-orders/${encodeURIComponent(multiLineOrder.billNo)}/audit`, { method: "POST" })
]);
const multiLineStatuses = [planAuditResult.status, orderAuditResult.status].sort((left, right) => left - right);
const multiLineSnapshot = requisitionSnapshot(multiLineRequisitionNo);
assert(JSON.stringify(multiLineStatuses) === JSON.stringify([200, 409]), "multi-line plan/order audits must serialize without over-occupation", {
  planAuditResult, orderAuditResult, multiLineSnapshot
});
assert(planAuditResult.elapsedMs < 10_000 && orderAuditResult.elapsedMs < 10_000, "multi-line plan/order race must not deadlock", {
  planAuditResult, orderAuditResult
});
assert(
  (Number(multiLineSnapshot.plannedQty) === 10 && Number(multiLineSnapshot.orderedQty) === 0
    && purchasePlanStatus(multiLinePlanNo) === "AUDITED" && purchaseOrderStatus(multiLineOrder.billNo) === "DRAFT")
  ||
  (Number(multiLineSnapshot.plannedQty) === 0 && Number(multiLineSnapshot.orderedQty) === 10
    && purchasePlanStatus(multiLinePlanNo) === "DRAFT" && purchaseOrderStatus(multiLineOrder.billNo) === "AUDITED"),
  "multi-line serialization must leave one authoritative downstream winner", { multiLineSnapshot }
);
evidence.multiLineSerialization = {
  requisitionNo: multiLineRequisitionNo,
  purchasePlanNo: multiLinePlanNo,
  purchaseOrderNo: multiLineOrder.billNo,
  planAuditStatus: planAuditResult.status,
  orderAuditStatus: orderAuditResult.status,
  snapshot: multiLineSnapshot
};

await writeFile(resultPath, JSON.stringify(evidence, null, 2));
console.log(JSON.stringify(evidence, null, 2));
