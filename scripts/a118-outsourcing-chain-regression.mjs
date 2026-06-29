import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { installApiSession } from "./helpers/regression-auth.mjs";

const rootDir = path.resolve(import.meta.dirname, "..");
const verificationDir = path.join(rootDir, "verification");
const resultPath = path.join(verificationDir, "a118-outsourcing-chain-regression.json");
const apiBase = "http://127.0.0.1:8080";
await installApiSession(apiBase);
await mkdir(verificationDir, { recursive: true });

const batch = new Date().toISOString().replace(/\D/g, "").slice(0, 14);
const bomCode = `BOM-A118-${batch}`;
const workOrderNo = `WWJG-A118-${batch}`;
const productCode = "CP-001";
const componentCode = "PJ-014";
const supplierCode = "GYS-001";

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

async function request(pathname, options = {}) {
  return fetch(`${apiBase}${pathname}`, {
    method: options.method ?? "GET",
    headers: options.body ? { "Content-Type": "application/json" } : undefined,
    body: options.body ? JSON.stringify(options.body) : undefined
  });
}

async function requireJson(pathname, options = {}) {
  const response = await request(pathname, options);
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`${options.method ?? "GET"} ${pathname} failed ${response.status}: ${text}`);
  }
  return text ? JSON.parse(text) : {};
}

async function seedStock() {
  await requireJson("/api/inventory/adjustments", {
    method: "POST",
    body: {
      productCode: componentCode,
      warehouseCode: "CK-002",
      qtyDelta: 5000,
      txnType: "A118_OUTSOURCING_CHAIN_SEED",
      sourceBillType: `A118:${batch}`
    }
  });
}

async function listRow(listKey, billNo) {
  const result = await requireJson(`/api/lists/${listKey}?keyword=${encodeURIComponent(billNo)}&pageSize=200`);
  return result.rows.find((row) => row.billNo === billNo);
}

await seedStock();

await requireJson("/api/production/boms", {
  method: "POST",
  body: {
    code: bomCode,
    productCode,
    qty: 1,
    bomCategory: "委外加工",
    lines: [
      { materialCode: componentCode, qty: 2 }
    ]
  }
});
const bom = await requireJson(`/api/production/boms/${encodeURIComponent(bomCode)}/audit`, { method: "POST" });

const workOrder = await requireJson("/api/outsourcing/work-orders/draft", {
  method: "POST",
  body: {
    billNo: workOrderNo,
    supplierCode,
    productCode,
    qty: 3,
    planDeliveryDate: "2026-07-15",
    remark: `A118 regression ${batch}`
  }
});
assert(workOrder.billNo === workOrderNo, "outsourcing work order should keep requested bill number");
assert(workOrder.status === "DRAFT", "saved outsourcing work order should be draft before audit");
assert(workOrder.components?.length === 1, "outsourcing work order should expand BOM child component");
assert(Number(workOrder.components[0].qty) === 6, "component required qty should equal BOM child qty * outsourcing qty");

await requireJson(`/api/outsourcing/work-orders/${encodeURIComponent(workOrderNo)}/audit`, { method: "POST" });
const issue = await requireJson(`/api/outsourcing/work-orders/${encodeURIComponent(workOrderNo)}/push-issue`, { method: "POST" });
assert(String(issue.billNo ?? "").startsWith("WWFL"), "work order should push to outsourcing material issue");
await requireJson(`/api/outsourcing/issues/${encodeURIComponent(issue.billNo)}/audit`, { method: "POST" });

const receipt = await requireJson(`/api/outsourcing/work-orders/${encodeURIComponent(workOrderNo)}/push-receipt`, {
  method: "POST",
  body: { qty: 3 }
});
assert(String(receipt.billNo ?? "").startsWith("WWRK"), "work order should push to outsourcing product receipt");
await requireJson(`/api/outsourcing/receipts/${encodeURIComponent(receipt.billNo)}/audit`, { method: "POST" });

const returnBill = await requireJson(`/api/outsourcing/receipts/${encodeURIComponent(receipt.billNo)}/push-return`, {
  method: "POST",
  body: { qty: 1 }
});
assert(String(returnBill.billNo ?? "").startsWith("WWTH"), "receipt should push to outsourcing product return");
await requireJson(`/api/outsourcing/returns/${encodeURIComponent(returnBill.billNo)}/audit`, { method: "POST" });

const scrap = await requireJson(`/api/outsourcing/receipts/${encodeURIComponent(receipt.billNo)}/push-scrap`, {
  method: "POST",
  body: { qty: 1 }
});
assert(String(scrap.billNo ?? "").startsWith("WWBF"), "receipt should push to outsourcing product scrap");
await requireJson(`/api/outsourcing/scraps/${encodeURIComponent(scrap.billNo)}/audit`, { method: "POST" });

const workOrderRow = await listRow("outsourcing-work-order-list", workOrderNo);
const issueRow = await listRow("outsourcing-issue-list", issue.billNo);
const receiptRow = await listRow("outsourcing-receipt-list", receipt.billNo);
const returnRow = await listRow("outsourcing-return-list", returnBill.billNo);
const scrapRow = await listRow("outsourcing-scrap-list", scrap.billNo);

assert(workOrderRow?.status === "已审核", "outsourcing work order list should show audited status");
assert(issueRow?.status === "已审核", "outsourcing issue list should show audited status");
assert(receiptRow?.status === "已审核", "outsourcing receipt list should show audited status");
assert(returnRow?.status === "已审核", "outsourcing return list should show audited status");
assert(scrapRow?.status === "已审核", "outsourcing scrap list should show audited status");

const result = {
  ok: true,
  batch,
  bomCode: bom.code ?? bomCode,
  bomVersionNo: bom.versionNo,
  workOrderNo,
  issueNo: issue.billNo,
  receiptNo: receipt.billNo,
  returnNo: returnBill.billNo,
  scrapNo: scrap.billNo,
  checks: {
    bomExpandedQty: Number(workOrder.components[0].qty) === 6,
    issueAudited: issueRow.status === "已审核",
    receiptAudited: receiptRow.status === "已审核",
    returnAudited: returnRow.status === "已审核",
    scrapAudited: scrapRow.status === "已审核"
  }
};

await writeFile(resultPath, JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));
