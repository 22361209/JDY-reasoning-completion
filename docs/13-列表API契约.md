# 列表 API 契约

本文件约束 B1 之后所有高密度列表页的查询接口。当前后端仍可返回 stub 数据，但参数和返回结构必须按本契约稳定下来，后续接真实业务表时不得另起一套。

## 请求

统一路径：

```http
GET /api/lists/{listKey}
```

列表引出：

```http
GET /api/lists/{listKey}/export.csv
```

引出接口复用列表查询参数，导出应用筛选和排序后的结果集，不只导出当前页。

统一参数：

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `keyword` | string | 否 | 全局关键字，按列表定义覆盖主要可搜索字段。 |
| `status` | string | 否 | 状态快速筛选，空值表示全部。 |
| `page` | number | 否 | 当前页，从 `1` 开始。 |
| `pageSize` | number | 否 | 每页条数，前端固定提供 `200/500/1000`。 |
| `view` | `header`/`detail` | 否 | 单据列表视图，默认 `header` 整单视图；`detail` 为明细视图，每行一条分录并带单头字段。 |
| `sortField` | string | 否 | 排序字段，必须是当前列表已知字段。 |
| `sortOrder` | `asc`/`desc` | 否 | 排序方向，默认 `asc`。 |
| `columnFilters` | JSON string | 否 | 列过滤条件，字段名到过滤规则的映射。 |
| `module` | string | 否 | 操作日志专用，模块代码。 |
| `action` | string | 否 | 操作日志专用，动作代码。 |
| `operator` | string | 否 | 操作日志专用，操作人包含匹配。 |
| `targetType` | string | 否 | 操作日志专用，对象类型精确匹配。 |
| `dateFrom` | date | 否 | 操作日志专用，操作日期起点。 |
| `dateTo` | date | 否 | 操作日志专用，操作日期终点。 |

`columnFilters` 示例：

```json
{
  "customer": { "operator": "包含", "value": "广州" },
  "status": { "operator": "等于", "value": "已审核" }
}
```

操作符固定为：

```text
包含、不包含、等于、不等于、以……开始、以……结束、为空、不为空
```

## 响应

```json
{
  "page": 1,
  "pageSize": 200,
  "sortField": "billNo",
  "sortOrder": "asc",
  "total": 1200,
  "rows": []
}
```

约束：

- `rows` 只返回当前页数据。
- `total` 是应用所有查询条件后的总数。
- 单据列表 `view=detail` 时，后端直查单头 join 分录，只读返回，不缓存；列筛选、分页和导出继续复用同一列表契约。
- 无权限返回 `403`，前端显示无权限态。
- 服务异常返回非 `2xx`，前端显示错误态并提供重试。
- 查询无结果返回 `200` 且 `rows=[]`、`total=0`，前端显示空态。

## 当前 stub 边界

- 真实业务查询未接入前，纯 stub 列表可在 `pageSize=1000` 时扩展样本行，用于验证前端 1000 行渲染和滚动密度。
- 已接入数据库的主数据/业务列表不得扩展样本行，必须返回真实查询结果；否则会污染选择器、粘贴匹配和业务判断。
- 库存查询未来必须接数据库余额口径，不允许业务结果缓存。
