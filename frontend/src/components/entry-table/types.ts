export interface EntryLine {
  lineNo?: number;
  productId?: string;
  customerMaterialCode?: string;
  supplierMaterialCode?: string;
  customerOrderNo?: string;
  productCode: string;
  productName?: string;
  spec?: string;
  unit?: string;
  netWeight?: number | string;
  grossWeight?: number | string;
  warehouseCode: string;
  targetWarehouseCode?: string;
  sourceOrderNo?: string;
  sourceLineNo?: number;
  qty: number;
  executedQty?: number;
  remainingQty?: number;
  lineCloseStatus?: string;
  lineFrozenStatus?: string;
  unitPrice: number;
  taxRate?: number;
  taxAmount?: number | string;
  priceTaxTotal?: number | string;
  lineRemark?: string;
  planDeliveryDate?: string;
  downstreamDocs?: any[];
  stockOnHand?: number | string;
  stockReserved?: number | string;
  stockAvailable?: number | string;
  stockInTransit?: number | string;
}

export interface MasterOption {
  id?: string;
  code: string;
  name: string;
  spec?: string;
  unit?: string;
  category?: string;
  netWeight?: string;
  grossWeight?: string;
  [key: string]: string | undefined;
}

export type EntryColumnKey =
  | "rowNo"
  | "partyCode"
  | "customerMaterialCode"
  | "supplierMaterialCode"
  | "customerOrderNo"
  | "productCode"
  | "productName"
  | "spec"
  | "unit"
  | "netWeight"
  | "grossWeight"
  | "warehouse"
  | "targetWarehouse"
  | "sourceOrderNo"
  | "sourceLineNo"
  | "qty"
  | "executedQty"
  | "remainingQty"
  | "stockOnHand"
  | "stockReserved"
  | "stockAvailable"
  | "stockInTransit"
  | "unitPrice"
  | "taxInclusiveUnitPrice"
  | "taxRate"
  | "amount"
  | "taxAmount"
  | "priceTaxTotal"
  | "planDeliveryDate"
  | "remark";

export interface EntryColumn {
  key: EntryColumnKey;
  title: string;
  width: number;
  visible: boolean;
  fixed?: "" | "left" | "right";
  locked?: boolean;
  reorderable?: boolean;
  configurable?: boolean;
  numeric?: boolean;
  bulkFillable?: boolean;
}

export type EditableLineCell =
  | "product"
  | "warehouse"
  | "target-warehouse"
  | "qty"
  | "price"
  | "taxRate"
  | "planDeliveryDate"
  | "customerMaterialCode"
  | "supplierMaterialCode"
  | "customerOrderNo"
  | "remark";

export interface EntryColumnOptions {
  partyCodeLabel?: string;
  showPartyCodeColumn?: boolean;
  showCustomerMaterialCodeColumn?: boolean;
  showSupplierMaterialCodeColumn?: boolean;
  showCustomerOrderNoColumn?: boolean;
  showSourceLineColumn: boolean;
  showExecutionColumns: boolean;
  showTargetWarehouseColumn?: boolean;
  showPlanDeliveryDateColumn?: boolean;
  showStockColumns?: boolean;
  stockColumnMode?: "all" | "availableOnly";
  enableSalesPriceBulk?: boolean;
  executionQtyLabel?: string;
  remainingQtyLabel?: string;
  qtyLabel?: string;
  stockAvailableLabel?: string;
  showExecutedQtyColumn?: boolean;
  showPriceAmountColumns?: boolean;
  showTaxColumns?: boolean;
  isDraft?: boolean;
}
