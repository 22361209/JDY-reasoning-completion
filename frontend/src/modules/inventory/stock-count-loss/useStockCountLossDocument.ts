import { initialStockCountLossForm } from "../../../app/documentModel";
import { useDocumentModule } from "../../documents/useDocumentModule";

export function useStockCountLossDocument(options: Parameters<typeof useDocumentModule>[1]) {
  return useDocumentModule({
    documentType: "stockCountLoss",
    saveType: "stockCountLoss",
    outputType: "stockCountLoss",
    title: "盘亏单",
    testPrefix: "stock-count-loss",
    partyKind: "supplier",
    partyLabel: "盘点仓",
    auditPermission: "inventory.stock_count_loss.audit",
    billPrefix: "PK",
    defaultDepartment: "仓储部",
    defaultPartyCode: "",
    defaultUnitPrice: 0,
    sourceTraceType: "stockCount",
    reversible: true,
    initialForm: initialStockCountLossForm,
    riskySummaryTitle: "盘亏单",
    redReverseImpact: "盘亏单第一版不做红冲，库存冲销使用反审核路径。",
    reverseImpact: "反审核将按盘亏数量补回库存余额，并追加正向库存流水。"
  }, options);
}
