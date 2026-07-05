import { initialSalesQuoteForm } from "../../../app/documentModel";
import { useDocumentModule } from "../../documents/useDocumentModule";

export function useSalesQuoteDocument(options: Parameters<typeof useDocumentModule>[1]) {
  return useDocumentModule({
    documentType: "salesQuote",
    saveType: "salesQuote",
    outputType: "salesQuote",
    title: "销售报价单",
    testPrefix: "sales-quote",
    partyKind: "customer",
    partyLabel: "客户",
    auditPermission: "sales.order.audit",
    billPrefix: "XSBJ",
    defaultDepartment: "销售部",
    defaultPartyCode: "",
    defaultUnitPrice: 86,
    showTaxColumns: true,
    reversible: true,
    allowDraftDelete: true,
    allowZeroQty: true,
    reverseImpact: "反审核将销售报价单退回草稿，可再次编辑报价；已被销售订单引用的历史记录仍保留。",
    initialForm: initialSalesQuoteForm
  }, options);
}
