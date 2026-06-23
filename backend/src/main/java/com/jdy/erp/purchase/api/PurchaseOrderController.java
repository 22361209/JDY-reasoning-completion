package com.jdy.erp.purchase.api;

import java.math.BigDecimal;
import java.time.LocalDate;
import java.util.List;
import java.util.Map;

import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.ResponseStatus;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.server.ResponseStatusException;

@RestController
@RequestMapping("/api/purchase-orders")
public class PurchaseOrderController {
    private final JdbcTemplate jdbcTemplate;

    public PurchaseOrderController(JdbcTemplate jdbcTemplate) {
        this.jdbcTemplate = jdbcTemplate;
    }

    @PostMapping("/draft")
    @ResponseStatus(HttpStatus.CREATED)
    @Transactional
    public Map<String, Object> saveDraft(@RequestBody PurchaseOrderDraftRequest request) {
        var supplierId = lookupId("md_supplier", request.supplierCode(), "供应商");
        var totalAmount = request.lines().stream()
            .map(line -> line.qty().multiply(line.unitPrice()))
            .reduce(BigDecimal.ZERO, BigDecimal::add);
        var order = jdbcTemplate.queryForMap("""
            INSERT INTO purchase_order (bill_no, supplier_id, bill_date, department, status, in_status, total_amount, owner_name)
            VALUES (?, ?::uuid, ?, ?, 'DRAFT', 'NOT_IN', ?, ?)
            ON CONFLICT (bill_no) DO UPDATE
            SET supplier_id = EXCLUDED.supplier_id,
                bill_date = EXCLUDED.bill_date,
                department = EXCLUDED.department,
                status = 'DRAFT',
                in_status = 'NOT_IN',
                total_amount = EXCLUDED.total_amount,
                owner_name = EXCLUDED.owner_name,
                updated_at = now(),
                version = purchase_order.version + 1
            RETURNING id::text AS id, bill_no AS "billNo", total_amount AS "totalAmount"
            """,
            required(request.billNo(), "单据编号"),
            supplierId,
            LocalDate.parse(required(request.billDate(), "业务日期")),
            request.department(),
            totalAmount,
            request.ownerName()
        );
        var orderId = order.get("id");
        jdbcTemplate.update("DELETE FROM purchase_order_line WHERE order_id = ?::uuid", orderId);
        var lineNo = 1;
        for (var line : request.lines()) {
            var productId = lookupId("md_product", line.productCode(), "商品");
            var warehouseId = lookupId("md_warehouse", line.warehouseCode(), "仓库");
            var amount = line.qty().multiply(line.unitPrice());
            jdbcTemplate.update("""
                INSERT INTO purchase_order_line (order_id, line_no, product_id, warehouse_id, qty, unit_price, amount)
                VALUES (?::uuid, ?, ?::uuid, ?::uuid, ?, ?, ?)
                """,
                orderId,
                lineNo,
                productId,
                warehouseId,
                line.qty(),
                line.unitPrice(),
                amount
            );
            lineNo += 1;
        }
        return order;
    }

    @PostMapping("/{billNo}/audit")
    public Map<String, Object> audit(@PathVariable String billNo) {
        var rows = jdbcTemplate.queryForList("""
            UPDATE purchase_order
            SET status = 'AUDITED', updated_at = now(), version = version + 1
            WHERE bill_no = ?
            RETURNING id::text AS id, bill_no AS "billNo", status
            """, billNo);
        if (rows.isEmpty()) {
            throw new ResponseStatusException(HttpStatus.NOT_FOUND, "采购订单不存在");
        }
        return rows.get(0);
    }

    private String lookupId(String table, String code, String label) {
        var value = required(code, label + "编码");
        var rows = jdbcTemplate.queryForList("SELECT id::text AS id FROM " + table + " WHERE code = ? AND enabled = TRUE", value);
        if (rows.isEmpty()) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, label + "不存在或已禁用");
        }
        return String.valueOf(rows.get(0).get("id"));
    }

    private String required(String value, String label) {
        if (value == null || value.isBlank()) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, label + "不能为空");
        }
        return value.trim();
    }

    public record PurchaseOrderDraftRequest(
        String billNo,
        String supplierCode,
        String billDate,
        String department,
        String ownerName,
        List<PurchaseOrderLineRequest> lines
    ) {
        public PurchaseOrderDraftRequest {
            if (lines == null || lines.isEmpty()) {
                throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "至少需要一条分录");
            }
        }
    }

    public record PurchaseOrderLineRequest(
        String productCode,
        String warehouseCode,
        BigDecimal qty,
        BigDecimal unitPrice
    ) {
    }
}
