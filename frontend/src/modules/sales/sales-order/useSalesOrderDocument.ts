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
    defaultPartyCode: "KH-001",
    defaultUnitPrice: 86,
    reversible: true,
    reverseImpact: "反审核将把销售订单从已审核退回已反审核；若已有已审核销售出库下游单据，后端会阻断操作。",
    initialForm: initialSalesOrderForm
  }, options);
}
