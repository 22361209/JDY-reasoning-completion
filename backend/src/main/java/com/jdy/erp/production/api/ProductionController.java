package com.jdy.erp.production.api;

import java.math.BigDecimal;
import java.util.List;
import java.util.Map;

import com.jdy.erp.inventory.application.InventoryPostingService;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.ResponseStatus;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.server.ResponseStatusException;

@RestController
@RequestMapping("/api/production")
public class ProductionController {
    private final JdbcTemplate jdbcTemplate;
    private final InventoryPostingService postingService;

    public ProductionController(JdbcTemplate jdbcTemplate, InventoryPostingService postingService) {
        this.jdbcTemplate = jdbcTemplate;
        this.postingService = postingService;
    }

    @GetMapping("/material-issues/{billNo}")
    public Map<String, Object> issueDetail(@PathVariable String billNo) {
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
                   '本地管理员' AS "ownerName"
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

    @GetMapping("/product-ins/{billNo}")
    public Map<String, Object> completionDetail(@PathVariable String billNo) {
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
                   '本地管理员' AS "ownerName"
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

    @PostMapping("/boms")
    @ResponseStatus(HttpStatus.CREATED)
    @Transactional
    public Map<String, Object> saveBom(@RequestBody BomRequest request) {
        var productId = lookupId("md_product", request.productCode(), "成品");
        var rows = jdbcTemplate.queryForList("""
            INSERT INTO prod_bom (code, product_id, qty, enabled)
            VALUES (?, ?::uuid, ?, TRUE)
            ON CONFLICT (code) DO UPDATE
            SET product_id = EXCLUDED.product_id,
                qty = EXCLUDED.qty,
                enabled = TRUE
            RETURNING id::text AS id, code, qty
            """, required(request.code(), "BOM 编码"), productId, positive(request.qty(), "BOM 数量"));
        var bomId = String.valueOf(rows.get(0).get("id"));
        jdbcTemplate.update("DELETE FROM prod_bom_line WHERE bom_id = ?::uuid", bomId);
        var lineNo = 1;
        for (var line : request.lines()) {
            jdbcTemplate.update("""
                INSERT INTO prod_bom_line (bom_id, line_no, material_id, qty)
                VALUES (?::uuid, ?, ?::uuid, ?)
                """,
                bomId,
                lineNo,
                lookupId("md_product", line.materialCode(), "物料"),
                positive(line.qty(), "物料用量")
            );
            lineNo += 1;
        }
        log("PRODUCTION", "SAVE_BOM", "prod_bom", bomId, true, null);
        return rows.get(0);
    }

    @PostMapping("/tasks")
    @ResponseStatus(HttpStatus.CREATED)
    @Transactional
    public Map<String, Object> createTask(@RequestBody TaskRequest request) {
        var bomRows = jdbcTemplate.queryForList("""
            SELECT b.id::text AS id, b.product_id::text AS product_id
            FROM prod_bom b
            WHERE b.code = ? AND b.enabled = TRUE
            """, required(request.bomCode(), "BOM 编码"));
        if (bomRows.isEmpty()) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "BOM 不存在或未启用");
        }
        var warehouseId = lookupId("md_warehouse", request.warehouseCode(), "完工仓库");
        var bom = bomRows.get(0);
        var rows = jdbcTemplate.queryForList("""
            INSERT INTO production_task (bill_no, bom_id, product_id, warehouse_id, qty, status)
            VALUES (?, ?::uuid, ?::uuid, ?::uuid, ?, 'AUDITED')
            ON CONFLICT (bill_no) DO UPDATE
            SET bom_id = EXCLUDED.bom_id,
                product_id = EXCLUDED.product_id,
                warehouse_id = EXCLUDED.warehouse_id,
                qty = EXCLUDED.qty,
                status = 'AUDITED',
                updated_at = now()
            RETURNING id::text AS id, bill_no AS "billNo", qty, status
            """,
            required(request.billNo(), "生产任务单号"),
            bom.get("id"),
            bom.get("product_id"),
            warehouseId,
            positive(request.qty(), "生产数量")
        );
        log("PRODUCTION", "CREATE_TASK", "production_task", String.valueOf(rows.get(0).get("id")), true, null);
        return rows.get(0);
    }

    @PostMapping("/tasks/{billNo}/issue")
    @ResponseStatus(HttpStatus.CREATED)
    @Transactional
    public Map<String, Object> issue(@PathVariable String billNo, @RequestBody IssueRequest request) {
        var taskRows = jdbcTemplate.queryForList("""
            SELECT id::text AS id, bom_id::text AS bom_id, qty
            FROM production_task
            WHERE bill_no = ? AND status IN ('AUDITED', 'ISSUED')
            """, billNo);
        if (taskRows.isEmpty()) {
            throw new ResponseStatusException(HttpStatus.CONFLICT, "生产任务不存在或不能领料");
        }
        var task = taskRows.get(0);
        var materialWarehouseId = lookupId("md_warehouse", request.materialWarehouseCode(), "领料仓库");
        var materialWarehouseCode = required(request.materialWarehouseCode(), "领料仓库");
        var issueRows = jdbcTemplate.queryForList("""
            INSERT INTO production_material_issue (bill_no, task_id, status)
            VALUES (?, ?::uuid, 'AUDITED')
            RETURNING id::text AS id, bill_no AS "billNo", status
            """, required(request.billNo(), "领料单号"), task.get("id"));
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
            postingService.post(
                String.valueOf(line.get("materialCode")),
                materialWarehouseCode,
                neededQty.negate(),
                "PRODUCTION_ISSUE",
                "PRODUCTION_ISSUE:" + request.billNo()
            );
        }
        jdbcTemplate.update("""
            UPDATE production_task
            SET issued_qty = qty,
                status = CASE WHEN completed_qty >= qty THEN 'COMPLETED' ELSE 'ISSUED' END,
                updated_at = now()
            WHERE id = ?::uuid
            """, task.get("id"));
        log("PRODUCTION", "ISSUE", "production_material_issue", String.valueOf(issueRows.get(0).get("id")), true, null);
        return issueRows.get(0);
    }

    @PostMapping("/material-issues/{billNo}/reverse")
    @Transactional
    public Map<String, Object> reverseIssue(@PathVariable String billNo) {
        var rows = jdbcTemplate.queryForList("""
            UPDATE production_material_issue
            SET status = 'REVERSED', reversed_at = now()
            WHERE bill_no = ? AND status = 'AUDITED'
            RETURNING id::text AS id, bill_no AS "billNo", status
            """, billNo);
        if (rows.isEmpty()) {
            throw new ResponseStatusException(HttpStatus.CONFLICT, "生产领料单不存在或不能反审核");
        }
        postIssueLines(billNo, BigDecimal.ONE, "PRODUCTION_ISSUE_REVERSE", "PRODUCTION_ISSUE_REVERSE:" + billNo);
        log("PRODUCTION", "REVERSE_ISSUE", "production_material_issue", String.valueOf(rows.get(0).get("id")), true, null);
        return rows.get(0);
    }

    @PostMapping("/material-issues/{billNo}/red-reverse")
    @ResponseStatus(HttpStatus.CREATED)
    @Transactional
    public Map<String, Object> redReverseIssue(@PathVariable String billNo, @RequestBody RedReverseRequest request) {
        var sourceRows = jdbcTemplate.queryForList("""
            SELECT id::text AS id, task_id::text AS "taskId"
            FROM production_material_issue
            WHERE bill_no = ? AND status = 'AUDITED'
            """, billNo);
        if (sourceRows.isEmpty()) {
            throw new ResponseStatusException(HttpStatus.CONFLICT, "只有已审核生产领料单可以红冲");
        }
        var redBillNo = required(request.redBillNo(), "红冲单号");
        var redRows = jdbcTemplate.queryForList("""
            INSERT INTO production_material_issue (bill_no, task_id, status)
            VALUES (?, ?::uuid, 'RED_REVERSED')
            RETURNING id::text AS id, bill_no AS "billNo", status
            """, redBillNo, sourceRows.get(0).get("taskId"));
        copyIssueLines(billNo, String.valueOf(redRows.get(0).get("id")), true);
        postIssueLines(redBillNo, BigDecimal.ONE.negate(), "PRODUCTION_ISSUE_RED", "PRODUCTION_ISSUE_RED:" + redBillNo);
        log("PRODUCTION", "RED_REVERSE_ISSUE", "production_material_issue", String.valueOf(redRows.get(0).get("id")), true, null);
        return redRows.get(0);
    }

    @PostMapping("/tasks/{billNo}/complete")
    @ResponseStatus(HttpStatus.CREATED)
    @Transactional
    public Map<String, Object> complete(@PathVariable String billNo, @RequestBody CompleteRequest request) {
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
            VALUES (?, ?::uuid, ?, 'AUDITED')
            RETURNING id::text AS id, bill_no AS "billNo", qty, status
            """, required(request.billNo(), "完工单号"), task.get("id"), qty);
        var completionId = String.valueOf(completionRows.get(0).get("id"));
        var lineNo = 1;
        for (var line : requestLines) {
            var productCode = required(line.productCode(), "完工商品编码");
            var warehouseCode = required(line.warehouseCode(), "完工仓库");
            var lineQty = positive(line.qty(), "完工数量");
            var unitPrice = line.unitPrice() == null ? BigDecimal.ONE : line.unitPrice();
            insertCompletionLine(completionId, lineNo, lookupId("md_product", productCode, "完工商品"), lookupId("md_warehouse", warehouseCode, "完工仓库"), lineQty, unitPrice);
            postingService.post(productCode, warehouseCode, lineQty, "PRODUCTION_COMPLETE", "PRODUCTION_COMPLETE:" + request.billNo());
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
        log("PRODUCTION", "COMPLETE", "production_completion", String.valueOf(completionRows.get(0).get("id")), true, null);
        return rows.get(0);
    }

    @PostMapping("/product-ins/{billNo}/reverse")
    @Transactional
    public Map<String, Object> reverseCompletion(@PathVariable String billNo) {
        var rows = jdbcTemplate.queryForList("""
            UPDATE production_completion
            SET status = 'REVERSED', reversed_at = now()
            WHERE bill_no = ? AND status = 'AUDITED'
            RETURNING id::text AS id, bill_no AS "billNo", status
            """, billNo);
        if (rows.isEmpty()) {
            throw new ResponseStatusException(HttpStatus.CONFLICT, "产品入库单不存在或不能反审核");
        }
        postCompletionLines(billNo, BigDecimal.ONE.negate(), "PRODUCTION_COMPLETE_REVERSE", "PRODUCTION_COMPLETE_REVERSE:" + billNo);
        log("PRODUCTION", "REVERSE_COMPLETE", "production_completion", String.valueOf(rows.get(0).get("id")), true, null);
        return rows.get(0);
    }

    @PostMapping("/product-ins/{billNo}/red-reverse")
    @ResponseStatus(HttpStatus.CREATED)
    @Transactional
    public Map<String, Object> redReverseCompletion(@PathVariable String billNo, @RequestBody RedReverseRequest request) {
        var sourceRows = jdbcTemplate.queryForList("""
            SELECT id::text AS id, task_id::text AS "taskId", qty
            FROM production_completion
            WHERE bill_no = ? AND status = 'AUDITED'
            """, billNo);
        if (sourceRows.isEmpty()) {
            throw new ResponseStatusException(HttpStatus.CONFLICT, "只有已审核产品入库单可以红冲");
        }
        var redBillNo = required(request.redBillNo(), "红冲单号");
        var redQty = ((BigDecimal) sourceRows.get(0).get("qty")).negate();
        var redRows = jdbcTemplate.queryForList("""
            INSERT INTO production_completion (bill_no, task_id, qty, status)
            VALUES (?, ?::uuid, ?, 'RED_REVERSED')
            RETURNING id::text AS id, bill_no AS "billNo", status, qty
            """, redBillNo, sourceRows.get(0).get("taskId"), redQty);
        copyCompletionLines(billNo, String.valueOf(redRows.get(0).get("id")), true);
        postCompletionLines(redBillNo, BigDecimal.ONE, "PRODUCTION_COMPLETE_RED", "PRODUCTION_COMPLETE_RED:" + redBillNo);
        log("PRODUCTION", "RED_REVERSE_COMPLETE", "production_completion", String.valueOf(redRows.get(0).get("id")), true, null);
        return redRows.get(0);
    }

    private void insertIssueLine(String issueId, Object lineNo, Object productId, Object warehouseId, BigDecimal qty, BigDecimal unitPrice) {
        jdbcTemplate.update("""
            INSERT INTO production_material_issue_line (issue_id, line_no, product_id, warehouse_id, qty, unit_price, amount)
            VALUES (?::uuid, ?, ?::uuid, ?::uuid, ?, ?, ?)
            """, issueId, lineNo, productId, warehouseId, qty, unitPrice, qty.multiply(unitPrice));
    }

    private void insertCompletionLine(String completionId, Object lineNo, Object productId, Object warehouseId, BigDecimal qty, BigDecimal unitPrice) {
        jdbcTemplate.update("""
            INSERT INTO production_completion_line (completion_id, line_no, product_id, warehouse_id, qty, unit_price, amount)
            VALUES (?::uuid, ?, ?::uuid, ?::uuid, ?, ?, ?)
            """, completionId, lineNo, productId, warehouseId, qty, unitPrice, qty.multiply(unitPrice));
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
            postingService.post(
                String.valueOf(line.get("productCode")),
                String.valueOf(line.get("warehouseCode")),
                ((BigDecimal) line.get("qty")).multiply(sign),
                txnType,
                sourceBillType
            );
        }
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
            postingService.post(
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

    private String lookupId(String table, String code, String label) {
        var value = required(code, label + "编码");
        var rows = jdbcTemplate.queryForList("SELECT id::text AS id FROM " + table + " WHERE code = ? AND enabled = TRUE", value);
        if (rows.isEmpty()) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, label + "不存在或已禁用");
        }
        return String.valueOf(rows.get(0).get("id"));
    }

    private BigDecimal positive(BigDecimal value, String label) {
        if (value == null || value.compareTo(BigDecimal.ZERO) <= 0) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, label + "必须大于 0");
        }
        return value;
    }

    private String required(String value, String label) {
        if (value == null || value.isBlank()) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, label + "不能为空");
        }
        return value.trim();
    }

    private void log(String module, String action, String targetType, String targetId, boolean success, String reason) {
        jdbcTemplate.update("""
            INSERT INTO sys_operation_log (module_code, action_code, target_type, target_id, success, failure_reason)
            VALUES (?, ?, ?, ?::uuid, ?, ?)
            """, module, action, targetType, targetId, success, reason);
    }

    public record BomRequest(String code, String productCode, BigDecimal qty, List<BomLineRequest> lines) {
        public BomRequest {
            if (lines == null || lines.isEmpty()) {
                throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "BOM 至少需要一条物料");
            }
        }
    }

    public record BomLineRequest(String materialCode, BigDecimal qty) {
    }

    public record TaskRequest(String billNo, String bomCode, String warehouseCode, BigDecimal qty) {
    }

    public record IssueRequest(String billNo, String materialWarehouseCode) {
    }

    public record CompleteRequest(String billNo, BigDecimal qty, List<CompleteLineRequest> lines) {
    }

    public record CompleteLineRequest(String productCode, String warehouseCode, BigDecimal qty, BigDecimal unitPrice) {
    }

    public record RedReverseRequest(String redBillNo) {
    }
}
