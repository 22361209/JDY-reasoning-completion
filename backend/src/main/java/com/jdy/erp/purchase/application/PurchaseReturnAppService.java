package com.jdy.erp.purchase.application;

import java.math.BigDecimal;
import java.time.LocalDate;
import java.util.List;
import java.util.Map;

import com.jdy.erp.shared.application.BillLifecycleService;
import com.jdy.erp.shared.application.BillLifecycleService.BillLifecycleTarget;
import com.jdy.erp.shared.application.BillLifecycleService.VoidRequest;
import com.jdy.erp.shared.application.BillLifecycleService.SourceLineQuantityDemand;
import com.jdy.erp.shared.application.BillLifecycleService.SourceLineQuantityGuard;
import com.jdy.erp.shared.application.ConversionService.SourceExecutionSpec;
import com.jdy.erp.shared.application.FinancePosting;
import com.jdy.erp.shared.application.InventoryPostingHook;
import com.jdy.erp.shared.application.LookupService;
import com.jdy.erp.shared.application.NumberingService;
import com.jdy.erp.shared.application.OperationLogService;
import com.jdy.erp.shared.application.PostingContext;
import com.jdy.erp.shared.application.PostingPipeline;
import com.jdy.erp.shared.application.ProductSnapshotService;
import com.jdy.erp.shared.application.TaxAmountCalculator;
import com.jdy.erp.shared.application.ValidationService;
import com.jdy.erp.shared.domain.BillStatus;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.server.ResponseStatusException;

@Service
public class PurchaseReturnAppService {
    private static final String BILL_TABLE = "purchase_return";
    private static final BillLifecycleTarget LIFECYCLE_TARGET = new BillLifecycleTarget(BILL_TABLE, "purchase_return_line", "bill_id", "PURCHASE", "purchase_return");
    private static final SourceExecutionSpec PURCHASE_IN_RETURN_SPEC = new SourceExecutionSpec(
        "purchase_in",
        "purchase_in_line",
        "bill_id",
        "line_no",
        "qty",
        "qty",
        "in_status",
        "采购退货数量不能超过源采购入库剩余可退数量"
    );
    private static final SourceLineQuantityGuard PURCHASE_IN_RETURN_QUANTITY_GUARD = new SourceLineQuantityGuard(
        PURCHASE_IN_RETURN_SPEC,
        "purchase_return",
        "purchase_return_line",
        "bill_id",
        "source_in_no",
        "source_line_no",
        "qty",
        "采购退货源入库明细不存在或未审核",
        "采购退货数量不能超过源采购入库剩余可退数量"
    );

    private final JdbcTemplate jdbcTemplate;
    private final LookupService lookupService;
    private final ValidationService validationService;
    private final BillLifecycleService lifecycleService;
    private final PostingPipeline postingPipeline;
    private final OperationLogService operationLogService;
    private final NumberingService numberingService;
    private final TaxAmountCalculator taxAmountCalculator;
    private final ProductSnapshotService productSnapshotService;

    public PurchaseReturnAppService(
        JdbcTemplate jdbcTemplate,
        LookupService lookupService,
        ValidationService validationService,
        BillLifecycleService lifecycleService,
        PostingPipeline postingPipeline,
        OperationLogService operationLogService,
        NumberingService numberingService,
        TaxAmountCalculator taxAmountCalculator,
        ProductSnapshotService productSnapshotService
    ) {
        this.jdbcTemplate = jdbcTemplate;
        this.lookupService = lookupService;
        this.validationService = validationService;
        this.lifecycleService = lifecycleService;
        this.postingPipeline = postingPipeline;
        this.operationLogService = operationLogService;
        this.numberingService = numberingService;
        this.taxAmountCalculator = taxAmountCalculator;
        this.productSnapshotService = productSnapshotService;
    }

    public Map<String, Object> detail(String billNo) {
        var billRows = jdbcTemplate.queryForList("""
            SELECT pr.id::text AS id,
                   pr.bill_no AS "billNo",
                   s.code AS "supplierCode",
                   s.name AS supplier,
                   to_char(pr.bill_date, 'YYYY-MM-DD') AS "billDate",
                   pr.department,
                   pr.status,
                   pr.close_status AS "closeStatus",
                   pr.frozen_status AS "frozenStatus",
                   pr.total_amount AS "totalAmount",
                   pr.owner_name AS "ownerName",
                   COALESCE(pr.remark, '') AS remark
            FROM purchase_return pr
            JOIN md_supplier s ON s.id = pr.supplier_id
            WHERE pr.bill_no = ?
            """, billNo);
        if (billRows.isEmpty()) {
            throw new ResponseStatusException(HttpStatus.NOT_FOUND, "采购退货单不存在");
        }
        var lines = jdbcTemplate.queryForList("""
            SELECT l.line_no AS "lineNo",
                   l.source_in_no AS "sourceOrderNo",
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
                   l.line_close_status AS "lineCloseStatus",
                   l.line_frozen_status AS "lineFrozenStatus",
                   l.unit_price AS "unitPrice",
                   round(l.unit_price * (1 + COALESCE(l.tax_rate, 0) / 100), 2) AS "taxInclusiveUnitPrice",
                   l.amount,
                   l.tax_rate AS "taxRate",
                   l.tax_amount AS "taxAmount",
                   l.price_tax_total AS "priceTaxTotal",
                   COALESCE(l.line_remark, '') AS "lineRemark"
            FROM purchase_return_line l
            JOIN md_product p ON p.id = l.product_id
            JOIN md_warehouse w ON w.id = l.warehouse_id
            JOIN purchase_return pr ON pr.id = l.bill_id
            WHERE pr.bill_no = ?
            ORDER BY l.line_no
            """, billNo);
        return Map.of("action", "DETAIL", "document", billRows.get(0), "lines", lines);
    }

    public Map<String, Object> selectableLines(String supplierCode) {
        var rows = jdbcTemplate.queryForList("""
            SELECT pi.bill_no AS "billNo",
                   s.code AS "supplierCode",
                   s.name AS supplier,
                   to_char(pi.bill_date, 'YYYY-MM-DD') AS "billDate",
                   pi.department,
                   pi.owner_name AS "ownerName",
                   l.line_no AS "lineNo",
                   l.product_id::text AS "productId",
                   COALESCE(l.product_code_snapshot, p.code) AS "productCode",
                   COALESCE(l.product_name_snapshot, p.name) AS "productName",
                   COALESCE(l.product_spec_snapshot, p.spec, '') AS spec,
                   COALESCE(l.product_unit_snapshot, p.unit, '') AS unit,
                   trim(to_char(COALESCE(l.net_weight_snapshot, p.net_weight), 'FM9999999990.00')) AS "netWeight",
                   trim(to_char(COALESCE(l.gross_weight_snapshot, p.gross_weight), 'FM9999999990.00')) AS "grossWeight",
                   w.code AS "warehouseCode",
                   l.qty AS "sourceQty",
                   COALESCE(returned.returned_qty, 0) AS "returnedQty",
                   GREATEST(0, l.qty - COALESCE(returned.returned_qty, 0)) AS "remainingQty",
                   l.unit_price AS "unitPrice",
                   round(l.unit_price * (1 + COALESCE(l.tax_rate, 0) / 100), 2) AS "taxInclusiveUnitPrice",
                   l.tax_rate AS "taxRate",
                   l.tax_amount AS "taxAmount",
                   l.price_tax_total AS "priceTaxTotal",
                   COALESCE(l.line_remark, '') AS "lineRemark"
            FROM purchase_in pi
            JOIN md_supplier s ON s.id = pi.supplier_id
            JOIN purchase_in_line l ON l.bill_id = pi.id
            JOIN md_product p ON p.id = l.product_id
            JOIN md_warehouse w ON w.id = l.warehouse_id
            LEFT JOIN (
                SELECT source_in_no, source_line_no, SUM(qty) AS returned_qty
                FROM purchase_return_line prl
                JOIN purchase_return pr ON pr.id = prl.bill_id
                WHERE pr.status = 'AUDITED'
                GROUP BY source_in_no, source_line_no
            ) returned ON returned.source_in_no = pi.bill_no AND returned.source_line_no = l.line_no
            WHERE s.code = ?
              AND pi.status = ?
              AND GREATEST(0, l.qty - COALESCE(returned.returned_qty, 0)) > 0
            ORDER BY pi.bill_date DESC, pi.bill_no DESC, l.line_no
            """, supplierCode == null ? "" : supplierCode.trim(), BillStatus.AUDITED.name());
        return Map.of("supplierCode", supplierCode == null ? "" : supplierCode.trim(), "lines", rows);
    }

    @Transactional
    public Map<String, Object> saveDraft(PurchaseReturnDraftRequest request) {
        var billNo = numberingService.assignBillNo("purchaseReturn", request.billNo());
        var supplierId = lookupService.lookupEnabledId("md_supplier", request.supplierCode(), "供应商");
        var totalAmount = request.lines().stream()
            .map(line -> taxAmountCalculator.calculate(line.qty(), line.unitPrice(), line.taxRate()).priceTaxTotal())
            .reduce(BigDecimal.ZERO, BigDecimal::add);
        var bill = jdbcTemplate.queryForMap("""
            INSERT INTO purchase_return (bill_no, supplier_id, bill_date, department, status, total_amount, owner_name, remark)
            VALUES (?, ?::uuid, ?, ?, ?, ?, ?, ?)
            ON CONFLICT (bill_no) DO UPDATE
            SET supplier_id = EXCLUDED.supplier_id,
                bill_date = EXCLUDED.bill_date,
                department = EXCLUDED.department,
                status = EXCLUDED.status,
                total_amount = EXCLUDED.total_amount,
                owner_name = EXCLUDED.owner_name,
                remark = EXCLUDED.remark,
                close_status = 'OPEN',
                frozen_status = 'NORMAL',
                updated_at = now(),
                version = purchase_return.version + 1
            RETURNING id::text AS id, bill_no AS "billNo", total_amount AS "totalAmount"
            """,
            billNo,
            supplierId,
            LocalDate.parse(validationService.required(request.billDate(), "业务日期")),
            request.department(),
            BillStatus.DRAFT.name(),
            totalAmount,
            request.ownerName(),
            validationService.optionalText(request.remark())
        );
        var billId = bill.get("id");
        jdbcTemplate.update("DELETE FROM purchase_return_line WHERE bill_id = ?::uuid", billId);
        insertLines(billId, request.lines());
        return bill;
    }

    @Transactional
    public Map<String, Object> audit(String billNo) {
        var lines = postingLines(billNo);
        lifecycleService.guardSourceLineQuantities(PURCHASE_IN_RETURN_QUANTITY_GUARD, sourceLineDemands(lines), billNo);
        var row = lifecycleService.transition(
            BILL_TABLE,
            billNo,
            BillStatus.DRAFT,
            BillStatus.AUDITED,
            "id::text AS id, bill_no AS \"billNo\", supplier_id::text AS \"supplierId\", bill_date AS \"billDate\", total_amount AS \"totalAmount\", status",
            "PURCHASE",
            "AUDIT",
            "purchase_return",
            "采购退货单不存在或已审核"
        );
        for (var line : lines) {
            postingPipeline.post(new PostingContext(
                InventoryPostingHook.CHANNEL,
                String.valueOf(line.get("productCode")),
                String.valueOf(line.get("warehouseCode")),
                ((BigDecimal) line.get("qty")).negate(),
                "PURCHASE_RETURN",
                "PURCHASE_RETURN:" + billNo
            ));
        }
        postingPipeline.post(financeContext(row, "PURCHASE_RETURN", ((BigDecimal) row.get("totalAmount")).negate()));
        operationLogService.log("PURCHASE", "AUDIT", "purchase_return", String.valueOf(row.get("id")), true, null);
        return row;
    }

    @Transactional
    public Map<String, Object> reverse(String billNo) {
        var row = lifecycleService.transition(
            BILL_TABLE,
            billNo,
            BillStatus.AUDITED,
            BillStatus.DRAFT,
            "id::text AS id, bill_no AS \"billNo\", supplier_id::text AS \"supplierId\", bill_date AS \"billDate\", total_amount AS \"totalAmount\", status",
            "PURCHASE",
            "REVERSE",
            "purchase_return",
            "采购退货单不存在或不能反审核"
        );
        for (var line : postingLines(billNo)) {
            postingPipeline.post(new PostingContext(
                InventoryPostingHook.CHANNEL,
                String.valueOf(line.get("productCode")),
                String.valueOf(line.get("warehouseCode")),
                (BigDecimal) line.get("qty"),
                "PURCHASE_RETURN_REVERSE",
                "PURCHASE_RETURN_REVERSE:" + billNo
            ));
        }
        postingPipeline.post(financeContext(row, "PURCHASE_RETURN_REVERSE", (BigDecimal) row.get("totalAmount")));
        return row;
    }

    @Transactional
    public Map<String, Object> voidBill(String billNo, VoidRequest request) {
        return lifecycleService.voidBill(LIFECYCLE_TARGET, billNo, request);
    }

    public Map<String, Object> delete(String billNo) {
        return lifecycleService.deleteDraft(LIFECYCLE_TARGET, billNo, "只有草稿采购退货单可以删除");
    }

    private void insertLines(Object billId, List<PurchaseReturnLineRequest> lines) {
        var lineNo = 1;
        for (var line : lines) {
            var product = productSnapshotService.resolve(line.productId(), line.productCode(), "商品");
            var warehouseId = lookupService.lookupEnabledId("md_warehouse", line.warehouseCode(), "仓库");
            var amounts = taxAmountCalculator.calculate(line.qty(), line.unitPrice(), line.taxRate());
            jdbcTemplate.update("""
                INSERT INTO purchase_return_line (bill_id, line_no, source_in_no, source_line_no, product_id, product_code_snapshot, product_name_snapshot, product_spec_snapshot, warehouse_id, qty, unit_price, amount, tax_rate, tax_amount, price_tax_total, line_remark)
                VALUES (?::uuid, ?, ?, ?, ?::uuid, ?, ?, ?, ?::uuid, ?, ?, ?, ?, ?, ?, ?)
                """,
                billId,
                lineNo,
                validationService.optionalText(line.sourceOrderNo()),
                line.sourceLineNo(),
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
                validationService.optionalText(line.lineRemark())
            );
            lineNo += 1;
        }
    }

    private List<Map<String, Object>> postingLines(String billNo) {
        return jdbcTemplate.queryForList("""
            SELECT l.line_no AS "lineNo",
                   l.source_in_no AS "sourceOrderNo",
                   l.source_line_no AS "sourceLineNo",
                   COALESCE(l.product_code_snapshot, p.code) AS "productCode",
                   w.code AS "warehouseCode",
                   l.qty
            FROM purchase_return_line l
            JOIN md_product p ON p.id = l.product_id
            JOIN md_warehouse w ON w.id = l.warehouse_id
            JOIN purchase_return pr ON pr.id = l.bill_id
            WHERE pr.bill_no = ?
            ORDER BY l.line_no
            """, billNo);
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

    private PostingContext financeContext(Map<String, Object> row, String txnType, BigDecimal amount) {
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
            amount
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

    public record PurchaseReturnDraftRequest(String billNo, String supplierCode, String billDate, String department, String ownerName, String remark, List<PurchaseReturnLineRequest> lines) {
        public PurchaseReturnDraftRequest {
            if (lines == null || lines.isEmpty()) {
                throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "至少需要一条分录");
            }
        }
    }

    public record PurchaseReturnLineRequest(String productId, String productCode, String warehouseCode, String sourceOrderNo, Integer sourceLineNo, BigDecimal qty, BigDecimal unitPrice, BigDecimal taxRate, String lineRemark) {
    }
}
