import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { installApiSession } from "./helpers/regression-auth.mjs";

const rootDir = path.resolve(import.meta.dirname, "..");
const verificationDir = path.join(rootDir, "verification");
const resultPath = path.join(verificationDir, "a129-purchase-requisition-order-lifecycle-regression.json");
const apiBase = "http://127.0.0.1:8080";
const batch = new Date().toISOString().replace(/\D/g, "").slice(0, 14);
const billDate = "2026-07-05";
const requisitionNo = `CGSQ-A129-${batch}`;

await installApiSession(apiBase);
await mkdir(verificationDir, { recursive: true });

function assert(condition, message, context = {}) {
  if (!condition) {
    throw new Error(`${message}: ${JSON.stringify(context)}`);
  }
}

function sqlText(sql) {
  return execFileSync("docker", ["exec", "jdy-erp-postgres", "psql", "-U", "jdy", "-d", "jdy_erp", "-tA", "-c", sql], { encoding: "utf8" }).trim();
}

function orderedQty() {
  return Number(sqlText(`
    SELECT COALESCE(line.ordered_qty, 0)
    FROM purchase_requisition req
    JOIN purchase_requisition_line line ON line.requisition_id = req.id
    WHERE req.bill_no = '${requisitionNo}'
      AND line.line_no = 1
  `) || "0");
}

function purchaseOrderStatus(billNo) {
  return sqlText(`SELECT status FROM purchase_order WHERE bill_no = '${billNo}'`);
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
  const result = await request(pathname, options);
  if (!result.response.ok) {
    throw new Error(`${options.method ?? "GET"} ${pathname} failed ${result.response.status}: ${result.text}`);
  }
  return result.data;
}

async function expectFailure(pathname, options, expectedStatus, expectedText) {
  const result = await request(pathname, options);
  assert(result.response.status === expectedStatus, `expected ${expectedStatus}`, { pathname, status: result.response.status, text: result.text });
  if (expectedText) {
    assert(result.text.includes(expectedText), "failure text mismatch", { expectedText, text: result.text });
  }
  return result;
}

function purchaseOrderPayload(qty) {
  return {
    supplierCode: "GYS-001",
    billDate,
    department: "采购部",
    ownerName: "A129回归",
    lines: [
      {
        productCode: "CP-001",
        warehouseCode: "CK-001",
        sourceOrderNo: requisitionNo,
        sourceLineNo: 1,
        qty,
        unitPrice: 1,
        taxRate: 13,
        lineRemark: "A129采购申请占用回归"
      }
    ]
  };
}

sqlText(`
  WITH supplier AS (
      SELECT id, code, name FROM md_supplier WHERE code = 'GYS-001'
  ),
  product AS (
      SELECT id, code, name, spec, unit FROM md_product WHERE code = 'CP-001'
  ),
  warehouse AS (
      SELECT id FROM md_warehouse WHERE code = 'CK-001'
  ),
  inserted AS (
      INSERT INTO purchase_requisition (bill_no, supplier_id, supplier_code_snapshot, supplier_name_snapshot, bill_date, department, status, owner_name)
      SELECT '${requisitionNo}', supplier.id, supplier.code, supplier.name, DATE '${billDate}', '采购部', 'AUDITED', 'A129回归'
      FROM supplier
      RETURNING id
  )
  INSERT INTO purchase_requisition_line (requisition_id, line_no, product_id, product_code_snapshot, product_name_snapshot, product_spec_snapshot, product_unit_snapshot, warehouse_id, qty, ordered_qty, plan_delivery_date)
  SELECT inserted.id, 1, product.id, product.code, product.name, product.spec, product.unit, warehouse.id, 10, 0, DATE '${billDate}'
  FROM inserted, product, warehouse
`);

const beforeDraft = orderedQty();
const firstDraft = await requireJson("/api/purchase-orders/draft", { method: "POST", body: purchaseOrderPayload(4) });
const afterDraft = orderedQty();
const selectableAfterDraft = await requireJson(`/api/purchase-orders/selectable-requisition-lines?supplierCode=${encodeURIComponent("GYS-001")}`);
const selectedAfterDraft = selectableAfterDraft.lines.find((line) => line.billNo === requisitionNo && Number(line.lineNo) === 1);

assert(beforeDraft === 0, "seeded requisition should start with zero ordered qty", { beforeDraft });
assert(afterDraft === 0, "draft purchase order must not occupy purchase requisition", { afterDraft });
assert(Number(selectedAfterDraft?.remainingQty) === 10, "draft purchase order must not reduce selectable remaining qty", { selectedAfterDraft });

await requireJson(`/api/purchase-orders/${encodeURIComponent(firstDraft.billNo)}/audit`, { method: "POST" });
const afterAudit = orderedQty();
const selectableAfterAudit = await requireJson(`/api/purchase-orders/selectable-requisition-lines?supplierCode=${encodeURIComponent("GYS-001")}`);
const selectedAfterAudit = selectableAfterAudit.lines.find((line) => line.billNo === requisitionNo && Number(line.lineNo) === 1);

assert(afterAudit === 4, "audited purchase order must occupy purchase requisition", { afterAudit });
assert(Number(selectedAfterAudit?.remainingQty) === 6, "audited purchase order must reduce selectable remaining qty", { selectedAfterAudit });

await expectFailure(`/api/purchase-orders/${encodeURIComponent(firstDraft.billNo)}/audit`, { method: "POST" }, 409, "采购订单不存在或已审核");
assert(orderedQty() === 4, "re-auditing audited purchase order must not double occupy", { orderedQty: orderedQty() });

const secondDraft = await requireJson("/api/purchase-orders/draft", { method: "POST", body: purchaseOrderPayload(7) });
assert(orderedQty() === 4, "second draft must still not occupy purchase requisition", { orderedQty: orderedQty() });
await expectFailure(`/api/purchase-orders/${encodeURIComponent(secondDraft.billNo)}/audit`, { method: "POST" }, 409, "采购订单数量不能超过采购申请剩余可订数量");
assert(purchaseOrderStatus(secondDraft.billNo) === "DRAFT", "failed over-quantity audit must roll back purchase order status", { status: purchaseOrderStatus(secondDraft.billNo) });
assert(orderedQty() === 4, "failed over-quantity audit must not change ordered qty", { orderedQty: orderedQty() });

await expectFailure("/api/purchase-orders/draft", { method: "POST", body: purchaseOrderPayload(0) }, 400, "采购订单数量必须大于 0");
const zeroSalesDraftResult = await request("/api/sales-orders/draft", {
  method: "POST",
  body: {
    customerCode: "KH-001",
    billDate,
    department: "销售部",
    ownerName: "A129回归",
    lines: [
      {
        productCode: "CP-001",
        warehouseCode: "CK-001",
        qty: 0,
        unitPrice: 1,
        taxRate: 13
      }
    ]
  }
});
assert(zeroSalesDraftResult.response.status === 201, "zero-quantity sales order draft should return 201", { status: zeroSalesDraftResult.response.status, text: zeroSalesDraftResult.text });
const zeroSalesDraft = zeroSalesDraftResult.data;
const zeroSalesBeforeAudit = await requireJson(`/api/sales-orders/${encodeURIComponent(zeroSalesDraft.billNo)}`);
assert(zeroSalesBeforeAudit.order?.status === "DRAFT", "zero-quantity sales order should be saved as draft", { zeroSalesBeforeAudit });
assert(Number(zeroSalesBeforeAudit.lines?.[0]?.qty) === 0, "zero-quantity sales order draft should preserve qty=0", { zeroSalesBeforeAudit });
assert(String(zeroSalesBeforeAudit.lines?.[0]?.lineRemark ?? "") === "", "zero-quantity sales order draft should not require a reason remark", { zeroSalesBeforeAudit });
await expectFailure(`/api/sales-orders/${encodeURIComponent(zeroSalesDraft.billNo)}/audit`, { method: "POST" }, 400, "销售订单数量必须大于 0");
const zeroSalesAfterAudit = await requireJson(`/api/sales-orders/${encodeURIComponent(zeroSalesDraft.billNo)}`);
assert(zeroSalesAfterAudit.order?.status === "DRAFT", "rejected zero-quantity sales order audit must keep DRAFT", { zeroSalesAfterAudit });

const evidence = {
  batch,
  requisitionNo,
  firstPurchaseOrderNo: firstDraft.billNo,
  secondPurchaseOrderNo: secondDraft.billNo,
  zeroSalesOrderNo: zeroSalesDraft.billNo,
  beforeDraft,
  afterDraft,
  afterAudit,
  remainingAfterDraft: Number(selectedAfterDraft?.remainingQty),
  remainingAfterAudit: Number(selectedAfterAudit?.remainingQty)
};

await writeFile(resultPath, JSON.stringify(evidence, null, 2));
console.log(JSON.stringify(evidence, null, 2));
