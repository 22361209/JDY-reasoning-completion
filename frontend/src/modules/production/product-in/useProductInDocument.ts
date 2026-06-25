import { initialProductInForm } from "../../../app/documentModel";
import { useDocumentModule } from "../../documents/useDocumentModule";

export function useProductInDocument(options: Parameters<typeof useDocumentModule>[1]) {
  return useDocumentModule({
    documentType: "productIn",
    saveType: "productIn",
    outputType: "productIn",
    title: "产品入库单",
    testPrefix: "product-in",
    partyKind: "customer",
    partyLabel: "来源",
    auditPermission: "production.document.audit",
    billPrefix: "CPRK",
    defaultDepartment: "生产部",
    defaultPartyCode: "SCRW-00001",
    defaultUnitPrice: 1,
    reversible: true,
    initialForm: initialProductInForm,
    riskySummaryTitle: "产品入库单",
    redReverseImpact: "红冲将生成负数产品入库单，原单标记已红冲，并回写产品入库库存流水。",
    reverseImpact: "反审核将冲销产品入库库存流水，并保留生产任务执行链路。"
  }, options);
}
