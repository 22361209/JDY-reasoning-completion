#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";

import { loginAsAdmin } from "./helpers/regression-auth.mjs";

const rootDir = path.resolve(import.meta.dirname, "..");
const verificationDir = path.join(rootDir, "verification");
const screenshotDir = path.join(verificationDir, "playwright");
const resultPath = path.join(verificationDir, "a184-a166-usability-regression.json");
const frontendUrl = process.env.JDY_WEB_BASE || "http://127.0.0.1:5173/";
const runId = randomUUID();
const runShort = runId.replaceAll("-", "").slice(0, 12);
const mockProductName = `A184 A166 名称 ${runShort}`;
const mockProductNameId = randomUUID();

const slowKeyword = "A184-SLOW";
const fastKeyword = "A184-FAST";
const slowRow = productRow("A184-SLOW-OPTION", "A184 慢响应母件", "慢响应规格", "件", "CK-002");
const fastRow = productRow("A184-FAST-OPTION", "A184 新响应母件", "新响应规格", "只", "CK-003");
const staleSelectorRow = productRow("A184-STALE-SELECTOR", "A184 旧响应母件", "旧响应规格", "件", "CK-002");

await mkdir(verificationDir, { recursive: true });
await mkdir(screenshotDir, { recursive: true });

function assert(condition, message, details) {
  if (!condition) {
    const suffix = details === undefined ? "" : `: ${JSON.stringify(details)}`;
    throw new Error(`${message}${suffix}`);
  }
}

function errorText(error) {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

function productRow(code, name, spec, unit, defaultWarehouseCode) {
  return {
    id: randomUUID(),
    code,
    name,
    spec,
    unit,
    defaultWarehouseCode,
    status: "启用",
    auditStatus: "已审核",
    isProduce: "是"
  };
}

function deferred(label) {
  let resolvePromise;
  let released = false;
  const promise = new Promise((resolve) => {
    resolvePromise = resolve;
  });
  return {
    label,
    promise,
    release(value) {
      if (!released) {
        released = true;
        resolvePromise(value);
      }
    },
    get released() {
      return released;
    }
  };
}

function listPayload(rows, pageSize) {
  return {
    page: 1,
    pageSize: Number(pageSize || 100),
    total: rows.length,
    rows
  };
}

async function waitForSignal(signal, timeoutMs = 10000) {
  let timeoutId;
  try {
    return await Promise.race([
      signal.promise,
      new Promise((_, reject) => {
        timeoutId = setTimeout(() => reject(new Error(`${signal.label} timed out after ${timeoutMs}ms`)), timeoutMs);
      })
    ]);
  } finally {
    clearTimeout(timeoutId);
  }
}

async function openList(page, moduleTestId, entryTestId, rootTestId) {
  await page.getByTestId(moduleTestId).hover();
  await page.getByTestId(entryTestId).click();
  const root = page.getByTestId(rootTestId);
  await root.waitFor({ state: "visible", timeout: 10000 });
  return root;
}

async function fulfillJson(route, data, status = 200) {
  await route.fulfill({
    status,
    contentType: "application/json",
    body: JSON.stringify(data)
  });
}

function bomField(page, label) {
  return page.locator(".bom-product-fields label").filter({ hasText: label }).locator("input");
}

const initialLookupSeen = [deferred("first product-name initial lookup"), deferred("second product-name initial lookup")];
const initialLookupRelease = [deferred("release first product-name initial lookup"), deferred("release second product-name initial lookup")];
const initialLookupResponded = [deferred("first product-name initial response"), deferred("second product-name initial response")];
const slowSeen = deferred("BOM slow lookup request");
const slowRelease = deferred("release BOM slow lookup");
const slowResponded = deferred("BOM slow lookup response");
const fastSeen = deferred("BOM fast lookup request");
const fastRelease = deferred("release BOM fast lookup");
const selectorSeen = deferred("BOM full selector request");
const selectorRelease = deferred("release BOM full selector");
const selectorResponded = deferred("BOM stale full selector response");
const selectorFreshSeen = deferred("BOM fresh full selector response");
const allReleases = [...initialLookupRelease, slowRelease, fastRelease, selectorRelease];

const evidence = {
  taskId: "A184-4",
  sourceTask: "A166",
  runId,
  generatedAt: new Date().toISOString(),
  ok: false,
  checks: {},
  requests: {
    initialProductNameLookups: 0,
    exactProductNameLookups: 0,
    slowBomLookups: 0,
    fastBomLookups: 0,
    selectorLookups: 0,
    selectorFreshLookups: 0,
    mockedProductNameWrites: [],
    blockedUnexpectedWrites: []
  },
  screenshots: [],
  error: ""
};

let browser;
let primaryError;
let closeError;
let selectorPayload;
let selectorFreshPayload;
let selectorExactKeyword = "";

try {
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1803, height: 960 } });
  const page = await context.newPage();

  await page.goto(frontendUrl, { waitUntil: "networkidle" });
  await loginAsAdmin(page);

  await page.route("**/api/**", async (route) => {
    const request = route.request();
    if (request.method() === "GET" || request.method() === "HEAD") {
      await route.continue();
      return;
    }
    evidence.requests.blockedUnexpectedWrites.push(`${request.method()} ${new URL(request.url()).pathname}`);
    await route.abort("blockedbyclient");
  });

  await page.route("**/api/lists/**", async (route) => {
    const request = route.request();
    if (request.method() !== "GET") {
      evidence.requests.blockedUnexpectedWrites.push(`${request.method()} ${new URL(request.url()).pathname}`);
      await route.abort("blockedbyclient");
      return;
    }
    const url = new URL(request.url());
    const keyword = url.searchParams.get("keyword") ?? "";
    const pageSize = url.searchParams.get("pageSize") ?? "";
    const status = url.searchParams.get("status") ?? "";

    if (url.pathname === "/api/lists/product-master-list" && keyword === slowKeyword) {
      evidence.requests.slowBomLookups += 1;
      slowSeen.release(true);
      await slowRelease.promise;
      await fulfillJson(route, listPayload([slowRow], pageSize));
      slowResponded.release(true);
      return;
    }
    if (url.pathname === "/api/lists/product-master-list" && keyword === fastKeyword) {
      evidence.requests.fastBomLookups += 1;
      fastSeen.release(true);
      await fastRelease.promise;
      await fulfillJson(route, listPayload([fastRow], pageSize));
      return;
    }
    if (url.pathname === "/api/lists/product-master-list" && keyword === "CP-" && pageSize === "100") {
      evidence.requests.selectorLookups += 1;
      const upstream = await route.fetch();
      const body = await upstream.text();
      assert(upstream.ok(), "real produce-product selector request should succeed", { status: upstream.status(), body });
      selectorPayload = JSON.parse(body);
      assert(Array.isArray(selectorPayload?.rows) && selectorPayload.rows.length > 0,
        "real produce selector should return at least one row", selectorPayload);
      const selectedRow = selectorPayload.rows.find((row) => String(row.code ?? "") === "CP-001") ?? selectorPayload.rows[0];
      selectorExactKeyword = String(selectedRow.code ?? "");
      assert(selectorExactKeyword, "real produce selector row should expose a code", selectedRow);
      selectorSeen.release(true);
      await selectorRelease.promise;
      await route.fulfill({
        response: upstream,
        body: JSON.stringify({
          ...selectorPayload,
          total: Number(selectorPayload.total ?? selectorPayload.rows.length) + 1,
          rows: [staleSelectorRow, ...selectorPayload.rows]
        })
      });
      selectorResponded.release(true);
      return;
    }
    if (url.pathname === "/api/lists/product-master-list"
      && selectorExactKeyword
      && keyword === selectorExactKeyword
      && pageSize === "100") {
      evidence.requests.selectorFreshLookups += 1;
      const upstream = await route.fetch();
      const body = await upstream.text();
      assert(upstream.ok(), "real exact produce-product selector request should succeed", { status: upstream.status(), body });
      const exactPayload = JSON.parse(body);
      const exactRow = exactPayload?.rows?.find((row) => String(row.code ?? "") === selectorExactKeyword);
      assert(exactRow, "real exact selector request should return the selected produce product", exactPayload);
      selectorFreshPayload = listPayload([exactRow], pageSize);
      await fulfillJson(route, selectorFreshPayload);
      selectorFreshSeen.release(true);
      return;
    }
    if (url.pathname === "/api/lists/product-name-list" && pageSize === "300" && status === "启用") {
      if (!keyword && evidence.requests.initialProductNameLookups < 2) {
        const index = evidence.requests.initialProductNameLookups;
        evidence.requests.initialProductNameLookups += 1;
        initialLookupSeen[index].release(true);
        await initialLookupRelease[index].promise;
        await fulfillJson(route, listPayload([], pageSize));
        initialLookupResponded[index].release(true);
        return;
      }
      if (keyword === mockProductName) {
        evidence.requests.exactProductNameLookups += 1;
        await fulfillJson(route, listPayload([], pageSize));
        return;
      }
    }
    await route.continue();
  });

  await page.route("**/api/master-data/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const decodedPath = decodeURIComponent(url.pathname);
    if (request.method() === "POST" && decodedPath === "/api/master-data/productName") {
      const payload = request.postDataJSON();
      assert(payload?.name === mockProductName && payload?.code === mockProductName,
        "lookup-created product name write should preserve the requested value", payload);
      evidence.requests.mockedProductNameWrites.push("create");
      await fulfillJson(route, {
        id: mockProductNameId,
        code: mockProductName,
        name: mockProductName,
        remark: String(payload.remark ?? ""),
        status: "启用",
        auditStatus: "草稿",
        version: 0
      }, 201);
      return;
    }
    if (request.method() === "POST" && decodedPath === `/api/master-data/productName/${mockProductName}/audit`) {
      evidence.requests.mockedProductNameWrites.push("audit");
      await fulfillJson(route, {
        id: mockProductNameId,
        code: mockProductName,
        name: mockProductName,
        status: "启用",
        auditStatus: "已审核",
        version: 1
      });
      return;
    }
    if (request.method() !== "GET" && request.method() !== "HEAD") {
      evidence.requests.blockedUnexpectedWrites.push(`${request.method()} ${decodedPath}`);
      await route.abort("blockedbyclient");
      return;
    }
    await route.continue();
  });

  // A166-1: the three list utilities occupy the same right-aligned toolbar row.
  const salesList = await openList(page, "module-销售管理", "query-sales-order-form", "list-page-sales-order-form-list");
  const toolbar = salesList.locator(".list-toolbar");
  const toolbarMetrics = await toolbar.evaluate((node) => {
    const actions = node.querySelector(".list-toolbar-actions");
    const utilities = node.querySelector(".list-toolbar-utilities");
    const detail = node.querySelector('[data-testid="list-detail-view-toggle"]');
    const settings = node.querySelector('[data-testid="column-settings"]');
    const refresh = node.querySelector('[data-testid="list-refresh-stock"]');
    const rect = (element) => element?.getBoundingClientRect();
    const toolbarRect = rect(node);
    const actionsRect = rect(actions);
    const utilitiesRect = rect(utilities);
    return {
      actionsCenter: actionsRect ? actionsRect.top + actionsRect.height / 2 : null,
      utilitiesCenter: utilitiesRect ? utilitiesRect.top + utilitiesRect.height / 2 : null,
      utilitiesGapAfterActions: actionsRect && utilitiesRect ? utilitiesRect.left - actionsRect.right : null,
      utilitiesRightGap: toolbarRect && utilitiesRect ? toolbarRect.right - utilitiesRect.right : null,
      detailInUtilities: Boolean(detail?.closest(".list-toolbar-utilities")),
      settingsInUtilities: Boolean(settings?.closest(".list-toolbar-utilities")),
      refreshInUtilities: Boolean(refresh?.closest(".list-toolbar-utilities")),
      resolvedUtilitiesMarginLeft: utilities ? Number.parseFloat(getComputedStyle(utilities).marginLeft) : 0
    };
  });
  assert(toolbarMetrics.actionsCenter !== null && toolbarMetrics.utilitiesCenter !== null,
    "list action and utility groups should both be rendered", toolbarMetrics);
  assert(Math.abs(toolbarMetrics.actionsCenter - toolbarMetrics.utilitiesCenter) <= 2,
    "list actions and utilities should share one toolbar row", toolbarMetrics);
  assert(toolbarMetrics.detailInUtilities && toolbarMetrics.settingsInUtilities && toolbarMetrics.refreshInUtilities,
    "detail view, column settings and refresh-stock actions should share the utility group", toolbarMetrics);
  assert(toolbarMetrics.utilitiesGapAfterActions > 0
      && toolbarMetrics.resolvedUtilitiesMarginLeft > 0
      && toolbarMetrics.utilitiesRightGap >= 0
      && toolbarMetrics.utilitiesRightGap <= 12,
    "list utility group should consume the flexible gap and align to the toolbar right edge", toolbarMetrics);
  assert(await salesList.locator(".list-table-tools").count() === 0, "legacy second list-tools row should not exist");
  evidence.checks.toolbar = toolbarMetrics;

  // A166-2: an older initial lookup must not clear a newer request's visible loading state.
  await openList(page, "module-基础资料", "entry-product-master-list", "list-page-product-master-list");
  await page.getByTestId("list-create").click();
  await page.getByTestId("master-record-category").waitFor({ state: "visible", timeout: 10000 });
  await waitForSignal(initialLookupSeen[0]);
  let nameInput = page.getByTestId("master-record-name");
  assert(await nameInput.isDisabled(), "first product-name lookup should disable the name field");
  assert((await nameInput.getAttribute("placeholder"))?.includes("正在加载"), "first lookup should expose a loading placeholder");

  await openList(page, "module-基础资料", "entry-product-name-list", "list-page-product-name-list");
  await page.getByTestId("list-create").click();
  await page.getByTestId("master-record-page").waitFor({ state: "visible", timeout: 10000 });
  await openList(page, "module-基础资料", "entry-product-master-list", "list-page-product-master-list");
  await page.getByTestId("list-create").click();
  await page.getByTestId("master-record-category").waitFor({ state: "visible", timeout: 10000 });
  await waitForSignal(initialLookupSeen[1]);
  nameInput = page.getByTestId("master-record-name");
  assert(await nameInput.isDisabled(), "second product-name lookup should own the loading state");

  initialLookupRelease[0].release(true);
  await waitForSignal(initialLookupResponded[0]);
  await page.waitForFunction(() => {
    const input = document.querySelector('[data-testid="master-record-name"]');
    const stableKey = "__a184MasterLoadingStableFrames";
    const matches = input instanceof HTMLInputElement
      && input.disabled
      && input.placeholder.includes("正在加载");
    window[stableKey] = matches ? Number(window[stableKey] ?? 0) + 1 : 0;
    return window[stableKey] >= 3;
  }, undefined, { polling: "raf", timeout: 1000 });
  assert(await nameInput.isDisabled(), "stale first response must not enable the name field while request two is pending");
  assert((await nameInput.getAttribute("placeholder"))?.includes("正在加载"),
    "stale first response must not remove the newer loading placeholder");
  initialLookupRelease[1].release(true);
  await waitForSignal(initialLookupResponded[1]);
  await page.waitForFunction(() => {
    const input = document.querySelector('[data-testid="master-record-name"]');
    return input instanceof HTMLInputElement && !input.disabled;
  });
  evidence.checks.masterLookupLoading = {
    staleResponsePreservedDisabledState: true,
    initialRequests: evidence.requests.initialProductNameLookups
  };

  // A166-3: missing product name opens maintenance, saves+audits, and returns selected to the source form.
  await nameInput.fill(mockProductName);
  await page.getByTestId("master-record-code").click();
  await page.getByTestId("master-record-lookup-create-dialog").waitFor({ state: "visible", timeout: 10000 });
  await page.getByTestId("master-record-lookup-create-confirm").click();
  await page.getByTestId("master-record-page").waitFor({ state: "visible", timeout: 10000 });
  assert(await page.getByTestId("master-record-name").inputValue() === mockProductName,
    "lookup-created product-name page should carry the missing name");
  assert((await page.getByTestId("master-record-save").innerText()).includes("保存并审核"),
    "lookup-created product name should expose save-and-audit");
  assert((await page.getByTestId("master-record-bottom-save").innerText()).includes("保存并审核"),
    "bottom action should share the save-and-audit label");
  await page.getByTestId("master-record-save").click();
  await page.waitForFunction((expected) => {
    const name = document.querySelector('[data-testid="master-record-name"]');
    const category = document.querySelector('[data-testid="master-record-category"]');
    return name instanceof HTMLInputElement && name.value === expected && category instanceof HTMLInputElement;
  }, mockProductName);
  assert(await page.getByTestId("master-record-dirty-hint").isVisible(),
    "returned source product should remain dirty with the selected new name");
  assert(JSON.stringify(evidence.requests.mockedProductNameWrites) === JSON.stringify(["create", "audit"]),
    "lookup-created name should perform create then audit", evidence.requests.mockedProductNameWrites);
  evidence.checks.productNameReturn = {
    selectedName: mockProductName,
    writes: [...evidence.requests.mockedProductNameWrites],
    persistence: "browser-controlled response; no database write"
  };

  // A166-4: input immediately invalidates an older BOM request and never co-renders loading with empty state.
  await openList(page, "module-生产管理", "entry-bom-list", "list-page-bom-list");
  await page.getByTestId("list-create").click();
  await page.getByTestId("bom-form").waitFor({ state: "visible", timeout: 10000 });
  const bomInput = page.getByTestId("bom-product-code");
  await bomInput.fill(slowKeyword);
  await waitForSignal(slowSeen);
  const bomMenu = page.locator(".bom-parent-selector .master-selector__menu");
  await bomMenu.waitFor({ state: "visible" });
  assert((await bomMenu.innerText()).includes("正在查询"), "slow lookup should expose its loading state");

  await page.evaluate(() => {
    const nativeSetTimeout = window.setTimeout;
    const nativeClearTimeout = window.clearTimeout;
    const heldTimers = new Map();
    let nextHeldId = -1;
    window.__a184ReleaseBomDebounce = () => {
      const callbacks = [...heldTimers.values()];
      heldTimers.clear();
      window.setTimeout = nativeSetTimeout;
      window.clearTimeout = nativeClearTimeout;
      callbacks.forEach(({ handler, args }) => {
        if (typeof handler === "function") {
          handler(...args);
        }
      });
    };
    window.setTimeout = (handler, timeout = 0, ...args) => {
      if (Number(timeout) === 180) {
        const timerId = nextHeldId;
        nextHeldId -= 1;
        heldTimers.set(timerId, { handler, args });
        return timerId;
      }
      return nativeSetTimeout(handler, timeout, ...args);
    };
    window.clearTimeout = (timerId) => {
      if (!heldTimers.delete(timerId)) {
        nativeClearTimeout(timerId);
      }
    };
  });
  await bomInput.fill(fastKeyword);
  assert((await bomMenu.innerText()).includes("正在查询"), "new keyword should keep loading visible immediately");
  assert(!(await bomMenu.innerText()).includes("没有匹配"), "loading and no-match state must be mutually exclusive");
  assert(!(await bomMenu.innerText()).includes(slowRow.code), "new keyword should immediately clear old candidates");
  slowRelease.release(true);
  await waitForSignal(slowResponded);
  await page.waitForFunction(({ slowCode }) => {
    const menu = document.querySelector(".bom-parent-selector .master-selector__menu");
    const text = menu?.textContent ?? "";
    const stableKey = "__a184BomLoadingStableFrames";
    const matches = text.includes("正在查询") && !text.includes("没有匹配") && !text.includes(slowCode);
    window[stableKey] = matches ? Number(window[stableKey] ?? 0) + 1 : 0;
    return window[stableKey] >= 3;
  }, { slowCode: slowRow.code }, { polling: "raf", timeout: 1000 });
  assert(!fastSeen.released, "the controlled debounce must keep the newer lookup pending during stale-response checks");
  assert((await bomMenu.innerText()).includes("正在查询"),
    "a stale response during the newer debounce window must not clear loading");
  assert(!(await bomMenu.innerText()).includes("没有匹配"),
    "a stale response must not expose a false empty state during the newer request");

  await page.evaluate(() => window.__a184ReleaseBomDebounce());
  await waitForSignal(fastSeen);
  fastRelease.release(true);
  const fastOption = bomMenu.getByRole("button").filter({ hasText: fastRow.code });
  await fastOption.waitFor({ state: "visible", timeout: 10000 });
  assert(!(await bomMenu.innerText()).includes(slowRow.code), "stale slow candidates must never replace fast candidates");
  assert(!(await bomMenu.innerText()).includes("正在查询"), "current response should close loading");
  assert(!(await bomMenu.innerText()).includes("没有匹配"), "non-empty current response should not show the empty state");
  evidence.checks.bomLookupRace = {
    slowRequests: evidence.requests.slowBomLookups,
    fastRequests: evidence.requests.fastBomLookups,
    visibleCandidate: fastRow.code
  };

  // A166-5: the real produce-material selector keeps loading copy and rejects an older response after a newer query.
  await bomInput.fill("CP-");
  await page.getByTestId("bom-product-selector").click();
  const selector = page.getByTestId("master-selector-source-selector-dialog");
  await selector.waitFor({ state: "visible", timeout: 10000 });
  await waitForSignal(selectorSeen);
  const loadingCount = (await page.getByTestId("master-selector-source-selector-count").innerText()).trim();
  const loadingSummary = (await page.getByTestId("master-selector-source-selector-summary").innerText()).trim();
  const loadingPagination = (await page.getByTestId("master-selector-source-selector-pagination").innerText()).replace(/\s+/g, " ").trim();
  assert(loadingCount.includes("加载中") && !loadingCount.includes("0"), "selector count should be loading, not zero", loadingCount);
  assert(loadingSummary.includes("加载中") && !loadingSummary.includes("0 行"), "selector summary should be loading, not zero", loadingSummary);
  assert(loadingPagination.includes("总数加载中") && loadingPagination.includes("分页加载中") && !loadingPagination.includes("共 0 条"),
    "selector pagination should expose loading without a false zero", loadingPagination);
  const paginationControls = page.getByTestId("master-selector-source-selector-pagination").locator("select, button");
  const disabledControls = await paginationControls.evaluateAll((nodes) => nodes.map((node) => node.disabled));
  assert(disabledControls.length === 3 && disabledControls.every(Boolean),
    "all selector pagination controls should be disabled while loading", disabledControls);

  const loadingScreenshot = `a184-a166-selector-loading-${runShort}.png`;
  await page.screenshot({ path: path.join(screenshotDir, loadingScreenshot), fullPage: true });
  evidence.screenshots.push(`verification/playwright/${loadingScreenshot}`);
  const selectedRow = selectorPayload.rows.find((row) => String(row.code ?? "") === "CP-001") ?? selectorPayload.rows[0];
  const selectedCode = String(selectedRow.code ?? "");
  assert(selectedCode === selectorExactKeyword, "real selector should freeze the exact follow-up keyword", {
    selectedCode,
    selectorExactKeyword
  });
  await page.getByTestId("master-selector-source-selector-search").fill(selectedCode);
  await page.getByTestId("master-selector-source-selector-query").click();
  await waitForSignal(selectorFreshSeen);
  assert(selectorFreshPayload?.total === 1, "fresh exact selector response should be deterministic", selectorFreshPayload);
  const selectedControl = page.getByTestId(`master-selector-source-line-${selectedCode}`);
  await selectedControl.waitFor({ state: "visible", timeout: 10000 });
  const freshCount = (await page.getByTestId("master-selector-source-selector-count").innerText()).trim();
  assert(freshCount === "共 1 条", "fresh exact selector response should own the visible count", freshCount);
  assert(await page.getByText(staleSelectorRow.code, { exact: true }).count() === 0,
    "stale selector sentinel must not be visible before releasing the old response");

  selectorRelease.release(true);
  await waitForSignal(selectorResponded);
  await page.waitForFunction(({ selectedCode: code, staleCode, expectedCount }) => {
    const row = document.querySelector(`[data-testid="master-selector-source-line-${CSS.escape(code)}"]`);
    const count = document.querySelector('[data-testid="master-selector-source-selector-count"]')?.textContent?.trim() ?? "";
    const text = document.querySelector('[data-testid="master-selector-source-selector-dialog"]')?.textContent ?? "";
    const stableKey = "__a184SelectorFreshStableFrames";
    const matches = Boolean(row) && count === expectedCount && !text.includes(staleCode);
    window[stableKey] = matches ? Number(window[stableKey] ?? 0) + 1 : 0;
    return window[stableKey] >= 3;
  }, { selectedCode, staleCode: staleSelectorRow.code, expectedCount: freshCount }, { polling: "raf", timeout: 1000 });
  assert((await page.getByTestId("master-selector-source-selector-count").innerText()).trim() === freshCount,
    "older selector response must not overwrite the newer visible total");
  assert(await page.getByText(staleSelectorRow.code, { exact: true }).count() === 0,
    "older selector response must not overwrite newer rows");
  await selectedControl.click();
  await selector.waitFor({ state: "hidden", timeout: 10000 });
  assert(await bomInput.inputValue() === selectedCode, "full selector should backfill the real product code");
  assert(await bomField(page, "母件名称").inputValue() === String(selectedRow.name ?? ""),
    "full selector should backfill the real product name", selectedRow);
  assert(await bomField(page, "规格型号").inputValue() === String(selectedRow.spec ?? ""),
    "full selector should backfill the real product spec", selectedRow);
  assert(await bomField(page, "单位").inputValue() === String(selectedRow.unit ?? ""),
    "full selector should backfill the real product unit", selectedRow);
  assert(await bomField(page, "默认仓库").inputValue() === String(selectedRow.defaultWarehouseCode ?? ""),
    "full selector should backfill the real default warehouse", selectedRow);
  evidence.checks.realBomSelector = {
    code: selectedCode,
    name: String(selectedRow.name ?? ""),
    spec: String(selectedRow.spec ?? ""),
    unit: String(selectedRow.unit ?? ""),
    defaultWarehouseCode: String(selectedRow.defaultWarehouseCode ?? ""),
    loading: { count: loadingCount, summary: loadingSummary, pagination: loadingPagination },
    staleResponseRejected: true,
    freshCount
  };

  // A166-6: unsaved opening-stock rows keep stable identity and keyboard focus; do not save inventory.
  await page.getByTestId("module-库存管理").hover();
  const openingStockLoad = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return url.pathname === "/api/inventory/opening-stock"
      && response.request().method() === "GET";
  }, { timeout: 10000 });
  await page.getByTestId("entry-opening-stock-settings").click();
  await page.getByTestId("opening-stock-page").waitFor({ state: "visible", timeout: 10000 });
  const openingStockResponse = await openingStockLoad;
  assert(openingStockResponse.ok(), "opening-stock baseline should load before adding local focus rows", {
    status: openingStockResponse.status()
  });
  const existingRowCount = await page.locator('[data-testid^="opening-product-code-"]').count();
  await page.getByTestId("opening-stock-add-row").click();
  const firstNewIndex = existingRowCount + 1;
  const firstProduct = page.getByTestId(`opening-product-code-${firstNewIndex}`);
  const firstWarehouse = page.getByTestId(`opening-warehouse-code-${firstNewIndex}`);
  await firstProduct.waitFor({ state: "visible" });
  await firstProduct.focus();
  await firstProduct.pressSequentially("A184-FOCUS-1", { delay: 15 });
  assert(await page.evaluate(() => document.activeElement?.getAttribute("data-testid")) === `opening-product-code-${firstNewIndex}`,
    "typing the unsaved product code must not replace the row or lose focus");
  await page.keyboard.press("Tab");
  assert(await page.evaluate(() => document.activeElement?.getAttribute("data-testid")) === `opening-warehouse-code-${firstNewIndex}`,
    "Tab should move from product code to warehouse code on the same unsaved row");
  await firstWarehouse.pressSequentially("A184-WH-1", { delay: 15 });
  await page.getByTestId("opening-stock-add-row").click();
  const secondNewIndex = firstNewIndex + 1;
  const secondProduct = page.getByTestId(`opening-product-code-${secondNewIndex}`);
  await secondProduct.waitFor({ state: "visible" });
  assert(await firstProduct.inputValue() === "A184-FOCUS-1" && await firstWarehouse.inputValue() === "A184-WH-1",
    "adding another unsaved row must preserve the first row values");
  await secondProduct.focus();
  await secondProduct.pressSequentially("A184-FOCUS-2", { delay: 15 });
  assert(await page.evaluate(() => document.activeElement?.getAttribute("data-testid")) === `opening-product-code-${secondNewIndex}`,
    "typing the second unsaved row must keep focus on its stable key");
  await page.getByTestId(`opening-remove-${secondNewIndex}`).click();
  await page.getByTestId(`opening-remove-${firstNewIndex}`).click();
  assert(await page.locator('[data-testid^="opening-product-code-"]').count() === existingRowCount,
    "unsaved focus rows should be removed without saving inventory");
  evidence.checks.openingStockFocus = {
    existingRowCount,
    firstNewIndex,
    secondNewIndex,
    saved: false
  };

  const finalScreenshot = `a184-a166-opening-focus-${runShort}.png`;
  await page.screenshot({ path: path.join(screenshotDir, finalScreenshot), fullPage: true });
  evidence.screenshots.push(`verification/playwright/${finalScreenshot}`);

  assert(evidence.requests.initialProductNameLookups === 2, "loading ownership test should issue exactly two controlled initial requests");
  assert(evidence.requests.slowBomLookups === 1 && evidence.requests.fastBomLookups === 1,
    "BOM race should issue one slow and one fast request", evidence.requests);
  assert(evidence.requests.selectorLookups === 1, "full selector loading test should issue one controlled real request");
  assert(evidence.requests.selectorFreshLookups === 1,
    "full selector response-order test should issue one newer exact request");
  assert(evidence.requests.exactProductNameLookups >= 1,
    "missing-name flow should verify the exact value before offering create", evidence.requests);
  assert(evidence.requests.blockedUnexpectedWrites.length === 0,
    "the acceptance flow must not attempt any unexpected business write", evidence.requests.blockedUnexpectedWrites);
  evidence.ok = true;
} catch (error) {
  primaryError = error;
  evidence.error = errorText(error);
} finally {
  allReleases.forEach((control) => control.release(true));
  if (browser) {
    try {
      await browser.close();
    } catch (error) {
      closeError = error;
    }
  }
  evidence.completedAt = new Date().toISOString();
  if (closeError) {
    evidence.closeError = errorText(closeError);
    evidence.ok = false;
  }
  await writeFile(resultPath, `${JSON.stringify(evidence, null, 2)}\n`);
}

if (primaryError && closeError) {
  throw new AggregateError([primaryError, closeError], "A184 A166 usability regression and browser cleanup both failed");
}
if (primaryError) {
  throw primaryError;
}
if (closeError) {
  throw closeError;
}

console.log(JSON.stringify(evidence, null, 2));
