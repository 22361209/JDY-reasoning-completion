import { initialStockTransferForm } from "../../../app/documentModel";
import type { MasterOption } from "../../../app/documentModel";
import { useDocumentModule } from "../../documents/useDocumentModule";

export function useStockTransferDocument(
  options: Parameters<typeof useDocumentModule>[1],
  organizationOptions: () => MasterOption[]
) {
  return useDocumentModule({
    documentType: "stockTransfer",
    saveType: "stockTransfer",
    outputType: "stockTransfer",
    title: "调拨单",
    testPrefix: "stock-transfer",
    partyKind: "organization",
    partyLabel: "调拨组织",
    partyOptions: organizationOptions,
    auditPermission: "inventory.stock_transfer.audit",
    billPrefix: "ZJDB",
    defaultDepartment: "仓储部",
    defaultPartyCode: "",
    defaultUnitPrice: 0,
    showTargetWarehouseColumn: true,
    defaultTargetWarehouseCode: "CK-002",
    reversible: true,
    initialForm: initialStockTransferForm,
    riskySummaryTitle: "调拨单",
    redReverseImpact: "调拨单第一版不做红冲，库存冲销使用反审核路径。",
    reverseImpact: "反审核将回滚调拨两腿：目标仓扣回、源仓补回。"
  }, options);
}
