import { chromium } from "playwright";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { installApiSession, loginAsAdmin } from "./helpers/regression-auth.mjs";

const rootDir = path.resolve(import.meta.dirname, "..");
const screenshotDir = path.join(rootDir, "verification/playwright");
const resultPath = path.join(rootDir, "verification/a100-purchase-direct-push-regression.json");
const frontendUrl = "http://127.0.0.1:5173/";
const apiBase = "http://127.0.0.1:8080";
const batch = new Date().toISOString().replace(/\D/g, "").slice(0, 14);
const billDate = "2026-06-26";

await installApiSession(apiBase);
await mkdir(screenshotDir, { recursive: true });
await mkdir(path.dirname(resultPath), { recursive: true });

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function assertArray(name, actual, expected) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${name} expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
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
  assert(result.ok, `${options.method ?? "POST"} ${pathname} failed ${result.status}`);
  return result.data;
}

async function createPurchaseOrder(suffix, lines) {
  const billNo = `CGDD-A100-${suffix}-${batch}`;
  await requireApi("/api/purchase-orders/draft", {
    body: {
      billNo,
      supplierCode: "GYS-001",
      billDate,
      department: "采购部",
      ownerName: "本地管理员",
      lines
    }
  });
  await requireApi(`/api/purchase-orders/${encodeURIComponent(billNo)}/audit`);
  return billNo;
}

async function createData() {
  const directLines = [
    { productCode: "CP-001", warehouseCode: "CK-001", qty: 11, unitPrice: 72, lineRemark: "A100 采购第一行" },
    { productCode: "CP-T413874", warehouseCode: "CK-T413874", qty: 9, unitPrice: 81, lineRemark: "A100 采购第二行" },
    { productCode: "PJ-014", warehouseCode: "CK-002", qty: 7, unitPrice: 8, lineRemark: "A100 采购第三行" }
  ];
  const partialInNo = `CGRK-A100-PART-${batch}`;
  const directOrderNo = await createPurchaseOrder("PUSH", directLines);
  await requireApi("/api/purchase-ins/draft", {
    body: {
      billNo: partialInNo,
      sourceOrderNo: directOrderNo,
      supplierCode: "GYS-001",
      billDate,
      department: "采购部",
      ownerName: "本地管理员",
      lines: [
        { productCode: "CP-001", warehouseCode: "CK-001", qty: 5, unitPrice: 72 },
        { productCode: "CP-T413874", warehouseCode: "CK-T413874", qty: 4, unitPrice: 81 },
        { productCode: "PJ-014", warehouseCode: "CK-002", qty: 3, unitPrice: 8 }
      ]
    }
  });
  await requireApi(`/api/purchase-ins/${encodeURIComponent(partialInNo)}/audit`);

  const orderA = await createPurchaseOrder("A", [
    { productCode: "CP-001", warehouseCode: "CK-001", qty: 3, unitPrice: 72, lineRemark: "A100 多源 A" }
  ]);
  const orderB = await createPurchaseOrder("B", [
    { productCode: "PJ-014", warehouseCode: "CK-002", qty: 2, unitPrice: 8, lineRemark: "A100 多源 B" }
  ]);
  const draftOccupiedOrderNo = await createPurchaseOrder("DRAFT-OCCUPY", [
    { productCode: "CP-001", warehouseCode: "CK-001", qty: 4, unitPrice: 72, lineRemark: "A100 草稿不占用源单" }
  ]);
  const draftOccupiedInNo = `CGRK-A100-DRAFT-OCCUPY-${batch}`;
  await requireApi("/api/purchase-ins/draft", {
    body: {
      billNo: draftOccupiedInNo,
      supplierCode: "GYS-001",
      billDate,
      department: "采购部",
      ownerName: "本地管理员",
      lines: [
        { productCode: "CP-001", warehouseCode: "CK-001", sourceOrderNo: draftOccupiedOrderNo, sourceLineNo: 1, qty: 4, unitPrice: 72, lineRemark: "A100 未审核入库不占用源单" }
      ]
    }
  });
  return {
    directOrderNo,
    partialInNo,
    orderA,
    orderB,
    draftOccupiedOrderNo,
    draftOccupiedInNo,
    expectedDirect: {
      sources: [`${directOrderNo} / #1`, `${directOrderNo} / #2`, `${directOrderNo} / #3`],
      products: ["CP-001", "CP-T413874", "PJ-014"],
      warehouses: ["CK-001", "CK-T413874", "CK-002"],
      qtys: [6, 5, 4],
      prices: [72, 81, 8],
      remarks: ["A100 采购第一行", "A100 采购第二行", "A100 采购第三行"]
    }
  };
}

async function openPurchaseOrderListAndPush(page, billNo) {
  await page.getByTestId("module-采购管理").hover();
  await page.getByTestId("query-purchase-order-form").click();
  await page.getByTestId("tab-purchase-order-form-list").waitFor({ state: "visible" });
  await page.getByTestId("list-keyword").fill(billNo);
  await page.getByTestId("list-keyword").press("Enter");
  const row = page.locator(".vxe-body--row", { hasText: billNo }).first();
  await row.waitFor({ state: "visible" });
  await row.locator(".vxe-checkbox--icon").first().click();
  await page.getByTestId("push-purchase-in").click();
  await page.getByTestId("purchase-in-bill-no").waitFor({ state: "visible" });
}

async function readPurchaseInLines(page, count) {
  const values = {
    sources: [],
    products: [],
    warehouses: [],
    qtys: [],
    prices: [],
    remarks: []
  };
  for (let index = 0; index < count; index += 1) {
    const suffix = index === 0 ? "" : `-${index + 1}`;
    values.sources.push(await lineSourceText(page, "purchase-in", index));
    values.products.push(await page.getByTestId(`purchase-in-line-product${suffix}`).inputValue());
    values.warehouses.push(await page.getByTestId(`purchase-in-line-warehouse${suffix}`).inputValue());
    values.qtys.push(Number(await page.getByTestId(`purchase-in-line-qty${suffix}`).inputValue()));
    values.prices.push(Number(await page.getByTestId(`purchase-in-line-price${suffix}`).inputValue()));
    values.remarks.push(await page.getByTestId(`purchase-in-line-remark${suffix}`).inputValue());
  }
  return values;
}

async function lineSourceText(page, prefix, index) {
  const suffix = index === 0 ? "" : `-${index + 1}`;
  const orderNo = (await page.getByTestId(`${prefix}-line-source-order-no${suffix}`).innerText()).trim();
  const lineNo = (await page.getByTestId(`${prefix}-line-source-line-no${suffix}`).innerText()).trim();
  return `${orderNo} / ${lineNo}`;
}

const data = await createData();
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1366, height: 768 } });
const screenshots = [];

try {
  await page.goto(frontendUrl, { waitUntil: "networkidle" });
  await loginAsAdmin(page);
  await openPurchaseOrderListAndPush(page, data.directOrderNo);
  assert(await page.getByTestId("push-confirm-dialog").count() === 0, "purchase pushdown confirmation dialog should not appear");
  const directLines = await readPurchaseInLines(page, 3);
  assertArray("direct purchase sources", directLines.sources, data.expectedDirect.sources);
  assertArray("direct purchase products", directLines.products, data.expectedDirect.products);
  assertArray("direct purchase warehouses", directLines.warehouses, data.expectedDirect.warehouses);
  assertArray("direct purchase qtys", directLines.qtys, data.expectedDirect.qtys);
  assertArray("direct purchase prices", directLines.prices, data.expectedDirect.prices);
  assertArray("direct purchase remarks", directLines.remarks, data.expectedDirect.remarks);
  await page.getByTestId("purchase-in-line-qty").fill("5");
  assert(Number(await page.getByTestId("purchase-in-line-qty").inputValue()) === 5, "purchase in qty should be editable in draft");
  const directShot = `a100-purchase-direct-push-${batch}.png`;
  await page.screenshot({ path: path.join(screenshotDir, directShot), fullPage: true });
  screenshots.push(`verification/playwright/${directShot}`);

  const multiInNo = `CGRK-A100-MULTI-${batch}`;
  await requireApi("/api/purchase-ins/draft", {
    body: {
      billNo: multiInNo,
      supplierCode: "GYS-001",
      billDate,
      department: "采购部",
      ownerName: "本地管理员",
      lines: [
        { productCode: "CP-001", warehouseCode: "CK-001", sourceOrderNo: data.orderA, sourceLineNo: 1, qty: 3, unitPrice: 72, lineRemark: "A100 多源 A" },
        { productCode: "PJ-014", warehouseCode: "CK-002", sourceOrderNo: data.orderB, sourceLineNo: 1, qty: 2, unitPrice: 8, lineRemark: "A100 多源 B" }
      ]
    }
  });
  const draftDetail = await requireApi(`/api/purchase-ins/${encodeURIComponent(multiInNo)}`, { method: "GET" });
  assert(!draftDetail.document.sourceOrderNo, "purchase in header source order should stay empty");
  assertArray("multi-source draft line sources", draftDetail.lines.map((line) => line.sourceOrderNo), [data.orderA, data.orderB]);
  await requireApi(`/api/purchase-ins/${encodeURIComponent(multiInNo)}/audit`);
  const auditedDetail = await requireApi(`/api/purchase-ins/${encodeURIComponent(multiInNo)}`, { method: "GET" });
  assert(!auditedDetail.document.sourceOrderNo, "audited purchase in header source order should stay empty");
  assertArray("multi-source audited line sources", auditedDetail.lines.map((line) => line.sourceOrderNo), [data.orderA, data.orderB]);
  const orderADetail = await requireApi(`/api/purchase-orders/${encodeURIComponent(data.orderA)}`, { method: "GET" });
  const orderBDetail = await requireApi(`/api/purchase-orders/${encodeURIComponent(data.orderB)}`, { method: "GET" });
  assert(Number(orderADetail.lines[0].remainingQty) === 0, "purchase order A should have no remaining qty after multi-source purchase in audit");
  assert(Number(orderBDetail.lines[0].remainingQty) === 0, "purchase order B should have no remaining qty after multi-source purchase in audit");
  const selectableAfterDraft = await requireApi(`/api/purchase-orders/selectable-lines?supplierCode=${encodeURIComponent("GYS-001")}`, { method: "GET" });
  const occupiedSelectableLine = selectableAfterDraft.lines.find((line) => line.billNo === data.draftOccupiedOrderNo);
  assert(Number(occupiedSelectableLine?.remainingQty) === 4, `draft purchase in should not occupy purchase order source qty: ${JSON.stringify(occupiedSelectableLine)}`);

  const duplicateNo = `CGRK-A100-OVER-${batch}`;
  await requireApi("/api/purchase-ins/draft", {
    body: {
      billNo: duplicateNo,
      supplierCode: "GYS-001",
      billDate,
      department: "采购部",
      ownerName: "本地管理员",
      lines: [
        { productCode: "CP-001", warehouseCode: "CK-001", sourceOrderNo: data.orderA, sourceLineNo: 1, qty: 1, unitPrice: 72 }
      ]
    }
  });
  const duplicateAudit = await api(`/api/purchase-ins/${encodeURIComponent(duplicateNo)}/audit`, { expectFailure: true });
  assert(duplicateAudit.status === 409, `duplicate purchase over-push audit should be blocked with 409, got ${duplicateAudit.status}`);

  const result = {
    batch,
    generatedAt: new Date().toISOString(),
    assertions: [
      "采购订单下推采购入库直连无确认对话框",
      "采购下推按剩余可入数量带全行并在入库单内改数量",
      "采购入库支持多采购订单行级源单号",
      "未审核采购入库草稿不占用采购订单源单剩余量",
      "采购入库审核按源单行汇总保留超剩余数量守卫"
    ],
    directOrderNo: data.directOrderNo,
    directLines,
    multiSource: auditedDetail.lines.map((line) => ({ lineNo: line.lineNo, sourceOrderNo: line.sourceOrderNo, sourceLineNo: line.sourceLineNo })),
    draftOccupiedOrderNo: data.draftOccupiedOrderNo,
    draftOccupiedInNo: data.draftOccupiedInNo,
    duplicateAuditStatus: duplicateAudit.status,
    screenshots
  };
  await writeFile(resultPath, JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
} finally {
  await browser.close();
}
