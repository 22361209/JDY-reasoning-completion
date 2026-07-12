import fs from "node:fs";
import path from "node:path";

const root = process.cwd();

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), "utf8");
}

function stripComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}

function parseBooleans(text) {
  return text.split(",").map((item) => item.trim()).map((item) => {
    if (item === "true") return true;
    if (item === "false") return false;
    return item;
  });
}

function parseFrontendPolicies(source) {
  const defaultMatch = source.match(/const DEFAULT_FACT_POLICY[\s\S]*?=\s*\{([\s\S]*?)\};/);
  const defaultPolicy = {};
  if (defaultMatch) {
    for (const line of defaultMatch[1].split("\n")) {
      const match = line.match(/(\w+):\s*(true|false)/);
      if (match) {
        defaultPolicy[match[1]] = match[2] === "true";
      }
    }
  }
  const blockMatch = source.match(/const lifecyclePolicyByType[\s\S]*?=\s*\{([\s\S]*?)\};/);
  if (!blockMatch) {
    throw new Error("frontend lifecycle policy block not found");
  }
  const policies = {};
  for (const line of blockMatch[1].split("\n")) {
    const defaultLine = line.match(/^\s*(\w+):\s*DEFAULT_FACT_POLICY/);
    if (defaultLine) {
      policies[defaultLine[1]] = { ...defaultPolicy };
      continue;
    }
    const objectLine = line.match(/^\s*(\w+):\s*\{([^}]+)\}/);
    if (!objectLine) continue;
    const policy = {};
    for (const part of objectLine[2].split(",")) {
      const match = part.trim().match(/(\w+):\s*(true|false)/);
      if (match) {
        policy[match[1]] = match[2] === "true";
      }
    }
    policies[objectLine[1]] = policy;
  }
  return policies;
}

function parseControllerTargets(source) {
  const targets = {};
  const pattern = /Map\.entry\("([^"]+)",\s*new BillLifecycleTarget\("([^"]+)"/g;
  let match;
  while ((match = pattern.exec(source))) {
    targets[match[1]] = match[2];
  }
  return targets;
}

function parseDocumentPermissions(source) {
  const permissions = {};
  const pattern = /Map\.entry\("([^"]+)",\s*"([^"]+)"\)/g;
  let match;
  while ((match = pattern.exec(source))) {
    permissions[match[1]] = match[2];
  }
  return permissions;
}

function parseBackendPolicies(source) {
  const factMatch = source.match(/FACT_DOCUMENT\s*=\s*new LifecycleCapabilities\(([^)]+)\)/);
  const factPolicy = factMatch ? parseBooleans(factMatch[1]) : [];
  const policies = {};
  const pattern = /Map\.entry\("([^"]+)",\s*(FACT_DOCUMENT|new LifecycleCapabilities\(([^)]+)\))\)/g;
  let match;
  while ((match = pattern.exec(source))) {
    const values = match[2] === "FACT_DOCUMENT" ? factPolicy : parseBooleans(match[3]);
    policies[match[1]] = {
      closeFreezeAllowed: values[0],
      lineCloseFreezeAllowed: values[1],
      redReverseAllowed: values[2],
      voidAllowed: values[3]
    };
  }
  return policies;
}

function parseDocumentActionListTypes(source) {
  const match = source.match(/const documentActionTypeByListKey[\s\S]*?=\s*\{([\s\S]*?)\};/);
  if (!match) {
    throw new Error("documentActionTypeByListKey block not found");
  }
  const values = [];
  const pattern = /"[^"]+":\s*"([^"]+)"/g;
  let item;
  while ((item = pattern.exec(match[1]))) {
    values.push(item[1]);
  }
  return [...new Set(values)].sort();
}

function scanFiles(dir, predicate) {
  const hits = [];
  for (const entry of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
    const relative = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      hits.push(...scanFiles(relative, predicate));
    } else if (predicate(relative)) {
      hits.push(relative);
    }
  }
  return hits;
}

const frontendPolicySource = read("frontend/src/app/documentLifecyclePolicy.ts");
const controllerSource = read("backend/src/main/java/com/jdy/erp/shared/api/BillLifecycleController.java");
const backendPolicySource = read("backend/src/main/java/com/jdy/erp/shared/application/BillLifecyclePolicy.java");
const permissionPolicySource = read("backend/src/main/java/com/jdy/erp/shared/application/DocumentPermissionPolicy.java");
const documentLockServiceSource = read("backend/src/main/java/com/jdy/erp/shared/application/DocumentLockService.java");
const documentLockControllerSource = read("backend/src/main/java/com/jdy/erp/shared/api/DocumentLockController.java");
const permissionGuardSource = read("backend/src/main/java/com/jdy/erp/system/security/PermissionGuardInterceptor.java");
const dataListSource = read("frontend/src/components/DataListPage.vue");

const frontendPolicies = parseFrontendPolicies(frontendPolicySource);
const controllerTargets = parseControllerTargets(controllerSource);
const backendPolicies = parseBackendPolicies(backendPolicySource);
const documentPermissions = parseDocumentPermissions(permissionPolicySource);
const listActionTypes = parseDocumentActionListTypes(dataListSource);

const failures = [];
const warnings = [];

if (!/@RequireDocumentPermission\s+public class BillLifecycleController/.test(controllerSource)) {
  failures.push("BillLifecycleController must require dynamic document permission before lifecycle writes");
}
if (!/RequireDocumentPermission/.test(permissionGuardSource)
  || !/DocumentPermissionPolicy/.test(permissionGuardSource)
  || !/URI_TEMPLATE_VARIABLES_ATTRIBUTE/.test(permissionGuardSource)
  || !/documentPermissionPolicy\.requirePermission/.test(permissionGuardSource)) {
  failures.push("PermissionGuardInterceptor must resolve @RequireDocumentPermission from the mapped {type} before controller execution");
}

for (const type of Object.keys(controllerTargets)) {
  if (!documentPermissions[type]) {
    failures.push(`controller target ${type} has no document permission mapping`);
  }
}

for (const type of Object.keys(documentPermissions)) {
  if (!controllerTargets[type]) {
    failures.push(`document permission mapping ${type} has no BillLifecycleController target`);
  }
}

if (!/@GetMapping\("\/\{type\}\/\{billNo\}"\)\s+@RequireDocumentPermission/.test(documentLockControllerSource)) {
  failures.push("document lock status must require the mapped document permission");
}
if (!/@PostMapping\("\/\{type\}\/\{billNo\}\/acquire"\)\s+@RequireDocumentPermission/.test(documentLockControllerSource)) {
  failures.push("document lock acquire must require the mapped document permission");
}
if (!/documentPermissionPolicy\.supportedDocumentTypes\(\)\.contains\(documentType\)/.test(documentLockServiceSource)) {
  failures.push("DocumentLockService must derive supported types from the unique DocumentPermissionPolicy registry");
}

for (const [type, frontPolicy] of Object.entries(frontendPolicies)) {
  const headerTable = controllerTargets[type];
  if (!headerTable) {
    failures.push(`frontend policy ${type} has no BillLifecycleController target`);
    continue;
  }
  const backendPolicy = backendPolicies[headerTable];
  if (!backendPolicy) {
    failures.push(`controller target ${type}/${headerTable} has no backend BillLifecyclePolicy capability`);
    continue;
  }
  for (const key of ["closeFreezeAllowed", "lineCloseFreezeAllowed", "redReverseAllowed", "voidAllowed"]) {
    if (frontPolicy[key] !== backendPolicy[key]) {
      failures.push(`policy mismatch ${type}.${key}: frontend=${frontPolicy[key]} backend=${backendPolicy[key]}`);
    }
  }
}

for (const type of listActionTypes) {
  if (!frontendPolicies[type]) {
    failures.push(`DataListPage lifecycle action list type ${type} is not registered in frontend lifecycle policy`);
  }
}

const backendJavaFiles = scanFiles("backend/src/main/java", (file) => file.endsWith(".java"));
const frontendFiles = scanFiles("frontend/src", (file) => /\.(ts|vue)$/.test(file));
const scriptFiles = scanFiles("scripts", (file) => file.endsWith(".mjs") && file !== "scripts/a124-lifecycle-contract-scan.mjs");

for (const file of backendJavaFiles) {
  const content = stripComments(read(file));
  if (/BillStatus\.AUDITED\.name\(\)\s*,\s*BillStatus\.REVERSED\.name\(\)/.test(content) || /BillStatus\.REVERSED\.name\(\)/.test(content)) {
    failures.push(`${file} still writes or targets BillStatus.REVERSED`);
  }
  if (/SET\s+status\s*=\s*'REVERSED'/i.test(content)) {
    failures.push(`${file} directly sets status='REVERSED'`);
  }
  if (/execution_status/i.test(content)) {
    failures.push(`${file} references execution_status in application code`);
  }
}

for (const file of frontendFiles) {
  const content = stripComments(read(file));
  if (/outStatus\s*!==\s*["']全部出库["']/.test(content) || /inStatus\s*!==\s*["']全部入库["']/.test(content)) {
    failures.push(`${file} uses display status text to decide pushdown`);
  }
  if (/execution_status/i.test(content)) {
    failures.push(`${file} references execution_status in frontend code`);
  }
}

for (const file of scriptFiles) {
  const content = read(file);
  if (/当前批次只接入|占位提示/.test(content)) {
    failures.push(`${file} still contains placeholder batch action wording`);
  }
  if (/click\(\{\s*force:\s*true/.test(content) || /force:\s*true/.test(content)) {
    warnings.push(`${file} contains force:true click; verify whether it hides real UI hit-test issues`);
  }
}

const localActionFiles = frontendFiles.filter((file) => {
  if (!file.endsWith(".vue")) return false;
  if (file.includes("components/")) return false;
  const content = read(file);
  return /defineAction\("(audit|reverse|close|unclose|freeze|unfreeze|void|redReverse)"/.test(content);
});

for (const file of localActionFiles) {
  if (file.includes("modules/production/production-task/")) {
    warnings.push(`${file} has local lifecycle-like actions and is an immature/boundary module to be reclaimed later`);
  }
}

const result = {
  ok: failures.length === 0,
  checkedAt: new Date().toISOString(),
  registeredDocumentTypes: Object.keys(frontendPolicies).sort(),
  documentPermissionTypes: Object.keys(documentPermissions).sort(),
  listActionTypes,
  failures,
  warnings
};

console.log(JSON.stringify(result, null, 2));

if (failures.length > 0) {
  process.exit(1);
}
