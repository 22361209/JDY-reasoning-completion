package com.jdy.erp.sales.application;

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
        TaxAmountCalculator taxAmountCalculator
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
    }

    public Map<String, Object> detail(String billNo) {
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
                   so.is_tax_inclusive AS "isTaxInclusive",
                   so.owner_name AS "ownerName",
                   COALESCE(creator.display_name, so.owner_name, '') AS "createdByName",
                   COALESCE(so.remark, '') AS remark,
                   (
                       SELECT red.bill_no
                       FROM sales_out red
                       WHERE red.red_source_bill_id = so.id
                         AND red.status = ?
                       LIMIT 1
                   ) AS "redReverseBillNo",
                   (
                       SELECT original.bill_no
                       FROM sales_out original
                       WHERE original.id = so.red_source_bill_id
                         AND so.status = ?
                       LIMIT 1
                   ) AS "redSourceBillNo"
            FROM sales_out so
            JOIN md_customer c ON c.id = so.customer_id
            LEFT JOIN sys_user creator ON creator.id = so.created_by
            LEFT JOIN sales_order src ON src.id = so.source_order_id
            WHERE so.bill_no = ?
            """, BillStatus.RED_REVERSED.name(), BillStatus.RED_REVERSED.name(), billNo);
        if (billRows.isEmpty()) {
            throw new ResponseStatusException(HttpStatus.NOT_FOUND, "销售出库单不存在");
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
                   l.tax_rate AS "taxRate",
                   l.tax_amount AS "taxAmount",
                   l.price_tax_total AS "priceTaxTotal",
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
        var billNo = numberingService.assignBillNo("salesOut", request.billNo());
        var customerId = lookupService.lookupEnabledId("md_customer", request.customerCode(), "客户");
        var sourceOrderId = sourceOrderId(request.sourceOrderNo());
        var isTaxInclusive = Boolean.TRUE.equals(request.isTaxInclusive());
        var totalAmount = request.lines().stream()
            .map(line -> taxAmountCalculator.calculate(line.qty(), line.unitPrice(), line.taxRate(), isTaxInclusive).priceTaxTotal())
            .reduce(BigDecimal.ZERO, BigDecimal::add);
        var ownerName = currentSessionService.currentDisplayName();
        var createdBy = currentSessionService.currentUserId();
        var bill = jdbcTemplate.queryForMap("""
            INSERT INTO sales_out (bill_no, source_order_id, customer_id, bill_date, department, status, total_amount, is_tax_inclusive, owner_name, remark, created_by)
            VALUES (?, ?::uuid, ?::uuid, ?, ?, ?, ?, ?, ?, ?, ?::uuid)
            ON CONFLICT (bill_no) DO UPDATE
            SET source_order_id = EXCLUDED.source_order_id,
                customer_id = EXCLUDED.customer_id,
                bill_date = EXCLUDED.bill_date,
                department = EXCLUDED.department,
                status = EXCLUDED.status,
                total_amount = EXCLUDED.total_amount,
                is_tax_inclusive = EXCLUDED.is_tax_inclusive,
                owner_name = EXCLUDED.owner_name,
                remark = EXCLUDED.remark,
                updated_at = now(),
                version = sales_out.version + 1
            RETURNING id::text AS id, bill_no AS "billNo", total_amount AS "totalAmount"
            """,
            billNo,
            sourceOrderId,
            customerId,
            LocalDate.parse(validationService.required(request.billDate(), "业务日期")),
            request.department(),
            BillStatus.DRAFT.name(),
            totalAmount,
            isTaxInclusive,
            ownerName,
            validationService.optionalText(request.remark()),
            createdBy
        );
        var billId = bill.get("id");
        jdbcTemplate.update("DELETE FROM sales_out_line WHERE bill_id = ?::uuid", billId);
        insertLines(billId, request.lines(), isTaxInclusive);
        return bill;
    }

    @Transactional
    public Map<String, Object> audit(String billNo) {
        var row = lifecycleService.transition(
            BILL_TABLE,
            billNo,
            BillStatus.DRAFT,
            BillStatus.AUDITED,
            "id::text AS id, bill_no AS \"billNo\", source_order_id::text AS \"sourceOrderId\", customer_id::text AS \"customerId\", bill_date AS \"billDate\", total_amount AS \"totalAmount\", status",
            "SALES",
            "AUDIT",
            "sales_out",
            "销售出库单不存在或已审核"
        );
        var sourceOrderId = row.get("sourceOrderId");
        var lines = postingLines(billNo);
        if (sourceOrderId != null) {
            for (var line : lines) {
                conversionService.increaseExecutedQuantity(
                    SALES_ORDER_OUT_SPEC,
                    String.valueOf(sourceOrderId),
                    line.get("sourceLineNo"),
                    (BigDecimal) line.get("qty")
                );
            }
            conversionService.refreshSourceStatus(SALES_ORDER_OUT_SPEC, String.valueOf(sourceOrderId));
        }
        for (var line : lines) {
            postingPipeline.post(new PostingContext(
                InventoryPostingHook.CHANNEL,
                String.valueOf(line.get("productCode")),
                String.valueOf(line.get("warehouseCode")),
                ((BigDecimal) line.get("qty")).negate(),
                "SALES_OUT",
                "SALES_OUT:" + billNo
            ));
        }
        postingPipeline.post(financeContext(row, "SALES_OUT"));
        return row;
    }

    @Transactional
    public Map<String, Object> reverse(String billNo) {
        var row = lifecycleService.transition(
            BILL_TABLE,
            billNo,
            BillStatus.AUDITED,
            BillStatus.DRAFT,
            "id::text AS id, bill_no AS \"billNo\", source_order_id::text AS \"sourceOrderId\", customer_id::text AS \"customerId\", bill_date AS \"billDate\", total_amount AS \"totalAmount\", status",
            "SALES",
            "REVERSE",
            "sales_out",
            "销售出库单不存在或不能反审核"
        );
        var sourceOrderId = row.get("sourceOrderId");
        var lines = postingLines(billNo);
        for (var line : lines) {
            postingPipeline.post(new PostingContext(
                InventoryPostingHook.CHANNEL,
                String.valueOf(line.get("productCode")),
                String.valueOf(line.get("warehouseCode")),
                (BigDecimal) line.get("qty"),
                "SALES_OUT_REVERSE",
                "SALES_OUT_REVERSE:" + billNo
            ));
        }
        if (sourceOrderId != null) {
            for (var line : lines) {
                conversionService.decreaseExecutedQuantity(
                    SALES_ORDER_OUT_SPEC,
                    String.valueOf(sourceOrderId),
                    line.get("sourceLineNo"),
                    (BigDecimal) line.get("qty")
                );
            }
            conversionService.refreshSourceStatus(SALES_ORDER_OUT_SPEC, String.valueOf(sourceOrderId));
        }
        postingPipeline.post(financeContext(row, "SALES_OUT_REVERSE"));
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
            "SALES",
            "VOID",
            "sales_out",
            "只有草稿销售出库单可以作废"
        );
    }

    @Transactional
    public Map<String, Object> redReverse(String billNo, RedReverseRequest request) {
        var sourceRows = jdbcTemplate.queryForList("""
            SELECT id::text AS id,
                   source_order_id::text AS "sourceOrderId",
                   customer_id::text AS "customerId",
                   department,
                   total_amount,
                   is_tax_inclusive,
                   owner_name AS "ownerName"
            FROM sales_out
            WHERE bill_no = ? AND status = ?
            """, billNo, BillStatus.AUDITED.name());
        if (sourceRows.isEmpty()) {
            throw new ResponseStatusException(HttpStatus.CONFLICT, "只有已审核销售出库单可以红冲");
        }
        var redBillNo = validationService.required(request.redBillNo(), "红冲单号");
        if (!jdbcTemplate.queryForList("SELECT 1 FROM sales_out WHERE bill_no = ?", redBillNo).isEmpty()) {
            throw new ResponseStatusException(HttpStatus.CONFLICT, "红冲单号已存在");
        }
        var source = sourceRows.get(0);
        var redBill = jdbcTemplate.queryForMap("""
            INSERT INTO sales_out (bill_no, source_order_id, red_source_bill_id, customer_id, bill_date, department, status, total_amount, is_tax_inclusive, owner_name)
            VALUES (?, ?::uuid, ?::uuid, ?::uuid, ?, ?, ?, ?, ?, ?)
            RETURNING id::text AS id, bill_no AS "billNo", status, total_amount AS "totalAmount"
            """,
            redBillNo,
            source.get("sourceOrderId"),
            source.get("id"),
            source.get("customerId"),
            LocalDate.parse(validationService.required(request.billDate(), "红冲日期")),
            source.get("department"),
            BillStatus.RED_REVERSED.name(),
            ((BigDecimal) source.get("total_amount")).negate(),
            source.get("is_tax_inclusive"),
            request.ownerName() == null || request.ownerName().isBlank() ? source.get("ownerName") : request.ownerName().trim()
        );
        var lines = redSourceLines(billNo);
        for (var line : lines) {
            var qty = (BigDecimal) line.get("qty");
            jdbcTemplate.update("""
                INSERT INTO sales_out_line (bill_id, line_no, source_line_no, product_id, warehouse_id, qty, unit_price, amount, tax_rate, tax_amount, price_tax_total, line_remark, plan_delivery_date)
                VALUES (?::uuid, ?, ?, ?::uuid, ?::uuid, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                redBill.get("id"),
                line.get("lineNo"),
                line.get("sourceLineNo"),
                line.get("productId"),
                line.get("warehouseId"),
                qty.negate(),
                line.get("unitPrice"),
                ((BigDecimal) line.get("amount")).negate(),
                line.get("taxRate"),
                ((BigDecimal) line.get("taxAmount")).negate(),
                ((BigDecimal) line.get("priceTaxTotal")).negate(),
                line.get("lineRemark"),
                line.get("planDeliveryDate")
            );
            postingPipeline.post(new PostingContext(
                InventoryPostingHook.CHANNEL,
                String.valueOf(line.get("productCode")),
                String.valueOf(line.get("warehouseCode")),
                qty,
                "SALES_OUT_RED",
                "SALES_OUT_RED:" + redBillNo
            ));
            if (source.get("sourceOrderId") != null) {
                conversionService.decreaseExecutedQuantity(
                    SALES_ORDER_OUT_SPEC,
                    String.valueOf(source.get("sourceOrderId")),
                    line.get("sourceLineNo"),
                    qty
                );
            }
        }
        if (source.get("sourceOrderId") != null) {
            conversionService.refreshSourceStatus(SALES_ORDER_OUT_SPEC, String.valueOf(source.get("sourceOrderId")));
        }
        postingPipeline.post(new PostingContext(
            FinancePosting.CHANNEL,
            null,
            null,
            null,
            "SALES_OUT_RED",
            "SALES_OUT_RED:" + redBillNo,
            redBillNo,
            String.valueOf(source.get("customerId")),
            LocalDate.parse(validationService.required(request.billDate(), "红冲日期")),
            (BigDecimal) redBill.get("totalAmount")
        ));
        operationLogService.log("SALES", "RED_REVERSE", "sales_out", String.valueOf(redBill.get("id")), true, null);
        return redBill;
    }

    private void insertLines(Object billId, List<SalesOutLineRequest> lines, boolean isTaxInclusive) {
        var lineNo = 1;
        for (var line : lines) {
            var productId = lookupService.lookupEnabledId("md_product", line.productCode(), "商品");
            var warehouseId = lookupService.lookupEnabledId("md_warehouse", line.warehouseCode(), "仓库");
            var amounts = taxAmountCalculator.calculate(line.qty(), line.unitPrice(), line.taxRate(), isTaxInclusive);
            jdbcTemplate.update("""
                INSERT INTO sales_out_line (bill_id, line_no, source_line_no, product_id, warehouse_id, qty, unit_price, amount, tax_rate, tax_amount, price_tax_total, line_remark, plan_delivery_date)
                VALUES (?::uuid, ?, ?, ?::uuid, ?::uuid, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                billId,
                lineNo,
                line.sourceLineNo() == null ? lineNo : line.sourceLineNo(),
                productId,
                warehouseId,
                line.qty(),
                line.unitPrice(),
                amounts.amount(),
                amounts.taxRate(),
                amounts.taxAmount(),
                amounts.priceTaxTotal(),
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
            SELECT l.line_no AS "lineNo", COALESCE(l.source_line_no, l.line_no) AS "sourceLineNo", p.code AS "productCode", w.code AS "warehouseCode", l.qty
            FROM sales_out_line l
            JOIN md_product p ON p.id = l.product_id
            JOIN md_warehouse w ON w.id = l.warehouse_id
            JOIN sales_out so ON so.id = l.bill_id
            WHERE so.bill_no = ?
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
            String.valueOf(row.get("customerId")),
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

    private List<Map<String, Object>> redSourceLines(String billNo) {
        return jdbcTemplate.queryForList("""
            SELECT l.line_no AS "lineNo",
                   COALESCE(l.source_line_no, l.line_no) AS "sourceLineNo",
                   p.code AS "productCode",
                   w.code AS "warehouseCode",
                   l.product_id::text AS "productId",
                   l.warehouse_id::text AS "warehouseId",
                   l.qty,
                   l.unit_price AS "unitPrice",
                   l.amount,
                   l.tax_rate AS "taxRate",
                   l.tax_amount AS "taxAmount",
                   l.price_tax_total AS "priceTaxTotal",
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

    public record SalesOutDraftRequest(String billNo, String sourceOrderNo, String customerCode, String billDate, String department, String ownerName, String remark, Boolean isTaxInclusive, List<SalesOutLineRequest> lines) {
        public SalesOutDraftRequest {
            if (lines == null || lines.isEmpty()) {
                throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "至少需要一条分录");
            }
        }
    }

    public record SalesOutLineRequest(String productCode, String warehouseCode, Integer sourceLineNo, BigDecimal qty, BigDecimal unitPrice, BigDecimal taxRate, String lineRemark, String planDeliveryDate) {
    }

    public record RedReverseRequest(String redBillNo, String billDate, String ownerName) {
    }

    private LocalDate optionalDate(String value) {
        return value == null || value.isBlank() ? null : LocalDate.parse(value);
    }
}
