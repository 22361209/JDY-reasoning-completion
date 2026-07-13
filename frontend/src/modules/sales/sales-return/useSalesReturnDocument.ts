import { initialSalesReturnForm } from "../../../app/documentModel";
import { saveSalesReturnDraft } from "../../../services/salesReturnApi";
import { useDocumentModule } from "../../documents/useDocumentModule";

export function useSalesReturnDocument(options: Parameters<typeof useDocumentModule>[1]) {
  return useDocumentModule({
    documentType: "salesReturn",
    saveType: "salesReturn",
    outputType: "salesReturn",
    title: "销售退货单",
    testPrefix: "sales-return",
    partyKind: "customer",
    partyLabel: "客户",
    auditPermission: "sales.out.audit",
    billPrefix: "XSTH",
    defaultDepartment: "销售部",
    defaultPartyCode: "",
    defaultUnitPrice: 0,
    showTaxColumns: true,
    sourceTraceType: "salesOut",
    reversible: true,
    allowDraftDelete: true,
    skipZeroEntryWarnings: true,
    initialForm: initialSalesReturnForm,
    riskySummaryTitle: "销售退货单",
    reverseImpact: "反审核将扣回本单回补库存，并恢复对应应收冲销与待退款事实。",
    redReverseImpact: "销售退货单不启用红冲。",
    sourceLockedLines: true,
    reloadAfterLifecycle: true,
    saveDraft: saveSalesReturnDraft
  }, options);
}
