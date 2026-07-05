package com.jdy.erp.production.application;

import java.math.BigDecimal;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

import com.jdy.erp.shared.application.BillLifecycleService;
import com.jdy.erp.shared.application.InventoryPostingHook;
import com.jdy.erp.shared.application.LookupService;
import com.jdy.erp.shared.application.NumberingService;
import com.jdy.erp.shared.application.OperationLogService;
import com.jdy.erp.shared.application.PostingContext;
import com.jdy.erp.shared.application.PostingPipeline;
import com.jdy.erp.shared.application.ProductSnapshotService;
import com.jdy.erp.shared.application.RedReverseGuardService;
import com.jdy.erp.shared.application.ValidationService;
import com.jdy.erp.shared.domain.BillStatus;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.server.ResponseStatusException;

@Service
public class ProductInAppService {
    private static final String BILL_TABLE = "production_completion";

    private final JdbcTemplate jdbcTemplate;
    private final LookupService lookupService;
    private final ValidationService validationService;
    private final PostingPipeline postingPipeline;
    private final OperationLogService operationLogService;
    private final NumberingService numberingService;
    private final BillLifecycleService lifecycleService;
    private final ProductSnapshotService productSnapshotService;
    private final RedReverseGuardService redReverseGuardService;

    public ProductInAppService(JdbcTemplate jdbcTemplate, LookupService lookupService, ValidationService validationService, PostingPipeline postingPipeline, OperationLogService operationLogService, NumberingService numberingService, BillLifecycleService lifecycleService, ProductSnapshotService productSnapshotService, RedReverseGuardService redReverseGuardService) {
        this.jdbcTemplate = jdbcTemplate;
        this.lookupService = lookupService;
        this.validationService = validationService;
        this.postingPipeline = postingPipeline;
        this.operationLogService = operationLogService;
        this.numberingService = numberingService;
        this.lifecycleService = lifecycleService;
        this.productSnapshotService = productSnapshotService;
        this.redReverseGuardService = redReverseGuardService;
    }

    public Map<String, Object> detail(String billNo) {
        var billRows = jdbcTemplate.queryForList("""
            SELECT c.id::text AS id,
                   c.bill_no AS "billNo",
                   t.bill_no AS "sourceOrderNo",
                   'SC' AS "customerCode",
                   '生产车间' AS customer,
                   to_char(c.created_at, 'YYYY-MM-DD') AS "billDate",
                   '生产部' AS department,
	                   c.status,
	                   COALESCE(SUM(l.amount), 0) AS "totalAmount",
	                   '本地管理员' AS "ownerName",
	                   (
	                       SELECT red.bill_no
	                       FROM production_completion red
	                       WHERE red.red_source_bill_id = c.id
	                         AND red.status <> 'VOID'
	                       LIMIT 1
	                   ) AS "redReverseBillNo",
	                   (
	                       SELECT original.bill_no
	                       FROM production_completion original
                       WHERE original.id = c.red_source_bill_id
                   ) AS "redSourceBillNo"
            FROM production_completion c
            JOIN production_task t ON t.id = c.task_id
            LEFT JOIN production_completion_line l ON l.completion_id = c.id
            WHERE c.bill_no = ?
            GROUP BY c.id, t.bill_no
            """, billNo);
        if (billRows.isEmpty()) {
            throw new ResponseStatusException(HttpStatus.NOT_FOUND, "产品入库单不存在");
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
            FROM production_completion_line l
            JOIN md_product p ON p.id = l.product_id
            JOIN md_warehouse w ON w.id = l.warehouse_id
            JOIN production_completion c ON c.id = l.completion_id
            WHERE c.bill_no = ?
            ORDER BY l.line_no
            """, billNo);
        return Map.of("action", "DETAIL", "document", billRows.get(0), "lines", lines);
    }

    @Transactional
    public Map<String, Object> saveDraft(ProductInDraftRequest request) {
        if (request == null) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "产品入库单草稿不能为空");
        }
        var sourceTaskNo = validationService.required(request.sourceOrderNo(), "生产任务单号");
        var task = completionTask(sourceTaskNo);
        var productInBillNo = numberingService.assignBillNo("productIn", request.billNo());
        redReverseGuardService.assertNotRedDraftForBillNo(BILL_TABLE, productInBillNo, "产品入库单");
        var defaultQty = request.qty() == null ? remainingCompletableQty(task) : positive(request.qty(), "完工数量");
        var completionRows = jdbcTemplate.queryForList("""
            INSERT INTO production_completion (bill_no, task_id, qty, status)
            VALUES (?, ?::uuid, ?, ?)
            ON CONFLICT (bill_no) DO UPDATE
            SET task_id = EXCLUDED.task_id,
                qty = EXCLUDED.qty,
                status = EXCLUDED.status,
                updated_at = now()
            WHERE production_completion.status = 'DRAFT'
            RETURNING id::text AS id, bill_no AS "billNo", qty, status
            """, productInBillNo, task.get("id"), defaultQty, BillStatus.DRAFT.name());
        if (completionRows.isEmpty()) {
            throw new ResponseStatusException(HttpStatus.CONFLICT, "只有草稿产品入库单可以覆盖保存");
        }
        var completionId = String.valueOf(completionRows.get(0).get("id"));
        jdbcTemplate.update("DELETE FROM production_completion_line WHERE completion_id = ?::uuid", completionId);
        var totalQty = insertDraftCompletionLines(completionId, task, defaultQty, request.lines());
        validateCompletionQtyWithinTask(String.valueOf(task.get("id")), totalQty);
        jdbcTemplate.update("""
            UPDATE production_completion
            SET qty = ?, updated_at = now()
            WHERE id = ?::uuid
            """, totalQty, completionId);
        var row = new LinkedHashMap<String, Object>(completionRows.get(0));
        row.put("qty", totalQty);
        row.put("sourceOrderNo", sourceTaskNo);
        operationLogService.log("PRODUCTION", "SAVE_COMPLETE_DRAFT", "production_completion", completionId, true, null);
        return row;
    }

    @Transactional
    public Map<String, Object> completeFromIssue(String issueBillNo, CompleteRequest request) {
        var issueRows = jdbcTemplate.queryForList("""
            SELECT i.bill_no AS "issueBillNo",
                   t.bill_no AS "taskBillNo"
            FROM production_material_issue i
            JOIN production_task t ON t.id = i.task_id
            WHERE i.bill_no = ?
              AND i.status = ?
              AND t.status = 'AUDITED'
            """, issueBillNo, BillStatus.AUDITED.name());
        if (issueRows.isEmpty()) {
            throw new ResponseStatusException(HttpStatus.CONFLICT, "生产领料单不存在、未审核或来源任务不能完工入库");
        }
        var issue = issueRows.get(0);
        var completionRequest = new ProductInDraftRequest(
            request == null ? null : request.billNo(),
            String.valueOf(issue.get("taskBillNo")),
            request == null ? null : request.qty(),
            request == null ? null : request.lines()
        );
        var result = new LinkedHashMap<String, Object>(saveDraft(completionRequest));
        result.put("sourceIssueNo", issueBillNo);
        return result;
    }

    @Transactional
    public Map<String, Object> complete(String billNo, CompleteRequest request) {
        return saveDraft(new ProductInDraftRequest(
            request == null ? null : request.billNo(),
            validationService.required(billNo, "生产任务单号"),
            request == null ? null : request.qty(),
            request == null ? null : request.lines()
        ));
    }

	    @Transactional
	    public Map<String, Object> audit(String billNo) {
	        var completionRows = jdbcTemplate.queryForList("""
	            SELECT c.id::text AS id,
	                   c.task_id::text AS "taskId",
	                   c.red_source_bill_id::text AS "redSourceBillId",
	                   c.qty,
	                   t.status AS "taskStatus",
	                   t.close_status AS "taskCloseStatus",
	                   t.frozen_status AS "taskFrozenStatus"
	            FROM production_completion c
	            JOIN production_task t ON t.id = c.task_id
	            WHERE c.bill_no = ?
	              AND c.status = ?
	            """, billNo, BillStatus.DRAFT.name());
	        if (completionRows.isEmpty()) {
	            throw new ResponseStatusException(HttpStatus.CONFLICT, "产品入库单不存在、非草稿或来源任务不能完工入库");
	        }
	        var completion = completionRows.get(0);
	        if (isRedBill(completion)) {
	            return auditRedBill(completion, billNo);
	        }
	        requireExecutableTask(completion, "完工入库");
	        var qty = (BigDecimal) completion.get("qty");
	        validateCompletionQtyWithinTask(String.valueOf(completion.get("taskId")), qty);
        postCompletionLines(billNo, BigDecimal.ONE, "PRODUCTION_COMPLETE", "PRODUCTION_COMPLETE:" + billNo);
        var taskRows = jdbcTemplate.queryForList("""
            UPDATE production_task
            SET completed_qty = completed_qty + ?,
                updated_at = now()
            WHERE id = ?::uuid
              AND completed_qty + ? <= qty
            RETURNING id::text AS id, bill_no AS "billNo", completed_qty AS "completedQty"
            """, qty, completion.get("taskId"), qty);
        if (taskRows.isEmpty()) {
            throw new ResponseStatusException(HttpStatus.CONFLICT, "完工数量不能超过任务数量");
        }
        var rows = jdbcTemplate.queryForList("""
            UPDATE production_completion
            SET status = ?, updated_at = now()
            WHERE id = ?::uuid
            RETURNING id::text AS id, bill_no AS "billNo", qty, status
            """, BillStatus.AUDITED.name(), completion.get("id"));
        operationLogService.log("PRODUCTION", "AUDIT_COMPLETE", "production_completion", String.valueOf(completion.get("id")), true, null);
	        var row = new LinkedHashMap<String, Object>(rows.get(0));
	        row.put("taskCompletedQty", taskRows.get(0).get("completedQty"));
	        return row;
	    }

	    private Map<String, Object> auditRedBill(Map<String, Object> completion, String billNo) {
	        var qty = (BigDecimal) completion.get("qty");
	        validateRedCompletion(completion, billNo, qty);
	        postCompletionLines(billNo, BigDecimal.ONE, "PRODUCTION_COMPLETE_RED", "PRODUCTION_COMPLETE_RED:" + billNo);
	        var taskRows = jdbcTemplate.queryForList("""
	            UPDATE production_task
	            SET completed_qty = completed_qty + ?,
	                updated_at = now()
	            WHERE id = ?::uuid
	              AND completed_qty + ? >= 0
	            RETURNING id::text AS id, bill_no AS "billNo", completed_qty AS "completedQty"
	            """, qty, completion.get("taskId"), qty);
	        if (taskRows.isEmpty()) {
	            throw new ResponseStatusException(HttpStatus.CONFLICT, "红冲数量不能超过任务已完工套数");
	        }
	        var rows = jdbcTemplate.queryForList("""
	            UPDATE production_completion
	            SET status = ?, updated_at = now()
	            WHERE id = ?::uuid
	            RETURNING id::text AS id, bill_no AS "billNo", qty, status
	            """, BillStatus.AUDITED.name(), completion.get("id"));
	        operationLogService.log("PRODUCTION", "AUDIT_RED_COMPLETE", "production_completion", String.valueOf(completion.get("id")), true, null);
	        var row = new LinkedHashMap<String, Object>(rows.get(0));
	        row.put("taskCompletedQty", taskRows.get(0).get("completedQty"));
	        return row;
	    }

    @Transactional
    public Map<String, Object> reverse(String billNo) {
        redReverseGuardService.assertNoNonVoidRedBillForBillNo(BILL_TABLE, billNo, "产品入库单", "反审核");
        var currentRows = jdbcTemplate.queryForList("""
            SELECT id::text AS id,
                   red_source_bill_id::text AS "redSourceBillId"
            FROM production_completion
            WHERE bill_no = ?
              AND status = ?
            """, billNo, BillStatus.AUDITED.name());
        if (!currentRows.isEmpty() && !isRedBill(currentRows.get(0))) {
            blockIfOutsourcingDownstream(String.valueOf(currentRows.get(0).get("id")), billNo, "反审核");
        }
        var row = lifecycleService.transition(
            BILL_TABLE,
            billNo,
	            BillStatus.AUDITED,
	            BillStatus.DRAFT,
	            "id::text AS id, bill_no AS \"billNo\", task_id::text AS \"taskId\", red_source_bill_id::text AS \"redSourceBillId\", qty, status",
	            "PRODUCTION",
	            "REVERSE_COMPLETE",
	            "production_completion",
	            "产品入库单不存在或不能反审核"
	        );
	        if (isRedBill(row)) {
	            postCompletionLines(billNo, BigDecimal.ONE.negate(), "PRODUCTION_COMPLETE_RED_REVERSE", "PRODUCTION_COMPLETE_RED_REVERSE:" + billNo);
	            decrementTaskCompletedQty(String.valueOf(row.get("taskId")), (BigDecimal) row.get("qty"));
	            return row;
	        }
	        postCompletionLines(billNo, BigDecimal.ONE.negate(), "PRODUCTION_COMPLETE_REVERSE", "PRODUCTION_COMPLETE_REVERSE:" + billNo);
	        decrementTaskCompletedQty(String.valueOf(row.get("taskId")), (BigDecimal) row.get("qty"));
	        return row;
    }

    @Transactional
    public Map<String, Object> redReverse(String billNo, MaterialIssueAppService.RedReverseRequest request) {
        var sourceRows = jdbcTemplate.queryForList("""
            SELECT id::text AS id, task_id::text AS "taskId", qty
            FROM production_completion
            WHERE bill_no = ? AND status = ?
            """, billNo, BillStatus.AUDITED.name());
	        if (sourceRows.isEmpty()) {
	            throw new ResponseStatusException(HttpStatus.CONFLICT, "只有已审核产品入库单可以红冲");
	        }
	        redReverseGuardService.assertNoNonVoidRedBill(BILL_TABLE, sourceRows.get(0).get("id"), "产品入库单");
	        blockIfOutsourcingDownstream(String.valueOf(sourceRows.get(0).get("id")), billNo);
	        var redBillNo = numberingService.nextBillNo("productIn");
	        var redQty = ((BigDecimal) sourceRows.get(0).get("qty")).negate();
	        var redRows = jdbcTemplate.queryForList("""
	            INSERT INTO production_completion (bill_no, task_id, red_source_bill_id, qty, status)
	            VALUES (?, ?::uuid, ?::uuid, ?, ?)
	            RETURNING id::text AS id, bill_no AS "billNo", status, qty
	            """, redBillNo, sourceRows.get(0).get("taskId"), sourceRows.get(0).get("id"), redQty, BillStatus.DRAFT.name());
	        copyCompletionLines(billNo, String.valueOf(redRows.get(0).get("id")), true);
	        operationLogService.log("PRODUCTION", "CREATE_RED_COMPLETE_DRAFT", "production_completion", String.valueOf(redRows.get(0).get("id")), true, null);
	        return redRows.get(0);
	    }

    private void insertCompletionLine(String completionId, Object lineNo, Object productId, Object productCode, Object productName, Object spec, Object warehouseId, BigDecimal qty, BigDecimal unitPrice) {
        jdbcTemplate.update("""
            INSERT INTO production_completion_line (completion_id, line_no, product_id, product_code_snapshot, product_name_snapshot, product_spec_snapshot, warehouse_id, qty, unit_price, amount)
            VALUES (?::uuid, ?, ?::uuid, ?, ?, ?, ?::uuid, ?, ?, ?)
            """, completionId, lineNo, productId, productCode, productName, spec, warehouseId, qty, unitPrice, qty.multiply(unitPrice));
    }

    private void postCompletionLines(String billNo, BigDecimal sign, String txnType, String sourceBillType) {
        var lines = jdbcTemplate.queryForList("""
            SELECT p.code AS "productCode", w.code AS "warehouseCode", l.qty
            FROM production_completion_line l
            JOIN md_product p ON p.id = l.product_id
            JOIN md_warehouse w ON w.id = l.warehouse_id
            JOIN production_completion c ON c.id = l.completion_id
            WHERE c.bill_no = ?
            ORDER BY l.line_no
            """, billNo);
        for (var line : lines) {
            post(String.valueOf(line.get("productCode")), String.valueOf(line.get("warehouseCode")), ((BigDecimal) line.get("qty")).multiply(sign), txnType, sourceBillType);
        }
    }

    private void copyCompletionLines(String sourceBillNo, String targetCompletionId, boolean negate) {
        var lines = jdbcTemplate.queryForList("""
            SELECT l.line_no AS "lineNo",
                   l.product_id::text AS "productId",
                   l.product_code_snapshot AS "productCode",
                   l.product_name_snapshot AS "productName",
                   l.product_spec_snapshot AS spec,
                   l.warehouse_id::text AS "warehouseId",
                   l.qty,
                   l.unit_price AS "unitPrice"
            FROM production_completion_line l
            JOIN production_completion c ON c.id = l.completion_id
            WHERE c.bill_no = ?
            ORDER BY l.line_no
            """, sourceBillNo);
        for (var line : lines) {
            var qty = (BigDecimal) line.get("qty");
            insertCompletionLine(targetCompletionId, line.get("lineNo"), line.get("productId"), line.get("productCode"), line.get("productName"), line.get("spec"), line.get("warehouseId"), negate ? qty.negate() : qty, (BigDecimal) line.get("unitPrice"));
        }
    }

    private Map<String, Object> completionTask(String taskBillNo) {
        var taskRows = jdbcTemplate.queryForList("""
            SELECT t.id::text AS id,
                   t.product_id::text AS product_id,
                   COALESCE(t.product_code_snapshot, p.code) AS product_code,
                   COALESCE(t.product_name_snapshot, p.name) AS product_name,
                   COALESCE(t.product_spec_snapshot, p.spec, '') AS spec,
                   w.code AS warehouse_code,
                   t.qty,
                   t.completed_qty,
                   COALESCE(issue_progress.issued_sets, 0) AS issued_sets
            FROM production_task t
            JOIN md_product p ON p.id = t.product_id
            JOIN md_warehouse w ON w.id = t.warehouse_id
            LEFT JOIN LATERAL (
                SELECT LEAST(
                           t.qty,
                           COALESCE(MIN(
                               CASE
                                   WHEN s.required_qty > 0 THEN s.issued_qty * t.qty / s.required_qty
                                   ELSE t.qty
                               END
                           ), 0)
                       ) AS issued_sets
                FROM production_task_material_snapshot s
                WHERE s.task_id = t.id
            ) issue_progress ON TRUE
            WHERE t.bill_no = ?
              AND t.status = 'AUDITED'
              AND t.close_status = 'OPEN'
              AND t.frozen_status = 'NORMAL'
            """, taskBillNo);
        if (taskRows.isEmpty()) {
            throw new ResponseStatusException(HttpStatus.CONFLICT, "生产任务不存在或不能完工");
        }
        return taskRows.get(0);
    }

    private BigDecimal insertDraftCompletionLines(String completionId, Map<String, Object> task, BigDecimal defaultQty, List<CompleteLineRequest> requestLines) {
        var lineNo = 1;
        if (requestLines == null || requestLines.isEmpty()) {
            var warehouseCode = String.valueOf(task.get("warehouse_code"));
            insertCompletionLine(
                completionId,
                lineNo,
                task.get("product_id"),
                task.get("product_code"),
                task.get("product_name"),
                task.get("spec"),
                lookupService.lookupEnabledId("md_warehouse", warehouseCode, "完工仓库"),
                defaultQty,
                BigDecimal.ONE
            );
            return defaultQty;
        }
        var totalQty = BigDecimal.ZERO;
        for (var line : requestLines) {
            var product = productSnapshotService.resolve(line.productId(), line.productCode(), "完工商品");
            var warehouseCode = validationService.required(line.warehouseCode(), "完工仓库");
            var lineQty = positive(line.qty(), "完工数量");
            var unitPrice = line.unitPrice() == null ? BigDecimal.ONE : line.unitPrice();
            insertCompletionLine(completionId, lineNo, product.id(), product.code(), product.name(), product.spec(), lookupService.lookupEnabledId("md_warehouse", warehouseCode, "完工仓库"), lineQty, unitPrice);
            totalQty = totalQty.add(lineQty);
            lineNo += 1;
        }
        return totalQty;
    }

    private BigDecimal remainingCompletableQty(Map<String, Object> task) {
        var taskQty = (BigDecimal) task.get("qty");
        var completedQty = (BigDecimal) task.get("completed_qty");
        var issuedSets = (BigDecimal) task.get("issued_sets");
        var remainingQty = taskQty.min(issuedSets).subtract(completedQty);
        if (remainingQty.compareTo(BigDecimal.ZERO) <= 0) {
            throw new ResponseStatusException(HttpStatus.CONFLICT, "来源生产任务没有可完工入库的已领套数");
        }
        return remainingQty;
    }

	    private void validateCompletionQtyWithinTask(String taskId, BigDecimal qty) {
	        var taskRows = jdbcTemplate.queryForList("""
	            SELECT t.qty,
                   t.completed_qty,
                   COALESCE(issue_progress.issued_sets, 0) AS issued_sets
            FROM production_task t
            LEFT JOIN LATERAL (
                SELECT LEAST(
                           t.qty,
                           COALESCE(MIN(
                               CASE
                                   WHEN s.required_qty > 0 THEN s.issued_qty * t.qty / s.required_qty
                                   ELSE t.qty
                               END
                           ), 0)
                       ) AS issued_sets
                FROM production_task_material_snapshot s
                WHERE s.task_id = t.id
            ) issue_progress ON TRUE
            WHERE t.id = ?::uuid
            """, taskId);
        if (taskRows.isEmpty()) {
            throw new ResponseStatusException(HttpStatus.CONFLICT, "来源生产任务不存在");
        }
        var task = taskRows.get(0);
        var taskQty = (BigDecimal) task.get("qty");
        var completedQty = (BigDecimal) task.get("completed_qty");
        var issuedSets = (BigDecimal) task.get("issued_sets");
        if (completedQty.add(qty).compareTo(taskQty) > 0) {
            throw new ResponseStatusException(HttpStatus.CONFLICT, "完工数量不能超过任务数量");
        }
        if (completedQty.add(qty).compareTo(issuedSets) > 0) {
	            throw new ResponseStatusException(HttpStatus.CONFLICT, "完工套数不能超过已领套数，请先审核生产领料单");
	        }
	    }

	    private void validateRedCompletion(Map<String, Object> completion, String billNo, BigDecimal qty) {
	        if (qty == null || qty.compareTo(BigDecimal.ZERO) >= 0) {
	            throw new ResponseStatusException(HttpStatus.CONFLICT, "产品入库红字单数量必须为负数");
	        }
	        validateRedSourceStillAudited(completion.get("redSourceBillId"));
	        validateRedCompletionMatchesSource(completion, billNo, qty);
	        blockIfOutsourcingDownstream(String.valueOf(completion.get("redSourceBillId")), sourceBillNo(String.valueOf(completion.get("redSourceBillId"))));
	        var rows = jdbcTemplate.queryForList("""
	            SELECT 1
	            FROM production_task
	            WHERE id = ?::uuid
	              AND completed_qty + ? >= 0
	            """, completion.get("taskId"), qty);
	        if (rows.isEmpty()) {
	            throw new ResponseStatusException(HttpStatus.CONFLICT, "红冲数量不能超过任务已完工套数");
	        }
	    }

	    private void requireExecutableTask(Map<String, Object> completion, String actionLabel) {
	        if (!"AUDITED".equals(String.valueOf(completion.get("taskStatus")))
	            || !"OPEN".equals(String.valueOf(completion.get("taskCloseStatus")))
	            || !"NORMAL".equals(String.valueOf(completion.get("taskFrozenStatus")))) {
	            throw new ResponseStatusException(HttpStatus.CONFLICT, "产品入库单不存在、非草稿或来源任务不能" + actionLabel);
	        }
	    }

	    private boolean isRedBill(Map<String, Object> row) {
	        var redSourceBillId = row.get("redSourceBillId");
	        return redSourceBillId != null && !String.valueOf(redSourceBillId).isBlank();
	    }

	    private void validateRedSourceStillAudited(Object redSourceBillId) {
	        var count = jdbcTemplate.queryForObject("""
	            SELECT COUNT(*)
	            FROM production_completion
	            WHERE id = ?::uuid
	              AND status = 'AUDITED'
	            """, Integer.class, redSourceBillId);
	        if (count == null || count == 0) {
	            throw new ResponseStatusException(HttpStatus.CONFLICT, "来源产品入库单未审核，不能审核红字单");
	        }
	    }

	    private void validateRedCompletionMatchesSource(Map<String, Object> completion, String billNo, BigDecimal qty) {
	        var invalidHeader = jdbcTemplate.queryForList("""
	            SELECT 1
	            FROM production_completion source
	            WHERE source.id = ?::uuid
	              AND ? <> -source.qty
	            """, completion.get("redSourceBillId"), qty);
	        if (!invalidHeader.isEmpty()) {
	            throw new ResponseStatusException(HttpStatus.CONFLICT, "产品入库红字单数量必须与来源单反向一致");
	        }
	        var counts = jdbcTemplate.queryForMap("""
	            SELECT
	                (SELECT COUNT(*) FROM production_completion_line WHERE completion_id = ?::uuid) AS "sourceCount",
	                (
	                    SELECT COUNT(*)
	                    FROM production_completion_line red_line
	                    JOIN production_completion red ON red.id = red_line.completion_id
	                    WHERE red.bill_no = ?
	                ) AS "redCount"
	            """, completion.get("redSourceBillId"), billNo);
	        var sourceCount = Number.class.cast(counts.get("sourceCount")).longValue();
	        var redCount = Number.class.cast(counts.get("redCount")).longValue();
	        if (sourceCount != redCount) {
	            throw new ResponseStatusException(HttpStatus.CONFLICT, "产品入库红字单分录必须与来源单一致");
	        }
	        var invalidLines = jdbcTemplate.queryForList("""
	            SELECT red_line.line_no
	            FROM production_completion red
	            JOIN production_completion_line red_line ON red_line.completion_id = red.id
	            LEFT JOIN production_completion_line source_line
	              ON source_line.completion_id = red.red_source_bill_id
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
	            throw new ResponseStatusException(HttpStatus.CONFLICT, "产品入库红字单分录必须保持来源行反向数量和金额");
	        }
	    }

	    private String sourceBillNo(String sourceCompletionId) {
	        var rows = jdbcTemplate.queryForList("""
	            SELECT bill_no AS "billNo"
	            FROM production_completion
	            WHERE id = ?::uuid
	            """, sourceCompletionId);
	        if (rows.isEmpty()) {
	            throw new ResponseStatusException(HttpStatus.CONFLICT, "来源产品入库单不存在");
	        }
	        return String.valueOf(rows.get(0).get("billNo"));
	    }

	    private void blockIfOutsourcingDownstream(String sourceCompletionId, String sourceBillNo) {
	        blockIfOutsourcingDownstream(sourceCompletionId, sourceBillNo, "红冲");
	    }

	    private void blockIfOutsourcingDownstream(String sourceCompletionId, String sourceBillNo, String actionLabel) {
	        var count = jdbcTemplate.queryForObject("""
	            SELECT COUNT(*)
	            FROM outsourcing_work_order
	            WHERE (source_completion_id = ?::uuid OR source_bill_no = ?)
	              AND status <> 'VOID'
	            """, Integer.class, sourceCompletionId, sourceBillNo);
	        if (count != null && count > 0) {
	            throw new ResponseStatusException(HttpStatus.CONFLICT, "产品入库单已下推委外加工单，不能" + actionLabel);
	        }
	    }

	    private void decrementTaskCompletedQty(String taskId, BigDecimal qty) {
        jdbcTemplate.update("""
            UPDATE production_task
            SET completed_qty = GREATEST(completed_qty - ?, 0),
                updated_at = now()
            WHERE id = ?::uuid
            """, qty, taskId);
    }

    private void post(String productCode, String warehouseCode, BigDecimal qty, String txnType, String sourceBillType) {
        postingPipeline.post(new PostingContext(InventoryPostingHook.CHANNEL, productCode, warehouseCode, qty, txnType, sourceBillType));
    }

    private BigDecimal positive(BigDecimal value, String label) {
        if (value == null || value.compareTo(BigDecimal.ZERO) <= 0) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, label + "必须大于 0");
        }
        return value;
    }

    public record CompleteRequest(String billNo, BigDecimal qty, List<CompleteLineRequest> lines) {
    }

    public record CompleteLineRequest(String productId, String productCode, String warehouseCode, BigDecimal qty, BigDecimal unitPrice) {
    }

    public record ProductInDraftRequest(String billNo, String sourceOrderNo, BigDecimal qty, List<CompleteLineRequest> lines) {
    }
}
