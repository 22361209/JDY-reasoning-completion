#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";

import { loginApi, loginAs } from "./helpers/regression-auth.mjs";

const rootDir = path.resolve(import.meta.dirname, "..");
const apiBase = "http://127.0.0.1:8080";
const frontendUrl = "http://127.0.0.1:5173/";
const runId = `${new Date().toISOString().replace(/\D/g, "").slice(0, 14)}-${randomUUID().slice(0, 8)}`;
const compactRunId = runId.replaceAll("-", "");
const fixturePrefix = `A140-${runId}`;
const userPrefix = `a140_${compactRunId}`;
const masterRoleCode = `A140_MASTER_${compactRunId}`;
const verificationDir = path.join(rootDir, "verification");
const screenshotDir = path.join(verificationDir, "playwright");
const resultPath = path.join(verificationDir, "a140-employee-financial-account-regression.json");

const users = {
  admin: { username: `${userPrefix}_admin`, password: `A140-${compactRunId}-admin`, role: "ADMIN" },
  master: { username: `${userPrefix}_master`, password: `A140-${compactRunId}-master`, role: masterRoleCode },
  finance: { username: `${userPrefix}_finance`, password: `A140-${compactRunId}-finance`, role: "FINANCE" },
  warehouse: { username: `${userPrefix}_warehouse`, password: `A140-${compactRunId}-warehouse`, role: "WAREHOUSE" }
};

const fixtures = {
  employee: `${fixturePrefix}-E`,
  employeeDraft: `${fixturePrefix}-ED`,
  employeeDisabled: `${fixturePrefix}-EX`,
  accountCash: `${fixturePrefix}-AC`,
  accountBank: `${fixturePrefix}-AB`,
  accountDraft: `${fixturePrefix}-AD`,
  accountDisabled: `${fixturePrefix}-AX`,
  uiEmployee: `${fixturePrefix}-UE`,
  uiAccount: `${fixturePrefix}-UA`,
  forbiddenEmployee: `${fixturePrefix}-FE`,
  forbiddenAccount: `${fixturePrefix}-FA`,
  masterPermissionEmployee: `${fixturePrefix}-ME`
};

const listKeys = [
  "employee-master-list",
  "employee-master-selector",
  "financial-account-master-list",
  "financial-account-master-selector"
];

const evidence = {
  runId,
  generatedAt: new Date().toISOString(),
  ok: false,
  fixtures: { ...fixtures, users: Object.fromEntries(Object.entries(users).map(([key, value]) => [key, value.username])) },
  environment: {},
  requests: [],
  assertions: [],
  api: {},
  permissions: [],
  selectors: {},
  tenantIsolation: {},
  employeeLink: {},
  browser: [],
  permissionBrowser: [],
  screenshots: [],
  auditTrail: [],
  cleanup: { attempted: false, remaining: null, error: "" },
  failure: null
};

let browser = null;
let cookies = {};
let replayTenant = null;

function assert(condition, message, details = undefined) {
  if (!condition) {
    const suffix = details === undefined ? "" : ` ${JSON.stringify(details)}`;
    throw new Error(`${message}${suffix}`);
  }
  evidence.assertions.push({ message, details });
}

function same(actual, expected) {
  return JSON.stringify(actual) === JSON.stringify(expected);
}

function sqlLiteral(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function sqlIdentifier(value) {
  const normalized = String(value);
  if (!/^[a-z_][a-z0-9_]*$/i.test(normalized)) {
    throw new Error(`unsafe SQL identifier: ${normalized}`);
  }
  return `"${normalized.replaceAll('"', '""')}"`;
}

function dbScalar(sql) {
  return execFileSync(
    "docker",
    ["exec", "jdy-erp-postgres", "psql", "-X", "-U", "jdy", "-d", "jdy_erp", "-v", "ON_ERROR_STOP=1", "-tAq", "-c", sql],
    { encoding: "utf8" }
  ).trim();
}

function dbJson(sql) {
  const text = dbScalar(sql);
  return text ? JSON.parse(text) : null;
}

async function request(cookie, pathname, options = {}) {
  const method = options.method ?? "GET";
  const headers = new Headers(options.body === undefined ? undefined : { "Content-Type": "application/json" });
  if (cookie) {
    headers.set("Cookie", cookie);
  }
  const response = await fetch(`${apiBase}${pathname}`, {
    method,
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body)
  });
  const text = await response.text();
  let data = null;
  if (text.trim()) {
    try {
      data = JSON.parse(text);
    } catch {
      data = null;
    }
  }
  return { status: response.status, ok: response.ok, text, data };
}

function expectStatus(label, response, expectedStatus) {
  evidence.requests.push({ label, expectedStatus, actualStatus: response.status });
  assert(response.status === expectedStatus, `${label} 应返回 HTTP ${expectedStatus}`, {
    actualStatus: response.status,
    body: response.text.slice(0, 500)
  });
}

function assertResponseShape(label, row, code, expectedVersion = undefined) {
  for (const key of ["id", "systemNo", "code", "name", "version", "auditStatus", "status"]) {
    assert(Object.prototype.hasOwnProperty.call(row ?? {}, key), `${label} 响应必须包含 ${key}`, row);
  }
  assert(row.code === code, `${label} 必须返回请求编码`, row);
  if (expectedVersion !== undefined) {
    assert(row.version === expectedVersion, `${label} version 应为 ${expectedVersion}`, row);
  }
}

async function listResponse(cookie, listKey, keyword = fixturePrefix, suffix = "") {
  const query = new URLSearchParams({ keyword, page: "1", pageSize: "200" });
  return request(cookie, `/api/lists/${encodeURIComponent(listKey)}${suffix}?${query}`);
}

async function listRows(cookie, listKey, keyword = fixturePrefix) {
  const response = await listResponse(cookie, listKey, keyword);
  expectStatus(`${listKey} query ${keyword}`, response, 200);
  assert(Array.isArray(response.data?.rows), `${listKey} 必须返回 rows 数组`, response.data);
  return response.data.rows;
}

async function exactRow(cookie, listKey, code) {
  const rows = await listRows(cookie, listKey, code);
  const exact = rows.filter((row) => row.code === code);
  assert(exact.length <= 1, `${listKey} 编码 ${code} 不得返回重复行`, exact);
  return exact[0] ?? null;
}

async function assertNoRow(cookie, listKey, code, message) {
  const row = await exactRow(cookie, listKey, code);
  assert(row === null, message, row);
}

async function createMaster(type, payload, label = `${type} create`) {
  const response = await request(cookies.admin, `/api/master-data/${encodeURIComponent(type)}`, { method: "POST", body: payload });
  expectStatus(label, response, 201);
  assertResponseShape(label, response.data, payload.code, 0);
  return response.data;
}

async function patchMaster(type, code, version, changes, expectedStatus = 200, label = `${type} PATCH`) {
  const response = await request(cookies.admin, `/api/master-data/${encodeURIComponent(type)}/${encodeURIComponent(code)}`, {
    method: "PATCH",
    body: { version, changes }
  });
  expectStatus(label, response, expectedStatus);
  return response;
}

async function lifecycle(type, code, action, expectedStatus = 200) {
  const route = action === "status"
    ? `/api/master-data/${type}/${encodeURIComponent(code)}/status`
    : `/api/master-data/${type}/${encodeURIComponent(code)}/${action}`;
  const response = await request(cookies.admin, route, {
    method: action === "status" ? "PATCH" : "POST",
    body: action === "status" ? { status: "禁用" } : {}
  });
  expectStatus(`${type} ${code} ${action}`, response, expectedStatus);
  return response;
}

async function setStatus(type, code, status) {
  const response = await request(cookies.admin, `/api/master-data/${type}/${encodeURIComponent(code)}/status`, {
    method: "PATCH",
    body: { status }
  });
  expectStatus(`${type} ${code} status ${status}`, response, 200);
  return response;
}

function setupFixtures() {
  const currentSchema = dbScalar("SELECT current_schema()");
  assert(currentSchema === "public", "A140 只允许在 public 测试账套执行直接数据库准备", { currentSchema });
  const primaryAccount = dbJson(`
    SELECT row_to_json(account_row)::text
    FROM (
      SELECT id::text AS id, code, name, schema_name AS "schemaName", enabled
      FROM public.sys_account_set
      WHERE code = 'BLD-TEST'
    ) account_row
  `);
  assert(primaryAccount?.enabled === true && primaryAccount.schemaName === "public", "BLD-TEST 必须是启用的 public 测试账套", primaryAccount);

  replayTenant = dbJson(`
    SELECT row_to_json(account_row)::text
    FROM (
      SELECT id::text AS id, code, name, schema_name AS "schemaName"
      FROM public.sys_account_set
      WHERE enabled = TRUE
        AND code <> 'BLD-TEST'
        AND code LIKE 'A119%'
        AND schema_name <> 'public'
      ORDER BY CASE WHEN code = 'A119UI' THEN 0 ELSE 1 END, code
      LIMIT 1
    ) account_row
  `);
  assert(replayTenant?.code && replayTenant?.schemaName, "A140 跨账套 token 验收需要一个已存在的 A119 测试账套", replayTenant);
  const replaySchema = sqlIdentifier(replayTenant.schemaName);
  const replaySchemaReady = Number(dbScalar(`
    SELECT count(*)
    FROM information_schema.tables
    WHERE table_schema = ${sqlLiteral(replayTenant.schemaName)}
      AND table_name IN ('md_employee', 'md_financial_account', 'sys_operation_log')
  `));
  assert(replaySchemaReady === 3, "A119 回放账套必须已同步员工、账户和操作日志表", { replayTenant, replaySchemaReady });

  const existing = Number(dbScalar(`
    SELECT (SELECT count(*) FROM public.sys_user WHERE username LIKE ${sqlLiteral(`${userPrefix}%`)})
         + (SELECT count(*) FROM public.md_employee WHERE code LIKE ${sqlLiteral(`${fixturePrefix}%`)})
         + (SELECT count(*) FROM public.md_financial_account WHERE code LIKE ${sqlLiteral(`${fixturePrefix}%`)})
  `));
  assert(existing === 0, "A140 唯一夹具前缀不得已有残留", { existing });

  const values = Object.values(users).map((user) => `(${sqlLiteral(user.username)}, ${sqlLiteral(user.password)}, ${sqlLiteral(user.role)})`).join(",\n");
  const created = Number(dbScalar(`
    BEGIN;
    INSERT INTO public.sys_role (code, name, enabled)
    VALUES (${sqlLiteral(masterRoleCode)}, 'A140 基础资料管理员', TRUE);
    INSERT INTO public.sys_permission (role_id, permission_code, enabled)
    SELECT id, 'master.data.manage', TRUE
    FROM public.sys_role
    WHERE code = ${sqlLiteral(masterRoleCode)};

    CREATE TEMP TABLE a140_users (username text, password text, role_code text) ON COMMIT DROP;
    INSERT INTO a140_users VALUES ${values};

    INSERT INTO public.sys_user (username, display_name, password_hash, enabled, default_account_set_id)
    SELECT fixture.username,
           'A140 ' || fixture.role_code || ' ' || ${sqlLiteral(runId)},
           '{noop}' || fixture.password,
           TRUE,
           account_set.id
    FROM a140_users fixture
    JOIN public.sys_account_set account_set ON account_set.code = 'BLD-TEST' AND account_set.enabled = TRUE;

    INSERT INTO public.sys_user_role (user_id, role_id)
    SELECT app_user.id, role_row.id
    FROM a140_users fixture
    JOIN public.sys_user app_user ON app_user.username = fixture.username
    JOIN public.sys_role role_row ON role_row.code = fixture.role_code AND role_row.enabled = TRUE;

    INSERT INTO public.sys_user_account_set (user_id, account_set_id, role_code, is_default, enabled)
    SELECT app_user.id, account_set.id, fixture.role_code, TRUE, TRUE
    FROM a140_users fixture
    JOIN public.sys_user app_user ON app_user.username = fixture.username
    JOIN public.sys_account_set account_set ON account_set.code = 'BLD-TEST' AND account_set.enabled = TRUE;

    INSERT INTO public.sys_user_account_set (user_id, account_set_id, role_code, is_default, enabled)
    SELECT app_user.id, replay_account.id, fixture.role_code, FALSE, TRUE
    FROM a140_users fixture
    JOIN public.sys_user app_user ON app_user.username = fixture.username
    JOIN public.sys_account_set replay_account ON replay_account.code = ${sqlLiteral(replayTenant.code)} AND replay_account.enabled = TRUE
    WHERE fixture.role_code IN ('ADMIN', 'WAREHOUSE');

    INSERT INTO ${replaySchema}.md_employee (code, name, position, department, enabled, audit_status)
    VALUES (
      ${sqlLiteral(fixtures.employee)},
      ${sqlLiteral(`A140 B 同码员工 ${runId}`)},
      'B账套岗位',
      'B账套部门',
      TRUE,
      'AUDITED'
    );

    INSERT INTO ${replaySchema}.md_financial_account (
      code, name, account_type, bank_name, account_no, account_holder, currency, remark, enabled, audit_status
    ) VALUES (
      ${sqlLiteral(fixtures.accountCash)},
      ${sqlLiteral(`A140 B 同码银行账户 ${runId}`)},
      'BANK',
      'A140 B账套银行',
      ${sqlLiteral(`B0000${compactRunId}`)},
      'A140 B账套户名',
      'USD',
      'B账套隔离数据',
      TRUE,
      'AUDITED'
    );
    COMMIT;

    SELECT (SELECT count(*) FROM public.sys_user WHERE username LIKE ${sqlLiteral(`${userPrefix}%`)})
         + (SELECT count(*) FROM public.sys_user_role role_link JOIN public.sys_user app_user ON app_user.id = role_link.user_id WHERE app_user.username LIKE ${sqlLiteral(`${userPrefix}%`)})
         + (SELECT count(*) FROM public.sys_user_account_set grant_row JOIN public.sys_user app_user ON app_user.id = grant_row.user_id WHERE app_user.username LIKE ${sqlLiteral(`${userPrefix}%`)})
  `));
  assert(created === 14, "A140 必须创建 4 用户、4 角色关系、4 个 A 授权和 2 个 B 授权", { created });
  const grantVersions = dbJson(`
    SELECT jsonb_agg(row_to_json(grant_row) ORDER BY grant_row.account_code, grant_row.username)::text
    FROM (
      SELECT account_set.code AS account_code, app_user.username, grant_row.version, grant_row.employee_code
      FROM public.sys_user_account_set grant_row
      JOIN public.sys_user app_user ON app_user.id = grant_row.user_id
      JOIN public.sys_account_set account_set ON account_set.id = grant_row.account_set_id
      WHERE app_user.username = ${sqlLiteral(users.warehouse.username)}
        AND account_set.code IN ('BLD-TEST', ${sqlLiteral(replayTenant.code)})
    ) grant_row
  `);
  assert(grantVersions?.length === 2 && grantVersions.every((row) => Number(row.version) === 0 && row.employee_code === null), "A/B 目标授权必须从相同 version=0 且未关联状态开始", grantVersions);
  evidence.environment = { primaryAccount, replayTenant, grantVersions, masterRoleCode };
}

async function loginFixtures() {
  cookies.admin = await loginApi(apiBase, users.admin.username, users.admin.password, "BLD-TEST");
  cookies.master = await loginApi(apiBase, users.master.username, users.master.password, "BLD-TEST");
  cookies.finance = await loginApi(apiBase, users.finance.username, users.finance.password, "BLD-TEST");
  cookies.warehouse = await loginApi(apiBase, users.warehouse.username, users.warehouse.password, "BLD-TEST");
}

async function verifyMasterApis() {
  await createMaster("employee", {
    code: fixtures.employee,
    name: `A140 员工 ${runId}`,
    position: "仓储主管",
    department: "供应链部",
    phone: "13814000001",
    email: `${compactRunId}@example.invalid`,
    remark: "A140 员工原备注",
    status: "启用"
  }, "employee create complete fields");
  await createMaster("financialAccount", {
    code: fixtures.accountCash,
    name: `A140 现金账户 ${runId}`,
    accountType: "CASH",
    currency: "CNY",
    remark: "A140 现金原备注",
    status: "启用"
  }, "CASH CNY create");
  const bank = await createMaster("financialAccount", {
    code: fixtures.accountBank,
    name: `A140 美元银行账户 ${runId}`,
    accountType: "BANK",
    bankName: "A140 验收银行",
    accountNo: `0000${compactRunId}`,
    accountHolder: "A140 验收户名",
    currency: "USD",
    remark: "A140 USD BANK"
  }, "BANK USD create");
  assert(bank.accountNo === `0000${compactRunId}` && bank.currency === "USD" && bank.accountType === "BANK", "BANK/USD 必须保留前导零账号", bank);

  const invalidCreates = [
    ["CASH with bank fields", { code: `${fixturePrefix}-IC`, name: "非法现金", accountType: "CASH", currency: "CNY", bankName: "不应允许", accountNo: "001", accountHolder: "不应允许" }],
    ["BANK missing fields", { code: `${fixturePrefix}-IB`, name: "非法银行", accountType: "BANK", currency: "USD" }],
    ["unsupported currency", { code: `${fixturePrefix}-IU`, name: "非法币种", accountType: "CASH", currency: "EUR" }],
    ["unsupported account type", { code: `${fixturePrefix}-IT`, name: "非法类型", accountType: "CARD", currency: "CNY" }]
  ];
  for (const [label, body] of invalidCreates) {
    const response = await request(cookies.admin, "/api/master-data/financialAccount", { method: "POST", body });
    expectStatus(label, response, 400);
    await assertNoRow(cookies.admin, "financial-account-master-list", body.code, `${label} 不得产生账户残留`);
  }

  const cases = [
    { type: "employee", listKey: "employee-master-list", code: fixtures.employee, field: "department", winner: `A140 部门 ${runId}`, loser: `A140 失败部门 ${runId}` },
    { type: "financialAccount", listKey: "financial-account-master-list", code: fixtures.accountCash, field: "name", winner: `A140 现金新名称 ${runId}`, loser: `A140 失败名称 ${runId}` }
  ];
  const methodFailureLogBaseline = Number(dbScalar(`
    SELECT count(*)
    FROM public.sys_operation_log
    WHERE action_code = 'WRITE_FAILED'
      AND actor_username = ${sqlLiteral(users.admin.username)}
      AND target_type = 'http_endpoint'
      AND target_no IN (
        'PUT /api/master-data/{type}/{code}',
        'DELETE /api/master-data/{type}/{code}'
      )
  `));
  const apiCaseEvidence = [];
  for (const fixture of cases) {
    const initial = await exactRow(cookies.admin, fixture.listKey, fixture.code);
    const put = await request(cookies.admin, `/api/master-data/${fixture.type}/${encodeURIComponent(fixture.code)}`, {
      method: "PUT",
      body: { code: fixture.code, name: "旧 PUT 不应写入" }
    });
    expectStatus(`${fixture.type} legacy PUT`, put, 405);
    const afterPut = await exactRow(cookies.admin, fixture.listKey, fixture.code);
    assert(same(afterPut, initial), `${fixture.type} PUT 405 必须零副作用`, { initial, afterPut });

    const deletion = await request(cookies.admin, `/api/master-data/${fixture.type}/${encodeURIComponent(fixture.code)}`, { method: "DELETE" });
    expectStatus(`${fixture.type} DELETE`, deletion, 405);
    const afterDelete = await exactRow(cookies.admin, fixture.listKey, fixture.code);
    assert(same(afterDelete, initial), `${fixture.type} DELETE 405 必须零副作用`, { initial, afterDelete });

    const sparse = await patchMaster(fixture.type, fixture.code, initial.version, { [fixture.field]: fixture.winner }, 200, `${fixture.type} sparse PATCH`);
    assertResponseShape(`${fixture.type} sparse PATCH`, sparse.data, fixture.code, initial.version + 1);
    const afterSparse = await exactRow(cookies.admin, fixture.listKey, fixture.code);
    for (const key of Object.keys(initial)) {
      if ([fixture.field, "version", "updatedAt"].includes(key)) continue;
      assert(same(afterSparse[key], initial[key]), `${fixture.type} sparse PATCH 不得改动省略字段 ${key}`, { before: initial[key], after: afterSparse[key] });
    }
    assert(afterSparse[fixture.field] === fixture.winner, `${fixture.type} sparse PATCH 必须持久化目标字段`, afterSparse);

    const clear = await patchMaster(fixture.type, fixture.code, afterSparse.version, { remark: null }, 200, `${fixture.type} explicit null`);
    assertResponseShape(`${fixture.type} explicit null`, clear.data, fixture.code, afterSparse.version + 1);
    const afterNull = await exactRow(cookies.admin, fixture.listKey, fixture.code);
    assert(afterNull.remark === "", `${fixture.type} 显式 null 必须清空备注`, afterNull);

    const casVersion = afterNull.version;
    const casWinner = await patchMaster(fixture.type, fixture.code, casVersion, { remark: `CAS-WIN-${runId}` }, 200, `${fixture.type} CAS winner`);
    const casLoser = await patchMaster(fixture.type, fixture.code, casVersion, { remark: `CAS-LOSE-${runId}` }, 409, `${fixture.type} CAS stale`);
    const afterCas = await exactRow(cookies.admin, fixture.listKey, fixture.code);
    assert(afterCas.remark === `CAS-WIN-${runId}` && afterCas.version === casWinner.data.version, `${fixture.type} CAS 失败不得覆盖 winner 或递增版本`, afterCas);
    apiCaseEvidence.push({ type: fixture.type, code: fixture.code, put: put.status, delete: deletion.status, sparseVersion: afterSparse.version, nullVersion: afterNull.version, cas: [casWinner.status, casLoser.status], finalVersion: afterCas.version });
  }
  const methodFailureLogs = dbJson(`
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
      'target_no', target_no,
      'failure_reason', failure_reason
    ) ORDER BY operated_at, id), '[]'::jsonb)::text
    FROM public.sys_operation_log
    WHERE action_code = 'WRITE_FAILED'
      AND actor_username = ${sqlLiteral(users.admin.username)}
      AND target_type = 'http_endpoint'
      AND target_no IN (
        'PUT /api/master-data/{type}/{code}',
        'DELETE /api/master-data/{type}/{code}'
      )
  `) ?? [];
  assert(
    methodFailureLogs.length === methodFailureLogBaseline + cases.length * 2,
    "旧 PUT/DELETE 每次 405 必须各写一条统一失败审计",
    { methodFailureLogBaseline, methodFailureLogs }
  );
  const newMethodFailureLogs = methodFailureLogs.slice(methodFailureLogBaseline);
  assert(
    newMethodFailureLogs.filter((row) => row.target_no === "PUT /api/master-data/{type}/{code}").length === cases.length,
    "旧 PUT 405 失败审计数量必须精确",
    newMethodFailureLogs
  );
  assert(
    newMethodFailureLogs.filter((row) => row.target_no === "DELETE /api/master-data/{type}/{code}").length === cases.length,
    "DELETE 405 失败审计数量必须精确",
    newMethodFailureLogs
  );
  assert(
    newMethodFailureLogs.every((row) => row.failure_reason && !row.failure_reason.includes(fixturePrefix)),
    "旧 PUT/DELETE 失败审计必须脱敏且不得包含夹具业务值",
    newMethodFailureLogs
  );
  evidence.methodFailureAudit = newMethodFailureLogs;

  const cashBeforeInvalidPatch = await exactRow(cookies.admin, "financial-account-master-list", fixtures.accountCash);
  const invalidCashPatch = await patchMaster("financialAccount", fixtures.accountCash, cashBeforeInvalidPatch.version, { bankName: "CASH 不得有银行" }, 400, "CASH invalid bank PATCH");
  const cashAfterInvalidPatch = await exactRow(cookies.admin, "financial-account-master-list", fixtures.accountCash);
  assert(same(cashAfterInvalidPatch, cashBeforeInvalidPatch), "CASH 非法银行字段 PATCH 必须整单回滚", { invalidCashPatch: invalidCashPatch.text, cashBeforeInvalidPatch, cashAfterInvalidPatch });

  await createMaster("employee", { code: fixtures.employeeDraft, name: `A140 草稿员工 ${runId}` }, "draft employee create");
  await createMaster("employee", { code: fixtures.employeeDisabled, name: `A140 禁用员工 ${runId}` }, "disabled employee create");
  await createMaster("financialAccount", { code: fixtures.accountDraft, name: `A140 草稿账户 ${runId}`, accountType: "CASH", currency: "CNY" }, "draft account create");
  await createMaster("financialAccount", { code: fixtures.accountDisabled, name: `A140 禁用账户 ${runId}`, accountType: "CASH", currency: "CNY" }, "disabled account create");
  await lifecycle("employee", fixtures.employeeDisabled, "audit");
  await setStatus("employee", fixtures.employeeDisabled, "禁用");
  await lifecycle("financialAccount", fixtures.accountDisabled, "audit");
  await setStatus("financialAccount", fixtures.accountDisabled, "禁用");

  evidence.api = { cases: apiCaseEvidence, bankUsd: bank, conditionalValidation: invalidCreates.map(([label]) => label) };
}

async function verifyPermissions() {
  const expected = {
    admin: Object.fromEntries(listKeys.map((key) => [key, 200])),
    master: Object.fromEntries(listKeys.map((key) => [key, 200])),
    finance: {
      "employee-master-list": 403,
      "employee-master-selector": 403,
      "financial-account-master-list": 200,
      "financial-account-master-selector": 200
    },
    warehouse: Object.fromEntries(listKeys.map((key) => [key, 403]))
  };
  for (const [role, matrix] of Object.entries(expected)) {
    for (const [listKey, status] of Object.entries(matrix)) {
      for (const suffix of ["", "/export.csv"]) {
        const response = await listResponse(cookies[role], listKey, fixturePrefix, suffix);
        const label = `${role} ${listKey}${suffix || "/query"}`;
        expectStatus(label, response, status);
        evidence.permissions.push({ role, listKey, operation: suffix ? "export" : "query", status: response.status });
      }
    }
  }

  const masterWrite = await request(cookies.master, "/api/master-data/employee", {
    method: "POST",
    body: { code: fixtures.masterPermissionEmployee, name: "基础资料管理员可维护员工" }
  });
  expectStatus("master employee write allowed", masterWrite, 201);
  assertResponseShape("master employee write allowed", masterWrite.data, fixtures.masterPermissionEmployee, 0);

  const deniedFinance = await request(cookies.finance, "/api/master-data/financialAccount", {
    method: "POST",
    body: { code: fixtures.forbiddenAccount, name: "财务只读不应创建", accountType: "CASH", currency: "CNY" }
  });
  expectStatus("finance account write denied", deniedFinance, 403);
  const deniedWarehouse = await request(cookies.warehouse, "/api/master-data/employee", {
    method: "POST",
    body: { code: fixtures.forbiddenEmployee, name: "仓库角色不应创建" }
  });
  expectStatus("warehouse employee write denied", deniedWarehouse, 403);
  await assertNoRow(cookies.admin, "financial-account-master-list", fixtures.forbiddenAccount, "财务 403 不得产生账户");
  await assertNoRow(cookies.admin, "employee-master-list", fixtures.forbiddenEmployee, "仓库 403 不得产生员工");

  const unknownKey = `a140-${runId}-employee-master-selector-copy`;
  for (const role of ["admin", "warehouse"]) {
    for (const suffix of ["", "/export.csv"]) {
      const response = await listResponse(cookies[role], unknownKey, fixturePrefix, suffix);
      expectStatus(`${role} unknown selector${suffix || "/query"}`, response, 404);
      assert(!response.text.includes(fixtures.employee), "未知 selector 404 不得泄露真实员工行", response.text.slice(0, 500));
    }
  }
}

async function verifySelectorLifecycle(type, listKey, selectorKey, code) {
  let rows = await listRows(cookies.admin, selectorKey, fixturePrefix);
  assert(!rows.some((row) => row.code === code), `${selectorKey} 审核前不得出现 ${code}`, rows);
  await lifecycle(type, code, "audit");
  rows = await listRows(cookies.admin, selectorKey, fixturePrefix);
  assert(rows.some((row) => row.code === code), `${selectorKey} 审核且启用后必须出现 ${code}`, rows);
  await setStatus(type, code, "禁用");
  rows = await listRows(cookies.admin, selectorKey, fixturePrefix);
  assert(!rows.some((row) => row.code === code), `${selectorKey} 禁用后不得出现 ${code}`, rows);
  await setStatus(type, code, "启用");
  rows = await listRows(cookies.admin, selectorKey, fixturePrefix);
  assert(rows.some((row) => row.code === code), `${selectorKey} 重新启用后必须出现 ${code}`, rows);
  await lifecycle(type, code, "reverse");
  rows = await listRows(cookies.admin, selectorKey, fixturePrefix);
  assert(!rows.some((row) => row.code === code), `${selectorKey} 反审核后不得出现 ${code}`, rows);
  await lifecycle(type, code, "audit");
  rows = await listRows(cookies.admin, selectorKey, fixturePrefix);
  assert(rows.some((row) => row.code === code), `${selectorKey} 重新审核后必须出现 ${code}`, rows);

  const audited = await exactRow(cookies.admin, listKey, code);
  const rejected = await patchMaster(type, code, audited.version, { name: `审核后非法写入 ${runId}` }, 409, `${type} audited PATCH`);
  const unchanged = await exactRow(cookies.admin, listKey, code);
  assert(same(unchanged, audited), `${type} 已审核 PATCH 409 必须零副作用`, { rejected: rejected.text, audited, unchanged });
  return { code, finalVersion: audited.version, finalStatus: audited.status, finalAuditStatus: audited.auditStatus };
}

async function verifySelectors() {
  const employee = await verifySelectorLifecycle("employee", "employee-master-list", "employee-master-selector", fixtures.employee);
  const account = await verifySelectorLifecycle("financialAccount", "financial-account-master-list", "financial-account-master-selector", fixtures.accountCash);
  const employeeRows = await listRows(cookies.admin, "employee-master-selector", fixturePrefix);
  const accountRows = await listRows(cookies.admin, "financial-account-master-selector", fixturePrefix);
  assert(!employeeRows.some((row) => [fixtures.employeeDraft, fixtures.employeeDisabled].includes(row.code)), "员工 selector 必须排除草稿和禁用行", employeeRows);
  assert(!accountRows.some((row) => [fixtures.accountDraft, fixtures.accountDisabled, fixtures.accountBank].includes(row.code)), "账户 selector 必须排除草稿、禁用和未审核 BANK 行", accountRows);
  evidence.selectors = {
    employee,
    account,
    employeeCodes: employeeRows.map((row) => row.code),
    accountCodes: accountRows.map((row) => row.code)
  };
}

async function tenantMasterSnapshot(cookie, expected) {
  const employeeList = await exactRow(cookie, "employee-master-list", fixtures.employee);
  const employeeSelector = await exactRow(cookie, "employee-master-selector", fixtures.employee);
  const accountList = await exactRow(cookie, "financial-account-master-list", fixtures.accountCash);
  const accountSelector = await exactRow(cookie, "financial-account-master-selector", fixtures.accountCash);
  for (const [label, row] of Object.entries({ employeeList, employeeSelector })) {
    assert(row?.name === expected.employee.name, `${expected.tenant} ${label} 必须返回当前 tenant 的员工名称`, { expected, row });
    assert(row?.position === expected.employee.position && row?.department === expected.employee.department, `${expected.tenant} ${label} 必须返回当前 tenant 的员工字段`, { expected, row });
    assert(row?.auditStatus === "已审核" && row?.status === "启用", `${expected.tenant} ${label} 员工必须是已审核且启用`, row);
  }
  for (const [label, row] of Object.entries({ accountList, accountSelector })) {
    assert(row?.name === expected.account.name, `${expected.tenant} ${label} 必须返回当前 tenant 的账户名称`, { expected, row });
    assert(row?.accountType === expected.account.accountType && row?.currency === expected.account.currency, `${expected.tenant} ${label} 必须返回当前 tenant 的账户类型和币种`, { expected, row });
    assert(row?.accountNo === expected.account.accountNo, `${expected.tenant} ${label} 必须返回当前 tenant 的账号字符串`, { expected, row });
    assert(row?.auditStatus === "已审核" && row?.status === "启用", `${expected.tenant} ${label} 账户必须是已审核且启用`, row);
  }
  return { employeeList, employeeSelector, accountList, accountSelector };
}

async function verifyTenantIsolation() {
  const expectedA = {
    tenant: "BLD-TEST",
    employee: { name: `A140 员工 ${runId}`, position: "仓储主管", department: `A140 部门 ${runId}` },
    account: { name: `A140 现金新名称 ${runId}`, accountType: "CASH", currency: "CNY", accountNo: "" }
  };
  const expectedB = {
    tenant: replayTenant.code,
    employee: { name: `A140 B 同码员工 ${runId}`, position: "B账套岗位", department: "B账套部门" },
    account: { name: `A140 B 同码银行账户 ${runId}`, accountType: "BANK", currency: "USD", accountNo: `B0000${compactRunId}` }
  };

  const initialA = await tenantMasterSnapshot(cookies.admin, expectedA);
  await switchAccount(cookies.admin, replayTenant.code);
  const currentB = await tenantMasterSnapshot(cookies.admin, expectedB);
  assert(currentB.employeeList.name !== initialA.employeeList.name && currentB.accountList.name !== initialA.accountList.name, "A/B 同码员工与账户必须具有可辨别的不同数据", { initialA, currentB });
  await switchAccount(cookies.admin, "BLD-TEST");
  const returnedA = await tenantMasterSnapshot(cookies.admin, expectedA);
  assert(same(returnedA, initialA), "切回 A 后 list/selector 必须恢复 A 数据且不得残留 B 字段", { initialA, returnedA });
  evidence.tenantIsolation = { expectedA, expectedB, initialA, currentB, returnedA };
}

function grantState() {
  return dbJson(`
    SELECT jsonb_agg(row_to_json(grant_row) ORDER BY grant_row.account_code)::text
    FROM (
      SELECT account_set.code AS account_code,
             grant_row.version,
             grant_row.enabled,
             COALESCE(grant_row.employee_code, '') AS employee_code
      FROM public.sys_user_account_set grant_row
      JOIN public.sys_user app_user ON app_user.id = grant_row.user_id
      JOIN public.sys_account_set account_set ON account_set.id = grant_row.account_set_id
      WHERE app_user.username = ${sqlLiteral(users.warehouse.username)}
        AND account_set.code IN ('BLD-TEST', ${sqlLiteral(replayTenant.code)})
    ) grant_row
  `);
}

function replayLogCounts() {
  const replaySchema = sqlIdentifier(replayTenant.schemaName);
  const target = `${users.warehouse.username}:${fixtures.employee}`;
  return {
    primary: Number(dbScalar(`SELECT count(*) FROM public.sys_operation_log WHERE target_no = ${sqlLiteral(target)}`)),
    replay: Number(dbScalar(`SELECT count(*) FROM ${replaySchema}.sys_operation_log WHERE target_no = ${sqlLiteral(target)}`))
  };
}

function linkRow(payload, username = users.warehouse.username) {
  return payload?.employeeLinks?.find((row) => row.username === username) ?? null;
}

async function switchAccount(cookie, accountSetCode) {
  const response = await request(cookie, "/api/system/account-sets/current", { method: "POST", body: { accountSetCode } });
  expectStatus(`switch account set ${accountSetCode}`, response, 200);
  assert(response.data?.current?.code === accountSetCode, `当前账套必须切换为 ${accountSetCode}`, response.data);
}

async function verifyEmployeeLink() {
  const linksA = await request(cookies.admin, "/api/system/current-account-employee-links");
  expectStatus("employee links A", linksA, 200);
  const rowA = linkRow(linksA.data);
  assert(rowA && rowA.grantVersion === 0 && typeof rowA.scopeToken === "string" && rowA.scopeToken, "A 账套关联行必须返回 version=0 和 scopeToken", rowA);

  const beforeRoundTripGrant = grantState();
  const beforeRoundTripLogs = replayLogCounts();
  await switchAccount(cookies.admin, replayTenant.code);
  await switchAccount(cookies.admin, "BLD-TEST");
  const roundTripReplay = await request(cookies.admin, `/api/system/current-account-employee-links/${encodeURIComponent(users.warehouse.username)}`, {
    method: "PUT",
    body: { employeeCode: fixtures.employee, version: 0, scopeToken: rowA.scopeToken }
  });
  expectStatus("A token after A-B-A round trip without intermediate link request", roundTripReplay, 409);
  const afterRoundTripGrant = grantState();
  const afterRoundTripLogs = replayLogCounts();
  assert(same(afterRoundTripGrant, beforeRoundTripGrant), "A→B→A 中间零关联请求时旧 token 不得写入任一账套授权", { beforeRoundTripGrant, afterRoundTripGrant });
  assert(same(afterRoundTripLogs, beforeRoundTripLogs), "A→B→A 中间零关联请求时旧 token 不得写入任一账套日志", { beforeRoundTripLogs, afterRoundTripLogs });

  const refreshedAfterRoundTrip = await request(cookies.admin, "/api/system/current-account-employee-links");
  expectStatus("employee links refreshed after A-B-A", refreshedAfterRoundTrip, 200);
  const rowAfterRoundTrip = linkRow(refreshedAfterRoundTrip.data);
  assert(rowAfterRoundTrip && rowAfterRoundTrip.scopeToken !== rowA.scopeToken && rowAfterRoundTrip.grantVersion === 0, "A→B→A 后 scopeToken 必须轮换且 grant version 保持 0", { before: rowA, after: rowAfterRoundTrip });

  const beforeReplayGrant = grantState();
  const beforeReplayLogs = replayLogCounts();
  await switchAccount(cookies.admin, replayTenant.code);
  const replay = await request(cookies.admin, `/api/system/current-account-employee-links/${encodeURIComponent(users.warehouse.username)}`, {
    method: "PUT",
    body: { employeeCode: fixtures.employee, version: 0, scopeToken: rowAfterRoundTrip.scopeToken }
  });
  expectStatus("A token replayed after switch to B", replay, 409);
  const afterReplayGrant = grantState();
  const afterReplayLogs = replayLogCounts();
  assert(same(afterReplayGrant, beforeReplayGrant), "A→B 同版本旧 token 重放不得写入任一账套授权", { beforeReplayGrant, afterReplayGrant });
  assert(same(afterReplayLogs, beforeReplayLogs), "A→B 同版本旧 token 重放不得写入任一账套日志", { beforeReplayLogs, afterReplayLogs });

  await switchAccount(cookies.admin, "BLD-TEST");
  const refreshedLinks = await request(cookies.admin, "/api/system/current-account-employee-links");
  expectStatus("employee links refreshed A", refreshedLinks, 200);
  let current = linkRow(refreshedLinks.data);
  assert(current && current.scopeToken !== rowAfterRoundTrip.scopeToken && current.grantVersion === 0, "切回 A 后 scopeToken 必须再次轮换且 grant version 保持 0", { before: rowAfterRoundTrip, after: current });

  const extraField = await request(cookies.admin, `/api/system/current-account-employee-links/${encodeURIComponent(users.warehouse.username)}`, {
    method: "PUT",
    body: { employeeCode: fixtures.employee, version: current.grantVersion, scopeToken: current.scopeToken, accountSetCode: "BLD-TEST" }
  });
  expectStatus("employee link rejects accountSetCode", extraField, 400);
  assert(same(grantState(), beforeReplayGrant), "accountSetCode 400 必须零授权副作用", grantState());

  const link = await request(cookies.admin, `/api/system/current-account-employee-links/${encodeURIComponent(users.warehouse.username)}`, {
    method: "PUT",
    body: { employeeCode: fixtures.employee, version: current.grantVersion, scopeToken: current.scopeToken }
  });
  expectStatus("employee link", link, 200);
  current = linkRow(link.data);
  assert(current?.employeeCode === fixtures.employee && current?.grantVersion === 1 && current?.employeeName, "合法关联必须返回员工快照并递增版本", current);

  const staleUnlink = await request(cookies.admin, `/api/system/current-account-employee-links/${encodeURIComponent(users.warehouse.username)}`, {
    method: "PUT",
    body: { employeeCode: null, version: 0, scopeToken: current.scopeToken }
  });
  expectStatus("employee stale unlink", staleUnlink, 409);
  assert(grantState().find((row) => row.account_code === "BLD-TEST")?.employee_code === fixtures.employee, "stale unlink 不得解除现有关联", grantState());

  const unlink = await request(cookies.admin, `/api/system/current-account-employee-links/${encodeURIComponent(users.warehouse.username)}`, {
    method: "PUT",
    body: { employeeCode: null, version: current.grantVersion, scopeToken: current.scopeToken }
  });
  expectStatus("employee unlink", unlink, 200);
  current = linkRow(unlink.data);
  assert(current?.employeeCode === "" && current?.grantVersion === 2, "合法解除关联必须清空员工并递增版本", current);

  for (const code of [fixtures.employeeDraft, fixtures.employeeDisabled]) {
    const rejected = await request(cookies.admin, `/api/system/current-account-employee-links/${encodeURIComponent(users.warehouse.username)}`, {
      method: "PUT",
      body: { employeeCode: code, version: current.grantVersion, scopeToken: current.scopeToken }
    });
    expectStatus(`reject unselectable employee ${code}`, rejected, 409);
    const state = grantState().find((row) => row.account_code === "BLD-TEST");
    assert(state?.employee_code === "" && state?.version === 2, "草稿或禁用员工关联失败必须零副作用", state);
  }

  evidence.employeeLink = {
    zeroRequestRoundTrip: { status: roundTripReplay.status, beforeRoundTripGrant, afterRoundTripGrant, beforeRoundTripLogs, afterRoundTripLogs },
    crossAccountReplay: { status: replay.status, beforeReplayGrant, afterReplayGrant, beforeReplayLogs, afterReplayLogs },
    extraAccountSetCodeStatus: extraField.status,
    linkStatus: link.status,
    staleUnlinkStatus: staleUnlink.status,
    unlinkStatus: unlink.status,
    finalApiRow: current
  };
}

async function browserWaitForWrite(page, method, pathname, click) {
  const responsePromise = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return response.request().method() === method && url.pathname === pathname;
  });
  await click();
  const response = await responsePromise;
  const text = await response.text();
  assert(response.status() >= 200 && response.status() < 300, `浏览器 ${method} ${pathname} 必须成功`, { status: response.status(), text: text.slice(0, 500) });
  return { status: response.status(), text };
}

async function settleBrowserPaint(page) {
  await page.evaluate(() => new Promise((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(resolve));
  }));
  await page.waitForTimeout(100);
}

async function captureEvidenceScreenshot(page, screenshotName) {
  const rawScreenshot = await page.screenshot({ type: "jpeg", quality: 95, fullPage: false });
  const normalizedBase64 = await page.evaluate(async (encoded) => {
    const image = new Image();
    image.src = `data:image/jpeg;base64,${encoded}`;
    await image.decode();
    const canvas = document.createElement("canvas");
    canvas.width = image.naturalWidth;
    canvas.height = image.naturalHeight;
    const context = canvas.getContext("2d", { alpha: false });
    if (!context) {
      throw new Error("browser screenshot canvas context unavailable");
    }
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(image, 0, 0);
    return canvas.toDataURL("image/jpeg", 0.95).split(",", 2)[1];
  }, rawScreenshot.toString("base64"));
  await writeFile(path.join(screenshotDir, screenshotName), Buffer.from(normalizedBase64, "base64"));
}

async function openEntry(page, moduleName, entryId) {
  await page.getByTestId(`module-${moduleName}`).hover();
  await page.getByTestId(`entry-${entryId}`).click();
}

async function createBrowserMaster(page, fixture) {
  await openEntry(page, "基础资料", fixture.listKey);
  await page.getByTestId(`list-page-${fixture.listKey}`).waitFor({ state: "visible" });
  await page.getByTestId("list-create").click();
  await page.getByTestId("master-record-page").waitFor({ state: "visible" });
  assert(await page.getByTestId("master-record-delete").count() === 0, `${fixture.type} 新增页不得出现删除动作`);
  assert(await page.getByTestId("master-record-bottom-delete").count() === 0, `${fixture.type} 新增页底部不得出现删除动作`);

  await page.getByTestId("master-record-code").fill(fixture.code);
  await page.getByTestId("master-record-name").fill(fixture.name);
  if (fixture.type === "employee") {
    await page.getByTestId("master-record-position").fill("A140 UI 仓管员");
    await page.getByTestId("master-record-department").fill("A140 UI 部门");
    await page.getByTestId("master-record-remark").fill("A140 UI 员工原备注");
  } else {
    assert(!(await page.getByTestId("master-record-bankName").isVisible().catch(() => false)), "CASH 默认态不得显示开户行字段");
    await page.getByTestId("master-record-accountType").selectOption("BANK");
    assert(await page.getByTestId("master-record-bankName").isVisible(), "BANK 必须显示开户行字段");
    assert(await page.getByTestId("master-record-accountNo").isVisible(), "BANK 必须显示账号字段");
    assert(await page.getByTestId("master-record-accountHolder").isVisible(), "BANK 必须显示户名字段");
    await page.getByTestId("master-record-bankName").fill("A140 UI 银行");
    await page.getByTestId("master-record-accountNo").fill(fixture.accountNo);
    await page.getByTestId("master-record-accountHolder").fill("A140 UI 户名");
    await page.getByTestId("master-record-currency").selectOption("USD");
    await page.getByTestId("master-record-remark").fill("A140 UI 账户原备注");
  }

  const create = await browserWaitForWrite(page, "POST", `/api/master-data/${fixture.type}`, () => page.getByTestId("master-record-save").click());
  await page.getByTestId("master-record-remark").fill(`A140 UI 编辑后 ${runId}`);
  const patch = await browserWaitForWrite(page, "PATCH", `/api/master-data/${fixture.type}/${fixture.code}`, () => page.getByTestId("master-record-save").click());
  const audit = await browserWaitForWrite(page, "POST", `/api/master-data/${fixture.type}/${fixture.code}/audit`, () => page.getByTestId("master-record-audit").click());
  await page.getByTestId("document-status").filter({ hasText: "已审核" }).waitFor({ state: "visible" });
  const reverse = await browserWaitForWrite(page, "POST", `/api/master-data/${fixture.type}/${fixture.code}/reverse`, () => page.getByTestId("master-record-reverse-audit").click());
  const disable = await browserWaitForWrite(page, "PATCH", `/api/master-data/${fixture.type}/${fixture.code}/status`, () => page.getByTestId("master-record-toggle-status").click());
  await page.getByTestId("document-status").filter({ hasText: "禁用" }).waitFor({ state: "visible" });
  const enable = await browserWaitForWrite(page, "PATCH", `/api/master-data/${fixture.type}/${fixture.code}/status`, () => page.getByTestId("master-record-toggle-status").click());
  const finalAudit = await browserWaitForWrite(page, "POST", `/api/master-data/${fixture.type}/${fixture.code}/audit`, () => page.getByTestId("master-record-audit").click());

  await page.getByTestId("master-record-cancel").click();
  await page.getByTestId(`list-page-${fixture.listKey}`).waitFor({ state: "visible" });
  await page.getByTestId("list-keyword").fill(fixture.code);
  await page.getByTestId("list-keyword").press("Enter");
  await page.getByTestId(`open-master-${fixture.code}`).waitFor({ state: "visible" });
  await page.getByTestId("list-more-actions").hover();
  assert(await page.getByTestId("batch-delete").count() === 0, `${fixture.type} 列表更多菜单不得出现批量删除动作`);
  await page.getByTestId(`open-master-${fixture.code}`).click();
  await page.getByTestId("master-record-page").waitFor({ state: "visible" });
  assert(await page.getByTestId("master-record-delete").count() === 0, `${fixture.type} 查看页不得出现删除动作`);
  assert(await page.getByTestId("master-record-bottom-delete").count() === 0, `${fixture.type} 查看页底部不得出现删除动作`);
  assert(await page.getByTestId("master-record-code").inputValue() === fixture.code, `${fixture.type} 查看页必须打开真实保存记录`);
  assert((await page.getByTestId("document-status").innerText()).includes("已审核"), `${fixture.type} 查看页必须显示最终已审核状态`);
  if (fixture.type === "financialAccount") {
    assert(await page.getByTestId("master-record-accountNo").inputValue() === fixture.accountNo, "账户查看页必须保留账号前导零");
    assert(await page.getByTestId("master-record-currency").inputValue() === "USD", "账户查看页必须保留 USD");
  }

  const screenshotName = `a140-${fixture.type}-${fixture.viewport.width}x${fixture.viewport.height}-${runId}.jpg`;
  await captureEvidenceScreenshot(page, screenshotName);
  evidence.screenshots.push(`verification/playwright/${screenshotName}`);
  return { type: fixture.type, code: fixture.code, viewport: fixture.viewport, create: create.status, patch: patch.status, lifecycle: [audit.status, reverse.status, disable.status, enable.status, finalAudit.status], screenshot: `verification/playwright/${screenshotName}` };
}

async function logoutBrowserPage(page) {
  await page.evaluate(async () => {
    await fetch("/api/system/logout", { method: "POST" }).catch(() => null);
  }).catch(() => null);
}

async function verifyBrowser() {
  browser = await chromium.launch({ headless: true, args: ["--disable-gpu"] });
  const browserFixtures = [
    { type: "employee", listKey: "employee-master-list", code: fixtures.uiEmployee, name: `A140 UI 员工 ${runId}`, viewport: { width: 1366, height: 768 } },
    { type: "financialAccount", listKey: "financial-account-master-list", code: fixtures.uiAccount, name: `A140 UI 账户 ${runId}`, accountNo: `00000${compactRunId}`, viewport: { width: 1920, height: 1080 } }
  ];

  for (const fixture of browserFixtures) {
    const context = await browser.newContext({ viewport: fixture.viewport });
    const page = await context.newPage();
    try {
      await page.goto(frontendUrl, { waitUntil: "domcontentloaded" });
      await loginAs(page, users.admin.username, users.admin.password, "系统管理员", "BLD-TEST");
      evidence.browser.push(await createBrowserMaster(page, fixture));

      if (fixture.type === "financialAccount") {
        await page.getByTestId("master-record-cancel").click();
        await openEntry(page, "系统设置", "user-role-list");
        await page.getByTestId(`managed-user-${users.warehouse.username}`).waitFor({ state: "visible" });
        await page.getByTestId(`managed-user-${users.warehouse.username}`).click();
        await page.getByTestId("current-account-employee-link").waitFor({ state: "visible" });
        assert(await page.getByTestId("managed-user-employee-empty").isVisible(), "UI 关联前目标用户必须未关联员工");
        await page.getByTestId("managed-user-employee-select").click();
        await page.getByTestId("master-selector-source-selector-dialog").waitFor({ state: "visible" });
        await page.getByTestId("master-selector-source-selector-search").fill(fixtures.uiEmployee);
        await page.getByTestId("master-selector-source-selector-query").click();
        await page.getByTestId(`master-selector-source-line-${fixtures.uiEmployee}`).waitFor({ state: "visible" });
        await page.getByTestId(`master-selector-source-line-${fixtures.uiEmployee}`).click();
        await page.getByTestId("master-selector-source-selector-dialog").waitFor({ state: "hidden" });
        await page.getByTestId("managed-user-employee-candidate").filter({ hasText: fixtures.uiEmployee }).waitFor({ state: "visible" });

        let linkRequestBody = null;
        page.on("request", (browserRequest) => {
          const url = new URL(browserRequest.url());
          if (browserRequest.method() === "PUT" && url.pathname === `/api/system/current-account-employee-links/${users.warehouse.username}`) {
            linkRequestBody = browserRequest.postDataJSON();
          }
        });
        const linkResponse = await browserWaitForWrite(page, "PUT", `/api/system/current-account-employee-links/${users.warehouse.username}`, () => page.getByTestId("managed-user-employee-link").click());
        assert(same(Object.keys(linkRequestBody ?? {}).sort(), ["employeeCode", "scopeToken", "version"]), "UI 员工关联请求必须且只能提交 employeeCode/version/scopeToken", linkRequestBody);
        assert(linkRequestBody.employeeCode === fixtures.uiEmployee && typeof linkRequestBody.scopeToken === "string" && linkRequestBody.scopeToken, "UI 员工关联必须提交真实员工与 scopeToken", linkRequestBody);
        await page.getByTestId("managed-user-employee-code").filter({ hasText: fixtures.uiEmployee }).waitFor({ state: "visible" });
        await settleBrowserPaint(page);
        const linkScreenshot = `a140-employee-link-1920x1080-${runId}.jpg`;
        await captureEvidenceScreenshot(page, linkScreenshot);
        evidence.screenshots.push(`verification/playwright/${linkScreenshot}`);
        const unlinkResponse = await browserWaitForWrite(page, "PUT", `/api/system/current-account-employee-links/${users.warehouse.username}`, () => page.getByTestId("managed-user-employee-unlink").click());
        await page.getByTestId("managed-user-employee-empty").waitFor({ state: "visible" });
        evidence.employeeLink.browser = { linkStatus: linkResponse.status, unlinkStatus: unlinkResponse.status, requestBodyKeys: Object.keys(linkRequestBody).sort(), screenshot: `verification/playwright/${linkScreenshot}` };
      }
      await logoutBrowserPage(page);
    } finally {
      await context.close();
    }
  }
}

async function verifyBrowserPermissions() {
  const cases = [
    { role: "master", expectedRole: "A140 基础资料管理员" },
    { role: "finance", expectedRole: "财务员" },
    { role: "warehouse", expectedRole: "仓库员" }
  ];
  for (const permissionCase of cases) {
    const context = await browser.newContext({ viewport: { width: 1366, height: 768 } });
    const page = await context.newPage();
    try {
      const user = users[permissionCase.role];
      await page.goto(frontendUrl, { waitUntil: "domcontentloaded" });
      await loginAs(page, user.username, user.password, permissionCase.expectedRole, "BLD-TEST");
      await page.getByTestId("module-基础资料").hover();
      await page.getByTestId("module-panel").waitFor({ state: "visible" });
      const employeeEntry = page.getByTestId("entry-employee-master-list");
      const accountEntry = page.getByTestId("entry-financial-account-master-list");
      const employeeEntryVisible = await employeeEntry.isVisible().catch(() => false);
      const accountEntryVisible = await accountEntry.isVisible().catch(() => false);

      if (permissionCase.role === "warehouse") {
        assert(await employeeEntry.count() === 0, "仓库角色菜单不得显示员工主档入口");
        assert(await accountEntry.count() === 0, "仓库角色菜单不得显示账户资料入口");
      } else if (permissionCase.role === "finance") {
        assert(await employeeEntry.count() === 0, "财务角色菜单不得显示员工主档入口");
        assert(await accountEntry.isVisible(), "财务角色菜单必须显示账户资料只读入口");
        await accountEntry.click();
        await page.getByTestId("list-page-financial-account-master-list").waitFor({ state: "visible" });
        for (const actionId of ["list-create", "master-edit", "master-audit", "master-reverse-audit", "master-enable", "master-disable"]) {
          assert(await page.getByTestId(actionId).isDisabled(), `财务角色 ${actionId} 必须禁用`);
        }
      } else {
        assert(await employeeEntry.isVisible(), "基础资料管理员菜单必须显示员工主档入口");
        assert(await accountEntry.isVisible(), "基础资料管理员菜单必须显示账户资料入口");
        await employeeEntry.click();
        await page.getByTestId("list-page-employee-master-list").waitFor({ state: "visible" });
        assert(await page.getByTestId("list-create").isEnabled(), "基础资料管理员必须可新增员工");
        await openEntry(page, "基础资料", "financial-account-master-list");
        await page.getByTestId("list-page-financial-account-master-list").waitFor({ state: "visible" });
        assert(await page.getByTestId("list-create").isEnabled(), "基础资料管理员必须可新增账户资料");
      }

      await settleBrowserPaint(page);
      const screenshot = `a140-permission-${permissionCase.role}-1366x768-${runId}.jpg`;
      await captureEvidenceScreenshot(page, screenshot);
      evidence.screenshots.push(`verification/playwright/${screenshot}`);
      evidence.permissionBrowser.push({
        role: permissionCase.role,
        employeeEntryVisible,
        accountEntryVisible,
        screenshot: `verification/playwright/${screenshot}`
      });
      await logoutBrowserPage(page);
    } finally {
      await context.close();
    }
  }
}

async function verifyGrantRevocation() {
  cookies.admin = await loginApi(apiBase, users.admin.username, users.admin.password, "BLD-TEST");
  const beforeLinks = await request(cookies.admin, "/api/system/current-account-employee-links");
  expectStatus("grant revocation current links", beforeLinks, 200);
  const before = linkRow(beforeLinks.data);
  assert(before?.scopeToken && Number.isInteger(before.grantVersion), "撤销授权前必须取得仓库用户的当前 scope/version", before);

  const linked = await request(cookies.admin, `/api/system/current-account-employee-links/${encodeURIComponent(users.warehouse.username)}`, {
    method: "PUT",
    body: { employeeCode: fixtures.employee, version: before.grantVersion, scopeToken: before.scopeToken }
  });
  expectStatus("grant revocation pre-link", linked, 200);
  const linkedRow = linkRow(linked.data);
  assert(linkedRow?.employeeCode === fixtures.employee && linkedRow.grantVersion === before.grantVersion + 1, "撤销授权前员工关联必须成功", linkedRow);

  const revoke = await request(cookies.admin, `/api/system/managed-users/${encodeURIComponent(users.warehouse.username)}/account-sets`, {
    method: "PUT",
    body: { accountSetCodes: [replayTenant.code], defaultAccountSetCode: replayTenant.code }
  });
  expectStatus("revoke linked BLD-TEST grant", revoke, 200);
  const revokedGrant = grantState().find((row) => row.account_code === "BLD-TEST");
  assert(revokedGrant?.enabled === false && revokedGrant.employee_code === "", "撤销账套授权必须同步释放员工唯一关联", revokedGrant);
  const revokeAuditCount = Number(dbScalar(`
    SELECT count(*)
    FROM public.sys_operation_log
    WHERE action_code = 'UNLINK_EMPLOYEE_ACCOUNT'
      AND target_no = ${sqlLiteral(`${users.warehouse.username}:${fixtures.employee}`)}
      AND failure_reason = ${sqlLiteral(`employeeCode=${fixtures.employee};source=grant_revoked`)}
  `));
  assert(revokeAuditCount === 1, "撤销账套授权必须精确写一条带来源的租户解除关联审计", { revokeAuditCount });

  const replacementLinks = await request(cookies.admin, "/api/system/current-account-employee-links");
  expectStatus("grant revocation replacement links", replacementLinks, 200);
  const replacementBefore = linkRow(replacementLinks.data, users.master.username);
  assert(replacementBefore?.scopeToken && replacementBefore.employeeCode === "", "释放后基础资料管理员账号必须可作为替代关联目标", replacementBefore);
  const replacement = await request(cookies.admin, `/api/system/current-account-employee-links/${encodeURIComponent(users.master.username)}`, {
    method: "PUT",
    body: { employeeCode: fixtures.employee, version: replacementBefore.grantVersion, scopeToken: replacementBefore.scopeToken }
  });
  expectStatus("reuse employee after grant revocation", replacement, 200);
  const replacementAfter = linkRow(replacement.data, users.master.username);
  assert(replacementAfter?.employeeCode === fixtures.employee, "旧授权撤销后同一员工必须可关联另一账号", replacementAfter);
  evidence.employeeLink.grantRevocation = {
    revokeStatus: revoke.status,
    revokedGrant,
    revokeAuditCount,
    replacementStatus: replacement.status,
    replacementUser: users.master.username
  };
}

function captureAuditTrail() {
  const rows = dbJson(`
    SELECT COALESCE(jsonb_agg(row_to_json(log_row) ORDER BY log_row.operated_at), '[]'::jsonb)::text
    FROM (
      SELECT action_code, target_type, target_no, actor_username, account_set_code, success, operated_at
      FROM public.sys_operation_log
      WHERE actor_username LIKE ${sqlLiteral(`${userPrefix}%`)}
         OR target_no LIKE ${sqlLiteral(`${fixturePrefix}%`)}
         OR target_no LIKE ${sqlLiteral(`${userPrefix}%`)}
    ) log_row
  `) ?? [];
  const actions = new Set(rows.map((row) => row.action_code));
  for (const required of ["CREATE_MASTER_DATA", "PATCH_MASTER_DATA", "AUDIT_MASTER_DATA", "REVERSE_MASTER_DATA", "DISABLE_MASTER_DATA", "ENABLE_MASTER_DATA", "LINK_EMPLOYEE_ACCOUNT", "UNLINK_EMPLOYEE_ACCOUNT"]) {
    assert(actions.has(required), `A140 操作日志必须包含 ${required}`, rows);
  }
  evidence.auditTrail = rows;
}

async function logoutApiSessions() {
  await Promise.all(Object.values(cookies).map((cookie) => fetch(`${apiBase}/api/system/logout`, { method: "POST", headers: { Cookie: cookie } }).catch(() => null)));
}

function cleanupFixtures() {
  evidence.cleanup.attempted = true;
  const replaySchema = replayTenant?.schemaName ? sqlIdentifier(replayTenant.schemaName) : null;
  if (replaySchema) {
    dbScalar(`
      BEGIN;
      DELETE FROM ${replaySchema}.sys_operation_log
      WHERE actor_username LIKE ${sqlLiteral(`${userPrefix}%`)}
         OR target_no LIKE ${sqlLiteral(`${fixturePrefix}%`)}
         OR target_no LIKE ${sqlLiteral(`${userPrefix}%`)};
      DELETE FROM ${replaySchema}.md_financial_account WHERE code LIKE ${sqlLiteral(`${fixturePrefix}%`)};
      DELETE FROM ${replaySchema}.md_employee WHERE code LIKE ${sqlLiteral(`${fixturePrefix}%`)};
      COMMIT;
    `);
  }
  dbScalar(`
    BEGIN;
    DELETE FROM public.sys_operation_log
    WHERE actor_username LIKE ${sqlLiteral(`${userPrefix}%`)}
       OR target_no LIKE ${sqlLiteral(`${fixturePrefix}%`)}
       OR target_no LIKE ${sqlLiteral(`${userPrefix}%`)}
       OR COALESCE(failure_reason, '') LIKE ${sqlLiteral(`%${fixturePrefix}%`)};
    DELETE FROM public.sys_user_account_set
    WHERE user_id IN (SELECT id FROM public.sys_user WHERE username LIKE ${sqlLiteral(`${userPrefix}%`)});
    DELETE FROM public.sys_user_role
    WHERE user_id IN (SELECT id FROM public.sys_user WHERE username LIKE ${sqlLiteral(`${userPrefix}%`)});
    DELETE FROM public.sys_user WHERE username LIKE ${sqlLiteral(`${userPrefix}%`)};
    DELETE FROM public.sys_permission
    WHERE role_id IN (SELECT id FROM public.sys_role WHERE code = ${sqlLiteral(masterRoleCode)});
    DELETE FROM public.sys_role WHERE code = ${sqlLiteral(masterRoleCode)};
    DELETE FROM public.md_financial_account WHERE code LIKE ${sqlLiteral(`${fixturePrefix}%`)};
    DELETE FROM public.md_employee WHERE code LIKE ${sqlLiteral(`${fixturePrefix}%`)};
    COMMIT;
  `);

  const remaining = {
    users: Number(dbScalar(`SELECT count(*) FROM public.sys_user WHERE username LIKE ${sqlLiteral(`${userPrefix}%`)}`)),
    roles: Number(dbScalar(`SELECT count(*) FROM public.sys_user_role role_link JOIN public.sys_user app_user ON app_user.id = role_link.user_id WHERE app_user.username LIKE ${sqlLiteral(`${userPrefix}%`)}`)),
    grants: Number(dbScalar(`SELECT count(*) FROM public.sys_user_account_set grant_row JOIN public.sys_user app_user ON app_user.id = grant_row.user_id WHERE app_user.username LIKE ${sqlLiteral(`${userPrefix}%`)}`)),
    employees: Number(dbScalar(`SELECT count(*) FROM public.md_employee WHERE code LIKE ${sqlLiteral(`${fixturePrefix}%`)}`)),
    accounts: Number(dbScalar(`SELECT count(*) FROM public.md_financial_account WHERE code LIKE ${sqlLiteral(`${fixturePrefix}%`)}`)),
    logs: Number(dbScalar(`SELECT count(*) FROM public.sys_operation_log WHERE actor_username LIKE ${sqlLiteral(`${userPrefix}%`)} OR target_no LIKE ${sqlLiteral(`${fixturePrefix}%`)} OR target_no LIKE ${sqlLiteral(`${userPrefix}%`)}`)),
    replayEmployees: replaySchema ? Number(dbScalar(`SELECT count(*) FROM ${replaySchema}.md_employee WHERE code LIKE ${sqlLiteral(`${fixturePrefix}%`)}`)) : 0,
    replayAccounts: replaySchema ? Number(dbScalar(`SELECT count(*) FROM ${replaySchema}.md_financial_account WHERE code LIKE ${sqlLiteral(`${fixturePrefix}%`)}`)) : 0,
    replayLogs: replaySchema ? Number(dbScalar(`SELECT count(*) FROM ${replaySchema}.sys_operation_log WHERE actor_username LIKE ${sqlLiteral(`${userPrefix}%`)} OR target_no LIKE ${sqlLiteral(`${fixturePrefix}%`)} OR target_no LIKE ${sqlLiteral(`${userPrefix}%`)}`)) : 0,
    customRoles: Number(dbScalar(`SELECT count(*) FROM public.sys_role WHERE code = ${sqlLiteral(masterRoleCode)}`)),
    customRolePermissions: Number(dbScalar(`SELECT count(*) FROM public.sys_permission permission_row JOIN public.sys_role role_row ON role_row.id = permission_row.role_id WHERE role_row.code = ${sqlLiteral(masterRoleCode)}`))
  };
  evidence.cleanup.remaining = remaining;
  assert(Object.values(remaining).every((value) => value === 0), "A140 finally 清理后所有测试残留必须为 0", remaining);
}

async function main() {
  await mkdir(verificationDir, { recursive: true });
  await mkdir(screenshotDir, { recursive: true });
  assert(new URL(apiBase).hostname === "127.0.0.1" && new URL(frontendUrl).hostname === "127.0.0.1", "A140 回归脚本只允许访问本机服务");
  setupFixtures();
  await loginFixtures();
  await verifyMasterApis();
  await verifyPermissions();
  await verifySelectors();
  await verifyTenantIsolation();
  await verifyEmployeeLink();
  await verifyBrowser();
  await verifyBrowserPermissions();
  await verifyGrantRevocation();
  captureAuditTrail();
}

let failure = null;
try {
  await main();
} catch (error) {
  failure = error;
  evidence.failure = { message: error instanceof Error ? error.message : String(error), stack: error instanceof Error ? error.stack : "" };
} finally {
  if (browser) {
    await browser.close().catch(() => null);
  }
  await logoutApiSessions().catch(() => null);
  try {
    cleanupFixtures();
  } catch (cleanupError) {
    evidence.cleanup.error = cleanupError instanceof Error ? cleanupError.message : String(cleanupError);
    if (!failure) {
      failure = cleanupError;
      evidence.failure = { message: evidence.cleanup.error, stack: cleanupError instanceof Error ? cleanupError.stack : "" };
    }
  }
  evidence.ok = failure === null;
  evidence.completedAt = new Date().toISOString();
  await mkdir(verificationDir, { recursive: true });
  await writeFile(resultPath, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
}

if (failure) {
  throw failure;
}

console.log(JSON.stringify({ ok: true, resultPath, screenshots: evidence.screenshots, cleanup: evidence.cleanup.remaining }, null, 2));
