package com.jdy.erp.sales.api;

import java.math.BigDecimal;
import java.time.LocalDate;
import java.util.List;
import java.util.Map;

import com.jdy.erp.inventory.application.InventoryPostingService;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.bind.annotation.GetMapping;
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

    @GetMapping("/{billNo}")
    public Map<String, Object> detail(@PathVariable String billNo) {
        var billRows = jdbcTemplate.queryForList("""
            SELECT so.id::text AS id,
                   so.bill_no AS "billNo",
                   src.bill_no AS "sourceOrderNo",
                   c.code AS "customerCode",
                   c.name AS customer,
                   to_char(so.bill_date, 'YYYY-MM-DD') AS "billDate",
                   so.department,
                   so.status,
                   so.total_amount AS "totalAmount",
                   so.owner_name AS "ownerName"
            FROM sales_out so
            JOIN md_customer c ON c.id = so.customer_id
            LEFT JOIN sales_order src ON src.id = so.source_order_id
            WHERE so.bill_no = ?
            """, billNo);
        if (billRows.isEmpty()) {
            throw new ResponseStatusException(HttpStatus.NOT_FOUND, "销售出库单不存在");
        }
        var lines = jdbcTemplate.queryForList("""
            SELECT l.line_no AS "lineNo",
                   p.code AS "productCode",
                   p.name AS "productName",
                   COALESCE(p.spec, '') AS spec,
                   w.code AS "warehouseCode",
                   l.qty,
                   l.unit_price AS "unitPrice",
                   l.amount
            FROM sales_out_line l
            JOIN md_product p ON p.id = l.product_id
            LEFT JOIN md_warehouse w ON w.id = l.warehouse_id
            JOIN sales_out so ON so.id = l.bill_id
            WHERE so.bill_no = ?
            ORDER BY l.line_no
            """, billNo);
        return Map.of("action", "DETAIL", "document", billRows.get(0), "lines", lines);
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
            WHERE bill_no = ? AND status = 'DRAFT'
            RETURNING id::text AS id, bill_no AS "billNo", source_order_id::text AS "sourceOrderId"
            """, billNo);
        if (rows.isEmpty()) {
            throw new ResponseStatusException(HttpStatus.CONFLICT, "销售出库单不存在或已审核");
        }
        var billId = String.valueOf(rows.get(0).get("id"));
        var sourceOrderId = rows.get(0).get("sourceOrderId");
        var lines = jdbcTemplate.queryForList("""
            SELECT l.line_no AS "lineNo", p.code AS "productCode", w.code AS "warehouseCode", l.qty
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
        if (sourceOrderId != null) {
            for (var line : lines) {
                jdbcTemplate.update("""
                    UPDATE sales_order_line
                    SET shipped_qty = shipped_qty + ?
                    WHERE order_id = ?::uuid AND line_no = ?
                    """, line.get("qty"), sourceOrderId, line.get("lineNo"));
            }
            refreshSalesOrderOutStatus(String.valueOf(sourceOrderId));
        }
        log("SALES", "AUDIT", "sales_out", billId, true, null);
        return rows.get(0);
    }

    @PostMapping("/{billNo}/reverse")
    @Transactional
    public Map<String, Object> reverse(@PathVariable String billNo) {
        var rows = jdbcTemplate.queryForList("""
            UPDATE sales_out
            SET status = 'REVERSED', reversed_at = now(), updated_at = now(), version = version + 1
            WHERE bill_no = ? AND status = 'AUDITED'
            RETURNING id::text AS id, bill_no AS "billNo", source_order_id::text AS "sourceOrderId"
            """, billNo);
        if (rows.isEmpty()) {
            throw new ResponseStatusException(HttpStatus.CONFLICT, "销售出库单不存在或不能反审核");
        }
        var billId = String.valueOf(rows.get(0).get("id"));
        var sourceOrderId = rows.get(0).get("sourceOrderId");
        var lines = jdbcTemplate.queryForList("""
            SELECT l.line_no AS "lineNo", p.code AS "productCode", w.code AS "warehouseCode", l.qty
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
                (BigDecimal) line.get("qty"),
                "SALES_OUT_REVERSE",
                "SALES_OUT_REVERSE:" + billNo
            );
        }
        if (sourceOrderId != null) {
            for (var line : lines) {
                jdbcTemplate.update("""
                    UPDATE sales_order_line
                    SET shipped_qty = GREATEST(0, shipped_qty - ?)
                    WHERE order_id = ?::uuid AND line_no = ?
                    """, line.get("qty"), sourceOrderId, line.get("lineNo"));
            }
            refreshSalesOrderOutStatus(String.valueOf(sourceOrderId));
        }
        log("SALES", "REVERSE", "sales_out", billId, true, null);
        return rows.get(0);
    }

    @PostMapping("/{billNo}/void")
    @Transactional
    public Map<String, Object> voidBill(@PathVariable String billNo) {
        var rows = jdbcTemplate.queryForList("""
            UPDATE sales_out
            SET status = 'VOID', voided_at = now(), updated_at = now(), version = version + 1
            WHERE bill_no = ? AND status = 'DRAFT'
            RETURNING id::text AS id, bill_no AS "billNo", status
            """, billNo);
        if (rows.isEmpty()) {
            throw new ResponseStatusException(HttpStatus.CONFLICT, "只有草稿销售出库单可以作废");
        }
        log("SALES", "VOID", "sales_out", String.valueOf(rows.get(0).get("id")), true, null);
        return rows.get(0);
    }

    @PostMapping("/{billNo}/red-reverse")
    @ResponseStatus(HttpStatus.CREATED)
    @Transactional
    public Map<String, Object> redReverse(@PathVariable String billNo, @RequestBody RedReverseRequest request) {
        var sourceRows = jdbcTemplate.queryForList("""
            SELECT id::text AS id,
                   source_order_id::text AS "sourceOrderId",
                   customer_id::text AS "customerId",
                   department,
                   total_amount,
                   owner_name AS "ownerName"
            FROM sales_out
            WHERE bill_no = ? AND status = 'AUDITED'
            """, billNo);
        if (sourceRows.isEmpty()) {
            throw new ResponseStatusException(HttpStatus.CONFLICT, "只有已审核销售出库单可以红冲");
        }
        var redBillNo = required(request.redBillNo(), "红冲单号");
        if (!jdbcTemplate.queryForList("SELECT 1 FROM sales_out WHERE bill_no = ?", redBillNo).isEmpty()) {
            throw new ResponseStatusException(HttpStatus.CONFLICT, "红冲单号已存在");
        }
        var source = sourceRows.get(0);
        var redBill = jdbcTemplate.queryForMap("""
            INSERT INTO sales_out (bill_no, source_order_id, customer_id, bill_date, department, status, total_amount, owner_name)
            VALUES (?, ?::uuid, ?::uuid, ?, ?, 'RED_REVERSED', ?, ?)
            RETURNING id::text AS id, bill_no AS "billNo", status, total_amount AS "totalAmount"
            """,
            redBillNo,
            source.get("sourceOrderId"),
            source.get("customerId"),
            LocalDate.parse(required(request.billDate(), "红冲日期")),
            source.get("department"),
            ((BigDecimal) source.get("total_amount")).negate(),
            request.ownerName() == null || request.ownerName().isBlank() ? source.get("ownerName") : request.ownerName().trim()
        );
        var lines = jdbcTemplate.queryForList("""
            SELECT l.line_no AS "lineNo",
                   p.code AS "productCode",
                   w.code AS "warehouseCode",
                   l.product_id::text AS "productId",
                   l.warehouse_id::text AS "warehouseId",
                   l.qty,
                   l.unit_price AS "unitPrice",
                   l.amount
            FROM sales_out_line l
            JOIN md_product p ON p.id = l.product_id
            JOIN md_warehouse w ON w.id = l.warehouse_id
            JOIN sales_out so ON so.id = l.bill_id
            WHERE so.bill_no = ?
            ORDER BY l.line_no
            """, billNo);
        for (var line : lines) {
            var qty = (BigDecimal) line.get("qty");
            jdbcTemplate.update("""
                INSERT INTO sales_out_line (bill_id, line_no, product_id, warehouse_id, qty, unit_price, amount)
                VALUES (?::uuid, ?, ?::uuid, ?::uuid, ?, ?, ?)
                """,
                redBill.get("id"),
                line.get("lineNo"),
                line.get("productId"),
                line.get("warehouseId"),
                qty.negate(),
                line.get("unitPrice"),
                ((BigDecimal) line.get("amount")).negate()
            );
            postingService.post(
                String.valueOf(line.get("productCode")),
                String.valueOf(line.get("warehouseCode")),
                qty,
                "SALES_OUT_RED",
                "SALES_OUT_RED:" + redBillNo
            );
            if (source.get("sourceOrderId") != null) {
                jdbcTemplate.update("""
                    UPDATE sales_order_line
                    SET shipped_qty = GREATEST(0, shipped_qty - ?)
                    WHERE order_id = ?::uuid AND line_no = ?
                    """, qty, source.get("sourceOrderId"), line.get("lineNo"));
            }
        }
        if (source.get("sourceOrderId") != null) {
            refreshSalesOrderOutStatus(String.valueOf(source.get("sourceOrderId")));
        }
        log("SALES", "RED_REVERSE", "sales_out", String.valueOf(redBill.get("id")), true, null);
        return redBill;
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

    private void refreshSalesOrderOutStatus(String orderId) {
        jdbcTemplate.update("""
            UPDATE sales_order
            SET out_status = CASE
                    WHEN NOT EXISTS (SELECT 1 FROM sales_order_line WHERE order_id = ?::uuid AND shipped_qty > 0) THEN 'NOT_OUT'
                    WHEN NOT EXISTS (SELECT 1 FROM sales_order_line WHERE order_id = ?::uuid AND shipped_qty < qty) THEN 'ALL_OUT'
                    ELSE 'PART_OUT'
                END,
                updated_at = now(),
                version = version + 1
            WHERE id = ?::uuid
            """, orderId, orderId, orderId);
    }

    private void log(String module, String action, String targetType, String targetId, boolean success, String reason) {
        jdbcTemplate.update("""
            INSERT INTO sys_operation_log (module_code, action_code, target_type, target_id, success, failure_reason)
            VALUES (?, ?, ?, ?::uuid, ?, ?)
            """, module, action, targetType, targetId, success, reason);
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

    public record RedReverseRequest(String redBillNo, String billDate, String ownerName) {
    }
}
