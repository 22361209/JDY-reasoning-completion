package com.jdy.erp.purchase.application;

import java.math.BigDecimal;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.TreeMap;
import java.util.UUID;

import com.jdy.erp.purchase.application.PurchaseOrderAppService.PurchaseOrderDraftRequest;
import com.jdy.erp.purchase.application.PurchaseOrderAppService.PurchaseOrderLineRequest;
import com.jdy.erp.shared.application.OperationLogCommand;
import com.jdy.erp.shared.application.OperationLogService;
import com.jdy.erp.shared.application.ValidationService;
import com.jdy.erp.shared.domain.BillStatus;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.server.ResponseStatusException;

@Service
public class PurchasePlanAppService {
    private final JdbcTemplate jdbcTemplate;
    private final ValidationService validationService;
    private final OperationLogService operationLogService;
    private final PurchaseOrderAppService purchaseOrderAppService;

    public PurchasePlanAppService(
        JdbcTemplate jdbcTemplate,
        ValidationService validationService,
        OperationLogService operationLogService,
        PurchaseOrderAppService purchaseOrderAppService
    ) {
        this.jdbcTemplate = jdbcTemplate;
        this.validationService = validationService;
        this.operationLogService = operationLogService;
        this.purchaseOrderAppService = purchaseOrderAppService;
    }

    public Map<String, Object> detail(String billNo) {
        var normalizedBillNo = validationService.required(billNo, "采购计划单号");
        var headers = jdbcTemplate.queryForList("""
            SELECT plan.id::text AS id,
                   plan.bill_no AS "billNo",
                   plan.source_requisition_id::text AS "sourceRequisitionId",
                   plan.source_requisition_no AS "sourceRequisitionNo",
                   plan.supplier_id::text AS "supplierId",
                   COALESCE(plan.supplier_code_snapshot, supplier.code) AS "supplierCode",
                   COALESCE(plan.supplier_name_snapshot, supplier.name) AS "supplierName",
                   to_char(plan.bill_date, 'YYYY-MM-DD') AS "billDate",
                   plan.department,
                   plan.status,
                   plan.owner_name AS "ownerName",
                   to_char(plan.created_at, 'YYYY-MM-DD HH24:MI:SS') AS "createdAt",
                   to_char(plan.updated_at, 'YYYY-MM-DD HH24:MI:SS') AS "updatedAt",
                   plan.version
            FROM purchase_plan plan
            JOIN md_supplier supplier ON supplier.id = plan.supplier_id
            WHERE plan.bill_no = ?
            """, normalizedBillNo);
        if (headers.isEmpty()) {
            throw notFound("采购计划不存在");
        }
        var lines = jdbcTemplate.queryForList("""
            SELECT line.id::text AS id,
                   line.line_no AS "lineNo",
                   line.source_requisition_line_id::text AS "sourceRequisitionLineId",
                   line.source_requisition_no AS "sourceRequisitionNo",
                   line.source_requisition_line_no AS "sourceRequisitionLineNo",
                   line.product_id::text AS "productId",
                   COALESCE(line.product_code_snapshot, product.code) AS "productCode",
                   COALESCE(line.product_name_snapshot, product.name) AS "productName",
                   COALESCE(line.product_spec_snapshot, product.spec, '') AS spec,
                   COALESCE(line.product_unit_snapshot, product.unit, '') AS unit,
                   COALESCE(line.net_weight_snapshot, product.net_weight) AS "netWeight",
                   COALESCE(line.gross_weight_snapshot, product.gross_weight) AS "grossWeight",
                   line.warehouse_id::text AS "warehouseId",
                   warehouse.code AS "warehouseCode",
                   line.qty,
                   COALESCE(line.ordered_qty, 0) AS "orderedQty",
                   GREATEST(line.qty - COALESCE(line.ordered_qty, 0), 0) AS "remainingOrderQty",
                   to_char(line.plan_delivery_date, 'YYYY-MM-DD') AS "planDeliveryDate"
            FROM purchase_plan plan
            JOIN purchase_plan_line line ON line.plan_id = plan.id
            JOIN md_product product ON product.id = line.product_id
            LEFT JOIN md_warehouse warehouse ON warehouse.id = line.warehouse_id
            WHERE plan.bill_no = ?
            ORDER BY line.line_no
            """, normalizedBillNo);
        var totalQty = lines.stream()
            .map(line -> (BigDecimal) line.get("qty"))
            .reduce(BigDecimal.ZERO, BigDecimal::add);
        var document = new LinkedHashMap<String, Object>(headers.get(0));
        document.put("totalQty", totalQty);
        document.put("lineCount", lines.size());
        return Map.of(
            "action", "DETAIL",
            "document", document,
            "lines", lines
        );
    }

    @Transactional
    public Map<String, Object> audit(String billNo) {
        var normalizedBillNo = validationService.required(billNo, "采购计划单号");
        var planReference = findPlanReference(normalizedBillNo);
        var sourceRequisitionId = String.valueOf(planReference.get("sourceRequisitionId"));
        lockSourceRequisition(sourceRequisitionId, true);
        lockSourceRequisitionLines(sourceRequisitionId);
        var lines = sourceLineDemands(String.valueOf(planReference.get("id")));
        var plan = lockPlan(normalizedBillNo);
        requireSameSourceRequisition(plan, sourceRequisitionId);
        requireStatus(plan, BillStatus.DRAFT, "只有草稿采购计划可以审核");
        reserveSourceRequisitionLines(sourceRequisitionId, lines);
        transitionLocked(plan, BillStatus.DRAFT, BillStatus.AUDITED, "采购计划状态已变化，本次审核已回滚");
        return detail(normalizedBillNo);
    }

    @Transactional
    public Map<String, Object> reverse(String billNo) {
        var normalizedBillNo = validationService.required(billNo, "采购计划单号");
        var planReference = findPlanReference(normalizedBillNo);
        var sourceRequisitionId = String.valueOf(planReference.get("sourceRequisitionId"));
        lockSourceRequisition(sourceRequisitionId, false);
        lockSourceRequisitionLines(sourceRequisitionId);
        var lines = sourceLineDemands(String.valueOf(planReference.get("id")));
        var plan = lockPlan(normalizedBillNo);
        requireSameSourceRequisition(plan, sourceRequisitionId);
        requireStatus(plan, BillStatus.AUDITED, "只有已审核采购计划可以反审核");
        requireNoAuditedPurchaseOrders(String.valueOf(plan.get("id")));
        releaseSourceRequisitionLines(sourceRequisitionId, lines);
        transitionLocked(plan, BillStatus.AUDITED, BillStatus.DRAFT, "采购计划状态已变化，本次反审核已回滚");
        return detail(normalizedBillNo);
    }

    @Transactional
    public Map<String, Object> pushDownOrder(String billNo) {
        var normalizedBillNo = validationService.required(billNo, "采购计划单号");
        var plan = lockPlan(normalizedBillNo);
        requireStatus(plan, BillStatus.AUDITED, "只有已审核采购计划可以下推采购订单");
        var rows = jdbcTemplate.queryForList("""
            SELECT plan.id::text AS "planId",
                   plan.bill_no AS "planNo",
                   plan.supplier_code_snapshot AS "supplierCode",
                   to_char(plan.bill_date, 'YYYY-MM-DD') AS "billDate",
                   COALESCE(plan.department, '采购部') AS department,
                   COALESCE(plan.owner_name, '') AS "ownerName",
                   line.id::text AS "planLineId",
                   line.line_no AS "planLineNo",
                   line.product_id::text AS "productId",
                   line.product_code_snapshot AS "productCode",
                   warehouse.code AS "warehouseCode",
                   GREATEST(line.qty - COALESCE(line.ordered_qty, 0), 0) AS qty,
                   COALESCE(product.purchase_price, 0) AS "unitPrice",
                   COALESCE(product.tax_rate, 13) AS "taxRate",
                   to_char(line.plan_delivery_date, 'YYYY-MM-DD') AS "planDeliveryDate"
            FROM purchase_plan plan
            JOIN purchase_plan_line line ON line.plan_id = plan.id
            JOIN md_product product ON product.id = line.product_id
            LEFT JOIN md_warehouse warehouse ON warehouse.id = line.warehouse_id
            WHERE plan.id = ?::uuid
              AND line.qty - COALESCE(line.ordered_qty, 0) > 0
            ORDER BY line.line_no
            """, plan.get("id"));
        if (rows.isEmpty()) {
            throw conflict("采购计划没有剩余可下单数量");
        }
        for (var row : rows) {
            if (row.get("warehouseCode") == null) {
                throw conflict("采购计划第 " + row.get("planLineNo") + " 行未指定有效仓库，不能下推采购订单");
            }
        }
        var first = rows.get(0);
        var lines = rows.stream().map(row -> new PurchaseOrderLineRequest(
            String.valueOf(row.get("productId")), String.valueOf(row.get("productCode")),
            String.valueOf(row.get("warehouseCode")), (BigDecimal) row.get("qty"),
            (BigDecimal) row.get("unitPrice"), (BigDecimal) row.get("taxRate"), "", "",
            null, null, row.get("planDeliveryDate") == null ? null : String.valueOf(row.get("planDeliveryDate")),
            String.valueOf(row.get("planId")), String.valueOf(row.get("planLineId")),
            String.valueOf(row.get("planNo")), ((Number) row.get("planLineNo")).intValue()
        )).toList();
        var order = purchaseOrderAppService.saveDraft(new PurchaseOrderDraftRequest(
            "", String.valueOf(first.get("supplierCode")), String.valueOf(first.get("billDate")),
            String.valueOf(first.get("department")), String.valueOf(first.get("ownerName")), "CNY", lines
        ));
        return Map.of("purchaseOrderBillNo", order.get("billNo"));
    }

    @Transactional
    public Map<String, Object> deleteDraft(String billNo) {
        var normalizedBillNo = validationService.required(billNo, "采购计划单号");
        var planReference = findPlanReference(normalizedBillNo);
        var sourceRequisitionId = String.valueOf(planReference.get("sourceRequisitionId"));
        lockSourceRequisition(sourceRequisitionId, false);
        lockSourceRequisitionLines(sourceRequisitionId);
        var plan = lockPlan(normalizedBillNo);
        requireSameSourceRequisition(plan, sourceRequisitionId);
        requireStatus(plan, BillStatus.DRAFT, "只有草稿采购计划可以删除");
        var version = plan.get("version");
        if (!(version instanceof Number number)) {
            throw new IllegalStateException("purchase_plan.version 不是数值");
        }
        var deleted = jdbcTemplate.update("""
            DELETE FROM purchase_plan
            WHERE id = ?::uuid
              AND status = 'DRAFT'
              AND version = ?
            """, plan.get("id"), number.longValue());
        if (deleted != 1) {
            throw conflict("采购计划状态已变化，本次删除已回滚");
        }
        operationLogService.logCurrent(OperationLogCommand.success(
            "PURCHASE",
            "DELETE_PURCHASE_PLAN_DRAFT",
            "purchase_plan",
            UUID.fromString(String.valueOf(plan.get("id"))),
            normalizedBillNo,
            OperationLogCommand.state(
                OperationLogCommand.StateField.STATUS, BillStatus.DRAFT.name(),
                OperationLogCommand.StateField.VERSION, number.longValue()
            ),
            OperationLogCommand.state(
                OperationLogCommand.StateField.STATUS, "DELETED",
                OperationLogCommand.StateField.VERSION, number.longValue()
            )
        ));
        return Map.of("billNo", normalizedBillNo, "status", "DELETED");
    }

    private Map<String, Object> findPlanReference(String billNo) {
        var rows = jdbcTemplate.queryForList("""
            SELECT id::text AS id,
                   source_requisition_id::text AS "sourceRequisitionId"
            FROM purchase_plan
            WHERE bill_no = ?
            """, billNo);
        if (rows.isEmpty()) {
            throw notFound("采购计划不存在");
        }
        return rows.get(0);
    }

    private void lockSourceRequisition(String sourceRequisitionId, boolean requireAudited) {
        var rows = jdbcTemplate.queryForList("""
            SELECT status
            FROM purchase_requisition
            WHERE id = ?::uuid
            FOR UPDATE
            """, sourceRequisitionId);
        if (rows.isEmpty()) {
            throw conflict("采购计划来源采购申请不存在");
        }
        if (requireAudited && !BillStatus.AUDITED.name().equals(String.valueOf(rows.get(0).get("status")))) {
            throw conflict("采购计划来源采购申请未审核，不能审核采购计划");
        }
    }

    private void lockSourceRequisitionLines(String sourceRequisitionId) {
        jdbcTemplate.queryForList("""
            SELECT id::text AS id
            FROM purchase_requisition_line
            WHERE requisition_id = ?::uuid
            ORDER BY id
            FOR UPDATE
            """, sourceRequisitionId);
    }

    private List<Map<String, Object>> sourceLineDemands(String planId) {
        var lines = jdbcTemplate.queryForList("""
            SELECT line_no AS "lineNo",
                   source_requisition_line_id::text AS "sourceRequisitionLineId",
                   qty
            FROM purchase_plan_line
            WHERE plan_id = ?::uuid
            ORDER BY line_no
            """, planId);
        if (lines.isEmpty()) {
            throw badRequest("采购计划至少需要一条分录");
        }
        for (var line : lines) {
            validationService.positive((BigDecimal) line.get("qty"), "第 " + line.get("lineNo") + " 行计划数量");
        }
        return lines;
    }

    private void reserveSourceRequisitionLines(String sourceRequisitionId, List<Map<String, Object>> lines) {
        for (var entry : sourceLineQuantities(lines).entrySet()) {
            var updated = jdbcTemplate.update("""
                UPDATE purchase_requisition_line
                SET planned_qty = planned_qty + ?,
                    updated_at = now()
                WHERE requisition_id = ?::uuid
                  AND id = ?::uuid
                  AND qty - COALESCE(ordered_qty, 0) - COALESCE(planned_qty, 0) >= ?
                """, entry.getValue(), sourceRequisitionId, entry.getKey(), entry.getValue());
            if (updated != 1) {
                throw conflict("采购计划数量不能超过采购申请剩余可计划数量");
            }
        }
    }

    private void releaseSourceRequisitionLines(String sourceRequisitionId, List<Map<String, Object>> lines) {
        for (var entry : sourceLineQuantities(lines).entrySet()) {
            var updated = jdbcTemplate.update("""
                UPDATE purchase_requisition_line
                SET planned_qty = planned_qty - ?,
                    updated_at = now()
                WHERE requisition_id = ?::uuid
                  AND id = ?::uuid
                  AND COALESCE(planned_qty, 0) >= ?
                """, entry.getValue(), sourceRequisitionId, entry.getKey(), entry.getValue());
            if (updated != 1) {
                throw conflict("采购计划来源占用已变化，不能反审核");
            }
        }
    }

    private void requireNoAuditedPurchaseOrders(String planId) {
        var ordered = jdbcTemplate.queryForObject("""
            SELECT COUNT(*)
            FROM purchase_order_line line
            JOIN purchase_order purchase_order ON purchase_order.id = line.order_id
            WHERE line.source_purchase_plan_id = ?::uuid
              AND purchase_order.status = 'AUDITED'
            """, Long.class, planId);
        if (ordered != null && ordered > 0) {
            throw conflict("采购计划已有已审核采购订单，不能反审核");
        }
    }

    private Map<String, BigDecimal> sourceLineQuantities(List<Map<String, Object>> lines) {
        var quantities = new TreeMap<String, BigDecimal>();
        for (var line : lines) {
            var sourceLineId = String.valueOf(line.get("sourceRequisitionLineId"));
            quantities.merge(sourceLineId, (BigDecimal) line.get("qty"), BigDecimal::add);
        }
        return quantities;
    }

    private Map<String, Object> lockPlan(String billNo) {
        var rows = jdbcTemplate.queryForList("""
            SELECT id::text AS id,
                   bill_no AS "billNo",
                   source_requisition_id::text AS "sourceRequisitionId",
                   status,
                   version
            FROM purchase_plan
            WHERE bill_no = ?
            FOR UPDATE
            """, billNo);
        if (rows.isEmpty()) {
            throw notFound("采购计划不存在");
        }
        return rows.get(0);
    }

    private void requireSameSourceRequisition(Map<String, Object> plan, String sourceRequisitionId) {
        if (!sourceRequisitionId.equals(String.valueOf(plan.get("sourceRequisitionId")))) {
            throw conflict("采购计划来源采购申请已变化，本次操作已回滚");
        }
    }

    private void requireStatus(Map<String, Object> plan, BillStatus expected, String message) {
        if (!expected.name().equals(String.valueOf(plan.get("status")))) {
            throw conflict(message);
        }
    }

    private void transitionLocked(
        Map<String, Object> plan,
        BillStatus from,
        BillStatus to,
        String conflictMessage
    ) {
        var version = plan.get("version");
        if (!(version instanceof Number number)) {
            throw new IllegalStateException("purchase_plan.version 不是数值");
        }
        var updated = jdbcTemplate.update("""
            UPDATE purchase_plan
            SET status = ?,
                updated_at = now(),
                version = version + 1
            WHERE id = ?::uuid
              AND status = ?
              AND version = ?
            """, to.name(), plan.get("id"), from.name(), number.longValue());
        if (updated != 1) {
            throw conflict(conflictMessage);
        }
    }

    private ResponseStatusException badRequest(String message) {
        return new ResponseStatusException(HttpStatus.BAD_REQUEST, message);
    }

    private ResponseStatusException conflict(String message) {
        return new ResponseStatusException(HttpStatus.CONFLICT, message);
    }

    private ResponseStatusException notFound(String message) {
        return new ResponseStatusException(HttpStatus.NOT_FOUND, message);
    }
}
