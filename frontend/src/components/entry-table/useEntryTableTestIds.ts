import type { EntryColumnKey } from "./types";

export function createEntryTableTestIds(testPrefix: () => string) {
  function indexed(base: string, index: number) {
    return index === 0 ? `${testPrefix()}-${base}` : `${testPrefix()}-${base}-${index + 1}`;
  }

  function selectorIdForLine(lineIndex: number, field: "product" | "warehouse" | "target-warehouse") {
    return `${testPrefix()}-line-${lineIndex}-${field}`;
  }

  function lineProductTestId(index: number) {
    return indexed("line-product", index);
  }

  function lineWarehouseTestId(index: number) {
    return indexed("line-warehouse", index);
  }

  function lineTargetWarehouseTestId(index: number) {
    return indexed("line-target-warehouse", index);
  }

  function lineQtyTestId(index: number) {
    return indexed("line-qty", index);
  }

  function lineSourceLineNoTestId(index: number) {
    return indexed("line-source-line-no", index);
  }

  function lineSourceOrderNoTestId(index: number) {
    return indexed("line-source-order-no", index);
  }

  function lineSourceTraceTestId(index: number) {
    return indexed("line-source-trace", index);
  }

  function lineDownstreamTraceTestId(index: number) {
    return indexed("line-downstream-trace", index);
  }

  function lineExecutedQtyTestId(index: number) {
    return indexed("line-executed-qty", index);
  }

  function lineRemainingQtyTestId(index: number) {
    return indexed("line-remaining-qty", index);
  }

  function linePriceTestId(index: number) {
    return indexed("line-price", index);
  }

  function lineTaxInclusiveUnitPriceTestId(index: number) {
    return indexed("line-tax-inclusive-price", index);
  }

  function lineTaxRateTestId(index: number) {
    return indexed("line-tax-rate", index);
  }

  function lineAmountTestId(index: number) {
    return indexed("line-amount", index);
  }

  function lineTaxAmountTestId(index: number) {
    return indexed("line-tax-amount", index);
  }

  function linePriceTaxTotalTestId(index: number) {
    return indexed("line-price-tax-total", index);
  }

  function lineRemarkTestId(index: number) {
    return indexed("line-remark", index);
  }

  function lineCustomerMaterialCodeTestId(index: number) {
    return indexed("line-customer-material-code", index);
  }

  function lineSupplierMaterialCodeTestId(index: number) {
    return indexed("line-supplier-material-code", index);
  }

  function lineCustomerOrderNoTestId(index: number) {
    return indexed("line-customer-order-no", index);
  }

  function linePlanDeliveryDateTestId(index: number) {
    return indexed("line-plan-delivery-date", index);
  }

  function lineDeleteTestId(index: number) {
    return indexed("line-delete", index);
  }

  function lineInsertTestId(index: number) {
    return indexed("line-insert", index);
  }

  function columnCellTestId(key: EntryColumnKey, index: number) {
    const suffix = index === 0 ? "" : `-${index + 1}`;
    if (key === "rowNo") {
      return `${testPrefix()}-line-row-no${suffix}`;
    }
    if (key === "partyCode") {
      return `${testPrefix()}-line-party-code${suffix}`;
    }
    if (key === "customerMaterialCode") {
      return lineCustomerMaterialCodeTestId(index);
    }
    if (key === "supplierMaterialCode") {
      return lineSupplierMaterialCodeTestId(index);
    }
    if (key === "customerOrderNo") {
      return lineCustomerOrderNoTestId(index);
    }
    if (key === "productName") {
      return `${testPrefix()}-line-product-name${suffix}`;
    }
    if (key === "spec") {
      return `${testPrefix()}-line-spec${suffix}`;
    }
    if (key === "unit" || key === "netWeight" || key === "grossWeight") {
      return `${testPrefix()}-line-${key}${suffix}`;
    }
    if (key === "sourceLineNo") {
      return lineSourceLineNoTestId(index);
    }
    if (key === "sourceOrderNo") {
      return lineSourceOrderNoTestId(index);
    }
    if (key === "executedQty") {
      return lineExecutedQtyTestId(index);
    }
    if (key === "remainingQty") {
      return lineRemainingQtyTestId(index);
    }
    if (key === "stockOnHand" || key === "stockReserved" || key === "stockAvailable" || key === "stockInTransit") {
      return `${testPrefix()}-line-${key}${suffix}`;
    }
    if (key === "taxInclusiveUnitPrice") {
      return lineTaxInclusiveUnitPriceTestId(index);
    }
    return undefined;
  }

  return {
    selectorIdForLine,
    lineProductTestId,
    lineWarehouseTestId,
    lineTargetWarehouseTestId,
    lineQtyTestId,
    lineSourceLineNoTestId,
    lineSourceOrderNoTestId,
    lineSourceTraceTestId,
    lineDownstreamTraceTestId,
    lineExecutedQtyTestId,
    lineRemainingQtyTestId,
    linePriceTestId,
    lineTaxInclusiveUnitPriceTestId,
    lineTaxRateTestId,
    lineAmountTestId,
    lineTaxAmountTestId,
    linePriceTaxTotalTestId,
    lineRemarkTestId,
    lineCustomerMaterialCodeTestId,
    lineSupplierMaterialCodeTestId,
    lineCustomerOrderNoTestId,
    linePlanDeliveryDateTestId,
    lineDeleteTestId,
    lineInsertTestId,
    columnCellTestId
  };
}
