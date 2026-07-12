import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { installApiSession } from "./helpers/regression-auth.mjs";

const rootDir = path.resolve(import.meta.dirname, "..");
const verificationDir = path.join(rootDir, "verification");
const resultPath = path.join(verificationDir, "a56-backend-permission-guard-regression.json");
const apiBase = "http://127.0.0.1:8080";
await installApiSession(apiBase);
const batch = new Date().toISOString().replace(/\D/g, "").slice(0, 14);
const roleCode = "ADMIN";
const removedPermissions = [
  "sales.order.audit",
  "system.print_template.manage",
  "master.data.manage"
];

await mkdir(verificationDir, { recursive: true });

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

async function requireForbidden(pathname, expectedReason, options = {}) {
  const response = await request(pathname, options);
  const text = await response.text();
  assert(response.status === 403, `${options.method ?? "GET"} ${pathname} should be forbidden, got ${response.status}: ${text}`);
  assert(text.includes(expectedReason), `${options.method ?? "GET"} ${pathname} should report ${expectedReason}: ${text}`);
  return { status: response.status, body: text };
}

function generatedSalesOrderNo(row, label) {
  const value = String(row?.billNo ?? "");
  assert(/^XSDD\d{6}$/.test(value), `${label} should return a system sales order number, got ${JSON.stringify(row)}`);
  return value;
}

function findRole(matrix, code) {
  const role = matrix.roles.find((item) => item.code === code);
  assert(role, `role ${code} should exist`);
  return role;
}

function detailStatus(payload) {
  return payload.order?.status ?? payload.document?.status;
}

async function saveRolePermissions(code, permissionCodes) {
  return requireJson(`/api/system/roles/${encodeURIComponent(code)}/permissions`, {
    method: "PUT",
    body: { permissionCodes }
  });
}

function samePermissionSet(left, right) {
  return JSON.stringify([...new Set(left)].sort()) === JSON.stringify([...new Set(right)].sort());
}

let billNo = "";
const masterCode = `A56-P-${batch}`;
const originalMatrix = await requireJson("/api/system/role-permissions");
const originalPermissions = [...findRole(originalMatrix, roleCode).permissionCodes];
for (const permissionCode of removedPermissions) {
  assert(originalPermissions.includes(permissionCode), `original ADMIN permissions should include ${permissionCode}`);
}
assert(originalPermissions.includes("system.role_permission.manage"), "regression restore path requires system.role_permission.manage");

const reducedPermissions = originalPermissions.filter((permissionCode) => !removedPermissions.includes(permissionCode));
const assertions = [];
let primaryError;

async function restoreAdminPermissions() {
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      await saveRolePermissions(roleCode, originalPermissions);
      const restoredMatrix = await requireJson("/api/system/role-permissions");
      const restoredPermissions = findRole(restoredMatrix, roleCode).permissionCodes;
      assert(samePermissionSet(restoredPermissions, originalPermissions), `ADMIN permission restore attempt ${attempt} did not reproduce the complete original set`);
      return;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

try {
  const savedOrder = await requireJson("/api/sales-orders/draft", {
    method: "POST",
    body: {
      billNo: null,
      customerCode: "KH-001",
      billDate: "2026-06-24",
      department: "销售部",
      ownerName: "A56 后端权限回归",
      lines: [
        { productCode: "CP-001", warehouseCode: "CK-001", qty: 1, unitPrice: 10, lineRemark: "后端权限草稿" }
      ]
    }
  });
  billNo = generatedSalesOrderNo(savedOrder, "A56 sales order");

  await saveRolePermissions(roleCode, reducedPermissions);
  const session = await requireJson("/api/system/session");
  for (const permissionCode of removedPermissions) {
    assert(!session.user.permissionCodes.includes(permissionCode), `session should not include ${permissionCode}`);
  }

  assertions.push({
    name: "sales order audit blocked without sales.order.audit",
    ...(await requireForbidden(`/api/sales-orders/${encodeURIComponent(billNo)}/audit`, "当前角色无权执行该操作：sales.order.audit", { method: "POST" }))
  });
  const draftAfterBlockedAudit = await requireJson(`/api/sales-orders/${encodeURIComponent(billNo)}`);
  assert(detailStatus(draftAfterBlockedAudit) === "DRAFT", "blocked audit should not change sales order status");

  assertions.push({
    name: "print template save blocked without system.print_template.manage",
    ...(await requireForbidden("/api/documents/sales-order/print-template", "当前角色无权执行该操作：system.print_template.manage", {
      method: "PUT",
      body: {
        templateCode: "STANDARD",
        templateName: "标准套打模板",
        companyName: "博莱德机械测试账套",
        headerNote: "",
        footerNote: "本单据由系统生成",
        showSignature: true,
        showSeal: true,
        isDefault: true
      }
    }))
  });

  assertions.push({
    name: "master data create blocked without master.data.manage",
    ...(await requireForbidden("/api/master-data/product", "当前角色无权执行该操作：master.data.manage", {
      method: "POST",
      body: {
        code: masterCode,
        name: "A56 权限回归商品",
        spec: "不可落库",
        category: "测试",
        unit: "只"
      }
    }))
  });
} catch (error) {
  primaryError = error;
  throw error;
} finally {
  try {
    await restoreAdminPermissions();
  } catch (cleanupError) {
    if (primaryError) {
      console.error(`A56 permission restore failed after primary error: ${cleanupError instanceof Error ? cleanupError.stack ?? cleanupError.message : String(cleanupError)}`);
    } else {
      throw cleanupError;
    }
  }
}

const restoredSession = await requireJson("/api/system/session");
assert(samePermissionSet(restoredSession.user.permissionCodes, originalPermissions), "restored ADMIN session should match the complete original permission set");
for (const permissionCode of removedPermissions) {
  assert(restoredSession.user.permissionCodes.includes(permissionCode), `restored session should include ${permissionCode}`);
}

const auditedOrder = await requireJson(`/api/sales-orders/${encodeURIComponent(billNo)}/audit`, { method: "POST" });
assert(auditedOrder.status === "AUDITED", "restored sales.order.audit should allow audit");

const result = {
  batch,
  generatedAt: new Date().toISOString(),
  roleCode,
  removedPermissions,
  originalPermissionCount: originalPermissions.length,
  reducedPermissionCount: reducedPermissions.length,
  assertions,
  restoredAudit: {
    billNo,
    status: auditedOrder.status
  }
};

await writeFile(resultPath, JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));
