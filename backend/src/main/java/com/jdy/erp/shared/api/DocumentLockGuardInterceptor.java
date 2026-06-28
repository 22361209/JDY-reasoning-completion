package com.jdy.erp.shared.api;

import java.util.Map;
import java.util.regex.Pattern;

import com.jdy.erp.shared.application.DocumentLockService;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import org.springframework.stereotype.Component;
import org.springframework.web.servlet.HandlerInterceptor;

@Component
public class DocumentLockGuardInterceptor implements HandlerInterceptor {
    private static final Map<String, String> API_PREFIX_TO_TYPE = Map.ofEntries(
        Map.entry("/api/sales-orders/", "salesOrder"),
        Map.entry("/api/sales-outs/", "salesOut"),
        Map.entry("/api/purchase-orders/", "purchaseOrder"),
        Map.entry("/api/purchase-ins/", "purchaseIn"),
        Map.entry("/api/purchase-returns/", "purchaseReturn"),
        Map.entry("/api/other-stock-ins/", "otherStockIn"),
        Map.entry("/api/other-stock-outs/", "otherStockOut"),
        Map.entry("/api/stock-transfers/", "stockTransfer"),
        Map.entry("/api/stock-counts/", "stockCount"),
        Map.entry("/api/stock-count-gains/", "stockCountGain"),
        Map.entry("/api/stock-count-losses/", "stockCountLoss"),
        Map.entry("/api/production/material-issues/", "materialIssue"),
        Map.entry("/api/production/product-ins/", "productIn")
    );
    private static final Pattern DOCUMENT_LIFECYCLE =
        Pattern.compile("^/api/document-lifecycle/([^/]+)/([^/]+)/.+$");

    private final DocumentLockService lockService;

    public DocumentLockGuardInterceptor(DocumentLockService lockService) {
        this.lockService = lockService;
    }

    @Override
    public boolean preHandle(HttpServletRequest request, HttpServletResponse response, Object handler) {
        var method = request.getMethod();
        if ("GET".equalsIgnoreCase(method) || "OPTIONS".equalsIgnoreCase(method)) {
            return true;
        }
        var path = request.getRequestURI();
        if (path.startsWith("/api/document-locks/")) {
            return true;
        }
        var lifecycle = DOCUMENT_LIFECYCLE.matcher(path);
        if (lifecycle.matches()) {
            lockService.assertWritable(lifecycle.group(1), lifecycle.group(2));
            return true;
        }
        for (var entry : API_PREFIX_TO_TYPE.entrySet()) {
            if (path.startsWith(entry.getKey())) {
                var tail = path.substring(entry.getKey().length());
                var slash = tail.indexOf('/');
                var billNo = slash >= 0 ? tail.substring(0, slash) : tail;
                if (!billNo.isBlank() && !"draft".equals(billNo)) {
                    lockService.assertWritable(entry.getValue(), billNo);
                }
                return true;
            }
        }
        return true;
    }
}
