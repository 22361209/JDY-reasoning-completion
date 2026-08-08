#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import path from "node:path";

const rootDir = path.resolve(import.meta.dirname, "..");

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

const [systemApi, appVue, masterRecordPage] = await Promise.all([
  readFile(path.join(rootDir, "frontend/src/services/systemApi.ts"), "utf8"),
  readFile(path.join(rootDir, "frontend/src/app/App.vue"), "utf8"),
  readFile(path.join(rootDir, "frontend/src/modules/master-data/MasterDataRecordPage.vue"), "utf8")
]);

assert(
  /async function writeManagedUser[\s\S]*?parseErrorMessage\(text\) \|\| "用户保存失败。"/.test(systemApi),
  "UAT-DEF-001: managed-user writes must extract the server validation message"
);
assert(
  /resetManagedUserPassword[\s\S]*?parseErrorMessage\(text\) \|\| "密码重置失败。"/.test(systemApi),
  "UAT-DEF-001: managed password reset must extract the server validation message"
);
assert(
  /changeSystemPassword[\s\S]*?parseErrorMessage\(text\) \|\| "密码修改失败。"/.test(systemApi),
  "UAT-DEF-001: current-user password change must extract the server validation message"
);
assert(
  systemApi.includes("payload.message || payload.detail || payload.reason || payload.error || text"),
  "UAT-DEF-001: password validation parser must prefer user-readable JSON fields"
);
assert(
  appVue.includes(":save-label=\"activeMasterRecord.lookupCreateReturn ? '保存并审核' : '保存'\""),
  "UAT-DEF-002: lookup-created product names must expose an explicit save-and-audit action"
);
assert(
  /clearActiveDirty\(\);\s*if \(record\.lookupCreateReturn\) \{\s*await auditActiveMasterRecord\(\);\s*\}/.test(appVue),
  "UAT-DEF-002: saving a lookup-created product name must audit before returning"
);
assert(
  appVue.includes("returnToMasterLookupSource(record);"),
  "UAT-DEF-002: a successfully audited product name must return to the source material form"
);
assert(
  masterRecordPage.includes("lookupOptions[field.name] = auditedRows.map"),
  "UAT-DEF-002: lookup options must never fall back to unaudited rows"
);
assert(
  masterRecordPage.includes('{{ saveLabel || "保存" }}')
    && masterRecordPage.includes('label: props.saveLabel || "保存"'),
  "UAT-DEF-002: top and bottom save actions must share the explicit save label"
);

console.log(JSON.stringify({ ok: true, defects: ["UAT-DEF-001", "UAT-DEF-002"] }));
