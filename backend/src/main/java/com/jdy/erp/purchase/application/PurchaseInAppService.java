package com.jdy.erp.purchase.application;

import java.math.BigDecimal;
import java.time.LocalDate;
import java.util.List;
import java.util.Map;

import com.jdy.erp.shared.application.BillLifecycleService;
import com.jdy.erp.shared.application.ConversionService;
import com.jdy.erp.shared.application.ConversionService.SourceExecutionSpec;
import com.jdy.erp.shared.application.FinancePosting;
import com.jdy.erp.shared.application.InventoryPostingHook;
import com.jdy.erp.shared.application.LookupService;
import com.jdy.erp.shared.application.NumberingService;
import com.jdy.erp.shared.application.OperationLogService;
import com.jdy.erp.shared.application.PostingContext;
import com.jdy.erp.shared.application.PostingPipeline;
import com.jdy.erp.shared.application.ValidationService;
import com.jdy.erp.shared.domain.BillStatus;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.server.ResponseStatusException;

@Service
public class PurchaseInAppService {
    private static final String BILL_TABLE = "purchase_in";
    private static final SourceExecutionSpec PURCHASE_ORDER_IN_SPEC = new SourceExecutionSpec(
        "purchase_order",
        "purchase_order_line",
        "order_id",
        "line_no",
        "received_qty",
        "qty",
        "in_status",
        "采购入库数量不能超过采购订单剩余可入数量",
        "NOT_IN",
        "PART_IN",
        "ALL_IN"
    );

    private final JdbcTemplate jdbcTemplate;
    private final LookupService lookupService;
    private final ValidationService validationService;
    private final BillLifecycleService lifecycleService;
    private final PostingPipeline postingPipeline;
    private final ConversionService conversionService;
    private final OperationLogService operationLogService;
    private final NumberingService numberingService;

    public PurchaseInAppService(
        JdbcTemplate jdbcTemplate,
        LookupService lookupService,
        ValidationService validationService,
        BillLifecycleService lifecycleService,
        PostingPipeline postingPipeline,
        ConversionService conversionService,
        OperationLogService operationLogService,
        NumberingService numberingService
    ) {
        this.jdbcTemplate = jdbcTemplate;
        this.lookupService = lookupService;
        this.validationService = validationService;
        this.lifecycleService = lifecycleService;
        this.postingPipeline = postingPipeline;
        this.conversionService = conversionService;
        this.operationLogService = operationLogService;
        this.numberingService = numberingService;
    }

    public Map<String, Object> detail(String billNo) {
        var billRows = jdbcTemplate.queryForList("""
            SELECT pi.id::text AS id,
                   pi.bill_no AS "billNo",
                   po.bill_no AS "sourceOrderNo",
                   s.code AS "supplierCode",
                   s.name AS supplier,
                   to_char(pi.bill_date, 'YYYY-MM-DD') AS "billDate",
                   pi.department,
                   pi.status,
                   pi.total_amount AS "totalAmount",
                   pi.owner_name AS "ownerName",
                   (
                       SELECT red.bill_no
                       FROM purchase_in red
                       WHERE red.red_source_bill_id = pi.id
                         AND red.status = ?
                       LIMIT 1
                   ) AS "redReverseBillNo",
                   (
                       SELECT original.bill_no
                       FROM purchase_in original
                       WHERE original.id = pi.red_source_bill_id
                         AND pi.status = ?
                       LIMIT 1
                   ) AS "redSourceBillNo"
            FROM purchase_in pi
            JOIN md_supplier s ON s.id = pi.supplier_id
            LEFT JOIN purchase_order po ON po.id = pi.source_order_id
            WHERE pi.bill_no = ?
            """, BillStatus.RED_REVERSED.name(), BillStatus.RED_REVERSED.name(), billNo);
        if (billRows.isEmpty()) {
            throw new ResponseStatusException(HttpStatus.NOT_FOUND, "采购入库单不存在");
        }
        var lines = jdbcTemplate.queryForList("""
            SELECT l.line_no AS "lineNo",
                   COALESCE(l.source_line_no, l.line_no) AS "sourceLineNo",
                   p.code AS "productCode",
                   p.name AS "productName",
                   COALESCE(p.spec, '') AS spec,
                   w.code AS "warehouseCode",
                   l.qty,
                   l.unit_price AS "unitPrice",
                   l.amount,
                   COALESCE(l.line_remark, '') AS "lineRemark"
            FROM purchase_in_line l
            JOIN md_product p ON p.id = l.product_id
            LEFT JOIN md_warehouse w ON w.id = l.warehouse_id
            JOIN purchase_in pi ON pi.id = l.bill_id
            WHERE pi.bill_no = ?
            ORDER BY l.line_no
            """, billNo);
        return Map.of("action", "DETAIL", "document", billRows.get(0), "lines", lines);
    }

    @Transactional
    public Map<String, Object> saveDraft(PurchaseInDraftRequest request) {
        var billNo = numberingService.assignBillNo("purchaseIn", request.billNo());
        var supplierId = lookupService.lookupEnabledId("md_supplier", request.supplierCode(), "供应商");
        var sourceOrderId = sourceOrderId(request.sourceOrderNo());
        var totalAmount = request.lines().stream()
            .map(line -> line.qty().multiply(line.unitPrice()))
            .reduce(BigDecimal.ZERO, BigDecimal::add);
        var bill = jdbcTemplate.queryForMap("""
            INSERT INTO purchase_in (bill_no, source_order_id, supplier_id, bill_date, department, status, total_amount, owner_name)
            VALUES (?, ?::uuid, ?::uuid, ?, ?, ?, ?, ?)
            ON CONFLICT (bill_no) DO UPDATE
            SET source_order_id = EXCLUDED.source_order_id,
                supplier_id = EXCLUDED.supplier_id,
                bill_date = EXCLUDED.bill_date,
                department = EXCLUDED.department,
                status = EXCLUDED.status,
                total_amount = EXCLUDED.total_amount,
                owner_name = EXCLUDED.owner_name,
                updated_at = now(),
                version = purchase_in.version + 1
            RETURNING id::text AS id, bill_no AS "billNo", total_amount AS "totalAmount"
            """,
            billNo,
            sourceOrderId,
            supplierId,
            LocalDate.parse(validationService.required(request.billDate(), "业务日期")),
            request.department(),
            BillStatus.DRAFT.name(),
            totalAmount,
            request.ownerName()
        );
        var billId = bill.get("id");
        jdbcTemplate.update("DELETE FROM purchase_in_line WHERE bill_id = ?::uuid", billId);
        insertLines("purchase_in_line", "bill_id", billId, request.lines());
        return bill;
    }

    @Transactional
    public Map<String, Object> audit(String billNo) {
        var row = lifecycleService.transition(
            BILL_TABLE,
            billNo,
            BillStatus.DRAFT,
            BillStatus.AUDITED,
            "id::text AS id, bill_no AS \"billNo\", source_order_id::text AS \"sourceOrderId\", supplier_id::text AS \"supplierId\", bill_date AS \"billDate\", total_amount AS \"totalAmount\"",
            "PURCHASE",
            "AUDIT",
            "purchase_in",
            "采购入库单不存在或已审核"
        );
        var sourceOrderId = row.get("sourceOrderId");
        var lines = postingLines(billNo);
        if (sourceOrderId != null) {
            for (var line : lines) {
                conversionService.increaseExecutedQuantity(
                    PURCHASE_ORDER_IN_SPEC,
                    String.valueOf(sourceOrderId),
                    line.get("sourceLineNo"),
                    (BigDecimal) line.get("qty")
                );
            }
            conversionService.refreshSourceStatus(PURCHASE_ORDER_IN_SPEC, String.valueOf(sourceOrderId));
        }
        for (var line : lines) {
            postingPipeline.post(new PostingContext(
                InventoryPostingHook.CHANNEL,
                String.valueOf(line.get("productCode")),
                String.valueOf(line.get("warehouseCode")),
                (BigDecimal) line.get("qty"),
                "PURCHASE_IN",
                "PURCHASE_IN:" + billNo
            ));
        }
        postingPipeline.post(financeContext(row, "PURCHASE_IN"));
        return row;
    }

    @Transactional
    public Map<String, Object> reverse(String billNo) {
        var row = lifecycleService.transition(
            BILL_TABLE,
            billNo,
            BillStatus.AUDITED,
            BillStatus.REVERSED,
            "id::text AS id, bill_no AS \"billNo\", source_order_id::text AS \"sourceOrderId\", supplier_id::text AS \"supplierId\", bill_date AS \"billDate\", total_amount AS \"totalAmount\"",
            "PURCHASE",
            "REVERSE",
            "purchase_in",
            "采购入库单不存在或不能反审核"
        );
        var sourceOrderId = row.get("sourceOrderId");
        var lines = postingLines(billNo);
        for (var line : lines) {
            postingPipeline.post(new PostingContext(
                InventoryPostingHook.CHANNEL,
                String.valueOf(line.get("productCode")),
                String.valueOf(line.get("warehouseCode")),
                ((BigDecimal) line.get("qty")).negate(),
                "PURCHASE_IN_REVERSE",
                "PURCHASE_IN_REVERSE:" + billNo
            ));
        }
        if (sourceOrderId != null) {
            for (var line : lines) {
                conversionService.decreaseExecutedQuantity(
                    PURCHASE_ORDER_IN_SPEC,
                    String.valueOf(sourceOrderId),
                    line.get("sourceLineNo"),
                    (BigDecimal) line.get("qty")
                );
            }
            conversionService.refreshSourceStatus(PURCHASE_ORDER_IN_SPEC, String.valueOf(sourceOrderId));
        }
        postingPipeline.post(financeContext(row, "PURCHASE_IN_REVERSE"));
        return row;
    }

    @Transactional
    public Map<String, Object> voidBill(String billNo) {
        return lifecycleService.transition(
            BILL_TABLE,
            billNo,
            BillStatus.DRAFT,
            BillStatus.VOID,
            "id::text AS id, bill_no AS \"billNo\", status",
            "PURCHASE",
            "VOID",
            "purchase_in",
            "只有草稿采购入库单可以作废"
        );
    }

    @Transactional
    public Map<String, Object> redReverse(String billNo, RedReverseRequest request) {
        var sourceRows = jdbcTemplate.queryForList("""
            SELECT id::text AS id,
                   source_order_id::text AS "sourceOrderId",
                   supplier_id::text AS "supplierId",
                   department,
                   total_amount,
                   owner_name AS "ownerName"
            FROM purchase_in
            WHERE bill_no = ? AND status = ?
            """, billNo, BillStatus.AUDITED.name());
        if (sourceRows.isEmpty()) {
            throw new ResponseStatusException(HttpStatus.CONFLICT, "只有已审核采购入库单可以红冲");
        }
        var redBillNo = validationService.required(request.redBillNo(), "红冲单号");
        if (!jdbcTemplate.queryForList("SELECT 1 FROM purchase_in WHERE bill_no = ?", redBillNo).isEmpty()) {
            throw new ResponseStatusException(HttpStatus.CONFLICT, "红冲单号已存在");
        }
        var source = sourceRows.get(0);
        var redBill = jdbcTemplate.queryForMap("""
            INSERT INTO purchase_in (bill_no, source_order_id, red_source_bill_id, supplier_id, bill_date, department, status, total_amount, owner_name)
            VALUES (?, ?::uuid, ?::uuid, ?::uuid, ?, ?, ?, ?, ?)
            RETURNING id::text AS id, bill_no AS "billNo", status, total_amount AS "totalAmount"
            """,
            redBillNo,
            source.get("sourceOrderId"),
            source.get("id"),
            source.get("supplierId"),
            LocalDate.parse(validationService.required(request.billDate(), "红冲日期")),
            source.get("department"),
            BillStatus.RED_REVERSED.name(),
            ((BigDecimal) source.get("total_amount")).negate(),
            request.ownerName() == null || request.ownerName().isBlank() ? source.get("ownerName") : request.ownerName().trim()
        );
        var lines = jdbcTemplate.queryForList("""
            SELECT l.line_no AS "lineNo",
                   COALESCE(l.source_line_no, l.line_no) AS "sourceLineNo",
                   p.code AS "productCode",
                   w.code AS "warehouseCode",
                   l.product_id::text AS "productId",
                   l.warehouse_id::text AS "warehouseId",
                   l.qty,
                   l.unit_price AS "unitPrice",
                   l.amount,
                   COALESCE(l.line_remark, '') AS "lineRemark"
            FROM purchase_in_line l
            JOIN md_product p ON p.id = l.product_id
            JOIN md_warehouse w ON w.id = l.warehouse_id
            JOIN purchase_in pi ON pi.id = l.bill_id
            WHERE pi.bill_no = ?
            ORDER BY l.line_no
            """, billNo);
        for (var line : lines) {
            var qty = (BigDecimal) line.get("qty");
            jdbcTemplate.update("""
                INSERT INTO purchase_in_line (bill_id, line_no, source_line_no, product_id, warehouse_id, qty, unit_price, amount, line_remark)
                VALUES (?::uuid, ?, ?, ?::uuid, ?::uuid, ?, ?, ?, ?)
                """,
                redBill.get("id"),
                line.get("lineNo"),
                line.get("sourceLineNo"),
                line.get("productId"),
                line.get("warehouseId"),
                qty.negate(),
                line.get("unitPrice"),
                ((BigDecimal) line.get("amount")).negate(),
                line.get("lineRemark")
            );
            postingPipeline.post(new PostingContext(
                InventoryPostingHook.CHANNEL,
                String.valueOf(line.get("productCode")),
                String.valueOf(line.get("warehouseCode")),
                qty.negate(),
                "PURCHASE_IN_RED",
                "PURCHASE_IN_RED:" + redBillNo
            ));
            if (source.get("sourceOrderId") != null) {
                conversionService.decreaseExecutedQuantity(
                    PURCHASE_ORDER_IN_SPEC,
                    String.valueOf(source.get("sourceOrderId")),
                    line.get("sourceLineNo"),
                    qty
                );
            }
        }
        if (source.get("sourceOrderId") != null) {
            conversionService.refreshSourceStatus(PURCHASE_ORDER_IN_SPEC, String.valueOf(source.get("sourceOrderId")));
        }
        postingPipeline.post(new PostingContext(
            FinancePosting.CHANNEL,
            null,
            null,
            null,
            "PURCHASE_IN_RED",
            "PURCHASE_IN_RED:" + redBillNo,
            redBillNo,
            String.valueOf(source.get("supplierId")),
            LocalDate.parse(validationService.required(request.billDate(), "红冲日期")),
            (BigDecimal) redBill.get("totalAmount")
        ));
        operationLogService.log("PURCHASE", "RED_REVERSE", "purchase_in", String.valueOf(redBill.get("id")), true, null);
        return redBill;
    }

    private void insertLines(String table, String billIdColumn, Object billId, List<PurchaseInLineRequest> lines) {
        var lineNo = 1;
        for (var line : lines) {
            var productId = lookupService.lookupEnabledId("md_product", line.productCode(), "商品");
            var warehouseId = lookupService.lookupEnabledId("md_warehouse", line.warehouseCode(), "仓库");
            var amount = line.qty().multiply(line.unitPrice());
            jdbcTemplate.update("INSERT INTO " + table + " (" + billIdColumn + ", line_no, source_line_no, product_id, warehouse_id, qty, unit_price, amount, line_remark) VALUES (?::uuid, ?, ?, ?::uuid, ?::uuid, ?, ?, ?, ?)",
                billId, lineNo, line.sourceLineNo() == null ? lineNo : line.sourceLineNo(), productId, warehouseId, line.qty(), line.unitPrice(), amount, validationService.optionalText(line.lineRemark()));
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

    private List<Map<String, Object>> postingLines(String billNo) {
        return jdbcTemplate.queryForList("""
            SELECT l.line_no AS "lineNo", COALESCE(l.source_line_no, l.line_no) AS "sourceLineNo", p.code AS "productCode", w.code AS "warehouseCode", l.qty
            FROM purchase_in_line l
            JOIN md_product p ON p.id = l.product_id
            JOIN md_warehouse w ON w.id = l.warehouse_id
            JOIN purchase_in pi ON pi.id = l.bill_id
            WHERE pi.bill_no = ?
            ORDER BY l.line_no
            """, billNo);
    }

    private PostingContext financeContext(Map<String, Object> row, String txnType) {
        return new PostingContext(
            FinancePosting.CHANNEL,
            null,
            null,
            null,
            txnType,
            txnType + ":" + row.get("billNo"),
            String.valueOf(row.get("billNo")),
            String.valueOf(row.get("supplierId")),
            toLocalDate(row.get("billDate")),
            (BigDecimal) row.get("totalAmount")
        );
    }

    private LocalDate toLocalDate(Object value) {
        if (value instanceof LocalDate localDate) {
            return localDate;
        }
        if (value instanceof java.sql.Date sqlDate) {
            return sqlDate.toLocalDate();
        }
        return LocalDate.parse(String.valueOf(value));
    }

    public record PurchaseInDraftRequest(String billNo, String sourceOrderNo, String supplierCode, String billDate, String department, String ownerName, List<PurchaseInLineRequest> lines) {
        public PurchaseInDraftRequest {
            if (lines == null || lines.isEmpty()) {
                throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "至少需要一条分录");
            }
        }
    }

    public record PurchaseInLineRequest(String productCode, String warehouseCode, Integer sourceLineNo, BigDecimal qty, BigDecimal unitPrice, String lineRemark) {
    }

    public record RedReverseRequest(String redBillNo, String billDate, String ownerName) {
    }
}
