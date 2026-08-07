const MASTER_DATA_LIST_KEYS = Object.freeze({
  product: "product-master-list",
  customer: "customer-master-list",
  supplier: "supplier-master-list",
  warehouse: "warehouse-master-list"
});

const NON_PATCH_FIELDS = new Set([
  "id",
  "systemNo",
  "code",
  "version",
  "status",
  "enabled",
  "auditStatus",
  "updatedAt"
]);

const BOOLEAN_PATCH_FIELDS = new Set([
  "isPurchase",
  "isSale",
  "isInventory",
  "isProduce",
  "isSubcontract"
]);

const NUMBER_PATCH_FIELDS = new Set([
  "netWeight",
  "grossWeight",
  "taxRate",
  "defaultSalePrice",
  "costPrice",
  "minSalePrice",
  "purchasePrice",
  "maxPurchasePrice",
  "subcontractPrice",
  "wholesalePrice",
  "retailPrice",
  "minStockQty",
  "safetyStockQty",
  "maxStockQty",
  "creditLimit"
]);

function masterDataListKey(type) {
  const listKey = MASTER_DATA_LIST_KEYS[type];
  if (!listKey) {
    throw new Error(`unsupported sparse-patch master data type: ${type}`);
  }
  return listKey;
}

async function readResponse(response) {
  const text = await response.text();
  if (!text) {
    return {};
  }
  try {
    return JSON.parse(text);
  } catch {
    return { text };
  }
}

async function requestMasterDataJson(apiBase, pathname, options = {}) {
  const method = options.method ?? "GET";
  const response = await fetch(`${apiBase}${pathname}`, {
    method,
    headers: options.body === undefined ? options.headers : {
      "Content-Type": "application/json",
      ...options.headers
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body)
  });
  const data = await readResponse(response);
  if (!response.ok) {
    throw new Error(`${method} ${pathname} failed ${response.status}: ${JSON.stringify(data)}`);
  }
  return data;
}

export async function queryExactMasterData(apiBase, type, code) {
  const listKey = masterDataListKey(type);
  const query = new URLSearchParams({
    keyword: code,
    page: "1",
    pageSize: "200"
  });
  const result = await requestMasterDataJson(apiBase, `/api/lists/${listKey}?${query}`);
  const exactRows = Array.isArray(result.rows)
    ? result.rows.filter((row) => String(row?.code ?? "") === code)
    : [];
  if (exactRows.length !== 1) {
    throw new Error(`${type} ${code} exact lookup expected 1 row, got ${exactRows.length}`);
  }
  const row = exactRows[0];
  if (!Number.isInteger(row.version) || row.version < 0) {
    throw new Error(`${type} ${code} exact lookup returned invalid version: ${JSON.stringify(row.version)}`);
  }
  return row;
}

function fixturePatchValue(type, field, value) {
  if (value === null) {
    return null;
  }
  if (type === "product" && BOOLEAN_PATCH_FIELDS.has(field)) {
    if (typeof value === "boolean") {
      return value;
    }
    if (["true", "1", "是"].includes(String(value))) {
      return true;
    }
    if (["false", "0", "否"].includes(String(value))) {
      return false;
    }
    throw new Error(`product fixture field ${field} must be boolean-compatible, got ${JSON.stringify(value)}`);
  }
  if (NUMBER_PATCH_FIELDS.has(field)) {
    if (value === "") {
      return null;
    }
    const number = Number(value);
    if (!Number.isFinite(number)) {
      throw new Error(`${type} fixture field ${field} must be number-compatible, got ${JSON.stringify(value)}`);
    }
    return number;
  }
  return value;
}

export function fixturePatchChanges(type, payload) {
  return Object.fromEntries(
    Object.entries(payload)
      .filter(([key, value]) => !NON_PATCH_FIELDS.has(key) && value !== undefined)
      .map(([key, value]) => [key, fixturePatchValue(type, key, value)])
  );
}

export async function patchMasterDataRecord(apiBase, type, code, version, changes) {
  masterDataListKey(type);
  if (!Number.isInteger(version) || version < 0) {
    throw new Error(`${type} ${code} patch requires a nonnegative integer version`);
  }
  if (!changes || Object.keys(changes).length === 0) {
    throw new Error(`${type} ${code} patch requires at least one business field`);
  }
  return requestMasterDataJson(apiBase, `/api/master-data/${type}/${encodeURIComponent(code)}`, {
    method: "PATCH",
    body: { version, changes }
  });
}

function isAudited(row) {
  return row.auditStatus === "已审核" || row.auditStatus === "AUDITED";
}

export async function upsertMasterDataFixture({ apiBase, type, payload, audit = true }) {
  masterDataListKey(type);
  const code = String(payload?.code ?? "").trim();
  if (!code) {
    throw new Error(`${type} fixture requires code`);
  }

  const createResponse = await fetch(`${apiBase}/api/master-data/${type}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
  const createData = await readResponse(createResponse);
  if (createResponse.ok) {
    if (audit) {
      await requestMasterDataJson(apiBase, `/api/master-data/${type}/${encodeURIComponent(code)}/audit`, { method: "POST" });
    }
    return queryExactMasterData(apiBase, type, code);
  }
  if (createResponse.status !== 409) {
    throw new Error(`POST /api/master-data/${type} failed ${createResponse.status}: ${JSON.stringify(createData)}`);
  }

  let current = await queryExactMasterData(apiBase, type, code);
  if (isAudited(current)) {
    await requestMasterDataJson(apiBase, `/api/master-data/${type}/${encodeURIComponent(code)}/reverse`, { method: "POST" });
    current = await queryExactMasterData(apiBase, type, code);
  }

  const desiredStatus = payload.status;
  if (desiredStatus !== undefined && current.status !== desiredStatus) {
    await requestMasterDataJson(apiBase, `/api/master-data/${type}/${encodeURIComponent(code)}/status`, {
      method: "PATCH",
      body: { status: desiredStatus }
    });
    current = await queryExactMasterData(apiBase, type, code);
  }

  const changes = fixturePatchChanges(type, payload);
  if (Object.keys(changes).length > 0) {
    await patchMasterDataRecord(apiBase, type, code, current.version, changes);
    current = await queryExactMasterData(apiBase, type, code);
  }

  if (audit) {
    await requestMasterDataJson(apiBase, `/api/master-data/${type}/${encodeURIComponent(code)}/audit`, { method: "POST" });
    current = await queryExactMasterData(apiBase, type, code);
  }
  return current;
}

export async function removeMasterDataFixture({ apiBase, type, code }) {
  masterDataListKey(type);
  const normalizedCode = String(code ?? "").trim();
  if (!normalizedCode) {
    throw new Error(`${type} fixture cleanup requires code`);
  }
  const query = new URLSearchParams({ keyword: normalizedCode, page: "1", pageSize: "200" });
  const before = await requestMasterDataJson(apiBase, `/api/lists/${masterDataListKey(type)}?${query}`);
  const rows = Array.isArray(before.rows) ? before.rows.filter((row) => String(row?.code ?? "") === normalizedCode) : [];
  if (rows.length === 0) return false;
  if (rows.length !== 1) {
    throw new Error(`${type} ${normalizedCode} fixture cleanup expected one exact row, got ${rows.length}`);
  }
  if (isAudited(rows[0])) {
    await requestMasterDataJson(apiBase, `/api/master-data/${type}/${encodeURIComponent(normalizedCode)}/reverse`, { method: "POST" });
  }
  await requestMasterDataJson(apiBase, `/api/master-data/${type}/${encodeURIComponent(normalizedCode)}`, { method: "DELETE" });
  const after = await requestMasterDataJson(apiBase, `/api/lists/${masterDataListKey(type)}?${query}`);
  const residue = Array.isArray(after.rows) ? after.rows.filter((row) => String(row?.code ?? "") === normalizedCode) : [];
  if (residue.length !== 0) {
    throw new Error(`${type} ${normalizedCode} fixture cleanup left ${residue.length} exact rows`);
  }
  return true;
}
