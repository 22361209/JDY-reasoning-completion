import { initialSalesOrderForm } from "../../../app/documentModel";
import { useDocumentModule } from "../../documents/useDocumentModule";

export function useSalesOrderDocument(options: Parameters<typeof useDocumentModule>[1]) {
  return useDocumentModule({
    documentType: "salesOrder",
    saveType: "salesOrder",
    outputType: "salesOrder",
    title: "销售订单",
    testPrefix: "sales",
    partyKind: "customer",
    partyLabel: "客户",
    auditPermission: "sales.order.audit",
    billPrefix: "XSDD",
    defaultDepartment: "销售部",
    defaultPartyCode: "",
    defaultUnitPrice: 86,
    showTaxMode: true,
    showStockColumns: true,
    sourceTraceType: "salesQuote",
    reversible: true,
    allowDraftDelete: true,
    reverseImpact: "反审核将把销售订单从已审核退回草稿，可再次编辑和审核；若已有已审核销售出库下游单据，后端会阻断操作。",
    initialForm: initialSalesOrderForm
  }, options);
}
