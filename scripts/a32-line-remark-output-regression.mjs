import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { installApiSession } from "./helpers/regression-auth.mjs";

const rootDir = path.resolve(import.meta.dirname, "..");
const resultPath = path.join(rootDir, "verification/a32-line-remark-output-regression.json");
const apiBase = "http://127.0.0.1:8080";
await installApiSession(apiBase);
const batch = new Date().toISOString().replace(/\D/g, "").slice(0, 14);
const billNo = `XSDD-A32-${batch}`;
const firstRemark = "零值原因：样品（单价为 0）";
const secondRemark = "零值原因：补录（数量为 0）";

await mkdir(path.dirname(resultPath), { recursive: true });

async function request(pathname, options = {}) {
  const response = await fetch(`${apiBase}${pathname}`, {
    method: options.method ?? "GET",
    headers: options.body ? { "Content-Type": "application/json" } : undefined,
    body: options.body ? JSON.stringify(options.body) : undefined
  });
  const text = await response.text();
  return { ok: response.ok, status: response.status, text };
}

async function requireRequest(pathname, options = {}) {
  const result = await request(pathname, options);
  if (!result.ok) {
    throw new Error(`${options.method ?? "GET"} ${pathname} failed ${result.status}: ${result.text}`);
  }
  return result.text;
}

function assertIncludes(name, text, expected) {
  if (!text.includes(expected)) {
    throw new Error(`${name} expected to include ${expected}`);
  }
}

await requireRequest("/api/sales-orders/draft", {
  method: "POST",
  body: {
    billNo,
    customerCode: "KH-001",
    billDate: "2026-06-24",
    department: "销售部",
    ownerName: "本地管理员",
    lines: [
      { productCode: "CP-001", warehouseCode: "CK-001", qty: 1, unitPrice: 0, lineRemark: firstRemark },
      { productCode: "PJ-014", warehouseCode: "CK-002", qty: 0, unitPrice: 5, lineRemark: secondRemark },
      { productCode: "CP-T413874", warehouseCode: "CK-001", qty: 2, unitPrice: 30, lineRemark: "" }
    ]
  }
});

const csv = await requireRequest(`/api/documents/sales-order/${encodeURIComponent(billNo)}/export.csv`);
assertIncludes("csv header", csv, "行号,源单号,物料编码,物料名称,规格型号,仓库,数量,单价,金额,行备注");
assertIncludes("csv first remark", csv, firstRemark);
assertIncludes("csv second remark", csv, secondRemark);

const html = await requireRequest(`/api/documents/sales-order/${encodeURIComponent(billNo)}/print.html`);
assertIncludes("print remark column", html, "<th>行备注</th>");
assertIncludes("print first remark", html, firstRemark);
assertIncludes("print second remark", html, secondRemark);
assertIncludes("print remark class", html, "class=\"remark\"");

const result = {
  batch,
  generatedAt: new Date().toISOString(),
  billNo,
  firstRemark,
  secondRemark,
  csvChecks: {
    hasRemarkHeader: csv.includes("行号,源单号,物料编码,物料名称,规格型号,仓库,数量,单价,金额,行备注"),
    hasFirstRemark: csv.includes(firstRemark),
    hasSecondRemark: csv.includes(secondRemark)
  },
  htmlChecks: {
    hasRemarkHeader: html.includes("<th>行备注</th>"),
    hasFirstRemark: html.includes(firstRemark),
    hasSecondRemark: html.includes(secondRemark),
    hasRemarkClass: html.includes("class=\"remark\"")
  },
  csvPreview: csv.split("\n").slice(0, 10),
  htmlLength: html.length
};

await writeFile(resultPath, JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));
