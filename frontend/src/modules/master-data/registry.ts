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
    fields: productMasterFields,
    formComponent: ProductMasterForm
  },
  "customer-master-list": {
    listKey: "customer-master-list",
    type: "customer",
    fields: customerMasterFields,
    formComponent: CustomerMasterForm
  },
  "supplier-master-list": {
    listKey: "supplier-master-list",
    type: "supplier",
    fields: supplierMasterFields,
    formComponent: SupplierMasterForm
  },
  "warehouse-master-list": {
    listKey: "warehouse-master-list",
    type: "warehouse",
    fields: warehouseMasterFields,
    formComponent: WarehouseMasterForm
  }
};
