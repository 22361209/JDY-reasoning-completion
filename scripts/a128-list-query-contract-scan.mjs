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
  listController
] = await Promise.all([
  text("docs/13-列表API契约.md"),
  text("docs/guides/list-query-unification-protocol.md"),
  text("frontend/src/components/DataListPage.vue"),
  text("frontend/src/components/list/ListQueryBar.vue"),
  text("frontend/src/components/list/useDataListDefinition.ts"),
  text("frontend/src/services/listApi.ts"),
  text("backend/src/main/java/com/jdy/erp/system/api/ListStubController.java")
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

assert(dataListDefinition.includes("searchFields:"), "ListDefinition 必须包含 searchFields 协议元数据");
assert(dataListDefinition.includes("dateField:"), "ListDefinition 必须包含 dateField 协议元数据");
assert(dataListDefinition.includes("supportsQuickDateFilter:"), "ListDefinition 必须包含 supportsQuickDateFilter 协议元数据");
assert(dataListDefinition.includes("lifecycleColumns:"), "ListDefinition 必须包含 lifecycleColumns 协议元数据");
assert(dataListDefinition.includes("normalizeListDefinition"), "列表定义必须经过统一归一化");

assert(listApi.includes("status?: string"), "ListQuery.status 必须是兼容字段而不是必填字段");
assert(!listApi.includes("status: query.status,\n"), "listApi 不得无条件发送 status 参数");
assert(listApi.includes("if (query.status)"), "listApi 只能在兼容旧调用时发送 status 参数");

assert(listController.includes("ListQueryRequest"), "后端列表查询必须收敛到统一查询请求");
assert(listController.includes("ListQueryContract"), "后端列表查询必须登记统一查询契约");
assert(listController.includes("salesOrderHeaderRows"), "销售订单整单视图必须有 header adapter");
assert(listController.includes("EXISTS"), "整单视图命中明细字段必须用 EXISTS 或等价 join");
assert(!listController.includes("searchFieldsFor("), "后端不得保留旧 searchFieldsFor 推断函数");
assert(!listController.includes("dateFieldFor("), "后端不得保留旧 dateFieldFor 推断函数");
assert(listController.includes("keywordTokens"), "后端列表查询必须实现关键字分词");
assert(listController.includes("matchesKeywordTokens"), "后端列表查询必须实现多词关键字匹配");
assert(listController.includes("matchesDateRange"), "后端列表查询必须实现通用日期范围");
assert(listController.includes('filters.put("status"'), "后端必须把旧 status 参数兼容为列头筛选");

console.log("A128 list query contract scan passed");
