package com.jdy.erp.shared.application;

import java.math.BigDecimal;
import java.time.LocalDate;
import java.util.UUID;

import com.jdy.erp.inventory.application.InventoryPostingCommand;
import com.jdy.erp.inventory.application.InventoryPostingCommand.PostingAction;
import com.jdy.erp.inventory.application.InventoryPostingCommand.TraceQuality;

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
    BigDecimal amount,
    String currency,
    UUID sourceBillId,
    UUID sourceBillLineId,
    PostingAction postingAction,
    TraceQuality traceQuality
) {
    public static PostingContext inventory(InventoryPostingCommand command) {
        return new PostingContext(
            InventoryPostingHook.CHANNEL,
            command.productCode(),
            command.warehouseCode(),
            command.quantity(),
            command.txnType(),
            command.sourceBillType(),
            command.sourceBillNo(),
            null,
            command.sourceBillDate(),
            null,
            "CNY",
            command.sourceBillId(),
            command.sourceBillLineId(),
            command.postingAction(),
            command.traceQuality()
        );
    }

    public static PostingContext finance(
        String txnType,
        String sourceBillNo,
        String partyId,
        LocalDate billDate,
        BigDecimal amount,
        String currency
    ) {
        return new PostingContext(
            FinancePosting.CHANNEL,
            null,
            null,
            null,
            txnType,
            txnType + ":" + sourceBillNo,
            sourceBillNo,
            partyId,
            billDate,
            amount,
            currency,
            null,
            null,
            null,
            null
        );
    }

}
