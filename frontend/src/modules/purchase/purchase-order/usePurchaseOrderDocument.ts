import { initialPurchaseOrderForm } from "../../../app/documentModel";
import { useDocumentModule } from "../../documents/useDocumentModule";

export function usePurchaseOrderDocument(options: Parameters<typeof useDocumentModule>[1]) {
  return useDocumentModule({
    documentType: "purchaseOrder",
    saveType: "purchaseOrder",
    outputType: "purchaseOrder",
    title: "采购订单",
    testPrefix: "purchase",
    partyKind: "supplier",
    partyLabel: "供应商",
    auditPermission: "purchase.order.audit",
    billPrefix: "CGDD",
    defaultDepartment: "采购部",
    defaultPartyCode: "",
    defaultUnitPrice: 72,
    showSupplierMaterialCodeColumn: true,
    showTaxMode: true,
    initialForm: initialPurchaseOrderForm
  }, options);
}
