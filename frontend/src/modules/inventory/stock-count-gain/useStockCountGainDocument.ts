import { initialStockCountGainForm } from "../../../app/documentModel";
import { useDocumentModule } from "../../documents/useDocumentModule";

export function useStockCountGainDocument(options: Parameters<typeof useDocumentModule>[1]) {
  return useDocumentModule({
    documentType: "stockCountGain",
    saveType: "stockCountGain",
    outputType: "stockCountGain",
    title: "盘盈单",
    testPrefix: "stock-count-gain",
    partyKind: "supplier",
    partyLabel: "盘点仓",
    auditPermission: "inventory.stock_count_gain.audit",
    billPrefix: "PY",
    defaultDepartment: "仓储部",
    defaultPartyCode: "CK-001",
    defaultUnitPrice: 0,
    sourceTraceType: "stockCount",
    reversible: true,
    initialForm: initialStockCountGainForm,
    riskySummaryTitle: "盘盈单",
    redReverseImpact: "盘盈单第一版不做红冲，库存冲销使用反审核路径。",
    reverseImpact: "反审核将按盘盈数量扣减库存余额，并追加负向库存流水。"
  }, options);
}
