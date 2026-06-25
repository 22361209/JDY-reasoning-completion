package com.jdy.erp.shared.application;

import java.math.BigDecimal;
import java.time.LocalDate;

public record PostingContext(
    String channel,
    String productCode,
    String warehouseCode,
    BigDecimal qtyDelta,
    String txnType,
    String sourceBillType,
    String sourceBillNo,
    String partyId,
    LocalDate billDate,
    BigDecimal amount
) {
    public PostingContext(
        String channel,
        String productCode,
        String warehouseCode,
        BigDecimal qtyDelta,
        String txnType,
        String sourceBillType
    ) {
        this(channel, productCode, warehouseCode, qtyDelta, txnType, sourceBillType, null, null, null, null);
    }
}
