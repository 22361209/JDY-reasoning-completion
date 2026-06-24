import { reactive } from "vue";
import { initialSalesOrderForm, type OrderForm, type OrderLineForm } from "../../../app/documentModel";
import { auditSalesOrder, deleteSalesOrder, saveSalesOrderDraft } from "../../../services/salesOrderApi";

interface PreparedSalesOrderLines {
  formLines: OrderLineForm[];
  documentLines: {
    productCode: string;
    warehouseCode: string;
    sourceLineNo?: number;
    qty: number;
    unitPrice: number;
    lineRemark: string;
  }[];
}

export function useSalesOrderDocument() {
  const form = reactive<OrderForm>({
    ...initialSalesOrderForm,
    lines: initialSalesOrderForm.lines.map((line) => ({ ...line }))
  });

  async function saveDraft(preparedLines: PreparedSalesOrderLines) {
    form.lines = preparedLines.formLines;
    const result = await saveSalesOrderDraft({
      billNo: form.billNo,
      customerCode: form.partyCode,
      billDate: form.billDate,
      department: form.department,
      ownerName: form.ownerName,
      lines: preparedLines.documentLines
    });
    if (result.ok) {
      form.status = "DRAFT";
    }
    return result;
  }

  async function audit() {
    const result = await auditSalesOrder(form.billNo);
    if (result.ok) {
      form.status = "AUDITED";
    }
    return result;
  }

  async function remove() {
    return deleteSalesOrder(form.billNo);
  }

  return {
    form,
    saveDraft,
    audit,
    remove
  };
}
