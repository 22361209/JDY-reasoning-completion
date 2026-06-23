package com.jdy.erp.sales.api;

import java.math.BigDecimal;
import java.time.LocalDate;
import java.util.List;
import java.util.Map;

import com.jdy.erp.inventory.application.InventoryPostingService;
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
@RequestMapping("/api/sales-outs")
public class SalesOutController {
    private final JdbcTemplate jdbcTemplate;
    private final InventoryPostingService postingService;

    public SalesOutController(JdbcTemplate jdbcTemplate, InventoryPostingService postingService) {
        this.jdbcTemplate = jdbcTemplate;
        this.postingService = postingService;
    }

    @PostMapping("/draft")
    @ResponseStatus(HttpStatus.CREATED)
    @Transactional
    public Map<String, Object> saveDraft(@RequestBody SalesOutDraftRequest request) {
        var customerId = lookupId("md_customer", request.customerCode(), "客户");
        var sourceOrderId = sourceOrderId(request.sourceOrderNo());
        var totalAmount = request.lines().stream()
            .map(line -> line.qty().multiply(line.unitPrice()))
            .reduce(BigDecimal.ZERO, BigDecimal::add);
        var bill = jdbcTemplate.queryForMap("""
            INSERT INTO sales_out (bill_no, source_order_id, customer_id, bill_date, department, status, total_amount, owner_name)
            VALUES (?, ?::uuid, ?::uuid, ?, ?, 'DRAFT', ?, ?)
            ON CONFLICT (bill_no) DO UPDATE
            SET source_order_id = EXCLUDED.source_order_id,
                customer_id = EXCLUDED.customer_id,
                bill_date = EXCLUDED.bill_date,
                department = EXCLUDED.department,
                status = 'DRAFT',
                total_amount = EXCLUDED.total_amount,
                owner_name = EXCLUDED.owner_name,
                updated_at = now(),
                version = sales_out.version + 1
            RETURNING id::text AS id, bill_no AS "billNo", total_amount AS "totalAmount"
            """,
            required(request.billNo(), "单据编号"),
            sourceOrderId,
            customerId,
            LocalDate.parse(required(request.billDate(), "业务日期")),
            request.department(),
            totalAmount,
            request.ownerName()
        );
        var billId = bill.get("id");
        jdbcTemplate.update("DELETE FROM sales_out_line WHERE bill_id = ?::uuid", billId);
        insertLines(billId, request.lines());
        return bill;
    }

    @PostMapping("/{billNo}/audit")
    @Transactional
    public Map<String, Object> audit(@PathVariable String billNo) {
        var rows = jdbcTemplate.queryForList("""
            UPDATE sales_out
            SET status = 'AUDITED', updated_at = now(), version = version + 1
            WHERE bill_no = ?
            RETURNING id::text AS id, bill_no AS "billNo", source_order_id::text AS "sourceOrderId"
            """, billNo);
        if (rows.isEmpty()) {
            throw new ResponseStatusException(HttpStatus.NOT_FOUND, "销售出库单不存在");
        }
        var lines = jdbcTemplate.queryForList("""
            SELECT p.code AS "productCode", w.code AS "warehouseCode", l.qty
            FROM sales_out_line l
            JOIN md_product p ON p.id = l.product_id
            JOIN md_warehouse w ON w.id = l.warehouse_id
            JOIN sales_out so ON so.id = l.bill_id
            WHERE so.bill_no = ?
            ORDER BY l.line_no
            """, billNo);
        for (var line : lines) {
            postingService.post(
                String.valueOf(line.get("productCode")),
                String.valueOf(line.get("warehouseCode")),
                ((BigDecimal) line.get("qty")).negate(),
                "SALES_OUT",
                "SALES_OUT:" + billNo
            );
        }
        var sourceOrderId = rows.get(0).get("sourceOrderId");
        if (sourceOrderId != null) {
            jdbcTemplate.update("UPDATE sales_order SET out_status = 'ALL_OUT', updated_at = now(), version = version + 1 WHERE id = ?::uuid", sourceOrderId);
        }
        return rows.get(0);
    }

    private void insertLines(Object billId, List<SalesOutLineRequest> lines) {
        var lineNo = 1;
        for (var line : lines) {
            var productId = lookupId("md_product", line.productCode(), "商品");
            var warehouseId = lookupId("md_warehouse", line.warehouseCode(), "仓库");
            var amount = line.qty().multiply(line.unitPrice());
            jdbcTemplate.update("""
                INSERT INTO sales_out_line (bill_id, line_no, product_id, warehouse_id, qty, unit_price, amount)
                VALUES (?::uuid, ?, ?::uuid, ?::uuid, ?, ?, ?)
                """, billId, lineNo, productId, warehouseId, line.qty(), line.unitPrice(), amount);
            lineNo += 1;
        }
    }

    private String sourceOrderId(String sourceOrderNo) {
        if (sourceOrderNo == null || sourceOrderNo.isBlank()) {
            return null;
        }
        var rows = jdbcTemplate.queryForList("SELECT id::text AS id FROM sales_order WHERE bill_no = ?", sourceOrderNo.trim());
        if (rows.isEmpty()) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "销售订单不存在");
        }
        return String.valueOf(rows.get(0).get("id"));
    }

    private String lookupId(String table, String code, String label) {
        if (code == null || code.isBlank()) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, label + "编码不能为空");
        }
        var rows = jdbcTemplate.queryForList("SELECT id::text AS id FROM " + table + " WHERE code = ? AND enabled = TRUE", code.trim());
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

    public record SalesOutDraftRequest(String billNo, String sourceOrderNo, String customerCode, String billDate, String department, String ownerName, List<SalesOutLineRequest> lines) {
        public SalesOutDraftRequest {
            if (lines == null || lines.isEmpty()) {
                throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "至少需要一条分录");
            }
        }
    }

    public record SalesOutLineRequest(String productCode, String warehouseCode, BigDecimal qty, BigDecimal unitPrice) {
    }
}
