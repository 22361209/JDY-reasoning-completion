import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { installApiSession } from "./helpers/regression-auth.mjs";

const rootDir = path.resolve(import.meta.dirname, "..");
const verificationDir = path.join(rootDir, "verification");
const resultPath = path.join(verificationDir, "a114-production-plan-snapshot-regression.json");
const apiBase = "http://127.0.0.1:8080";
await installApiSession(apiBase);
await mkdir(verificationDir, { recursive: true });

const batch = new Date().toISOString().replace(/\D/g, "").slice(0, 14);
const bomCode = `BOM-A114-${batch}`;
const taskNo = `SCRW-A114-${batch}`;
const issueNo = `SOUT-A114-${batch}`;

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
  for (const productCode of ["CP-001", "PJ-014"]) {
    await requireJson("/api/inventory/adjustments", {
      method: "POST",
      body: {
        productCode,
        warehouseCode: "CK-002",
        qtyDelta: 5000,
        txnType: "A114_PRODUCTION_SNAPSHOT_SEED",
        sourceBillType: `A114:${batch}`
      }
    });
  }
}

await seedStock();

await requireJson("/api/production/boms", {
  method: "POST",
  body: {
    code: bomCode,
    productCode: "CP-001",
    qty: 1,
    lines: [
      { materialCode: "CP-001", qty: 1 },
      { materialCode: "PJ-014", qty: 2 }
    ]
  }
});
await requireJson(`/api/production/boms/${encodeURIComponent(bomCode)}/audit`, { method: "POST" });

const task = await requireJson("/api/production/tasks", {
  method: "POST",
  body: { billNo: taskNo, bomCode, warehouseCode: "CK-001", qty: 3 }
});

const taskList = await requireJson(`/api/lists/production-task-form-list?keyword=${encodeURIComponent(taskNo)}&pageSize=200`);
const taskRow = taskList.rows.find((row) => row.billNo === taskNo);

assert(task.billNo === taskNo, "task should keep requested bill number");
assert(taskRow, "production task list should show created task");
assert(!taskRow.planNo, "standalone production task must not create a hidden production plan");
assert(taskRow?.bomCode === bomCode, "production task should keep BOM code");

await requireJson("/api/production/boms", {
  method: "POST",
  body: {
    code: bomCode,
    productCode: "CP-001",
    qty: 1,
    lines: [
      { materialCode: "CP-001", qty: 1 },
      { materialCode: "PJ-014", qty: 9 }
    ]
  }
});
await requireJson(`/api/production/boms/${encodeURIComponent(bomCode)}/audit`, { method: "POST" });

await requireJson(`/api/production/tasks/${encodeURIComponent(taskNo)}/issue`, {
  method: "POST",
  body: { billNo: issueNo, materialWarehouseCode: "CK-002" }
});

const detail = await requireJson(`/api/production/material-issues/${encodeURIComponent(issueNo)}`);
const pjLine = detail.lines.find((line) => line.productCode === "PJ-014");
assert(pjLine, "issue should include PJ-014 from task material snapshot");
assert(Number(pjLine.qty) === 6, "issue qty should use task snapshot 2*3, not modified BOM 9*3");

const result = {
  ok: true,
  batch,
  bomCode,
  taskNo,
  issueNo,
  checks: {
    standaloneTaskHasNoPlanNo: !taskRow.planNo,
    issueUsesSnapshotQty: Number(pjLine.qty) === 6
  }
};

await writeFile(resultPath, JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));
