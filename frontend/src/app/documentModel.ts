import type { DownstreamDocumentRef, PrintTemplateConfig } from "../services/documentApi";

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

export interface EntryPasteRefs {
  products: MasterOption[];
  warehouses: MasterOption[];
}

export interface EntryPasteConflict {
  lineIndex: number;
  productText: string;
  candidates: MasterOption[];
  selectedCode?: string;
  activeIndex?: number;
}

export interface OrderLineForm {
  lineNo?: number;
  productId?: string;
  productCode: string;
  productName?: string;
  spec?: string;
  unit?: string;
  netWeight?: string | number;
  grossWeight?: string | number;
  warehouseCode: string;
  targetWarehouseCode?: string;
  sourceOrderNo?: string;
  sourceLineNo?: number;
  sourceDeliveryNoticeNo?: string;
  sourceDeliveryLineNo?: number;
  customerMaterialCode?: string;
  supplierMaterialCode?: string;
  customerOrderNo?: string;
  qty: number;
  executedQty?: number;
  remainingQty?: number;
  availableNoticeQty?: number;
  lineCloseStatus?: "OPEN" | "CLOSED" | string;
  lineFrozenStatus?: "NORMAL" | "FROZEN" | string;
  unitPrice: number;
  taxRate?: number;
  taxAmount?: number | string;
  priceTaxTotal?: number | string;
  lineRemark?: string;
  planDeliveryDate?: string;
  downstreamDocs?: DownstreamDocumentRef[];
  stockOnHand?: number | string;
  stockReserved?: number | string;
  stockAvailable?: number | string;
  stockInTransit?: number | string;
}

export interface PendingEntryPaste {
  startIndex: number;
  lines: OrderLineForm[];
  conflicts: EntryPasteConflict[];
}

export interface ZeroEntryWarning {
  lineNo: number;
  productCode: string;
  warehouseCode: string;
  qty: number;
  unitPrice: number;
  reasons: string[];
  reason: string;
}

export interface PendingZeroEntrySave {
  target: "salesOrder" | "document";
  warnings: ZeroEntryWarning[];
}

export type RiskyDocumentAction = "reverse" | "redReverse";
export type LifecycleDocumentAction = "close" | "unclose" | "freeze" | "unfreeze" | "void";

export interface DownstreamTraceState {
  title: string;
  lineNo: number;
  executedQty: string;
  docs: DownstreamDocumentRef[];
}

export interface OrderForm {
  billNo: string;
  sourceOrderNo?: string;
  redReverseBillNo?: string;
  redSourceBillNo?: string;
  partyCode: string;
  partyName?: string;
  billDate: string;
  department: string;
  ownerName: string;
  remark?: string;
  isTaxInclusive?: boolean;
  enabled?: boolean;
  validUntil?: string;
  status: "DRAFT" | "AUDITED" | "REVERSED" | "VOIDED" | "RED_REVERSED";
  closeStatus?: "OPEN" | "CLOSED" | string;
  closeMode?: "AUTO" | "MANUAL" | string | null;
  frozenStatus?: "NORMAL" | "FROZEN" | string;
  productInfo?: {
    productCode?: string;
    productName?: string;
    spec?: string;
    unit?: string;
    warehouseCode?: string;
    taskQty?: number | string;
    remainingQty?: number | string;
    bomCode?: string;
    bomVersionNo?: number | string;
  };
  lines: OrderLineForm[];
}

export interface PendingPushLine extends OrderLineForm {
  sourceQty: number;
  executedQty: number;
  remainingQty: number;
  availableNoticeQty?: number;
  selected?: boolean;
}

export const zeroReasonOptions = ["赠品", "样品", "补录", "其他已确认"];

export const printTemplateDocumentTypes = [
  { documentType: "sales-quote", documentTitle: "销售报价单" },
  { documentType: "sales-order", documentTitle: "销售订单" },
  { documentType: "delivery-notice", documentTitle: "发货通知单" },
  { documentType: "purchase-order", documentTitle: "采购订单" },
  { documentType: "sales-out", documentTitle: "销售出库单" },
  { documentType: "purchase-in", documentTitle: "采购入库单" },
  { documentType: "purchase-return", documentTitle: "采购退货单" },
  { documentType: "material-issue", documentTitle: "生产领料单" },
  { documentType: "product-in", documentTitle: "产品入库单" },
  { documentType: "other-stock-in", documentTitle: "其他入库单" },
  { documentType: "other-stock-out", documentTitle: "其他出库单" },
  { documentType: "stock-transfer", documentTitle: "调拨单" },
  { documentType: "stock-count", documentTitle: "盘点单" },
  { documentType: "stock-count-gain", documentTitle: "盘盈单" },
  { documentType: "stock-count-loss", documentTitle: "盘亏单" }
];

export const defaultPrintTemplateForm: PrintTemplateConfig = {
  documentType: "sales-order",
  documentTitle: "销售订单",
  templateCode: "STANDARD",
  templateName: "标准套打模板",
  roleCode: "",
  companyName: "博莱德机械测试账套",
  headerNote: "会计期间 2026-06 / 业务期间 2026-06",
  footerNote: "本单据由 JDY 推理补完 ERP 生成，请按公司制度完成签字、盖章与归档。",
  showSignature: true,
  showSeal: true,
  isDefault: true,
  paperSize: "A4",
  pageOrientation: "PORTRAIT",
  marginTopMm: "12",
  marginRightMm: "12",
  marginBottomMm: "12",
  marginLeftMm: "12",
  copyCount: 1,
  enabled: true
};

export const initialSalesOrderForm: OrderForm = {
  billNo: "",
  partyCode: "",
  billDate: "2026-06-23",
  department: "销售部",
  ownerName: "本地管理员",
  isTaxInclusive: false,
  status: "DRAFT",
  lines: [{ productCode: "CP-001", warehouseCode: "CK-001", qty: 20, unitPrice: 86, taxRate: 13 }]
};

export const initialSalesQuoteForm: OrderForm = {
  billNo: "",
  partyCode: "",
  billDate: "2026-06-23",
  validUntil: "2026-07-23",
  department: "销售部",
  ownerName: "本地管理员",
  isTaxInclusive: false,
  status: "DRAFT",
  lines: [{ productCode: "CP-001", warehouseCode: "CK-001", qty: 0, unitPrice: 86, taxRate: 13 }]
};

export const initialPurchaseOrderForm: OrderForm = {
  billNo: "",
  partyCode: "",
  billDate: "2026-06-23",
  department: "采购部",
  ownerName: "本地管理员",
  isTaxInclusive: false,
  status: "DRAFT",
  lines: [{ productCode: "CP-001", warehouseCode: "CK-001", qty: 50, unitPrice: 72, taxRate: 13 }]
};

export const initialPurchaseInForm: OrderForm = {
  billNo: "",
  sourceOrderNo: "",
  partyCode: "",
  billDate: "2026-06-23",
  department: "采购部",
  ownerName: "本地管理员",
  isTaxInclusive: false,
  status: "DRAFT",
  lines: [{ productCode: "CP-001", warehouseCode: "CK-001", qty: 10, unitPrice: 72, taxRate: 13 }]
};

export const initialPurchaseReturnForm: OrderForm = {
  billNo: "",
  sourceOrderNo: "",
  partyCode: "",
  billDate: "2026-06-23",
  department: "采购部",
  ownerName: "本地管理员",
  isTaxInclusive: false,
  status: "DRAFT",
  lines: [{ productCode: "", warehouseCode: "", qty: 0, unitPrice: 0, taxRate: 13 }]
};

export const initialSalesOutForm: OrderForm = {
  billNo: "",
  sourceOrderNo: "",
  partyCode: "",
  billDate: "2026-06-23",
  department: "销售部",
  ownerName: "本地管理员",
  isTaxInclusive: false,
  status: "DRAFT",
  lines: [{ productCode: "CP-001", warehouseCode: "CK-001", qty: 5, unitPrice: 86, taxRate: 13 }]
};

export const initialDeliveryNoticeForm: OrderForm = {
  billNo: "",
  sourceOrderNo: "",
  partyCode: "",
  billDate: "2026-06-26",
  department: "销售部",
  ownerName: "本地管理员",
  isTaxInclusive: false,
  status: "DRAFT",
  lines: [{ productCode: "CP-001", warehouseCode: "CK-001", qty: 5, unitPrice: 86, taxRate: 13 }]
};

export const initialMaterialIssueForm: OrderForm = {
  billNo: "",
  sourceOrderNo: "",
  partyCode: "",
  billDate: "2026-06-23",
  department: "生产部",
  ownerName: "本地管理员",
  status: "AUDITED",
  lines: [{ productCode: "WL-001", warehouseCode: "CK-001", qty: 2, unitPrice: 1 }]
};

export const initialProductInForm: OrderForm = {
  billNo: "",
  sourceOrderNo: "",
  partyCode: "",
  billDate: "2026-06-23",
  department: "生产部",
  ownerName: "本地管理员",
  status: "AUDITED",
  lines: [{ productCode: "CP-001", warehouseCode: "CK-001", qty: 1, unitPrice: 1 }]
};

export const initialOtherStockInForm: OrderForm = {
  billNo: "",
  partyCode: "",
  billDate: "2026-06-25",
  department: "仓储部",
  ownerName: "本地管理员",
  status: "DRAFT",
  lines: [{ productCode: "CP-001", warehouseCode: "CK-001", qty: 10, unitPrice: 0 }]
};

export const initialOtherStockOutForm: OrderForm = {
  billNo: "",
  partyCode: "",
  billDate: "2026-06-25",
  department: "仓储部",
  ownerName: "本地管理员",
  status: "DRAFT",
  lines: [{ productCode: "CP-001", warehouseCode: "CK-001", qty: 5, unitPrice: 0 }]
};

export const initialStockTransferForm: OrderForm = {
  billNo: "",
  partyCode: "",
  billDate: "2026-06-25",
  department: "仓储部",
  ownerName: "本地管理员",
  status: "DRAFT",
  lines: [{ productCode: "CP-001", warehouseCode: "CK-001", targetWarehouseCode: "CK-002", qty: 5, unitPrice: 0 }]
};

export const initialStockCountForm: OrderForm = {
  billNo: "",
  partyCode: "",
  billDate: "2026-06-26",
  department: "仓储部",
  ownerName: "本地管理员",
  status: "DRAFT",
  lines: [{ productCode: "CP-001", warehouseCode: "CK-001", qty: 10, unitPrice: 0 }]
};

export const initialStockCountGainForm: OrderForm = {
  billNo: "",
  sourceOrderNo: "",
  partyCode: "",
  billDate: "2026-06-26",
  department: "仓储部",
  ownerName: "本地管理员",
  status: "DRAFT",
  lines: [{ productCode: "CP-001", warehouseCode: "CK-001", sourceLineNo: 1, qty: 1, unitPrice: 0 }]
};

export const initialStockCountLossForm: OrderForm = {
  billNo: "",
  sourceOrderNo: "",
  partyCode: "",
  billDate: "2026-06-26",
  department: "仓储部",
  ownerName: "本地管理员",
  status: "DRAFT",
  lines: [{ productCode: "CP-001", warehouseCode: "CK-001", sourceLineNo: 1, qty: 1, unitPrice: 0 }]
};

export const knownProductOptions: MasterOption[] = [
  { code: "CP-001", name: "控制臂总成", spec: "左前 / 黑色", unit: "只", netWeight: "1.20", grossWeight: "1.35" },
  { code: "CP-T413874", name: "验收商品总成", spec: "左前 / 蓝色", unit: "只", netWeight: "1.10", grossWeight: "1.25" },
  { code: "PJ-014", name: "衬套", spec: "65mm / 加强", unit: "件", netWeight: "0.08", grossWeight: "0.10" }
];

export const knownWarehouseOptions: MasterOption[] = [
  { code: "CK-001", name: "成品仓" },
  { code: "CK-002", name: "原材料仓" },
  { code: "CK-T413874", name: "验收仓" }
];
