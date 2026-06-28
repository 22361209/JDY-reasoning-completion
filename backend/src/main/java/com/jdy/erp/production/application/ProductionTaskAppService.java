package com.jdy.erp.production.application;

import java.math.BigDecimal;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

import com.jdy.erp.shared.application.LookupService;
import com.jdy.erp.shared.application.NumberingService;
import com.jdy.erp.shared.application.OperationLogService;
import com.jdy.erp.shared.application.ValidationService;
import com.jdy.erp.shared.domain.BillStatus;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.server.ResponseStatusException;

@Service
public class ProductionTaskAppService {
    private final JdbcTemplate jdbcTemplate;
    private final LookupService lookupService;
    private final ValidationService validationService;
    private final OperationLogService operationLogService;
    private final NumberingService numberingService;

    public ProductionTaskAppService(JdbcTemplate jdbcTemplate, LookupService lookupService, ValidationService validationService, OperationLogService operationLogService, NumberingService numberingService) {
        this.jdbcTemplate = jdbcTemplate;
        this.lookupService = lookupService;
        this.validationService = validationService;
        this.operationLogService = operationLogService;
        this.numberingService = numberingService;
    }

    @Transactional
    public Map<String, Object> saveBom(BomRequest request) {
        var productId = lookupService.lookupEnabledId("md_product", request.productCode(), "成品");
        var rows = jdbcTemplate.queryForList("""
            INSERT INTO prod_bom (code, product_id, qty, enabled)
            VALUES (?, ?::uuid, ?, TRUE)
            ON CONFLICT (code) DO UPDATE
            SET product_id = EXCLUDED.product_id,
                qty = EXCLUDED.qty,
                enabled = TRUE
            RETURNING id::text AS id, code, qty
            """, validationService.required(request.code(), "BOM 编码"), productId, positive(request.qty(), "BOM 数量"));
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
                lookupService.lookupEnabledId("md_product", line.materialCode(), "物料"),
                positive(line.qty(), "物料用量")
            );
            lineNo += 1;
        }
        operationLogService.log("PRODUCTION", "SAVE_BOM", "prod_bom", bomId, true, null);
        return rows.get(0);
    }

    @Transactional
    public Map<String, Object> createPlan(PlanRequest request) {
        return createPlanRow(request);
    }

    @Transactional
    public Map<String, Object> createTask(TaskRequest request) {
        var billNo = numberingService.assignBillNo("productionTask", request.billNo());
        var source = resolveTaskSource(request);
        var rows = jdbcTemplate.queryForList("""
            INSERT INTO production_task (bill_no, plan_id, bom_id, product_id, product_code_snapshot, product_name_snapshot, product_spec_snapshot, warehouse_id, qty, status)
            VALUES (?, ?::uuid, ?::uuid, ?::uuid, ?, ?, ?, ?::uuid, ?, ?)
            ON CONFLICT (bill_no) DO UPDATE
            SET plan_id = EXCLUDED.plan_id,
                bom_id = EXCLUDED.bom_id,
                product_id = EXCLUDED.product_id,
                product_code_snapshot = EXCLUDED.product_code_snapshot,
                product_name_snapshot = EXCLUDED.product_name_snapshot,
                product_spec_snapshot = EXCLUDED.product_spec_snapshot,
                warehouse_id = EXCLUDED.warehouse_id,
                qty = EXCLUDED.qty,
                status = EXCLUDED.status,
                updated_at = now()
            RETURNING id::text AS id, bill_no AS "billNo", qty, status
            """,
            billNo,
            source.get("planId"),
            source.get("bomId"),
            source.get("productId"),
            source.get("productCode"),
            source.get("productName"),
            source.get("spec"),
            source.get("warehouseId"),
            source.get("taskQty"),
            BillStatus.AUDITED.name()
        );
        var taskId = String.valueOf(rows.get(0).get("id"));
        rebuildTaskMaterialSnapshot(taskId);
        operationLogService.log("PRODUCTION", "CREATE_TASK", "production_task", taskId, true, null);
        return rows.get(0);
    }

    @Transactional
    public Map<String, Object> createTaskFromPlan(String planNo, TaskRequest request) {
        return createTask(new TaskRequest(request.billNo(), planNo, request.bomCode(), request.warehouseCode(), request.qty()));
    }

    public List<Map<String, Object>> kitAnalysis(String planNo) {
        return jdbcTemplate.queryForList("""
            SELECT s.line_no AS "lineNo",
                   material.code AS "materialCode",
                   material.name AS "materialName",
                   COALESCE(material.spec, '') AS spec,
                   COALESCE(material.unit, '') AS unit,
                   s.qty * pl.planned_qty AS "requiredQty",
                   COALESCE(stock.qty_available, 0) AS "availableQty",
                   GREATEST(s.qty * pl.planned_qty - COALESCE(stock.qty_available, 0), 0) AS "shortageQty",
                   CASE WHEN COALESCE(stock.qty_available, 0) >= s.qty * pl.planned_qty THEN '齐套' ELSE '缺料' END AS status
            FROM production_plan pl
            JOIN prod_bom_line s ON s.bom_id = pl.bom_id
            JOIN md_product material ON material.id = s.material_id
            LEFT JOIN (
                SELECT product_id, SUM(qty_available) AS qty_available
                FROM inv_stock_balance
                GROUP BY product_id
            ) stock ON stock.product_id = s.material_id
            WHERE pl.bill_no = ?
            ORDER BY s.line_no
            """, validationService.required(planNo, "生产计划单号"));
    }

    private Map<String, Object> resolveTaskSource(TaskRequest request) {
        var planNo = validationService.optionalText(request.planNo());
        if (planNo != null) {
            return resolvePlanForTask(planNo, request.qty());
        }
        return resolveStandaloneTaskSource(request);
    }

    private Map<String, Object> resolvePlanForTask(String planNo, BigDecimal requestedQty) {
        var planRows = jdbcTemplate.queryForList("""
                SELECT p.id::text AS id,
                       p.bom_id::text AS "bomId",
                       p.product_id::text AS "productId",
                       COALESCE(p.product_code_snapshot, mp.code) AS "productCode",
                       COALESCE(p.product_name_snapshot, mp.name) AS "productName",
                       COALESCE(p.product_spec_snapshot, mp.spec, '') AS spec,
                       p.warehouse_id::text AS "warehouseId",
                       p.planned_qty AS "plannedQty",
                       COALESCE(task_qty.assigned_qty, 0) AS "assignedQty"
                FROM production_plan p
                JOIN md_product mp ON mp.id = p.product_id
                LEFT JOIN (
                    SELECT plan_id, SUM(qty) AS assigned_qty
                    FROM production_task
                    WHERE plan_id IS NOT NULL
                    GROUP BY plan_id
                ) task_qty ON task_qty.plan_id = p.id
                WHERE p.bill_no = ?
                  AND p.status = 'AUDITED'
                """, planNo);
        if (planRows.isEmpty()) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "生产计划不存在或未审核");
        }
        var plan = planRows.get(0);
        var plannedQty = (BigDecimal) plan.get("plannedQty");
        var assignedQty = (BigDecimal) plan.get("assignedQty");
        var availableQty = plannedQty.subtract(assignedQty);
        if (availableQty.compareTo(BigDecimal.ZERO) <= 0) {
            throw new ResponseStatusException(HttpStatus.CONFLICT, "生产计划已全部分解为生产任务");
        }
        var taskQty = requestedQty == null ? availableQty : positive(requestedQty, "任务数量");
        if (taskQty.compareTo(availableQty) > 0) {
            throw new ResponseStatusException(HttpStatus.CONFLICT, "任务数量不能超过生产计划剩余数量");
        }
        var source = new LinkedHashMap<String, Object>();
        source.put("planId", plan.get("id"));
        source.put("bomId", plan.get("bomId"));
        source.put("productId", plan.get("productId"));
        source.put("productCode", plan.get("productCode"));
        source.put("productName", plan.get("productName"));
        source.put("spec", plan.get("spec"));
        source.put("warehouseId", plan.get("warehouseId"));
        source.put("taskQty", taskQty);
        return source;
    }

    private Map<String, Object> resolveStandaloneTaskSource(TaskRequest request) {
        var bomRows = jdbcTemplate.queryForList("""
            SELECT b.id::text AS "bomId",
                   b.product_id::text AS "productId",
                   p.code AS "productCode",
                   p.name AS "productName",
                   COALESCE(p.spec, '') AS spec
            FROM prod_bom b
            JOIN md_product p ON p.id = b.product_id
            WHERE b.code = ? AND b.enabled = TRUE
            """, validationService.required(request.bomCode(), "BOM 编码"));
        if (bomRows.isEmpty()) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "BOM 不存在或未启用");
        }
        var bom = bomRows.get(0);
        var source = new LinkedHashMap<String, Object>();
        source.put("planId", null);
        source.put("bomId", bom.get("bomId"));
        source.put("productId", bom.get("productId"));
        source.put("productCode", bom.get("productCode"));
        source.put("productName", bom.get("productName"));
        source.put("spec", bom.get("spec"));
        source.put("warehouseId", lookupService.lookupEnabledId("md_warehouse", request.warehouseCode(), "完工仓库"));
        source.put("taskQty", positive(request.qty(), "任务数量"));
        return source;
    }

    private Map<String, Object> createPlanRow(PlanRequest request) {
        var planNo = numberingService.assignBillNo("productionPlan", request.billNo());
        var bomRows = jdbcTemplate.queryForList("""
            SELECT b.id::text AS id,
                   b.product_id::text AS product_id,
                   p.code AS product_code,
                   p.name AS product_name,
                   COALESCE(p.spec, '') AS spec
            FROM prod_bom b
            JOIN md_product p ON p.id = b.product_id
            WHERE b.code = ? AND b.enabled = TRUE
            """, validationService.required(request.bomCode(), "BOM 编码"));
        if (bomRows.isEmpty()) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "BOM 不存在或未启用");
        }
        var warehouseId = lookupService.lookupEnabledId("md_warehouse", request.warehouseCode(), "完工仓库");
        var departmentCode = validationService.optionalText(request.departmentCode());
        if (departmentCode != null) {
            lookupService.lookupEnabledId("md_production_department", departmentCode, "生产部门");
        }
        var bom = bomRows.get(0);
        var rows = jdbcTemplate.queryForList("""
            INSERT INTO production_plan (bill_no, bom_id, product_id, product_code_snapshot, product_name_snapshot, product_spec_snapshot, warehouse_id, department_code, planned_qty, source_type, status)
            VALUES (?, ?::uuid, ?::uuid, ?, ?, ?, ?::uuid, ?, ?, ?, ?)
            ON CONFLICT (bill_no) DO UPDATE
            SET bom_id = EXCLUDED.bom_id,
                product_id = EXCLUDED.product_id,
                product_code_snapshot = EXCLUDED.product_code_snapshot,
                product_name_snapshot = EXCLUDED.product_name_snapshot,
                product_spec_snapshot = EXCLUDED.product_spec_snapshot,
                warehouse_id = EXCLUDED.warehouse_id,
                department_code = EXCLUDED.department_code,
                planned_qty = EXCLUDED.planned_qty,
                source_type = EXCLUDED.source_type,
                status = EXCLUDED.status,
                updated_at = now()
            RETURNING id::text AS id,
                      bill_no AS "billNo",
                      bom_id::text AS "bomId",
                      product_id::text AS "productId",
                      product_code_snapshot AS "productCode",
                      product_name_snapshot AS "productName",
                      COALESCE(product_spec_snapshot, '') AS spec,
                      warehouse_id::text AS "warehouseId",
                      planned_qty AS "plannedQty",
                      status
            """,
            planNo,
            bom.get("id"),
            bom.get("product_id"),
            bom.get("product_code"),
            bom.get("product_name"),
            bom.get("spec"),
            warehouseId,
            departmentCode,
            positive(request.qty(), "计划数量"),
            validationService.optionalText(request.sourceType()) == null ? "SELF" : validationService.optionalText(request.sourceType()),
            BillStatus.AUDITED.name()
        );
        operationLogService.log("PRODUCTION", "CREATE_PLAN", "production_plan", String.valueOf(rows.get(0).get("id")), true, null);
        return rows.get(0);
    }

    private void rebuildTaskMaterialSnapshot(String taskId) {
        jdbcTemplate.update("DELETE FROM production_task_material_snapshot WHERE task_id = ?::uuid", taskId);
        jdbcTemplate.update("""
            INSERT INTO production_task_material_snapshot (task_id, line_no, source_bom_line_id, product_id, product_code_snapshot, product_name_snapshot, product_spec_snapshot, unit_qty, required_qty)
            SELECT t.id,
                   l.line_no,
                   l.id,
                   l.material_id,
                   p.code,
                   p.name,
                   p.spec,
                   l.qty,
                   l.qty * t.qty
            FROM production_task t
            JOIN prod_bom_line l ON l.bom_id = t.bom_id
            JOIN md_product p ON p.id = l.material_id
            WHERE t.id = ?::uuid
            ORDER BY l.line_no
            """, taskId);
    }

    private BigDecimal positive(BigDecimal value, String label) {
        if (value == null || value.compareTo(BigDecimal.ZERO) <= 0) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, label + "必须大于 0");
        }
        return value;
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

    public record PlanRequest(String billNo, String bomCode, String warehouseCode, BigDecimal qty, String sourceType, String departmentCode) {
    }

    public record TaskRequest(String billNo, String planNo, String bomCode, String warehouseCode, BigDecimal qty) {
    }
}
