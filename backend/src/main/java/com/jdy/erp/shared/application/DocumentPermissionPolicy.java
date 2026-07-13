package com.jdy.erp.shared.application;

import java.util.Map;
import java.util.Set;

import com.jdy.erp.system.security.CurrentPermissionService;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Component;
import org.springframework.web.server.ResponseStatusException;

@Component
public class DocumentPermissionPolicy {
    private static final Map<String, String> PERMISSIONS = Map.ofEntries(
        Map.entry("salesQuote", "sales.order.audit"),
        Map.entry("salesOrder", "sales.order.audit"),
        Map.entry("deliveryNotice", "sales.out.audit"),
        Map.entry("salesOut", "sales.out.audit"),
        Map.entry("salesReturn", "sales.out.audit"),
        Map.entry("purchaseOrder", "purchase.order.audit"),
        Map.entry("purchaseIn", "purchase.in.audit"),
        Map.entry("purchaseReturn", "purchase.return.audit"),
        Map.entry("receipt", "finance.settle"),
        Map.entry("payment", "finance.settle"),
        Map.entry("productionTask", "production.task.audit"),
        Map.entry("materialIssue", "production.document.audit"),
        Map.entry("productIn", "production.document.audit"),
        Map.entry("otherStockIn", "inventory.other_stock_in.audit"),
        Map.entry("otherStockOut", "inventory.other_stock_out.audit"),
        Map.entry("stockTransfer", "inventory.stock_transfer.audit"),
        Map.entry("stockCount", "inventory.stock_count.audit"),
        Map.entry("stockCountGain", "inventory.stock_count_gain.audit"),
        Map.entry("stockCountLoss", "inventory.stock_count_loss.audit")
    );

    private final CurrentPermissionService permissionService;

    public DocumentPermissionPolicy(CurrentPermissionService permissionService) {
        this.permissionService = permissionService;
    }

    public void requirePermission(String documentType) {
        var permission = permissionCode(documentType);
        if (!permissionService.hasPermission(permission)) {
            throw new ResponseStatusException(HttpStatus.FORBIDDEN, "当前角色无权执行该操作：" + permission);
        }
    }

    public String permissionCode(String documentType) {
        var permission = PERMISSIONS.get(documentType);
        if (permission == null) {
            throw new ResponseStatusException(HttpStatus.NOT_FOUND, "不支持的单据类型");
        }
        return permission;
    }

    public Set<String> supportedDocumentTypes() {
        return PERMISSIONS.keySet();
    }
}
