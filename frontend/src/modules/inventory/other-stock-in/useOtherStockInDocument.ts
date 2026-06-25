import { initialOtherStockInForm } from "../../../app/documentModel";
import { useDocumentModule } from "../../documents/useDocumentModule";

export function useOtherStockInDocument(options: Parameters<typeof useDocumentModule>[1]) {
  return useDocumentModule({
    documentType: "otherStockIn",
    saveType: "otherStockIn",
    outputType: "otherStockIn",
    title: "其他入库单",
    testPrefix: "other-stock-in",
    partyKind: "supplier",
    partyLabel: "供应商",
    auditPermission: "inventory.other_stock_in.audit",
    billPrefix: "QTRK",
    defaultDepartment: "仓储部",
    defaultPartyCode: "GYS-001",
    defaultUnitPrice: 0,
    reversible: true,
    initialForm: initialOtherStockInForm,
    riskySummaryTitle: "其他入库单",
    redReverseImpact: "其他入库第一版不做红冲，库存冲销使用反审核路径。",
    reverseImpact: "反审核将按分录数量扣减库存余额，并追加负向库存流水。"
  }, options);
}
