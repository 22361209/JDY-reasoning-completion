package com.jdy.erp.production.application;

import java.math.BigDecimal;
import java.util.List;
import java.util.Map;

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
public class ProductInAppService {
    private final JdbcTemplate jdbcTemplate;
    private final LookupService lookupService;
    private final ValidationService validationService;
    private final PostingPipeline postingPipeline;
    private final OperationLogService operationLogService;
    private final NumberingService numberingService;

    public ProductInAppService(JdbcTemplate jdbcTemplate, LookupService lookupService, ValidationService validationService, PostingPipeline postingPipeline, OperationLogService operationLogService, NumberingService numberingService) {
        this.jdbcTemplate = jdbcTemplate;
        this.lookupService = lookupService;
        this.validationService = validationService;
        this.postingPipeline = postingPipeline;
        this.operationLogService = operationLogService;
        this.numberingService = numberingService;
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
                   p.code AS "productCode",
                   p.name AS "productName",
                   COALESCE(p.spec, '') AS spec,
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
    public Map<String, Object> complete(String billNo, CompleteRequest request) {
        var productInBillNo = numberingService.assignBillNo("productIn", request.billNo());
        var taskRows = jdbcTemplate.queryForList("""
            SELECT t.id::text AS id, p.code AS product_code, w.code AS warehouse_code, t.qty, t.completed_qty
            FROM production_task t
            JOIN md_product p ON p.id = t.product_id
            JOIN md_warehouse w ON w.id = t.warehouse_id
            WHERE t.bill_no = ? AND t.status IN ('AUDITED', 'ISSUED')
            """, billNo);
        if (taskRows.isEmpty()) {
            throw new ResponseStatusException(HttpStatus.CONFLICT, "生产任务不存在或不能完工");
        }
        var task = taskRows.get(0);
        var requestLines = request.lines() == null || request.lines().isEmpty()
            ? List.of(new CompleteLineRequest(String.valueOf(task.get("product_code")), String.valueOf(task.get("warehouse_code")), request.qty(), BigDecimal.ONE))
            : request.lines();
        var qty = requestLines.stream()
            .map(line -> positive(line.qty(), "完工数量"))
            .reduce(BigDecimal.ZERO, BigDecimal::add);
        var completionRows = jdbcTemplate.queryForList("""
            INSERT INTO production_completion (bill_no, task_id, qty, status)
            VALUES (?, ?::uuid, ?, ?)
            RETURNING id::text AS id, bill_no AS "billNo", qty, status
            """, productInBillNo, task.get("id"), qty, BillStatus.AUDITED.name());
        var completionId = String.valueOf(completionRows.get(0).get("id"));
        var lineNo = 1;
        for (var line : requestLines) {
            var productCode = validationService.required(line.productCode(), "完工商品编码");
            var warehouseCode = validationService.required(line.warehouseCode(), "完工仓库");
            var lineQty = positive(line.qty(), "完工数量");
            var unitPrice = line.unitPrice() == null ? BigDecimal.ONE : line.unitPrice();
            insertCompletionLine(completionId, lineNo, lookupService.lookupEnabledId("md_product", productCode, "完工商品"), lookupService.lookupEnabledId("md_warehouse", warehouseCode, "完工仓库"), lineQty, unitPrice);
            post(productCode, warehouseCode, lineQty, "PRODUCTION_COMPLETE", "PRODUCTION_COMPLETE:" + productInBillNo);
            lineNo += 1;
        }
        var rows = jdbcTemplate.queryForList("""
            UPDATE production_task
            SET completed_qty = completed_qty + ?,
                status = CASE WHEN completed_qty + ? >= qty THEN 'COMPLETED' ELSE 'ISSUED' END,
                updated_at = now()
            WHERE id = ?::uuid
              AND completed_qty + ? <= qty
            RETURNING id::text AS id, bill_no AS "billNo", qty, issued_qty AS "issuedQty", completed_qty AS "completedQty", status
            """, qty, qty, task.get("id"), qty);
        if (rows.isEmpty()) {
            throw new ResponseStatusException(HttpStatus.CONFLICT, "完工数量不能超过任务数量");
        }
        operationLogService.log("PRODUCTION", "COMPLETE", "production_completion", String.valueOf(completionRows.get(0).get("id")), true, null);
        return rows.get(0);
    }

    @Transactional
    public Map<String, Object> reverse(String billNo) {
        var rows = jdbcTemplate.queryForList("""
            UPDATE production_completion
            SET status = ?, reversed_at = now()
            WHERE bill_no = ? AND status = ?
            RETURNING id::text AS id, bill_no AS "billNo", status
            """, BillStatus.REVERSED.name(), billNo, BillStatus.AUDITED.name());
        if (rows.isEmpty()) {
            throw new ResponseStatusException(HttpStatus.CONFLICT, "产品入库单不存在或不能反审核");
        }
        postCompletionLines(billNo, BigDecimal.ONE.negate(), "PRODUCTION_COMPLETE_REVERSE", "PRODUCTION_COMPLETE_REVERSE:" + billNo);
        operationLogService.log("PRODUCTION", "REVERSE_COMPLETE", "production_completion", String.valueOf(rows.get(0).get("id")), true, null);
        return rows.get(0);
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
        var redBillNo = validationService.required(request.redBillNo(), "红冲单号");
        var redQty = ((BigDecimal) sourceRows.get(0).get("qty")).negate();
        var redRows = jdbcTemplate.queryForList("""
            INSERT INTO production_completion (bill_no, task_id, red_source_bill_id, qty, status)
            VALUES (?, ?::uuid, ?::uuid, ?, ?)
            RETURNING id::text AS id, bill_no AS "billNo", status, qty
            """, redBillNo, sourceRows.get(0).get("taskId"), sourceRows.get(0).get("id"), redQty, BillStatus.RED_REVERSED.name());
        copyCompletionLines(billNo, String.valueOf(redRows.get(0).get("id")), true);
        postCompletionLines(redBillNo, BigDecimal.ONE, "PRODUCTION_COMPLETE_RED", "PRODUCTION_COMPLETE_RED:" + redBillNo);
        operationLogService.log("PRODUCTION", "RED_REVERSE_COMPLETE", "production_completion", String.valueOf(redRows.get(0).get("id")), true, null);
        return redRows.get(0);
    }

    private void insertCompletionLine(String completionId, Object lineNo, Object productId, Object warehouseId, BigDecimal qty, BigDecimal unitPrice) {
        jdbcTemplate.update("""
            INSERT INTO production_completion_line (completion_id, line_no, product_id, warehouse_id, qty, unit_price, amount)
            VALUES (?::uuid, ?, ?::uuid, ?::uuid, ?, ?, ?)
            """, completionId, lineNo, productId, warehouseId, qty, unitPrice, qty.multiply(unitPrice));
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
            SELECT l.line_no AS "lineNo", l.product_id::text AS "productId", l.warehouse_id::text AS "warehouseId", l.qty, l.unit_price AS "unitPrice"
            FROM production_completion_line l
            JOIN production_completion c ON c.id = l.completion_id
            WHERE c.bill_no = ?
            ORDER BY l.line_no
            """, sourceBillNo);
        for (var line : lines) {
            var qty = (BigDecimal) line.get("qty");
            insertCompletionLine(targetCompletionId, line.get("lineNo"), line.get("productId"), line.get("warehouseId"), negate ? qty.negate() : qty, (BigDecimal) line.get("unitPrice"));
        }
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

    public record CompleteLineRequest(String productCode, String warehouseCode, BigDecimal qty, BigDecimal unitPrice) {
    }
}
