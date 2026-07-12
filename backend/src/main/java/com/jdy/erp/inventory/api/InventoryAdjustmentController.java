package com.jdy.erp.inventory.api;

import java.math.BigDecimal;
import java.util.Map;
import java.util.regex.Pattern;

import com.jdy.erp.inventory.application.InventoryTestAdjustmentAccessPolicy;
import com.jdy.erp.inventory.application.InventoryPostingService;
import com.jdy.erp.system.security.RequirePermission;
import org.springframework.http.HttpStatus;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.ResponseStatus;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.server.ResponseStatusException;

@RestController
@RequestMapping("/api/inventory")
public class InventoryAdjustmentController {
    private static final Pattern TEST_SOURCE_PATTERN = Pattern.compile("^A\\d+[A-Za-z0-9_:-]*$");

    private final InventoryPostingService postingService;
    private final InventoryTestAdjustmentAccessPolicy accessPolicy;

    public InventoryAdjustmentController(
        InventoryPostingService postingService,
        InventoryTestAdjustmentAccessPolicy accessPolicy
    ) {
        this.postingService = postingService;
        this.accessPolicy = accessPolicy;
    }

    @PostMapping("/adjustments")
    @ResponseStatus(HttpStatus.CREATED)
    @RequirePermission("system.account_set.manage")
    public Map<String, Object> adjust(@RequestBody InventoryAdjustmentRequest request) {
        accessPolicy.requireAllowed();
        return postingService.post(
            request.productCode(),
            request.warehouseCode(),
            request.qtyDelta(),
            requireTestSource(request.txnType(), "txnType"),
            requireTestSource(request.sourceBillType(), "sourceBillType")
        );
    }

    private String requireTestSource(String value, String field) {
        var normalized = value == null ? "" : value.trim();
        if (!TEST_SOURCE_PATTERN.matcher(normalized).matches()) {
            throw new ResponseStatusException(
                HttpStatus.BAD_REQUEST,
                field + " 必须使用 A 编号测试来源，禁止伪装正式库存业务"
            );
        }
        return normalized;
    }

    public record InventoryAdjustmentRequest(
        String productCode,
        String warehouseCode,
        BigDecimal qtyDelta,
        String txnType,
        String sourceBillType
    ) {
    }
}
