package com.jdy.erp.shared.application;

import java.math.BigDecimal;

public record PostingContext(
    String channel,
    String productCode,
    String warehouseCode,
    BigDecimal qtyDelta,
    String txnType,
    String sourceBillType
) {
}
