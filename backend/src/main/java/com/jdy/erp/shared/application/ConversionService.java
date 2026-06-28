package com.jdy.erp.shared.application;

import java.math.BigDecimal;
import java.util.Set;

import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;
import org.springframework.web.server.ResponseStatusException;

@Service
public class ConversionService {
    private static final Set<String> TABLES = Set.of("sales_order", "sales_order_line", "purchase_order", "purchase_order_line");
    private static final Set<String> QUANTITY_COLUMNS = Set.of("shipped_qty", "received_qty", "qty");
    private static final Set<String> STATUS_COLUMNS = Set.of("out_status", "in_status");

    private final JdbcTemplate jdbcTemplate;
    private final BillLifecycleService lifecycleService;

    public ConversionService(JdbcTemplate jdbcTemplate, BillLifecycleService lifecycleService) {
        this.jdbcTemplate = jdbcTemplate;
        this.lifecycleService = lifecycleService;
    }

    public void increaseExecutedQuantity(SourceExecutionSpec spec, String sourceId, Object sourceLineNo, BigDecimal qty) {
        guard(spec);
        lifecycleService.guardExecutableSourceLine(spec, sourceId, sourceLineNo);
        var updated = jdbcTemplate.update("""
            UPDATE %s
            SET %s = %s + ?
            WHERE %s = ?::uuid
              AND %s = ?
              AND %s + ? <= %s
              AND line_close_status = 'OPEN'
              AND line_frozen_status = 'NORMAL'
            """.formatted(
                spec.lineTable(),
                spec.executedQtyColumn(),
                spec.executedQtyColumn(),
                spec.lineOwnerColumn(),
                spec.lineNoColumn(),
                spec.executedQtyColumn(),
                spec.totalQtyColumn()
            ), qty, sourceId, sourceLineNo, qty);
        if (updated == 0) {
            throw new ResponseStatusException(HttpStatus.CONFLICT, spec.overQuantityMessage());
        }
    }

    public void decreaseExecutedQuantity(SourceExecutionSpec spec, String sourceId, Object sourceLineNo, BigDecimal qty) {
        guard(spec);
        jdbcTemplate.update("""
            UPDATE %s
            SET %s = GREATEST(0, %s - ?)
            WHERE %s = ?::uuid AND %s = ?
            """.formatted(
                spec.lineTable(),
                spec.executedQtyColumn(),
                spec.executedQtyColumn(),
                spec.lineOwnerColumn(),
                spec.lineNoColumn()
            ), qty, sourceId, sourceLineNo);
    }

    public void refreshSourceStatus(SourceExecutionSpec spec, String sourceId) {
        guard(spec);
        jdbcTemplate.update("""
            UPDATE %s
            SET %s = CASE
                    WHEN NOT EXISTS (SELECT 1 FROM %s WHERE %s = ?::uuid AND %s > 0) THEN ?
                    WHEN NOT EXISTS (SELECT 1 FROM %s WHERE %s = ?::uuid AND %s < %s) THEN ?
                    ELSE ?
                END,
                updated_at = now(),
                version = version + 1
            WHERE id = ?::uuid
            """.formatted(
                spec.headerTable(),
                spec.statusColumn(),
                spec.lineTable(),
                spec.lineOwnerColumn(),
                spec.executedQtyColumn(),
                spec.lineTable(),
                spec.lineOwnerColumn(),
                spec.executedQtyColumn(),
                spec.totalQtyColumn()
            ), sourceId, spec.notStartedStatus(), sourceId, spec.allExecutedStatus(), spec.partExecutedStatus(), sourceId);
    }

    public ConversionResult createStockCountAdjustments(String stockCountBillNo) {
        var billRows = jdbcTemplate.queryForList("""
            SELECT id::text AS id,
                   bill_no,
                   bill_date,
                   department,
                   owner_name
            FROM stock_count
            WHERE bill_no = ?
            """, stockCountBillNo);
        if (billRows.isEmpty()) {
            throw new ResponseStatusException(HttpStatus.NOT_FOUND, "盘点单不存在");
        }
        var bill = billRows.get(0);
        var sourceId = String.valueOf(bill.get("id"));
        var gainNo = "PY-" + stockCountBillNo;
        var lossNo = "PK-" + stockCountBillNo;
        var gainCount = createStockCountAdjustment(
            "stock_count_gain",
            "stock_count_gain_line",
            gainNo,
            "STK_StockCountGain",
            "盘盈单",
            sourceId,
            bill,
            true
        );
        var lossCount = createStockCountAdjustment(
            "stock_count_loss",
            "stock_count_loss_line",
            lossNo,
            "STK_StockCountLoss",
            "盘亏单",
            sourceId,
            bill,
            false
        );
        return new ConversionResult(gainNo, lossNo, gainCount, lossCount);
    }

    private int createStockCountAdjustment(
        String headerTable,
        String lineTable,
        String billNo,
        String documentType,
        String businessType,
        String sourceId,
        java.util.Map<String, Object> sourceBill,
        boolean gain
    ) {
        var lines = jdbcTemplate.queryForList("""
            SELECT l.line_no,
                   l.product_id::text AS product_id,
                   l.product_code_snapshot,
                   l.product_name_snapshot,
                   l.product_spec_snapshot,
                   l.warehouse_id::text AS warehouse_id,
                   l.diff_qty,
                   l.unit_price,
                   l.line_remark
            FROM stock_count_line l
            WHERE l.bill_id = ?::uuid
              AND %s
            ORDER BY l.line_no
            """.formatted(gain ? "l.diff_qty > 0" : "l.diff_qty < 0"), sourceId);
        if (lines.isEmpty()) {
            return 0;
        }
        var header = jdbcTemplate.queryForMap("""
            INSERT INTO %s (bill_no, bill_date, department, document_type, business_type, status, total_amount, owner_name, source_bill_id)
            VALUES (?, ?, ?, ?, ?, 'DRAFT', 0, ?, ?::uuid)
            ON CONFLICT (bill_no) DO UPDATE
            SET bill_date = EXCLUDED.bill_date,
                department = EXCLUDED.department,
                owner_name = EXCLUDED.owner_name,
                source_bill_id = EXCLUDED.source_bill_id,
                updated_at = now(),
                version = %s.version + 1
            WHERE %s.status = 'DRAFT'
            RETURNING id::text AS id
            """.formatted(headerTable, headerTable, headerTable),
            billNo,
            sourceBill.get("bill_date"),
            sourceBill.get("department"),
            documentType,
            businessType,
            sourceBill.get("owner_name"),
            sourceId
        );
        var headerId = String.valueOf(header.get("id"));
        jdbcTemplate.update("DELETE FROM %s WHERE bill_id = ?::uuid".formatted(lineTable), headerId);
        var count = 0;
        for (var line : lines) {
            var qty = ((BigDecimal) line.get("diff_qty")).abs();
            var unitPrice = (BigDecimal) line.get("unit_price");
            jdbcTemplate.update("""
                INSERT INTO %s (bill_id, line_no, product_id, product_code_snapshot, product_name_snapshot, product_spec_snapshot, warehouse_id, source_bill_id, source_line_no, qty, unit_price, amount, line_remark)
                VALUES (?::uuid, ?, ?::uuid, ?, ?, ?, ?::uuid, ?::uuid, ?, ?, ?, ?, ?)
                """.formatted(lineTable),
                headerId,
                line.get("line_no"),
                line.get("product_id"),
                line.get("product_code_snapshot"),
                line.get("product_name_snapshot"),
                line.get("product_spec_snapshot"),
                line.get("warehouse_id"),
                sourceId,
                line.get("line_no"),
                qty,
                unitPrice,
                qty.multiply(unitPrice),
                line.get("line_remark")
            );
            count += 1;
        }
        jdbcTemplate.update("""
            UPDATE %s
            SET total_amount = (SELECT COALESCE(sum(amount), 0) FROM %s WHERE bill_id = ?::uuid),
                updated_at = now()
            WHERE id = ?::uuid
            """.formatted(headerTable, lineTable), headerId, headerId);
        return count;
    }

    private void guard(SourceExecutionSpec spec) {
        if (!TABLES.contains(spec.headerTable()) || !TABLES.contains(spec.lineTable())) {
            throw new IllegalArgumentException("Unsupported conversion table");
        }
        if (!QUANTITY_COLUMNS.contains(spec.executedQtyColumn()) || !QUANTITY_COLUMNS.contains(spec.totalQtyColumn())) {
            throw new IllegalArgumentException("Unsupported quantity column");
        }
        if (!STATUS_COLUMNS.contains(spec.statusColumn())) {
            throw new IllegalArgumentException("Unsupported status column");
        }
        if (!"order_id".equals(spec.lineOwnerColumn()) || !"line_no".equals(spec.lineNoColumn())) {
            throw new IllegalArgumentException("Unsupported source line key");
        }
    }

    public record SourceExecutionSpec(
        String headerTable,
        String lineTable,
        String lineOwnerColumn,
        String lineNoColumn,
        String executedQtyColumn,
        String totalQtyColumn,
        String statusColumn,
        String overQuantityMessage,
        String notStartedStatus,
        String partExecutedStatus,
        String allExecutedStatus
    ) {
        public SourceExecutionSpec(
            String headerTable,
            String lineTable,
            String lineOwnerColumn,
            String lineNoColumn,
            String executedQtyColumn,
            String totalQtyColumn,
            String statusColumn,
            String overQuantityMessage
        ) {
            this(headerTable, lineTable, lineOwnerColumn, lineNoColumn, executedQtyColumn, totalQtyColumn, statusColumn, overQuantityMessage, "NOT_OUT", "PART_OUT", "ALL_OUT");
        }
    }

    public record ConversionResult(String gainBillNo, String lossBillNo, int gainCount, int lossCount) {
    }
}
