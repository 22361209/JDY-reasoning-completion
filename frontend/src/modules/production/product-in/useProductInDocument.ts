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
    billPrefix: "SCRK",
    defaultDepartment: "生产部",
    defaultPartyCode: "",
    defaultUnitPrice: 1,
    reversible: true,
    initialForm: initialProductInForm,
    riskySummaryTitle: "产品入库单",
	    redReverseImpact: "红冲将生成负数产品入库草稿，在原单关联红字单；审核红字单后才回写产品入库库存流水。",
    reverseImpact: "反审核将冲销产品入库库存流水，并保留生产任务执行链路。"
  }, options);
}
