package com.jdy.erp.purchase.api;

import java.math.BigDecimal;
import java.time.LocalDate;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

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
@RequestMapping("/api/purchase-orders")
public class PurchaseOrderController {
    private final JdbcTemplate jdbcTemplate;

    public PurchaseOrderController(JdbcTemplate jdbcTemplate) {
        this.jdbcTemplate = jdbcTemplate;
    }

    @GetMapping("/{billNo}")
    public Map<String, Object> detail(@PathVariable String billNo) {
        var orderRows = jdbcTemplate.queryForList("""
            SELECT po.id::text AS id,
                   po.bill_no AS "billNo",
                   s.code AS "supplierCode",
                   s.name AS supplier,
                   to_char(po.bill_date, 'YYYY-MM-DD') AS "billDate",
                   po.department,
                   po.status,
                   po.in_status AS "inStatus",
                   po.total_amount AS "totalAmount",
                   po.owner_name AS "ownerName"
            FROM purchase_order po
            JOIN md_supplier s ON s.id = po.supplier_id
            WHERE po.bill_no = ?
            """, billNo);
        if (orderRows.isEmpty()) {
            throw new ResponseStatusException(HttpStatus.NOT_FOUND, "采购订单不存在");
        }
        var lines = jdbcTemplate.queryForList("""
            SELECT l.line_no AS "lineNo",
                   p.code AS "productCode",
                   p.name AS "productName",
                   COALESCE(p.spec, '') AS spec,
                   w.code AS "warehouseCode",
                   l.qty,
                   l.received_qty AS "receivedQty",
                   GREATEST(0, l.qty - l.received_qty) AS "remainingQty",
                   l.unit_price AS "unitPrice",
                   l.amount,
                   COALESCE(l.line_remark, '') AS "lineRemark"
            FROM purchase_order_line l
            JOIN md_product p ON p.id = l.product_id
            LEFT JOIN md_warehouse w ON w.id = l.warehouse_id
            JOIN purchase_order po ON po.id = l.order_id
            WHERE po.bill_no = ?
            ORDER BY l.line_no
            """, billNo);
        var sourceOrderId = String.valueOf(orderRows.get(0).get("id"));
        var enrichedLines = lines.stream().map(line -> {
            var copy = new HashMap<String, Object>(line);
            copy.put("downstreamDocs", downstreamPurchaseInDocs(sourceOrderId, line.get("lineNo")));
            return copy;
        }).toList();
        return Map.of("action", "DETAIL", "document", orderRows.get(0), "lines", enrichedLines);
    }

    private List<Map<String, Object>> downstreamPurchaseInDocs(String sourceOrderId, Object sourceLineNo) {
        var docs = jdbcTemplate.queryForList("""
            SELECT pi.bill_no AS "billNo",
                   'purchaseIn' AS type,
                   '采购入库单' AS "typeLabel",
                   pi.status,
                   to_char(pi.bill_date, 'YYYY-MM-DD') AS "billDate",
                   COALESCE(l.source_line_no, l.line_no) AS "sourceLineNo",
                   l.line_no AS "downstreamLineNo",
                   l.qty,
                   l.amount
            FROM purchase_in_line l
            JOIN purchase_in pi ON pi.id = l.bill_id
            WHERE pi.source_order_id = ?::uuid
              AND COALESCE(l.source_line_no, l.line_no) = ?
              AND pi.status = 'AUDITED'
            ORDER BY pi.bill_date DESC, pi.bill_no DESC, l.line_no
            """, sourceOrderId, sourceLineNo);
        return docs.stream().<Map<String, Object>>map(doc -> {
            var copy = new HashMap<String, Object>(doc);
            copy.put("riskLevel", "HIGH");
            copy.put("reverseImpact", "反审核将冲销采购入库库存流水，并把源采购订单第 "
                + doc.get("sourceLineNo") + " 行已入库数量减少 " + doc.get("qty") + "，随后重算入库状态。");
            copy.put("redReverseImpact", "红冲将生成负数采购入库单，原单标记已红冲，并同样回退源采购订单第 "
                + doc.get("sourceLineNo") + " 行已入库数量。");
            return copy;
        }).toList();
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
                INSERT INTO purchase_order_line (order_id, line_no, product_id, warehouse_id, qty, unit_price, amount, line_remark)
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

    private String optionalText(String value) {
        return value == null || value.isBlank() ? null : value.trim();
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
        BigDecimal unitPrice,
        String lineRemark
    ) {
    }
}
