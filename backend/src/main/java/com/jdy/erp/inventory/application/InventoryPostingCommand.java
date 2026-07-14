package com.jdy.erp.inventory.application;

import java.math.BigDecimal;
import java.time.LocalDate;
import java.util.UUID;

/**
 * Exact source identity for one inventory posting fact. Formal document
 * callers must provide the real header and line ids; the posting service never
 * invents ids or derives source identity from product/quantity.
 */
public record InventoryPostingCommand(
    String productCode,
    String warehouseCode,
    BigDecimal quantity,
    String txnType,
    String sourceBillType,
    UUID sourceBillId,
    UUID sourceBillLineId,
    String sourceBillNo,
    LocalDate sourceBillDate,
    PostingAction postingAction,
    TraceQuality traceQuality
) {
    public enum PostingAction {
        AUDIT,
        REVERSE,
        RED_AUDIT,
        RED_REVERSE,
        RESERVE,
        RELEASE
    }

    public enum TraceQuality {
        EXACT,
        TEST
    }

    public static InventoryPostingCommand document(
        String productCode,
        String warehouseCode,
        BigDecimal quantity,
        String txnType,
        String sourceBillType,
        Object sourceBillId,
        Object sourceBillLineId,
        String sourceBillNo,
        Object sourceBillDate,
        PostingAction postingAction
    ) {
        return new InventoryPostingCommand(
            productCode,
            warehouseCode,
            quantity,
            txnType,
            sourceBillType,
            parseUuid(sourceBillId),
            parseUuid(sourceBillLineId),
            sourceBillNo,
            parseDate(sourceBillDate),
            postingAction,
            TraceQuality.EXACT
        );
    }

    public static InventoryPostingCommand testAdjustment(
        String productCode,
        String warehouseCode,
        BigDecimal quantity,
        String txnType,
        String sourceBillType,
        UUID sourceBillId,
        UUID sourceBillLineId,
        String sourceBillNo,
        LocalDate sourceBillDate
    ) {
        return test(
            productCode, warehouseCode, quantity, txnType, sourceBillType,
            sourceBillId, sourceBillLineId, sourceBillNo, sourceBillDate, PostingAction.AUDIT
        );
    }

    public static InventoryPostingCommand test(
        String productCode,
        String warehouseCode,
        BigDecimal quantity,
        String txnType,
        String sourceBillType,
        UUID sourceBillId,
        UUID sourceBillLineId,
        String sourceBillNo,
        LocalDate sourceBillDate,
        PostingAction postingAction
    ) {
        return new InventoryPostingCommand(
            productCode,
            warehouseCode,
            quantity,
            txnType,
            sourceBillType,
            sourceBillId,
            sourceBillLineId,
            sourceBillNo,
            sourceBillDate,
            postingAction,
            TraceQuality.TEST
        );
    }

    private static UUID parseUuid(Object value) {
        return value instanceof UUID uuid ? uuid : UUID.fromString(String.valueOf(value));
    }

    private static LocalDate parseDate(Object value) {
        if (value instanceof LocalDate date) {
            return date;
        }
        return LocalDate.parse(String.valueOf(value));
    }
}
