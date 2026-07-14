# 报表查询协议（A144）

本文约束 roadmap 6E 的真实报表查询、分页、合计和引出。它不把现有通用列表壳升级成“万能报表”，也不允许用 seed rows、销售订单 fallback 或跨领域拼接结果冒充业务事实。

## 1. 所有权与边界

1. 报表传输协议、分页/排序/过滤白名单、CSV 引出和统一错误形态属于现有 `com.jdy.erp.reports.api/application` 模块，不得搬入 `system` 或另造平行报表底座。
2. 每个报表的数据 SQL、字段口径、权限和钻取目标仍由对应业务域维护：销售、库存、财务、生产分别拥有自己的 adapter/definition。
3. Controller 只做 HTTP 参数、权限前置和响应封装；SQL、聚合和金额公式不得写进 Controller 或前端。
4. 前端只渲染服务端返回的 rows/totals，不在浏览器重新聚合金额、推断库存结存或混算币种。
5. 报表查询必须走 routed tenant `JdbcTemplate`；客户端不能提交 schema、account-set id 或 tenant id。
6. 未登记的 report key 返回 404。禁止回退到 `DefaultStubListQueryAdapter`、`StubListSeedRowsProvider` 或任意既有列表数据。
7. 共享底座至少分为精确 `ReportQuerySpecRegistry`、字段白名单、严格 query parser/planner、SQL executor 与固定 CSV column definition；每个业务 report key 注册自己的 spec，不允许 default switch。
8. 前端可复用 DataListPage/TableCore/筛选与列设置组件，但不能复用“只合计当前页却标成合计”的语义；报表总计一律来自服务端同谓词 totals SQL，若展示当前页小计必须明确写“本页合计”。

## 2. 首版 report key

| report key | 功能 | 真实来源 | 首版权限 |
| --- | --- | --- | --- |
| `sales-detail` | F029 销售明细 | 有效销售出库（AUDITED/legacy RED_REVERSED）与已审核销售退货头行 | `sales.order.audit` |
| `sales-summary` | F029 销售汇总 | 与销售明细相同的共享查询定义 | `sales.order.audit` |
| `sales-order-tracking` | F029 销售订单跟踪 | 已审核销售订单行及真实下游数量 | `sales.order.audit` |
| `inventory-movement-detail` | F042 商品收发明细 | `inv_stock_txn` + 主数据快照/来源定位 | `inventory.stock.view` |
| `receivable-detail` | F091 应收明细 | 销售出库过账生命周期 AR 正负事实、A141 收款核销/反审核、A142 finance allocation 冲应收及待退款状态 | `finance.report.view` |
| `receivable-summary` | F091 应收汇总 | 与应收明细相同的共享查询定义 | `finance.report.view` |
| `payable-detail` | F091 应付明细 | 正式采购/退货过账 AP 正负事实、A141 付款核销/反审核 | `finance.report.view` |
| `payable-summary` | F091 应付汇总 | 与应付明细相同的共享查询定义 | `finance.report.view` |
| `material-scrap-summary` | F061 材料报废统计 | 已审核正式材料报废单 | `production.document.audit` |

首版严格复用项目现有粗粒度权限，避免只为报表另造角色语义。report key→权限映射必须在后端 registry/state guard 中精确登记；查询和引出在任何 JDBC 业务读取前执行同一权限检查，前端 catalog 隐藏不能代替 403。

## 3. HTTP 合同

```text
GET /api/reports/{reportKey}
GET /api/reports/{reportKey}/export.csv
```

共享参数：

| 参数 | 规则 |
| --- | --- |
| `dateFrom/dateTo` | ISO 日期；`dateFrom <= dateTo`；需要日期的报表两端必填 |
| `page` | 从 1 开始 |
| `pageSize` | 20/50/100/200/500 白名单；默认 100，最大 500 |
| `sortField/sortOrder` | 每个 report key 的字段白名单；明细默认业务日期/单号/行号/真实非空 PK，汇总默认完整 group tuple 或无碰撞结果键 |
| `keyword` | 仅作用于 definition 声明的编码/名称/单号字段 |
| 业务过滤 | 每个 definition 显式声明并解析；未知参数、未知列/操作符、非法 JSON 或非法枚举返回 400 |

查询响应固定包含：

```json
{
  "reportKey": "sales-detail",
  "page": 1,
  "pageSize": 100,
  "total": 0,
  "rows": [],
  "totals": [],
  "query": {},
  "generatedAt": "2026-07-14T00:00:00Z"
}
```

- `query` 是服务端规范化后的查询回显，前端摘要条和引出必须复用它。
- `totals` 由服务端 SQL 计算；金额类按币种分别返回，不能跨 CNY/USD 相加。
- rows 与 totals 来自同一 WHERE/口径定义；不能一个查数据库、另一个在内存或前端重算。
- 空结果仍返回 200、`rows=[]/total=0/totals=[]`，前端显示明确空态。

## 4. SQL 与分页

1. adapter 必须先执行受限 count/aggregate SQL，再执行 `LIMIT/OFFSET` 行查询；不得先加载全部 rows 再在 Java 内存过滤、排序或分页。
2. 所有动态列、排序和过滤只可从 definition 白名单映射到固定 SQL 片段；用户输入不得拼表名、列名、方向或 schema。
3. count、rows、totals、export 共用同一个规范化 query object 和 predicate builder。
4. 明细 definition 的稳定排序必须以真实非空行主键收尾；汇总 definition 必须以能唯一标识结果行的完整 GROUP BY 维度 tuple 收尾，或使用由该 tuple 无碰撞构造的结果键。禁止在汇总行上塞任意 `MIN(id)` 冒充唯一键；未声明唯一稳定尾的 definition 启动即失败。
5. 日期按业务日期过滤；审计/记账时间仅作为显示或二级排序，不用它偷偷改变业务日期范围。唯一例外是 F042 正式报表可纳入的 `trace_quality=LEGACY AND source_bill_date IS NULL` 历史流水：固定 SQL 显式使用 `(occurred_at AT TIME ZONE 'Asia/Shanghai')::date` 作为“历史记账日期降级”参与筛选和显示，同时响应 `dateBasis=POSTING_FALLBACK`；其他正式行必须返回 `dateBasis=BUSINESS_DATE`。`TEST` 必须在任何日期/fallback 计算前排除，即使既有 TEST 的日期为空也绝不进入 rows/count/totals/export。该降级不得冒充业务日期、不得扩展到新流水、TEST 或其他报表，并以 UTC 跨日边界夹具证明结果不受数据库 session TimeZone 影响。
6. 默认只统计已审核/已记账事实。某报表确需未审核数据时，必须有显式 `includeDraft` 合同、独立权限和测试；6E 首版不开启。
7. tenant scope 和权限必须在 SQL 执行前确定；跨 tenant 相同业务编号仍只能返回当前 routed schema 的行。
8. keyword 多词使用 AND、每个词在 definition 声明字段间使用 OR；`%`、`_` 和转义符必须按 ILIKE 语义转义，不能扩大查询范围。
9. 报表 API 只接受 current tenant scope，不接收或忽略前端提交的 `scope/schema/accountSetId/tenantId/dataScope` 或任何 server-owned binding 名；出现即 400，不允许回落 platform JDBC，也不得进入 query echo。
10. F029 汇总、F091 期初/期间/期末等需要日期进入聚合前 source 的报表，只允许把规范化 `dateFrom/dateTo` 作为绑定参数传给固定 source SQL；“必须提供日期范围”与“外层按日期列过滤”是两个独立能力。禁止把日期、过滤值或 SQL 片段字符串拼进 source。
11. report service 进入 routed 事务前必须同时校验 tenant scope、合法 accountSetId、非空 databaseName 与 schemaName，并通过 platform JDBC 验证三者与 `sys_account_set` 当前登记精确一致；任一缺失、伪造或不匹配都在 tenant JDBC 前 fail closed，绝不把缺失 schema 回落默认 `public`。平台注册为 `public` 的合法老账套必须可用。真实集成测试同时放置合法 public 账套与 public decoy，证明只有平台注册绑定可读。
12. 即使 source SQL 来自后端固定 definition，所有关系引用也必须由保守词法/关系校验 fail closed。`FROM/JOIN`、逗号 join、括号化 JOIN tree、`ONLY (schema.table)`、`TABLE schema.table`、CTE/子查询以及 quoted/whitespace 变体中的 schema-qualified 名称全部拒绝，包括 `public.*`、`pg_catalog.*` 和其他 tenant schema；只允许 routed search path 下的无 schema 关系名。
13. foundation 必须支持受控 two-stage plan：fixed fact/source SQL → planner 在 fact 层应用 date、AND 多词 keyword 与 filters → optional fixed result/aggregate SQL（只能引用受控 fact CTE）→ result 层 count/rows/totals/export/稳定排序。每个 filter、keyword 和日期定义显式声明 `FACT/RESULT/BOTH/BOUND_ONLY` placement；汇总复用明细 predicate 时必须放 FACT，不能聚合后补滤或重复过滤。`BOUND_ONLY` 只允许把已规范化的值绑定到固定 source/result SQL 参数，或据此选择后端预注册的固定 result branch（如 dimension）；它本身不再生成外层 WHERE，绝不能影响 schema、表名、列名或拼接 SQL 片段。result SQL 与 source SQL 使用同一单语句/schema-safe 校验，任何用户值都只能作为绑定参数。definition 可声明 enum default 或 required：缺省值由服务端规范化、校验并进入 query echo，required 缺失或非法 enum 返回 400；客户端不能通过省略参数改变口径。
14. definition 可声明服务端拥有的 data-scope 参数绑定。prepare 顺序固定为 registry require → typed raw query parse → permission → platform registered route → `TenantDataScopeService.currentScopeId(namespace)` → plan/execute；任何 tenant JDBC 都只能发生在这些步骤之后。data scope 每请求只解析一次并作为 JDBC 参数传给固定 source/result SQL，同一请求的 count/rows/totals/export 全部复用该不可变快照。public/platform schema 使用该服务返回的 current accountSetId，tenant schema 使用该服务返回的 namespace-derived scope；report foundation 不得自行重算或把 tenant scope 偷换成 accountSetId。客户端不得提交、覆盖或从 query echo 获得该内部 scope。F042 的 `inv_stock_txn.account_set_id` 必须绑定 namespace=`inventory`；public 与 tenant schema 都不得只依赖 schema 隔离。public decoy 夹具必须在同一已注册 public schema 内放入两条除 `account_set_id` 外均命中相同日期与业务筛选的行为事实：一条使用 current accountSetId，一条使用另一 UUID；count/rows/totals/export 必须全部只包含合法行，不能用伪造 route 代替该数据域隔离证明。tenant schema 同样以 namespace-derived scope 与另一 UUID 做同条件正反夹具，并对 count/rows/totals/export 四路证明只包含合法行。

## 5. 引出

1. CSV 引出使用与页面完全相同的规范化 query、predicate、排序和字段口径，只取消页面 `LIMIT/OFFSET`。
2. 引出最多 20,000 行；超过上限返回 413 和明确文案，不允许静默截断或耗尽 JVM 内存。
3. CSV 使用 UTF-8 BOM、definition 固定业务列顺序、RFC 4180 转义；空结果也必须输出表头，编码、账号和单号作为文本输出，不能转科学计数。非数值文本以 `= + - @ tab CR` 等公式触发字符开头时必须中和，数据库数值类型单独按数值输出；含 tab 或其他受控字符的普通文本也必须进入引用/安全处理分支并通过 round-trip 测试。
4. 引出在保留 TenantContext 的请求线程内同步流式写出、有界临时文件或有界分块；禁止无界 `queryForList`/StringBuilder、64 MiB byte array 多次复制，也禁止把流式响应切到会丢 tenant 上下文的异步线程。全部 artifact 只能创建在专用临时目录并由单一 cleanup manager 持有；请求删除、生成阶段失败、队列满、调度拒绝或重试耗尽都不得丢失所有权，必须由受控重试、周期清扫、启动扫描和关闭清理继续接管。目录扫描必须区分本进程 active/pending 与超过受控 stale grace 的遗留文件，不得删除仍在传输的活跃 artifact。不得把带绝对路径的 cleanup exception 作为 raw/suppressed 异常外泄，清扫日志也不得包含绝对路径。
5. 页面 `total <= 20,000` 时，按相同条件导出的数据行数必须等于 total；合计必须与页面 totals 一致。
6. 引出失败、无权限、超限和网络写出错误不得生成“成功”日志；传输复制字节数必须等于 artifact 声明的 `contentLength`，不一致时在 flush/成功日志前失败。只有当前请求线程完成响应写出/flush 后才尝试记录 report key、规范化过滤摘要、结果行数和 actor，不记录整份结果。flush 后日志写入失败时，响应已提交，不得抛出或宣称一个客户端不可能收到的 HTTP 500；必须写服务端结构化告警，只含 requestId/reportKey/rowCount/actor/tenant 和安全错误分类等受限摘要，不记录 SQL、schema、绝对路径或原始异常消息，并进入运维补偿。

## 6. 金额、币种与退货

1. 可见文案遵守项目词汇：`单价`、`金额` 默认不含税，含税总额统一显示为 `含税金额`。
2. CNY 与 USD 在行、合计和汇总中按 `currency` 分组；不提供无汇率依据的跨币种总计。
3. 有效销售出库事实为 `sales_out.status IN ('AUDITED','RED_REVERSED')`；`RED_REVERSED` 只兼容历史仍生效红字（含旧 link 缺失），行内 qty/amount/tax/priceTaxTotal 已有正负号必须原样使用，不按类型再次取反。DRAFT/REVERSED/VOID 排除。`sales_return.status='AUDITED'` 的数量、金额、税额和含税金额由报表统一转为负数；不得删除原销售出库行或用绝对值冲淡方向。
4. A141 正式收款/付款核销及反审核按已审核事实进入应收/应付明细；A142 销售退货冲应收是负向 AR 调整，待退款只是状态/待办金额，不冒充已实际退款现金流。
5. 汇总等于同一查询条件下明细的服务端聚合；用精确 decimal，禁止前端浮点求和。
6. parser、normalized query、plan、JDBC bindings、executor rows/totals 在内部必须保持 `BigDecimal`，不得提前字符串化；只有 API response 的 rows、totals 与 query echo 出站边界把所有 `BigDecimal` 递归转换为 `stripTrailingZeros().toPlainString()` 语义的无指数十进制字符串，绝不经过 double/JavaScript number。page/pageSize/total 等安全整数仍为 JSON integer。CSV 不经过 response normalizer，直接从数据库 `BigDecimal.toPlainString()` 精确输出并保留有效 scale；两条路径均不得经 double。前端按十进制字符串显示，合计只使用服务端结果。

## 7. 库存来源追溯

1. F042 只能读取 `inv_stock_txn`，余额表和业务单据列表不能冒充库存流水。
2. 新正式库存流水必须保存真实 `source_bill_type/source_bill_id/source_bill_line_id/source_bill_no/source_bill_date/posting_action`，并在库存更新事务中保存 `qty_on_hand_after`。
3. 反审核/冲销流水必须能关联原流水并保留方向；不能覆盖或删除原流水来伪造历史。
4. `trace_quality` 只有五态：`EXACT/CONTROLLED/HEADER_ONLY/LEGACY/TEST`。`EXACT` 具有真实 header+line，可精确钻取；`CONTROLLED` 是受控期初等真实非单据来源，可在正式报表显示，但不得伪装成业务单据行或生成假钻取；`HEADER_ONLY` 仅能定位真实 header，不能宣称精确到行；`LEGACY` 不可精确定位。可识别的历史 `TYPE:billNo` 仅在单号唯一命中时回填 header，禁止按商品+数量猜 line。
5. 历史库存业务事实字段不可修改。既有源单保存前必须锁定 header 并确认仍为 DRAFT；非 DRAFT 直接保存 409，header/line/余额/流水/业务成功日志零变化，但 HTTP 层仍按 A136 统一失败审计仅新增一条 `SECURITY/WRITE_FAILED`。源单反审后保存若将更新/删除旧行，必须在同一 routed 事务、DRAFT guard 成功后且删改前，把引用旧 line id 的历史 `EXACT` 单向降级为 `HEADER_ONLY` 并清空 `source_bill_line_id`；source header/id/no/date、商品、仓库、数量、动作、发生时间、结存与 reversal 关系保持不变。禁止把旧事实 retarget 到新行；重新审核只为新当前行写新的 `EXACT`。已有任一历史库存流水的源单 header 不得物理删除，只有从未过账的 DRAFT 可删；删除必须 `SELECT ... FOR UPDATE`、锁内 history guard、最终 `DELETE ... WHERE status='DRAFT'` 且 rowcount=1，审核与删除并发不得产生 orphan fact。
6. `TEST` 永不作为正式报表业务事实，生产报表 SQL 默认排除；`HEADER_ONLY/LEGACY/TEST` 不得生成精确行钻取，无法定位的历史来源显示“历史流水（源单不可定位）”。
7. 新流水的结存读取 `qty_on_hand_after`；历史缺失时只能显示降级状态或使用可证明的区间前余额，日期筛选不能把区间前余额当成 0。同一 accountSet+商品+仓库的正式/受控写入必须锁定余额行后才读取旧值、计算 delta、更新余额并写流水；期初绝对值保存也不例外，且必须保留锁内既有 `qty_reserved`，令 available=new_on_hand-reserved；new_on_hand<reserved 时 409 且余额/流水/业务成功日志零变化，HTTP 层仍按 A136 统一失败审计仅新增一条 `SECURITY/WRITE_FAILED`。新事实 `occurred_at` 必须在取得该序列化锁后显式写数据库 `clock_timestamp()`，不得继承事务开始时刻 `now()` 默认。两个都成功的并发过账按 `occurred_at,id` 排序时，`qty_on_hand_after` 必须与余额更新顺序一致，最终余额必须等于基线加流水 delta 之和。来源业务表若只有 timestamptz `created_at` 可作为日期依据，必须固定用 `(created_at AT TIME ZONE 'Asia/Shanghai')::date`；Opening CONTROLLED 的日期由同一 fact `clock_timestamp()` 按 Asia/Shanghai 推导，不能使用 session `CURRENT_DATE`。UTC 跨日和不同 session TimeZone 夹具必须证明 EXACT/HEADER_ONLY/CONTROLLED 日期一致。
8. 在正式报表可纳入的流水中，`source_bill_date IS NULL` 只允许出现在迁移保留的 `LEGACY` 历史流水；其筛选/显示日期固定降级为 `(occurred_at AT TIME ZONE 'Asia/Shanghai')::date`，响应标记 `dateBasis=POSTING_FALLBACK` 并显示“历史记账日期（业务日期缺失）”。既有 `TEST` 可保留空日期，但必须在 fallback 前排除；新增 `EXACT/CONTROLLED/HEADER_ONLY` 必须有业务日期。不得静默使用 session 时区下的 `occurred_at::date`，也不得把降级日期写回或宣称为源单业务日期。
9. 可追溯来源显示真实单号并调用已有单据详情入口；未实现的来源类型只显示文本，不回退到销售订单。
10. `qty_delta=0` 的预留/释放不属于商品收发；第一版没有库存成本口径，页面和 CSV 不提供成本列，也不以 0 伪造成本。

## 8. 前端报表范式

首版共享 `ReportQueryPage`/composable，至少包含：

- 可展开筛选区、查询/重置、收起后的规范化摘要条；
- 查询中、明确空态、403、400、413、网络失败与重试；
- TableCore 结果表、黄色合计行、服务端分页、稳定排序和表内横滚；
- 引出、刷新、列设置；组合排序仅在服务端支持的白名单字段中生效；
- 单号钻取只在响应含可信 `sourceTarget/sourceBillNo` 时显示；
- 1366×768 与 1920×1080 页面本身无横向溢出，仅结果表内部横滚。

查询、翻页、排序和引出使用 abort/serial，旧响应不得覆盖新条件。切换账套后清空 rows/query/totals 并重新查询，不能展示上一账套缓存。

## 9. 报表口径

### F029 销售

- 销售明细：AUDITED/legacy RED_REVERSED 有效销售出库与已审核销售退货行；销售出库保留行内正负号、销售退货统一负数；按业务日期、客户、商品、仓库、单据类型、币种过滤。
- 销售汇总：单一 `sales-summary` key 使用 `dimension=CUSTOMER|PRODUCT_UNIT`，服务端默认/echo `CUSTOMER`。CUSTOMER 按客户+币种只汇总金额、税额、含税金额且不返回数量合计；PRODUCT_UNIT 按商品 id+单位快照+币种汇总数量、金额、税额、含税金额，禁止跨单位或币种相加，商品/客户显示名称不进入身份 tuple。日期、AND 多词 keyword、客户、商品、仓库、单据类型与币种必须在 fact 层聚合前复用明细 predicate；dimension 只作为受控默认/绑定值选择固定 result aggregate 分支，不得拼 SQL或聚合后补滤。CUSTOMER 与 PRODUCT_UNIT 的金额 totals 均按 CNY、USD 分组，不提供无汇率折算总计。第一版不做销售排行、利润或无可信成本字段。
- 订单跟踪：只取已审核订单行和可追溯的真实下游审核事实。令 `N` 为按来源订单号+行号聚合的已审核发货通知数量，`O` 为按订单号+行号聚合的有效销售出库 signed 数量（AUDITED/legacy RED_REVERSED，保留行符号），`D` 为 `O` 中未匹配到有效已审核发货通知来源的 legacy 直接出库 signed 数量，`R` 为已审核销售退货经 `source_out_line_id` 回溯到订单行的正数量；固定公式为 `executedQty=N+D`、`shippedQty=O`、`returnedQty=R`、`netDeliveredQty=O-R`、`unexecutedQty=max(orderQty-executedQty,0)`、`executedUnshippedQty=max(executedQty-shippedQty,0)`。不得以商品+数量猜配缺失 trace，也不得用订单行冗余 shipped counter 替代真实下游聚合；超订单、负数或 shippedQty>executedQty 等原始异常必须返回 `INCONSISTENT`，不能被 max 静默隐藏。日期范围只过滤订单业务日期，下游数量表示查询时当前状态；`remainingDeliveryDays=planDeliveryDate-(CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Shanghai')::date`。tracking 不做跨单位 totals。

### F042 商品收发明细

- 按业务日期、来源类型/单号、商品、仓库过滤；显示入库数量、出库数量、结存、来源单号与追溯状态。仅 `LEGACY + source_bill_date IS NULL` 使用明确标记的历史记账日期降级，页面/CSV 必须显示 `POSTING_FALLBACK` 提示。
- 正式报表可显示 `EXACT/CONTROLLED/HEADER_ONLY/LEGACY`，其中只有 `EXACT` 可精确钻取；生产报表默认排除 `TEST`。
- 只解释正式库存流水；预约/锁定数量变化若 `qty_delta=0`，不得当作出入库数量。

### F091 应收应付

- 应收明细/汇总按客户+币种，只包含销售出库审核/反审/红字/红字反审过账写入的 `ar_receivable` 正负事实、A141 收款核销/反审核，以及 A142 `sales_return_finance_allocation` 的冲应收/待退款状态；应付明细/汇总按供应商+币种，只包含采购入库/采购退货生命周期过账写入的 `ap_payable` 正负事实和 A141 付款核销/反审核。AR/AP `amount` 的既有正负号必须原样保留，不得再按来源类型重复取反。
- `ar_receivable.status/ap_payable.status` 只有 `OPEN/PART_SETTLED/SETTLED`，表达结算进度而非审核生命周期；禁止用 `status='AUDITED'` 查询 AR/AP，未审核源单不会生成 AR/AP 事实。
- 应收余额事件增量=`ar_receivable.amount`（带符号）- 已审核 receipt allocation.`settlement_amount` - 已审核 `sales_return` finance allocation.`offset_amount`；应付余额事件增量=`ap_payable.amount`（带符号）- 已审核 payment allocation.`settlement_amount`。A142 不创建 `ar_receivable` 行，禁止把销售退货同时算作负 AR 事实和 `offset_amount` 双重扣减；`pending_refund_amount` 单独展示，绝不进入 AR 余额或现金流。
- 期间明细按事件日期和父单审核状态重建：AR/AP 发生日期取来源 `bill_date`；A141 allocation 只在 receipt/payment parent header `status=AUDITED` 时生效，日期取 parent `bill_date`，反审核回 `DRAFT` 后退出；A142 finance allocation 只在 `sales_return.status=AUDITED` 时生效，日期取 return `bill_date`。
- 期初=所有 `dateFrom` 之前上述事件增量之和，期间=`dateFrom..dateTo` 上述事件增量之和，期末=期初+期间净额，按 CNY/USD 分组。禁止使用 AR/AP 当前 `received_amount/paid_amount/return_offset_amount` 快照重建期初或期间，也禁止同时读取快照与 allocation 重复扣减。
- 实际收款退款单/付款退款单、预收/预付、其他应收/其他应付和任何未交付事实不进入 6E 首版，禁止伪造空行填补。
- A141 审核/反审核、A142 冲应收/反审核后的汇总必须与同条件明细聚合一致；待退款不计为已退款，首版不发布预警表。

### F061 材料报废统计

- 只有正式材料报废业务达到 A4 后才登记 report key 和入口。
- 只统计已审核材料报废行；按业务日期、业务类型、生产车间、商品、报废原因过滤并汇总基本数量。
- 草稿、已反审核/作废单不得进入统计；是否入库分支不能改变报废数量统计方向。
- 已确认库存语义：报废审核本身不再次扣库存；`isStockIn=false` 零库存流水，`isStockIn=true` 也只进入待入库，必须由独立“报废入库”动作入指定报废仓，撤销入库写精确反向流水。该分支不改变报废数量统计方向。

## 10. 错误与日志

| 状态 | 含义 |
| --- | --- |
| 400 | 日期、枚举、分页、排序或过滤非法 |
| 401 | 未登录 |
| 403 | 缺少当前 report key 的后端权限 |
| 404 | report key 未登记或可信钻取目标不存在 |
| 409 | 来源状态变化导致动作冲突；只用于有写动作的业务闭环 |
| 413 | 引出结果超过 20,000 行 |

响应不得包含 SQL、schema、绝对路径、堆栈或其他 tenant 信息。查询本身不写操作日志；成功引出和报表相关设置变更写受限日志。

## 11. 自动化底线

每个 report key 至少覆盖：

1. 真实业务夹具与预期 rows/totals 精确一致；
2. 过滤、排序、分页和空态；
3. 页面 total/totals 与同条件 CSV 一致；
4. 无权限 403、未知 key 404、非法参数 400、导出超限 413；
5. 两 tenant 使用相同单号时隔离；
6. 凡包含金额/币种的 report key 覆盖 CNY/USD 分组且无跨币种合计；F042/F061 等纯数量报表不伪造 currency，必须按商品基本单位/单位快照分组且无跨单位合计；
7. SQL 门禁证明没有 seed-all、内存分页或 fallback；
8. fixture、用户、权限、日志和租户残留为 0。

F042 额外覆盖真实来源定位、历史不可定位标记、反审核冲销和区间前余额；F029 覆盖退货负数及跨单位数量不相加；F091 覆盖 A141 收付款核销/反审核、A142 冲应收及待退款状态，并证明未交付资金事实零伪造；F061 覆盖草稿不统计、审核统计、反审核剔除、重复/并发和源单超量。
