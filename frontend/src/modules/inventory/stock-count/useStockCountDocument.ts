import { initialStockCountForm } from "../../../app/documentModel";
import { useDocumentModule } from "../../documents/useDocumentModule";

export function useStockCountDocument(options: Parameters<typeof useDocumentModule>[1]) {
  return useDocumentModule({
    documentType: "stockCount",
    saveType: "stockCount",
    outputType: "stockCount",
    title: "盘点单",
    testPrefix: "stock-count",
    partyKind: "supplier",
    partyLabel: "盘点仓",
    auditPermission: "inventory.stock_count.audit",
    billPrefix: "PD",
    defaultDepartment: "仓储部",
    defaultPartyCode: "CK-001",
    defaultUnitPrice: 0,
    executionQtyLabel: "系统库存",
    remainingQtyLabel: "差异",
    reversible: true,
    initialForm: initialStockCountForm,
    riskySummaryTitle: "盘点单",
    redReverseImpact: "盘点单第一版不做红冲，差异调整通过下推盘盈/盘亏草稿处理。",
    reverseImpact: "盘点单本身不动库存，反审核只回滚盘点单状态。"
  }, options);
}
