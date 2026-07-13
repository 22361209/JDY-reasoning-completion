package com.jdy.erp.production.application;

import java.math.BigDecimal;
import java.math.RoundingMode;
import java.time.LocalDate;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;

import com.jdy.erp.shared.application.LookupService;
import com.jdy.erp.shared.application.NumberingService;
import com.jdy.erp.shared.application.OperationLogCommand;
import com.jdy.erp.shared.application.OperationLogService;
import com.jdy.erp.shared.application.ValidationService;
import com.jdy.erp.shared.domain.BillStatus;
import com.jdy.erp.system.security.CurrentSessionService;
import com.jdy.erp.system.tenant.TenantDataScopeService;
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
    private final TenantDataScopeService tenantDataScopeService;
    private final CurrentSessionService currentSessionService;

    public ProductionTaskAppService(JdbcTemplate jdbcTemplate, LookupService lookupService, ValidationService validationService, OperationLogService operationLogService, NumberingService numberingService, TenantDataScopeService tenantDataScopeService, CurrentSessionService currentSessionService) {
        this.jdbcTemplate = jdbcTemplate;
        this.lookupService = lookupService;
        this.validationService = validationService;
        this.operationLogService = operationLogService;
        this.numberingService = numberingService;
        this.tenantDataScopeService = tenantDataScopeService;
        this.currentSessionService = currentSessionService;
    }

    @Transactional
    public Map<String, Object> saveBom(BomRequest request) {
        var productCode = validationService.required(request.productCode(), "母件编码");
        var product = lookupAuditedMaterial(productCode, "母件");
        var productId = String.valueOf(product.get("id"));
        var requestedCode = validationService.required(request.code(), "BOM 编码");
        var bomQty = positive(request.qty(), "母件数量");
        var userId = currentSessionService.currentUserId();
        var existingDraft = jdbcTemplate.queryForList("""
            SELECT id::text AS id
            FROM prod_bom
            WHERE code = ?
              AND audit_status = 'DRAFT'
            ORDER BY updated_at DESC
            LIMIT 1
            """, requestedCode);
        var versionNo = jdbcTemplate.queryForObject(
            "SELECT COALESCE(MAX(version_no), 0) + 1 FROM prod_bom WHERE product_id = ?::uuid",
            Integer.class,
            productId
        );
        var bomId = existingDraft.isEmpty()
            ? String.valueOf(jdbcTemplate.queryForMap("""
                INSERT INTO prod_bom (code, product_id, qty, enabled, audit_status, version_no, is_current, bom_category, remark, updated_at, updated_by)
                VALUES (?, ?::uuid, ?, TRUE, 'DRAFT', ?, FALSE, ?, ?, now(), ?::uuid)
                RETURNING id::text AS id
                """,
                requestedCode,
                productId,
                bomQty,
                versionNo == null ? 1 : versionNo,
                validationService.optionalText(request.bomCategory()),
                validationService.optionalText(request.remark()),
                userId
            ).get("id"))
            : String.valueOf(existingDraft.get(0).get("id"));
        if (!existingDraft.isEmpty()) {
            jdbcTemplate.update("""
                UPDATE prod_bom
                SET product_id = ?::uuid,
                    qty = ?,
                    enabled = TRUE,
                    is_current = FALSE,
                    bom_category = ?,
                    remark = ?,
                    updated_by = ?::uuid,
                    updated_at = now()
                WHERE id = ?::uuid
                """,
                productId,
                bomQty,
                validationService.optionalText(request.bomCategory()),
                validationService.optionalText(request.remark()),
                userId,
                bomId
            );
        }
        jdbcTemplate.update("DELETE FROM prod_bom_line WHERE bom_id = ?::uuid", bomId);
        var lineNo = 1;
        for (var line : request.lines()) {
            var material = lookupAuditedMaterial(line.materialCode(), "子件物料");
            var materialId = String.valueOf(material.get("id"));
            var productQty = positive(line.productQty() == null ? bomQty : line.productQty(), "产品产量");
            var materialQty = line.materialQty() == null
                ? positive(line.qty(), "材料用量")
                : positive(line.materialQty(), "材料用量");
            var unitQty = materialQty.divide(productQty, 6, RoundingMode.HALF_UP);
            var issueWarehouseCode = validationService.optionalText(line.issueWarehouseCode());
            var issueWarehouseId = issueWarehouseCode == null
                ? nullableText(material.get("defaultWarehouseId"))
                : lookupService.lookupEnabledId("md_warehouse", issueWarehouseCode, "发料仓库");
            var resolvedIssueWarehouseCode = issueWarehouseCode == null
                ? nullableText(material.get("defaultWarehouseCode"))
                : issueWarehouseCode;
            var childBom = lookupOptionalCurrentBom(line.childBomCode());
            jdbcTemplate.update("""
                INSERT INTO prod_bom_line (
                    bom_id, line_no, material_id, qty, product_qty, material_qty, unit_qty,
                    issue_method, issue_warehouse_id, issue_warehouse_code, fixed_loss_qty,
                    loss_rate, child_bom_id, child_bom_code_snapshot, child_bom_version_no
                )
                VALUES (?::uuid, ?, ?::uuid, ?, ?, ?, ?, ?, ?::uuid, ?, ?, ?, ?::uuid, ?, ?)
                """,
                bomId,
                lineNo,
                materialId,
                unitQty,
                productQty,
                materialQty,
                unitQty,
                normalizedIssueMethod(line.issueMethod()),
                issueWarehouseId,
                resolvedIssueWarehouseCode,
                nonNegative(line.fixedLossQty(), "固定损耗"),
                nonNegative(line.lossRate(), "损耗率"),
                childBom.get("id"),
                childBom.get("code"),
                childBom.get("versionNo")
            );
            lineNo += 1;
        }
        operationLogService.logCurrent(OperationLogCommand.success(
            "PRODUCTION", "SAVE_BOM", "prod_bom",
            UUID.fromString(bomId), requestedCode, Map.of(),
            OperationLogCommand.state(OperationLogCommand.StateField.AUDIT_STATUS, "DRAFT")
        ));
        return bomDetailById(bomId);
    }

    public Map<String, Object> bomDetail(String code) {
        var bom = findBomByCode(validationService.required(code, "BOM 编码"));
        return bomDetailById(String.valueOf(bom.get("id")));
    }

    public Map<String, Object> bomAuditPreview(String code) {
        var bom = findBomByCode(validationService.required(code, "BOM 编码"));
        var bomId = String.valueOf(bom.get("id"));
        return bomAuditPreviewForBom(bom, bomId);
    }

    private Map<String, Object> bomAuditPreviewForBom(Map<String, Object> bom, String bomId) {
        var latestAuditedRows = jdbcTemplate.queryForList("""
            SELECT id::text AS id,
                   code,
                   version_no AS "versionNo"
            FROM prod_bom
            WHERE product_id = ?::uuid
              AND id <> ?::uuid
              AND audit_status = 'AUDITED'
            ORDER BY version_no DESC, updated_at DESC, created_at DESC
            LIMIT 1
            """, bom.get("productId"), bomId);
        if (latestAuditedRows.isEmpty()) {
            return Map.of("requiresConfirmation", false);
        }
        var latestBom = latestAuditedRows.get(0);
        var draftLineSignatures = bomLineSignatures(bomId);
        var latestLineSignatures = bomLineSignatures(String.valueOf(latestBom.get("id")));
        if (!draftLineSignatures.isEmpty() && draftLineSignatures.equals(latestLineSignatures)) {
            var result = new LinkedHashMap<String, Object>();
            result.put("blocked", true);
            result.put("reason", "SAME_AS_LATEST_BOM");
            result.put("latestBomCode", latestBom.get("code"));
            result.put("latestVersionNo", latestBom.get("versionNo"));
            result.put("message", "当前草稿的子件物料与当前版本 BOM 完全一致，请核对后重新提交或关闭。");
            return result;
        }
        var draftMaterialCodes = bomMaterialCodes(bomId);
        var latestMaterialCodes = bomMaterialCodes(String.valueOf(latestBom.get("id")));
        if (draftMaterialCodes.isEmpty() || draftMaterialCodes.equals(latestMaterialCodes)) {
            return Map.of("requiresConfirmation", false);
        }
        var result = new LinkedHashMap<String, Object>();
        result.put("requiresConfirmation", true);
        result.put("latestBomCode", latestBom.get("code"));
        result.put("latestVersionNo", latestBom.get("versionNo"));
        result.put("message", "该母件已有已审核 BOM，当前草稿的子件物料编码与当前版本不同。审核后会新增该母件的新版本，并禁用旧版本。");
        return result;
    }

    @Transactional
    public Map<String, Object> auditBom(String code) {
        return auditBom(code, null);
    }

    @Transactional
    public Map<String, Object> auditBom(String code, BomAuditRequest request) {
        var bom = findBomByCode(validationService.required(code, "BOM 编码"));
        var bomId = String.valueOf(bom.get("id"));
        var productId = String.valueOf(bom.get("productId"));
        var userId = currentSessionService.currentUserId();
        var lineCount = jdbcTemplate.queryForObject("SELECT COUNT(*) FROM prod_bom_line WHERE bom_id = ?::uuid", Integer.class, bomId);
        if (lineCount == null || lineCount == 0) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "BOM 至少需要一条子件明细");
        }
        enforceBomAuditPreview(bom, bomId, request);
        jdbcTemplate.update("""
            UPDATE prod_bom
            SET is_current = FALSE,
                enabled = FALSE,
                updated_by = ?::uuid,
                updated_at = now()
            WHERE product_id = ?::uuid
              AND id <> ?::uuid
              AND is_current = TRUE
            """, userId, productId, bomId);
        jdbcTemplate.update("""
            UPDATE prod_bom
            SET audit_status = 'AUDITED',
                enabled = TRUE,
                is_current = TRUE,
                updated_by = ?::uuid,
                updated_at = now()
            WHERE id = ?::uuid
            """, userId, bomId);
        operationLogService.logCurrent(OperationLogCommand.success(
            "PRODUCTION", "AUDIT_BOM", "prod_bom",
            UUID.fromString(bomId), code,
            OperationLogCommand.state(OperationLogCommand.StateField.AUDIT_STATUS, "DRAFT"),
            OperationLogCommand.state(OperationLogCommand.StateField.AUDIT_STATUS, "AUDITED")
        ));
        return bomDetailById(bomId);
    }

    private void enforceBomAuditPreview(Map<String, Object> bom, String bomId, BomAuditRequest request) {
        var preview = bomAuditPreviewForBom(bom, bomId);
        var message = String.valueOf(preview.getOrDefault("message", ""));
        if (Boolean.TRUE.equals(preview.get("blocked"))) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, message);
        }
        if (!Boolean.TRUE.equals(preview.get("requiresConfirmation"))) {
            return;
        }
        if (request == null || !Boolean.TRUE.equals(request.confirmNewVersion())) {
            throw new ResponseStatusException(HttpStatus.CONFLICT, message);
        }
        var latestBomCode = String.valueOf(preview.getOrDefault("latestBomCode", ""));
        var latestVersionNo = String.valueOf(preview.getOrDefault("latestVersionNo", ""));
        var confirmedBomCode = validationService.optionalText(request.latestBomCode());
        var confirmedVersionNo = validationService.optionalText(request.latestVersionNo());
        if (!latestBomCode.equals(confirmedBomCode) || !latestVersionNo.equals(confirmedVersionNo)) {
            throw new ResponseStatusException(HttpStatus.CONFLICT, "当前母件最新 BOM 已变化，请重新审核。");
        }
    }

    @Transactional
    public Map<String, Object> reverseBom(String code) {
        var bom = findBomByCode(validationService.required(code, "BOM 编码"));
        var bomId = String.valueOf(bom.get("id"));
        var userId = currentSessionService.currentUserId();
        ensureBomNotReferenced(bomId, "反审核");
        jdbcTemplate.update("""
            UPDATE prod_bom
            SET audit_status = 'DRAFT',
                is_current = FALSE,
                updated_by = ?::uuid,
                updated_at = now()
            WHERE id = ?::uuid
            """, userId, bomId);
        operationLogService.logCurrent(OperationLogCommand.success(
            "PRODUCTION", "REVERSE_BOM", "prod_bom",
            UUID.fromString(bomId), code,
            OperationLogCommand.state(OperationLogCommand.StateField.AUDIT_STATUS, "AUDITED"),
            OperationLogCommand.state(OperationLogCommand.StateField.AUDIT_STATUS, "DRAFT")
        ));
        return bomDetailById(bomId);
    }

    @Transactional
    public Map<String, Object> setBomEnabled(String code, boolean enabled) {
        var bom = findBomByCode(validationService.required(code, "BOM 编码"));
        var bomId = String.valueOf(bom.get("id"));
        var wasEnabled = Boolean.parseBoolean(String.valueOf(bom.get("enabled")));
        var userId = currentSessionService.currentUserId();
        if (enabled && !"AUDITED".equals(String.valueOf(bom.get("auditStatus")))) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "BOM 未审核，不能启用为当前版本");
        }
        if (enabled) {
            jdbcTemplate.update("""
                UPDATE prod_bom
                SET enabled = FALSE,
                    is_current = FALSE,
                    updated_by = ?::uuid,
                    updated_at = now()
                WHERE product_id = ?::uuid
                  AND id <> ?::uuid
                  AND is_current = TRUE
                """, userId, bom.get("productId"), bomId);
        }
        jdbcTemplate.update("""
            UPDATE prod_bom
            SET enabled = ?,
                is_current = ?,
                updated_by = ?::uuid,
                updated_at = now()
            WHERE id = ?::uuid
            """, enabled, enabled, userId, bomId);
        operationLogService.logCurrent(OperationLogCommand.success(
            "PRODUCTION", enabled ? "ENABLE_BOM" : "DISABLE_BOM", "prod_bom",
            UUID.fromString(bomId), code,
            OperationLogCommand.state(OperationLogCommand.StateField.ENABLED, wasEnabled),
            OperationLogCommand.state(OperationLogCommand.StateField.ENABLED, enabled)
        ));
        return bomDetailById(bomId);
    }

    @Transactional
    public Map<String, Object> deleteBom(String code) {
        var bom = findBomByCode(validationService.required(code, "BOM 编码"));
        var bomId = String.valueOf(bom.get("id"));
        if (!"DRAFT".equals(String.valueOf(bom.get("auditStatus")))) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "只能删除未审核 BOM");
        }
        ensureBomNotReferenced(bomId, "删除");
        jdbcTemplate.update("DELETE FROM prod_bom WHERE id = ?::uuid", bomId);
        operationLogService.logCurrent(OperationLogCommand.success(
            "PRODUCTION", "DELETE_BOM", "prod_bom",
            UUID.fromString(bomId), code,
            OperationLogCommand.state(
                OperationLogCommand.StateField.AUDIT_STATUS, String.valueOf(bom.get("auditStatus")),
                OperationLogCommand.StateField.ENABLED, Boolean.parseBoolean(String.valueOf(bom.get("enabled")))
            ),
            OperationLogCommand.state(OperationLogCommand.StateField.STATUS, "DELETED")
        ));
        return Map.of("code", code, "deleted", true);
    }

    private Map<String, Object> bomDetailById(String bomId) {
        var header = jdbcTemplate.queryForMap("""
            SELECT b.id::text AS id,
                   b.code,
                   b.product_id::text AS "productId",
                   p.code AS "productCode",
                   p.name AS "productName",
                   COALESCE(p.spec, '') AS spec,
                   COALESCE(p.unit, '') AS unit,
                   COALESCE(p.default_warehouse_code, '') AS "warehouseCode",
                   b.qty,
                   COALESCE(b.bom_category, '') AS "bomCategory",
                   COALESCE(b.remark, '') AS remark,
                   b.version_no AS "versionNo",
                   b.is_current AS "isCurrent",
                   b.audit_status AS "auditStatus",
                   b.enabled
            FROM prod_bom b
            JOIN md_product p ON p.id = b.product_id
            WHERE b.id = ?::uuid
            """, bomId);
        var lines = jdbcTemplate.queryForList("""
            SELECT l.id::text AS id,
                   l.line_no AS "lineNo",
                   material.code AS "materialCode",
                   material.name AS "materialName",
                   COALESCE(material.spec, '') AS spec,
                   COALESCE(material.unit, '') AS unit,
                   l.product_qty AS "productQty",
                   COALESCE(l.material_qty, l.qty) AS "materialQty",
                   COALESCE(l.unit_qty, l.qty) AS "unitQty",
                   l.issue_method AS "issueMethod",
                   COALESCE(l.issue_warehouse_code, material.default_warehouse_code, '') AS "issueWarehouseCode",
                   COALESCE(warehouse.name, '') AS "issueWarehouseName",
                   l.fixed_loss_qty AS "fixedLossQty",
                   l.loss_rate AS "lossRate",
                   COALESCE(l.child_bom_code_snapshot, '') AS "childBomCode",
                   l.child_bom_version_no AS "childBomVersionNo"
            FROM prod_bom_line l
            JOIN md_product material ON material.id = l.material_id
            LEFT JOIN md_warehouse warehouse ON warehouse.id = l.issue_warehouse_id
            WHERE l.bom_id = ?::uuid
            ORDER BY l.line_no
            """, bomId);
        var result = new LinkedHashMap<String, Object>(header);
        result.put("lines", lines);
        return result;
    }

    private Map<String, Object> findBomByCode(String code) {
        var rows = jdbcTemplate.queryForList("""
            SELECT id::text AS id,
                   product_id::text AS "productId",
                   code,
                   audit_status AS "auditStatus",
                   enabled,
                   is_current AS "isCurrent"
            FROM prod_bom
            WHERE code = ?
            ORDER BY CASE WHEN audit_status = 'DRAFT' THEN 0 ELSE 1 END,
                     is_current DESC,
                     updated_at DESC,
                     created_at DESC
            LIMIT 1
            """, code);
        if (rows.isEmpty()) {
            throw new ResponseStatusException(HttpStatus.NOT_FOUND, "BOM 不存在");
        }
        return rows.get(0);
    }

    private List<String> bomMaterialCodes(String bomId) {
        return jdbcTemplate.queryForList("""
            SELECT material.code
            FROM prod_bom_line line
            JOIN md_product material ON material.id = line.material_id
            WHERE line.bom_id = ?::uuid
            ORDER BY line.line_no
            """, String.class, bomId);
    }

    private List<String> bomLineSignatures(String bomId) {
        return jdbcTemplate.queryForList("""
            SELECT material.code AS "materialCode",
                   line.product_qty AS "productQty",
                   COALESCE(line.material_qty, line.qty) AS "materialQty",
                   line.issue_method AS "issueMethod",
                   COALESCE(line.issue_warehouse_code, '') AS "issueWarehouseCode",
                   line.fixed_loss_qty AS "fixedLossQty",
                   line.loss_rate AS "lossRate",
                   COALESCE(line.child_bom_code_snapshot, '') AS "childBomCode"
            FROM prod_bom_line line
            JOIN md_product material ON material.id = line.material_id
            WHERE line.bom_id = ?::uuid
            ORDER BY line.line_no
            """, bomId).stream()
            .map(this::bomLineSignature)
            .toList();
    }

    private String bomLineSignature(Map<String, Object> line) {
        return String.join("|",
            signatureText(line.get("materialCode")),
            normalizedDecimal(line.get("productQty")),
            normalizedDecimal(line.get("materialQty")),
            signatureText(line.get("issueMethod")),
            signatureText(line.get("issueWarehouseCode")),
            normalizedDecimal(line.get("fixedLossQty")),
            normalizedDecimal(line.get("lossRate")),
            signatureText(line.get("childBomCode"))
        );
    }

    private String normalizedDecimal(Object value) {
        if (value == null) {
            return "";
        }
        if (value instanceof BigDecimal decimal) {
            return decimal.stripTrailingZeros().toPlainString();
        }
        return signatureText(value);
    }

    private String signatureText(Object value) {
        var text = nullableText(value);
        return text == null ? "" : text;
    }

    private Map<String, Object> lookupAuditedMaterial(String code, String label) {
        var rows = jdbcTemplate.queryForList("""
            SELECT id::text AS id,
                   code,
                   name,
                   COALESCE(spec, '') AS spec,
                   COALESCE(unit, '') AS unit,
                   default_warehouse_id::text AS "defaultWarehouseId",
                   COALESCE(default_warehouse_code, '') AS "defaultWarehouseCode"
            FROM md_product
            WHERE code = ?
              AND enabled = TRUE
              AND audit_status = 'AUDITED'
            """, validationService.required(code, label));
        if (rows.isEmpty()) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, label + "不存在、未启用或未审核");
        }
        return rows.get(0);
    }

    private Map<String, Object> lookupOptionalCurrentBom(String code) {
        var normalized = validationService.optionalText(code);
        var result = new LinkedHashMap<String, Object>();
        result.put("id", null);
        result.put("code", null);
        result.put("versionNo", null);
        if (normalized == null) {
            return result;
        }
        var rows = jdbcTemplate.queryForList("""
            SELECT id::text AS id,
                   code,
                   version_no AS "versionNo"
            FROM prod_bom
            WHERE code = ?
              AND audit_status = 'AUDITED'
              AND enabled = TRUE
              AND is_current = TRUE
            """, normalized);
        if (rows.isEmpty()) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "子件 BOM 不存在或不是当前可用版本");
        }
        return rows.get(0);
    }

    private void ensureBomNotReferenced(String bomId, String action) {
        var references = jdbcTemplate.queryForObject("""
            SELECT COUNT(*)
            FROM (
                SELECT 1 FROM production_plan WHERE bom_id = ?::uuid
                UNION ALL
                SELECT 1 FROM production_task WHERE bom_id = ?::uuid
                UNION ALL
                SELECT 1 FROM prod_bom_line WHERE child_bom_id = ?::uuid
            ) refs
            """, Integer.class, bomId, bomId, bomId);
        if (references != null && references > 0) {
            throw new ResponseStatusException(HttpStatus.CONFLICT, "BOM 已被业务或上级 BOM 引用，不能" + action);
        }
    }

    private String nullableText(Object value) {
        if (value == null) {
            return null;
        }
        var text = String.valueOf(value).trim();
        return text.isEmpty() ? null : text;
    }

    private String normalizedIssueMethod(String value) {
        var method = validationService.optionalText(value);
        return method == null ? "按单领料" : method;
    }

    @Transactional
    public Map<String, Object> createPlan(PlanRequest request) {
        return createPlanRow(request);
    }

    @Transactional
    public Map<String, Object> auditPlan(String planNo) {
        return transitionPlan(planNo, BillStatus.DRAFT, BillStatus.AUDITED, "AUDIT_PLAN", "只有草稿生产计划可以审核");
    }

    @Transactional
    public Map<String, Object> reversePlan(String planNo) {
        guardPlanHasNoDownstream(planNo);
        return transitionPlan(planNo, BillStatus.AUDITED, BillStatus.DRAFT, "REVERSE_PLAN", "只有已审核且未下推的生产计划可以反审核");
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
            BillStatus.DRAFT.name()
        );
        var taskId = String.valueOf(rows.get(0).get("id"));
        rebuildTaskMaterialSnapshot(taskId);
        operationLogService.logCurrent(OperationLogCommand.success(
            "PRODUCTION", "CREATE_TASK", "production_task",
            UUID.fromString(taskId), billNo, Map.of(),
            OperationLogCommand.state(OperationLogCommand.StateField.STATUS, BillStatus.DRAFT.name())
        ));
        return rows.get(0);
    }

    public Map<String, Object> taskDetail(String taskNo) {
        var taskRows = jdbcTemplate.queryForList("""
            SELECT t.id::text AS id,
                   t.bill_no AS "billNo",
                   COALESCE(pl.bill_no, '') AS "planNo",
                   to_char(t.created_at, 'YYYY-MM-DD') AS "billDate",
                   COALESCE(t.department_code, '生产部') AS department,
                   t.status,
                   t.close_status AS "closeStatus",
                   t.frozen_status AS "frozenStatus"
            FROM production_task t
            LEFT JOIN production_plan pl ON pl.id = t.plan_id
            WHERE t.bill_no = ?
            """, validationService.required(taskNo, "生产任务单号"));
        if (taskRows.isEmpty()) {
            throw new ResponseStatusException(HttpStatus.NOT_FOUND, "生产任务单不存在");
        }
        var task = taskRows.get(0);
        var productRows = jdbcTemplate.queryForList("""
            SELECT COALESCE(t.product_code_snapshot, p.code) AS "productCode",
                   COALESCE(t.product_name_snapshot, p.name) AS "productName",
                   COALESCE(t.product_spec_snapshot, p.spec, '') AS spec,
                   COALESCE(t.product_unit_snapshot, p.unit, '') AS unit,
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
                   s.required_qty AS qty,
                   GREATEST(s.required_qty - s.issued_qty, 0) AS "remainingQty",
                   s.issued_qty AS "issuedQty",
                   COALESCE(stock.qty_on_hand, 0) AS "stockOnHand",
                   COALESCE(stock.qty_reserved, 0) AS "stockReserved",
                   COALESCE(stock.qty_available, 0) AS "stockAvailable",
                   0 AS "stockInTransit"
            FROM production_task_material_snapshot s
            JOIN md_product p ON p.id = s.product_id
            LEFT JOIN prod_bom_line bom_line ON bom_line.id = s.source_bom_line_id
            LEFT JOIN md_warehouse w ON w.id = COALESCE(bom_line.issue_warehouse_id, p.default_warehouse_id)
            LEFT JOIN inv_stock_balance stock ON stock.product_id = s.product_id
                 AND stock.warehouse_id = COALESCE(bom_line.issue_warehouse_id, p.default_warehouse_id)
                 AND stock.account_set_id = ?::uuid
            WHERE s.task_id = ?::uuid
            ORDER BY s.line_no
            """, inventoryScopeId(), task.get("id"));
        return Map.of(
            "action", "DETAIL",
            "document", task,
            "productInfo", productRows.isEmpty() ? Map.of() : productRows.get(0),
            "lines", lines
        );
    }

    @Transactional
    public Map<String, Object> createTaskFromPlan(String planNo, TaskRequest request) {
        return createTask(new TaskRequest(request.billNo(), planNo, request.bomCode(), request.warehouseCode(), request.qty()));
    }

    @Transactional
    public Map<String, Object> auditTask(String billNo) {
        var rows = jdbcTemplate.queryForList("""
            UPDATE production_task
            SET status = ?,
                close_status = 'OPEN',
                frozen_status = 'NORMAL',
                updated_at = now(),
                version = version + 1
            WHERE bill_no = ?
              AND status = ?
            RETURNING id::text AS id,
                      bill_no AS "billNo",
                      status,
                      close_status AS "closeStatus",
                      frozen_status AS "frozenStatus"
            """, BillStatus.AUDITED.name(), validationService.required(billNo, "生产任务单号"), BillStatus.DRAFT.name());
        if (rows.isEmpty()) {
            throw new ResponseStatusException(HttpStatus.CONFLICT, "只有草稿生产任务单可以审核");
        }
        operationLogService.logCurrent(OperationLogCommand.success(
            "PRODUCTION", "AUDIT_TASK", "production_task",
            UUID.fromString(String.valueOf(rows.get(0).get("id"))), String.valueOf(rows.get(0).get("billNo")),
            OperationLogCommand.state(OperationLogCommand.StateField.STATUS, BillStatus.DRAFT.name()),
            OperationLogCommand.state(OperationLogCommand.StateField.STATUS, BillStatus.AUDITED.name())
        ));
        return rows.get(0);
    }

    @Transactional
    public Map<String, Object> reverseTask(String billNo) {
        guardTaskHasNoDownstream(billNo);
        var rows = jdbcTemplate.queryForList("""
            UPDATE production_task
            SET status = ?,
                close_status = 'OPEN',
                close_reason = NULL,
                closed_by = NULL,
                closed_at = NULL,
                frozen_status = 'NORMAL',
                frozen_reason = NULL,
                frozen_by = NULL,
                frozen_at = NULL,
                updated_at = now(),
                version = version + 1
            WHERE bill_no = ?
              AND status = ?
              AND COALESCE(issued_qty, 0) = 0
              AND COALESCE(completed_qty, 0) = 0
            RETURNING id::text AS id,
                      bill_no AS "billNo",
                      status,
                      close_status AS "closeStatus",
                      frozen_status AS "frozenStatus"
            """, BillStatus.DRAFT.name(), validationService.required(billNo, "生产任务单号"), BillStatus.AUDITED.name());
        if (rows.isEmpty()) {
            throw new ResponseStatusException(HttpStatus.CONFLICT, "只有已审核且未领料、未完工的生产任务单可以反审核");
        }
        jdbcTemplate.update("""
            UPDATE production_task_material_snapshot
            SET line_close_status = 'OPEN',
                line_close_reason = NULL,
                line_frozen_status = 'NORMAL',
                line_frozen_reason = NULL
            WHERE task_id = ?::uuid
            """, rows.get(0).get("id"));
        operationLogService.logCurrent(OperationLogCommand.success(
            "PRODUCTION", "REVERSE_TASK", "production_task",
            UUID.fromString(String.valueOf(rows.get(0).get("id"))), String.valueOf(rows.get(0).get("billNo")),
            OperationLogCommand.state(OperationLogCommand.StateField.STATUS, BillStatus.AUDITED.name()),
            OperationLogCommand.state(OperationLogCommand.StateField.STATUS, BillStatus.DRAFT.name())
        ));
        return rows.get(0);
    }

    public List<Map<String, Object>> kitAnalysis(String planNo) {
        return jdbcTemplate.queryForList("""
            SELECT s.line_no AS "lineNo",
                   material.code AS "materialCode",
                   material.name AS "materialName",
                   COALESCE(material.spec, '') AS spec,
                   COALESCE(material.unit, '') AS unit,
                   (COALESCE(s.unit_qty, s.qty) * pl.planned_qty)
                       + COALESCE(s.fixed_loss_qty, 0)
                       + ((COALESCE(s.unit_qty, s.qty) * pl.planned_qty) * COALESCE(s.loss_rate, 0) / 100) AS "requiredQty",
                   COALESCE(stock.qty_available, 0) AS "availableQty",
                   GREATEST((COALESCE(s.unit_qty, s.qty) * pl.planned_qty)
                       + COALESCE(s.fixed_loss_qty, 0)
                       + ((COALESCE(s.unit_qty, s.qty) * pl.planned_qty) * COALESCE(s.loss_rate, 0) / 100)
                       - COALESCE(stock.qty_available, 0), 0) AS "shortageQty",
                   CASE WHEN COALESCE(stock.qty_available, 0) >= (COALESCE(s.unit_qty, s.qty) * pl.planned_qty)
                       + COALESCE(s.fixed_loss_qty, 0)
                       + ((COALESCE(s.unit_qty, s.qty) * pl.planned_qty) * COALESCE(s.loss_rate, 0) / 100)
                       THEN '齐套' ELSE '缺料' END AS status
            FROM production_plan pl
            JOIN prod_bom_line s ON s.bom_id = pl.bom_id
            JOIN md_product material ON material.id = s.material_id
            LEFT JOIN (
                SELECT product_id, SUM(qty_available) AS qty_available
                FROM inv_stock_balance
                WHERE account_set_id = ?::uuid
                GROUP BY product_id
            ) stock ON stock.product_id = s.material_id
            WHERE pl.bill_no = ?
            ORDER BY s.line_no
            """, inventoryScopeId(), validationService.required(planNo, "生产计划单号"));
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
                      AND status <> 'VOID'
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
              AND b.audit_status = 'AUDITED'
              AND b.is_current = TRUE
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
            BillStatus.DRAFT.name()
        );
        operationLogService.logCurrent(OperationLogCommand.success(
            "PRODUCTION", "CREATE_PLAN", "production_plan",
            UUID.fromString(String.valueOf(rows.get(0).get("id"))), String.valueOf(rows.get(0).get("billNo")), Map.of(),
            OperationLogCommand.state(OperationLogCommand.StateField.STATUS, BillStatus.DRAFT.name())
        ));
        return rows.get(0);
    }

    private Map<String, Object> transitionPlan(String planNo, BillStatus from, BillStatus to, String action, String conflictMessage) {
        var rows = jdbcTemplate.queryForList("""
            UPDATE production_plan
            SET status = ?, updated_at = now()
            WHERE bill_no = ? AND status = ?
            RETURNING id::text AS id, bill_no AS "billNo", status
            """, to.name(), validationService.required(planNo, "生产计划单号"), from.name());
        if (rows.isEmpty()) {
            throw new ResponseStatusException(HttpStatus.CONFLICT, conflictMessage);
        }
        operationLogService.logCurrent(OperationLogCommand.success(
            "PRODUCTION", action, "production_plan",
            UUID.fromString(String.valueOf(rows.get(0).get("id"))), String.valueOf(rows.get(0).get("billNo")),
            OperationLogCommand.state(OperationLogCommand.StateField.STATUS, from.name()),
            OperationLogCommand.state(OperationLogCommand.StateField.STATUS, to.name())
        ));
        return rows.get(0);
    }

    private void guardPlanHasNoDownstream(String planNo) {
        var count = jdbcTemplate.queryForObject("""
            SELECT COUNT(*)
            FROM (
                SELECT 1
                FROM production_task task
                JOIN production_plan plan ON plan.id = task.plan_id
                WHERE plan.bill_no = ?
                  AND task.status <> 'VOID'
                UNION ALL
                SELECT 1
                FROM purchase_requisition requisition
                JOIN production_plan plan ON plan.id = requisition.source_plan_id
                WHERE plan.bill_no = ?
            ) refs
            """, Integer.class, planNo, planNo);
        if (count != null && count > 0) {
            throw new ResponseStatusException(HttpStatus.CONFLICT, "生产计划已下推，不能反审核");
        }
    }

    private void guardTaskHasNoDownstream(String taskNo) {
        var count = jdbcTemplate.queryForObject("""
            SELECT COUNT(*)
            FROM (
                SELECT 1
                FROM production_material_issue issue
                JOIN production_task task ON task.id = issue.task_id
                WHERE task.bill_no = ?
                  AND issue.status <> 'VOID'
                UNION ALL
                SELECT 1
                FROM production_completion completion
                JOIN production_task task ON task.id = completion.task_id
                WHERE task.bill_no = ?
                  AND completion.status <> 'VOID'
            ) refs
            """, Integer.class, taskNo, taskNo);
        if (count != null && count > 0) {
            throw new ResponseStatusException(HttpStatus.CONFLICT, "生产任务已产生领料或完工单据，不能反审核");
        }
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
                  AND b.audit_status = 'AUDITED'
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
              AND b.is_current = TRUE
              AND b.audit_status = 'AUDITED'
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
                   (COALESCE(line.unit_qty, line.qty) * ?)
                       + COALESCE(line.fixed_loss_qty, 0)
                       + ((COALESCE(line.unit_qty, line.qty) * ?) * COALESCE(line.loss_rate, 0) / 100) AS qty
            FROM production_plan plan
            JOIN prod_bom_line line ON line.bom_id = plan.bom_id
            JOIN md_product material ON material.id = line.material_id
            LEFT JOIN md_supplier supplier ON supplier.id = material.default_supplier_id
            WHERE plan.bill_no = ?
              AND material.enabled = TRUE
              AND material.audit_status = 'AUDITED'
              AND material.is_purchase = TRUE
            ORDER BY supplier.code NULLS LAST, line.line_no
            """, taskQty, taskQty, planNo);
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
                   COALESCE(l.unit_qty, l.qty),
                   (COALESCE(l.unit_qty, l.qty) * t.qty)
                       + COALESCE(l.fixed_loss_qty, 0)
                       + ((COALESCE(l.unit_qty, l.qty) * t.qty) * COALESCE(l.loss_rate, 0) / 100)
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

    private BigDecimal nonNegative(BigDecimal value, String label) {
        if (value == null) {
            return BigDecimal.ZERO;
        }
        if (value.compareTo(BigDecimal.ZERO) < 0) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, label + "不能小于 0");
        }
        return value;
    }

    public record BomRequest(String code, String productCode, BigDecimal qty, String bomCategory, String remark, List<BomLineRequest> lines) {
        public BomRequest {
            if (lines == null || lines.isEmpty()) {
                throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "BOM 至少需要一条物料");
            }
        }
    }

    public record BomAuditRequest(Boolean confirmNewVersion, String latestBomCode, String latestVersionNo) {
    }

    public record BomLineRequest(
        String materialCode,
        BigDecimal qty,
        BigDecimal productQty,
        BigDecimal materialQty,
        BigDecimal unitQty,
        String issueMethod,
        String issueWarehouseCode,
        BigDecimal fixedLossQty,
        BigDecimal lossRate,
        String childBomCode
    ) {
    }

    public record PlanRequest(String billNo, String productCode, String bomCode, String warehouseCode, BigDecimal qty, String sourceType, String departmentCode, String planDeliveryDate) {
    }

    public record TaskRequest(String billNo, String planNo, String bomCode, String warehouseCode, BigDecimal qty) {
    }

    private String inventoryScopeId() {
        return tenantDataScopeService.currentScopeId("inventory");
    }
}
