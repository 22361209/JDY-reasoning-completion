package com.jdy.erp.purchase.application;

import java.math.BigDecimal;
import java.util.LinkedHashMap;
import java.util.Map;

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

    public PurchasePlanAppService(JdbcTemplate jdbcTemplate, ValidationService validationService) {
        this.jdbcTemplate = jdbcTemplate;
        this.validationService = validationService;
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
        var plan = lockPlan(normalizedBillNo);
        requireStatus(plan, BillStatus.DRAFT, "只有草稿采购计划可以审核");
        var lines = jdbcTemplate.queryForList("""
            SELECT line_no AS "lineNo", qty
            FROM purchase_plan_line
            WHERE plan_id = ?::uuid
            ORDER BY line_no
            FOR UPDATE
            """, plan.get("id"));
        if (lines.isEmpty()) {
            throw badRequest("采购计划至少需要一条分录");
        }
        for (var line : lines) {
            validationService.positive((BigDecimal) line.get("qty"), "第 " + line.get("lineNo") + " 行计划数量");
        }
        transitionLocked(plan, BillStatus.DRAFT, BillStatus.AUDITED, "采购计划状态已变化，本次审核已回滚");
        return detail(normalizedBillNo);
    }

    @Transactional
    public Map<String, Object> reverse(String billNo) {
        var normalizedBillNo = validationService.required(billNo, "采购计划单号");
        var plan = lockPlan(normalizedBillNo);
        requireStatus(plan, BillStatus.AUDITED, "只有已审核采购计划可以反审核");
        transitionLocked(plan, BillStatus.AUDITED, BillStatus.DRAFT, "采购计划状态已变化，本次反审核已回滚");
        return detail(normalizedBillNo);
    }

    private Map<String, Object> lockPlan(String billNo) {
        var rows = jdbcTemplate.queryForList("""
            SELECT id::text AS id,
                   bill_no AS "billNo",
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
