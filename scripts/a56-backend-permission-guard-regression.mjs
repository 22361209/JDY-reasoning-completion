import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  createIsolatedAdminSessionFixture,
  loginApi,
  logoutApiSession
} from "./helpers/regression-auth.mjs";

const rootDir = path.resolve(import.meta.dirname, "..");
const verificationDir = path.join(rootDir, "verification");
const resultPath = path.join(verificationDir, "a56-backend-permission-guard-regression.json");
const apiBase = "http://127.0.0.1:8080";
const batch = new Date().toISOString().replace(/\D/g, "").slice(0, 14);
const deniedRoleCode = "WAREHOUSE";
const deniedUsername = "warehouse";
const deniedPermissions = [
  "sales.order.audit",
  "system.print_template.manage",
  "master.data.manage"
];

await mkdir(verificationDir, { recursive: true });
const identity = createIsolatedAdminSessionFixture(apiBase, {
  label: "a56",
  // This random r_a56_* identity is owned exclusively by this script. Its
  // cleanup may therefore release its own Redis session, then proves zero
  // residue; no shared admin or suite identity is ever eligible here.
  allowForcedRedisRelease: true
});
let deniedRoleCookie = "";
let billNo = "";
let result = null;
let primaryError = null;

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

async function request(pathname, options = {}) {
  const headers = new Headers(options.body ? { "Content-Type": "application/json" } : undefined);
  if (options.cookie) headers.set("Cookie", options.cookie);
  return fetch(`${apiBase}${pathname}`, {
    method: options.method ?? "GET",
    headers,
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

async function requireForbidden(cookie, pathname, expectedReason, options = {}) {
  const response = await request(pathname, { ...options, cookie });
  const text = await response.text();
  assert(response.status === 403, `${options.method ?? "GET"} ${pathname} should be forbidden, got ${response.status}: ${text}`);
  assert(text.includes(expectedReason), `${options.method ?? "GET"} ${pathname} should report ${expectedReason}: ${text}`);
  return { status: response.status, body: text };
}

async function cleanupSalesOrder() {
  if (!billNo) return;
  const detailResponse = await request(`/api/sales-orders/${encodeURIComponent(billNo)}`);
  if (detailResponse.status === 404) return;
  const detailText = await detailResponse.text();
  assert(detailResponse.ok, `A56 cleanup could not read sales order ${billNo}: ${detailResponse.status} ${detailText}`);
  const detail = detailText ? JSON.parse(detailText) : {};
  const status = detailStatus(detail);
  if (status === "AUDITED") {
    await requireJson(`/api/sales-orders/${encodeURIComponent(billNo)}/reverse`, { method: "POST" });
  } else {
    assert(status === "DRAFT", `A56 cleanup refuses unexpected sales order status ${status}`);
  }
  await requireJson(`/api/sales-orders/${encodeURIComponent(billNo)}`, { method: "DELETE" });
  const residue = await request(`/api/sales-orders/${encodeURIComponent(billNo)}`);
  assert(residue.status === 404, `A56 cleanup left sales order ${billNo}: ${residue.status}`);
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

function samePermissionSet(left, right) {
  return JSON.stringify([...new Set(left)].sort()) === JSON.stringify([...new Set(right)].sort());
}

try {
  await identity.installForApi("BLD-TEST");
  const masterCode = `A56-P-${batch}`;
  const originalMatrix = await requireJson("/api/system/role-permissions");
  const originalAdminPermissions = [...findRole(originalMatrix, "ADMIN").permissionCodes];
  const deniedRolePermissions = [...findRole(originalMatrix, deniedRoleCode).permissionCodes];
  for (const permissionCode of deniedPermissions) {
    assert(originalAdminPermissions.includes(permissionCode), `original ADMIN permissions should include ${permissionCode}`);
    assert(!deniedRolePermissions.includes(permissionCode), `${deniedRoleCode} should not include ${permissionCode}`);
  }
  const assertions = [];
  deniedRoleCookie = await loginApi(apiBase, deniedUsername, "warehouse123", "BLD-TEST");
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
  billNo = String(savedOrder?.billNo ?? "");
  generatedSalesOrderNo(savedOrder, "A56 sales order");

  const deniedSessionResponse = await request("/api/system/session", { cookie: deniedRoleCookie });
  const deniedSession = await deniedSessionResponse.json();
  assert(deniedSessionResponse.ok && deniedSession?.authenticated === true, `${deniedRoleCode} session should be authenticated`);
  assert(deniedSession?.user?.username === deniedUsername && deniedSession?.user?.roleCode === deniedRoleCode, `${deniedRoleCode} session identity mismatch`);
  assert(deniedSession?.tenant?.code === "BLD-TEST" && deniedSession?.tenant?.schemaName === "public", `${deniedRoleCode} session must stay in BLD-TEST/public`);
  for (const permissionCode of deniedPermissions) {
    assert(!deniedSession.user.permissionCodes.includes(permissionCode), `${deniedRoleCode} session should not include ${permissionCode}`);
  }

  assertions.push({
    name: "sales order audit blocked without sales.order.audit",
    ...(await requireForbidden(deniedRoleCookie, `/api/sales-orders/${encodeURIComponent(billNo)}/audit`, "当前角色无权执行该操作：sales.order.audit", { method: "POST" }))
  });
  const draftAfterBlockedAudit = await requireJson(`/api/sales-orders/${encodeURIComponent(billNo)}`);
  assert(detailStatus(draftAfterBlockedAudit) === "DRAFT", "blocked audit should not change sales order status");

  assertions.push({
    name: "print template save blocked without system.print_template.manage",
    ...(await requireForbidden(deniedRoleCookie, "/api/documents/sales-order/print-template", "当前角色无权执行该操作：system.print_template.manage", {
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
    ...(await requireForbidden(deniedRoleCookie, "/api/master-data/product", "当前角色无权执行该操作：master.data.manage", {
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

  const auditedOrder = await requireJson(`/api/sales-orders/${encodeURIComponent(billNo)}/audit`, { method: "POST" });
  assert(auditedOrder.status === "AUDITED", "restored sales.order.audit should allow audit");

  const finalMatrix = await requireJson("/api/system/role-permissions");
  const finalAdminPermissions = findRole(finalMatrix, "ADMIN").permissionCodes;
  const finalDeniedRolePermissions = findRole(finalMatrix, deniedRoleCode).permissionCodes;
  assert(samePermissionSet(finalAdminPermissions, originalAdminPermissions), "A56 must not change shared ADMIN permissions");
  assert(samePermissionSet(finalDeniedRolePermissions, deniedRolePermissions), `A56 must not change shared ${deniedRoleCode} permissions`);

  result = {
    batch,
    generatedAt: new Date().toISOString(),
    deniedRoleCode,
    deniedUsername,
    deniedPermissions,
    adminPermissionCount: originalAdminPermissions.length,
    deniedRolePermissionCount: deniedRolePermissions.length,
    sharedPermissionMatrixUnchanged: true,
    assertions,
    adminAudit: {
      billNo,
      status: auditedOrder.status
    }
  };

} catch (error) {
  primaryError = error;
}

const cleanupErrors = [];
try {
  await cleanupSalesOrder();
} catch (error) {
  cleanupErrors.push(error instanceof Error ? error.message : String(error));
}
if (deniedRoleCookie) {
  try {
    await logoutApiSession(apiBase, deniedRoleCookie);
  } catch (error) {
    cleanupErrors.push(error instanceof Error ? error.message : String(error));
  }
}
try {
  await identity.cleanup({
    allowForcedRedisRelease: true
  });
} catch (error) {
  cleanupErrors.push(error instanceof Error ? error.message : String(error));
}
if (primaryError) {
  if (cleanupErrors.length > 0) {
    throw new AggregateError(
      [primaryError, ...cleanupErrors.map((message) => new Error(message))],
      `A56 regression failed: ${primaryError instanceof Error ? primaryError.message : String(primaryError)}; cleanup failed: ${cleanupErrors.join("; ")}`
    );
  }
  throw primaryError;
}
if (cleanupErrors.length > 0) throw new Error(`A56 session cleanup failed: ${cleanupErrors.join("; ")}`);
assert(result, "A56 regression completed without result evidence");
await writeFile(resultPath, JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));
