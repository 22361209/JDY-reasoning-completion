#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const migrationDir = path.join(root, "backend/src/main/resources/db/migration");
const javaRoot = path.join(root, "backend/src/main/java/com/jdy/erp");
const outPath = path.join(root, "verification/a119-0-architecture-inventory.json");

function walk(dir, predicate = () => true) {
  const result = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      result.push(...walk(full, predicate));
    } else if (predicate(full)) {
      result.push(full);
    }
  }
  return result;
}

function read(file) {
  return fs.readFileSync(file, "utf8");
}

function rel(file) {
  return path.relative(root, file);
}

function moduleFromFile(file) {
  const relative = path.relative(javaRoot, file);
  const first = relative.split(path.sep)[0];
  return first || "unknown";
}

function classifyTable(name) {
  const platformCore = new Set([
    "sys_account_set",
    "sys_user",
    "sys_role",
    "sys_user_role",
    "sys_permission",
    "sys_permission_catalog",
    "sys_password_reset_request",
    "sys_setting"
  ]);
  const tenantSystem = new Set([
    "document_number_sequence",
    "doc_edit_lock",
    "sys_list_filter_preset",
    "sys_operation_log",
    "sys_outbox_event",
    "sys_notification_outbox",
    "sys_print_template"
  ]);
  if (platformCore.has(name)) {
    return "platform";
  }
  if (tenantSystem.has(name)) {
    return "tenant-system";
  }
  if (/^(md_|inv_|sales_|purchase_|delivery_notice|stock_|other_stock_|prod_|production_|outsourcing_|ar_|ap_)/.test(name)) {
    return "tenant-business";
  }
  return "needs-review";
}

function tableModule(name) {
  if (name.startsWith("sys_") || name === "document_number_sequence" || name === "doc_edit_lock") return "system";
  if (name.startsWith("md_")) return "masterdata";
  if (name.startsWith("inv_") || name.startsWith("stock_") || name.startsWith("other_stock_")) return "inventory";
  if (name.startsWith("sales_") || name.startsWith("delivery_notice")) return "sales";
  if (name.startsWith("purchase_")) return "purchase";
  if (name.startsWith("prod_") || name.startsWith("production_")) return "production";
  if (name.startsWith("outsourcing_")) return "outsourcing";
  if (name.startsWith("ar_") || name.startsWith("ap_")) return "finance";
  return "unknown";
}

function classifyApi(moduleName, basePath, file) {
  if (basePath === "/api/lists") {
    return "tenant-business";
  }
  if (basePath === "/api/list-presets") {
    return "tenant-system";
  }
  if (basePath.includes("numbering") || basePath.includes("document-locks") || basePath.includes("document-lifecycle")) {
    return "tenant-system";
  }
  if (basePath.includes("account-sets") || file.includes("SystemShellController")) {
    return "platform-or-cross-tenant";
  }
  if (basePath.startsWith("/api/system") || file.includes("/system/")) {
    return "platform";
  }
  if (moduleName === "reports") {
    return "tenant-reporting";
  }
  return "tenant-business";
}

function extractStringLiteralArgs(annotationText) {
  const bare = annotationText.match(/^\s*"([^"]*)"/);
  if (bare) return bare[1];
  const direct = annotationText.match(/\(\s*"([^"]*)"/);
  if (direct) return direct[1];
  const value = annotationText.match(/value\s*=\s*"([^"]*)"/);
  if (value) return value[1];
  return "";
}

const migrationFiles = fs.readdirSync(migrationDir)
  .filter((name) => name.endsWith(".sql"))
  .sort((a, b) => {
    const av = Number((a.match(/^V(\d+)/) || [])[1] || 0);
    const bv = Number((b.match(/^V(\d+)/) || [])[1] || 0);
    return av - bv || a.localeCompare(b);
  })
  .map((name) => path.join(migrationDir, name));

const migrationText = migrationFiles.map((file) => `\n-- ${path.basename(file)}\n${read(file)}`).join("\n");
const tableMap = new Map();
for (const file of migrationFiles) {
  const text = read(file);
  for (const match of text.matchAll(/CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([a-zA-Z_][\w]*)/gi)) {
    const name = match[1];
    if (!tableMap.has(name)) {
      tableMap.set(name, {
        name,
        module: tableModule(name),
        targetOwner: classifyTable(name),
        createdIn: path.basename(file),
        accountSetScopedToday: false,
        notes: []
      });
    }
  }
}

for (const table of tableMap.values()) {
  const createPattern = new RegExp(`CREATE\\s+TABLE\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?${table.name}\\b([\\s\\S]*?);`, "i");
  const alterPattern = new RegExp(`ALTER\\s+TABLE\\s+${table.name}\\b[\\s\\S]{0,700}?account_set_id`, "i");
  const createBlock = migrationText.match(createPattern)?.[0] || "";
  table.accountSetScopedToday = /account_set_id/i.test(createBlock) || alterPattern.test(migrationText);
  if (table.targetOwner === "tenant-business" && !table.accountSetScopedToday) {
    table.notes.push("tenant table not account_set scoped in current single-db transition");
  }
  if (table.targetOwner === "platform" && table.accountSetScopedToday) {
    table.notes.push("platform table currently references account_set; revisit during platform split");
  }
}

const javaFiles = walk(javaRoot, (file) => file.endsWith(".java"));
const apiControllers = [];
const sqlRisks = [];

for (const file of javaFiles) {
  const text = read(file);
  const moduleName = moduleFromFile(file);
  const classMapping = text.match(/@RequestMapping\s*\(([^)]*)\)/);
  if (classMapping) {
    const basePath = extractStringLiteralArgs(classMapping[1]);
    const methods = [];
    const methodPattern = /@(GetMapping|PostMapping|PutMapping|DeleteMapping|PatchMapping)\s*(?:\(([^)]*)\))?/g;
    for (const match of text.matchAll(methodPattern)) {
      methods.push({
        method: match[1].replace("Mapping", "").toUpperCase(),
        path: extractStringLiteralArgs(match[2] || "")
      });
    }
    apiControllers.push({
      file: rel(file),
      module: moduleName,
      basePath,
      scope: classifyApi(moduleName, basePath, rel(file)),
      endpointCount: methods.length,
      endpoints: methods
    });
  }

  const usesJdbc = /JdbcTemplate|NamedParameterJdbcTemplate/.test(text);
  const sqlCallCount = (text.match(/jdbcTemplate\.(query|queryForList|queryForMap|queryForObject|update)|namedJdbcTemplate\.(query|queryForList|queryForMap|queryForObject|update)/g) || []).length;
  const rawSqlCount = (text.match(/\b(SELECT|INSERT\s+INTO|UPDATE|DELETE\s+FROM)\b/g) || []).length;
  if (usesJdbc || sqlCallCount > 0 || rawSqlCount > 0) {
    const tags = [];
    if (rel(file).includes("ListStubController")) tags.push("central-list-api");
    if (rel(file).includes("BillLifecycleService")) tags.push("dynamic-lifecycle-sql");
    if (rel(file).includes("InventoryPostingService")) tags.push("critical-inventory-posting");
    if (rel(file).includes("NumberingService")) tags.push("tenant-numbering");
    if (rel(file).includes("DocumentOutputController")) tags.push("report-print-export");
    if (rel(file).includes("CurrentSessionService")) tags.push("platform-session");
    if (/%s|\.formatted\(|String\.format\(/.test(text)) tags.push("dynamic-table-sql");
    sqlRisks.push({
      file: rel(file),
      module: moduleName,
      usesJdbc,
      sqlCallCount,
      rawSqlCount,
      tags
    });
  }
}

const tableList = [...tableMap.values()].sort((a, b) => a.module.localeCompare(b.module) || a.name.localeCompare(b.name));
const tableSummary = tableList.reduce((acc, table) => {
  const key = table.targetOwner;
  acc[key] = acc[key] || { total: 0, accountSetScopedToday: 0 };
  acc[key].total += 1;
  if (table.accountSetScopedToday) acc[key].accountSetScopedToday += 1;
  return acc;
}, {});

const apiSummary = apiControllers.reduce((acc, controller) => {
  const key = controller.scope;
  acc[key] = acc[key] || { controllers: 0, endpoints: 0 };
  acc[key].controllers += 1;
  acc[key].endpoints += controller.endpointCount;
  return acc;
}, {});

const riskSummary = sqlRisks.reduce((acc, item) => {
  acc.files += 1;
  acc.sqlCalls += item.sqlCallCount;
  acc.rawSqlSnippets += item.rawSqlCount;
  acc.byModule[item.module] = acc.byModule[item.module] || { files: 0, sqlCalls: 0 };
  acc.byModule[item.module].files += 1;
  acc.byModule[item.module].sqlCalls += item.sqlCallCount;
  for (const tag of item.tags) {
    acc.tags[tag] = (acc.tags[tag] || 0) + 1;
  }
  return acc;
}, { files: 0, sqlCalls: 0, rawSqlSnippets: 0, byModule: {}, tags: {} });

const output = {
  generatedAt: new Date().toISOString(),
  migrationFiles: migrationFiles.length,
  routeDecision: {
    preferred: "separate-database",
    rationale: "Matches the long-term target of platform_db + tenant_* databases and gives safer per-account backup/restore and stronger isolation. A119-0 freezes this unless a later explicit decision changes it.",
    fallback: "separate-schema only if A119-0/A119-1 proves database routing cost is unacceptable; do not mix both silently."
  },
  tables: {
    summary: tableSummary,
    items: tableList
  },
  apis: {
    summary: apiSummary,
    controllers: apiControllers.sort((a, b) => a.scope.localeCompare(b.scope) || a.file.localeCompare(b.file))
  },
  sqlRisks: {
    summary: riskSummary,
    items: sqlRisks.sort((a, b) => b.sqlCallCount - a.sqlCallCount || a.file.localeCompare(b.file))
  }
};

fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, `${JSON.stringify(output, null, 2)}\n`);

console.log(`A119 architecture inventory written to ${rel(outPath)}`);
console.log(`Tables: ${tableList.length}; APIs: ${apiControllers.length} controllers; SQL-risk files: ${sqlRisks.length}`);
console.log(`Table summary: ${JSON.stringify(tableSummary)}`);
console.log(`API summary: ${JSON.stringify(apiSummary)}`);
console.log(`SQL risk summary: ${JSON.stringify(riskSummary)}`);
