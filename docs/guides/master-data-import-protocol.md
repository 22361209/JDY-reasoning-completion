# 基础资料 Excel 导入协议

本文固化 roadmap 6D、F008 的共享导入协议。业务范围、字段白名单和验收矩阵以 `docs/12-当前批次验收清单.md` 为准；本协议只定义实现边界、状态机和接入规则，后续入口不得另造第二套导入语义。

## 适用范围

第一阶段只覆盖物料类别、计量单位、客户、供应商、仓库、员工、账户资料和物料八类 tenant 主数据。八个列表共享唯一 `master-data-import` 工作区、同一组 `/api/master-data/import/**` 接口和 `master.data.manage` 权限，不新增独立 catalog owner；F008 保持 `surface=shared`、`catalogEntryIds=[]`。

固定边界：

- 只接受真实 OOXML `.xlsx`；`.xls`、CSV、ODS、压缩包、改扩展名、宏、公式、外链、加密或损坏文件一律拒绝。
- 一文件一类资料，只新增，不更新、不覆盖、不跳过错误行。文件内或当前账套内编码重复，整批不可确认。
- 原文件最大 10 MiB，最多 5,000 行非空数据；第 5,001 行拒绝。服务端仍执行列数、单元格长度和解压内容上限。
- 确认成功统一沿用手工新增语义：资料为 `DRAFT`、`version=0`，不自动审核。账户币种只允许 `CNY/USD`。
- 生产部门、余额、期初、汇率、BOM、单据、自定义模板、更新模式和部分成功均不属于本协议。

## 唯一定义与模板

`MasterDataImportDefinitionRegistry` 是八类导入类型、模板版本、字段白名单、表头、默认值、枚举和资源上限的后端唯一事实。预置模板由 `scripts/build-a143-master-data-import-templates.mjs` 可重复生成，每个模板固定包含：

1. `导入数据`：唯一数据 sheet；第 2 行为精确表头，第 3 行起为数据。
2. `填写说明`：字段与示例说明，不计入数据行。
3. `__meta`：隐藏、受保护，绑定 A143、资料类型、模板版本和数据行上限。

文件名和前端类型选择都不是可信事实；服务端必须核对扩展名、ZIP 签名、OOXML 部件、三个固定 sheet、`__meta`、精确表头以及禁止特性。前端只做扩展名和大小的轻量提示，不解析、Base64 化或自行决定业务合法性。

## API 与权限

所有端点类级声明 `master.data.manage`，tenant、account set、actor 和 schema 只从服务端会话与路由上下文取得，不接受客户端传入：

| 方法 | 路径 | 语义 |
| --- | --- | --- |
| GET | `/api/master-data/import/templates` | 返回八个模板元数据 |
| GET | `/api/master-data/import/templates/{type}` | 下载指定 `.xlsx` 模板 |
| POST | `/api/master-data/import/jobs/{type}/preview` | 以 multipart `file` 创建预检任务 |
| GET | `/api/master-data/import/jobs` | 当前 tenant、当前创建者的任务分页 |
| GET | `/api/master-data/import/jobs/{jobId}` | 当前创建者可见的任务和行结果 |
| GET | `/api/master-data/import/jobs/{jobId}/error-receipt` | 下载结构化 `.xlsx` 错误回执 |
| POST | `/api/master-data/import/jobs/{jobId}/confirm` | 原子确认有效预检任务 |

跨 tenant 或同 tenant 其他用户访问任务按 404 处理。未登录、无权限、结构错误、超限、状态冲突和过期分别按 401、403、400、413、409、410 返回受控 JSON，不返回堆栈、绝对路径或其他账套信息。

## 预检与状态机

预检在读取和解析工作簿前完成权限与 tenant scope 校验，只允许写 `md_import_batch` 工作流事实，业务 `md_*` 表写入必须为 0。每一行保存标准化白名单 payload 和结构化 `rowNo/field/code/message/value` 错误；任一文件或行错误都使整批不可确认。

状态精确为：

```text
preview valid   -> VALIDATED -> confirm success -> COMMITTED
preview invalid -> INVALID
VALIDATED       -> confirm revalidation drift -> STALE
VALIDATED       -> transactional failure       -> FAILED
VALIDATED/INVALID/STALE/FAILED -> timeout       -> EXPIRED
```

`canConfirm` 是服务端事实，只有当前任务仍为 `VALIDATED`、未过期且 payload 完整时才可为 true。预检令牌 30 分钟过期；详情读取和后台清理都必须把到期未提交任务转为 `EXPIRED` 并清空可提交 payload。后台清理按受管账套逐个进入 routed tenant 上下文和独立事务处理，不拼 schema、不写 public、不中断其他账套；`COMMITTED` 与未到期任务保持不变。

## 原子确认与共享创建

确认只消费服务端保存的标准化预检事实，不再次接收文件。事务内执行顺序固定为：

1. 锁定当前 tenant、当前创建者的 batch。
2. 识别已提交幂等返回、过期和非法状态。
3. 对全部行重新校验编码、唯一性、引用、枚举和数值；类别父链校验必须覆盖导入节点与既有节点形成的跨边界环。
4. 任一行失效时整批转 `STALE`，业务资料零写入。
5. 按稳定行号或类别父先子后顺序调用 `MasterDataCreateService`；导入服务不得直接维护八类业务表。
6. 全部资料创建和批次级成功日志都成功后，batch 才转 `COMMITTED` 并清空 payload。

创建业务资料、批次状态和 `CONFIRM_MASTER_DATA_IMPORT` 成功日志处于同一 tenant 事务。任一后续行、数据库约束或日志写入失败都必须整体回滚，不能留下前半批资料或伪成功状态。同一 job 的重复或并发确认只允许一次写入，后续请求幂等返回同一 `COMMITTED` 结果。

## 审计与隐私

预检和确认分别记录批次级 `PREVIEW_MASTER_DATA_IMPORT`、`CONFIRM_MASTER_DATA_IMPORT`，target 固定为 `MASTER_DATA_IMPORT` 与 batch id。日志可以记录资料类型、行数、文件摘要前缀和最终状态，不得记录标准化行 payload、完整工作簿、账号、电话、邮箱、银行信息或 scope token。权限、格式或确认失败不能伪装为成功日志。

原始工作簿不入库；batch 只保存受限标准化 payload、摘要和计数。成功或过期后清空 payload；备份恢复时所有未提交任务强制过期并清空 payload，旧令牌不得复活。

## 前端接入规则

- 八个主数据列表的“导入”动作只负责打开并预选共享工作区，不调用通用 `/api/lists/*` fallback。
- 页面固定展示 `.xlsx / 10 MiB / 5,000 行`、只新增、导入后草稿、整批原子四项边界。
- 上传使用 `FormData`；错误预览复用 `TableCore`，实际写入数只有 `COMMITTED` 可以非 0。
- 确认按钮同时服从后端 `status/canConfirm/expiresAt`；任务详情刷新、计数或网络异常时 fail-closed。
- 切换类型、关闭页签或切换账套会使当前文件/令牌失效，dirty 状态必须二次确认；`COMMITTING` 期间禁止关闭和切换账套。
- 异步上传、详情和确认必须使用 abort/serial 防止旧请求覆盖新文件；成功结果保留在最近任务中，不只显示瞬时 toast。

## 变更与验收要求

新增资料类型、字段、模板版本、导入模式、权限或状态都属于协议变更，必须先更新受版本控制合同、唯一注册表、模板生成器和测试，再实现页面或接口。任何实现不得以兼容为由放宽为覆盖、部分成功、跨账套读取或未经预检直接写入。

涉及本协议的改动至少运行 A143 静态/动态/迁移门禁、目标后端测试、frontend build、A115/A119/A128/A137/A140 兼容门禁、master-data/security/system/table area、smoke、full，以及 1366×768 与 1920×1080 浏览器可见验收；验收报告必须记录冻结失败集合与 A143 新增失败数。
