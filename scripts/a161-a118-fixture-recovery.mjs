import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const rootDir = path.resolve(import.meta.dirname, "..");
const resultPath = path.join(rootDir, "verification", "a161-a118-fixture-recovery.json");
const allowedTokens = Object.freeze([
  "23FE74D8B7C8", "86691A5C4381", "049D0CA37E6A", "657B4A24B0AC", "3D2BCD87C511"
]);
const requestedTokens = process.argv.slice(2).flatMap((arg, index, args) => arg === "--token" ? [args[index + 1]] : []);

function assert(condition, message, details = undefined) {
  if (!condition) throw new Error(details === undefined ? message : `${message}: ${JSON.stringify(details)}`);
}

function sqlLiteral(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function psql(sql) {
  return execFileSync("docker", [
    "exec", "jdy-erp-postgres", "psql", "-X", "-v", "ON_ERROR_STOP=1", "-qAt",
    "-U", "jdy", "-d", "jdy_erp", "-c", sql
  ], { encoding: "utf8" }).trim();
}

function dbJson(sql) {
  const raw = psql(sql);
  return raw ? JSON.parse(raw) : null;
}

function canonicalJson(value) {
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalJson(value[key])]));
  }
  return value;
}

function jsonEqual(left, right) {
  return JSON.stringify(canonicalJson(left)) === JSON.stringify(canonicalJson(right));
}

function selectedTokens() {
  assert(process.argv.slice(2).every((arg, index, args) => arg === "--token" || (index > 0 && args[index - 1] === "--token")),
    "A161 recovery only accepts repeated --token TOKEN arguments");
  const tokens = requestedTokens.length === 0 ? [...allowedTokens] : requestedTokens;
  assert(new Set(tokens).size === tokens.length, "A161 recovery refuses duplicate tokens", tokens);
  for (const token of tokens) assert(allowedTokens.includes(token), "A161 recovery refuses an unknown token", token);
  return tokens;
}

function aggregate(table, alias, predicate, orderBy) {
  return `COALESCE((SELECT jsonb_agg(to_jsonb(${alias}) ORDER BY ${orderBy}) FROM ${table} ${alias} WHERE ${predicate}), '[]'::jsonb)`;
}

function snapshotSql(token) {
  const fixtureKey = `A118-${token}`;
  const parentCode = `CP-${fixtureKey}`;
  const componentCode = `PJ-${fixtureKey}`;
  const bomCode = `BOM-${fixtureKey}`;
  const username = `a118_${token.toLowerCase()}_admin`;
  return `WITH
    products AS (SELECT * FROM public.md_product WHERE code IN (${sqlLiteral(parentCode)}, ${sqlLiteral(componentCode)})),
    boms AS (SELECT * FROM public.prod_bom WHERE code=${sqlLiteral(bomCode)} OR product_id IN (SELECT id FROM products)),
    work_orders AS (SELECT * FROM public.outsourcing_work_order WHERE remark=${sqlLiteral(fixtureKey)}),
    issues AS (SELECT * FROM public.outsourcing_material_issue WHERE source_work_order_id IN (SELECT id FROM work_orders)),
    receipts AS (SELECT * FROM public.outsourcing_receipt WHERE source_work_order_id IN (SELECT id FROM work_orders)),
    returns AS (SELECT * FROM public.outsourcing_return WHERE source_receipt_id IN (SELECT id FROM receipts)),
    scraps AS (SELECT * FROM public.outsourcing_scrap WHERE source_receipt_id IN (SELECT id FROM receipts)),
    documents AS (
      SELECT bill_no FROM work_orders UNION ALL SELECT bill_no FROM issues UNION ALL SELECT bill_no FROM receipts
      UNION ALL SELECT bill_no FROM returns UNION ALL SELECT bill_no FROM scraps
    ),
    run_user AS (SELECT * FROM public.sys_user WHERE username=${sqlLiteral(username)})
  SELECT jsonb_build_object(
    'accountSet', COALESCE((SELECT to_jsonb(account_set) FROM public.sys_account_set account_set WHERE code='BLD-TEST' AND schema_name='public'), 'null'::jsonb),
    'adminRoles', ${aggregate("public.sys_role", "role_row", "role_row.code='ADMIN'", "role_row.id")},
    'users', ${aggregate("run_user", "app_user", "TRUE", "app_user.id")},
    'roleLinks', ${aggregate("public.sys_user_role", "user_role", "user_role.user_id IN (SELECT id FROM run_user)", "user_role.user_id, user_role.role_id")},
    'grants', ${aggregate("public.sys_user_account_set", "user_grant", "user_grant.user_id IN (SELECT id FROM run_user)", "user_grant.id")},
    'sessionScopes', ${aggregate("public.sys_session_account_scope", "session_scope", "session_scope.user_id IN (SELECT id FROM run_user)", "session_scope.session_token")},
    'products', ${aggregate("products", "product_row", "TRUE", "product_row.code")},
    'boms', ${aggregate("boms", "bom_row", "TRUE", "bom_row.id")},
    'bomLines', ${aggregate("public.prod_bom_line", "bom_line", "bom_line.bom_id IN (SELECT id FROM boms)", "bom_line.id")},
    'workOrders', ${aggregate("work_orders", "work_order", "TRUE", "work_order.id")},
    'workOrderLines', ${aggregate("public.outsourcing_work_order_line", "work_order_line", "work_order_line.work_order_id IN (SELECT id FROM work_orders)", "work_order_line.id")},
    'workOrderComponents', ${aggregate("public.outsourcing_work_order_component", "work_order_component", "work_order_component.work_order_id IN (SELECT id FROM work_orders)", "work_order_component.id")},
    'issues', ${aggregate("issues", "issue_row", "TRUE", "issue_row.id")},
    'issueLines', ${aggregate("public.outsourcing_material_issue_line", "issue_line", "issue_line.issue_id IN (SELECT id FROM issues)", "issue_line.id")},
    'receipts', ${aggregate("receipts", "receipt_row", "TRUE", "receipt_row.id")},
    'receiptLines', ${aggregate("public.outsourcing_receipt_line", "receipt_line", "receipt_line.receipt_id IN (SELECT id FROM receipts)", "receipt_line.id")},
    'returns', ${aggregate("returns", "return_row", "TRUE", "return_row.id")},
    'returnLines', ${aggregate("public.outsourcing_return_line", "return_line", "return_line.return_id IN (SELECT id FROM returns)", "return_line.id")},
    'scraps', ${aggregate("scraps", "scrap_row", "TRUE", "scrap_row.id")},
    'scrapLines', ${aggregate("public.outsourcing_scrap_line", "scrap_line", "scrap_line.scrap_id IN (SELECT id FROM scraps)", "scrap_line.id")},
    'transactions', ${aggregate("public.inv_stock_txn", "stock_txn", "stock_txn.product_id IN (SELECT id FROM products)", "stock_txn.occurred_at, stock_txn.id")},
    'balances', ${aggregate("public.inv_stock_balance", "stock_balance", "stock_balance.product_id IN (SELECT id FROM products)", "stock_balance.id")},
    'logs', ${aggregate("public.sys_operation_log", "operation_log", `operation_log.actor_username=${sqlLiteral(username)}`, "operation_log.id")},
    'locks', ${aggregate("public.doc_edit_lock", "edit_lock", `edit_lock.holder_username=${sqlLiteral(username)} OR edit_lock.bill_no IN (SELECT bill_no FROM documents)`, "edit_lock.document_type, edit_lock.bill_no")}
  )`;
}

function validateSnapshot(token, state) {
  const fixtureKey = `A118-${token}`;
  const parentCode = `CP-${fixtureKey}`;
  const componentCode = `PJ-${fixtureKey}`;
  const username = `a118_${token.toLowerCase()}_admin`;
  assert(state?.accountSet?.code === "BLD-TEST" && state.accountSet.schema_name === "public", "A161 recovery refuses a changed BLD-TEST route", state?.accountSet);
  assert(state.adminRoles.length === 1 && state.adminRoles[0].code === "ADMIN", "A161 recovery requires one ADMIN role", state.adminRoles);
  const expectedCounts = {
    users: 1, roleLinks: 1, grants: 1, sessionScopes: 0, products: 2, boms: 1, bomLines: 1,
    workOrders: 1, workOrderLines: 1, workOrderComponents: 1, issues: 1, issueLines: 1,
    receipts: 1, receiptLines: 1, returns: 1, returnLines: 1, scraps: 1, scrapLines: 1,
    transactions: 7, balances: 2, logs: 20, locks: 0
  };
  for (const [key, count] of Object.entries(expectedCounts)) {
    assert(Array.isArray(state[key]) && state[key].length === count, `A161 recovery refuses an unexpected ${key} count`, { token, count: state[key]?.length, expected: count });
  }
  const parent = state.products.find((row) => row.code === parentCode);
  const component = state.products.find((row) => row.code === componentCode);
  assert(parent && component && state.products.every((row) => row.spec === fixtureKey && row.remark === fixtureKey && row.enabled === true && row.audit_status === "AUDITED"),
    "A161 recovery refuses changed product semantics", state.products);
  assert(parent.name === `A118 委外母件 ${token}` && parent.category === "成品总成" && parent.unit === "只"
    && parent.is_sale && parent.is_inventory && parent.is_produce && parent.is_subcontract,
  "A161 recovery refuses changed parent product semantics", parent);
  assert(component.name === `A118 委外子件 ${token}` && component.category === "零配件" && component.unit === "件"
    && component.is_purchase && component.is_inventory && !component.is_produce && !component.is_subcontract,
  "A161 recovery refuses changed component product semantics", component);
  assert(state.boms[0].code === `BOM-${fixtureKey}` && state.boms[0].product_id === parent.id && state.boms[0].audit_status === "AUDITED", "A161 recovery refuses changed BOM semantics", state.boms);
  assert(state.bomLines[0].bom_id === state.boms[0].id && state.bomLines[0].material_id === component.id && Number(state.bomLines[0].qty) === 2, "A161 recovery refuses changed BOM line semantics", state.bomLines);
  assert(state.workOrders[0].remark === fixtureKey && state.workOrders[0].status === "AUDITED", "A161 recovery refuses changed work order semantics", state.workOrders);
  assert(state.workOrderLines[0].work_order_id === state.workOrders[0].id && state.workOrderLines[0].product_id === parent.id, "A161 recovery refuses changed work order line", state.workOrderLines);
  assert(state.workOrderComponents[0].work_order_id === state.workOrders[0].id && state.workOrderComponents[0].product_id === component.id, "A161 recovery refuses changed work order component", state.workOrderComponents);
  assert(state.issues[0].source_work_order_id === state.workOrders[0].id && state.issues[0].status === "AUDITED", "A161 recovery refuses changed issue semantics", state.issues);
  assert(state.receipts[0].source_work_order_id === state.workOrders[0].id && state.receipts[0].status === "AUDITED", "A161 recovery refuses changed receipt semantics", state.receipts);
  assert(state.returns[0].source_receipt_id === state.receipts[0].id && state.returns[0].status === "DRAFT", "A161 recovery refuses changed return semantics", state.returns);
  assert(state.scraps[0].source_receipt_id === state.receipts[0].id && state.scraps[0].status === "DRAFT", "A161 recovery refuses changed scrap semantics", state.scraps);
  assert(state.users[0].username === username && state.users[0].enabled === true, "A161 recovery refuses changed run user", state.users);
  assert(state.roleLinks[0].user_id === state.users[0].id && state.roleLinks[0].role_id === state.adminRoles[0].id, "A161 recovery refuses changed role link", state.roleLinks);
  assert(state.grants[0].user_id === state.users[0].id && state.grants[0].account_set_id === state.accountSet.id && state.grants[0].role_code === "ADMIN", "A161 recovery refuses changed account grant", state.grants);
  assert(state.transactions.every((row) => [parent.id, component.id].includes(row.product_id)) && state.balances.every((row) => [parent.id, component.id].includes(row.product_id)), "A161 recovery refuses foreign inventory rows", { transactions: state.transactions, balances: state.balances });
  assert(state.logs.every((row) => row.actor_username === username && row.operated_by === state.users[0].id), "A161 recovery refuses foreign operation logs", state.logs);
}

function deleteToken(token, snapshot) {
  const fixtureKey = `A118-${token}`;
  const parentCode = `CP-${fixtureKey}`;
  const componentCode = `PJ-${fixtureKey}`;
  const bomCode = `BOM-${fixtureKey}`;
  const username = `a118_${token.toLowerCase()}_admin`;
  const snapshotSqlText = snapshotSql(token);
  psql(`BEGIN;
    SET LOCAL lock_timeout='5s';
    SET LOCAL statement_timeout='30s';
    LOCK TABLE public.sys_user, public.sys_user_role, public.sys_user_account_set, public.sys_session_account_scope,
      public.md_product, public.prod_bom, public.prod_bom_line,
      public.outsourcing_work_order, public.outsourcing_work_order_line, public.outsourcing_work_order_component,
      public.outsourcing_material_issue, public.outsourcing_material_issue_line,
      public.outsourcing_receipt, public.outsourcing_receipt_line,
      public.outsourcing_return, public.outsourcing_return_line,
      public.outsourcing_scrap, public.outsourcing_scrap_line,
      public.inv_stock_txn, public.inv_stock_balance, public.sys_operation_log, public.doc_edit_lock
      IN SHARE ROW EXCLUSIVE MODE;
    DO $a161_recovery$
    DECLARE actual jsonb;
    BEGIN
      SELECT (${snapshotSqlText}) INTO actual;
      IF actual IS DISTINCT FROM ${sqlLiteral(JSON.stringify(snapshot))}::jsonb THEN
        RAISE EXCEPTION 'A161 recovery refused: ownership snapshot changed for ${token}';
      END IF;
      DELETE FROM public.sys_operation_log WHERE actor_username=${sqlLiteral(username)};
      DELETE FROM public.inv_stock_txn WHERE product_id IN (SELECT id FROM public.md_product WHERE code IN (${sqlLiteral(parentCode)}, ${sqlLiteral(componentCode)}));
      DELETE FROM public.outsourcing_return_line WHERE return_id IN (SELECT id FROM public.outsourcing_return WHERE source_receipt_id IN (SELECT id FROM public.outsourcing_receipt WHERE source_work_order_id IN (SELECT id FROM public.outsourcing_work_order WHERE remark=${sqlLiteral(fixtureKey)})));
      DELETE FROM public.outsourcing_scrap_line WHERE scrap_id IN (SELECT id FROM public.outsourcing_scrap WHERE source_receipt_id IN (SELECT id FROM public.outsourcing_receipt WHERE source_work_order_id IN (SELECT id FROM public.outsourcing_work_order WHERE remark=${sqlLiteral(fixtureKey)})));
      DELETE FROM public.outsourcing_return WHERE source_receipt_id IN (SELECT id FROM public.outsourcing_receipt WHERE source_work_order_id IN (SELECT id FROM public.outsourcing_work_order WHERE remark=${sqlLiteral(fixtureKey)}));
      DELETE FROM public.outsourcing_scrap WHERE source_receipt_id IN (SELECT id FROM public.outsourcing_receipt WHERE source_work_order_id IN (SELECT id FROM public.outsourcing_work_order WHERE remark=${sqlLiteral(fixtureKey)}));
      DELETE FROM public.outsourcing_receipt_line WHERE receipt_id IN (SELECT id FROM public.outsourcing_receipt WHERE source_work_order_id IN (SELECT id FROM public.outsourcing_work_order WHERE remark=${sqlLiteral(fixtureKey)}));
      DELETE FROM public.outsourcing_receipt WHERE source_work_order_id IN (SELECT id FROM public.outsourcing_work_order WHERE remark=${sqlLiteral(fixtureKey)});
      DELETE FROM public.outsourcing_material_issue_line WHERE issue_id IN (SELECT id FROM public.outsourcing_material_issue WHERE source_work_order_id IN (SELECT id FROM public.outsourcing_work_order WHERE remark=${sqlLiteral(fixtureKey)}));
      DELETE FROM public.outsourcing_material_issue WHERE source_work_order_id IN (SELECT id FROM public.outsourcing_work_order WHERE remark=${sqlLiteral(fixtureKey)});
      DELETE FROM public.outsourcing_work_order_component WHERE work_order_id IN (SELECT id FROM public.outsourcing_work_order WHERE remark=${sqlLiteral(fixtureKey)});
      DELETE FROM public.outsourcing_work_order_line WHERE work_order_id IN (SELECT id FROM public.outsourcing_work_order WHERE remark=${sqlLiteral(fixtureKey)});
      DELETE FROM public.outsourcing_work_order WHERE remark=${sqlLiteral(fixtureKey)};
      DELETE FROM public.prod_bom_line WHERE bom_id IN (SELECT id FROM public.prod_bom WHERE code=${sqlLiteral(bomCode)});
      DELETE FROM public.prod_bom WHERE code=${sqlLiteral(bomCode)};
      DELETE FROM public.inv_stock_balance WHERE product_id IN (SELECT id FROM public.md_product WHERE code IN (${sqlLiteral(parentCode)}, ${sqlLiteral(componentCode)}));
      DELETE FROM public.md_product WHERE code IN (${sqlLiteral(parentCode)}, ${sqlLiteral(componentCode)});
      DELETE FROM public.sys_session_account_scope WHERE user_id IN (SELECT id FROM public.sys_user WHERE username=${sqlLiteral(username)});
      DELETE FROM public.sys_user_account_set WHERE user_id IN (SELECT id FROM public.sys_user WHERE username=${sqlLiteral(username)});
      DELETE FROM public.sys_user_role WHERE user_id IN (SELECT id FROM public.sys_user WHERE username=${sqlLiteral(username)});
      DELETE FROM public.sys_user WHERE username=${sqlLiteral(username)};
    END;
    $a161_recovery$;
    COMMIT;`);
}

function residueSql(token) {
  const fixtureKey = `A118-${token}`;
  const parentCode = `CP-${fixtureKey}`;
  const componentCode = `PJ-${fixtureKey}`;
  const bomCode = `BOM-${fixtureKey}`;
  const username = `a118_${token.toLowerCase()}_admin`;
  return `SELECT jsonb_build_object(
    'products', (SELECT count(*) FROM public.md_product WHERE code IN (${sqlLiteral(parentCode)}, ${sqlLiteral(componentCode)})),
    'boms', (SELECT count(*) FROM public.prod_bom WHERE code=${sqlLiteral(bomCode)}),
    'workOrders', (SELECT count(*) FROM public.outsourcing_work_order WHERE remark=${sqlLiteral(fixtureKey)}),
    'documents', (SELECT count(*) FROM public.outsourcing_material_issue WHERE source_work_order_id IN (SELECT id FROM public.outsourcing_work_order WHERE remark=${sqlLiteral(fixtureKey)})) + (SELECT count(*) FROM public.outsourcing_receipt WHERE source_work_order_id IN (SELECT id FROM public.outsourcing_work_order WHERE remark=${sqlLiteral(fixtureKey)})),
    'logs', (SELECT count(*) FROM public.sys_operation_log WHERE actor_username=${sqlLiteral(username)}),
    'users', (SELECT count(*) FROM public.sys_user WHERE username=${sqlLiteral(username)})
  )`;
}

const tokens = selectedTokens();
const result = { ok: false, tokens, runs: [], failure: null };
try {
  for (const token of tokens) {
    const first = dbJson(snapshotSql(token));
    validateSnapshot(token, first);
    const second = dbJson(snapshotSql(token));
    assert(jsonEqual(first, second), "A161 recovery refused an unstable pre-delete snapshot", { token });
    deleteToken(token, second);
    const residue = dbJson(residueSql(token));
    assert(Object.values(residue).every((count) => count === 0), "A161 recovery closure is not zero", { token, residue });
    result.runs.push({ token, snapshotCounts: Object.fromEntries(Object.entries(second).filter(([, value]) => Array.isArray(value)).map(([key, value]) => [key, value.length])), residue });
  }
  result.ok = true;
} catch (error) {
  result.failure = error instanceof Error ? error.message : String(error);
  throw error;
} finally {
  await mkdir(path.dirname(resultPath), { recursive: true });
  await writeFile(resultPath, `${JSON.stringify(result, null, 2)}\n`);
}

console.log(JSON.stringify(result, null, 2));
