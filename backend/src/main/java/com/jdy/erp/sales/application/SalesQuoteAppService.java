package com.jdy.erp.sales.application;

import java.math.BigDecimal;
import java.time.LocalDate;
import java.util.List;
import java.util.Map;

import com.jdy.erp.shared.application.BillLifecycleService;
import com.jdy.erp.shared.application.BillLifecycleService.BillLifecycleTarget;
import com.jdy.erp.shared.application.LookupService;
import com.jdy.erp.shared.application.NumberingService;
import com.jdy.erp.shared.application.ProductSnapshotService;
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
public class SalesQuoteAppService {
    private static final String BILL_TABLE = "sales_quote";
    private static final BillLifecycleTarget LIFECYCLE_TARGET = new BillLifecycleTarget(BILL_TABLE, "sales_quote_line", "quote_id", "SALES", "sales_quote");

    private final JdbcTemplate jdbcTemplate;
    private final LookupService lookupService;
    private final ValidationService validationService;
    private final BillLifecycleService lifecycleService;
    private final NumberingService numberingService;
    private final CurrentSessionService currentSessionService;
    private final TaxAmountCalculator taxAmountCalculator;
    private final ProductSnapshotService productSnapshotService;

    public SalesQuoteAppService(
        JdbcTemplate jdbcTemplate,
        LookupService lookupService,
        ValidationService validationService,
        BillLifecycleService lifecycleService,
        NumberingService numberingService,
        CurrentSessionService currentSessionService,
        TaxAmountCalculator taxAmountCalculator,
        ProductSnapshotService productSnapshotService
    ) {
        this.jdbcTemplate = jdbcTemplate;
        this.lookupService = lookupService;
        this.validationService = validationService;
        this.lifecycleService = lifecycleService;
        this.numberingService = numberingService;
        this.currentSessionService = currentSessionService;
        this.taxAmountCalculator = taxAmountCalculator;
        this.productSnapshotService = productSnapshotService;
    }

    @Transactional
    public Map<String, Object> saveDraft(SalesQuoteDraftRequest request) {
        var billNo = numberingService.assignBillNo("salesQuote", request.billNo());
        var customerId = lookupService.lookupEnabledId("md_customer", request.customerCode(), "客户");
        var validUntil = LocalDate.parse(validationService.required(request.validUntil(), "报价有效期"));
        var totalAmount = request.lines().stream()
            .map(line -> taxAmountCalculator.calculate(line.qty(), line.unitPrice(), line.taxRate()).priceTaxTotal())
            .reduce(BigDecimal.ZERO, BigDecimal::add);
        var ownerName = currentSessionService.currentDisplayName();
        var createdBy = currentSessionService.currentUserId();
        var quote = jdbcTemplate.queryForMap("""
            INSERT INTO sales_quote (bill_no, customer_id, bill_date, valid_until, department, status, enabled, total_amount, owner_name, remark, created_by)
            VALUES (?, ?::uuid, ?, ?, ?, ?, TRUE, ?, ?, ?, ?::uuid)
            ON CONFLICT (bill_no) DO UPDATE
            SET customer_id = EXCLUDED.customer_id,
                bill_date = EXCLUDED.bill_date,
                valid_until = EXCLUDED.valid_until,
                department = EXCLUDED.department,
                status = EXCLUDED.status,
                total_amount = EXCLUDED.total_amount,
                owner_name = EXCLUDED.owner_name,
                remark = EXCLUDED.remark,
                updated_at = now(),
                version = sales_quote.version + 1
            RETURNING id::text AS id, bill_no AS "billNo", total_amount AS "totalAmount"
            """,
            billNo,
            customerId,
            LocalDate.parse(validationService.required(request.billDate(), "业务日期")),
            validUntil,
            request.department(),
            BillStatus.DRAFT.name(),
            totalAmount,
            ownerName,
            validationService.optionalText(request.remark()),
            createdBy
        );
        var quoteId = quote.get("id");
        jdbcTemplate.update("DELETE FROM sales_quote_line WHERE quote_id = ?::uuid", quoteId);
        var lineNo = 1;
        for (var line : request.lines()) {
            var product = productSnapshotService.resolve(line.productId(), line.productCode(), "商品");
            var warehouseId = optionalWarehouseId(line.warehouseCode());
            var amounts = taxAmountCalculator.calculate(line.qty(), line.unitPrice(), line.taxRate());
            jdbcTemplate.update("""
                INSERT INTO sales_quote_line (quote_id, line_no, product_id, product_code_snapshot, product_name_snapshot, product_spec_snapshot, warehouse_id, qty, unit_price, amount, tax_rate, tax_amount, price_tax_total, customer_material_code, customer_order_no, line_remark, plan_delivery_date)
                VALUES (?::uuid, ?, ?::uuid, ?, ?, ?, ?::uuid, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                quoteId,
                lineNo,
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
        return quote;
    }

    public Map<String, Object> audit(String billNo) {
        return lifecycleService.transition(
            BILL_TABLE,
            billNo,
            BillStatus.DRAFT,
            BillStatus.AUDITED,
            "id::text AS id, bill_no AS \"billNo\", status",
            "SALES",
            "AUDIT",
            "sales_quote",
            "销售报价单不存在或状态不允许操作"
        );
    }

    public Map<String, Object> reverse(String billNo) {
        return lifecycleService.transition(
            BILL_TABLE,
            billNo,
            BillStatus.AUDITED,
            BillStatus.DRAFT,
            "id::text AS id, bill_no AS \"billNo\", status",
            "SALES",
            "REVERSE",
            "sales_quote",
            "销售报价单不存在或不能反审核"
        );
    }

    public Map<String, Object> delete(String billNo) {
        return lifecycleService.deleteDraft(LIFECYCLE_TARGET, billNo, "只有草稿销售报价单可以删除");
    }

    public Map<String, Object> setValid(String billNo, boolean valid) {
        if (valid) {
            var expired = jdbcTemplate.queryForObject("""
                SELECT COUNT(*)
                FROM sales_quote
                WHERE bill_no = ?
                  AND status = ?
                  AND valid_until < CURRENT_DATE
                """, Integer.class, billNo, BillStatus.AUDITED.name());
            if (expired != null && expired > 0) {
                throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "报价已超过有效期，需先延长有效期后重新保存");
            }
        }
        var rows = jdbcTemplate.queryForList("""
            UPDATE sales_quote
            SET enabled = ?, updated_at = now(), version = version + 1
            WHERE bill_no = ?
              AND status = ?
            RETURNING id::text AS id, bill_no AS "billNo", enabled
            """, valid, billNo, BillStatus.AUDITED.name());
        if (rows.isEmpty()) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "只有已审核销售报价单可以设为有效或失效");
        }
        return Map.of("action", valid ? "VALID" : "INVALID", "document", rows.get(0));
    }

    public Map<String, Object> detail(String billNo) {
        var rows = jdbcTemplate.queryForList("""
            SELECT sq.id::text AS id,
                   sq.bill_no AS "billNo",
                   c.code AS "customerCode",
                   c.name AS customer,
                   to_char(sq.bill_date, 'YYYY-MM-DD') AS "billDate",
                   to_char(sq.valid_until, 'YYYY-MM-DD') AS "validUntil",
                   sq.department,
                   sq.status,
                   sq.enabled,
                   sq.total_amount AS "totalAmount",
                   sq.owner_name AS "ownerName",
                   COALESCE(creator.display_name, sq.owner_name, '') AS "createdByName",
                   COALESCE(sq.remark, '') AS remark
            FROM sales_quote sq
            JOIN md_customer c ON c.id = sq.customer_id
            LEFT JOIN public.sys_user creator ON creator.id = sq.created_by
            WHERE sq.bill_no = ?
            """, billNo);
        if (rows.isEmpty()) {
            throw new ResponseStatusException(HttpStatus.NOT_FOUND, "销售报价单不存在");
        }
        var lines = detailLines(billNo);
        return Map.of("action", "DETAIL", "document", rows.get(0), "lines", lines);
    }

    public Map<String, Object> selectableLines(String customerCode) {
        var rows = jdbcTemplate.queryForList("""
            SELECT sq.bill_no AS "billNo",
                   c.code AS "customerCode",
                   c.name AS customer,
                   to_char(sq.bill_date, 'YYYY-MM-DD') AS "billDate",
                   to_char(sq.valid_until, 'YYYY-MM-DD') AS "validUntil",
                   sq.department,
                   sq.owner_name AS "ownerName",
                   l.line_no AS "lineNo",
                   l.product_id::text AS "productId",
                   COALESCE(l.product_code_snapshot, p.code) AS "productCode",
                   COALESCE(l.product_name_snapshot, p.name) AS "productName",
                   COALESCE(l.product_spec_snapshot, p.spec, '') AS spec,
                   COALESCE(l.product_unit_snapshot, p.unit, '') AS unit,
                   trim(to_char(COALESCE(l.net_weight_snapshot, p.net_weight), 'FM9999999990.00')) AS "netWeight",
                   trim(to_char(COALESCE(l.gross_weight_snapshot, p.gross_weight), 'FM9999999990.00')) AS "grossWeight",
                   COALESCE(w.code, 'CK-001') AS "warehouseCode",
                   l.qty AS "sourceQty",
                   l.unit_price AS "unitPrice",
                   round(l.unit_price * (1 + COALESCE(l.tax_rate, 0) / 100), 2) AS "taxInclusiveUnitPrice",
                   l.tax_rate AS "taxRate",
                   l.tax_amount AS "taxAmount",
                   l.price_tax_total AS "priceTaxTotal",
                   COALESCE(l.customer_material_code, '') AS "customerMaterialCode",
                   COALESCE(l.customer_order_no, '') AS "customerOrderNo",
                   COALESCE(l.line_remark, '') AS "lineRemark",
                   to_char(l.plan_delivery_date, 'YYYY-MM-DD') AS "planDeliveryDate"
            FROM sales_quote sq
            JOIN md_customer c ON c.id = sq.customer_id
            JOIN sales_quote_line l ON l.quote_id = sq.id
            JOIN md_product p ON p.id = l.product_id
            LEFT JOIN md_warehouse w ON w.id = l.warehouse_id
            WHERE c.code = ?
              AND sq.status = ?
              AND sq.enabled = TRUE
              AND sq.valid_until >= CURRENT_DATE
              AND NOT EXISTS (
                  SELECT 1
                  FROM sales_order_line sol
                  JOIN sales_order so ON so.id = sol.order_id
                  WHERE sol.source_order_no = sq.bill_no
                    AND sol.source_line_no = l.line_no
                    AND so.status <> 'VOID'
              )
            ORDER BY sq.bill_date DESC, sq.updated_at DESC, sq.bill_no DESC, l.line_no
            """, customerCode == null ? "" : customerCode.trim(), BillStatus.AUDITED.name());
        return Map.of("customerCode", customerCode == null ? "" : customerCode.trim(), "lines", rows);
    }

    private List<Map<String, Object>> detailLines(String billNo) {
        return jdbcTemplate.queryForList("""
            SELECT l.line_no AS "lineNo",
                   l.product_id::text AS "productId",
                   COALESCE(l.product_code_snapshot, p.code) AS "productCode",
                   COALESCE(l.product_name_snapshot, p.name) AS "productName",
                   COALESCE(l.product_spec_snapshot, p.spec, '') AS spec,
                   COALESCE(l.product_unit_snapshot, p.unit, '') AS unit,
                   trim(to_char(COALESCE(l.net_weight_snapshot, p.net_weight), 'FM9999999990.00')) AS "netWeight",
                   trim(to_char(COALESCE(l.gross_weight_snapshot, p.gross_weight), 'FM9999999990.00')) AS "grossWeight",
                   COALESCE(w.code, 'CK-001') AS "warehouseCode",
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
                   to_char(l.plan_delivery_date, 'YYYY-MM-DD') AS "planDeliveryDate"
            FROM sales_quote_line l
            JOIN sales_quote sq ON sq.id = l.quote_id
            JOIN md_product p ON p.id = l.product_id
            LEFT JOIN md_warehouse w ON w.id = l.warehouse_id
            WHERE sq.bill_no = ?
            ORDER BY l.line_no
            """, billNo);
    }

    private String optionalWarehouseId(String warehouseCode) {
        var code = validationService.optionalText(warehouseCode);
        if (code == null) {
            return null;
        }
        return lookupService.lookupEnabledId("md_warehouse", code, "仓库");
    }

    private LocalDate optionalDate(String dateText) {
        var normalized = validationService.optionalText(dateText);
        return normalized == null ? null : LocalDate.parse(normalized);
    }

    public record SalesQuoteDraftRequest(
        String billNo,
        String customerCode,
        String billDate,
        String department,
        String ownerName,
        String remark,
        String validUntil,
        List<SalesQuoteLineRequest> lines
    ) {
        public SalesQuoteDraftRequest {
            if (lines == null || lines.isEmpty()) {
                throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "至少需要一条报价明细");
            }
        }
    }

    public record SalesQuoteLineRequest(
        String productId,
        String productCode,
        String warehouseCode,
        BigDecimal qty,
        BigDecimal unitPrice,
        BigDecimal taxRate,
        String customerMaterialCode,
        String customerOrderNo,
        String lineRemark,
        String planDeliveryDate
    ) {
    }
}
