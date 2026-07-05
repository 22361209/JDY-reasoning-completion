import { initialDeliveryNoticeForm } from "../../../app/documentModel";
import { useDocumentModule } from "../../documents/useDocumentModule";

export function useDeliveryNoticeDocument(options: Parameters<typeof useDocumentModule>[1]) {
  return useDocumentModule({
    documentType: "deliveryNotice",
    saveType: "deliveryNotice",
    outputType: "deliveryNotice",
    title: "发货通知单",
    testPrefix: "delivery-notice",
    partyKind: "customer",
    partyLabel: "客户",
    auditPermission: "sales.out.audit",
    billPrefix: "FHTZD",
    defaultDepartment: "销售部",
    defaultPartyCode: "",
    defaultUnitPrice: 86,
    showTaxColumns: true,
    showStockColumns: true,
    sourceTraceType: "salesOrder",
    reversible: true,
    allowDraftDelete: true,
    reverseImpact: "反审核将释放本单锁定库存；若已有下游销售出库，后端会阻断操作。",
    initialForm: initialDeliveryNoticeForm
  }, options);
}
