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
        { id: "sales-return-form", label: "销售退货申请", module: "销售管理", mode: "form" }
      ] },
      { title: "报表查询", entries: [
        { id: "sales-detail-report", label: "销售明细表", module: "销售管理", mode: "report", queryable: true },
        { id: "sales-profit-report", label: "销售利润表", module: "销售管理", mode: "report" }
      ] }
    ]
  },
  {
    name: "采购管理",
    short: "采",
    groups: [
      { title: "采购业务", entries: [
        { id: "purchase-order-form", label: "采购订单", module: "采购管理", mode: "form", queryable: true, dirty: true, permission: "purchase.order.audit" },
        { id: "purchase-in-form", label: "采购入库单", module: "采购管理", mode: "form", queryable: true, dirty: true, permission: "purchase.in.audit" },
        { id: "purchase-return-form", label: "采购退货单", module: "采购管理", mode: "form" }
      ] },
      { title: "报表查询", entries: [
        { id: "purchase-summary-report", label: "采购汇总表", module: "采购管理", mode: "report", queryable: true }
      ] }
    ]
  },
  {
    name: "库存管理",
    short: "库",
    groups: [
      { title: "库存业务", entries: [
        { id: "inventory-query-list", label: "库存查询", module: "库存管理", mode: "report", queryable: true, permission: "inventory.stock.view" },
        stockAlertListEntry,
        { id: "stock-transfer-form", label: "调拨单", module: "库存管理", mode: "form", queryable: true, dirty: true, permission: "inventory.stock_transfer.audit" },
        { id: "stock-count-form", label: "盘点单", module: "库存管理", mode: "form", queryable: true, dirty: true, permission: "inventory.stock_count.audit" },
        { id: "stock-count-gain-form", label: "盘盈单", module: "库存管理", mode: "form", queryable: true, dirty: true, permission: "inventory.stock_count_gain.audit" },
        { id: "stock-count-loss-form", label: "盘亏单", module: "库存管理", mode: "form", queryable: true, dirty: true, permission: "inventory.stock_count_loss.audit" },
        { id: "other-in-form", label: "其他入库单", module: "库存管理", mode: "form", queryable: true, dirty: true, permission: "inventory.other_stock_in.audit" },
        { id: "other-out-form", label: "其他出库单", module: "库存管理", mode: "form", queryable: true, dirty: true, permission: "inventory.other_stock_out.audit" }
      ] },
      { title: "流水报表", entries: [
        { id: "stock-flow-report", label: "商品收发明细表", module: "库存管理", mode: "report", queryable: true },
        { id: "scrap-report", label: "材料报废统计表", module: "库存管理", mode: "report" }
      ] }
    ]
  },
  {
    name: "应收应付",
    short: "款",
    groups: [
      { title: "往来单据", entries: [
        { id: "receivable-list", label: "应收单", module: "应收应付", mode: "list", queryable: true, permission: "finance.report.view" },
        { id: "payable-list", label: "应付单", module: "应收应付", mode: "list", queryable: true, permission: "finance.report.view" }
      ] },
      { title: "往来报表", entries: [
        { id: "ar-summary-report", label: "应收汇总表", module: "应收应付", mode: "report", queryable: true, permission: "finance.report.view" }
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
        { id: "product-in-form", label: "产品入库单", module: "生产管理", mode: "form", queryable: true, permission: "production.document.audit" }
      ] },
      { title: "BOM 与报表", entries: [
        { id: "bom-list", label: "BOM维护", module: "生产管理", mode: "list", queryable: true },
        { id: "task-track-report", label: "生产任务跟踪表", module: "生产管理", mode: "report", queryable: true }
      ] }
    ]
  },
  {
    name: "委外管理",
    short: "委",
    groups: [
      { title: "委外业务", entries: [
        { id: "outsourcing-order-form", label: "委外订单", module: "委外管理", mode: "form", queryable: true },
        { id: "outsourcing-in-list", label: "委外入库单", module: "委外管理", mode: "list", queryable: true }
      ] }
    ]
  },
  {
    name: "基础资料",
    short: "资",
    groups: [
      { title: "资料维护", entries: [
        { id: "product-master-list", label: "商品资料", module: "基础资料", mode: "list", queryable: true, permission: "master.data.manage" },
        { id: "customer-master-list", label: "客户", module: "基础资料", mode: "list", queryable: true, permission: "master.data.manage" },
        { id: "supplier-master-list", label: "供应商", module: "基础资料", mode: "list", queryable: true, permission: "master.data.manage" },
        { id: "warehouse-master-list", label: "仓库", module: "基础资料", mode: "list", queryable: true, permission: "master.data.manage" }
      ] }
    ]
  },
  {
    name: "系统设置",
    short: "设",
    groups: [
      { title: "系统基础", entries: [
        { id: "coding-rule-list", label: "编码规则", module: "系统设置", mode: "list", queryable: true },
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
