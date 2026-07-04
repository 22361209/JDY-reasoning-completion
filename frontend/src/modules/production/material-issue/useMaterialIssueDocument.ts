import { initialMaterialIssueForm } from "../../../app/documentModel";
import { useDocumentModule } from "../../documents/useDocumentModule";

export function useMaterialIssueDocument(options: Parameters<typeof useDocumentModule>[1]) {
  return useDocumentModule({
    documentType: "materialIssue",
    saveType: "materialIssue",
    outputType: "materialIssue",
    title: "生产领料单",
    testPrefix: "material-issue",
    partyKind: "customer",
    partyLabel: "来源",
    auditPermission: "production.document.audit",
    billPrefix: "SOUT",
    defaultDepartment: "生产部",
    defaultPartyCode: "",
    defaultUnitPrice: 1,
    remainingQtyLabel: "应领数量",
    qtyLabel: "本次数量",
    showExecutedQtyColumn: false,
    showStockColumns: true,
    stockColumnMode: "availableOnly",
    stockAvailableLabel: "子件库存数量",
    showPriceAmountColumns: false,
    showProductInfoSection: true,
    reversible: true,
    initialForm: initialMaterialIssueForm,
    riskySummaryTitle: "生产领料单",
    redReverseImpact: "红冲将生成负数生产领料单，原单标记已红冲，并回写生产领料库存流水。",
    reverseImpact: "反审核将冲销生产领料库存流水，并保留生产任务执行链路。"
  }, options);
}
