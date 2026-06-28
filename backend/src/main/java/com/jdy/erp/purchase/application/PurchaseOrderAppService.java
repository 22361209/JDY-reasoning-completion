package com.jdy.erp.purchase.application;

import java.math.BigDecimal;
import java.time.LocalDate;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

import org.springframework.http.HttpStatus;
import com.jdy.erp.shared.application.BillLifecycleService;
import com.jdy.erp.shared.application.LookupService;
import com.jdy.erp.shared.application.NumberingService;
import com.jdy.erp.shared.application.TaxAmountCalculator;
import com.jdy.erp.shared.application.ValidationService;
import com.jdy.erp.shared.domain.BillStatus;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.server.ResponseStatusException;

@Service
public class PurchaseOrderAppService {
    private static final String BILL_TABLE = "purchase_order";

    private final JdbcTemplate jdbcTemplate;
    private final LookupService lookupService;
    private final ValidationService validationService;
    private final BillLifecycleService lifecycleService;
    private final NumberingService numberingService;
    private final TaxAmountCalculator taxAmountCalculator;

    public PurchaseOrderAppService(
        JdbcTemplate jdbcTemplate,
        LookupService lookupService,
        ValidationService validationService,
        BillLifecycleService lifecycleService,
        NumberingService numberingService,
        TaxAmountCalculator taxAmountCalculator
    ) {
        this.jdbcTemplate = jdbcTemplate;
        this.lookupService = lookupService;
        this.validationService = validationService;
        this.lifecycleService = lifecycleService;
        this.numberingService = numberingService;
        this.taxAmountCalculator = taxAmountCalculator;
    }

    public Map<String, Object> detail(String billNo) {
        var orderRows = jdbcTemplate.queryForList("""
            SELECT po.id::text AS id,
                   po.bill_no AS "billNo",
                   s.code AS "supplierCode",
                   s.name AS supplier,
                   to_char(po.bill_date, 'YYYY-MM-DD') AS "billDate",
                   po.department,
                   po.status,
                   po.close_status AS "closeStatus",
                   po.frozen_status AS "frozenStatus",
                   po.in_status AS "inStatus",
                   po.total_amount AS "totalAmount",
                   po.is_tax_inclusive AS "isTaxInclusive",
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
                   l.line_close_status AS "lineCloseStatus",
                   l.line_frozen_status AS "lineFrozenStatus",
                   l.unit_price AS "unitPrice",
                   l.amount,
                   l.tax_rate AS "taxRate",
                   l.tax_amount AS "taxAmount",
                   l.price_tax_total AS "priceTaxTotal",
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
                   l.source_line_no AS "sourceLineNo",
                   l.line_no AS "downstreamLineNo",
                   l.qty,
                   l.amount,
                   l.price_tax_total AS "priceTaxTotal"
            FROM purchase_in_line l
            JOIN purchase_in pi ON pi.id = l.bill_id
            JOIN purchase_order src ON src.bill_no = l.source_order_no
            WHERE src.id = ?::uuid
              AND l.source_line_no = ?
              AND pi.status = ?
            ORDER BY pi.bill_date DESC, pi.bill_no DESC, l.line_no
            """, sourceOrderId, sourceLineNo, BillStatus.AUDITED.name());
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

    public Map<String, Object> selectableLines(String supplierCode) {
        var rows = jdbcTemplate.queryForList("""
            SELECT po.bill_no AS "billNo",
                   s.code AS "supplierCode",
                   s.name AS supplier,
                   to_char(po.bill_date, 'YYYY-MM-DD') AS "billDate",
                   po.department,
                   po.owner_name AS "ownerName",
                   po.is_tax_inclusive AS "isTaxInclusive",
                   l.line_no AS "lineNo",
                   p.code AS "productCode",
                   p.name AS "productName",
                   COALESCE(p.spec, '') AS spec,
                   w.code AS "warehouseCode",
                   l.qty AS "sourceQty",
                   GREATEST(COALESCE(l.received_qty, 0), COALESCE(in_qty.received_qty, 0)) AS "receivedQty",
                   GREATEST(0, l.qty - GREATEST(COALESCE(l.received_qty, 0), COALESCE(in_qty.received_qty, 0))) AS "remainingQty",
                   l.line_close_status AS "lineCloseStatus",
                   l.line_frozen_status AS "lineFrozenStatus",
                   l.unit_price AS "unitPrice",
                   l.tax_rate AS "taxRate",
                   l.tax_amount AS "taxAmount",
                   l.price_tax_total AS "priceTaxTotal",
                   COALESCE(l.line_remark, '') AS "lineRemark"
            FROM purchase_order po
            JOIN md_supplier s ON s.id = po.supplier_id
            JOIN purchase_order_line l ON l.order_id = po.id
            JOIN md_product p ON p.id = l.product_id
            LEFT JOIN md_warehouse w ON w.id = l.warehouse_id
            LEFT JOIN (
                SELECT pil.source_order_no,
                       pil.source_line_no,
                       SUM(pil.qty) AS received_qty
                FROM purchase_in_line pil
                JOIN purchase_in pi ON pi.id = pil.bill_id
                WHERE pi.status <> 'VOID'
                GROUP BY pil.source_order_no, pil.source_line_no
            ) in_qty ON in_qty.source_order_no = po.bill_no AND in_qty.source_line_no = l.line_no
            WHERE s.code = ?
              AND po.status = ?
              AND po.close_status = 'OPEN'
              AND po.frozen_status = 'NORMAL'
              AND l.line_close_status = 'OPEN'
              AND l.line_frozen_status = 'NORMAL'
              AND GREATEST(0, l.qty - GREATEST(COALESCE(l.received_qty, 0), COALESCE(in_qty.received_qty, 0))) > 0
            ORDER BY po.bill_date DESC, po.bill_no DESC, l.line_no
            """, supplierCode == null ? "" : supplierCode.trim(), BillStatus.AUDITED.name());
        return Map.of("supplierCode", supplierCode == null ? "" : supplierCode.trim(), "lines", rows);
    }

    @Transactional
    public Map<String, Object> saveDraft(PurchaseOrderDraftRequest request) {
        var billNo = numberingService.assignBillNo("purchaseOrder", request.billNo());
        var supplierId = lookupService.lookupEnabledId("md_supplier", request.supplierCode(), "供应商");
        var isTaxInclusive = Boolean.TRUE.equals(request.isTaxInclusive());
        var totalAmount = request.lines().stream()
            .map(line -> taxAmountCalculator.calculate(line.qty(), line.unitPrice(), line.taxRate(), isTaxInclusive).priceTaxTotal())
            .reduce(BigDecimal.ZERO, BigDecimal::add);
        var order = jdbcTemplate.queryForMap("""
            INSERT INTO purchase_order (bill_no, supplier_id, bill_date, department, status, in_status, total_amount, is_tax_inclusive, owner_name)
            VALUES (?, ?::uuid, ?, ?, ?, 'NOT_IN', ?, ?, ?)
            ON CONFLICT (bill_no) DO UPDATE
            SET supplier_id = EXCLUDED.supplier_id,
                bill_date = EXCLUDED.bill_date,
                department = EXCLUDED.department,
                status = EXCLUDED.status,
                in_status = 'NOT_IN',
                close_status = 'OPEN',
                close_reason = NULL,
                closed_by = NULL,
                closed_at = NULL,
                frozen_status = 'NORMAL',
                frozen_reason = NULL,
                frozen_by = NULL,
                frozen_at = NULL,
                total_amount = EXCLUDED.total_amount,
                is_tax_inclusive = EXCLUDED.is_tax_inclusive,
                owner_name = EXCLUDED.owner_name,
                updated_at = now(),
                version = purchase_order.version + 1
            RETURNING id::text AS id, bill_no AS "billNo", total_amount AS "totalAmount"
            """,
            billNo,
            supplierId,
            LocalDate.parse(validationService.required(request.billDate(), "业务日期")),
            request.department(),
            BillStatus.DRAFT.name(),
            totalAmount,
            isTaxInclusive,
            request.ownerName()
        );
        var orderId = order.get("id");
        jdbcTemplate.update("DELETE FROM purchase_order_line WHERE order_id = ?::uuid", orderId);
        var lineNo = 1;
        for (var line : request.lines()) {
            var productId = lookupService.lookupEnabledId("md_product", line.productCode(), "商品");
            var warehouseId = lookupService.lookupEnabledId("md_warehouse", line.warehouseCode(), "仓库");
            var amounts = taxAmountCalculator.calculate(line.qty(), line.unitPrice(), line.taxRate(), isTaxInclusive);
            jdbcTemplate.update("""
                INSERT INTO purchase_order_line (order_id, line_no, product_id, warehouse_id, qty, unit_price, amount, tax_rate, tax_amount, price_tax_total, line_remark)
                VALUES (?::uuid, ?, ?::uuid, ?::uuid, ?, ?, ?, ?, ?, ?, ?)
                """,
                orderId,
                lineNo,
                productId,
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
        return order;
    }

    public Map<String, Object> audit(String billNo) {
        return lifecycleService.transitionAny(
            BILL_TABLE,
            billNo,
            BillStatus.AUDITED,
            "id::text AS id, bill_no AS \"billNo\", status",
            "PURCHASE",
            "AUDIT",
            "purchase_order",
            "采购订单不存在"
        );
    }

    public record PurchaseOrderDraftRequest(
        String billNo,
        String supplierCode,
        String billDate,
        String department,
        String ownerName,
        Boolean isTaxInclusive,
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
        BigDecimal taxRate,
        String lineRemark
    ) {
    }
}
