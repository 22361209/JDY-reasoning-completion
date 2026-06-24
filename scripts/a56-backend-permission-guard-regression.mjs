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

async function requireForbidden(pathname, options = {}) {
  const response = await request(pathname, options);
  const text = await response.text();
  assert(response.status === 403, `${options.method ?? "GET"} ${pathname} should be forbidden, got ${response.status}: ${text}`);
  return { status: response.status, body: text };
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

const billNo = `A56-XSDD-${batch}`;
const masterCode = `A56-P-${batch}`;
const originalMatrix = await requireJson("/api/system/role-permissions");
const originalPermissions = [...findRole(originalMatrix, roleCode).permissionCodes];
for (const permissionCode of removedPermissions) {
  assert(originalPermissions.includes(permissionCode), `original ADMIN permissions should include ${permissionCode}`);
}
assert(originalPermissions.includes("system.role_permission.manage"), "regression restore path requires system.role_permission.manage");

const reducedPermissions = originalPermissions.filter((permissionCode) => !removedPermissions.includes(permissionCode));
const assertions = [];

try {
  await requireJson("/api/sales-orders/draft", {
    method: "POST",
    body: {
      billNo,
      customerCode: "KH-001",
      billDate: "2026-06-24",
      department: "销售部",
      ownerName: "A56 后端权限回归",
      lines: [
        { productCode: "CP-001", warehouseCode: "CK-001", qty: 1, unitPrice: 10, lineRemark: "后端权限草稿" }
      ]
    }
  });

  await saveRolePermissions(roleCode, reducedPermissions);
  const session = await requireJson("/api/system/session");
  for (const permissionCode of removedPermissions) {
    assert(!session.user.permissionCodes.includes(permissionCode), `session should not include ${permissionCode}`);
  }

  assertions.push({
    name: "sales order audit blocked without sales.order.audit",
    ...(await requireForbidden(`/api/sales-orders/${encodeURIComponent(billNo)}/audit`, { method: "POST" }))
  });
  const draftAfterBlockedAudit = await requireJson(`/api/sales-orders/${encodeURIComponent(billNo)}`);
  assert(detailStatus(draftAfterBlockedAudit) === "DRAFT", "blocked audit should not change sales order status");

  assertions.push({
    name: "print template save blocked without system.print_template.manage",
    ...(await requireForbidden("/api/documents/sales-order/print-template", {
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
    ...(await requireForbidden("/api/master-data/product", {
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
} finally {
  await saveRolePermissions(roleCode, originalPermissions);
}

const restoredSession = await requireJson("/api/system/session");
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
