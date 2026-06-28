import ProductMasterForm from "./product/ProductMasterForm.vue";
import { productMasterFields } from "./product/fields";
import CustomerMasterForm from "./customer/CustomerMasterForm.vue";
import { customerMasterFields } from "./customer/fields";
import SupplierMasterForm from "./supplier/SupplierMasterForm.vue";
import { supplierMasterFields } from "./supplier/fields";
import WarehouseMasterForm from "./warehouse/WarehouseMasterForm.vue";
import { warehouseMasterFields } from "./warehouse/fields";
import type { MasterDataDefinition } from "./types";

export const masterDataDefinitions: Record<string, MasterDataDefinition> = {
  "product-master-list": {
    listKey: "product-master-list",
    type: "product",
    title: "物料资料",
    keywordPlaceholder: "物料编码、物料名称、规格型号",
    statuses: ["启用", "禁用"],
    listColumns: [
      { field: "code", title: "物料编码", width: 140, fixed: "left", visible: true },
      { field: "id", title: "系统ID", width: 230, visible: true },
      { field: "name", title: "物料名称", width: 190, visible: true },
      { field: "spec", title: "规格型号", width: 170, visible: true },
      { field: "category", title: "物料分类", width: 130, visible: true },
      { field: "productType", title: "物料属性", width: 110, visible: true },
      { field: "unit", title: "主单位", width: 80, visible: true },
      { field: "isPurchase", title: "可采购", width: 86, visible: true },
      { field: "isSale", title: "可销售", width: 86, visible: true },
      { field: "isInventory", title: "可库存", width: 86, visible: true },
      { field: "isProduce", title: "可自制", width: 86, visible: true },
      { field: "isSubcontract", title: "可委外", width: 86, visible: true },
      { field: "defaultWarehouseCode", title: "默认仓库", width: 120, visible: true },
      { field: "defaultWorkshop", title: "默认生产车间", width: 140, visible: true },
      { field: "saleUnit", title: "销售单位", width: 90, visible: false },
      { field: "purchaseUnit", title: "采购单位", width: 90, visible: false },
      { field: "bomUnit", title: "生产/BOM单位", width: 120, visible: false },
      { field: "defaultSupplierCode", title: "默认供应商", width: 130, visible: false },
      { field: "issueWarehouseCode", title: "默认领料仓", width: 130, visible: false },
      { field: "issueMethod", title: "发料方式", width: 110, visible: false },
      { field: "taxRate", title: "税率(%)", width: 90, align: "right", visible: true },
      { field: "defaultSalePrice", title: "默认销售价", width: 120, align: "right", visible: true },
      { field: "minSalePrice", title: "最低销售价", width: 120, align: "right", visible: false },
      { field: "costPrice", title: "成本价", width: 110, align: "right", visible: false },
      { field: "status", title: "状态", width: 100, visible: true },
      { field: "remark", title: "备注", width: 180, visible: false },
      { field: "updatedAt", title: "最近更新时间", width: 160, visible: true }
    ],
    selectorColumns: [
      { field: "code", title: "物料编码", width: 140, visible: true },
      { field: "name", title: "物料名称", width: 180, visible: true },
      { field: "spec", title: "规格型号", width: 160, visible: true },
      { field: "unit", title: "单位", width: 80, visible: true },
      { field: "category", title: "物料分类", width: 120, visible: true }
    ],
    fields: productMasterFields,
    formComponent: ProductMasterForm
  },
  "customer-master-list": {
    listKey: "customer-master-list",
    type: "customer",
    title: "客户",
    keywordPlaceholder: "客户编码、客户名称、联系人",
    statuses: ["启用", "禁用"],
    listColumns: [
      { field: "code", title: "客户编码", width: 140, fixed: "left", visible: true },
      { field: "name", title: "客户名称", width: 240, visible: true },
      { field: "contact", title: "联系人", width: 120, visible: true },
      { field: "phone", title: "电话", width: 150, visible: true },
      { field: "region", title: "地区", width: 150, visible: true },
      { field: "address", title: "地址", width: 220, visible: false },
      { field: "remark", title: "备注", width: 180, visible: false },
      { field: "status", title: "状态", width: 100, visible: true }
    ],
    selectorColumns: [
      { field: "code", title: "客户编码", width: 140, visible: true },
      { field: "name", title: "客户名称", width: 220, visible: true },
      { field: "contact", title: "联系人", width: 120, visible: true },
      { field: "phone", title: "电话", width: 140, visible: true }
    ],
    fields: customerMasterFields,
    formComponent: CustomerMasterForm
  },
  "supplier-master-list": {
    listKey: "supplier-master-list",
    type: "supplier",
    title: "供应商",
    keywordPlaceholder: "供应商编码、供应商名称、联系人",
    statuses: ["启用", "禁用"],
    listColumns: [
      { field: "code", title: "供应商编码", width: 150, fixed: "left", visible: true },
      { field: "name", title: "供应商名称", width: 240, visible: true },
      { field: "contact", title: "联系人", width: 120, visible: true },
      { field: "phone", title: "电话", width: 150, visible: true },
      { field: "address", title: "地址", width: 220, visible: false },
      { field: "remark", title: "备注", width: 180, visible: false },
      { field: "status", title: "状态", width: 100, visible: true }
    ],
    selectorColumns: [
      { field: "code", title: "供应商编码", width: 150, visible: true },
      { field: "name", title: "供应商名称", width: 220, visible: true },
      { field: "contact", title: "联系人", width: 120, visible: true },
      { field: "phone", title: "电话", width: 140, visible: true }
    ],
    fields: supplierMasterFields,
    formComponent: SupplierMasterForm
  },
  "warehouse-master-list": {
    listKey: "warehouse-master-list",
    type: "warehouse",
    title: "仓库",
    keywordPlaceholder: "仓库编码、仓库名称",
    statuses: ["启用", "禁用"],
    listColumns: [
      { field: "code", title: "仓库编码", width: 140, fixed: "left", visible: true },
      { field: "name", title: "仓库名称", width: 220, visible: true },
      { field: "warehouseType", title: "仓库类型", width: 110, visible: true },
      { field: "manager", title: "仓管员", width: 110, visible: true },
      { field: "address", title: "仓库地址", width: 220, visible: false },
      { field: "remark", title: "备注", width: 180, visible: false },
      { field: "status", title: "状态", width: 100, visible: true }
    ],
    selectorColumns: [
      { field: "code", title: "仓库编码", width: 140, visible: true },
      { field: "name", title: "仓库名称", width: 200, visible: true },
      { field: "warehouseType", title: "仓库类型", width: 110, visible: true },
      { field: "manager", title: "仓管员", width: 110, visible: true }
    ],
    fields: warehouseMasterFields,
    formComponent: WarehouseMasterForm
  }
};
