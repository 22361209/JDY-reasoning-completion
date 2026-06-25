package com.jdy.erp.production.application;

import java.math.BigDecimal;
import java.util.List;
import java.util.Map;

import com.jdy.erp.shared.application.InventoryPostingHook;
import com.jdy.erp.shared.application.LookupService;
import com.jdy.erp.shared.application.OperationLogService;
import com.jdy.erp.shared.application.PostingContext;
import com.jdy.erp.shared.application.PostingPipeline;
import com.jdy.erp.shared.application.ValidationService;
import com.jdy.erp.shared.domain.BillStatus;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.server.ResponseStatusException;

@Service
public class MaterialIssueAppService {
    private final JdbcTemplate jdbcTemplate;
    private final LookupService lookupService;
    private final ValidationService validationService;
    private final PostingPipeline postingPipeline;
    private final OperationLogService operationLogService;

    public MaterialIssueAppService(
        JdbcTemplate jdbcTemplate,
        LookupService lookupService,
        ValidationService validationService,
        PostingPipeline postingPipeline,
        OperationLogService operationLogService
    ) {
        this.jdbcTemplate = jdbcTemplate;
        this.lookupService = lookupService;
        this.validationService = validationService;
        this.postingPipeline = postingPipeline;
        this.operationLogService = operationLogService;
    }

    public Map<String, Object> detail(String billNo) {
        var billRows = jdbcTemplate.queryForList("""
            SELECT i.id::text AS id,
                   i.bill_no AS "billNo",
                   t.bill_no AS "sourceOrderNo",
                   'SC' AS "customerCode",
                   '生产车间' AS customer,
                   to_char(i.created_at, 'YYYY-MM-DD') AS "billDate",
                   '生产部' AS department,
                   i.status,
                   COALESCE(SUM(l.amount), 0) AS "totalAmount",
                   '本地管理员' AS "ownerName",
                   (
                       SELECT original.bill_no
                       FROM production_material_issue original
                       WHERE original.id = i.red_source_bill_id
                   ) AS "redSourceBillNo"
            FROM production_material_issue i
            JOIN production_task t ON t.id = i.task_id
            LEFT JOIN production_material_issue_line l ON l.issue_id = i.id
            WHERE i.bill_no = ?
            GROUP BY i.id, t.bill_no
            """, billNo);
        if (billRows.isEmpty()) {
            throw new ResponseStatusException(HttpStatus.NOT_FOUND, "生产领料单不存在");
        }
        var lines = jdbcTemplate.queryForList("""
            SELECT l.line_no AS "lineNo",
                   p.code AS "productCode",
                   p.name AS "productName",
                   COALESCE(p.spec, '') AS spec,
                   w.code AS "warehouseCode",
                   l.qty,
                   l.unit_price AS "unitPrice",
                   l.amount
            FROM production_material_issue_line l
            JOIN md_product p ON p.id = l.product_id
            JOIN md_warehouse w ON w.id = l.warehouse_id
            JOIN production_material_issue i ON i.id = l.issue_id
            WHERE i.bill_no = ?
            ORDER BY l.line_no
            """, billNo);
        return Map.of("action", "DETAIL", "document", billRows.get(0), "lines", lines);
    }

    @Transactional
    public Map<String, Object> issue(String billNo, IssueRequest request) {
        var taskRows = jdbcTemplate.queryForList("""
            SELECT id::text AS id, bom_id::text AS bom_id, qty
            FROM production_task
            WHERE bill_no = ? AND status IN ('AUDITED', 'ISSUED')
            """, billNo);
        if (taskRows.isEmpty()) {
            throw new ResponseStatusException(HttpStatus.CONFLICT, "生产任务不存在或不能领料");
        }
        var task = taskRows.get(0);
        var materialWarehouseId = lookupService.lookupEnabledId("md_warehouse", request.materialWarehouseCode(), "领料仓库");
        var materialWarehouseCode = validationService.required(request.materialWarehouseCode(), "领料仓库");
        var issueRows = jdbcTemplate.queryForList("""
            INSERT INTO production_material_issue (bill_no, task_id, status)
            VALUES (?, ?::uuid, ?)
            RETURNING id::text AS id, bill_no AS "billNo", status
            """, validationService.required(request.billNo(), "领料单号"), task.get("id"), BillStatus.AUDITED.name());
        var issueId = String.valueOf(issueRows.get(0).get("id"));
        var lines = jdbcTemplate.queryForList("""
            SELECT l.line_no AS "lineNo",
                   l.material_id::text AS "productId",
                   p.code AS "materialCode",
                   l.qty
            FROM prod_bom_line l
            JOIN md_product p ON p.id = l.material_id
            WHERE l.bom_id = ?::uuid
            ORDER BY l.line_no
            """, task.get("bom_id"));
        var taskQty = (BigDecimal) task.get("qty");
        for (var line : lines) {
            var neededQty = ((BigDecimal) line.get("qty")).multiply(taskQty);
            insertIssueLine(issueId, line.get("lineNo"), line.get("productId"), materialWarehouseId, neededQty, BigDecimal.ONE);
            post(String.valueOf(line.get("materialCode")), materialWarehouseCode, neededQty.negate(), "PRODUCTION_ISSUE", "PRODUCTION_ISSUE:" + request.billNo());
        }
        jdbcTemplate.update("""
            UPDATE production_task
            SET issued_qty = qty,
                status = CASE WHEN completed_qty >= qty THEN 'COMPLETED' ELSE 'ISSUED' END,
                updated_at = now()
            WHERE id = ?::uuid
            """, task.get("id"));
        operationLogService.log("PRODUCTION", "ISSUE", "production_material_issue", String.valueOf(issueRows.get(0).get("id")), true, null);
        return issueRows.get(0);
    }

    @Transactional
    public Map<String, Object> reverse(String billNo) {
        var rows = jdbcTemplate.queryForList("""
            UPDATE production_material_issue
            SET status = ?, reversed_at = now()
            WHERE bill_no = ? AND status = ?
            RETURNING id::text AS id, bill_no AS "billNo", status
            """, BillStatus.REVERSED.name(), billNo, BillStatus.AUDITED.name());
        if (rows.isEmpty()) {
            throw new ResponseStatusException(HttpStatus.CONFLICT, "生产领料单不存在或不能反审核");
        }
        postIssueLines(billNo, BigDecimal.ONE, "PRODUCTION_ISSUE_REVERSE", "PRODUCTION_ISSUE_REVERSE:" + billNo);
        operationLogService.log("PRODUCTION", "REVERSE_ISSUE", "production_material_issue", String.valueOf(rows.get(0).get("id")), true, null);
        return rows.get(0);
    }

    @Transactional
    public Map<String, Object> redReverse(String billNo, RedReverseRequest request) {
        var sourceRows = jdbcTemplate.queryForList("""
            SELECT id::text AS id, task_id::text AS "taskId"
            FROM production_material_issue
            WHERE bill_no = ? AND status = ?
            """, billNo, BillStatus.AUDITED.name());
        if (sourceRows.isEmpty()) {
            throw new ResponseStatusException(HttpStatus.CONFLICT, "只有已审核生产领料单可以红冲");
        }
        var redBillNo = validationService.required(request.redBillNo(), "红冲单号");
        var redRows = jdbcTemplate.queryForList("""
            INSERT INTO production_material_issue (bill_no, task_id, red_source_bill_id, status)
            VALUES (?, ?::uuid, ?::uuid, ?)
            RETURNING id::text AS id, bill_no AS "billNo", status
            """, redBillNo, sourceRows.get(0).get("taskId"), sourceRows.get(0).get("id"), BillStatus.RED_REVERSED.name());
        copyIssueLines(billNo, String.valueOf(redRows.get(0).get("id")), true);
        postIssueLines(redBillNo, BigDecimal.ONE.negate(), "PRODUCTION_ISSUE_RED", "PRODUCTION_ISSUE_RED:" + redBillNo);
        operationLogService.log("PRODUCTION", "RED_REVERSE_ISSUE", "production_material_issue", String.valueOf(redRows.get(0).get("id")), true, null);
        return redRows.get(0);
    }

    private void insertIssueLine(String issueId, Object lineNo, Object productId, Object warehouseId, BigDecimal qty, BigDecimal unitPrice) {
        jdbcTemplate.update("""
            INSERT INTO production_material_issue_line (issue_id, line_no, product_id, warehouse_id, qty, unit_price, amount)
            VALUES (?::uuid, ?, ?::uuid, ?::uuid, ?, ?, ?)
            """, issueId, lineNo, productId, warehouseId, qty, unitPrice, qty.multiply(unitPrice));
    }

    private void postIssueLines(String billNo, BigDecimal sign, String txnType, String sourceBillType) {
        var lines = jdbcTemplate.queryForList("""
            SELECT p.code AS "productCode", w.code AS "warehouseCode", l.qty
            FROM production_material_issue_line l
            JOIN md_product p ON p.id = l.product_id
            JOIN md_warehouse w ON w.id = l.warehouse_id
            JOIN production_material_issue i ON i.id = l.issue_id
            WHERE i.bill_no = ?
            ORDER BY l.line_no
            """, billNo);
        for (var line : lines) {
            post(
                String.valueOf(line.get("productCode")),
                String.valueOf(line.get("warehouseCode")),
                ((BigDecimal) line.get("qty")).multiply(sign),
                txnType,
                sourceBillType
            );
        }
    }

    private void copyIssueLines(String sourceBillNo, String targetIssueId, boolean negate) {
        var lines = jdbcTemplate.queryForList("""
            SELECT l.line_no AS "lineNo", l.product_id::text AS "productId", l.warehouse_id::text AS "warehouseId", l.qty, l.unit_price AS "unitPrice"
            FROM production_material_issue_line l
            JOIN production_material_issue i ON i.id = l.issue_id
            WHERE i.bill_no = ?
            ORDER BY l.line_no
            """, sourceBillNo);
        for (var line : lines) {
            var qty = (BigDecimal) line.get("qty");
            insertIssueLine(targetIssueId, line.get("lineNo"), line.get("productId"), line.get("warehouseId"), negate ? qty.negate() : qty, (BigDecimal) line.get("unitPrice"));
        }
    }

    private void post(String productCode, String warehouseCode, BigDecimal qty, String txnType, String sourceBillType) {
        postingPipeline.post(new PostingContext(InventoryPostingHook.CHANNEL, productCode, warehouseCode, qty, txnType, sourceBillType));
    }

    public record IssueRequest(String billNo, String materialWarehouseCode) {
    }

    public record RedReverseRequest(String redBillNo) {
    }
}
