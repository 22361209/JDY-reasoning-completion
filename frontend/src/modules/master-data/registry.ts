import ProductMasterForm from "./product/ProductMasterForm.vue";
import { productMasterFields } from "./product/fields";
import { productCategoryFields } from "./product-category/fields";
import { unitMasterFields } from "./unit/fields";
import CustomerMasterForm from "./customer/CustomerMasterForm.vue";
import { customerMasterFields } from "./customer/fields";
import SupplierMasterForm from "./supplier/SupplierMasterForm.vue";
import { supplierMasterFields } from "./supplier/fields";
import WarehouseMasterForm from "./warehouse/WarehouseMasterForm.vue";
import { warehouseMasterFields } from "./warehouse/fields";
import { productionDepartmentFields } from "./production-department/fields";
import { employeeMasterFields } from "./employee/fields";
import { financialAccountMasterFields } from "./financial-account/fields";
import type { MasterDataDefinition } from "./types";

const MASTER_DATA_MAINTAIN_PERMISSION = "master.data.manage";

const employeeDefinition: Omit<MasterDataDefinition, "listKey"> = {
  type: "employee",
  maintainPermission: MASTER_DATA_MAINTAIN_PERMISSION,
  title: "员工",
  keywordPlaceholder: "员工编码、姓名、岗位、部门",
  statuses: ["启用", "禁用"],
  listColumns: [
    { field: "systemNo", title: "系统编号", width: 110, visible: true },
    { field: "code", title: "员工编码", width: 140, fixed: "left", visible: true },
    { field: "name", title: "员工姓名", width: 160, visible: true },
    { field: "position", title: "岗位", width: 140, visible: true },
    { field: "department", title: "部门", width: 160, visible: true },
    { field: "phone", title: "手机", width: 150, visible: true },
    { field: "email", title: "邮箱", width: 200, visible: false },
    { field: "remark", title: "备注", width: 200, visible: false },
    { field: "status", title: "状态", width: 90, visible: true },
    { field: "auditStatus", title: "审核状态", width: 100, visible: true },
    { field: "updatedAt", title: "最近更新时间", width: 160, visible: true }
  ],
  selectorColumns: [
    { field: "code", title: "员工编码", width: 140, visible: true },
    { field: "name", title: "员工姓名", width: 170, visible: true },
    { field: "position", title: "岗位", width: 140, visible: true },
    { field: "department", title: "部门", width: 160, visible: true }
  ],
  fields: employeeMasterFields,
  sparsePatch: true,
  allowDelete: false
};

const financialAccountDefinition: Omit<MasterDataDefinition, "listKey"> = {
  type: "financialAccount",
  maintainPermission: MASTER_DATA_MAINTAIN_PERMISSION,
  title: "账户资料",
  keywordPlaceholder: "账户编码、账户名称、开户行、账号",
  statuses: ["启用", "禁用"],
  listColumns: [
    { field: "systemNo", title: "系统编号", width: 110, visible: true },
    { field: "code", title: "账户编码", width: 140, fixed: "left", visible: true },
    { field: "name", title: "账户名称", width: 180, visible: true },
    { field: "accountType", title: "账户类型", width: 120, visible: true },
    { field: "bankName", title: "开户行", width: 180, visible: true },
    { field: "accountNo", title: "账号", width: 190, visible: true },
    { field: "accountHolder", title: "户名", width: 180, visible: true },
    { field: "currency", title: "币种", width: 90, visible: true },
    { field: "remark", title: "备注", width: 200, visible: false },
    { field: "status", title: "状态", width: 90, visible: true },
    { field: "auditStatus", title: "审核状态", width: 100, visible: true },
    { field: "updatedAt", title: "最近更新时间", width: 160, visible: true }
  ],
  selectorColumns: [
    { field: "code", title: "账户编码", width: 140, visible: true },
    { field: "name", title: "账户名称", width: 180, visible: true },
    { field: "accountType", title: "账户类型", width: 120, visible: true },
    { field: "currency", title: "币种", width: 90, visible: true },
    { field: "bankName", title: "开户行", width: 180, visible: true }
  ],
  fields: financialAccountMasterFields,
  sparsePatch: true,
  allowDelete: false
};

export const masterDataDefinitions: Record<string, MasterDataDefinition> = {
  "product-master-list": {
    listKey: "product-master-list",
    type: "product",
    maintainPermission: MASTER_DATA_MAINTAIN_PERMISSION,
    title: "物料资料",
    keywordPlaceholder: "物料编码、物料名称、规格型号",
    statuses: ["启用", "禁用"],
    listColumns: [
      { field: "systemNo", title: "系统编号", width: 110, visible: true },
      { field: "code", title: "物料编码", width: 140, fixed: "left", visible: true },
      { field: "category", title: "物料类别", width: 120, visible: true },
      { field: "spec", title: "规格型号", width: 150, visible: true },
      { field: "defaultSupplierCode", title: "默认供应商", width: 150, visible: true },
      { field: "name", title: "物料名称", width: 170, visible: true },
      { field: "defaultWarehouseCode", title: "默认仓库", width: 130, visible: true },
      { field: "status", title: "禁用状态", width: 90, visible: true },
      { field: "auditStatus", title: "审核状态", width: 100, visible: true },
      { field: "minStockQty", title: "最低库存数量", width: 120, align: "right", visible: false },
      { field: "maxStockQty", title: "最高库存数量", width: 120, align: "right", visible: false },
      { field: "isProduce", title: "可自制", width: 86, visible: true },
      { field: "safetyStockQty", title: "安全库存", width: 110, align: "right", visible: false },
      { field: "unit", title: "库存单位", width: 90, visible: true },
      { field: "netWeight", title: "净重", width: 90, align: "right", visible: true },
      { field: "grossWeight", title: "毛重", width: 90, align: "right", visible: true },
      { field: "surfaceTreatment", title: "表面处理", width: 130, visible: true },
      { field: "taxRate", title: "进项税率", width: 90, align: "right", visible: false },
      { field: "isPurchase", title: "可采购", width: 86, visible: true },
      { field: "isSale", title: "可销售", width: 86, visible: true },
      { field: "isInventory", title: "可库存", width: 86, visible: true },
      { field: "isSubcontract", title: "可委外", width: 86, visible: true },
      { field: "defaultWorkshop", title: "默认生产车间", width: 140, visible: true },
      { field: "purchasePrice", title: "采购价", width: 110, align: "right", visible: false },
      { field: "costPrice", title: "参考成本", width: 110, align: "right", visible: false },
      { field: "minSalePrice", title: "最低销售价", width: 120, align: "right", visible: false },
      { field: "drawingFileName", title: "图纸", width: 160, visible: false },
      { field: "imageFileNames", title: "图片", width: 180, visible: false },
      { field: "updatedAt", title: "最近更新时间", width: 160, visible: true }
    ],
    selectorColumns: [
      { field: "systemNo", title: "系统编号", width: 110, visible: false },
      { field: "code", title: "物料编码", width: 140, visible: true },
      { field: "name", title: "物料名称", width: 180, visible: true },
      { field: "spec", title: "规格型号", width: 160, visible: true },
      { field: "unit", title: "单位", width: 80, visible: true },
      { field: "netWeight", title: "净重", width: 90, align: "right", visible: false },
      { field: "grossWeight", title: "毛重", width: 90, align: "right", visible: false },
      { field: "category", title: "物料类别", width: 120, visible: true }
    ],
    fields: productMasterFields,
    sparsePatch: true,
    formComponent: ProductMasterForm
  },
  "product-category-list": {
    listKey: "product-category-list",
    type: "productCategory",
    maintainPermission: MASTER_DATA_MAINTAIN_PERMISSION,
    title: "物料类别",
    keywordPlaceholder: "类别编码、类别名称",
    statuses: ["启用", "禁用"],
    listColumns: [
      { field: "code", title: "类别编码", width: 130, fixed: "left", visible: true },
      { field: "name", title: "类别名称", width: 180, visible: true },
      { field: "parentCode", title: "上级类别编码", width: 130, visible: true },
      { field: "sortNo", title: "排序", width: 80, align: "right", visible: true },
      { field: "status", title: "状态", width: 90, visible: true },
      { field: "auditStatus", title: "审核状态", width: 100, visible: true },
      { field: "remark", title: "备注", width: 180, visible: false },
      { field: "updatedAt", title: "最近更新时间", width: 160, visible: true }
    ],
    selectorColumns: [
      { field: "code", title: "类别编码", width: 130, visible: true },
      { field: "name", title: "类别名称", width: 180, visible: true }
    ],
    fields: productCategoryFields
  },
  "unit-master-list": {
    listKey: "unit-master-list",
    type: "unit",
    maintainPermission: MASTER_DATA_MAINTAIN_PERMISSION,
    title: "计量单位",
    keywordPlaceholder: "搜索基本单位",
    statuses: ["启用", "禁用"],
    listColumns: [
      { field: "code", title: "单位名称", width: 180, fixed: "left", visible: true },
      { field: "decimalPlaces", title: "数量小数位", width: 120, align: "right", visible: true },
      { field: "sortNo", title: "排序", width: 80, align: "right", visible: false },
      { field: "status", title: "状态", width: 90, visible: true },
      { field: "auditStatus", title: "审核状态", width: 100, visible: true },
      { field: "remark", title: "备注", width: 180, visible: false },
      { field: "updatedAt", title: "最近更新时间", width: 160, visible: true }
    ],
    selectorColumns: [
      { field: "code", title: "单位名称", width: 180, visible: true },
      { field: "decimalPlaces", title: "数量小数位", width: 120, align: "right", visible: true }
    ],
    fields: unitMasterFields,
    sparsePatch: true
  },
  "customer-master-list": {
    listKey: "customer-master-list",
    type: "customer",
    maintainPermission: MASTER_DATA_MAINTAIN_PERMISSION,
    title: "客户",
    keywordPlaceholder: "客户编码、客户名称、联系人",
    statuses: ["启用", "禁用"],
    listColumns: [
      { field: "systemNo", title: "系统编号", width: 110, visible: true },
      { field: "code", title: "客户编码", width: 140, fixed: "left", visible: true },
      { field: "name", title: "客户名称", width: 240, visible: true },
      { field: "contact", title: "联系人", width: 120, visible: true },
      { field: "phone", title: "电话", width: 150, visible: true },
      { field: "region", title: "地区", width: 150, visible: true },
      { field: "address", title: "地址", width: 220, visible: false },
      { field: "remark", title: "备注", width: 180, visible: false },
      { field: "status", title: "状态", width: 100, visible: true },
      { field: "auditStatus", title: "审核状态", width: 100, visible: true }
    ],
    selectorColumns: [
      { field: "systemNo", title: "系统编号", width: 110, visible: false },
      { field: "code", title: "客户编码", width: 140, visible: true },
      { field: "name", title: "客户名称", width: 220, visible: true },
      { field: "contact", title: "联系人", width: 120, visible: true },
      { field: "phone", title: "电话", width: 140, visible: true }
    ],
    fields: customerMasterFields,
    sparsePatch: true,
    formComponent: CustomerMasterForm
  },
  "supplier-master-list": {
    listKey: "supplier-master-list",
    type: "supplier",
    maintainPermission: MASTER_DATA_MAINTAIN_PERMISSION,
    title: "供应商",
    keywordPlaceholder: "供应商编码、供应商名称、联系人",
    statuses: ["启用", "禁用"],
    listColumns: [
      { field: "systemNo", title: "系统编号", width: 110, visible: true },
      { field: "code", title: "供应商编码", width: 150, fixed: "left", visible: true },
      { field: "name", title: "供应商名称", width: 240, visible: true },
      { field: "contact", title: "联系人", width: 120, visible: true },
      { field: "phone", title: "电话", width: 150, visible: true },
      { field: "address", title: "地址", width: 220, visible: false },
      { field: "remark", title: "备注", width: 180, visible: false },
      { field: "status", title: "状态", width: 100, visible: true },
      { field: "auditStatus", title: "审核状态", width: 100, visible: true }
    ],
    selectorColumns: [
      { field: "systemNo", title: "系统编号", width: 110, visible: false },
      { field: "code", title: "供应商编码", width: 150, visible: true },
      { field: "name", title: "供应商名称", width: 220, visible: true },
      { field: "contact", title: "联系人", width: 120, visible: true },
      { field: "phone", title: "电话", width: 140, visible: true }
    ],
    fields: supplierMasterFields,
    sparsePatch: true,
    formComponent: SupplierMasterForm
  },
  "warehouse-master-list": {
    listKey: "warehouse-master-list",
    type: "warehouse",
    maintainPermission: MASTER_DATA_MAINTAIN_PERMISSION,
    title: "仓库",
    keywordPlaceholder: "仓库编码、仓库名称",
    statuses: ["启用", "禁用"],
    listColumns: [
      { field: "systemNo", title: "系统编号", width: 110, visible: true },
      { field: "code", title: "仓库编码", width: 140, fixed: "left", visible: true },
      { field: "name", title: "仓库名称", width: 220, visible: true },
      { field: "warehouseType", title: "仓库类型", width: 110, visible: true },
      { field: "manager", title: "仓管员", width: 110, visible: true },
      { field: "address", title: "仓库地址", width: 220, visible: false },
      { field: "remark", title: "备注", width: 180, visible: false },
      { field: "status", title: "状态", width: 100, visible: true },
      { field: "auditStatus", title: "审核状态", width: 100, visible: true }
    ],
    selectorColumns: [
      { field: "systemNo", title: "系统编号", width: 110, visible: false },
      { field: "code", title: "仓库编码", width: 140, visible: true },
      { field: "name", title: "仓库名称", width: 200, visible: true },
      { field: "warehouseType", title: "仓库类型", width: 110, visible: true },
      { field: "manager", title: "仓管员", width: 110, visible: true }
    ],
    fields: warehouseMasterFields,
    sparsePatch: true,
    formComponent: WarehouseMasterForm
  },
  "production-department-list": {
    listKey: "production-department-list",
    type: "productionDepartment",
    maintainPermission: MASTER_DATA_MAINTAIN_PERMISSION,
    title: "生产部门",
    keywordPlaceholder: "部门编码、部门名称、负责人",
    statuses: ["启用", "禁用"],
    listColumns: [
      { field: "systemNo", title: "系统编号", width: 110, visible: true },
      { field: "code", title: "部门编码", width: 140, fixed: "left", visible: true },
      { field: "name", title: "部门名称", width: 200, visible: true },
      { field: "manager", title: "负责人", width: 130, visible: true },
      { field: "status", title: "状态", width: 100, visible: true },
      { field: "auditStatus", title: "审核状态", width: 100, visible: true },
      { field: "remark", title: "备注", width: 220, visible: false },
      { field: "updatedAt", title: "最近更新时间", width: 160, visible: true }
    ],
    selectorColumns: [
      { field: "systemNo", title: "系统编号", width: 110, visible: false },
      { field: "code", title: "部门编码", width: 140, visible: true },
      { field: "name", title: "部门名称", width: 180, visible: true },
      { field: "manager", title: "负责人", width: 130, visible: true }
    ],
    fields: productionDepartmentFields,
    sparsePatch: true
  },
  "employee-master-list": {
    ...employeeDefinition,
    listKey: "employee-master-list"
  },
  "financial-account-master-list": {
    ...financialAccountDefinition,
    listKey: "financial-account-master-list"
  },
  "employee-master-selector": {
    ...employeeDefinition,
    listKey: "employee-master-selector"
  },
  "financial-account-master-selector": {
    ...financialAccountDefinition,
    listKey: "financial-account-master-selector"
  }
};

const selectorListKeyByType: Record<string, string> = {
  customer: "customer-master-list",
  supplier: "supplier-master-list",
  product: "product-master-list",
  warehouse: "warehouse-master-list",
  employee: "employee-master-selector",
  financialAccount: "financial-account-master-selector",
  "employee-master-selector": "employee-master-selector",
  "financial-account-master-selector": "financial-account-master-selector"
};

export function masterSelectorDefinition(type: string): MasterDataDefinition | null {
  const listKey = selectorListKeyByType[type];
  return listKey ? masterDataDefinitions[listKey] ?? null : null;
}
