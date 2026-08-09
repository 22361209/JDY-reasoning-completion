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
  /filter\(\(row\) => String\(row\.auditStatus \?\? "已审核"\) === "已审核"\)/.test(masterRecordPage),
  "UAT-DEF-002: lookup options must never fall back to unaudited rows"
);
assert(
  /fetchListRows\(lookup\.listKey, \{\s*keyword,\s*status: "启用"/.test(masterRecordPage),
  "A181-006: lookup input must send its keyword to the server and request enabled rows"
);
assert(
  masterRecordPage.includes("lookupRequestSeq")
    && masterRecordPage.includes("requestSeq !== lookupRequestSeq[field.name]"),
  "A181-006: stale lookup responses must not replace newer keyword results"
);
assert(
  masterRecordPage.includes("resolveLookupOptionExactly")
    && /for \(const field of strictFields\)[\s\S]*await resolveLookupOptionExactly\(field, value\)/.test(masterRecordPage),
  "A181-006: strict lookup save must verify the exact value with the server before rejecting it"
);
assert(
  /const cachedOption = resolveLookupOption\(field, rawValue\);\s*if \(cachedOption\) \{\s*return \{ option: cachedOption, error: "", stale: false \};\s*\}\s*const result = await queryLookupOptions/.test(masterRecordPage),
  "A181-006: audited enabled cache matches must remain case-insensitive before the server fallback"
);
assert(
  masterRecordPage.includes('{{ saveLabel || "保存" }}')
    && masterRecordPage.includes('label: props.saveLabel || "保存"'),
  "UAT-DEF-002: top and bottom save actions must share the explicit save label"
);

console.log(JSON.stringify({ ok: true, defects: ["UAT-DEF-001", "UAT-DEF-002", "A181-006"] }));
