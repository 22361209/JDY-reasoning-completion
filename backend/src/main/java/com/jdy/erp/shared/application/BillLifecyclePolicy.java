package com.jdy.erp.shared.application;

import java.util.Map;

import org.springframework.http.HttpStatus;
import org.springframework.web.server.ResponseStatusException;

public final class BillLifecyclePolicy {
    private static final LifecycleCapabilities DEFAULT_FACT_DOCUMENT = new LifecycleCapabilities(false, false, false);
    private static final Map<String, LifecycleCapabilities> CAPABILITIES_BY_TABLE = Map.ofEntries(
        Map.entry("sales_quote", new LifecycleCapabilities(false, false, false)),
        Map.entry("sales_order", new LifecycleCapabilities(true, true, false)),
        Map.entry("delivery_notice", new LifecycleCapabilities(true, true, false)),
        Map.entry("purchase_order", new LifecycleCapabilities(true, true, false)),
        Map.entry("sales_out", new LifecycleCapabilities(false, false, true)),
        Map.entry("purchase_in", new LifecycleCapabilities(false, false, true)),
        Map.entry("purchase_return", DEFAULT_FACT_DOCUMENT),
        Map.entry("production_material_issue", new LifecycleCapabilities(false, false, true)),
        Map.entry("production_completion", new LifecycleCapabilities(false, false, true)),
        Map.entry("other_stock_in", DEFAULT_FACT_DOCUMENT),
        Map.entry("other_stock_out", DEFAULT_FACT_DOCUMENT),
        Map.entry("stock_transfer", DEFAULT_FACT_DOCUMENT),
        Map.entry("stock_count", DEFAULT_FACT_DOCUMENT),
        Map.entry("stock_count_gain", DEFAULT_FACT_DOCUMENT),
        Map.entry("stock_count_loss", DEFAULT_FACT_DOCUMENT)
    );

    private BillLifecyclePolicy() {
    }

    public static LifecycleCapabilities forTarget(BillLifecycleService.BillLifecycleTarget target) {
        return CAPABILITIES_BY_TABLE.getOrDefault(target.headerTable(), DEFAULT_FACT_DOCUMENT);
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

    public record LifecycleCapabilities(
        boolean closeFreezeAllowed,
        boolean lineCloseFreezeAllowed,
        boolean redReverseAllowed
    ) {
    }
}
