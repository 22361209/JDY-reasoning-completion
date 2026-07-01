#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import assert from "node:assert/strict";

const root = new URL("../", import.meta.url);

async function text(path) {
  return readFile(new URL(path, root), "utf8");
}

const [
  apiContract,
  protocol,
  dataListPage,
  listQueryBar,
  dataListDefinition,
  listApi,
  listController,
  listQueryService,
  contractRegistry,
  listQueryAdapter,
  salesOrderAdapter,
  defaultAdapter,
  listQuerySupport,
  stubSeedRowsProvider
] = await Promise.all([
  text("docs/13-列表API契约.md"),
  text("docs/guides/list-query-unification-protocol.md"),
  text("frontend/src/components/DataListPage.vue"),
  text("frontend/src/components/list/ListQueryBar.vue"),
  text("frontend/src/components/list/useDataListDefinition.ts"),
  text("frontend/src/services/listApi.ts"),
  text("backend/src/main/java/com/jdy/erp/system/api/ListStubController.java"),
  text("backend/src/main/java/com/jdy/erp/system/application/list/ListQueryService.java"),
  text("backend/src/main/java/com/jdy/erp/system/application/list/ListQueryContractRegistry.java"),
  text("backend/src/main/java/com/jdy/erp/system/application/list/ListQueryAdapter.java"),
  text("backend/src/main/java/com/jdy/erp/system/application/list/SalesOrderListQueryAdapter.java"),
  text("backend/src/main/java/com/jdy/erp/system/application/list/DefaultStubListQueryAdapter.java"),
  text("backend/src/main/java/com/jdy/erp/system/application/list/ListQuerySupport.java"),
  text("backend/src/main/java/com/jdy/erp/system/application/list/StubListSeedRowsProvider.java")
]);

assert(apiContract.includes("多词 AND、字段内 OR"), "列表 API 契约必须声明关键字多词 AND / 字段内 OR");
assert(apiContract.includes("已废弃的状态快速筛选"), "列表 API 契约必须声明 status 顶部快捷筛选已废弃");
assert(!apiContract.includes("dateFrom` | date | 否 | 操作日志专用"), "dateFrom 不得继续标注为操作日志专用");
assert(protocol.includes("普通列表不得再显示顶部 `状态` 下拉"), "A128 协议必须禁止普通列表顶部状态下拉");
assert(protocol.includes("旧 `status` 参数仅为兼容旧链接和旧预设保留"), "A128 协议必须说明旧 status 兼容边界");
assert(protocol.includes("headerMatch=existsLine"), "A128 协议必须声明整单视图命中明细字段的 existsLine 口径");

assert(!dataListPage.includes('data-testid="list-status"'), "DataListPage 不得渲染普通列表顶部状态下拉");
assert(!dataListPage.includes("2026-06-01 至 2026-06-30"), "DataListPage 不得保留旧只读日期占位");
assert(!dataListPage.includes("本地管理员\" readonly"), "DataListPage 不得保留旧只读经办人占位");
assert(dataListPage.includes("ListQueryBar"), "DataListPage 必须通过统一 ListQueryBar 渲染查询栏");
assert(dataListPage.includes("migratePresetStatusFilter"), "旧预设 query.status 必须迁移到列头筛选");
assert(dataListPage.includes("submitQuery()"), "查询动作必须统一回到第一页后 reload");
assert(listQueryBar.includes('data-testid="list-quick-date"'), "ListQueryBar 必须提供常用过滤条件入口");
assert(listQueryBar.includes('data-testid="list-date-range"'), "ListQueryBar 必须提供日期范围入口");
assert(listQueryBar.includes("list-query-button"), "日期过滤触发按钮必须使用统一查询按钮样式");
assert(listQueryBar.includes(`@keydown.enter="emit('query')"`) || listQueryBar.includes(`@keydown.enter="emit(\\"query\\")"`), "关键字必须回车才触发查询");
assert(!listQueryBar.includes(`@input="emit('query')"`) && !listQueryBar.includes(`@input="emit(\\"query\\")"`), "关键字输入不得即时触发查询");

assert(dataListDefinition.includes("searchFields:"), "ListDefinition 必须包含 searchFields 协议元数据");
assert(dataListDefinition.includes("dateField:"), "ListDefinition 必须包含 dateField 协议元数据");
assert(dataListDefinition.includes("supportsQuickDateFilter:"), "ListDefinition 必须包含 supportsQuickDateFilter 协议元数据");
assert(dataListDefinition.includes("lifecycleColumns:"), "ListDefinition 必须包含 lifecycleColumns 协议元数据");
assert(dataListDefinition.includes("normalizeListDefinition"), "列表定义必须经过统一归一化");

assert(listApi.includes("status?: string"), "ListQuery.status 必须是兼容字段而不是必填字段");
assert(!listApi.includes("status: query.status,\n"), "listApi 不得无条件发送 status 参数");
assert(listApi.includes("if (query.status)"), "listApi 只能在兼容旧调用时发送 status 参数");

assert(listController.includes("ListQueryService"), "Controller 必须委托 ListQueryService");
assert(listController.includes("listQueryService.query"), "Controller 必须通过统一查询服务读取列表");
assert(listController.match(/stateGuard\.assertReadable\(listKey\)/g)?.length === 2, "列表读取和导出必须共用状态门禁");
assert(!listController.includes("ListQueryContract"), "Controller 不得登记或感知查询契约");
assert(!listController.includes("adapterHandlesQuery"), "Controller 不得保留 adapterHandlesQuery 特判");
assert(!listController.includes("contractFor("), "Controller 不得保留私有 contractFor");
assert(!listController.includes("salesOrderHeaderRows"), "Controller 不得保留销售订单 header SQL adapter");
assert(!listController.includes("matchesKeywordTokens"), "Controller 不得保留关键字匹配规则");
assert(!listController.includes("matchesDateRange"), "Controller 不得保留日期匹配规则");
assert(!listController.includes("parseColumnFilters"), "Controller 不得解析列筛选协议");
assert(!listController.includes('filters.put("status"'), "Controller 不得处理旧 status 兼容");
assert(!listController.includes("switch (listKey)"), "Controller 不得保留 listKey 数据路由 switch");
assert(!/case\s+"/.test(listController), "Controller 不得保留 listKey case 分支");
assert(!listController.includes("documentDetailRows"), "Controller 不得保留明细 rows 数据提供逻辑");
assert(!listController.includes("queryDetailRows"), "Controller 不得保留明细 SQL 查询逻辑");
assert(!listController.includes("JdbcTemplate"), "Controller 不得直接依赖 JdbcTemplate 读取列表数据");
assert(!listController.includes("permission-denied-list"), "Controller 不得保留权限态 listKey 特判");
assert(!listController.includes("error-list"), "Controller 不得保留错误态 listKey 特判");
assert(!listController.includes(".equals(listKey)"), "Controller 不得直接判断 listKey 特判");
assert(stubSeedRowsProvider.includes("implements ListSeedRowsProvider"), "历史 seed rows 必须迁入正式 ListSeedRowsProvider 实现");
assert(stubSeedRowsProvider.includes("switch (listKey)"), "历史 listKey 数据路由只能存在于 StubListSeedRowsProvider");

assert(listQueryService.includes("ListQueryContractRegistry"), "后端必须通过 ListQueryContractRegistry 获取协议");
assert(listQueryService.includes("ListQueryAdapter"), "后端必须通过 ListQueryAdapter 执行查询");
assert(listQueryService.includes("contractRegistry.contractFor"), "ListQueryService 必须按 listKey/view 获取契约");
assert(listQueryService.includes("contract.adapterKey()"), "ListQueryService 必须由契约决定 adapter");
assert(!listQueryService.includes("getOrDefault(contract.adapterKey()"), "非 default adapter 缺失不得静默回退到 default");
assert(listQueryService.includes("Missing list query adapter"), "adapter 缺失必须 fail fast 并给出明确错误");
assert(contractRegistry.includes('"sales-order-form-list"'), "Registry 必须登记销售订单列表契约");
assert(contractRegistry.includes('"salesOrder"'), "销售订单契约必须指向 salesOrder adapter");
assert(contractRegistry.includes('"exists"'), "销售订单整单视图必须声明 exists 明细命中策略");
assert(contractRegistry.includes('"join"'), "销售订单明细视图必须声明 join 明细返回策略");
assert(listQueryAdapter.includes("ListQueryResult query"), "ListQueryAdapter 必须定义统一查询结果接口");
assert(defaultAdapter.includes("seedRowsProvider"), "默认 adapter 必须显式依赖 seedRowsProvider");
assert(listQuerySupport.includes("keywordTokens"), "后端列表查询必须实现关键字分词");
assert(listQuerySupport.includes("matchesKeywordTokens"), "默认 adapter 必须支持多词关键字匹配");
assert(listQuerySupport.includes("matchesDateRange"), "默认 adapter 必须支持通用日期范围");
assert(listQuerySupport.includes('filters.put("status"'), "旧 status 参数必须在统一 support 中兼容为列头筛选");
assert(salesOrderAdapter.includes("EXISTS"), "整单视图命中明细字段必须用 EXISTS 或等价 join");
assert(salesOrderAdapter.includes("LIMIT ? OFFSET ?"), "销售订单 adapter 必须 SQL 下推分页");
assert(salesOrderAdapter.includes("SELECT count(*)"), "销售订单 adapter 必须 SQL 下推 total 计算");
assert(!salesOrderAdapter.includes("seedRowsProvider.seedRows"), "销售订单 adapter 不得回退 seedRows");
assert(salesOrderAdapter.includes("contract.returnShape()"), "销售订单 adapter 必须消费 contract 的 returnShape");
assert(salesOrderAdapter.includes("ResponseStatusException(HttpStatus.BAD_REQUEST"), "销售订单未知列筛选必须按协议错误返回 400");
assert(salesOrderAdapter.includes("Unsupported sales order list column filter"), "销售订单未知列筛选必须 fail fast，不能静默忽略");
[
  "billNo",
  "customerCode",
  "customer",
  "billDate",
  "status",
  "outStatus",
  "planDeliveryDate",
  "qty",
  "shippedQty",
  "remainingQty",
  "amount",
  "priceTaxTotal",
  "remark",
  "owner",
  "partner",
  "lineNo",
  "productCode",
  "productName",
  "spec",
  "unitPrice",
  "taxInclusiveUnitPrice",
  "customerMaterialCode",
  "customerOrderNo",
  "lineRemark",
  "warehouse",
  "unit",
  "netWeight",
  "grossWeight",
  "sourceBillNo",
  "sourceLineNo"
].forEach((field) => {
  assert(salesOrderAdapter.includes(`expressions.put("${field}"`), `销售订单 adapter 必须映射可见列筛选字段 ${field}`);
});
[
  "HEADER_AMOUNT_TEXT",
  "HEADER_PRICE_TAX_TOTAL_TEXT",
  "DETAIL_AMOUNT_TEXT",
  "DETAIL_PRICE_TAX_TOTAL_TEXT"
].forEach((constantName) => {
  assert(salesOrderAdapter.includes(constantName), `销售订单金额/数量筛选必须复用显示文本表达式 ${constantName}`);
});

console.log("A128 list query contract scan passed");
