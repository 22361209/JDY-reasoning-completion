package com.jdy.erp.shared.application;

import java.util.Map;

import org.springframework.http.HttpStatus;
import org.springframework.web.server.ResponseStatusException;

public final class BillLifecyclePolicy {
    private static final LifecycleCapabilities UNKNOWN_DOCUMENT = new LifecycleCapabilities(false, false, false, false);
    private static final LifecycleCapabilities FACT_DOCUMENT = new LifecycleCapabilities(false, false, false, true);
    private static final Map<String, LifecycleCapabilities> CAPABILITIES_BY_TABLE = Map.ofEntries(
        Map.entry("sales_quote", FACT_DOCUMENT),
        Map.entry("sales_order", new LifecycleCapabilities(true, true, false, true)),
        Map.entry("delivery_notice", new LifecycleCapabilities(true, true, false, true)),
        Map.entry("purchase_order", new LifecycleCapabilities(true, true, false, true)),
        Map.entry("production_task", new LifecycleCapabilities(true, true, false, true)),
        Map.entry("sales_out", new LifecycleCapabilities(false, false, true, true)),
        Map.entry("sales_return", FACT_DOCUMENT),
        Map.entry("purchase_in", new LifecycleCapabilities(false, false, true, true)),
        Map.entry("purchase_return", FACT_DOCUMENT),
        Map.entry("ar_receipt", new LifecycleCapabilities(false, false, false, false)),
        Map.entry("ap_payment", new LifecycleCapabilities(false, false, false, false)),
        Map.entry("production_material_issue", new LifecycleCapabilities(false, false, true, true)),
        Map.entry("production_completion", new LifecycleCapabilities(false, false, true, true)),
        Map.entry("other_stock_in", FACT_DOCUMENT),
        Map.entry("other_stock_out", FACT_DOCUMENT),
        Map.entry("stock_transfer", FACT_DOCUMENT),
        Map.entry("stock_count", FACT_DOCUMENT),
        Map.entry("stock_count_gain", FACT_DOCUMENT),
        Map.entry("stock_count_loss", FACT_DOCUMENT)
    );

    private BillLifecyclePolicy() {
    }

    public static LifecycleCapabilities forTarget(BillLifecycleService.BillLifecycleTarget target) {
        return CAPABILITIES_BY_TABLE.getOrDefault(target.headerTable(), UNKNOWN_DOCUMENT);
    }

    public static void requireCloseFreezeAllowed(BillLifecycleService.BillLifecycleTarget target, String actionLabel) {
        if (!forTarget(target).closeFreezeAllowed()) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, target.targetType() + " 不支持" + actionLabel + "，请使用审核/反审核/作废或红冲类动作处理。");
        }
    }

    public static void requireLineCloseFreezeAllowed(BillLifecycleService.BillLifecycleTarget target, String actionLabel) {
        if (!forTarget(target).lineCloseFreezeAllowed()) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, target.targetType() + " 不支持行" + actionLabel + "。");
        }
    }

    public static void requireVoidAllowed(BillLifecycleService.BillLifecycleTarget target) {
        if (!forTarget(target).voidAllowed()) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, target.targetType() + " 不支持作废。");
        }
    }

    public record LifecycleCapabilities(
        boolean closeFreezeAllowed,
        boolean lineCloseFreezeAllowed,
        boolean redReverseAllowed,
        boolean voidAllowed
    ) {
    }
}
