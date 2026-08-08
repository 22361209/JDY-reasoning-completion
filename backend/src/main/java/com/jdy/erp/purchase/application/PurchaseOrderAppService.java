package com.jdy.erp.purchase.application;

import java.math.BigDecimal;
import java.time.LocalDate;
import java.util.Comparator;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.UUID;

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
                   po.currency,
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
                   COALESCE(l.source_purchase_plan_id::text, '') AS "sourcePurchasePlanId",
                   COALESCE(l.source_purchase_plan_line_id::text, '') AS "sourcePurchasePlanLineId",
                   COALESCE(l.source_purchase_plan_no, '') AS "sourcePurchasePlanNo",
                   l.source_purchase_plan_line_no AS "sourcePurchasePlanLineNo",
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
                   po.currency,
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
                   COALESCE(l.supplier_code_snapshot, pr.supplier_code_snapshot, s.code) AS "supplierCode",
                   COALESCE(l.supplier_name_snapshot, pr.supplier_name_snapshot, s.name) AS supplier,
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
                   GREATEST(0, l.qty - COALESCE(l.ordered_qty, 0) - COALESCE(l.planned_qty, 0)) AS "remainingQty",
                   COALESCE(l.supplier_material_code, '') AS "supplierMaterialCode",
                   COALESCE(p.purchase_price, 0) AS "unitPrice",
                   COALESCE(p.tax_rate, 13) AS "taxRate",
                   0 AS "taxAmount",
                   0 AS "priceTaxTotal",
                   '' AS "lineRemark",
                   to_char(l.plan_delivery_date, 'YYYY-MM-DD') AS "planDeliveryDate"
            FROM purchase_requisition pr
            JOIN purchase_requisition_line l ON l.requisition_id = pr.id
            JOIN md_supplier s ON s.id = COALESCE(l.supplier_id, pr.supplier_id)
            JOIN md_product p ON p.id = l.product_id
            LEFT JOIN md_warehouse w ON w.id = l.warehouse_id
            WHERE s.code = ?
              AND pr.status = ?
              AND l.line_close_status = 'OPEN'
              AND l.line_frozen_status = 'NORMAL'
              AND GREATEST(0, l.qty - COALESCE(l.ordered_qty, 0) - COALESCE(l.planned_qty, 0)) > 0
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
        var currency = normalizeCurrency(request.currency());
        var orders = jdbcTemplate.queryForList("""
            INSERT INTO purchase_order (bill_no, supplier_id, bill_date, department, status, in_status, total_amount, currency, owner_name)
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
                currency = EXCLUDED.currency,
                owner_name = EXCLUDED.owner_name,
                updated_at = now(),
                version = purchase_order.version + 1
            WHERE purchase_order.status = 'DRAFT'
            RETURNING id::text AS id, bill_no AS "billNo", total_amount AS "totalAmount", currency
            """,
            billNo,
            supplierId,
            LocalDate.parse(validationService.required(request.billDate(), "业务日期")),
            request.department(),
            BillStatus.DRAFT.name(),
            totalAmount,
            currency,
            request.ownerName()
        );
        if (orders.isEmpty()) {
            throw new ResponseStatusException(HttpStatus.CONFLICT, "只有草稿采购订单可以保存");
        }
        var order = orders.get(0);
        var orderId = order.get("id");
        jdbcTemplate.update("DELETE FROM purchase_order_line WHERE order_id = ?::uuid", orderId);
        var lineNo = 1;
        for (var line : request.lines()) {
            var product = productSnapshotService.resolve(line.productId(), line.productCode(), "商品");
            var warehouseId = lookupService.lookupEnabledId("md_warehouse", line.warehouseCode(), "仓库");
            var amounts = taxAmountCalculator.calculate(line.qty(), line.unitPrice(), line.taxRate());
            jdbcTemplate.update("""
                INSERT INTO purchase_order_line (order_id, line_no, product_id, product_code_snapshot, product_name_snapshot, product_spec_snapshot, warehouse_id, supplier_material_code, source_requisition_no, source_requisition_line_no, qty, unit_price, amount, tax_rate, tax_amount, price_tax_total, line_remark, plan_delivery_date, source_purchase_plan_id, source_purchase_plan_line_id, source_purchase_plan_no, source_purchase_plan_line_no)
                VALUES (?::uuid, ?, ?::uuid, ?, ?, ?, ?::uuid, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?::uuid, ?::uuid, ?, ?)
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
                parseOptionalDate(line.planDeliveryDate()),
                validationService.optionalText(line.sourcePurchasePlanId()),
                validationService.optionalText(line.sourcePurchasePlanLineId()),
                validationService.optionalText(line.sourcePurchasePlanNo()),
                line.sourcePurchasePlanLineNo()
            );
            lineNo += 1;
        }
        return order;
    }

    @Transactional
    public Map<String, Object> audit(String billNo) {
        var normalizedBillNo = validationService.required(billNo, "采购订单单号");
        var order = lockPurchaseOrderForAudit(normalizedBillNo);
        lifecycleService.guardPositiveLineQuantities(LIFECYCLE_TARGET, normalizedBillNo, "采购订单数量必须大于 0");
        var demands = purchaseRequisitionDemands(normalizedBillNo);
        var lockedSources = lockPurchaseRequisitionSources(demands);
        refreshAndGuardPurchaseRequisitionQuantities(lockedSources, normalizedBillNo);
        var planSources = lockPurchasePlanSources(normalizedBillNo, String.valueOf(order.get("supplierId")));
        var row = lifecycleService.transition(
            BILL_TABLE,
            normalizedBillNo,
            BillStatus.DRAFT,
            BillStatus.AUDITED,
            "id::text AS id, bill_no AS \"billNo\", status",
            "PURCHASE",
            "AUDIT",
            "purchase_order",
            "采购订单不存在或已审核"
        );
        markPurchaseRequisitionOrdered(lockedSources);
        markPurchasePlanOrdered(planSources);
        return row;
    }

    @Transactional
    public Map<String, Object> reverse(String billNo) {
        var normalizedBillNo = validationService.required(billNo, "采购订单单号");
        var order = lockPurchaseOrderForReverse(normalizedBillNo);
        requireNoAuditedPurchaseIn(normalizedBillNo);
        var requisitionSources = lockPurchaseRequisitionSources(purchaseRequisitionDemands(normalizedBillNo));
        var planSources = lockPurchasePlanSourcesForRelease(normalizedBillNo, String.valueOf(order.get("supplierId")));
        var row = lifecycleService.transition(
            BILL_TABLE,
            normalizedBillNo,
            BillStatus.AUDITED,
            BillStatus.DRAFT,
            "id::text AS id, bill_no AS \"billNo\", status",
            "PURCHASE",
            "REVERSE",
            "purchase_order",
            "采购订单不存在、已关闭/冻结或状态已变化"
        );
        refreshPurchaseRequisitionQuantities(requisitionSources, normalizedBillNo);
        releasePurchasePlanOrdered(planSources);
        return row;
    }

    public record PurchaseOrderDraftRequest(
        String billNo,
        String supplierCode,
        String billDate,
        String department,
        String ownerName,
        String currency,
        List<PurchaseOrderLineRequest> lines
    ) {
        public PurchaseOrderDraftRequest(
            String billNo,
            String supplierCode,
            String billDate,
            String department,
            String ownerName,
            List<PurchaseOrderLineRequest> lines
        ) {
            this(billNo, supplierCode, billDate, department, ownerName, "CNY", lines);
        }

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
        String planDeliveryDate,
        String sourcePurchasePlanId,
        String sourcePurchasePlanLineId,
        String sourcePurchasePlanNo,
        Integer sourcePurchasePlanLineNo
    ) {
        public PurchaseOrderLineRequest(
            String productId, String productCode, String warehouseCode, BigDecimal qty,
            BigDecimal unitPrice, BigDecimal taxRate, String lineRemark,
            String supplierMaterialCode, String sourceOrderNo, Integer sourceLineNo,
            String planDeliveryDate
        ) {
            this(productId, productCode, warehouseCode, qty, unitPrice, taxRate, lineRemark,
                supplierMaterialCode, sourceOrderNo, sourceLineNo, planDeliveryDate,
                null, null, null, null);
        }
    }

    private String normalizeCurrency(String value) {
        if (value == null) {
            return "CNY";
        }
        if (value.isBlank()) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "请选择币种");
        }
        var currency = value.trim().toUpperCase(Locale.ROOT);
        if (!"CNY".equals(currency) && !"USD".equals(currency)) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "币种只支持 CNY 或 USD");
        }
        return currency;
    }

    private List<PurchaseRequisitionDemand> purchaseRequisitionDemands(String billNo) {
        var lines = jdbcTemplate.queryForList("""
            SELECT source_requisition_no AS "sourceBillNo",
                   source_requisition_line_no AS "sourceLineNo",
                   qty
            FROM purchase_order_line line
            JOIN purchase_order po ON po.id = line.order_id
            WHERE po.bill_no = ?
              AND line.source_purchase_plan_no IS NULL
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
            if (!(sourceLineNo instanceof Number lineNumber) || lineNumber.intValue() <= 0) {
                throw new ResponseStatusException(HttpStatus.CONFLICT, "采购申请源单行不正确");
            }
            var qty = validationService.positive((BigDecimal) line.get("qty"), "采购订单数量");
            var normalizedSourceLineNo = lineNumber.intValue();
            var key = sourceKey(sourceBillNo, normalizedSourceLineNo);
            var existing = grouped.get(key);
            grouped.put(
                key,
                existing == null
                    ? new PurchaseRequisitionDemand(sourceBillNo, normalizedSourceLineNo, qty)
                    : new PurchaseRequisitionDemand(sourceBillNo, normalizedSourceLineNo, existing.qty().add(qty))
            );
        }
        return grouped.values().stream()
            .sorted(Comparator.comparing(PurchaseRequisitionDemand::sourceBillNo)
                .thenComparingInt(PurchaseRequisitionDemand::sourceLineNo))
            .toList();
    }

    private List<LockedPurchasePlanLine> lockPurchasePlanSources(String billNo, String supplierId) {
        var demands = purchasePlanDemands(billNo);
        var locked = new java.util.ArrayList<LockedPurchasePlanLine>();
        for (var demand : demands) {
            var rows = jdbcTemplate.queryForList("""
                SELECT plan.id::text AS "planId",
                       plan.status,
                       plan.supplier_id::text AS "supplierId",
                       plan_line.id::text AS "lineId",
                       plan_line.qty,
                       COALESCE(plan_line.ordered_qty, 0) AS "orderedQty"
                FROM purchase_plan plan
                JOIN purchase_plan_line plan_line ON plan_line.plan_id = plan.id
                WHERE plan.bill_no = ?
                  AND plan_line.line_no = ?
                FOR UPDATE OF plan, plan_line
                """, demand.planNo(), demand.planLineNo());
            if (rows.size() != 1) {
                throw new ResponseStatusException(HttpStatus.CONFLICT, "采购计划源明细不存在");
            }
            var row = rows.get(0);
            if (!demand.planId().equals(String.valueOf(row.get("planId")))
                || !demand.planLineId().equals(String.valueOf(row.get("lineId")))) {
                throw new ResponseStatusException(HttpStatus.CONFLICT, "采购计划来源标识与源单行不一致");
            }
            if (!BillStatus.AUDITED.name().equals(String.valueOf(row.get("status")))
                || !supplierId.equals(String.valueOf(row.get("supplierId")))) {
                throw new ResponseStatusException(HttpStatus.CONFLICT, "采购计划源单未审核或供应商不一致");
            }
            var qty = demand.qty();
            var remaining = ((BigDecimal) row.get("qty")).subtract((BigDecimal) row.get("orderedQty"));
            if (remaining.compareTo(qty) < 0) {
                throw new ResponseStatusException(HttpStatus.CONFLICT, "采购订单数量不能超过采购计划剩余可订数量");
            }
            locked.add(new LockedPurchasePlanLine(String.valueOf(row.get("lineId")), qty));
        }
        return locked;
    }

    private void markPurchasePlanOrdered(List<LockedPurchasePlanLine> sources) {
        for (var source : sources) {
            var updated = jdbcTemplate.update("""
                UPDATE purchase_plan_line
                SET ordered_qty = COALESCE(ordered_qty, 0) + ?
                WHERE id = ?::uuid
                """, source.qty(), source.id());
            if (updated != 1) {
                throw new ResponseStatusException(HttpStatus.CONFLICT, "采购计划来源占用已变化，本次审核已回滚");
            }
        }
    }

    private List<LockedPurchasePlanLine> lockPurchasePlanSourcesForRelease(String billNo, String supplierId) {
        var demands = purchasePlanDemands(billNo);
        var locked = new java.util.ArrayList<LockedPurchasePlanLine>();
        for (var demand : demands) {
            var rows = jdbcTemplate.queryForList("""
                SELECT plan.id::text AS "planId",
                       plan.status,
                       plan.supplier_id::text AS "supplierId",
                       plan_line.id::text AS "lineId",
                       COALESCE(plan_line.ordered_qty, 0) AS "orderedQty"
                FROM purchase_plan plan
                JOIN purchase_plan_line plan_line ON plan_line.plan_id = plan.id
                WHERE plan.bill_no = ?
                  AND plan_line.line_no = ?
                FOR UPDATE OF plan, plan_line
                """, demand.planNo(), demand.planLineNo());
            if (rows.size() != 1) {
                throw new ResponseStatusException(HttpStatus.CONFLICT, "采购计划源明细不存在");
            }
            var row = rows.get(0);
            if (!demand.planId().equals(String.valueOf(row.get("planId")))
                || !demand.planLineId().equals(String.valueOf(row.get("lineId")))) {
                throw new ResponseStatusException(HttpStatus.CONFLICT, "采购计划来源标识与源单行不一致");
            }
            if (!BillStatus.AUDITED.name().equals(String.valueOf(row.get("status")))
                || !supplierId.equals(String.valueOf(row.get("supplierId")))) {
                throw new ResponseStatusException(HttpStatus.CONFLICT, "采购计划源单未审核或供应商不一致");
            }
            if (((BigDecimal) row.get("orderedQty")).compareTo(demand.qty()) < 0) {
                throw new ResponseStatusException(HttpStatus.CONFLICT, "采购计划已订数量不足，不能反审核采购订单");
            }
            locked.add(new LockedPurchasePlanLine(String.valueOf(row.get("lineId")), demand.qty()));
        }
        return locked;
    }

    private void releasePurchasePlanOrdered(List<LockedPurchasePlanLine> sources) {
        for (var source : sources) {
            var updated = jdbcTemplate.update("""
                UPDATE purchase_plan_line
                SET ordered_qty = COALESCE(ordered_qty, 0) - ?
                WHERE id = ?::uuid
                  AND COALESCE(ordered_qty, 0) >= ?
                """, source.qty(), source.id(), source.qty());
            if (updated != 1) {
                throw new ResponseStatusException(HttpStatus.CONFLICT, "采购计划来源占用已变化，本次反审核已回滚");
            }
        }
    }

    private List<PurchasePlanDemand> purchasePlanDemands(String billNo) {
        var rows = jdbcTemplate.queryForList("""
            SELECT line.source_purchase_plan_id::text AS "planId",
                   line.source_purchase_plan_line_id::text AS "planLineId",
                   line.source_purchase_plan_no AS "planNo",
                   line.source_purchase_plan_line_no AS "planLineNo",
                   line.qty
            FROM purchase_order_line line
            JOIN purchase_order purchase_order ON purchase_order.id = line.order_id
            WHERE purchase_order.bill_no = ?
              AND line.source_purchase_plan_no IS NOT NULL
            ORDER BY line.source_purchase_plan_no, line.source_purchase_plan_line_no
            """, billNo);
        var grouped = new HashMap<String, PurchasePlanDemand>();
        for (var row : rows) {
            var planId = validationService.optionalText((String) row.get("planId"));
            var planLineId = validationService.optionalText((String) row.get("planLineId"));
            var planNo = validationService.optionalText((String) row.get("planNo"));
            var planLineNo = row.get("planLineNo");
            if (planId == null || planLineId == null || planNo == null || !(planLineNo instanceof Number number)
                || number.intValue() <= 0) {
                throw new ResponseStatusException(HttpStatus.CONFLICT, "采购计划源单行不能为空");
            }
            var qty = validationService.positive((BigDecimal) row.get("qty"), "采购订单数量");
            var key = sourceKey(planNo, number.intValue());
            var existing = grouped.get(key);
            if (existing != null && (!existing.planId().equals(planId) || !existing.planLineId().equals(planLineId))) {
                throw new ResponseStatusException(HttpStatus.CONFLICT, "采购计划来源标识与源单行不一致");
            }
            grouped.put(key, existing == null
                ? new PurchasePlanDemand(planId, planLineId, planNo, number.intValue(), qty)
                : new PurchasePlanDemand(planId, planLineId, planNo, number.intValue(), existing.qty().add(qty)));
        }
        return grouped.values().stream()
            .sorted(Comparator.comparing(PurchasePlanDemand::planNo).thenComparingInt(PurchasePlanDemand::planLineNo))
            .toList();
    }

    private Map<String, Object> lockPurchaseOrderForAudit(String billNo) {
        var rows = jdbcTemplate.queryForList("""
            SELECT status, supplier_id::text AS "supplierId"
            FROM purchase_order
            WHERE bill_no = ?
            FOR UPDATE
            """, billNo);
        if (rows.isEmpty() || !BillStatus.DRAFT.name().equals(String.valueOf(rows.get(0).get("status")))) {
            throw new ResponseStatusException(HttpStatus.CONFLICT, "采购订单不存在或已审核");
        }
        return rows.get(0);
    }

    private Map<String, Object> lockPurchaseOrderForReverse(String billNo) {
        var rows = jdbcTemplate.queryForList("""
            SELECT status, supplier_id::text AS "supplierId", close_status AS "closeStatus", frozen_status AS "frozenStatus"
            FROM purchase_order
            WHERE bill_no = ?
            FOR UPDATE
            """, billNo);
        if (rows.isEmpty()
            || !BillStatus.AUDITED.name().equals(String.valueOf(rows.get(0).get("status")))
            || !"OPEN".equals(String.valueOf(rows.get(0).get("closeStatus")))
            || !"NORMAL".equals(String.valueOf(rows.get(0).get("frozenStatus")))) {
            throw new ResponseStatusException(HttpStatus.CONFLICT, "采购订单不存在、已关闭/冻结或状态已变化");
        }
        return rows.get(0);
    }

    private void requireNoAuditedPurchaseIn(String billNo) {
        var count = jdbcTemplate.queryForObject("""
            SELECT COUNT(*)
            FROM purchase_in_line line
            JOIN purchase_in purchase_in ON purchase_in.id = line.bill_id
            WHERE line.source_order_no = ?
              AND purchase_in.status = 'AUDITED'
            """, Integer.class, billNo);
        if (count != null && count > 0) {
            throw new ResponseStatusException(HttpStatus.CONFLICT, "已有已审核采购入库，不能反审核采购订单");
        }
    }

    private List<LockedPurchaseRequisitionLine> lockPurchaseRequisitionSources(
        List<PurchaseRequisitionDemand> demands
    ) {
        if (demands.isEmpty()) {
            return List.of();
        }

        var referencesByBillNo = new LinkedHashMap<String, PurchaseRequisitionReference>();
        for (var demand : demands) {
            if (referencesByBillNo.containsKey(demand.sourceBillNo())) {
                continue;
            }
            var rows = jdbcTemplate.queryForList("""
                SELECT id::text AS id,
                       bill_no AS "billNo"
                FROM purchase_requisition
                WHERE bill_no = ?
                """, demand.sourceBillNo());
            if (rows.isEmpty()) {
                throw new ResponseStatusException(HttpStatus.CONFLICT, "采购申请源明细不存在或未审核");
            }
            var row = rows.get(0);
            referencesByBillNo.put(
                demand.sourceBillNo(),
                new PurchaseRequisitionReference(
                    UUID.fromString(String.valueOf(row.get("id"))),
                    demand.sourceBillNo()
                )
            );
        }
        var requisitions = referencesByBillNo.values().stream()
            .sorted((left, right) -> compareUuid(left.id(), right.id()))
            .toList();
        for (var requisition : requisitions) {
            var rows = jdbcTemplate.queryForList("""
                SELECT id::text AS id,
                       bill_no AS "billNo",
                       status
                FROM purchase_requisition
                WHERE id = ?::uuid
                FOR UPDATE
                """, requisition.id().toString());
            if (rows.isEmpty()) {
                throw new ResponseStatusException(HttpStatus.CONFLICT, "采购申请源明细不存在或未审核");
            }
            var locked = rows.get(0);
            if (!requisition.id().toString().equals(String.valueOf(locked.get("id")))
                || !requisition.billNo().equals(String.valueOf(locked.get("billNo")))
                || !BillStatus.AUDITED.name().equals(String.valueOf(locked.get("status")))) {
                throw new ResponseStatusException(HttpStatus.CONFLICT, "采购申请源明细不存在或未审核");
            }
        }

        var demandsBySource = new HashMap<String, PurchaseRequisitionDemand>();
        for (var demand : demands) {
            demandsBySource.put(sourceKey(demand.sourceBillNo(), demand.sourceLineNo()), demand);
        }
        var lockedBySource = new HashMap<String, LockedPurchaseRequisitionLine>();
        for (var requisition : requisitions) {
            var rows = jdbcTemplate.queryForList("""
                SELECT id::text AS id,
                       line_no AS "lineNo",
                       qty,
                       COALESCE(planned_qty, 0) AS "plannedQty",
                       line_close_status AS "lineCloseStatus",
                       line_frozen_status AS "lineFrozenStatus"
                FROM purchase_requisition_line
                WHERE requisition_id = ?::uuid
                ORDER BY id
                FOR UPDATE
                """, requisition.id().toString());
            for (var row : rows) {
                var lineNo = ((Number) row.get("lineNo")).intValue();
                var key = sourceKey(requisition.billNo(), lineNo);
                var demand = demandsBySource.get(key);
                if (demand == null) {
                    continue;
                }
                lockedBySource.put(key, new LockedPurchaseRequisitionLine(
                    demand,
                    String.valueOf(row.get("id")),
                    (BigDecimal) row.get("qty"),
                    (BigDecimal) row.get("plannedQty"),
                    String.valueOf(row.get("lineCloseStatus")),
                    String.valueOf(row.get("lineFrozenStatus"))
                ));
            }
        }

        return demands.stream().map(demand -> {
            var locked = lockedBySource.get(sourceKey(demand.sourceBillNo(), demand.sourceLineNo()));
            if (locked == null) {
                throw new ResponseStatusException(HttpStatus.CONFLICT, "采购申请源明细不存在或未审核");
            }
            return locked;
        }).toList();
    }

    private void refreshAndGuardPurchaseRequisitionQuantities(
        List<LockedPurchaseRequisitionLine> sources,
        String currentBillNo
    ) {
        for (var source : sources) {
            var demand = source.demand();
            var orderedQty = refreshPurchaseRequisitionQuantity(source, currentBillNo);
            var remaining = source.qty().subtract(orderedQty).subtract(source.plannedQty());
            if (!"OPEN".equals(source.lineCloseStatus())
                || !"NORMAL".equals(source.lineFrozenStatus())
                || remaining.compareTo(demand.qty()) < 0) {
                throw new ResponseStatusException(HttpStatus.CONFLICT, "采购订单数量不能超过采购申请剩余可订数量");
            }
        }
    }

    private void refreshPurchaseRequisitionQuantities(
        List<LockedPurchaseRequisitionLine> sources,
        String currentBillNo
    ) {
        for (var source : sources) {
            refreshPurchaseRequisitionQuantity(source, currentBillNo);
        }
    }

    private BigDecimal refreshPurchaseRequisitionQuantity(
        LockedPurchaseRequisitionLine source,
        String currentBillNo
    ) {
        var demand = source.demand();
        var authoritativeOrderedQty = jdbcTemplate.queryForObject("""
            SELECT COALESCE(SUM(po_line.qty), 0)
            FROM purchase_order_line po_line
            JOIN purchase_order po ON po.id = po_line.order_id
            WHERE po.status = 'AUDITED'
              AND po.bill_no <> ?
              AND po_line.source_requisition_no = ?
              AND po_line.source_requisition_line_no = ?
            """, BigDecimal.class, currentBillNo, demand.sourceBillNo(), demand.sourceLineNo());
        var orderedQty = authoritativeOrderedQty == null ? BigDecimal.ZERO : authoritativeOrderedQty;
        var refreshed = jdbcTemplate.update("""
            UPDATE purchase_requisition_line
            SET ordered_qty = ?,
                updated_at = now()
            WHERE id = ?::uuid
            """, orderedQty, source.id());
        if (refreshed != 1) {
            throw new ResponseStatusException(HttpStatus.CONFLICT, "采购申请源占用已变化，本次操作已回滚");
        }
        return orderedQty;
    }

    private void markPurchaseRequisitionOrdered(List<LockedPurchaseRequisitionLine> sources) {
        for (var source : sources) {
            var updated = jdbcTemplate.update("""
                UPDATE purchase_requisition_line
                SET ordered_qty = COALESCE(ordered_qty, 0) + ?,
                    updated_at = now()
                WHERE id = ?::uuid
                """, source.demand().qty(), source.id());
            if (updated != 1) {
                throw new ResponseStatusException(HttpStatus.CONFLICT, "采购申请源占用已变化，本次审核已回滚");
            }
        }
    }

    private String sourceKey(String sourceBillNo, int sourceLineNo) {
        return sourceBillNo + "\u0000" + sourceLineNo;
    }

    private int compareUuid(UUID left, UUID right) {
        var mostSignificant = Long.compareUnsigned(left.getMostSignificantBits(), right.getMostSignificantBits());
        return mostSignificant != 0
            ? mostSignificant
            : Long.compareUnsigned(left.getLeastSignificantBits(), right.getLeastSignificantBits());
    }

    private LocalDate parseOptionalDate(String value) {
        var text = validationService.optionalText(value);
        return text == null ? null : LocalDate.parse(text);
    }

    private String optionalTextOrEmpty(String value) {
        var text = validationService.optionalText(value);
        return text == null ? "" : text;
    }

    private record PurchaseRequisitionDemand(String sourceBillNo, int sourceLineNo, BigDecimal qty) {
    }

    private record PurchaseRequisitionReference(UUID id, String billNo) {
    }

    private record LockedPurchaseRequisitionLine(
        PurchaseRequisitionDemand demand,
        String id,
        BigDecimal qty,
        BigDecimal plannedQty,
        String lineCloseStatus,
        String lineFrozenStatus
    ) {
    }

    private record LockedPurchasePlanLine(String id, BigDecimal qty) {
    }

    private record PurchasePlanDemand(
        String planId,
        String planLineId,
        String planNo,
        int planLineNo,
        BigDecimal qty
    ) {
    }
}
