import { initialPurchaseInForm } from "../../../app/documentModel";
import { useDocumentModule } from "../../documents/useDocumentModule";

export function usePurchaseInDocument(options: Parameters<typeof useDocumentModule>[1]) {
  return useDocumentModule({
    documentType: "purchaseIn",
    saveType: "purchaseIn",
    outputType: "purchaseIn",
    title: "采购入库单",
    testPrefix: "purchase-in",
    partyKind: "supplier",
    partyLabel: "供应商",
    auditPermission: "purchase.in.audit",
    billPrefix: "CGRK",
    defaultDepartment: "采购部",
    defaultPartyCode: "",
    defaultUnitPrice: 72,
    showTaxMode: true,
    sourceTraceType: "purchaseOrder",
    reversible: true,
    initialForm: initialPurchaseInForm,
    riskySummaryTitle: "采购入库单",
    redReverseImpact: "红冲将生成负数采购入库单，原单标记已红冲，并回退采购订单已入库数量、重算入库状态。",
    reverseImpact: "反审核将冲销采购入库库存流水，回退采购订单已入库数量，并重算入库状态。"
  }, options);
}
