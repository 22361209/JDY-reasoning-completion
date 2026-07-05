package com.jdy.erp.purchase.application;

import java.math.BigDecimal;
import java.time.LocalDate;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

import org.springframework.http.HttpStatus;
import com.jdy.erp.shared.application.BillLifecycleService;
import com.jdy.erp.shared.application.BillLifecycleService.BillLifecycleTarget;
import com.jdy.erp.shared.application.LookupService;
import com.jdy.erp.shared.application.NumberingService;
import com.jdy.erp.shared.application.ProductSnapshotService;
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
    private static final BillLifecycleTarget LIFECYCLE_TARGET = new BillLifecycleTarget(BILL_TABLE, "purchase_order_line", "order_id", "PURCHASE", "purchase_order");

    private final JdbcTemplate jdbcTemplate;
    private final LookupService lookupService;
    private final ValidationService validationService;
    private final BillLifecycleService lifecycleService;
    private final NumberingService numberingService;
    private final TaxAmountCalculator taxAmountCalculator;
    private final ProductSnapshotService productSnapshotService;

    public PurchaseOrderAppService(
        JdbcTemplate jdbcTemplate,
        LookupService lookupService,
        ValidationService validationService,
        BillLifecycleService lifecycleService,
        NumberingService numberingService,
        TaxAmountCalculator taxAmountCalculator,
        ProductSnapshotService productSnapshotService
    ) {
        this.jdbcTemplate = jdbcTemplate;
        this.lookupService = lookupService;
        this.validationService = validationService;
        this.lifecycleService = lifecycleService;
        this.numberingService = numberingService;
        this.taxAmountCalculator = taxAmountCalculator;
        this.productSnapshotService = productSnapshotService;
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
                   l.product_id::text AS "productId",
                   COALESCE(l.product_code_snapshot, p.code) AS "productCode",
                   COALESCE(l.product_name_snapshot, p.name) AS "productName",
                   COALESCE(l.product_spec_snapshot, p.spec, '') AS spec,
                   COALESCE(l.product_unit_snapshot, p.unit, '') AS unit,
                   trim(to_char(COALESCE(l.net_weight_snapshot, p.net_weight), 'FM9999999990.00')) AS "netWeight",
                   trim(to_char(COALESCE(l.gross_weight_snapshot, p.gross_weight), 'FM9999999990.00')) AS "grossWeight",
                   w.code AS "warehouseCode",
                   l.qty,
                   l.received_qty AS "receivedQty",
                   GREATEST(0, l.qty - l.received_qty) AS "remainingQty",
                   l.line_close_status AS "lineCloseStatus",
                   l.line_frozen_status AS "lineFrozenStatus",
                   COALESCE(l.supplier_material_code, '') AS "supplierMaterialCode",
                   COALESCE(l.source_requisition_no, '') AS "sourceOrderNo",
                   l.source_requisition_line_no AS "sourceLineNo",
                   l.unit_price AS "unitPrice",
                   round(l.unit_price * (1 + COALESCE(l.tax_rate, 0) / 100), 2) AS "taxInclusiveUnitPrice",
                   l.amount,
                   l.tax_rate AS "taxRate",
                   l.tax_amount AS "taxAmount",
                   l.price_tax_total AS "priceTaxTotal",
                   COALESCE(l.line_remark, '') AS "lineRemark",
                   to_char(l.plan_delivery_date, 'YYYY-MM-DD') AS "planDeliveryDate"
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
            copy.put("redReverseImpact", "红冲将生成负数采购入库单，在原单关联红字单，并同样回退源采购订单第 "
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
                   GREATEST(COALESCE(l.received_qty, 0), COALESCE(in_qty.received_qty, 0)) AS "receivedQty",
                   GREATEST(0, l.qty - GREATEST(COALESCE(l.received_qty, 0), COALESCE(in_qty.received_qty, 0))) AS "remainingQty",
                   l.line_close_status AS "lineCloseStatus",
                   l.line_frozen_status AS "lineFrozenStatus",
                   COALESCE(l.supplier_material_code, '') AS "supplierMaterialCode",
                   l.unit_price AS "unitPrice",
                   round(l.unit_price * (1 + COALESCE(l.tax_rate, 0) / 100), 2) AS "taxInclusiveUnitPrice",
                   l.tax_rate AS "taxRate",
                   l.tax_amount AS "taxAmount",
                   l.price_tax_total AS "priceTaxTotal",
                   COALESCE(l.line_remark, '') AS "lineRemark",
                   to_char(l.plan_delivery_date, 'YYYY-MM-DD') AS "planDeliveryDate"
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
                WHERE pi.status = 'AUDITED'
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

    public Map<String, Object> selectableRequisitionLines(String supplierCode) {
        var rows = jdbcTemplate.queryForList("""
            SELECT pr.bill_no AS "billNo",
                   COALESCE(pr.supplier_code_snapshot, s.code) AS "supplierCode",
                   COALESCE(pr.supplier_name_snapshot, s.name) AS supplier,
                   to_char(pr.bill_date, 'YYYY-MM-DD') AS "billDate",
                   pr.department,
                   pr.owner_name AS "ownerName",
                   l.line_no AS "lineNo",
                   l.product_id::text AS "productId",
                   COALESCE(l.product_code_snapshot, p.code) AS "productCode",
                   COALESCE(l.product_name_snapshot, p.name) AS "productName",
                   COALESCE(l.product_spec_snapshot, p.spec, '') AS spec,
                   COALESCE(l.product_unit_snapshot, p.unit, '') AS unit,
                   trim(to_char(COALESCE(l.net_weight_snapshot, p.net_weight), 'FM9999999990.00')) AS "netWeight",
                   trim(to_char(COALESCE(l.gross_weight_snapshot, p.gross_weight), 'FM9999999990.00')) AS "grossWeight",
                   COALESCE(w.code, '') AS "warehouseCode",
                   l.qty AS "sourceQty",
                   COALESCE(l.ordered_qty, 0) AS "receivedQty",
                   GREATEST(0, l.qty - COALESCE(l.ordered_qty, 0)) AS "remainingQty",
                   COALESCE(l.supplier_material_code, '') AS "supplierMaterialCode",
                   COALESCE(p.purchase_price, 0) AS "unitPrice",
                   COALESCE(p.tax_rate, 13) AS "taxRate",
                   0 AS "taxAmount",
                   0 AS "priceTaxTotal",
                   '' AS "lineRemark",
                   to_char(l.plan_delivery_date, 'YYYY-MM-DD') AS "planDeliveryDate"
            FROM purchase_requisition pr
            JOIN purchase_requisition_line l ON l.requisition_id = pr.id
            JOIN md_supplier s ON s.id = pr.supplier_id
            JOIN md_product p ON p.id = l.product_id
            LEFT JOIN md_warehouse w ON w.id = l.warehouse_id
            WHERE s.code = ?
              AND pr.status = ?
              AND l.line_close_status = 'OPEN'
              AND l.line_frozen_status = 'NORMAL'
              AND GREATEST(0, l.qty - COALESCE(l.ordered_qty, 0)) > 0
            ORDER BY pr.bill_date DESC, pr.bill_no DESC, l.line_no
            """, supplierCode == null ? "" : supplierCode.trim(), BillStatus.AUDITED.name());
        return Map.of("supplierCode", supplierCode == null ? "" : supplierCode.trim(), "lines", rows);
    }

    @Transactional
    public Map<String, Object> saveDraft(PurchaseOrderDraftRequest request) {
        request.lines().forEach(line -> validationService.positive(line.qty(), "采购订单数量"));
        var billNo = numberingService.assignBillNo("purchaseOrder", request.billNo());
        var supplierId = lookupService.lookupEnabledId("md_supplier", request.supplierCode(), "供应商");
        var totalAmount = request.lines().stream()
            .map(line -> taxAmountCalculator.calculate(line.qty(), line.unitPrice(), line.taxRate()).priceTaxTotal())
            .reduce(BigDecimal.ZERO, BigDecimal::add);
        var order = jdbcTemplate.queryForMap("""
            INSERT INTO purchase_order (bill_no, supplier_id, bill_date, department, status, in_status, total_amount, owner_name)
            VALUES (?, ?::uuid, ?, ?, ?, 'NOT_IN', ?, ?)
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
            request.ownerName()
        );
        var orderId = order.get("id");
        jdbcTemplate.update("DELETE FROM purchase_order_line WHERE order_id = ?::uuid", orderId);
        var lineNo = 1;
        for (var line : request.lines()) {
            var product = productSnapshotService.resolve(line.productId(), line.productCode(), "商品");
            var warehouseId = lookupService.lookupEnabledId("md_warehouse", line.warehouseCode(), "仓库");
            var amounts = taxAmountCalculator.calculate(line.qty(), line.unitPrice(), line.taxRate());
            jdbcTemplate.update("""
                INSERT INTO purchase_order_line (order_id, line_no, product_id, product_code_snapshot, product_name_snapshot, product_spec_snapshot, warehouse_id, supplier_material_code, source_requisition_no, source_requisition_line_no, qty, unit_price, amount, tax_rate, tax_amount, price_tax_total, line_remark, plan_delivery_date)
                VALUES (?::uuid, ?, ?::uuid, ?, ?, ?, ?::uuid, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                orderId,
                lineNo,
                product.id(),
                product.code(),
                product.name(),
                product.spec(),
                warehouseId,
                optionalTextOrEmpty(line.supplierMaterialCode()),
                validationService.optionalText(line.sourceOrderNo()),
                line.sourceLineNo(),
                line.qty(),
                line.unitPrice(),
                amounts.amount(),
                amounts.taxRate(),
                amounts.taxAmount(),
                amounts.priceTaxTotal(),
                validationService.optionalText(line.lineRemark()),
                parseOptionalDate(line.planDeliveryDate())
            );
            lineNo += 1;
        }
        return order;
    }

    @Transactional
    public Map<String, Object> audit(String billNo) {
        lifecycleService.guardPositiveLineQuantities(LIFECYCLE_TARGET, billNo, "采购订单数量必须大于 0");
        var row = lifecycleService.transition(
            BILL_TABLE,
            billNo,
            BillStatus.DRAFT,
            BillStatus.AUDITED,
            "id::text AS id, bill_no AS \"billNo\", status",
            "PURCHASE",
            "AUDIT",
            "purchase_order",
            "采购订单不存在或已审核"
        );
        var demands = purchaseRequisitionDemands(billNo);
        guardPurchaseRequisitionQuantities(demands, billNo);
        markPurchaseRequisitionOrdered(demands);
        return row;
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
        String productId,
        String productCode,
        String warehouseCode,
        BigDecimal qty,
        BigDecimal unitPrice,
        BigDecimal taxRate,
        String lineRemark,
        String supplierMaterialCode,
        String sourceOrderNo,
        Integer sourceLineNo,
        String planDeliveryDate
    ) {
    }

    private List<PurchaseRequisitionDemand> purchaseRequisitionDemands(String billNo) {
        var lines = jdbcTemplate.queryForList("""
            SELECT source_requisition_no AS "sourceBillNo",
                   source_requisition_line_no AS "sourceLineNo",
                   qty
            FROM purchase_order_line line
            JOIN purchase_order po ON po.id = line.order_id
            WHERE po.bill_no = ?
            ORDER BY line.line_no
            """, billNo);
        var grouped = new HashMap<String, PurchaseRequisitionDemand>();
        for (var line : lines) {
            var sourceBillNo = validationService.optionalText((String) line.get("sourceBillNo"));
            var sourceLineNo = line.get("sourceLineNo");
            if (sourceBillNo == null && sourceLineNo == null) {
                continue;
            }
            if (sourceBillNo == null || sourceLineNo == null) {
                throw new ResponseStatusException(HttpStatus.CONFLICT, "采购申请源单行不能为空");
            }
            var qty = validationService.positive((BigDecimal) line.get("qty"), "采购订单数量");
            var key = sourceBillNo + "\u0000" + sourceLineNo;
            var existing = grouped.get(key);
            grouped.put(
                key,
                existing == null
                    ? new PurchaseRequisitionDemand(sourceBillNo, sourceLineNo, qty)
                    : new PurchaseRequisitionDemand(sourceBillNo, sourceLineNo, existing.qty().add(qty))
            );
        }
        return grouped.values().stream().toList();
    }

    private void guardPurchaseRequisitionQuantities(List<PurchaseRequisitionDemand> demands, String currentBillNo) {
        for (var demand : demands) {
            refreshPurchaseRequisitionOrderedQty(demand, currentBillNo);
            var rows = jdbcTemplate.queryForList("""
                SELECT line.qty - COALESCE(line.ordered_qty, 0) AS remaining_qty
                FROM purchase_requisition req
                JOIN purchase_requisition_line line ON line.requisition_id = req.id
                WHERE req.bill_no = ?
                  AND req.status = 'AUDITED'
                  AND line.line_no = ?
                  AND line.line_close_status = 'OPEN'
                  AND line.line_frozen_status = 'NORMAL'
                FOR UPDATE OF line
                """, demand.sourceBillNo(), demand.sourceLineNo());
            if (rows.isEmpty()) {
                throw new ResponseStatusException(HttpStatus.CONFLICT, "采购申请源明细不存在或未审核");
            }
            var remaining = (BigDecimal) rows.get(0).get("remaining_qty");
            if (remaining == null || remaining.compareTo(demand.qty()) < 0) {
                throw new ResponseStatusException(HttpStatus.CONFLICT, "采购订单数量不能超过采购申请剩余可订数量");
            }
        }
    }

    private void refreshPurchaseRequisitionOrderedQty(PurchaseRequisitionDemand demand, String currentBillNo) {
        jdbcTemplate.update("""
            UPDATE purchase_requisition_line line
            SET ordered_qty = COALESCE((
                SELECT SUM(po_line.qty)
                FROM purchase_order_line po_line
                JOIN purchase_order po ON po.id = po_line.order_id
                WHERE po.status = 'AUDITED'
                  AND po.bill_no <> ?
                  AND po_line.source_requisition_no = req.bill_no
                  AND po_line.source_requisition_line_no = line.line_no
            ), 0)
            FROM purchase_requisition req
            WHERE req.id = line.requisition_id
              AND req.bill_no = ?
              AND line.line_no = ?
            """, currentBillNo, demand.sourceBillNo(), demand.sourceLineNo());
    }

    private void markPurchaseRequisitionOrdered(List<PurchaseRequisitionDemand> demands) {
        for (var demand : demands) {
            jdbcTemplate.update("""
                UPDATE purchase_requisition_line line
                SET ordered_qty = COALESCE(line.ordered_qty, 0) + ?
                FROM purchase_requisition req
                WHERE req.id = line.requisition_id
                  AND req.bill_no = ?
                  AND line.line_no = ?
                """, demand.qty(), demand.sourceBillNo(), demand.sourceLineNo());
        }
    }

    private LocalDate parseOptionalDate(String value) {
        var text = validationService.optionalText(value);
        return text == null ? null : LocalDate.parse(text);
    }

    private String optionalTextOrEmpty(String value) {
        var text = validationService.optionalText(value);
        return text == null ? "" : text;
    }

    private record PurchaseRequisitionDemand(String sourceBillNo, Object sourceLineNo, BigDecimal qty) {
    }
}
