package com.jdy.erp.production.application;

import java.math.BigDecimal;
import java.util.List;
import java.util.Map;

import com.jdy.erp.shared.application.BillLifecycleService;
import com.jdy.erp.shared.application.InventoryPostingHook;
import com.jdy.erp.shared.application.LookupService;
import com.jdy.erp.shared.application.NumberingService;
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
    private static final String BILL_TABLE = "production_material_issue";

    private final JdbcTemplate jdbcTemplate;
    private final LookupService lookupService;
    private final ValidationService validationService;
    private final PostingPipeline postingPipeline;
    private final OperationLogService operationLogService;
    private final NumberingService numberingService;
    private final BillLifecycleService lifecycleService;

    public MaterialIssueAppService(
        JdbcTemplate jdbcTemplate,
        LookupService lookupService,
        ValidationService validationService,
        PostingPipeline postingPipeline,
        OperationLogService operationLogService,
        NumberingService numberingService,
        BillLifecycleService lifecycleService
    ) {
        this.jdbcTemplate = jdbcTemplate;
        this.lookupService = lookupService;
        this.validationService = validationService;
        this.postingPipeline = postingPipeline;
        this.operationLogService = operationLogService;
        this.numberingService = numberingService;
        this.lifecycleService = lifecycleService;
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
                   l.product_id::text AS "productId",
                   COALESCE(l.product_code_snapshot, p.code) AS "productCode",
                   COALESCE(l.product_name_snapshot, p.name) AS "productName",
                   COALESCE(l.product_spec_snapshot, p.spec, '') AS spec,
                   COALESCE(l.product_unit_snapshot, p.unit, '') AS unit,
                   trim(to_char(COALESCE(l.net_weight_snapshot, p.net_weight), 'FM9999999990.00')) AS "netWeight",
                   trim(to_char(COALESCE(l.gross_weight_snapshot, p.gross_weight), 'FM9999999990.00')) AS "grossWeight",
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
    public Map<String, Object> saveDraft(IssueDraftRequest request) {
        var issueBillNo = numberingService.assignBillNo("materialIssue", request.billNo());
        var taskRows = jdbcTemplate.queryForList("""
            SELECT id::text AS id
            FROM production_task
            WHERE bill_no = ? AND status IN ('AUDITED', 'ISSUED')
            """, validationService.required(request.sourceOrderNo(), "生产任务单号"));
        if (taskRows.isEmpty()) {
            throw new ResponseStatusException(HttpStatus.CONFLICT, "生产任务不存在或不能领料");
        }
        var materialWarehouseCode = resolveMaterialWarehouseCode(request);
        var materialWarehouseId = lookupService.lookupEnabledId("md_warehouse", materialWarehouseCode, "领料仓库");
        var issueRows = jdbcTemplate.queryForList("""
            INSERT INTO production_material_issue (bill_no, task_id, status)
            VALUES (?, ?::uuid, ?)
            ON CONFLICT (bill_no) DO UPDATE
            SET task_id = EXCLUDED.task_id,
                status = EXCLUDED.status,
                updated_at = now()
            WHERE production_material_issue.status = 'DRAFT'
            RETURNING id::text AS id, bill_no AS "billNo", status
            """, issueBillNo, taskRows.get(0).get("id"), BillStatus.DRAFT.name());
        if (issueRows.isEmpty()) {
            throw new ResponseStatusException(HttpStatus.CONFLICT, "只有草稿生产领料单可以覆盖保存");
        }
        var issueId = String.valueOf(issueRows.get(0).get("id"));
        jdbcTemplate.update("DELETE FROM production_material_issue_line WHERE issue_id = ?::uuid", issueId);
        insertSnapshotIssueLines(issueId, taskRows.get(0).get("id"), materialWarehouseId);
        operationLogService.log("PRODUCTION", "SAVE_ISSUE_DRAFT", "production_material_issue", issueId, true, null);
        return issueRows.get(0);
    }

    @Transactional
    public Map<String, Object> audit(String billNo) {
        var issueRows = jdbcTemplate.queryForList("""
            SELECT i.id::text AS id,
                   i.task_id::text AS "taskId"
            FROM production_material_issue i
            JOIN production_task t ON t.id = i.task_id
            WHERE i.bill_no = ? AND i.status = ? AND t.status IN ('AUDITED', 'ISSUED')
            """, billNo, BillStatus.DRAFT.name());
        if (issueRows.isEmpty()) {
            throw new ResponseStatusException(HttpStatus.CONFLICT, "生产领料单不存在、非草稿或来源任务不能领料");
        }
        var issue = issueRows.get(0);
        validateIssueQtyWithinTask(billNo, String.valueOf(issue.get("taskId")));
        postIssueLines(billNo, BigDecimal.ONE.negate(), "PRODUCTION_ISSUE", "PRODUCTION_ISSUE:" + billNo);
        jdbcTemplate.update("""
            UPDATE production_task_material_snapshot s
            SET issued_qty = issued_qty + issued.qty
            FROM (
                SELECT line_no, SUM(qty) AS qty
                FROM production_material_issue_line
                WHERE issue_id = ?::uuid
                GROUP BY line_no
            ) issued
            WHERE s.task_id = ?::uuid
              AND s.line_no = issued.line_no
            """, issue.get("id"), issue.get("taskId"));
        jdbcTemplate.update("""
            UPDATE production_task
            SET issued_qty = LEAST(qty, (
                    SELECT COALESCE(SUM(issued_qty), 0)
                    FROM production_task_material_snapshot
                    WHERE task_id = ?::uuid
                )),
                status = CASE WHEN completed_qty >= qty THEN 'COMPLETED' ELSE 'ISSUED' END,
                updated_at = now()
            WHERE id = ?::uuid
            """, issue.get("taskId"), issue.get("taskId"));
        var rows = jdbcTemplate.queryForList("""
            UPDATE production_material_issue
            SET status = ?, updated_at = now()
            WHERE id = ?::uuid
            RETURNING id::text AS id, bill_no AS "billNo", status
            """, BillStatus.AUDITED.name(), issue.get("id"));
        operationLogService.log("PRODUCTION", "AUDIT_ISSUE", "production_material_issue", String.valueOf(issue.get("id")), true, null);
        return rows.get(0);
    }

    @Transactional
    public Map<String, Object> issue(String billNo, IssueRequest request) {
        var issueBillNo = numberingService.assignBillNo("materialIssue", request.billNo());
        var taskRows = jdbcTemplate.queryForList("""
            SELECT id::text AS id, qty
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
            """, issueBillNo, task.get("id"), BillStatus.AUDITED.name());
        var issueId = String.valueOf(issueRows.get(0).get("id"));
        var lines = jdbcTemplate.queryForList("""
            SELECT s.line_no AS "lineNo",
                   s.product_id::text AS "productId",
                   COALESCE(s.product_code_snapshot, p.code) AS "materialCode",
                   COALESCE(s.product_name_snapshot, p.name) AS "materialName",
                   COALESCE(s.product_spec_snapshot, p.spec, '') AS spec,
                   s.required_qty AS "requiredQty"
            FROM production_task_material_snapshot s
            JOIN md_product p ON p.id = s.product_id
            WHERE s.task_id = ?::uuid
            ORDER BY s.line_no
            """, task.get("id"));
        if (lines.isEmpty()) {
            throw new ResponseStatusException(HttpStatus.CONFLICT, "生产任务缺少用料快照，不能领料");
        }
        for (var line : lines) {
            var neededQty = (BigDecimal) line.get("requiredQty");
            insertIssueLine(issueId, line.get("lineNo"), line.get("productId"), line.get("materialCode"), line.get("materialName"), line.get("spec"), materialWarehouseId, neededQty, BigDecimal.ONE);
            post(String.valueOf(line.get("materialCode")), materialWarehouseCode, neededQty.negate(), "PRODUCTION_ISSUE", "PRODUCTION_ISSUE:" + issueBillNo);
        }
        jdbcTemplate.update("""
            UPDATE production_task_material_snapshot
            SET issued_qty = required_qty
            WHERE task_id = ?::uuid
            """, task.get("id"));
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

    private String resolveMaterialWarehouseCode(IssueDraftRequest request) {
        var explicit = validationService.optionalText(request.materialWarehouseCode());
        if (explicit != null) {
            return explicit;
        }
        if (request.lines() != null) {
            for (var line : request.lines()) {
                var warehouseCode = validationService.optionalText(line.warehouseCode());
                if (warehouseCode != null) {
                    return warehouseCode;
                }
            }
        }
        throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "领料仓库不能为空");
    }

    private void insertSnapshotIssueLines(String issueId, Object taskId, String materialWarehouseId) {
        var lines = jdbcTemplate.queryForList("""
            SELECT s.line_no AS "lineNo",
                   s.product_id::text AS "productId",
                   COALESCE(s.product_code_snapshot, p.code) AS "materialCode",
                   COALESCE(s.product_name_snapshot, p.name) AS "materialName",
                   COALESCE(s.product_spec_snapshot, p.spec, '') AS spec,
                   s.required_qty - s.issued_qty AS "remainingQty"
            FROM production_task_material_snapshot s
            JOIN md_product p ON p.id = s.product_id
            WHERE s.task_id = ?::uuid
            ORDER BY s.line_no
            """, taskId);
        if (lines.isEmpty()) {
            throw new ResponseStatusException(HttpStatus.CONFLICT, "生产任务缺少用料快照，不能领料");
        }
        for (var line : lines) {
            var remainingQty = (BigDecimal) line.get("remainingQty");
            if (remainingQty.compareTo(BigDecimal.ZERO) > 0) {
                insertIssueLine(issueId, line.get("lineNo"), line.get("productId"), line.get("materialCode"), line.get("materialName"), line.get("spec"), materialWarehouseId, remainingQty, BigDecimal.ONE);
            }
        }
    }

    private void validateIssueQtyWithinTask(String billNo, String taskId) {
        var violations = jdbcTemplate.queryForList("""
            SELECT s.line_no
            FROM production_task_material_snapshot s
            JOIN (
                SELECT line_no, SUM(qty) AS qty
                FROM production_material_issue_line l
                JOIN production_material_issue i ON i.id = l.issue_id
                WHERE i.bill_no = ?
                GROUP BY line_no
            ) issued ON issued.line_no = s.line_no
            WHERE s.task_id = ?::uuid
              AND s.issued_qty + issued.qty > s.required_qty
            """, billNo, taskId);
        if (!violations.isEmpty()) {
            throw new ResponseStatusException(HttpStatus.CONFLICT, "领料数量不能超过生产任务剩余用料");
        }
    }

    @Transactional
    public Map<String, Object> reverse(String billNo) {
        var row = lifecycleService.transition(
            BILL_TABLE,
            billNo,
            BillStatus.AUDITED,
            BillStatus.DRAFT,
            "id::text AS id, bill_no AS \"billNo\", status",
            "PRODUCTION",
            "REVERSE_ISSUE",
            "production_material_issue",
            "生产领料单不存在或不能反审核"
        );
        postIssueLines(billNo, BigDecimal.ONE, "PRODUCTION_ISSUE_REVERSE", "PRODUCTION_ISSUE_REVERSE:" + billNo);
        return row;
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

    private void insertIssueLine(String issueId, Object lineNo, Object productId, Object productCode, Object productName, Object spec, Object warehouseId, BigDecimal qty, BigDecimal unitPrice) {
        jdbcTemplate.update("""
            INSERT INTO production_material_issue_line (issue_id, line_no, product_id, product_code_snapshot, product_name_snapshot, product_spec_snapshot, warehouse_id, qty, unit_price, amount)
            VALUES (?::uuid, ?, ?::uuid, ?, ?, ?, ?::uuid, ?, ?, ?)
            """, issueId, lineNo, productId, productCode, productName, spec, warehouseId, qty, unitPrice, qty.multiply(unitPrice));
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
            SELECT l.line_no AS "lineNo",
                   l.product_id::text AS "productId",
                   l.product_code_snapshot AS "productCode",
                   l.product_name_snapshot AS "productName",
                   l.product_spec_snapshot AS spec,
                   l.warehouse_id::text AS "warehouseId",
                   l.qty,
                   l.unit_price AS "unitPrice"
            FROM production_material_issue_line l
            JOIN production_material_issue i ON i.id = l.issue_id
            WHERE i.bill_no = ?
            ORDER BY l.line_no
            """, sourceBillNo);
        for (var line : lines) {
            var qty = (BigDecimal) line.get("qty");
            insertIssueLine(targetIssueId, line.get("lineNo"), line.get("productId"), line.get("productCode"), line.get("productName"), line.get("spec"), line.get("warehouseId"), negate ? qty.negate() : qty, (BigDecimal) line.get("unitPrice"));
        }
    }

    private void post(String productCode, String warehouseCode, BigDecimal qty, String txnType, String sourceBillType) {
        postingPipeline.post(new PostingContext(InventoryPostingHook.CHANNEL, productCode, warehouseCode, qty, txnType, sourceBillType));
    }

    public record IssueRequest(String billNo, String materialWarehouseCode) {
    }

    public record IssueDraftRequest(String billNo, String sourceOrderNo, String materialWarehouseCode, List<IssueLineRequest> lines) {
    }

    public record IssueLineRequest(String warehouseCode) {
    }

    public record RedReverseRequest(String redBillNo) {
    }
}
