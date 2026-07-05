import { initialPurchaseReturnForm } from "../../../app/documentModel";
import { useDocumentModule } from "../../documents/useDocumentModule";

export function usePurchaseReturnDocument(options: Parameters<typeof useDocumentModule>[1]) {
  return useDocumentModule({
    documentType: "purchaseReturn",
    saveType: "purchaseReturn",
    outputType: "purchaseReturn",
    title: "采购退货单",
    testPrefix: "purchase-return",
    partyKind: "supplier",
    partyLabel: "供应商",
    auditPermission: "purchase.return.audit",
    billPrefix: "CGTH",
    defaultDepartment: "采购部",
    defaultPartyCode: "",
    defaultUnitPrice: 72,
    showTaxColumns: true,
    sourceTraceType: "purchaseIn",
    reversible: true,
    allowDraftDelete: true,
    initialForm: initialPurchaseReturnForm,
    riskySummaryTitle: "采购退货单",
    reverseImpact: "反审核将冲销采购退货库存流水，库存补回。",
    redReverseImpact: "采购退货单首版不启用红冲，请使用反审核或作废处理草稿。"
  }, options);
}
