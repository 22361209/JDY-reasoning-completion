import { initialOtherStockOutForm } from "../../../app/documentModel";
import { useDocumentModule } from "../../documents/useDocumentModule";

export function useOtherStockOutDocument(options: Parameters<typeof useDocumentModule>[1]) {
  return useDocumentModule({
    documentType: "otherStockOut",
    saveType: "otherStockOut",
    outputType: "otherStockOut",
    title: "其他出库单",
    testPrefix: "other-stock-out",
    partyKind: "customer",
    partyLabel: "客户",
    auditPermission: "inventory.other_stock_out.audit",
    billPrefix: "QTCK",
    defaultDepartment: "仓储部",
    defaultPartyCode: "",
    defaultUnitPrice: 0,
    reversible: true,
    initialForm: initialOtherStockOutForm,
    riskySummaryTitle: "其他出库单",
    redReverseImpact: "其他出库第一版不做红冲，库存冲销使用反审核路径。",
    reverseImpact: "反审核将按分录数量补回库存余额，并追加正向库存流水。"
  }, options);
}
