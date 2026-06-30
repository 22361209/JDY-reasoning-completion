package com.jdy.erp.shared.api;

import java.util.Map;

import com.jdy.erp.shared.application.BillLifecycleService;
import com.jdy.erp.shared.application.BillLifecycleService.BillLifecycleTarget;
import com.jdy.erp.shared.application.BillLifecycleService.VoidRequest;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.server.ResponseStatusException;
import org.springframework.http.HttpStatus;

@RestController
@RequestMapping("/api/document-lifecycle")
public class BillLifecycleController {
    private static final Map<String, BillLifecycleTarget> TARGETS = Map.ofEntries(
        Map.entry("salesQuote", new BillLifecycleTarget("sales_quote", "sales_quote_line", "quote_id", "SALES", "sales_quote")),
        Map.entry("salesOrder", new BillLifecycleTarget("sales_order", "sales_order_line", "order_id", "SALES", "sales_order")),
        Map.entry("deliveryNotice", new BillLifecycleTarget("delivery_notice", "delivery_notice_line", "bill_id", "SALES", "delivery_notice")),
        Map.entry("purchaseOrder", new BillLifecycleTarget("purchase_order", "purchase_order_line", "order_id", "PURCHASE", "purchase_order")),
        Map.entry("salesOut", new BillLifecycleTarget("sales_out", "sales_out_line", "bill_id", "SALES", "sales_out")),
        Map.entry("purchaseIn", new BillLifecycleTarget("purchase_in", "purchase_in_line", "bill_id", "PURCHASE", "purchase_in")),
        Map.entry("purchaseReturn", new BillLifecycleTarget("purchase_return", "purchase_return_line", "bill_id", "PURCHASE", "purchase_return")),
        Map.entry("materialIssue", new BillLifecycleTarget("production_material_issue", "production_material_issue_line", "issue_id", "PRODUCTION", "production_material_issue")),
        Map.entry("productIn", new BillLifecycleTarget("production_completion", "production_completion_line", "completion_id", "PRODUCTION", "production_completion")),
        Map.entry("otherStockIn", new BillLifecycleTarget("other_stock_in", "other_stock_in_line", "bill_id", "INVENTORY", "other_stock_in")),
        Map.entry("otherStockOut", new BillLifecycleTarget("other_stock_out", "other_stock_out_line", "bill_id", "INVENTORY", "other_stock_out")),
        Map.entry("stockTransfer", new BillLifecycleTarget("stock_transfer", "stock_transfer_line", "bill_id", "INVENTORY", "stock_transfer")),
        Map.entry("stockCount", new BillLifecycleTarget("stock_count", "stock_count_line", "bill_id", "INVENTORY", "stock_count")),
        Map.entry("stockCountGain", new BillLifecycleTarget("stock_count_gain", "stock_count_gain_line", "bill_id", "INVENTORY", "stock_count_gain")),
        Map.entry("stockCountLoss", new BillLifecycleTarget("stock_count_loss", "stock_count_loss_line", "bill_id", "INVENTORY", "stock_count_loss"))
    );

    private final BillLifecycleService lifecycleService;

    public BillLifecycleController(BillLifecycleService lifecycleService) {
        this.lifecycleService = lifecycleService;
    }

    @PostMapping("/{type}/{billNo}/close")
    public Map<String, Object> close(@PathVariable String type, @PathVariable String billNo, @RequestBody ReasonRequest request) {
        return lifecycleService.closeBill(target(type), billNo, request.reason());
    }

    @PostMapping("/{type}/{billNo}/unclose")
    public Map<String, Object> unclose(@PathVariable String type, @PathVariable String billNo, @RequestBody(required = false) ReasonRequest request) {
        return lifecycleService.reopenBill(target(type), billNo, request == null ? null : request.reason());
    }

    @PostMapping("/{type}/{billNo}/freeze")
    public Map<String, Object> freeze(@PathVariable String type, @PathVariable String billNo, @RequestBody ReasonRequest request) {
        return lifecycleService.freezeBill(target(type), billNo, request.reason());
    }

    @PostMapping("/{type}/{billNo}/unfreeze")
    public Map<String, Object> unfreeze(@PathVariable String type, @PathVariable String billNo, @RequestBody(required = false) ReasonRequest request) {
        return lifecycleService.unfreezeBill(target(type), billNo, request == null ? null : request.reason());
    }

    @PostMapping("/{type}/{billNo}/void")
    public Map<String, Object> voidBill(@PathVariable String type, @PathVariable String billNo, @RequestBody VoidRequest request) {
        return lifecycleService.voidBill(target(type), billNo, request);
    }

    @PostMapping("/{type}/{billNo}/lines/{lineNo}/close")
    public Map<String, Object> closeLine(@PathVariable String type, @PathVariable String billNo, @PathVariable int lineNo, @RequestBody ReasonRequest request) {
        return lifecycleService.setLineClosed(target(type), billNo, lineNo, true, request.reason());
    }

    @PostMapping("/{type}/{billNo}/lines/{lineNo}/unclose")
    public Map<String, Object> uncloseLine(@PathVariable String type, @PathVariable String billNo, @PathVariable int lineNo, @RequestBody(required = false) ReasonRequest request) {
        return lifecycleService.setLineClosed(target(type), billNo, lineNo, false, request == null ? null : request.reason());
    }

    @PostMapping("/{type}/{billNo}/lines/{lineNo}/freeze")
    public Map<String, Object> freezeLine(@PathVariable String type, @PathVariable String billNo, @PathVariable int lineNo, @RequestBody ReasonRequest request) {
        return lifecycleService.setLineFrozen(target(type), billNo, lineNo, true, request.reason());
    }

    @PostMapping("/{type}/{billNo}/lines/{lineNo}/unfreeze")
    public Map<String, Object> unfreezeLine(@PathVariable String type, @PathVariable String billNo, @PathVariable int lineNo, @RequestBody(required = false) ReasonRequest request) {
        return lifecycleService.setLineFrozen(target(type), billNo, lineNo, false, request == null ? null : request.reason());
    }

    private BillLifecycleTarget target(String type) {
        var target = TARGETS.get(type);
        if (target == null) {
            throw new ResponseStatusException(HttpStatus.NOT_FOUND, "不支持的单据类型");
        }
        return target;
    }

    public record ReasonRequest(String reason) {
    }
}
