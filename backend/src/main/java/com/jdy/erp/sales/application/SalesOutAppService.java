package com.jdy.erp.sales.application;

import java.math.BigDecimal;
import java.time.LocalDate;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.UUID;

import com.jdy.erp.inventory.application.InventoryPostingCommand;
import com.jdy.erp.inventory.application.InventoryPostingCommand.PostingAction;
import com.jdy.erp.inventory.application.InventoryPostingService;
import com.jdy.erp.inventory.application.InventoryTraceLifecycleService;
import com.jdy.erp.shared.application.BillLifecycleService;
import com.jdy.erp.shared.application.BillLifecycleService.BillLifecycleTarget;
import com.jdy.erp.shared.application.BillLifecycleService.SourceLineQuantityDemand;
import com.jdy.erp.shared.application.BillLifecycleService.SourceLineQuantityGuard;
import com.jdy.erp.shared.application.BillLifecycleService.VoidRequest;
import com.jdy.erp.shared.application.ConversionService;
import com.jdy.erp.shared.application.ConversionService.SourceExecutionSpec;
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
import com.jdy.erp.system.security.CurrentSessionService;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.server.ResponseStatusException;

@Service
public class SalesOutAppService {
    private static final String BILL_TABLE = "sales_out";
    private static final BillLifecycleTarget LIFECYCLE_TARGET = new BillLifecycleTarget(BILL_TABLE, "sales_out_line", "bill_id", "SALES", "sales_out");
    private static final SourceExecutionSpec SALES_ORDER_OUT_SPEC = new SourceExecutionSpec(
        "sales_order",
        "sales_order_line",
        "order_id",
        "line_no",
        "shipped_qty",
        "qty",
        "out_status",
        "销售出库数量不能超过销售订单剩余可出数量"
    );
    private static final SourceExecutionSpec DELIVERY_NOTICE_OUT_SPEC = new SourceExecutionSpec(
        "delivery_notice",
        "delivery_notice_line",
        "bill_id",
        "line_no",
        "shipped_qty",
        "qty",
        "out_status",
        "销售出库数量不能超过发货通知剩余可出数量"
    );
    private static final SourceLineQuantityGuard DELIVERY_NOTICE_OUT_QUANTITY_GUARD = new SourceLineQuantityGuard(
        DELIVERY_NOTICE_OUT_SPEC,
        "sales_out",
        "sales_out_line",
        "bill_id",
        "source_delivery_notice_no",
        "source_delivery_line_no",
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
    private final CurrentSessionService currentSessionService;
    private final TaxAmountCalculator taxAmountCalculator;
    private final InventoryPostingService inventoryPostingService;
    private final ProductSnapshotService productSnapshotService;
    private final RedReverseGuardService redReverseGuardService;
    private final InventoryTraceLifecycleService inventoryTraceLifecycleService;

    public SalesOutAppService(
        JdbcTemplate jdbcTemplate,
        LookupService lookupService,
        ValidationService validationService,
        BillLifecycleService lifecycleService,
        PostingPipeline postingPipeline,
        ConversionService conversionService,
        OperationLogService operationLogService,
        NumberingService numberingService,
        CurrentSessionService currentSessionService,
        TaxAmountCalculator taxAmountCalculator,
        InventoryPostingService inventoryPostingService,
        ProductSnapshotService productSnapshotService,
        RedReverseGuardService redReverseGuardService,
        InventoryTraceLifecycleService inventoryTraceLifecycleService
    ) {
        this.jdbcTemplate = jdbcTemplate;
        this.lookupService = lookupService;
        this.validationService = validationService;
        this.lifecycleService = lifecycleService;
        this.postingPipeline = postingPipeline;
        this.conversionService = conversionService;
        this.operationLogService = operationLogService;
        this.numberingService = numberingService;
        this.currentSessionService = currentSessionService;
        this.taxAmountCalculator = taxAmountCalculator;
        this.inventoryPostingService = inventoryPostingService;
        this.productSnapshotService = productSnapshotService;
        this.redReverseGuardService = redReverseGuardService;
        this.inventoryTraceLifecycleService = inventoryTraceLifecycleService;
    }

    public Map<String, Object> detail(String billNo) {
        var billRows = jdbcTemplate.queryForList("""
            SELECT so.id::text AS id,
                   so.bill_no AS "billNo",
                   NULL AS "sourceOrderNo",
                   c.code AS "customerCode",
                   c.name AS customer,
                   to_char(so.bill_date, 'YYYY-MM-DD') AS "billDate",
                   so.department,
                   so.status,
                   so.close_status AS "closeStatus",
                   so.frozen_status AS "frozenStatus",
                   so.total_amount AS "totalAmount",
                   so.currency,
                   so.owner_name AS "ownerName",
                   COALESCE(creator.display_name, so.owner_name, '') AS "createdByName",
                   COALESCE(so.remark, '') AS remark,
	                   (
	                       SELECT red.bill_no
	                       FROM sales_out red
	                       WHERE red.red_source_bill_id = so.id
	                         AND red.status <> 'VOID'
	                       LIMIT 1
	                   ) AS "redReverseBillNo",
	                   (
	                       SELECT original.bill_no
	                       FROM sales_out original
	                       WHERE original.id = so.red_source_bill_id
	                       LIMIT 1
	                   ) AS "redSourceBillNo"
            FROM sales_out so
            JOIN md_customer c ON c.id = so.customer_id
            LEFT JOIN public.sys_user creator ON creator.id = so.created_by
            WHERE so.bill_no = ?
	            """, billNo);
        if (billRows.isEmpty()) {
            throw new ResponseStatusException(HttpStatus.NOT_FOUND, "销售出库单不存在");
        }
        var lines = jdbcTemplate.queryForList("""
            SELECT l.line_no AS "lineNo",
                   l.source_order_no AS "sourceOrderNo",
                   l.source_line_no AS "sourceLineNo",
                   l.source_delivery_notice_no AS "sourceDeliveryNoticeNo",
                   l.source_delivery_line_no AS "sourceDeliveryLineNo",
                   l.product_id::text AS "productId",
                   COALESCE(l.product_code_snapshot, p.code) AS "productCode",
                   COALESCE(l.product_name_snapshot, p.name) AS "productName",
                   COALESCE(l.product_spec_snapshot, p.spec, '') AS spec,
                   COALESCE(l.product_unit_snapshot, p.unit, '') AS unit,
                   trim(to_char(COALESCE(l.net_weight_snapshot, p.net_weight), 'FM9999999990.00')) AS "netWeight",
                   trim(to_char(COALESCE(l.gross_weight_snapshot, p.gross_weight), 'FM9999999990.00')) AS "grossWeight",
                   w.code AS "warehouseCode",
                   l.qty,
                   l.line_close_status AS "lineCloseStatus",
                   l.line_frozen_status AS "lineFrozenStatus",
                   l.unit_price AS "unitPrice",
                   round(l.unit_price * (1 + COALESCE(l.tax_rate, 0) / 100), 2) AS "taxInclusiveUnitPrice",
                   l.amount,
                   l.tax_rate AS "taxRate",
                   l.tax_amount AS "taxAmount",
                   l.price_tax_total AS "priceTaxTotal",
                   COALESCE(l.customer_material_code, '') AS "customerMaterialCode",
                   COALESCE(l.customer_order_no, '') AS "customerOrderNo",
                   COALESCE(l.line_remark, '') AS "lineRemark",
                   to_char(l.plan_delivery_date, 'YYYY-MM-DD') AS "planDeliveryDate"
            FROM sales_out_line l
            JOIN md_product p ON p.id = l.product_id
            LEFT JOIN md_warehouse w ON w.id = l.warehouse_id
            JOIN sales_out so ON so.id = l.bill_id
            WHERE so.bill_no = ?
            ORDER BY l.line_no
            """, billNo);
        return Map.of("action", "DETAIL", "document", billRows.get(0), "lines", lines);
    }

    @Transactional
    public Map<String, Object> saveDraft(SalesOutDraftRequest request) {
        request.lines().forEach(line -> requirePositiveQty(line.qty(), "销售出库数量必须大于 0"));
        var billNo = numberingService.assignBillNo("salesOut", request.billNo());
        redReverseGuardService.assertNotRedDraftForBillNo(BILL_TABLE, billNo, "销售出库单");
        var customerId = lookupService.lookupEnabledId("md_customer", request.customerCode(), "客户");
        var totalAmount = request.lines().stream()
            .map(line -> taxAmountCalculator.calculate(line.qty(), line.unitPrice(), line.taxRate()).priceTaxTotal())
            .reduce(BigDecimal.ZERO, BigDecimal::add);
        var ownerName = currentSessionService.currentDisplayName();
        var createdBy = currentSessionService.currentUserId();
        var sourceDeliveryNoticeId = sourceDeliveryNoticeId(request);
        var currency = inheritedCurrency(request);
        var bills = jdbcTemplate.queryForList("""
            INSERT INTO sales_out (bill_no, source_order_id, source_delivery_notice_id, customer_id, bill_date, department, status, total_amount, currency, owner_name, remark, created_by)
            VALUES (?, ?::uuid, ?::uuid, ?::uuid, ?, ?, ?, ?, ?, ?, ?, ?::uuid)
            ON CONFLICT (bill_no) DO UPDATE
            SET source_order_id = EXCLUDED.source_order_id,
                source_delivery_notice_id = EXCLUDED.source_delivery_notice_id,
                customer_id = EXCLUDED.customer_id,
                bill_date = EXCLUDED.bill_date,
                department = EXCLUDED.department,
                status = EXCLUDED.status,
                total_amount = EXCLUDED.total_amount,
                currency = EXCLUDED.currency,
                owner_name = EXCLUDED.owner_name,
                remark = EXCLUDED.remark,
                updated_at = now(),
                version = sales_out.version + 1
            WHERE sales_out.status = 'DRAFT'
            RETURNING id::text AS id, bill_no AS "billNo", total_amount AS "totalAmount", currency
            """,
            billNo,
            null,
            sourceDeliveryNoticeId,
            customerId,
            LocalDate.parse(validationService.required(request.billDate(), "业务日期")),
            request.department(),
            BillStatus.DRAFT.name(),
            totalAmount,
            currency,
            ownerName,
            validationService.optionalText(request.remark()),
            createdBy
        );
        if (bills.isEmpty()) {
            throw new ResponseStatusException(HttpStatus.CONFLICT, "只有草稿销售出库单可以覆盖保存");
        }
        var bill = bills.getFirst();
        var billId = bill.get("id");
        inventoryTraceLifecycleService.prepareForLineReplacement("SALES_OUT", billId);
        jdbcTemplate.update("DELETE FROM sales_out_line WHERE bill_id = ?::uuid", billId);
        insertLines(billId, request.sourceOrderNo(), request.lines());
        return bill;
    }

    @Transactional
    public Map<String, Object> audit(String billNo) {
        var row = lifecycleService.transition(
            BILL_TABLE,
            billNo,
            BillStatus.DRAFT,
            BillStatus.AUDITED,
	            "id::text AS id, bill_no AS \"billNo\", source_order_id::text AS \"sourceOrderId\", red_source_bill_id::text AS \"redSourceBillId\", customer_id::text AS \"customerId\", bill_date AS \"billDate\", total_amount AS \"totalAmount\", currency, status",
            "SALES",
            "AUDIT",
            "sales_out",
            "销售出库单不存在或已审核"
	        );
	        if (isRedBill(row)) {
	            return auditRedBill(row, billNo);
	        }
	        var lines = postingLines(billNo);
        lifecycleService.guardSourceLineQuantities(DELIVERY_NOTICE_OUT_QUANTITY_GUARD, deliveryNoticeDemands(lines), billNo);
        for (var line : lines) {
            var sourceOrderId = sourceOrderIdFromLine(line);
            if (sourceOrderId != null) {
                conversionService.increaseExecutedQuantity(
                    SALES_ORDER_OUT_SPEC,
                    sourceOrderId,
                    line.get("sourceLineNo"),
                    (BigDecimal) line.get("qty")
                );
            }
        }
        refreshSalesSourceStatuses(lines);
        for (var line : lines) {
            inventoryPostingService.shipReserved(InventoryPostingCommand.document(
                String.valueOf(line.get("productCode")),
                String.valueOf(line.get("warehouseCode")),
                (BigDecimal) line.get("qty"),
                "SALES_OUT",
                "SALES_OUT",
                line.get("sourceBillId"),
                line.get("sourceBillLineId"),
                billNo,
                line.get("sourceBillDate"),
                PostingAction.AUDIT
            ));
        }
        postingPipeline.post(financeContext(row, "SALES_OUT"));
        return row;
    }

    @Transactional
    public Map<String, Object> reverse(String billNo) {
        var lockedSource = lockSourceHeader(billNo, "销售出库单不存在或不能反审核");
        if (!BillStatus.AUDITED.name().equals(String.valueOf(lockedSource.get("status")))) {
            throw new ResponseStatusException(HttpStatus.CONFLICT, "销售出库单不存在或不能反审核");
        }
        assertNoNonVoidSalesReturn(lockedSource.get("id"), "反审核");
        redReverseGuardService.assertNoNonVoidRedBillForBillNo(BILL_TABLE, billNo, "销售出库单", "反审核");
        var row = lifecycleService.transition(
            BILL_TABLE,
            billNo,
            BillStatus.AUDITED,
            BillStatus.DRAFT,
	            "id::text AS id, bill_no AS \"billNo\", source_order_id::text AS \"sourceOrderId\", red_source_bill_id::text AS \"redSourceBillId\", customer_id::text AS \"customerId\", bill_date AS \"billDate\", total_amount AS \"totalAmount\", currency, status",
            "SALES",
            "REVERSE",
            "sales_out",
            "销售出库单不存在或不能反审核"
	        );
	        if (isRedBill(row)) {
	            return reverseRedBill(row, billNo);
	        }
	        var lines = postingLines(billNo);
        for (var line : lines) {
            inventoryPostingService.reverseShipReserved(InventoryPostingCommand.document(
                String.valueOf(line.get("productCode")),
                String.valueOf(line.get("warehouseCode")),
                (BigDecimal) line.get("qty"),
                "SALES_OUT_REVERSE",
                "SALES_OUT",
                line.get("sourceBillId"),
                line.get("sourceBillLineId"),
                billNo,
                line.get("sourceBillDate"),
                PostingAction.REVERSE
            ));
        }
        for (var line : lines) {
            var sourceOrderId = sourceOrderIdFromLine(line);
            if (sourceOrderId != null) {
                conversionService.decreaseExecutedQuantity(
                    SALES_ORDER_OUT_SPEC,
                    sourceOrderId,
                    line.get("sourceLineNo"),
                    (BigDecimal) line.get("qty")
                );
            }
        }
        refreshSalesSourceStatuses(lines);
        postingPipeline.post(financeContext(row, "SALES_OUT_REVERSE"));
        return row;
    }

    @Transactional
    public Map<String, Object> voidBill(String billNo, VoidRequest request) {
        return lifecycleService.voidBill(LIFECYCLE_TARGET, billNo, request);
    }

    public Map<String, Object> delete(String billNo) {
        return lifecycleService.deleteDraft(LIFECYCLE_TARGET, billNo, "只有草稿销售出库单可以删除");
    }

    @Transactional
    public Map<String, Object> redReverse(String billNo, RedReverseRequest request) {
        var sourceRows = jdbcTemplate.queryForList("""
            SELECT id::text AS id,
                   source_order_id::text AS "sourceOrderId",
                   customer_id::text AS "customerId",
                   department,
                   total_amount,
                   currency,
                   owner_name AS "ownerName",
                   status
            FROM sales_out
            WHERE bill_no = ?
            FOR UPDATE
            """, billNo);
        if (sourceRows.isEmpty() || !BillStatus.AUDITED.name().equals(String.valueOf(sourceRows.get(0).get("status")))) {
            throw new ResponseStatusException(HttpStatus.CONFLICT, "只有已审核销售出库单可以红冲");
        }
        assertNoNonVoidSalesReturn(sourceRows.get(0).get("id"), "红冲");
        redReverseGuardService.assertNoNonVoidRedBill(BILL_TABLE, sourceRows.get(0).get("id"), "销售出库单");
        var redBillNo = numberingService.nextBillNo("salesOut");
        var source = sourceRows.get(0);
        var redBill = jdbcTemplate.queryForMap("""
            INSERT INTO sales_out (bill_no, source_order_id, red_source_bill_id, customer_id, bill_date, department, status, total_amount, currency, owner_name)
            VALUES (?, ?::uuid, ?::uuid, ?::uuid, ?, ?, ?, ?, ?, ?)
            RETURNING id::text AS id, bill_no AS "billNo", status, total_amount AS "totalAmount", currency
            """,
            redBillNo,
            source.get("sourceOrderId"),
            source.get("id"),
            source.get("customerId"),
            LocalDate.parse(validationService.required(request.billDate(), "红冲日期")),
            source.get("department"),
	            BillStatus.DRAFT.name(),
	            ((BigDecimal) source.get("total_amount")).negate(),
	            source.get("currency"),
	            request.ownerName() == null || request.ownerName().isBlank() ? source.get("ownerName") : request.ownerName().trim()
	        );
	        var lines = redSourceLines(billNo);
	        for (var line : lines) {
            var qty = (BigDecimal) line.get("qty");
            jdbcTemplate.update("""
                INSERT INTO sales_out_line (bill_id, line_no, source_order_no, source_line_no, source_delivery_notice_no, source_delivery_line_no, product_id, product_code_snapshot, product_name_snapshot, product_spec_snapshot, warehouse_id, qty, unit_price, amount, tax_rate, tax_amount, price_tax_total, customer_material_code, customer_order_no, line_remark, plan_delivery_date)
                VALUES (?::uuid, ?, ?, ?, ?, ?, ?::uuid, ?, ?, ?, ?::uuid, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                redBill.get("id"),
                line.get("lineNo"),
                line.get("sourceOrderNo"),
                line.get("sourceLineNo"),
                line.get("sourceDeliveryNoticeNo"),
                line.get("sourceDeliveryLineNo"),
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
                line.get("customerMaterialCode"),
                line.get("customerOrderNo"),
                line.get("lineRemark"),
	                line.get("planDeliveryDate")
	            );
	        }
	        operationLogService.logCurrent(OperationLogCommand.success(
	            "SALES", "CREATE_RED_DRAFT", "sales_out",
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
	            var qty = positiveRedQty(line, "销售出库红字单分录数量必须为负数");
	            inventoryPostingService.reverseShipReserved(InventoryPostingCommand.document(
	                String.valueOf(line.get("productCode")),
	                String.valueOf(line.get("warehouseCode")),
	                qty,
	                "SALES_OUT_RED",
	                "SALES_OUT",
	                line.get("sourceBillId"),
	                line.get("sourceBillLineId"),
	                billNo,
	                line.get("sourceBillDate"),
	                PostingAction.RED_AUDIT
	            ));
	            var sourceOrderId = sourceOrderIdFromLine(line);
	            if (sourceOrderId != null) {
	                conversionService.decreaseExecutedQuantity(
	                    SALES_ORDER_OUT_SPEC,
	                    sourceOrderId,
	                    line.get("sourceLineNo"),
	                    qty
	                );
	            }
	        }
	        refreshSalesSourceStatuses(lines);
	        postingPipeline.post(financeContext(row, "SALES_OUT_RED"));
	        operationLogService.logCurrent(OperationLogCommand.success(
	            "SALES", "RED_REVERSE", "sales_out",
	            UUID.fromString(String.valueOf(row.get("id"))), billNo,
	            OperationLogCommand.state(OperationLogCommand.StateField.STATUS, BillStatus.DRAFT.name()),
	            OperationLogCommand.state(OperationLogCommand.StateField.STATUS, String.valueOf(row.get("status")))
	        ));
	        return row;
	    }

	    private Map<String, Object> reverseRedBill(Map<String, Object> row, String billNo) {
	        var lines = postingLines(billNo);
	        for (var line : lines) {
	            var qty = positiveRedQty(line, "销售出库红字单分录数量必须为负数");
	            inventoryPostingService.shipReserved(InventoryPostingCommand.document(
	                String.valueOf(line.get("productCode")),
	                String.valueOf(line.get("warehouseCode")),
	                qty,
	                "SALES_OUT_RED_REVERSE",
	                "SALES_OUT",
	                line.get("sourceBillId"),
	                line.get("sourceBillLineId"),
	                billNo,
	                line.get("sourceBillDate"),
	                PostingAction.RED_REVERSE
	            ));
	            var sourceOrderId = sourceOrderIdFromLine(line);
	            if (sourceOrderId != null) {
	                conversionService.increaseExecutedQuantity(
	                    SALES_ORDER_OUT_SPEC,
	                    sourceOrderId,
	                    line.get("sourceLineNo"),
	                    qty
	                );
	            }
	        }
	        refreshSalesSourceStatuses(lines);
	        postingPipeline.post(financeContext(row, "SALES_OUT_RED_REVERSE"));
	        return row;
	    }

    private void insertLines(Object billId, String defaultSourceOrderNo, List<SalesOutLineRequest> lines) {
        var lineNo = 1;
        for (var line : lines) {
            var product = productSnapshotService.resolve(line.productId(), line.productCode(), "商品");
            var warehouseId = lookupService.lookupEnabledId("md_warehouse", line.warehouseCode(), "仓库");
            var amounts = taxAmountCalculator.calculate(line.qty(), line.unitPrice(), line.taxRate());
            var sourceDeliveryNo = validationService.optionalText(line.sourceDeliveryNoticeNo() == null || line.sourceDeliveryNoticeNo().isBlank() ? line.sourceOrderNo() : line.sourceDeliveryNoticeNo());
            var sourceDeliveryLineNo = line.sourceDeliveryLineNo() == null ? line.sourceLineNo() : line.sourceDeliveryLineNo();
            if (sourceDeliveryNo == null || sourceDeliveryLineNo == null) {
                throw new ResponseStatusException(HttpStatus.CONFLICT, "销售出库只能由已审核发货通知单下推生成");
            }
            var source = sourceFromDeliveryNotice(sourceDeliveryNo, sourceDeliveryLineNo);
            var sourceOrderNo = source.get("sourceOrderNo") == null ? null : String.valueOf(source.get("sourceOrderNo"));
            Integer sourceLineNo = (Integer) source.get("sourceLineNo");
            if (sourceLineNo == null && sourceOrderNo != null) {
                sourceLineNo = lineNo;
            }
            jdbcTemplate.update("""
                INSERT INTO sales_out_line (bill_id, line_no, source_order_no, source_line_no, source_delivery_notice_no, source_delivery_line_no, product_id, product_code_snapshot, product_name_snapshot, product_spec_snapshot, warehouse_id, qty, unit_price, amount, tax_rate, tax_amount, price_tax_total, customer_material_code, customer_order_no, line_remark, plan_delivery_date)
                VALUES (?::uuid, ?, ?, ?, ?, ?, ?::uuid, ?, ?, ?, ?::uuid, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                billId,
                lineNo,
                sourceOrderNo,
                sourceLineNo,
                sourceDeliveryNo,
                sourceDeliveryLineNo,
                product.id(),
                product.code(),
                product.name(),
                product.spec(),
                warehouseId,
                line.qty(),
                line.unitPrice(),
                amounts.amount(),
                amounts.taxRate(),
                amounts.taxAmount(),
                amounts.priceTaxTotal(),
                validationService.optionalText(line.customerMaterialCode()),
                validationService.optionalText(line.customerOrderNo()),
                validationService.optionalText(line.lineRemark()),
                optionalDate(line.planDeliveryDate())
            );
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

    private List<Map<String, Object>> postingLines(String billNo) {
        return jdbcTemplate.queryForList("""
            SELECT so.id::text AS "sourceBillId",
                   l.id::text AS "sourceBillLineId",
                   so.bill_date AS "sourceBillDate",
                   l.line_no AS "lineNo",
                   l.source_order_no AS "sourceOrderNo",
                   l.source_line_no AS "sourceLineNo",
                   l.source_delivery_notice_no AS "sourceDeliveryNoticeNo",
                   l.source_delivery_line_no AS "sourceDeliveryLineNo",
                   COALESCE(l.product_code_snapshot, p.code) AS "productCode",
                   COALESCE(l.product_name_snapshot, p.name) AS "productName",
                   COALESCE(l.product_spec_snapshot, p.spec, '') AS spec,
                   COALESCE(l.product_unit_snapshot, p.unit, '') AS unit,
                   trim(to_char(COALESCE(l.net_weight_snapshot, p.net_weight), 'FM9999999990.00')) AS "netWeight",
                   trim(to_char(COALESCE(l.gross_weight_snapshot, p.gross_weight), 'FM9999999990.00')) AS "grossWeight",
                   w.code AS "warehouseCode",
                   l.qty
            FROM sales_out_line l
            JOIN md_product p ON p.id = l.product_id
            JOIN md_warehouse w ON w.id = l.warehouse_id
            JOIN sales_out so ON so.id = l.bill_id
            WHERE so.bill_no = ?
            ORDER BY l.line_no
            """, billNo);
    }

    private Map<String, Object> lockSourceHeader(String billNo, String conflictMessage) {
        var rows = jdbcTemplate.queryForList("""
            SELECT id::text AS id, status
            FROM sales_out
            WHERE bill_no = ?
            FOR UPDATE
            """, billNo);
        if (rows.isEmpty()) {
            throw new ResponseStatusException(HttpStatus.CONFLICT, conflictMessage);
        }
        return rows.getFirst();
    }

    private void assertNoNonVoidSalesReturn(Object sourceBillId, String actionLabel) {
        var count = jdbcTemplate.queryForObject("""
            SELECT COUNT(*)
            FROM sales_return return_bill
            JOIN sales_return_line return_line ON return_line.bill_id = return_bill.id
            JOIN sales_out_line source_line ON source_line.id = return_line.source_out_line_id
            WHERE source_line.bill_id = ?::uuid
              AND return_bill.status <> 'VOID'
            """, Long.class, sourceBillId);
        if (count != null && count > 0) {
            throw new ResponseStatusException(
                HttpStatus.CONFLICT,
                "销售出库单已关联非作废销售退货单，不能" + actionLabel
            );
        }
    }

    private PostingContext financeContext(Map<String, Object> row, String txnType) {
        return PostingContext.finance(
            txnType,
            String.valueOf(row.get("billNo")),
            String.valueOf(row.get("customerId")),
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
	            FROM sales_out
	            WHERE id = ?::uuid
	              AND status = 'AUDITED'
	            """, Integer.class, redSourceBillId);
	        if (count == null || count == 0) {
	            throw new ResponseStatusException(HttpStatus.CONFLICT, "来源销售出库单未审核，不能审核红字单");
	        }
	    }

	    private void validateRedLinesMatchSource(String billNo, Object redSourceBillId) {
	        var counts = jdbcTemplate.queryForMap("""
	            SELECT
	                (SELECT COUNT(*) FROM sales_out_line WHERE bill_id = ?::uuid) AS "sourceCount",
	                (
	                    SELECT COUNT(*)
	                    FROM sales_out_line red_line
	                    JOIN sales_out red ON red.id = red_line.bill_id
	                    WHERE red.bill_no = ?
	                ) AS "redCount"
	            """, redSourceBillId, billNo);
	        var sourceCount = Number.class.cast(counts.get("sourceCount")).longValue();
	        var redCount = Number.class.cast(counts.get("redCount")).longValue();
	        if (sourceCount != redCount) {
	            throw new ResponseStatusException(HttpStatus.CONFLICT, "销售出库红字单分录必须与来源单一致");
	        }
	        var invalidHeader = jdbcTemplate.queryForList("""
	            SELECT 1
	            FROM sales_out red
	            JOIN sales_out source ON source.id = red.red_source_bill_id
	            WHERE red.bill_no = ?
	              AND (
	                  red.customer_id <> source.customer_id
	                  OR red.total_amount <> -source.total_amount
	              )
	            """, billNo);
	        if (!invalidHeader.isEmpty()) {
	            throw new ResponseStatusException(HttpStatus.CONFLICT, "销售出库红字单表头必须与来源单反向金额一致");
	        }
	        var invalidLines = jdbcTemplate.queryForList("""
	            SELECT red_line.line_no
	            FROM sales_out red
	            JOIN sales_out_line red_line ON red_line.bill_id = red.id
	            LEFT JOIN sales_out_line source_line
	              ON source_line.bill_id = red.red_source_bill_id
	             AND source_line.line_no = red_line.line_no
	            WHERE red.bill_no = ?
	              AND (
	                  source_line.line_no IS NULL
	                  OR red_line.product_id <> source_line.product_id
	                  OR red_line.warehouse_id <> source_line.warehouse_id
	                  OR COALESCE(red_line.source_order_no, '') <> COALESCE(source_line.source_order_no, '')
	                  OR COALESCE(red_line.source_line_no, -1) <> COALESCE(source_line.source_line_no, -1)
	                  OR COALESCE(red_line.source_delivery_notice_no, '') <> COALESCE(source_line.source_delivery_notice_no, '')
	                  OR COALESCE(red_line.source_delivery_line_no, -1) <> COALESCE(source_line.source_delivery_line_no, -1)
	                  OR red_line.qty <> -source_line.qty
	                  OR red_line.unit_price <> source_line.unit_price
	                  OR red_line.amount <> -source_line.amount
	                  OR COALESCE(red_line.tax_rate, 0) <> COALESCE(source_line.tax_rate, 0)
	                  OR red_line.tax_amount <> -source_line.tax_amount
	                  OR red_line.price_tax_total <> -source_line.price_tax_total
	              )
	            """, billNo);
	        if (!invalidLines.isEmpty()) {
	            throw new ResponseStatusException(HttpStatus.CONFLICT, "销售出库红字单分录必须保持来源行反向数量和金额");
	        }
	    }

	    private List<Map<String, Object>> redSourceLines(String billNo) {
        return jdbcTemplate.queryForList("""
            SELECT l.line_no AS "lineNo",
                   l.source_order_no AS "sourceOrderNo",
                   l.source_line_no AS "sourceLineNo",
                   l.source_delivery_notice_no AS "sourceDeliveryNoticeNo",
                   l.source_delivery_line_no AS "sourceDeliveryLineNo",
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
                   COALESCE(l.customer_material_code, '') AS "customerMaterialCode",
                   COALESCE(l.customer_order_no, '') AS "customerOrderNo",
                   COALESCE(l.line_remark, '') AS "lineRemark",
                   l.plan_delivery_date AS "planDeliveryDate"
            FROM sales_out_line l
            JOIN md_product p ON p.id = l.product_id
            JOIN md_warehouse w ON w.id = l.warehouse_id
            JOIN sales_out so ON so.id = l.bill_id
            WHERE so.bill_no = ?
            ORDER BY l.line_no
            """, billNo);
    }

    public record SalesOutDraftRequest(String billNo, String sourceOrderNo, String customerCode, String billDate, String department, String ownerName, String remark, String currency, List<SalesOutLineRequest> lines) {
        public SalesOutDraftRequest(String billNo, String sourceOrderNo, String customerCode, String billDate, String department, String ownerName, String remark, List<SalesOutLineRequest> lines) {
            this(billNo, sourceOrderNo, customerCode, billDate, department, ownerName, remark, null, lines);
        }

        public SalesOutDraftRequest {
            if (lines == null || lines.isEmpty()) {
                throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "至少需要一条分录");
            }
        }
    }

    private String sourceOrderIdFromLine(Map<String, Object> line) {
        var sourceOrderNo = line.get("sourceOrderNo");
        if (sourceOrderNo == null || String.valueOf(sourceOrderNo).isBlank() || line.get("sourceLineNo") == null) {
            return null;
        }
        return sourceOrderId(String.valueOf(sourceOrderNo));
    }

    private List<SourceLineQuantityDemand> deliveryNoticeDemands(List<Map<String, Object>> lines) {
        return lines.stream()
            .map(line -> {
                var sourceDeliveryNoticeNo = line.get("sourceDeliveryNoticeNo");
                var sourceDeliveryLineNo = line.get("sourceDeliveryLineNo");
                if (sourceDeliveryNoticeNo == null || sourceDeliveryLineNo == null) {
                    throw new ResponseStatusException(HttpStatus.CONFLICT, "销售出库只能来自发货通知单");
                }
                return new SourceLineQuantityDemand(
                    String.valueOf(sourceDeliveryNoticeNo),
                    sourceDeliveryLineNo,
                    (BigDecimal) line.get("qty")
                );
            })
            .toList();
    }

    private void refreshSalesSourceStatuses(List<Map<String, Object>> lines) {
        lines.stream()
            .map(this::sourceOrderIdFromLine)
            .filter(id -> id != null && !id.isBlank())
            .distinct()
            .forEach(id -> conversionService.refreshSourceStatus(SALES_ORDER_OUT_SPEC, id));
    }

    private String sourceDeliveryNoticeId(SalesOutDraftRequest request) {
        var notices = request.lines().stream()
            .map(line -> line.sourceDeliveryNoticeNo() == null || line.sourceDeliveryNoticeNo().isBlank() ? line.sourceOrderNo() : line.sourceDeliveryNoticeNo())
            .filter(value -> value != null && !value.isBlank())
            .distinct()
            .toList();
        if (notices.isEmpty()) {
            throw new ResponseStatusException(HttpStatus.CONFLICT, "销售出库必须来自发货通知单");
        }
        if (notices.size() != 1) {
            return null;
        }
        var rows = jdbcTemplate.queryForList("SELECT id::text AS id FROM delivery_notice WHERE bill_no = ? AND status = ?", notices.get(0), BillStatus.AUDITED.name());
        if (rows.isEmpty()) {
            throw new ResponseStatusException(HttpStatus.CONFLICT, "销售出库来源发货通知单不存在或未审核");
        }
        return String.valueOf(rows.get(0).get("id"));
    }

    private String inheritedCurrency(SalesOutDraftRequest request) {
        var noticeBillNos = new LinkedHashSet<String>();
        request.lines().stream()
            .map(line -> line.sourceDeliveryNoticeNo() == null || line.sourceDeliveryNoticeNo().isBlank()
                ? line.sourceOrderNo()
                : line.sourceDeliveryNoticeNo())
            .filter(value -> value != null && !value.isBlank())
            .map(String::trim)
            .forEach(noticeBillNos::add);
        if (noticeBillNos.isEmpty()) {
            throw new ResponseStatusException(HttpStatus.CONFLICT, "销售出库必须来自已审核发货通知单");
        }
        var currencies = new LinkedHashSet<String>();
        for (var noticeBillNo : noticeBillNos) {
            var rows = jdbcTemplate.queryForList(
                "SELECT currency FROM delivery_notice WHERE bill_no = ? AND status = ?",
                noticeBillNo,
                BillStatus.AUDITED.name()
            );
            if (rows.isEmpty()) {
                throw new ResponseStatusException(HttpStatus.CONFLICT, "销售出库来源发货通知单不存在或未审核");
            }
            currencies.add(String.valueOf(rows.getFirst().get("currency")));
        }
        if (currencies.size() != 1) {
            throw new ResponseStatusException(HttpStatus.CONFLICT, "一张销售出库单不能混用不同币种的发货通知单");
        }
        var inherited = currencies.getFirst();
        if (request.currency() != null) {
            var requested = request.currency().trim().toUpperCase(Locale.ROOT);
            if (requested.isBlank() || (!"CNY".equals(requested) && !"USD".equals(requested))) {
                throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "币种只支持 CNY 或 USD");
            }
            if (!inherited.equals(requested)) {
                throw new ResponseStatusException(HttpStatus.CONFLICT, "销售出库币种必须继承直接来源发货通知单");
            }
        }
        return inherited;
    }

    private Map<String, Object> sourceFromDeliveryNotice(String billNo, Integer lineNo) {
        var rows = jdbcTemplate.queryForList("""
            SELECT dnl.source_order_no AS "sourceOrderNo",
                   dnl.source_line_no AS "sourceLineNo",
                   dnl.qty - COALESCE(out_qty.shipped_qty, 0) AS "remainingQty"
            FROM delivery_notice dn
            JOIN delivery_notice_line dnl ON dnl.bill_id = dn.id AND dnl.line_no = ?
            LEFT JOIN (
                SELECT source_delivery_notice_no, source_delivery_line_no, SUM(qty) AS shipped_qty
                FROM sales_out_line sol
                JOIN sales_out so ON so.id = sol.bill_id
                WHERE so.status = 'AUDITED'
                GROUP BY source_delivery_notice_no, source_delivery_line_no
            ) out_qty ON out_qty.source_delivery_notice_no = dn.bill_no AND out_qty.source_delivery_line_no = dnl.line_no
            WHERE dn.bill_no = ? AND dn.status = ?
            """, lineNo, billNo, BillStatus.AUDITED.name());
        if (rows.isEmpty()) {
            throw new ResponseStatusException(HttpStatus.CONFLICT, "销售出库来源发货通知单不存在或未审核");
        }
        return rows.get(0);
    }

    public record SalesOutLineRequest(String productId, String productCode, String warehouseCode, String sourceOrderNo, Integer sourceLineNo, String sourceDeliveryNoticeNo, Integer sourceDeliveryLineNo, BigDecimal qty, BigDecimal unitPrice, BigDecimal taxRate, String customerMaterialCode, String customerOrderNo, String lineRemark, String planDeliveryDate) {
    }

    public record RedReverseRequest(String redBillNo, String billDate, String ownerName) {
    }

    private LocalDate optionalDate(String value) {
        return value == null || value.isBlank() ? null : LocalDate.parse(value);
    }
}
