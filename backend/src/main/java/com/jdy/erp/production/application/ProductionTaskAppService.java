package com.jdy.erp.production.application;

import java.math.BigDecimal;
import java.time.LocalDate;
import java.util.ArrayList;
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
        var productCode = validationService.required(request.productCode(), "母件编码");
        var productId = lookupService.lookupEnabledId("md_product", productCode, "成品");
        var requestedCode = validationService.required(request.code(), "BOM 编码");
        var versionNo = jdbcTemplate.queryForObject("SELECT COALESCE(MAX(version_no), 0) + 1 FROM prod_bom WHERE product_id = ?::uuid", Integer.class, productId);
        jdbcTemplate.update("""
            UPDATE prod_bom
            SET is_current = FALSE,
                enabled = FALSE,
                updated_at = now()
            WHERE product_id = ?::uuid
            """, productId);
        var rows = jdbcTemplate.queryForList("""
            INSERT INTO prod_bom (code, product_id, qty, enabled, version_no, is_current, updated_at)
            VALUES (?, ?::uuid, ?, TRUE, ?, TRUE, now())
            RETURNING id::text AS id, code, qty, version_no AS "versionNo", is_current AS "isCurrent"
            """, requestedCode, productId, positive(request.qty(), "BOM 数量"), versionNo == null ? 1 : versionNo);
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
    public Map<String, Object> nextPlanNumber() {
        return Map.of("billNo", numberingService.nextBillNo("productionPlan"));
    }

    @Transactional
    public Map<String, Object> pushDownPlan(String planNo) {
        var source = resolvePlanForTask(planNo, null);
        var task = createTask(new TaskRequest(null, planNo, null, null, (BigDecimal) source.get("taskQty")));
        var purchaseRequisitions = createPurchaseRequisitionsFromPlan(planNo, (BigDecimal) source.get("taskQty"));
        return Map.of(
            "planNo", planNo,
            "productionTasks", List.of(task),
            "purchaseRequisitions", purchaseRequisitions
        );
    }

    @Transactional
    public Map<String, Object> createTask(TaskRequest request) {
        var billNo = numberingService.assignBillNo("productionTask", request.billNo());
        var source = resolveTaskSource(request);
        var rows = jdbcTemplate.queryForList("""
            INSERT INTO production_task (bill_no, plan_id, bom_id, product_id, product_code_snapshot, product_name_snapshot, product_spec_snapshot, warehouse_id, department_code, bom_code_snapshot, bom_version_no, qty, status)
            VALUES (?, ?::uuid, ?::uuid, ?::uuid, ?, ?, ?, ?::uuid, ?, ?, ?, ?, ?)
            ON CONFLICT (bill_no) DO UPDATE
            SET plan_id = EXCLUDED.plan_id,
                bom_id = EXCLUDED.bom_id,
                product_id = EXCLUDED.product_id,
                product_code_snapshot = EXCLUDED.product_code_snapshot,
                product_name_snapshot = EXCLUDED.product_name_snapshot,
                product_spec_snapshot = EXCLUDED.product_spec_snapshot,
                warehouse_id = EXCLUDED.warehouse_id,
                department_code = EXCLUDED.department_code,
                bom_code_snapshot = EXCLUDED.bom_code_snapshot,
                bom_version_no = EXCLUDED.bom_version_no,
                qty = EXCLUDED.qty,
                status = EXCLUDED.status,
                updated_at = now()
            RETURNING id::text AS id, bill_no AS "billNo", department_code AS "departmentCode", bom_code_snapshot AS "bomCode", bom_version_no AS "bomVersionNo", qty, status
            """,
            billNo,
            source.get("planId"),
            source.get("bomId"),
            source.get("productId"),
            source.get("productCode"),
            source.get("productName"),
            source.get("spec"),
            source.get("warehouseId"),
            source.get("departmentCode"),
            source.get("bomCode"),
            source.get("bomVersionNo"),
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
                       p.department_code AS "departmentCode",
                       COALESCE(p.bom_code_snapshot, b.code) AS "bomCode",
                       COALESCE(p.bom_version_no, b.version_no) AS "bomVersionNo",
                       p.planned_qty AS "plannedQty",
                       COALESCE(task_qty.assigned_qty, 0) AS "assignedQty"
                FROM production_plan p
                JOIN md_product mp ON mp.id = p.product_id
                JOIN prod_bom b ON b.id = p.bom_id
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
        source.put("departmentCode", plan.get("departmentCode"));
        source.put("bomCode", plan.get("bomCode"));
        source.put("bomVersionNo", plan.get("bomVersionNo"));
        source.put("taskQty", taskQty);
        return source;
    }

    private Map<String, Object> resolveStandaloneTaskSource(TaskRequest request) {
        var bomRows = jdbcTemplate.queryForList("""
            SELECT b.id::text AS "bomId",
                   b.code AS "bomCode",
                   b.version_no AS "bomVersionNo",
                   b.product_id::text AS "productId",
                   p.code AS "productCode",
                   p.name AS "productName",
                   COALESCE(p.spec, '') AS spec,
                   department.code AS "departmentCode"
            FROM prod_bom b
            JOIN md_product p ON p.id = b.product_id
            LEFT JOIN md_production_department department ON department.id = p.default_workshop_id
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
        source.put("departmentCode", bom.get("departmentCode"));
        source.put("bomCode", bom.get("bomCode"));
        source.put("bomVersionNo", bom.get("bomVersionNo"));
        source.put("taskQty", positive(request.qty(), "任务数量"));
        return source;
    }

    private Map<String, Object> createPlanRow(PlanRequest request) {
        var planNo = numberingService.assignBillNo("productionPlan", request.billNo());
        var bom = resolveCurrentBomForPlan(request.productCode(), request.bomCode());
        var warehouseId = resolveWarehouseId(request.warehouseCode(), (String) bom.get("defaultWarehouseId"));
        var departmentCode = resolveDepartmentCode(request.departmentCode(), (String) bom.get("defaultWorkshopCode"));
        var deliveryDate = parseOptionalDate(request.planDeliveryDate());
        var rows = jdbcTemplate.queryForList("""
            INSERT INTO production_plan (bill_no, bom_id, product_id, product_code_snapshot, product_name_snapshot, product_spec_snapshot, product_unit_snapshot, net_weight_snapshot, gross_weight_snapshot, warehouse_id, department_code, bom_code_snapshot, bom_version_no, planned_qty, plan_delivery_date, source_type, status)
            VALUES (?, ?::uuid, ?::uuid, ?, ?, ?, ?, ?, ?, ?::uuid, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT (bill_no) DO UPDATE
            SET bom_id = EXCLUDED.bom_id,
                product_id = EXCLUDED.product_id,
                product_code_snapshot = EXCLUDED.product_code_snapshot,
                product_name_snapshot = EXCLUDED.product_name_snapshot,
                product_spec_snapshot = EXCLUDED.product_spec_snapshot,
                product_unit_snapshot = EXCLUDED.product_unit_snapshot,
                net_weight_snapshot = EXCLUDED.net_weight_snapshot,
                gross_weight_snapshot = EXCLUDED.gross_weight_snapshot,
                warehouse_id = EXCLUDED.warehouse_id,
                department_code = EXCLUDED.department_code,
                bom_code_snapshot = EXCLUDED.bom_code_snapshot,
                bom_version_no = EXCLUDED.bom_version_no,
                planned_qty = EXCLUDED.planned_qty,
                plan_delivery_date = EXCLUDED.plan_delivery_date,
                source_type = EXCLUDED.source_type,
                status = EXCLUDED.status,
                updated_at = now()
            RETURNING id::text AS id,
                      bill_no AS "billNo",
                      bom_id::text AS "bomId",
                      bom_code_snapshot AS "bomCode",
                      bom_version_no AS "bomVersionNo",
                      product_id::text AS "productId",
                      product_code_snapshot AS "productCode",
                      product_name_snapshot AS "productName",
                      COALESCE(product_spec_snapshot, '') AS spec,
                      COALESCE(product_unit_snapshot, '') AS unit,
                      warehouse_id::text AS "warehouseId",
                      department_code AS "departmentCode",
                      planned_qty AS "plannedQty",
                      to_char(plan_delivery_date, 'YYYY-MM-DD') AS "planDeliveryDate",
                      status
            """,
            planNo,
            bom.get("id"),
            bom.get("productId"),
            bom.get("productCode"),
            bom.get("productName"),
            bom.get("spec"),
            bom.get("unit"),
            bom.get("netWeight"),
            bom.get("grossWeight"),
            warehouseId,
            departmentCode,
            bom.get("bomCode"),
            bom.get("bomVersionNo"),
            positive(request.qty(), "计划数量"),
            deliveryDate,
            validationService.optionalText(request.sourceType()) == null ? "SELF" : validationService.optionalText(request.sourceType()),
            BillStatus.AUDITED.name()
        );
        operationLogService.log("PRODUCTION", "CREATE_PLAN", "production_plan", String.valueOf(rows.get(0).get("id")), true, null);
        return rows.get(0);
    }

    private Map<String, Object> resolveCurrentBomForPlan(String productCode, String bomCode) {
        var normalizedProductCode = validationService.optionalText(productCode);
        if (normalizedProductCode != null) {
            var rows = jdbcTemplate.queryForList("""
                SELECT b.id::text AS id,
                       b.code AS "bomCode",
                       b.version_no AS "bomVersionNo",
                       p.id::text AS "productId",
                       p.code AS "productCode",
                       p.name AS "productName",
                       COALESCE(p.spec, '') AS spec,
                       COALESCE(p.unit, '') AS unit,
                       p.net_weight AS "netWeight",
                       p.gross_weight AS "grossWeight",
                       p.default_warehouse_id::text AS "defaultWarehouseId",
                       department.code AS "defaultWorkshopCode"
                FROM prod_bom b
                JOIN md_product p ON p.id = b.product_id
                LEFT JOIN md_production_department department ON department.id = p.default_workshop_id
                WHERE p.code = ?
                  AND p.enabled = TRUE
                  AND p.audit_status = 'AUDITED'
                  AND b.enabled = TRUE
                  AND b.is_current = TRUE
                """, normalizedProductCode);
            if (rows.isEmpty()) {
                throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "母件没有当前可用 BOM");
            }
            return rows.get(0);
        }
        var rows = jdbcTemplate.queryForList("""
            SELECT b.id::text AS id,
                   b.code AS "bomCode",
                   b.version_no AS "bomVersionNo",
                   p.id::text AS "productId",
                   p.code AS "productCode",
                   p.name AS "productName",
                   COALESCE(p.spec, '') AS spec,
                   COALESCE(p.unit, '') AS unit,
                   p.net_weight AS "netWeight",
                   p.gross_weight AS "grossWeight",
                   p.default_warehouse_id::text AS "defaultWarehouseId",
                   department.code AS "defaultWorkshopCode"
            FROM prod_bom b
            JOIN md_product p ON p.id = b.product_id
            LEFT JOIN md_production_department department ON department.id = p.default_workshop_id
            WHERE b.code = ?
              AND b.enabled = TRUE
            """, validationService.required(bomCode, "母件编码或 BOM 编码"));
        if (rows.isEmpty()) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "BOM 不存在或未启用");
        }
        return rows.get(0);
    }

    private String resolveWarehouseId(String requestedWarehouseCode, String defaultWarehouseId) {
        var warehouseCode = validationService.optionalText(requestedWarehouseCode);
        if (warehouseCode != null) {
            return lookupService.lookupEnabledId("md_warehouse", warehouseCode, "完工仓库");
        }
        if (defaultWarehouseId == null) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "请先维护母件默认仓库，或在生产计划中填写完工仓库");
        }
        return defaultWarehouseId;
    }

    private String resolveDepartmentCode(String requestedDepartmentCode, String defaultWorkshopCode) {
        var departmentCode = validationService.optionalText(requestedDepartmentCode);
        if (departmentCode != null) {
            lookupService.lookupEnabledId("md_production_department", departmentCode, "生产部门");
            return departmentCode;
        }
        if (defaultWorkshopCode != null) {
            lookupService.lookupEnabledId("md_production_department", defaultWorkshopCode, "生产部门");
        }
        return defaultWorkshopCode;
    }

    private LocalDate parseOptionalDate(String value) {
        var text = validationService.optionalText(value);
        return text == null ? null : LocalDate.parse(text);
    }

    private List<Map<String, Object>> createPurchaseRequisitionsFromPlan(String planNo, BigDecimal taskQty) {
        var sourceLines = jdbcTemplate.queryForList("""
            SELECT plan.id::text AS "planId",
                   plan.bill_no AS "planNo",
                   to_char(plan.plan_delivery_date, 'YYYY-MM-DD') AS "planDeliveryDate",
                   COALESCE(plan.department_code, '') AS department,
                   line.id::text AS "sourceBomLineId",
                   line.line_no AS "sourceLineNo",
                   material.id::text AS "productId",
                   material.code AS "productCode",
                   material.name AS "productName",
                   COALESCE(material.spec, '') AS spec,
                   COALESCE(material.unit, '') AS unit,
                   material.net_weight AS "netWeight",
                   material.gross_weight AS "grossWeight",
                   material.default_supplier_id::text AS "supplierId",
                   supplier.code AS "supplierCode",
                   supplier.name AS "supplierName",
                   material.default_warehouse_id::text AS "warehouseId",
                   line.qty * ? AS qty
            FROM production_plan plan
            JOIN prod_bom_line line ON line.bom_id = plan.bom_id
            JOIN md_product material ON material.id = line.material_id
            LEFT JOIN md_supplier supplier ON supplier.id = material.default_supplier_id
            WHERE plan.bill_no = ?
              AND material.enabled = TRUE
              AND material.audit_status = 'AUDITED'
              AND material.is_purchase = TRUE
            ORDER BY supplier.code NULLS LAST, line.line_no
            """, taskQty, planNo);
        if (sourceLines.stream().anyMatch(line -> line.get("supplierId") == null)) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "可采购物料缺少默认供应商，无法自动生成采购申请");
        }
        var bySupplier = new LinkedHashMap<String, List<Map<String, Object>>>();
        for (var line : sourceLines) {
            bySupplier.computeIfAbsent(String.valueOf(line.get("supplierId")), ignored -> new ArrayList<>()).add(line);
        }
        var result = new ArrayList<Map<String, Object>>();
        for (var entry : bySupplier.entrySet()) {
            var lines = entry.getValue();
            if (lines.isEmpty()) {
                continue;
            }
            var first = lines.get(0);
            var billNo = numberingService.nextBillNo("purchaseRequisition");
            var header = jdbcTemplate.queryForMap("""
                INSERT INTO purchase_requisition (bill_no, source_plan_id, source_plan_no, supplier_id, supplier_code_snapshot, supplier_name_snapshot, bill_date, department, status, owner_name)
                VALUES (?, ?::uuid, ?, ?::uuid, ?, ?, CURRENT_DATE, ?, ?, ?)
                RETURNING id::text AS id, bill_no AS "billNo", supplier_code_snapshot AS "supplierCode", supplier_name_snapshot AS supplier, status
                """,
                billNo,
                first.get("planId"),
                first.get("planNo"),
                first.get("supplierId"),
                first.get("supplierCode"),
                first.get("supplierName"),
                first.get("department"),
                BillStatus.AUDITED.name(),
                "系统生成"
            );
            var lineNo = 1;
            for (var line : lines) {
                jdbcTemplate.update("""
                    INSERT INTO purchase_requisition_line (requisition_id, line_no, source_plan_id, source_plan_no, source_bom_line_id, product_id, product_code_snapshot, product_name_snapshot, product_spec_snapshot, product_unit_snapshot, net_weight_snapshot, gross_weight_snapshot, warehouse_id, qty, plan_delivery_date)
                    VALUES (?::uuid, ?, ?::uuid, ?, ?::uuid, ?::uuid, ?, ?, ?, ?, ?, ?, ?::uuid, ?, ?::date)
                    """,
                    header.get("id"),
                    lineNo,
                    line.get("planId"),
                    line.get("planNo"),
                    line.get("sourceBomLineId"),
                    line.get("productId"),
                    line.get("productCode"),
                    line.get("productName"),
                    line.get("spec"),
                    line.get("unit"),
                    line.get("netWeight"),
                    line.get("grossWeight"),
                    line.get("warehouseId"),
                    line.get("qty"),
                    line.get("planDeliveryDate")
                );
                lineNo += 1;
            }
            result.add(header);
        }
        return result;
    }

    private void rebuildTaskMaterialSnapshot(String taskId) {
        jdbcTemplate.update("DELETE FROM production_task_material_snapshot WHERE task_id = ?::uuid", taskId);
        jdbcTemplate.update("""
            INSERT INTO production_task_material_snapshot (task_id, line_no, source_bom_line_id, product_id, product_code_snapshot, product_name_snapshot, product_spec_snapshot, product_unit_snapshot, net_weight_snapshot, gross_weight_snapshot, bom_code_snapshot, bom_version_no, unit_qty, required_qty)
            SELECT t.id,
                   l.line_no,
                   l.id,
                   l.material_id,
                   p.code,
                   p.name,
                   p.spec,
                   p.unit,
                   p.net_weight,
                   p.gross_weight,
                   t.bom_code_snapshot,
                   t.bom_version_no,
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

    public record PlanRequest(String billNo, String productCode, String bomCode, String warehouseCode, BigDecimal qty, String sourceType, String departmentCode, String planDeliveryDate) {
    }

    public record TaskRequest(String billNo, String planNo, String bomCode, String warehouseCode, BigDecimal qty) {
    }
}
