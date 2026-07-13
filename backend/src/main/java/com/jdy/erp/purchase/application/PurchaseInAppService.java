package com.jdy.erp.purchase.application;

import java.math.BigDecimal;
import java.time.LocalDate;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.UUID;

import com.jdy.erp.shared.application.BillLifecycleService;
import com.jdy.erp.shared.application.BillLifecycleService.BillLifecycleTarget;
import com.jdy.erp.shared.application.BillLifecycleService.SourceLineQuantityDemand;
import com.jdy.erp.shared.application.BillLifecycleService.SourceLineQuantityGuard;
import com.jdy.erp.shared.application.BillLifecycleService.VoidRequest;
import com.jdy.erp.shared.application.ConversionService;
import com.jdy.erp.shared.application.ConversionService.SourceExecutionSpec;
import com.jdy.erp.shared.application.FinancePosting;
import com.jdy.erp.shared.application.InventoryPostingHook;
import com.jdy.erp.shared.application.LookupService;
import com.jdy.erp.shared.application.NumberingService;
import com.jdy.erp.shared.application.OperationLogCommand;
import com.jdy.erp.shared.application.OperationLogService;
import com.jdy.erp.shared.application.PostingContext;
import com.jdy.erp.shared.application.PostingPipeline;
import com.jdy.erp.shared.application.ProductSnapshotService;
import com.jdy.erp.shared.application.RedReverseGuardService;
import com.jdy.erp.shared.application.TaxAmountCalculator;
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
    private static final BillLifecycleTarget LIFECYCLE_TARGET = new BillLifecycleTarget(BILL_TABLE, "purchase_in_line", "bill_id", "PURCHASE", "purchase_in");
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
    private static final SourceLineQuantityGuard PURCHASE_ORDER_IN_QUANTITY_GUARD = new SourceLineQuantityGuard(
        PURCHASE_ORDER_IN_SPEC,
        "purchase_in",
        "purchase_in_line",
        "bill_id",
        "source_order_no",
        "source_line_no",
        "qty"
    );

    private final JdbcTemplate jdbcTemplate;
    private final LookupService lookupService;
    private final ValidationService validationService;
    private final BillLifecycleService lifecycleService;
    private final PostingPipeline postingPipeline;
    private final ConversionService conversionService;
    private final OperationLogService operationLogService;
    private final NumberingService numberingService;
    private final TaxAmountCalculator taxAmountCalculator;
    private final ProductSnapshotService productSnapshotService;
    private final RedReverseGuardService redReverseGuardService;

    public PurchaseInAppService(
        JdbcTemplate jdbcTemplate,
        LookupService lookupService,
        ValidationService validationService,
        BillLifecycleService lifecycleService,
        PostingPipeline postingPipeline,
        ConversionService conversionService,
        OperationLogService operationLogService,
        NumberingService numberingService,
        TaxAmountCalculator taxAmountCalculator,
        ProductSnapshotService productSnapshotService,
        RedReverseGuardService redReverseGuardService
    ) {
        this.jdbcTemplate = jdbcTemplate;
        this.lookupService = lookupService;
        this.validationService = validationService;
        this.lifecycleService = lifecycleService;
        this.postingPipeline = postingPipeline;
        this.conversionService = conversionService;
        this.operationLogService = operationLogService;
        this.numberingService = numberingService;
        this.taxAmountCalculator = taxAmountCalculator;
        this.productSnapshotService = productSnapshotService;
        this.redReverseGuardService = redReverseGuardService;
    }

    public Map<String, Object> detail(String billNo) {
        var billRows = jdbcTemplate.queryForList("""
            SELECT pi.id::text AS id,
                   pi.bill_no AS "billNo",
                   NULL AS "sourceOrderNo",
                   s.code AS "supplierCode",
                   s.name AS supplier,
                   to_char(pi.bill_date, 'YYYY-MM-DD') AS "billDate",
                   pi.department,
                   pi.status,
                   pi.total_amount AS "totalAmount",
                   pi.currency,
                   pi.owner_name AS "ownerName",
	                   (
	                       SELECT red.bill_no
	                       FROM purchase_in red
	                       WHERE red.red_source_bill_id = pi.id
	                         AND red.status <> 'VOID'
	                       LIMIT 1
	                   ) AS "redReverseBillNo",
	                   (
	                       SELECT original.bill_no
	                       FROM purchase_in original
	                       WHERE original.id = pi.red_source_bill_id
	                       LIMIT 1
	                   ) AS "redSourceBillNo"
            FROM purchase_in pi
            JOIN md_supplier s ON s.id = pi.supplier_id
            WHERE pi.bill_no = ?
	            """, billNo);
        if (billRows.isEmpty()) {
            throw new ResponseStatusException(HttpStatus.NOT_FOUND, "采购入库单不存在");
        }
        var lines = jdbcTemplate.queryForList("""
            SELECT l.line_no AS "lineNo",
                   l.source_order_no AS "sourceOrderNo",
                   l.source_line_no AS "sourceLineNo",
                   l.product_id::text AS "productId",
                   COALESCE(l.product_code_snapshot, p.code) AS "productCode",
                   COALESCE(l.product_name_snapshot, p.name) AS "productName",
                   COALESCE(l.product_spec_snapshot, p.spec, '') AS spec,
                   COALESCE(l.product_unit_snapshot, p.unit, '') AS unit,
                   trim(to_char(COALESCE(l.net_weight_snapshot, p.net_weight), 'FM9999999990.00')) AS "netWeight",
                   trim(to_char(COALESCE(l.gross_weight_snapshot, p.gross_weight), 'FM9999999990.00')) AS "grossWeight",
                   w.code AS "warehouseCode",
                   l.qty,
                   l.unit_price AS "unitPrice",
                   round(l.unit_price * (1 + COALESCE(l.tax_rate, 0) / 100), 2) AS "taxInclusiveUnitPrice",
                   l.amount,
                   l.tax_rate AS "taxRate",
                   l.tax_amount AS "taxAmount",
                   l.price_tax_total AS "priceTaxTotal",
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
        request.lines().forEach(line -> requirePositiveQty(line.qty(), "采购入库数量必须大于 0"));
        var billNo = numberingService.assignBillNo("purchaseIn", request.billNo());
        redReverseGuardService.assertNotRedDraftForBillNo(BILL_TABLE, billNo, "采购入库单");
        var supplierId = lookupService.lookupEnabledId("md_supplier", request.supplierCode(), "供应商");
        var totalAmount = request.lines().stream()
            .map(line -> taxAmountCalculator.calculate(line.qty(), line.unitPrice(), line.taxRate()).priceTaxTotal())
            .reduce(BigDecimal.ZERO, BigDecimal::add);
        var currency = settlementCurrency(request);
        var bill = jdbcTemplate.queryForMap("""
            INSERT INTO purchase_in (bill_no, source_order_id, supplier_id, bill_date, department, status, total_amount, currency, owner_name)
            VALUES (?, ?::uuid, ?::uuid, ?, ?, ?, ?, ?, ?)
            ON CONFLICT (bill_no) DO UPDATE
            SET source_order_id = EXCLUDED.source_order_id,
                supplier_id = EXCLUDED.supplier_id,
                bill_date = EXCLUDED.bill_date,
                department = EXCLUDED.department,
                status = EXCLUDED.status,
                total_amount = EXCLUDED.total_amount,
                currency = EXCLUDED.currency,
                owner_name = EXCLUDED.owner_name,
                updated_at = now(),
                version = purchase_in.version + 1
            RETURNING id::text AS id, bill_no AS "billNo", total_amount AS "totalAmount", currency
            """,
            billNo,
            null,
            supplierId,
            LocalDate.parse(validationService.required(request.billDate(), "业务日期")),
            request.department(),
            BillStatus.DRAFT.name(),
            totalAmount,
            currency,
            request.ownerName()
        );
        var billId = bill.get("id");
        jdbcTemplate.update("DELETE FROM purchase_in_line WHERE bill_id = ?::uuid", billId);
        insertLines("purchase_in_line", "bill_id", billId, request.sourceOrderNo(), request.lines());
        return bill;
    }

    @Transactional
    public Map<String, Object> audit(String billNo) {
        var row = lifecycleService.transition(
            BILL_TABLE,
            billNo,
            BillStatus.DRAFT,
            BillStatus.AUDITED,
	            "id::text AS id, bill_no AS \"billNo\", source_order_id::text AS \"sourceOrderId\", red_source_bill_id::text AS \"redSourceBillId\", supplier_id::text AS \"supplierId\", bill_date AS \"billDate\", total_amount AS \"totalAmount\", currency, status",
            "PURCHASE",
            "AUDIT",
            "purchase_in",
            "采购入库单不存在或已审核"
	        );
	        if (isRedBill(row)) {
	            return auditRedBill(row, billNo);
	        }
	        var lines = postingLines(billNo);
        lifecycleService.guardSourceLineQuantities(PURCHASE_ORDER_IN_QUANTITY_GUARD, sourceLineDemands(lines), billNo);
        for (var line : lines) {
            var sourceOrderId = sourceOrderIdFromLine(line);
            if (sourceOrderId != null) {
                conversionService.increaseExecutedQuantity(
                    PURCHASE_ORDER_IN_SPEC,
                    sourceOrderId,
                    line.get("sourceLineNo"),
                    (BigDecimal) line.get("qty")
                );
            }
        }
        refreshPurchaseSourceStatuses(lines);
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
        lockPurchaseInHeader(billNo);
        redReverseGuardService.assertNoNonVoidRedBillForBillNo(BILL_TABLE, billNo, "采购入库单", "反审核");
        assertNoPurchaseReturns(billNo);
        var row = lifecycleService.transition(
            BILL_TABLE,
            billNo,
            BillStatus.AUDITED,
            BillStatus.DRAFT,
	            "id::text AS id, bill_no AS \"billNo\", source_order_id::text AS \"sourceOrderId\", red_source_bill_id::text AS \"redSourceBillId\", supplier_id::text AS \"supplierId\", bill_date AS \"billDate\", total_amount AS \"totalAmount\", currency, status",
            "PURCHASE",
            "REVERSE",
            "purchase_in",
            "采购入库单不存在或不能反审核"
	        );
	        if (isRedBill(row)) {
	            return reverseRedBill(row, billNo);
	        }
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
        for (var line : lines) {
            var sourceOrderId = sourceOrderIdFromLine(line);
            if (sourceOrderId != null) {
                conversionService.decreaseExecutedQuantity(
                    PURCHASE_ORDER_IN_SPEC,
                    sourceOrderId,
                    line.get("sourceLineNo"),
                    (BigDecimal) line.get("qty")
                );
            }
        }
        refreshPurchaseSourceStatuses(lines);
        postingPipeline.post(financeContext(row, "PURCHASE_IN_REVERSE"));
        return row;
    }

    @Transactional
    public Map<String, Object> voidBill(String billNo, VoidRequest request) {
        return lifecycleService.voidBill(LIFECYCLE_TARGET, billNo, request);
    }

    public Map<String, Object> delete(String billNo) {
        return lifecycleService.deleteDraft(LIFECYCLE_TARGET, billNo, "只有草稿采购入库单可以删除");
    }

    @Transactional
    public Map<String, Object> redReverse(String billNo, RedReverseRequest request) {
        var sourceRows = jdbcTemplate.queryForList("""
            SELECT id::text AS id,
                   source_order_id::text AS "sourceOrderId",
                   supplier_id::text AS "supplierId",
                   department,
                   total_amount,
                   currency,
                   owner_name AS "ownerName"
            FROM purchase_in
            WHERE bill_no = ? AND status = ?
            """, billNo, BillStatus.AUDITED.name());
        if (sourceRows.isEmpty()) {
            throw new ResponseStatusException(HttpStatus.CONFLICT, "只有已审核采购入库单可以红冲");
        }
        redReverseGuardService.assertNoNonVoidRedBill(BILL_TABLE, sourceRows.get(0).get("id"), "采购入库单");
        var redBillNo = numberingService.nextBillNo("purchaseIn");
        var source = sourceRows.get(0);
        var redBill = jdbcTemplate.queryForMap("""
            INSERT INTO purchase_in (bill_no, source_order_id, red_source_bill_id, supplier_id, bill_date, department, status, total_amount, currency, owner_name)
            VALUES (?, ?::uuid, ?::uuid, ?::uuid, ?, ?, ?, ?, ?, ?)
            RETURNING id::text AS id, bill_no AS "billNo", status, total_amount AS "totalAmount", currency
            """,
            redBillNo,
            source.get("sourceOrderId"),
            source.get("id"),
            source.get("supplierId"),
            LocalDate.parse(validationService.required(request.billDate(), "红冲日期")),
            source.get("department"),
	            BillStatus.DRAFT.name(),
	            ((BigDecimal) source.get("total_amount")).negate(),
	            source.get("currency"),
	            request.ownerName() == null || request.ownerName().isBlank() ? source.get("ownerName") : request.ownerName().trim()
	        );
        var lines = jdbcTemplate.queryForList("""
            SELECT l.line_no AS "lineNo",
                   l.source_order_no AS "sourceOrderNo",
                   l.source_line_no AS "sourceLineNo",
                   COALESCE(l.product_code_snapshot, p.code) AS "productCode",
                   COALESCE(l.product_name_snapshot, p.name) AS "productName",
                   COALESCE(l.product_spec_snapshot, p.spec, '') AS spec,
                   COALESCE(l.product_unit_snapshot, p.unit, '') AS unit,
                   trim(to_char(COALESCE(l.net_weight_snapshot, p.net_weight), 'FM9999999990.00')) AS "netWeight",
                   trim(to_char(COALESCE(l.gross_weight_snapshot, p.gross_weight), 'FM9999999990.00')) AS "grossWeight",
                   w.code AS "warehouseCode",
                   l.product_id::text AS "productId",
                   l.warehouse_id::text AS "warehouseId",
                   l.qty,
                   l.unit_price AS "unitPrice",
                   round(l.unit_price * (1 + COALESCE(l.tax_rate, 0) / 100), 2) AS "taxInclusiveUnitPrice",
                   l.amount,
                   l.tax_rate AS "taxRate",
                   l.tax_amount AS "taxAmount",
                   l.price_tax_total AS "priceTaxTotal",
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
                INSERT INTO purchase_in_line (bill_id, line_no, source_order_no, source_line_no, product_id, product_code_snapshot, product_name_snapshot, product_spec_snapshot, warehouse_id, qty, unit_price, amount, tax_rate, tax_amount, price_tax_total, line_remark)
                VALUES (?::uuid, ?, ?, ?, ?::uuid, ?, ?, ?, ?::uuid, ?, ?, ?, ?, ?, ?, ?)
                """,
                redBill.get("id"),
                line.get("lineNo"),
                line.get("sourceOrderNo"),
                line.get("sourceLineNo"),
                line.get("productId"),
                line.get("productCode"),
                line.get("productName"),
                line.get("spec"),
                line.get("warehouseId"),
                qty.negate(),
                line.get("unitPrice"),
                ((BigDecimal) line.get("amount")).negate(),
                line.get("taxRate"),
                ((BigDecimal) line.get("taxAmount")).negate(),
                ((BigDecimal) line.get("priceTaxTotal")).negate(),
	                line.get("lineRemark")
	            );
	        }
	        operationLogService.logCurrent(OperationLogCommand.success(
	            "PURCHASE", "CREATE_RED_DRAFT", "purchase_in",
	            UUID.fromString(String.valueOf(redBill.get("id"))), redBillNo, Map.of(),
	            OperationLogCommand.state(OperationLogCommand.StateField.STATUS, String.valueOf(redBill.get("status")))
	        ));
	        return redBill;
	    }

	    private Map<String, Object> auditRedBill(Map<String, Object> row, String billNo) {
	        validateRedSourceStillAudited(row.get("redSourceBillId"));
	        validateRedLinesMatchSource(billNo, row.get("redSourceBillId"));
	        var lines = postingLines(billNo);
	        for (var line : lines) {
	            var qty = positiveRedQty(line, "采购入库红字单分录数量必须为负数");
	            postingPipeline.post(new PostingContext(
	                InventoryPostingHook.CHANNEL,
	                String.valueOf(line.get("productCode")),
	                String.valueOf(line.get("warehouseCode")),
	                qty.negate(),
	                "PURCHASE_IN_RED",
	                "PURCHASE_IN_RED:" + billNo
	            ));
	            var sourceOrderId = sourceOrderIdFromLine(line);
	            if (sourceOrderId != null) {
	                conversionService.decreaseExecutedQuantity(
	                    PURCHASE_ORDER_IN_SPEC,
	                    sourceOrderId,
	                    line.get("sourceLineNo"),
	                    qty
	                );
	            }
	        }
	        refreshPurchaseSourceStatuses(lines);
	        postingPipeline.post(financeContext(row, "PURCHASE_IN_RED"));
	        operationLogService.logCurrent(OperationLogCommand.success(
	            "PURCHASE", "RED_REVERSE", "purchase_in",
	            UUID.fromString(String.valueOf(row.get("id"))), billNo,
	            OperationLogCommand.state(OperationLogCommand.StateField.STATUS, BillStatus.DRAFT.name()),
	            OperationLogCommand.state(OperationLogCommand.StateField.STATUS, String.valueOf(row.get("status")))
	        ));
	        return row;
	    }

	    private Map<String, Object> reverseRedBill(Map<String, Object> row, String billNo) {
	        var lines = postingLines(billNo);
	        for (var line : lines) {
	            var qty = positiveRedQty(line, "采购入库红字单分录数量必须为负数");
	            postingPipeline.post(new PostingContext(
	                InventoryPostingHook.CHANNEL,
	                String.valueOf(line.get("productCode")),
	                String.valueOf(line.get("warehouseCode")),
	                qty,
	                "PURCHASE_IN_RED_REVERSE",
	                "PURCHASE_IN_RED_REVERSE:" + billNo
	            ));
	            var sourceOrderId = sourceOrderIdFromLine(line);
	            if (sourceOrderId != null) {
	                conversionService.increaseExecutedQuantity(
	                    PURCHASE_ORDER_IN_SPEC,
	                    sourceOrderId,
	                    line.get("sourceLineNo"),
	                    qty
	                );
	            }
	        }
	        refreshPurchaseSourceStatuses(lines);
	        postingPipeline.post(financeContext(row, "PURCHASE_IN_RED_REVERSE"));
	        return row;
	    }

    private void insertLines(String table, String billIdColumn, Object billId, String defaultSourceOrderNo, List<PurchaseInLineRequest> lines) {
        var lineNo = 1;
        for (var line : lines) {
            var product = productSnapshotService.resolve(line.productId(), line.productCode(), "商品");
            var warehouseId = lookupService.lookupEnabledId("md_warehouse", line.warehouseCode(), "仓库");
            var amounts = taxAmountCalculator.calculate(line.qty(), line.unitPrice(), line.taxRate());
            var sourceOrderNo = validationService.optionalText(line.sourceOrderNo() == null || line.sourceOrderNo().isBlank() ? defaultSourceOrderNo : line.sourceOrderNo());
            Integer sourceLineNo = line.sourceLineNo();
            if (sourceLineNo == null && sourceOrderNo != null) {
                sourceLineNo = lineNo;
            }
            jdbcTemplate.update("INSERT INTO " + table + " (" + billIdColumn + ", line_no, source_order_no, source_line_no, product_id, product_code_snapshot, product_name_snapshot, product_spec_snapshot, warehouse_id, qty, unit_price, amount, tax_rate, tax_amount, price_tax_total, line_remark) VALUES (?::uuid, ?, ?, ?, ?::uuid, ?, ?, ?, ?::uuid, ?, ?, ?, ?, ?, ?, ?)",
                billId, lineNo, sourceOrderNo, sourceLineNo, product.id(), product.code(), product.name(), product.spec(), warehouseId, line.qty(), line.unitPrice(), amounts.amount(), amounts.taxRate(), amounts.taxAmount(), amounts.priceTaxTotal(), validationService.optionalText(line.lineRemark()));
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
            SELECT l.line_no AS "lineNo",
                   l.source_order_no AS "sourceOrderNo",
                   l.source_line_no AS "sourceLineNo",
                   COALESCE(l.product_code_snapshot, p.code) AS "productCode",
                   w.code AS "warehouseCode",
                   l.qty
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
            (BigDecimal) row.get("totalAmount"),
            String.valueOf(row.get("currency"))
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

	    private boolean isRedBill(Map<String, Object> row) {
	        var redSourceBillId = row.get("redSourceBillId");
	        return redSourceBillId != null && !String.valueOf(redSourceBillId).isBlank();
	    }

	    private BigDecimal positiveRedQty(Map<String, Object> line, String message) {
	        var qty = (BigDecimal) line.get("qty");
	        if (qty == null || qty.compareTo(BigDecimal.ZERO) >= 0) {
	            throw new ResponseStatusException(HttpStatus.CONFLICT, message);
	        }
	        return qty.abs();
	    }

        private void requirePositiveQty(BigDecimal qty, String message) {
            if (qty == null || qty.compareTo(BigDecimal.ZERO) <= 0) {
                throw new ResponseStatusException(HttpStatus.BAD_REQUEST, message);
            }
        }

	    private void validateRedSourceStillAudited(Object redSourceBillId) {
	        var count = jdbcTemplate.queryForObject("""
	            SELECT COUNT(*)
	            FROM purchase_in
	            WHERE id = ?::uuid
	              AND status = 'AUDITED'
	            """, Integer.class, redSourceBillId);
	        if (count == null || count == 0) {
	            throw new ResponseStatusException(HttpStatus.CONFLICT, "来源采购入库单未审核，不能审核红字单");
	        }
	    }

	    private void validateRedLinesMatchSource(String billNo, Object redSourceBillId) {
	        var counts = jdbcTemplate.queryForMap("""
	            SELECT
	                (SELECT COUNT(*) FROM purchase_in_line WHERE bill_id = ?::uuid) AS "sourceCount",
	                (
	                    SELECT COUNT(*)
	                    FROM purchase_in_line red_line
	                    JOIN purchase_in red ON red.id = red_line.bill_id
	                    WHERE red.bill_no = ?
	                ) AS "redCount"
	            """, redSourceBillId, billNo);
	        var sourceCount = Number.class.cast(counts.get("sourceCount")).longValue();
	        var redCount = Number.class.cast(counts.get("redCount")).longValue();
	        if (sourceCount != redCount) {
	            throw new ResponseStatusException(HttpStatus.CONFLICT, "采购入库红字单分录必须与来源单一致");
	        }
	        var invalidHeader = jdbcTemplate.queryForList("""
	            SELECT 1
	            FROM purchase_in red
	            JOIN purchase_in source ON source.id = red.red_source_bill_id
	            WHERE red.bill_no = ?
	              AND (
	                  red.supplier_id <> source.supplier_id
	                  OR red.total_amount <> -source.total_amount
	              )
	            """, billNo);
	        if (!invalidHeader.isEmpty()) {
	            throw new ResponseStatusException(HttpStatus.CONFLICT, "采购入库红字单表头必须与来源单反向金额一致");
	        }
	        var invalidLines = jdbcTemplate.queryForList("""
	            SELECT red_line.line_no
	            FROM purchase_in red
	            JOIN purchase_in_line red_line ON red_line.bill_id = red.id
	            LEFT JOIN purchase_in_line source_line
	              ON source_line.bill_id = red.red_source_bill_id
	             AND source_line.line_no = red_line.line_no
	            WHERE red.bill_no = ?
	              AND (
	                  source_line.line_no IS NULL
	                  OR red_line.product_id <> source_line.product_id
	                  OR red_line.warehouse_id <> source_line.warehouse_id
	                  OR COALESCE(red_line.source_order_no, '') <> COALESCE(source_line.source_order_no, '')
	                  OR COALESCE(red_line.source_line_no, -1) <> COALESCE(source_line.source_line_no, -1)
	                  OR red_line.qty <> -source_line.qty
	                  OR red_line.unit_price <> source_line.unit_price
	                  OR red_line.amount <> -source_line.amount
	                  OR COALESCE(red_line.tax_rate, 0) <> COALESCE(source_line.tax_rate, 0)
	                  OR red_line.tax_amount <> -source_line.tax_amount
	                  OR red_line.price_tax_total <> -source_line.price_tax_total
	              )
	            """, billNo);
	        if (!invalidLines.isEmpty()) {
	            throw new ResponseStatusException(HttpStatus.CONFLICT, "采购入库红字单分录必须保持来源行反向数量和金额");
	        }
	    }

	    private String sourceOrderIdFromLine(Map<String, Object> line) {
        var sourceOrderNo = line.get("sourceOrderNo");
        if (sourceOrderNo == null || String.valueOf(sourceOrderNo).isBlank() || line.get("sourceLineNo") == null) {
            return null;
        }
        return sourceOrderId(String.valueOf(sourceOrderNo));
    }

    private void refreshPurchaseSourceStatuses(List<Map<String, Object>> lines) {
        lines.stream()
            .map(this::sourceOrderIdFromLine)
            .filter(id -> id != null && !id.isBlank())
            .distinct()
            .forEach(id -> conversionService.refreshSourceStatus(PURCHASE_ORDER_IN_SPEC, id));
    }

    private List<SourceLineQuantityDemand> sourceLineDemands(List<Map<String, Object>> lines) {
        return lines.stream()
            .filter(line -> line.get("sourceOrderNo") != null && line.get("sourceLineNo") != null)
            .map(line -> new SourceLineQuantityDemand(
                String.valueOf(line.get("sourceOrderNo")),
                line.get("sourceLineNo"),
                (BigDecimal) line.get("qty")
            ))
            .toList();
    }

    private String settlementCurrency(PurchaseInDraftRequest request) {
        var sourceBillNos = new LinkedHashSet<String>();
        if (request.sourceOrderNo() != null && !request.sourceOrderNo().isBlank()) {
            sourceBillNos.add(request.sourceOrderNo().trim());
        }
        request.lines().stream()
            .map(PurchaseInLineRequest::sourceOrderNo)
            .filter(value -> value != null && !value.isBlank())
            .map(String::trim)
            .forEach(sourceBillNos::add);
        if (sourceBillNos.isEmpty()) {
            return normalizeCurrency(request.currency());
        }
        var currencies = new LinkedHashSet<String>();
        for (var sourceBillNo : sourceBillNos) {
            var rows = jdbcTemplate.queryForList(
                "SELECT currency FROM purchase_order WHERE bill_no = ? AND status = ?",
                sourceBillNo,
                BillStatus.AUDITED.name()
            );
            if (rows.isEmpty()) {
                throw new ResponseStatusException(HttpStatus.CONFLICT, "采购入库来源采购订单不存在或未审核");
            }
            currencies.add(String.valueOf(rows.getFirst().get("currency")));
        }
        if (currencies.size() != 1) {
            throw new ResponseStatusException(HttpStatus.CONFLICT, "一张采购入库单不能混用不同币种的采购订单");
        }
        var inherited = currencies.getFirst();
        if (request.currency() != null && !inherited.equals(normalizeCurrency(request.currency()))) {
            throw new ResponseStatusException(HttpStatus.CONFLICT, "采购入库币种必须继承来源采购订单");
        }
        return inherited;
    }

    private String normalizeCurrency(String value) {
        if (value == null) {
            return "CNY";
        }
        if (value.isBlank()) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "无来源采购入库请选择币种");
        }
        var currency = value.trim().toUpperCase(Locale.ROOT);
        if (!"CNY".equals(currency) && !"USD".equals(currency)) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "币种只支持 CNY 或 USD");
        }
        return currency;
    }

    private void assertNoPurchaseReturns(String billNo) {
        var downstream = jdbcTemplate.queryForObject("""
            SELECT COUNT(*)::int
            FROM purchase_return_line line
            JOIN purchase_return header ON header.id = line.bill_id
            WHERE line.source_in_no = ?
              AND header.status <> 'VOID'
            """, Integer.class, billNo);
        if (downstream != null && downstream > 0) {
            throw new ResponseStatusException(HttpStatus.CONFLICT, "采购入库单已有采购退货下游，不能反审核");
        }
    }

    private void lockPurchaseInHeader(String billNo) {
        jdbcTemplate.queryForList(
            "SELECT id::text FROM purchase_in WHERE bill_no = ? FOR UPDATE",
            String.class,
            billNo
        );
    }

    public record PurchaseInDraftRequest(String billNo, String sourceOrderNo, String supplierCode, String billDate, String department, String ownerName, String currency, List<PurchaseInLineRequest> lines) {
        public PurchaseInDraftRequest(String billNo, String sourceOrderNo, String supplierCode, String billDate, String department, String ownerName, List<PurchaseInLineRequest> lines) {
            this(billNo, sourceOrderNo, supplierCode, billDate, department, ownerName, "CNY", lines);
        }

        public PurchaseInDraftRequest {
            if (lines == null || lines.isEmpty()) {
                throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "至少需要一条分录");
            }
        }
    }

    public record PurchaseInLineRequest(String productId, String productCode, String warehouseCode, String sourceOrderNo, Integer sourceLineNo, BigDecimal qty, BigDecimal unitPrice, BigDecimal taxRate, String lineRemark) {
    }

    public record RedReverseRequest(String redBillNo, String billDate, String ownerName) {
    }
}
