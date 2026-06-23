package com.jdy.erp.purchase.api;

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
@RequestMapping("/api/purchase-ins")
public class PurchaseInController {
    private final JdbcTemplate jdbcTemplate;
    private final InventoryPostingService postingService;

    public PurchaseInController(JdbcTemplate jdbcTemplate, InventoryPostingService postingService) {
        this.jdbcTemplate = jdbcTemplate;
        this.postingService = postingService;
    }

    @PostMapping("/draft")
    @ResponseStatus(HttpStatus.CREATED)
    @Transactional
    public Map<String, Object> saveDraft(@RequestBody PurchaseInDraftRequest request) {
        var supplierId = lookupId("md_supplier", request.supplierCode(), "供应商");
        var sourceOrderId = sourceOrderId(request.sourceOrderNo());
        var totalAmount = request.lines().stream()
            .map(line -> line.qty().multiply(line.unitPrice()))
            .reduce(BigDecimal.ZERO, BigDecimal::add);
        var bill = jdbcTemplate.queryForMap("""
            INSERT INTO purchase_in (bill_no, source_order_id, supplier_id, bill_date, department, status, total_amount, owner_name)
            VALUES (?, ?::uuid, ?::uuid, ?, ?, 'DRAFT', ?, ?)
            ON CONFLICT (bill_no) DO UPDATE
            SET source_order_id = EXCLUDED.source_order_id,
                supplier_id = EXCLUDED.supplier_id,
                bill_date = EXCLUDED.bill_date,
                department = EXCLUDED.department,
                status = 'DRAFT',
                total_amount = EXCLUDED.total_amount,
                owner_name = EXCLUDED.owner_name,
                updated_at = now(),
                version = purchase_in.version + 1
            RETURNING id::text AS id, bill_no AS "billNo", total_amount AS "totalAmount"
            """,
            required(request.billNo(), "单据编号"),
            sourceOrderId,
            supplierId,
            LocalDate.parse(required(request.billDate(), "业务日期")),
            request.department(),
            totalAmount,
            request.ownerName()
        );
        var billId = bill.get("id");
        jdbcTemplate.update("DELETE FROM purchase_in_line WHERE bill_id = ?::uuid", billId);
        insertLines("purchase_in_line", "bill_id", billId, request.lines());
        return bill;
    }

    @PostMapping("/{billNo}/audit")
    @Transactional
    public Map<String, Object> audit(@PathVariable String billNo) {
        var rows = jdbcTemplate.queryForList("""
            UPDATE purchase_in
            SET status = 'AUDITED', updated_at = now(), version = version + 1
            WHERE bill_no = ?
            RETURNING id::text AS id, bill_no AS "billNo", source_order_id::text AS "sourceOrderId"
            """, billNo);
        if (rows.isEmpty()) {
            throw new ResponseStatusException(HttpStatus.NOT_FOUND, "采购入库单不存在");
        }
        var lines = jdbcTemplate.queryForList("""
            SELECT p.code AS "productCode", w.code AS "warehouseCode", l.qty
            FROM purchase_in_line l
            JOIN md_product p ON p.id = l.product_id
            JOIN md_warehouse w ON w.id = l.warehouse_id
            JOIN purchase_in pi ON pi.id = l.bill_id
            WHERE pi.bill_no = ?
            ORDER BY l.line_no
            """, billNo);
        for (var line : lines) {
            postingService.post(
                String.valueOf(line.get("productCode")),
                String.valueOf(line.get("warehouseCode")),
                (BigDecimal) line.get("qty"),
                "PURCHASE_IN",
                "PURCHASE_IN:" + billNo
            );
        }
        var sourceOrderId = rows.get(0).get("sourceOrderId");
        if (sourceOrderId != null) {
            jdbcTemplate.update("UPDATE purchase_order SET in_status = 'ALL_IN', updated_at = now(), version = version + 1 WHERE id = ?::uuid", sourceOrderId);
        }
        return rows.get(0);
    }

    private void insertLines(String table, String billIdColumn, Object billId, List<PurchaseInLineRequest> lines) {
        var lineNo = 1;
        for (var line : lines) {
            var productId = lookupId("md_product", line.productCode(), "商品");
            var warehouseId = lookupId("md_warehouse", line.warehouseCode(), "仓库");
            var amount = line.qty().multiply(line.unitPrice());
            jdbcTemplate.update("INSERT INTO " + table + " (" + billIdColumn + ", line_no, product_id, warehouse_id, qty, unit_price, amount) VALUES (?::uuid, ?, ?::uuid, ?::uuid, ?, ?, ?)",
                billId, lineNo, productId, warehouseId, line.qty(), line.unitPrice(), amount);
            lineNo += 1;
        }
    }

    private String sourceOrderId(String sourceOrderNo) {
        if (sourceOrderNo == null || sourceOrderNo.isBlank()) {
            return null;
        }
        var rows = jdbcTemplate.queryForList("SELECT id::text AS id FROM purchase_order WHERE bill_no = ?", sourceOrderNo.trim());
        if (rows.isEmpty()) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "采购订单不存在");
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

    public record PurchaseInDraftRequest(String billNo, String sourceOrderNo, String supplierCode, String billDate, String department, String ownerName, List<PurchaseInLineRequest> lines) {
        public PurchaseInDraftRequest {
            if (lines == null || lines.isEmpty()) {
                throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "至少需要一条分录");
            }
        }
    }

    public record PurchaseInLineRequest(String productCode, String warehouseCode, BigDecimal qty, BigDecimal unitPrice) {
    }
}
