package com.jdy.erp.production.application;

import java.math.BigDecimal;
import java.util.List;
import java.util.Map;
import java.util.UUID;

import com.jdy.erp.inventory.application.InventoryPostingCommand;
import com.jdy.erp.inventory.application.InventoryPostingCommand.PostingAction;
import com.jdy.erp.inventory.application.InventoryTraceLifecycleService;
import com.jdy.erp.shared.application.BillLifecycleService;
import com.jdy.erp.shared.application.LookupService;
import com.jdy.erp.shared.application.NumberingService;
import com.jdy.erp.shared.application.OperationLogCommand;
import com.jdy.erp.shared.application.OperationLogService;
import com.jdy.erp.shared.application.PostingContext;
import com.jdy.erp.shared.application.PostingPipeline;
import com.jdy.erp.shared.application.RedReverseGuardService;
import com.jdy.erp.shared.application.ValidationService;
import com.jdy.erp.shared.domain.BillStatus;
import com.jdy.erp.system.tenant.TenantDataScopeService;
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
    private final TenantDataScopeService tenantDataScopeService;
    private final RedReverseGuardService redReverseGuardService;
    private final InventoryTraceLifecycleService inventoryTraceLifecycleService;

    public MaterialIssueAppService(
        JdbcTemplate jdbcTemplate,
        LookupService lookupService,
        ValidationService validationService,
        PostingPipeline postingPipeline,
        OperationLogService operationLogService,
        NumberingService numberingService,
        BillLifecycleService lifecycleService,
        TenantDataScopeService tenantDataScopeService,
        RedReverseGuardService redReverseGuardService,
        InventoryTraceLifecycleService inventoryTraceLifecycleService
    ) {
        this.jdbcTemplate = jdbcTemplate;
        this.lookupService = lookupService;
        this.validationService = validationService;
        this.postingPipeline = postingPipeline;
        this.operationLogService = operationLogService;
        this.numberingService = numberingService;
        this.lifecycleService = lifecycleService;
        this.tenantDataScopeService = tenantDataScopeService;
        this.redReverseGuardService = redReverseGuardService;
        this.inventoryTraceLifecycleService = inventoryTraceLifecycleService;
    }

    public Map<String, Object> detail(String billNo) {
        var billRows = jdbcTemplate.queryForList("""
            SELECT i.id::text AS id,
                   i.bill_no AS "billNo",
                   t.bill_no AS "sourceOrderNo",
                   'SC' AS "customerCode",
                   COALESCE(t.product_name_snapshot, task_product.name, '生产车间') AS customer,
                   to_char(i.created_at AT TIME ZONE 'Asia/Shanghai', 'YYYY-MM-DD') AS "billDate",
                   '生产部' AS department,
                   i.status,
	                   i.close_status AS "closeStatus",
	                   i.frozen_status AS "frozenStatus",
	                   COALESCE(SUM(l.amount), 0) AS "totalAmount",
	                   '本地管理员' AS "ownerName",
	                   (
	                       SELECT red.bill_no
	                       FROM production_material_issue red
	                       WHERE red.red_source_bill_id = i.id
	                         AND red.status <> 'VOID'
	                       LIMIT 1
	                   ) AS "redReverseBillNo",
	                   (
	                       SELECT original.bill_no
	                       FROM production_material_issue original
                       WHERE original.id = i.red_source_bill_id
                   ) AS "redSourceBillNo"
            FROM production_material_issue i
            JOIN production_task t ON t.id = i.task_id
            JOIN md_product task_product ON task_product.id = t.product_id
            LEFT JOIN production_material_issue_line l ON l.issue_id = i.id
            WHERE i.bill_no = ?
            GROUP BY i.id, t.bill_no, t.product_name_snapshot, task_product.name
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
                   l.line_no AS "sourceLineNo",
                   CASE
                       WHEN i.status = 'DRAFT' THEN GREATEST(COALESCE(s.required_qty, l.qty) - COALESCE(s.issued_qty, 0), 0)
                       ELSE l.qty
                   END AS "remainingQty",
                   COALESCE(stock.qty_on_hand, 0) AS "stockOnHand",
                   COALESCE(stock.qty_reserved, 0) AS "stockReserved",
                   COALESCE(stock.qty_available, 0) AS "stockAvailable",
                   0 AS "stockInTransit",
                   l.qty,
                   l.unit_price AS "unitPrice",
                   l.amount
            FROM production_material_issue_line l
            JOIN md_product p ON p.id = l.product_id
            JOIN md_warehouse w ON w.id = l.warehouse_id
            JOIN production_material_issue i ON i.id = l.issue_id
            LEFT JOIN production_task_material_snapshot s ON s.task_id = i.task_id AND s.line_no = l.line_no
            LEFT JOIN inv_stock_balance stock ON stock.product_id = l.product_id AND stock.warehouse_id = l.warehouse_id AND stock.account_set_id = ?::uuid
            WHERE i.bill_no = ?
            ORDER BY l.line_no
            """, inventoryScopeId(), billNo);
        var productRows = jdbcTemplate.queryForList("""
            SELECT COALESCE(t.product_code_snapshot, p.code) AS "productCode",
                   COALESCE(t.product_name_snapshot, p.name) AS "productName",
                   COALESCE(t.product_spec_snapshot, p.spec, '') AS spec,
                   COALESCE(p.unit, '') AS unit,
                   w.code AS "warehouseCode",
                   t.qty AS "taskQty",
                   GREATEST(t.qty - t.completed_qty, 0) AS "remainingQty",
                   t.bom_code_snapshot AS "bomCode",
                   t.bom_version_no AS "bomVersionNo"
            FROM production_material_issue i
            JOIN production_task t ON t.id = i.task_id
            JOIN md_product p ON p.id = t.product_id
            JOIN md_warehouse w ON w.id = t.warehouse_id
            WHERE i.bill_no = ?
            """, billNo);
        return Map.of(
            "action", "DETAIL",
            "document", billRows.get(0),
            "productInfo", productRows.isEmpty() ? Map.of() : productRows.get(0),
            "lines", lines
        );
    }

    @Transactional
    public Map<String, Object> saveDraft(IssueDraftRequest request) {
        var issueBillNo = numberingService.assignBillNo("materialIssue", request.billNo());
        redReverseGuardService.assertNotRedDraftForBillNo(BILL_TABLE, issueBillNo, "生产领料单");
        var taskRows = jdbcTemplate.queryForList("""
            SELECT id::text AS id
            FROM production_task
            WHERE bill_no = ?
              AND status = 'AUDITED'
              AND close_status = 'OPEN'
              AND frozen_status = 'NORMAL'
            """, validationService.required(request.sourceOrderNo(), "生产任务单号"));
        if (taskRows.isEmpty()) {
            throw new ResponseStatusException(HttpStatus.CONFLICT, "生产任务不存在或不能领料");
        }
        var materialWarehouseCode = resolveMaterialWarehouseCode(request);
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
        assertNoNonVoidMaterialScrap(issueId, "覆盖保存");
        inventoryTraceLifecycleService.prepareForLineReplacement("PRODUCTION_MATERIAL_ISSUE", issueId);
        jdbcTemplate.update("DELETE FROM production_material_issue_line WHERE issue_id = ?::uuid", issueId);
        insertSnapshotIssueLines(issueId, taskRows.get(0).get("id"), materialWarehouseCode, request.lines());
        operationLogService.logCurrent(OperationLogCommand.success(
            "PRODUCTION", "SAVE_ISSUE_DRAFT", "production_material_issue",
            UUID.fromString(issueId), issueBillNo, Map.of(),
            OperationLogCommand.state(OperationLogCommand.StateField.STATUS, String.valueOf(issueRows.get(0).get("status")))
        ));
        return issueRows.get(0);
    }

    public Map<String, Object> previewFromTask(String taskBillNo) {
        var taskRows = jdbcTemplate.queryForList("""
            SELECT t.id::text AS id,
                   t.bill_no AS "sourceOrderNo",
                   to_char(CURRENT_DATE, 'YYYY-MM-DD') AS "billDate",
                   COALESCE(t.department_code, '生产部') AS department,
                   t.status,
                   t.close_status AS "closeStatus",
                   t.frozen_status AS "frozenStatus"
            FROM production_task t
            WHERE t.bill_no = ?
              AND t.status <> 'VOID'
            """, validationService.required(taskBillNo, "生产任务单号"));
        if (taskRows.isEmpty()) {
            throw new ResponseStatusException(HttpStatus.CONFLICT, "生产任务不存在或已作废");
        }
        var task = taskRows.get(0);
        var productRows = jdbcTemplate.queryForList("""
            SELECT COALESCE(t.product_code_snapshot, p.code) AS "productCode",
                   COALESCE(t.product_name_snapshot, p.name) AS "productName",
                   COALESCE(t.product_spec_snapshot, p.spec, '') AS spec,
                   COALESCE(p.unit, '') AS unit,
                   w.code AS "warehouseCode",
                   t.qty AS "taskQty",
                   GREATEST(t.qty - t.completed_qty, 0) AS "remainingQty",
                   t.bom_code_snapshot AS "bomCode",
                   t.bom_version_no AS "bomVersionNo"
            FROM production_task t
            JOIN md_product p ON p.id = t.product_id
            JOIN md_warehouse w ON w.id = t.warehouse_id
            WHERE t.id = ?::uuid
            """, task.get("id"));
        var lines = jdbcTemplate.queryForList("""
            SELECT s.line_no AS "lineNo",
                   s.line_no AS "sourceLineNo",
                   s.product_id::text AS "productId",
                   COALESCE(s.product_code_snapshot, p.code) AS "productCode",
                   COALESCE(s.product_name_snapshot, p.name) AS "productName",
                   COALESCE(s.product_spec_snapshot, p.spec, '') AS spec,
                   COALESCE(s.product_unit_snapshot, p.unit, '') AS unit,
                   trim(to_char(COALESCE(s.net_weight_snapshot, p.net_weight), 'FM9999999990.00')) AS "netWeight",
                   trim(to_char(COALESCE(s.gross_weight_snapshot, p.gross_weight), 'FM9999999990.00')) AS "grossWeight",
                   COALESCE(w.code, '') AS "warehouseCode",
                   GREATEST(s.required_qty - s.issued_qty, 0) AS "remainingQty",
                   COALESCE(stock.qty_on_hand, 0) AS "stockOnHand",
                   COALESCE(stock.qty_reserved, 0) AS "stockReserved",
                   COALESCE(stock.qty_available, 0) AS "stockAvailable",
                   0 AS "stockInTransit",
                   GREATEST(s.required_qty - s.issued_qty, 0) AS qty
            FROM production_task_material_snapshot s
            JOIN md_product p ON p.id = s.product_id
            LEFT JOIN prod_bom_line bom_line ON bom_line.id = s.source_bom_line_id
            LEFT JOIN md_warehouse w ON w.id = COALESCE(bom_line.issue_warehouse_id, p.default_warehouse_id)
            LEFT JOIN inv_stock_balance stock ON stock.product_id = s.product_id
                 AND stock.warehouse_id = COALESCE(bom_line.issue_warehouse_id, p.default_warehouse_id)
                 AND stock.account_set_id = ?::uuid
            WHERE s.task_id = ?::uuid
              AND s.required_qty - s.issued_qty > 0
            ORDER BY s.line_no
            """, inventoryScopeId(), task.get("id"));
        if (lines.isEmpty()) {
            throw new ResponseStatusException(HttpStatus.CONFLICT, "生产任务没有剩余可领子件");
        }
        if (lines.stream().anyMatch(line -> line.get("warehouseCode") == null || validationService.optionalText(String.valueOf(line.get("warehouseCode"))) == null)) {
            throw new ResponseStatusException(HttpStatus.CONFLICT, "子件发料仓库未配置");
        }
        return Map.of(
            "action", "PREVIEW",
            "document", task,
            "productInfo", productRows.isEmpty() ? Map.of() : productRows.get(0),
            "lines", lines
        );
    }

	    @Transactional
	    public Map<String, Object> audit(String billNo) {
	        var issueRows = jdbcTemplate.queryForList("""
	            SELECT i.id::text AS id,
	                   i.bill_no AS "billNo",
	                   (i.created_at AT TIME ZONE 'Asia/Shanghai')::date AS "billDate",
	                   i.task_id::text AS "taskId",
	                   i.red_source_bill_id::text AS "redSourceBillId",
	                   t.status AS "taskStatus",
	                   t.close_status AS "taskCloseStatus",
	                   t.frozen_status AS "taskFrozenStatus"
	            FROM production_material_issue i
	            JOIN production_task t ON t.id = i.task_id
	            WHERE i.bill_no = ?
	              AND i.status = ?
	            FOR UPDATE OF i, t
	            """, billNo, BillStatus.DRAFT.name());
	        if (issueRows.isEmpty()) {
	            throw new ResponseStatusException(HttpStatus.CONFLICT, "生产领料单不存在、非草稿或来源任务不能领料");
	        }
	        var issue = issueRows.get(0);
	        if (isRedBill(issue)) {
	            return auditRedBill(issue, billNo);
	        }
	        requireExecutableTask(issue, "领料");
	        validateIssueQtyWithinTask(billNo, String.valueOf(issue.get("taskId")));
	        postIssueLines(billNo, BigDecimal.ONE.negate(), "PRODUCTION_ISSUE", PostingAction.AUDIT);
	        applyIssueQtyToTask(issue.get("id"), issue.get("taskId"));
	        var rows = markAudited(issue.get("id"));
	        operationLogService.logCurrent(OperationLogCommand.success(
	            "PRODUCTION", "AUDIT_ISSUE", "production_material_issue",
	            UUID.fromString(String.valueOf(issue.get("id"))), billNo,
	            OperationLogCommand.state(OperationLogCommand.StateField.STATUS, BillStatus.DRAFT.name()),
	            OperationLogCommand.state(OperationLogCommand.StateField.STATUS, String.valueOf(rows.get(0).get("status")))
	        ));
	        return rows.get(0);
	    }

	    private Map<String, Object> auditRedBill(Map<String, Object> issue, String billNo) {
	        validateRedSourceStillAudited(issue.get("redSourceBillId"));
	        validateRedIssueLinesMatchSource(billNo, issue.get("redSourceBillId"));
	        validateRedIssueQtyWithinTask(issue.get("id"), issue.get("taskId"));
	        postIssueLines(billNo, BigDecimal.ONE.negate(), "PRODUCTION_ISSUE_RED", PostingAction.RED_AUDIT);
	        applyIssueQtyToTask(issue.get("id"), issue.get("taskId"));
	        var rows = markAudited(issue.get("id"));
	        operationLogService.logCurrent(OperationLogCommand.success(
	            "PRODUCTION", "AUDIT_RED_ISSUE", "production_material_issue",
	            UUID.fromString(String.valueOf(issue.get("id"))), billNo,
	            OperationLogCommand.state(OperationLogCommand.StateField.STATUS, BillStatus.DRAFT.name()),
	            OperationLogCommand.state(OperationLogCommand.StateField.STATUS, String.valueOf(rows.get(0).get("status")))
	        ));
	        return rows.get(0);
	    }

    @Transactional
    public Map<String, Object> issue(String billNo, IssueRequest request) {
        var normalizedTaskBillNo = validationService.required(billNo, "生产任务单号");
        return saveDraft(new IssueDraftRequest(
            request == null ? null : request.billNo(),
            normalizedTaskBillNo,
            request == null ? null : request.materialWarehouseCode(),
            null
        ));
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

    private void insertSnapshotIssueLines(String issueId, Object taskId, String fallbackWarehouseCode, List<IssueLineRequest> requestedLines) {
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
        for (var index = 0; index < lines.size(); index++) {
            var line = lines.get(index);
            var remainingQty = (BigDecimal) line.get("remainingQty");
            var requestLine = matchingRequestLine(requestedLines, line, index);
            var requestedQty = requestedIssueQty(requestLine, remainingQty);
            if (requestedQty.compareTo(BigDecimal.ZERO) > 0) {
                var warehouseCode = requestLine == null ? fallbackWarehouseCode : validationService.optionalText(requestLine.warehouseCode());
                var warehouseId = lookupService.lookupEnabledId("md_warehouse", warehouseCode == null ? fallbackWarehouseCode : warehouseCode, "领料仓库");
                insertIssueLine(issueId, line.get("lineNo"), line.get("productId"), line.get("materialCode"), line.get("materialName"), line.get("spec"), warehouseId, requestedQty, BigDecimal.ONE);
            }
        }
    }

    private IssueLineRequest matchingRequestLine(List<IssueLineRequest> requestedLines, Map<String, Object> snapshotLine, int index) {
        if (requestedLines == null || requestedLines.isEmpty()) {
            return null;
        }
        var snapshotLineNo = Integer.parseInt(String.valueOf(snapshotLine.get("lineNo")));
        for (var line : requestedLines) {
            if (line == null) {
                continue;
            }
            if (line.sourceLineNo() != null && line.sourceLineNo().intValue() == snapshotLineNo) {
                return line;
            }
            if (line.lineNo() != null && line.lineNo().intValue() == snapshotLineNo) {
                return line;
            }
        }
        return index < requestedLines.size() ? requestedLines.get(index) : null;
    }

    private BigDecimal requestedIssueQty(IssueLineRequest requestLine, BigDecimal defaultQty) {
        if (requestLine == null || requestLine.qty() == null) {
            return defaultQty;
        }
        var qty = requestLine.qty();
        if (qty.compareTo(BigDecimal.ZERO) <= 0) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "领料数量必须大于 0");
        }
        if (qty.compareTo(defaultQty) > 0) {
            throw new ResponseStatusException(HttpStatus.CONFLICT, "领料数量不能超过生产任务剩余用料");
        }
        return qty;
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

	    private void validateRedIssueQtyWithinTask(Object issueId, Object taskId) {
	        var invalidLines = jdbcTemplate.queryForList("""
	            SELECT s.line_no
	            FROM production_task_material_snapshot s
	            JOIN (
	                SELECT line_no, SUM(qty) AS qty
	                FROM production_material_issue_line
	                WHERE issue_id = ?::uuid
	                GROUP BY line_no
	            ) red ON red.line_no = s.line_no
	            WHERE s.task_id = ?::uuid
	              AND (red.qty >= 0 OR s.issued_qty + red.qty < 0)
	            """, issueId, taskId);
	        if (!invalidLines.isEmpty()) {
	            throw new ResponseStatusException(HttpStatus.CONFLICT, "红冲数量不能超过生产任务已领套数");
	        }
	        var completionViolations = jdbcTemplate.queryForList("""
	            SELECT 1
	            FROM production_task t
	            WHERE t.id = ?::uuid
	              AND t.completed_qty > (
	                  SELECT LEAST(
	                      t.qty,
	                      COALESCE(MIN(
	                          CASE
	                              WHEN s.required_qty > 0 THEN (s.issued_qty + COALESCE(red.qty, 0)) * t.qty / s.required_qty
	                              ELSE t.qty
	                          END
	                      ), 0)
	                  )
	                  FROM production_task_material_snapshot s
	                  LEFT JOIN (
	                      SELECT line_no, SUM(qty) AS qty
	                      FROM production_material_issue_line
	                      WHERE issue_id = ?::uuid
	                      GROUP BY line_no
	                  ) red ON red.line_no = s.line_no
	                  WHERE s.task_id = t.id
	              )
	            """, taskId, issueId);
	        if (!completionViolations.isEmpty()) {
	            throw new ResponseStatusException(HttpStatus.CONFLICT, "红冲后完工套数会超过已领套数，请先处理下游产品入库单");
	        }
	    }

	    private void requireExecutableTask(Map<String, Object> issue, String actionLabel) {
	        if (!"AUDITED".equals(String.valueOf(issue.get("taskStatus")))
	            || !"OPEN".equals(String.valueOf(issue.get("taskCloseStatus")))
	            || !"NORMAL".equals(String.valueOf(issue.get("taskFrozenStatus")))) {
	            throw new ResponseStatusException(HttpStatus.CONFLICT, "生产领料单不存在、非草稿或来源任务不能" + actionLabel);
	        }
	    }

	    private boolean isRedBill(Map<String, Object> row) {
	        var redSourceBillId = row.get("redSourceBillId");
	        return redSourceBillId != null && !String.valueOf(redSourceBillId).isBlank();
	    }

	    private void validateRedSourceStillAudited(Object redSourceBillId) {
	        var count = jdbcTemplate.queryForObject("""
	            SELECT COUNT(*)
	            FROM production_material_issue
	            WHERE id = ?::uuid
	              AND status = 'AUDITED'
	            """, Integer.class, redSourceBillId);
	        if (count == null || count == 0) {
	            throw new ResponseStatusException(HttpStatus.CONFLICT, "来源生产领料单未审核，不能审核红字单");
	        }
	    }

	    private void validateRedIssueLinesMatchSource(String billNo, Object redSourceBillId) {
	        var counts = jdbcTemplate.queryForMap("""
	            SELECT
	                (SELECT COUNT(*) FROM production_material_issue_line WHERE issue_id = ?::uuid) AS "sourceCount",
	                (
	                    SELECT COUNT(*)
	                    FROM production_material_issue_line red_line
	                    JOIN production_material_issue red ON red.id = red_line.issue_id
	                    WHERE red.bill_no = ?
	                ) AS "redCount"
	            """, redSourceBillId, billNo);
	        var sourceCount = Number.class.cast(counts.get("sourceCount")).longValue();
	        var redCount = Number.class.cast(counts.get("redCount")).longValue();
	        if (sourceCount != redCount) {
	            throw new ResponseStatusException(HttpStatus.CONFLICT, "生产领料红字单分录必须与来源单一致");
	        }
	        var invalidLines = jdbcTemplate.queryForList("""
	            SELECT red_line.line_no
	            FROM production_material_issue red
	            JOIN production_material_issue_line red_line ON red_line.issue_id = red.id
	            LEFT JOIN production_material_issue_line source_line
	              ON source_line.issue_id = red.red_source_bill_id
	             AND source_line.line_no = red_line.line_no
	            WHERE red.bill_no = ?
	              AND (
	                  source_line.line_no IS NULL
	                  OR red_line.product_id <> source_line.product_id
	                  OR red_line.warehouse_id <> source_line.warehouse_id
	                  OR red_line.qty <> -source_line.qty
	                  OR red_line.unit_price <> source_line.unit_price
	                  OR red_line.amount <> -source_line.amount
	              )
	            """, billNo);
	        if (!invalidLines.isEmpty()) {
	            throw new ResponseStatusException(HttpStatus.CONFLICT, "生产领料红字单分录必须保持来源行反向数量和金额");
	        }
	    }

	    private void applyIssueQtyToTask(Object issueId, Object taskId) {
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
	            """, issueId, taskId);
	        jdbcTemplate.update("""
	            UPDATE production_task
	            SET issued_qty = LEAST(qty, (
	                    SELECT COALESCE(SUM(issued_qty), 0)
	                    FROM production_task_material_snapshot
	                    WHERE task_id = ?::uuid
	                )),
	                updated_at = now()
	            WHERE id = ?::uuid
	            """, taskId, taskId);
	    }

	    private List<Map<String, Object>> markAudited(Object issueId) {
	        return jdbcTemplate.queryForList("""
	            UPDATE production_material_issue
	            SET status = ?, updated_at = now()
	            WHERE id = ?::uuid
	            RETURNING id::text AS id, bill_no AS "billNo", status
	            """, BillStatus.AUDITED.name(), issueId);
	    }

	    @Transactional
	    public Map<String, Object> reverse(String billNo) {
        var issueRows = jdbcTemplate.queryForList("""
            SELECT id::text AS id,
                   task_id::text AS "taskId"
            FROM production_material_issue
            WHERE bill_no = ? AND status = ?
	        FOR UPDATE
            """, billNo, BillStatus.AUDITED.name());
        if (issueRows.isEmpty()) {
            throw new ResponseStatusException(HttpStatus.CONFLICT, "生产领料单不存在或不能反审核");
        }
        var issue = issueRows.get(0);
        redReverseGuardService.assertNoNonVoidRedBillForBillNo(BILL_TABLE, billNo, "生产领料单", "反审核");
        assertNoNonVoidMaterialScrap(issue.get("id"), "反审核");
        var row = lifecycleService.transition(
            BILL_TABLE,
            billNo,
            BillStatus.AUDITED,
            BillStatus.DRAFT,
	            "id::text AS id, bill_no AS \"billNo\", task_id::text AS \"taskId\", red_source_bill_id::text AS \"redSourceBillId\", status",
            "PRODUCTION",
            "REVERSE_ISSUE",
            "production_material_issue",
            "生产领料单不存在或不能反审核"
	        );
	        if (isRedBill(row)) {
	            postIssueLines(billNo, BigDecimal.ONE, "PRODUCTION_ISSUE_RED_REVERSE", PostingAction.RED_REVERSE);
	            decrementTaskIssuedQty(issue.get("id"), issue.get("taskId"));
	            return row;
	        }
	        postIssueLines(billNo, BigDecimal.ONE, "PRODUCTION_ISSUE_REVERSE", PostingAction.REVERSE);
	        decrementTaskIssuedQty(issue.get("id"), issue.get("taskId"));
	        return row;
	    }

    @Transactional
    public Map<String, Object> redReverse(String billNo, RedReverseRequest request) {
        var sourceRows = jdbcTemplate.queryForList("""
            SELECT id::text AS id, task_id::text AS "taskId"
            FROM production_material_issue
            WHERE bill_no = ? AND status = ?
            FOR UPDATE
            """, billNo, BillStatus.AUDITED.name());
        if (sourceRows.isEmpty()) {
            throw new ResponseStatusException(HttpStatus.CONFLICT, "只有已审核生产领料单可以红冲");
        }
	        redReverseGuardService.assertNoNonVoidRedBill(BILL_TABLE, sourceRows.get(0).get("id"), "生产领料单");
	        assertNoNonVoidMaterialScrap(sourceRows.get(0).get("id"), "红冲");
	        var redBillNo = numberingService.nextBillNo("materialIssue");
	        var redRows = jdbcTemplate.queryForList("""
	            INSERT INTO production_material_issue (bill_no, task_id, red_source_bill_id, status)
	            VALUES (?, ?::uuid, ?::uuid, ?)
	            RETURNING id::text AS id, bill_no AS "billNo", status
	            """, redBillNo, sourceRows.get(0).get("taskId"), sourceRows.get(0).get("id"), BillStatus.DRAFT.name());
	        copyIssueLines(billNo, String.valueOf(redRows.get(0).get("id")), true);
	        operationLogService.logCurrent(OperationLogCommand.success(
	            "PRODUCTION", "CREATE_RED_ISSUE_DRAFT", "production_material_issue",
	            UUID.fromString(String.valueOf(redRows.get(0).get("id"))), redBillNo, Map.of(),
	            OperationLogCommand.state(OperationLogCommand.StateField.STATUS, String.valueOf(redRows.get(0).get("status")))
	        ));
	        return redRows.get(0);
	    }

    private void assertNoNonVoidMaterialScrap(Object issueId, String actionLabel) {
        var count = jdbcTemplate.queryForObject("""
            SELECT COUNT(*)
            FROM production_material_scrap
            WHERE source_issue_id = ?::uuid
              AND status <> 'VOID'
            """, Long.class, issueId);
        if (count != null && count > 0) {
            throw new ResponseStatusException(
                HttpStatus.CONFLICT,
                "生产领料单已有未作废材料报废单，不能" + actionLabel
            );
        }
    }

    private void decrementTaskIssuedQty(Object issueId, Object taskId) {
        jdbcTemplate.update("""
            UPDATE production_task_material_snapshot s
            SET issued_qty = GREATEST(s.issued_qty - issued.qty, 0)
            FROM (
                SELECT line_no, SUM(qty) AS qty
                FROM production_material_issue_line
                WHERE issue_id = ?::uuid
                GROUP BY line_no
            ) issued
            WHERE s.task_id = ?::uuid
              AND s.line_no = issued.line_no
            """, issueId, taskId);
        jdbcTemplate.update("""
            UPDATE production_task
            SET issued_qty = (
                    SELECT COALESCE(SUM(issued_qty), 0)
                    FROM production_task_material_snapshot
                    WHERE task_id = ?::uuid
                ),
                updated_at = now()
            WHERE id = ?::uuid
            """, taskId, taskId);
    }

    private void insertIssueLine(String issueId, Object lineNo, Object productId, Object productCode, Object productName, Object spec, Object warehouseId, BigDecimal qty, BigDecimal unitPrice) {
        jdbcTemplate.update("""
            INSERT INTO production_material_issue_line (issue_id, line_no, product_id, product_code_snapshot, product_name_snapshot, product_spec_snapshot, warehouse_id, qty, unit_price, amount)
            VALUES (?::uuid, ?, ?::uuid, ?, ?, ?, ?::uuid, ?, ?, ?)
            """, issueId, lineNo, productId, productCode, productName, spec, warehouseId, qty, unitPrice, qty.multiply(unitPrice));
    }

    private void postIssueLines(String billNo, BigDecimal sign, String txnType, PostingAction postingAction) {
        var lines = jdbcTemplate.queryForList("""
            SELECT i.id::text AS "sourceBillId",
                   l.id::text AS "sourceBillLineId",
                   i.bill_no AS "sourceBillNo",
                   (i.created_at AT TIME ZONE 'Asia/Shanghai')::date AS "sourceBillDate",
                   p.code AS "productCode",
                   w.code AS "warehouseCode",
                   l.qty
            FROM production_material_issue_line l
            JOIN md_product p ON p.id = l.product_id
            JOIN md_warehouse w ON w.id = l.warehouse_id
            JOIN production_material_issue i ON i.id = l.issue_id
            WHERE i.bill_no = ?
            ORDER BY l.line_no
            """, billNo);
        for (var line : lines) {
            postingPipeline.post(PostingContext.inventory(InventoryPostingCommand.document(
                String.valueOf(line.get("productCode")),
                String.valueOf(line.get("warehouseCode")),
                ((BigDecimal) line.get("qty")).multiply(sign),
                txnType,
                "PRODUCTION_MATERIAL_ISSUE",
                line.get("sourceBillId"),
                line.get("sourceBillLineId"),
                String.valueOf(line.get("sourceBillNo")),
                line.get("sourceBillDate"),
                postingAction
            )));
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

    private String inventoryScopeId() {
        return tenantDataScopeService.currentScopeId("inventory");
    }

    public record IssueRequest(String billNo, String materialWarehouseCode) {
    }

    public record IssueDraftRequest(String billNo, String sourceOrderNo, String materialWarehouseCode, List<IssueLineRequest> lines) {
    }

    public record IssueLineRequest(Integer lineNo, Integer sourceLineNo, String productCode, String warehouseCode, BigDecimal qty) {
    }

    public record RedReverseRequest(String redBillNo) {
    }
}
