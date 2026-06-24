package com.jdy.erp.sales.api;

import java.math.BigDecimal;
import java.time.LocalDate;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

import com.jdy.erp.system.security.RequirePermission;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.ResponseStatus;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.server.ResponseStatusException;

@RestController
@RequestMapping("/api/sales-orders")
public class SalesOrderController {
    private final JdbcTemplate jdbcTemplate;

    public SalesOrderController(JdbcTemplate jdbcTemplate) {
        this.jdbcTemplate = jdbcTemplate;
    }

    @PostMapping("/draft")
    @ResponseStatus(HttpStatus.CREATED)
    @Transactional
    public Map<String, Object> saveDraft(@RequestBody SalesOrderDraftRequest request) {
        var existingRows = jdbcTemplate.queryForList("SELECT status FROM sales_order WHERE bill_no = ?", required(request.billNo(), "单据编号"));
        if (!existingRows.isEmpty() && !"DRAFT".equals(existingRows.get(0).get("status"))) {
            throw new ResponseStatusException(HttpStatus.CONFLICT, "已审核销售订单不能覆盖保存");
        }
        var customerId = lookupId("md_customer", request.customerCode(), "客户");
        var totalAmount = request.lines().stream()
            .map(line -> line.qty().multiply(line.unitPrice()))
            .reduce(BigDecimal.ZERO, BigDecimal::add);
        var order = jdbcTemplate.queryForMap("""
            INSERT INTO sales_order (bill_no, customer_id, bill_date, department, status, total_amount, owner_name)
            VALUES (?, ?::uuid, ?, ?, 'DRAFT', ?, ?)
            ON CONFLICT (bill_no) DO UPDATE
            SET customer_id = EXCLUDED.customer_id,
                bill_date = EXCLUDED.bill_date,
                department = EXCLUDED.department,
                status = 'DRAFT',
                out_status = 'NOT_OUT',
                total_amount = EXCLUDED.total_amount,
                owner_name = EXCLUDED.owner_name,
                updated_at = now(),
                version = sales_order.version + 1
            RETURNING id::text AS id, bill_no AS "billNo", total_amount AS "totalAmount"
            """,
            required(request.billNo(), "单据编号"),
            customerId,
            LocalDate.parse(required(request.billDate(), "业务日期")),
            request.department(),
            totalAmount,
            request.ownerName()
        );
        var orderId = order.get("id");
        jdbcTemplate.update("DELETE FROM sales_order_line WHERE order_id = ?::uuid", orderId);
        var lineNo = 1;
        for (var line : request.lines()) {
            var productId = lookupId("md_product", line.productCode(), "商品");
            var warehouseId = lookupId("md_warehouse", line.warehouseCode(), "仓库");
            var amount = line.qty().multiply(line.unitPrice());
            jdbcTemplate.update("""
                INSERT INTO sales_order_line (order_id, line_no, product_id, warehouse_id, qty, unit_price, amount, line_remark)
                VALUES (?::uuid, ?, ?::uuid, ?::uuid, ?, ?, ?, ?)
                """,
                orderId,
                lineNo,
                productId,
                warehouseId,
                line.qty(),
                line.unitPrice(),
                amount,
                optionalText(line.lineRemark())
            );
            lineNo += 1;
        }
        return order;
    }

    @PostMapping("/{billNo}/audit")
    @RequirePermission("sales.order.audit")
    public Map<String, Object> audit(@PathVariable String billNo) {
        return updateStatus(billNo, "AUDITED", "DRAFT");
    }

    @DeleteMapping("/{billNo}")
    @RequirePermission("sales.order.audit")
    public Map<String, Object> delete(@PathVariable String billNo) {
        var deleted = jdbcTemplate.queryForList("""
            DELETE FROM sales_order
            WHERE bill_no = ? AND status = 'DRAFT'
            RETURNING id::text AS id, bill_no AS "billNo"
            """, billNo);
        if (deleted.isEmpty()) {
            throw new ResponseStatusException(HttpStatus.CONFLICT, "只有草稿销售订单可以删除");
        }
        return deleted.get(0);
    }

    @GetMapping("/{billNo}")
    public Map<String, Object> detail(@PathVariable String billNo) {
        return orderPayload(billNo, "DETAIL");
    }

    @GetMapping("/{billNo}/export")
    public Map<String, Object> export(@PathVariable String billNo) {
        return orderPayload(billNo, "EXPORT");
    }

    @GetMapping("/{billNo}/print")
    public Map<String, Object> print(@PathVariable String billNo) {
        return orderPayload(billNo, "PRINT");
    }

    private String lookupId(String table, String code, String label) {
        var value = required(code, label + "编码");
        var rows = jdbcTemplate.queryForList("SELECT id::text AS id FROM " + table + " WHERE code = ? AND enabled = TRUE", value);
        if (rows.isEmpty()) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, label + "不存在或已禁用");
        }
        return String.valueOf(rows.get(0).get("id"));
    }

    private Map<String, Object> updateStatus(String billNo, String status, String fromStatus) {
        var rows = jdbcTemplate.queryForList("""
            UPDATE sales_order
            SET status = ?, updated_at = now(), version = version + 1
            WHERE bill_no = ? AND status = ?
            RETURNING id::text AS id, bill_no AS "billNo", status
            """, status, billNo, fromStatus);
        if (rows.isEmpty()) {
            throw new ResponseStatusException(HttpStatus.CONFLICT, "销售订单不存在或状态不允许操作");
        }
        return rows.get(0);
    }

    private Map<String, Object> orderPayload(String billNo, String action) {
        var orderRows = jdbcTemplate.queryForList("""
            SELECT so.id::text AS id,
                   so.bill_no AS "billNo",
                   c.code AS "customerCode",
                   c.name AS customer,
                   to_char(so.bill_date, 'YYYY-MM-DD') AS "billDate",
                   so.department,
                   so.status,
                   so.total_amount AS "totalAmount",
                   so.owner_name AS "ownerName"
            FROM sales_order so
            JOIN md_customer c ON c.id = so.customer_id
            WHERE so.bill_no = ?
            """, billNo);
        if (orderRows.isEmpty()) {
            throw new ResponseStatusException(HttpStatus.NOT_FOUND, "销售订单不存在");
        }
        var lines = jdbcTemplate.queryForList("""
            SELECT l.line_no AS "lineNo",
                   p.code AS "productCode",
                   p.name AS "productName",
                   COALESCE(p.spec, '') AS spec,
                   w.code AS "warehouseCode",
                   l.qty,
                   l.shipped_qty AS "shippedQty",
                   GREATEST(0, l.qty - l.shipped_qty) AS "remainingQty",
                   l.unit_price AS "unitPrice",
                   l.amount,
                   COALESCE(l.line_remark, '') AS "lineRemark"
            FROM sales_order_line l
            JOIN md_product p ON p.id = l.product_id
            LEFT JOIN md_warehouse w ON w.id = l.warehouse_id
            JOIN sales_order so ON so.id = l.order_id
            WHERE so.bill_no = ?
            ORDER BY l.line_no
            """, billNo);
        var sourceOrderId = String.valueOf(orderRows.get(0).get("id"));
        var enrichedLines = lines.stream().map(line -> {
            var copy = new HashMap<String, Object>(line);
            copy.put("downstreamDocs", downstreamSalesOutDocs(sourceOrderId, line.get("lineNo")));
            return copy;
        }).toList();
        return Map.of("action", action, "order", orderRows.get(0), "lines", enrichedLines);
    }

    private List<Map<String, Object>> downstreamSalesOutDocs(String sourceOrderId, Object sourceLineNo) {
        var docs = jdbcTemplate.queryForList("""
            SELECT so.bill_no AS "billNo",
                   'salesOut' AS type,
                   '销售出库单' AS "typeLabel",
                   so.status,
                   to_char(so.bill_date, 'YYYY-MM-DD') AS "billDate",
                   COALESCE(l.source_line_no, l.line_no) AS "sourceLineNo",
                   l.line_no AS "downstreamLineNo",
                   l.qty,
                   l.amount
            FROM sales_out_line l
            JOIN sales_out so ON so.id = l.bill_id
            WHERE so.source_order_id = ?::uuid
              AND COALESCE(l.source_line_no, l.line_no) = ?
              AND so.status = 'AUDITED'
            ORDER BY so.bill_date DESC, so.bill_no DESC, l.line_no
            """, sourceOrderId, sourceLineNo);
        return docs.stream().<Map<String, Object>>map(doc -> {
            var copy = new HashMap<String, Object>(doc);
            copy.put("riskLevel", "HIGH");
            copy.put("reverseImpact", "反审核将冲销销售出库库存流水，并把源销售订单第 "
                + doc.get("sourceLineNo") + " 行已出库数量减少 " + doc.get("qty") + "，随后重算出库状态。");
            copy.put("redReverseImpact", "红冲将生成负数销售出库单，原单标记已红冲，并同样回退源销售订单第 "
                + doc.get("sourceLineNo") + " 行已出库数量。");
            return copy;
        }).toList();
    }

    private String required(String value, String label) {
        if (value == null || value.isBlank()) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, label + "不能为空");
        }
        return value.trim();
    }

    private String optionalText(String value) {
        return value == null || value.isBlank() ? null : value.trim();
    }

    public record SalesOrderDraftRequest(
        String billNo,
        String customerCode,
        String billDate,
        String department,
        String ownerName,
        List<SalesOrderLineRequest> lines
    ) {
        public SalesOrderDraftRequest {
            if (lines == null || lines.isEmpty()) {
                throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "至少需要一条分录");
            }
        }
    }

    public record SalesOrderLineRequest(
        String productCode,
        String warehouseCode,
        BigDecimal qty,
        BigDecimal unitPrice,
        String lineRemark
    ) {
    }
}
