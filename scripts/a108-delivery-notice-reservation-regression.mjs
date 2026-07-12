import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";
import { installApiSession, loginAsAdmin } from "./helpers/regression-auth.mjs";

const rootDir = path.resolve(import.meta.dirname, "..");
const screenshotDir = path.join(rootDir, "verification/playwright");
const resultPath = path.join(rootDir, "verification/a108-delivery-notice-reservation-regression.json");
const frontendUrl = "http://127.0.0.1:5173/";
const apiBase = "http://127.0.0.1:8080";
const batch = new Date().toISOString().replace(/\D/g, "").slice(0, 14);
const billDate = "2026-06-26";
const productCode = "CP-001";
const warehouseCode = "CK-001";
const qty = 7;
const unitPrice = 86;
let orderNo = "";
let noticeNo = "";
let outNo = "";

await installApiSession(apiBase);
await mkdir(screenshotDir, { recursive: true });
await mkdir(path.dirname(resultPath), { recursive: true });

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function generatedBillNo(row, prefix, label) {
  const value = String(row?.billNo ?? "");
  assert(new RegExp(`^${prefix}\\d{6}$`).test(value), `${label} should return a system bill number, got ${JSON.stringify(row)}`);
  return value;
}

async function api(pathname, options = {}) {
  const response = await fetch(`${apiBase}${pathname}`, {
    method: options.method ?? "POST",
    headers: options.body ? { "Content-Type": "application/json" } : undefined,
    body: options.body ? JSON.stringify(options.body) : undefined
  });
  const text = await response.text();
  const data = text ? JSON.parse(text) : {};
  if (!response.ok && !options.expectFailure) {
    throw new Error(`${options.method ?? "POST"} ${pathname} failed ${response.status}: ${text}`);
  }
  return { ok: response.ok, status: response.status, data };
}

async function requireApi(pathname, options = {}) {
  const result = await api(pathname, options);
  assert(result.ok, `${options.method ?? "POST"} ${pathname} failed ${result.status}: ${JSON.stringify(result.data)}`);
  return result.data;
}

function sqlValue(sql) {
  return execFileSync("docker", ["exec", "jdy-erp-postgres", "psql", "-U", "jdy", "-d", "jdy_erp", "-tA", "-c", sql], { encoding: "utf8" }).trim();
}

function stock() {
  const raw = sqlValue(`
    SELECT COALESCE(b.qty_on_hand, 0) || ',' || COALESCE(b.qty_reserved, 0) || ',' || COALESCE(b.qty_available, 0)
    FROM md_product p
    JOIN md_warehouse w ON w.code = '${warehouseCode}'
    LEFT JOIN inv_stock_balance b ON b.product_id = p.id AND b.warehouse_id = w.id
    WHERE p.code = '${productCode}'
  `);
  const [onHand, reserved, available] = raw.split(",").map(Number);
  return { onHand, reserved, available };
}

function assertStockInvariant(label, value) {
  assert(value.available === value.onHand - value.reserved, `${label}: available should equal onHand-reserved, got ${JSON.stringify(value)}`);
  assert(value.onHand >= 0 && value.reserved >= 0 && value.available >= 0, `${label}: stock quantities should be non-negative, got ${JSON.stringify(value)}`);
}

async function seed() {
  await requireApi("/api/inventory/adjustments", {
    body: {
      productCode,
      warehouseCode,
      qtyDelta: 100,
      txnType: "A108_SEED",
      sourceBillType: `A108_SEED:${batch}`
    }
  });
  const savedOrder = await requireApi("/api/sales-orders/draft", {
    body: {
      billNo: null,
      customerCode: "KH-001",
      billDate,
      department: "销售部",
      ownerName: "本地管理员",
      lines: [{ productCode, warehouseCode, qty, unitPrice, taxRate: 13, lineRemark: "A108 订单源行", planDeliveryDate: "2026-07-08" }]
    }
  });
  orderNo = generatedBillNo(savedOrder, "XSDD", "A108 sales order");
  await requireApi(`/api/sales-orders/${encodeURIComponent(orderNo)}/audit`);
}

await seed();
const beforeNotice = stock();
assertStockInvariant("before notice", beforeNotice);

const directOut = await api("/api/sales-outs/draft", {
  expectFailure: true,
  body: {
    billNo: null,
    customerCode: "KH-001",
    billDate,
    department: "销售部",
    ownerName: "本地管理员",
    lines: [{ productCode, warehouseCode, sourceOrderNo: orderNo, sourceLineNo: 1, qty, unitPrice, taxRate: 13 }]
  }
});
assert(!directOut.ok && directOut.status === 409, `direct sales order to sales out should be blocked, got ${directOut.status}`);
assert(JSON.stringify(directOut.data).includes("销售出库来源发货通知单不存在或未审核"), `direct sales-order source should report the formal delivery-notice guard: ${JSON.stringify(directOut.data)}`);

const savedNotice = await requireApi("/api/delivery-notices/draft", {
  body: {
    billNo: null,
    sourceOrderNo: orderNo,
    customerCode: "KH-001",
    billDate,
    department: "销售部",
    ownerName: "本地管理员",
    lines: [{ productCode, warehouseCode, sourceOrderNo: orderNo, sourceLineNo: 1, qty, unitPrice, taxRate: 13, lineRemark: "A108 通知锁库", planDeliveryDate: "2026-07-08" }]
  }
});
noticeNo = generatedBillNo(savedNotice, "FHTZD", "A108 delivery notice");
await requireApi(`/api/delivery-notices/${encodeURIComponent(noticeNo)}/audit`);
const afterNoticeAudit = stock();
assert(afterNoticeAudit.onHand === beforeNotice.onHand, "delivery notice audit must not change on hand");
assert(afterNoticeAudit.reserved === beforeNotice.reserved + qty, "delivery notice audit should increase reserved");
assertStockInvariant("after notice audit", afterNoticeAudit);

const reverseBlocked = await api(`/api/sales-orders/${encodeURIComponent(orderNo)}/reverse`, { expectFailure: true });
assert(!reverseBlocked.ok && reverseBlocked.status === 409, `audited notice should block sales order reverse, got ${reverseBlocked.status}`);
assert(JSON.stringify(reverseBlocked.data).includes("销售订单已有已审核发货通知单，不能反审核"), `sales order reverse should report the audited delivery-notice guard: ${JSON.stringify(reverseBlocked.data)}`);

const savedOut = await requireApi("/api/sales-outs/draft", {
  body: {
    billNo: null,
    customerCode: "KH-001",
    billDate,
    department: "销售部",
    ownerName: "本地管理员",
    lines: [{ productCode, warehouseCode, sourceOrderNo: noticeNo, sourceLineNo: 1, sourceDeliveryNoticeNo: noticeNo, sourceDeliveryLineNo: 1, qty, unitPrice, taxRate: 13, lineRemark: "A108 通知出库", planDeliveryDate: "2026-07-08" }]
  }
});
outNo = generatedBillNo(savedOut, "XSCKD", "A108 sales out");
await requireApi(`/api/sales-outs/${encodeURIComponent(outNo)}/audit`);
const afterOutAudit = stock();
assert(afterOutAudit.onHand === afterNoticeAudit.onHand - qty, "sales out audit should decrease on hand");
assert(afterOutAudit.reserved === afterNoticeAudit.reserved - qty, "sales out audit should release reserved");
assertStockInvariant("after out audit", afterOutAudit);

await requireApi(`/api/sales-outs/${encodeURIComponent(outNo)}/reverse`);
const afterOutReverse = stock();
assert(afterOutReverse.onHand === afterNoticeAudit.onHand, "sales out reverse should restore on hand");
assert(afterOutReverse.reserved === afterNoticeAudit.reserved, "sales out reverse should restore reserved");
assertStockInvariant("after out reverse", afterOutReverse);

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1366, height: 768 } });
const screenshots = [];
try {
  await page.goto(frontendUrl, { waitUntil: "networkidle" });
  await loginAsAdmin(page);
  await page.getByTestId("module-销售管理").hover();
  await page.getByTestId("query-delivery-notice-form").click();
  await page.getByTestId("tab-delivery-notice-form-list").waitFor({ state: "visible" });
  await page.getByTestId("list-keyword").fill(noticeNo);
  await page.getByTestId("list-keyword").press("Enter");
  await page.getByTestId(`open-document-${noticeNo}`).click();
  await page.getByTestId("delivery-notice-line-stockOnHand").waitFor({ state: "visible" });
  await page.getByTestId("delivery-notice-line-stockReserved").waitFor({ state: "visible" });
  await page.getByTestId("delivery-notice-line-stockAvailable").waitFor({ state: "visible" });
  await page.getByTestId("refresh-entry-stock").click();
  await page.getByText("库存已更新").waitFor({ state: "visible", timeout: 10000 });
  const shot = `a108-delivery-notice-stock-columns-${batch}.png`;
  await page.screenshot({ path: path.join(screenshotDir, shot), fullPage: true });
  screenshots.push(`verification/playwright/${shot}`);
} finally {
  await browser.close();
}

const result = {
  batch,
  generatedAt: new Date().toISOString(),
  orderNo,
  noticeNo,
  outNo,
  directOutBlocked: { ok: !directOut.ok, status: directOut.status },
  stockAssertions: {
    beforeNotice,
    afterNoticeAudit,
    afterOutAudit,
    afterOutReverse,
    invariant: "qty_available = qty_on_hand - qty_reserved; all non-negative"
  },
  screenshots
};

await writeFile(resultPath, JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));
