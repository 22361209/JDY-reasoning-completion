import { stockAlertListEntry } from "./inventory/stock-alert/definition";

export const moduleCatalog = [
  {
    name: "销售管理",
    short: "销",
    groups: [
      { title: "销售业务", entries: [
        { id: "sales-quote-form", label: "销售报价单", module: "销售管理", mode: "form", queryable: true, dirty: true, permission: "sales.order.audit" },
        { id: "sales-order-form", label: "销售订单", module: "销售管理", mode: "form", queryable: true, dirty: true, permission: "sales.order.audit" },
        { id: "delivery-notice-form", label: "发货通知单", module: "销售管理", mode: "form", queryable: true, dirty: true, permission: "sales.out.audit" },
        { id: "sales-out-form", label: "销售出库单", module: "销售管理", mode: "form", queryable: true, dirty: true, permission: "sales.out.audit" },
        { id: "sales-return-form", label: "销售退货单", module: "销售管理", mode: "form", queryable: true, dirty: true, permission: "sales.out.audit" }
      ] },
      { title: "报表查询", entries: [
        { id: "sales-detail", label: "销售明细", module: "销售管理", mode: "report", queryable: true, permission: "sales.order.audit" },
        { id: "sales-summary", label: "销售汇总", module: "销售管理", mode: "report", queryable: true, permission: "sales.order.audit" },
        { id: "sales-order-tracking", label: "销售订单跟踪", module: "销售管理", mode: "report", queryable: true, permission: "sales.order.audit" }
      ] }
    ]
  },
  {
    name: "采购管理",
    short: "采",
    groups: [
      { title: "采购业务", entries: [
        { id: "purchase-requisition-list", label: "采购申请单", module: "采购管理", mode: "list", queryable: true, permission: "purchase.order.audit" },
        { id: "purchase-order-form", label: "采购订单", module: "采购管理", mode: "form", queryable: true, dirty: true, permission: "purchase.order.audit" },
        { id: "purchase-in-form", label: "采购入库单", module: "采购管理", mode: "form", queryable: true, dirty: true, permission: "purchase.in.audit" },
        { id: "purchase-return-form", label: "采购退货单", module: "采购管理", mode: "form", queryable: true, dirty: true, permission: "purchase.return.audit" }
      ] },
      { title: "报表查询", entries: [
        { id: "purchase-summary-report", label: "采购汇总表", module: "采购管理", mode: "report", queryable: true, permission: "purchase.order.audit" }
      ] }
    ]
  },
  {
    name: "库存管理",
    short: "库",
    groups: [
      { title: "库存业务", entries: [
        { id: "inventory-query-list", label: "库存查询", module: "库存管理", mode: "report", queryable: true, permission: "inventory.stock.view" },
        { id: "opening-stock-settings", label: "库存期初数", module: "库存管理", mode: "shell", permission: "inventory.opening_stock.manage" },
        stockAlertListEntry,
        { id: "stock-transfer-form", label: "调拨单", module: "库存管理", mode: "form", queryable: true, dirty: true, permission: "inventory.stock_transfer.audit" },
        { id: "stock-count-form", label: "盘点单", module: "库存管理", mode: "form", queryable: true, dirty: true, permission: "inventory.stock_count.audit" },
        { id: "stock-count-gain-form", label: "盘盈单", module: "库存管理", mode: "form", queryable: true, dirty: true, permission: "inventory.stock_count_gain.audit" },
        { id: "stock-count-loss-form", label: "盘亏单", module: "库存管理", mode: "form", queryable: true, dirty: true, permission: "inventory.stock_count_loss.audit" },
        { id: "other-in-form", label: "其他入库单", module: "库存管理", mode: "form", queryable: true, dirty: true, permission: "inventory.other_stock_in.audit" },
        { id: "other-out-form", label: "其他出库单", module: "库存管理", mode: "form", queryable: true, dirty: true, permission: "inventory.other_stock_out.audit" }
      ] },
      { title: "报表查询", entries: [
        { id: "inventory-movement-detail", label: "商品收发明细", module: "库存管理", mode: "report", queryable: true, permission: "inventory.stock.view" }
      ] }
    ]
  },
  {
    name: "应收应付",
    short: "款",
    groups: [
      { title: "往来单据", entries: [
        { id: "ar-receipt-form", label: "收款单", module: "应收应付", mode: "form", queryable: true, dirty: true, permissions: ["finance.report.view", "finance.settle"] },
        { id: "ap-payment-form", label: "付款单", module: "应收应付", mode: "form", queryable: true, dirty: true, permissions: ["finance.report.view", "finance.settle"] },
        { id: "cash-transfer-form", label: "资金转账单", module: "应收应付", mode: "form", dirty: true, permission: "finance.cash_transfer.audit" }
      ] },
      { title: "报表查询", entries: [
        { id: "receivable-detail", label: "应收明细", module: "应收应付", mode: "report", queryable: true, permission: "finance.report.view" },
        { id: "receivable-summary", label: "应收汇总", module: "应收应付", mode: "report", queryable: true, permission: "finance.report.view" },
        { id: "payable-detail", label: "应付明细", module: "应收应付", mode: "report", queryable: true, permission: "finance.report.view" },
        { id: "payable-summary", label: "应付汇总", module: "应收应付", mode: "report", queryable: true, permission: "finance.report.view" }
      ] }
    ]
  },
  {
    name: "生产管理",
    short: "产",
    groups: [
      { title: "生产执行", entries: [
        { id: "production-plan-list", label: "生产计划", module: "生产管理", mode: "list", queryable: true, permission: "production.task.audit" },
        { id: "production-task-form", label: "生产任务单", module: "生产管理", mode: "form", queryable: true, permission: "production.task.audit" },
        { id: "material-issue-form", label: "生产领料单", module: "生产管理", mode: "form", queryable: true, permission: "production.document.audit" },
        { id: "material-scrap-form", label: "材料报废单", module: "生产管理", mode: "form", queryable: true, dirty: true, permission: "production.document.audit" },
        { id: "product-in-form", label: "产品入库单", module: "生产管理", mode: "form", queryable: true, permission: "production.document.audit" }
      ] },
      { title: "BOM 与报表", entries: [
        { id: "bom-list", label: "BOM维护", module: "生产管理", mode: "list", queryable: true },
        { id: "kit-analysis-list", label: "齐套分析", module: "生产管理", mode: "list", queryable: true, permission: "production.task.audit" },
        { id: "task-track-report", label: "生产任务跟踪表", module: "生产管理", mode: "report", queryable: true, permission: "production.task.audit" },
        { id: "material-scrap-summary", label: "材料报废统计", module: "生产管理", mode: "report", queryable: true, permission: "production.document.audit" }
      ] }
    ]
  },
  {
    name: "委外管理",
    short: "委",
    groups: [
      { title: "委外业务", entries: [
        { id: "outsourcing-work-order-list", label: "委外加工单", module: "委外管理", mode: "list", queryable: true, permission: "production.document.audit" },
        { id: "outsourcing-issue-list", label: "委外发料单", module: "委外管理", mode: "list", queryable: true, permission: "production.document.audit" },
        { id: "outsourcing-receipt-list", label: "委外产品入库单", module: "委外管理", mode: "list", queryable: true, permission: "production.document.audit" },
        { id: "outsourcing-return-list", label: "委外产品退货单", module: "委外管理", mode: "list", queryable: true, permission: "production.document.audit" },
        { id: "outsourcing-scrap-list", label: "委外产品报废单", module: "委外管理", mode: "list", queryable: true, permission: "production.document.audit" }
      ] }
    ]
  },
  {
    name: "基础资料",
    short: "资",
    groups: [
      { title: "资料维护", entries: [
        { id: "product-master-list", label: "物料资料", module: "基础资料", mode: "list", queryable: true, permission: "master.data.manage" },
        { id: "product-category-list", label: "物料类别", module: "基础资料", mode: "list", queryable: true, permission: "master.data.manage" },
        { id: "unit-master-list", label: "计量单位", module: "基础资料", mode: "list", queryable: true, permission: "master.data.manage" },
        { id: "customer-master-list", label: "客户", module: "基础资料", mode: "list", queryable: true, permission: "master.data.manage" },
        { id: "supplier-master-list", label: "供应商", module: "基础资料", mode: "list", queryable: true, permission: "master.data.manage" },
        { id: "warehouse-master-list", label: "仓库", module: "基础资料", mode: "list", queryable: true, permission: "master.data.manage" },
        { id: "production-department-list", label: "生产部门", module: "基础资料", mode: "list", queryable: true, permission: "master.data.manage" },
        { id: "employee-master-list", label: "员工", module: "基础资料", mode: "list", queryable: true, permissions: ["master.data.manage", "system.role_permission.manage"] },
        { id: "financial-account-master-list", label: "账户资料", module: "基础资料", mode: "list", queryable: true, permissions: ["master.data.manage", "finance.settle"] }
      ] }
    ]
  },
  {
    name: "系统设置",
    short: "设",
    groups: [
      { title: "系统基础", entries: [
        { id: "account-set-settings", label: "账套管理", module: "系统设置", mode: "shell", permission: "system.account_set.manage" },
        { id: "numbering-rule-settings", label: "单据编号规则", module: "系统设置", mode: "shell", permission: "system.numbering_rule.manage" },
        { id: "security-settings", label: "安全设置", module: "系统设置", mode: "shell", permission: "system.security.manage" },
        { id: "notification-provider-settings", label: "通知供应商", module: "系统设置", mode: "shell", permission: "system.notification_provider.manage" },
        { id: "user-role-list", label: "用户角色", module: "系统设置", mode: "shell", permission: "system.role_permission.manage" },
        { id: "role-permission-settings", label: "权限矩阵", module: "系统设置", mode: "shell", permission: "system.role_permission.manage" },
        { id: "operation-log-list", label: "操作日志", module: "系统设置", mode: "list", queryable: true, permission: "system.audit_log.view" },
        { id: "print-template-settings", label: "打印模板", module: "系统设置", mode: "shell", permission: "system.print_template.manage" }
      ] }
    ]
  },
  {
    name: "快捷应用",
    short: "快",
    groups: [
      { title: "可见壳层", entries: [
        { id: "quick-sales-shell", label: "销售快速发起", module: "快捷应用", mode: "shell" },
        { id: "quick-purchase-shell", label: "采购快速发起", module: "快捷应用", mode: "shell" }
      ] }
    ]
  }
];

export const excludedModuleNames: string[] = [];

export const excludedModules = excludedModuleNames.map((name) => ({
  name,
  short: name.slice(0, 1),
  excluded: true,
  groups: []
}));
