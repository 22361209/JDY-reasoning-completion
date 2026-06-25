package com.jdy.erp.shared.application;

import com.jdy.erp.inventory.application.InventoryPostingService;
import org.springframework.stereotype.Component;

@Component
public class InventoryPostingHook implements PostingHook {
    public static final String CHANNEL = "INVENTORY";

    private final InventoryPostingService inventoryPostingService;

    public InventoryPostingHook(InventoryPostingService inventoryPostingService) {
        this.inventoryPostingService = inventoryPostingService;
    }

    @Override
    public boolean supports(String channel) {
        return CHANNEL.equals(channel);
    }

    @Override
    public void post(PostingContext context) {
        inventoryPostingService.post(
            context.productCode(),
            context.warehouseCode(),
            context.qtyDelta(),
            context.txnType(),
            context.sourceBillType()
        );
    }
}
