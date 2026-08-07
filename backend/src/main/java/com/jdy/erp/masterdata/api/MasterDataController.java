package com.jdy.erp.masterdata.api;

import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Set;
import java.util.UUID;

import com.fasterxml.jackson.databind.JsonNode;
import com.jdy.erp.masterdata.application.MasterDataCreateService;
import com.jdy.erp.masterdata.application.MasterDataPatchService;
import com.jdy.erp.shared.application.OperationLogCommand;
import com.jdy.erp.shared.application.OperationLogService;
import com.jdy.erp.system.tenant.TenantContext;
import com.jdy.erp.system.security.RequirePermission;
import org.springframework.http.HttpStatus;
import org.springframework.dao.DataIntegrityViolationException;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.PatchMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.ResponseStatus;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.server.ResponseStatusException;
import org.springframework.transaction.annotation.Transactional;

@RestController
@RequestMapping("/api/master-data")
public class MasterDataController {
    private static final Set<String> A140_MASTER_TYPES = Set.of("employee", "financialAccount");
    private static final Set<String> SPARSE_PATCH_TYPES = Set.of(
        "product", "customer", "supplier", "warehouse", "unit", "productionDepartment", "employee", "financialAccount"
    );

    private final JdbcTemplate jdbcTemplate;
    private final MasterDataCreateService masterDataCreateService;
    private final MasterDataPatchService masterDataPatchService;
    private final OperationLogService operationLogService;

    public MasterDataController(
        JdbcTemplate jdbcTemplate,
        MasterDataCreateService masterDataCreateService,
        MasterDataPatchService masterDataPatchService,
        OperationLogService operationLogService
    ) {
        this.jdbcTemplate = jdbcTemplate;
        this.masterDataCreateService = masterDataCreateService;
        this.masterDataPatchService = masterDataPatchService;
        this.operationLogService = operationLogService;
    }

    @PostMapping("/{type}")
    @RequirePermission("master.data.manage")
    @ResponseStatus(HttpStatus.CREATED)
    @Transactional
    public Map<String, Object> create(@PathVariable String type, @RequestBody Map<String, String> payload) {
        var result = masterDataCreateService.create(type, payload);
        var enabled = result.containsKey("status")
            ? "启用".equals(String.valueOf(result.get("status")))
            : !"禁用".equals(payload.getOrDefault("status", "启用"));
        logMasterDataChange(
            "CREATE_MASTER_DATA",
            type,
            result,
            Map.of(),
            masterState("DRAFT", enabled),
            "fields=" + String.join(",", payload.keySet().stream().sorted().toList()) + "; version=0"
        );
        return result;
    }

    @PutMapping("/{type}/{code}")
    @RequirePermission("master.data.manage")
    public Map<String, Object> update(@PathVariable String type, @PathVariable String code, @RequestBody JsonNode requestBody) {
        if (SPARSE_PATCH_TYPES.contains(type)) {
            throw new ResponseStatusException(HttpStatus.METHOD_NOT_ALLOWED, "该主数据类型只允许使用带 version 的 PATCH 更新");
        }
        if (!Set.of("productName", "productCategory", "unit", "productionDepartment").contains(type)) {
            throw new ResponseStatusException(HttpStatus.NOT_FOUND, "Unsupported master data type");
        }
        var payload = legacyPayload(requestBody);
        var name = "unit".equals(type) ? payload.getOrDefault("name", code).trim() : required(payload, "name");
        if (name.isBlank()) {
            name = code;
        }
        var enabled = !"禁用".equals(payload.getOrDefault("status", "启用"));
        return switch (type) {
            case "productName" -> updateProductName(code, name, payload, enabled);
            case "productCategory" -> updateProductCategory(code, name, payload, enabled);
            case "unit" -> updateUnit(code, name, payload, enabled);
            case "productionDepartment" -> updateProductionDepartment(code, name, payload, enabled);
            default -> throw new ResponseStatusException(HttpStatus.NOT_FOUND, "Unsupported master data type");
        };
    }

    @PatchMapping("/{type}/{code}")
    @RequirePermission("master.data.manage")
    @Transactional
    public Map<String, Object> patch(@PathVariable String type, @PathVariable String code, @RequestBody JsonNode requestBody) {
        var request = patchRequest(requestBody);
        var result = masterDataPatchService.patch(type, code, request.version(), request.changes());
        var state = OperationLogCommand.state(
            OperationLogCommand.StateField.AUDIT_STATUS, "DRAFT",
            OperationLogCommand.StateField.ENABLED, result.enabled()
        );
        operationLogService.logCurrent(OperationLogCommand.success(
            "MASTER_DATA",
            "PATCH_MASTER_DATA",
            result.targetType(),
            result.id(),
            result.code(),
            OperationLogCommand.ActorMode.CURRENT_USER,
            null,
            state,
            state,
            "fields=" + String.join(",", result.changedFields())
                + "; version=" + result.previousVersion() + "->" + result.version()
        ));
        return result.body();
    }

    @PatchMapping("/{type}/{code}/status")
    @RequirePermission("master.data.manage")
    @Transactional
    public Map<String, Object> updateStatus(@PathVariable String type, @PathVariable String code, @RequestBody Map<String, String> payload) {
        var enabled = A140_MASTER_TYPES.contains(type)
            ? enabledStatus(payload)
            : !"禁用".equals(payload.getOrDefault("status", "启用"));
        return setEnabled(type, code, enabled);
    }

    @PostMapping("/{type}/{code}/audit")
    @RequirePermission("master.data.manage")
    @Transactional
    public Map<String, Object> audit(@PathVariable String type, @PathVariable String code) {
        return setAuditStatus(type, code, "AUDITED");
    }

    @PostMapping("/{type}/{code}/reverse")
    @RequirePermission("master.data.manage")
    @Transactional
    public Map<String, Object> reverseAudit(@PathVariable String type, @PathVariable String code) {
        return setAuditStatus(type, code, "DRAFT");
    }

    @DeleteMapping("/{type}/{code}")
    @RequirePermission("master.data.manage")
    @Transactional
    public Map<String, Object> delete(@PathVariable String type, @PathVariable String code) {
        if (A140_MASTER_TYPES.contains(type)) {
            throw new ResponseStatusException(HttpStatus.METHOD_NOT_ALLOWED, "该主数据不允许删除，请使用正式禁用动作");
        }
        if ("product".equals(type)) {
            return deleteProduct(code);
        }
        return setEnabled(type, code, false);
    }

    private Map<String, Object> updateProductCategory(String code, String name, Map<String, String> payload, boolean enabled) {
        return updateAndReturn("""
            UPDATE md_product_category
            SET name = ?, parent_code = ?, sort_no = ?, remark = ?, enabled = ?, audit_status = 'DRAFT', updated_at = now(), version = version + 1
            WHERE code = ?
            RETURNING id::text AS id, code, name
            """,
            name,
            optional(payload, "parentCode"),
            integerOrDefault(payload, "sortNo", 0, "排序"),
            optional(payload, "remark"),
            enabled,
            code
        );
    }

    private Map<String, Object> updateProductName(String code, String name, Map<String, String> payload, boolean enabled) {
        return updateAndReturn("""
            UPDATE md_product_name
            SET name = ?, remark = ?, enabled = ?, audit_status = 'DRAFT', updated_at = now(), version = version + 1
            WHERE code = ?
            RETURNING id::text AS id, code, name
            """, name, optional(payload, "remark"), enabled, code);
    }

    private Map<String, Object> updateUnit(String code, String name, Map<String, String> payload, boolean enabled) {
        return updateAndReturn("""
            UPDATE md_unit
            SET name = ?, decimal_places = ?, sort_no = ?, remark = ?, enabled = ?, audit_status = 'DRAFT', updated_at = now(), version = version + 1
            WHERE code = ?
            RETURNING id::text AS id, code, name
            """,
            name,
            integerOrDefault(payload, "decimalPlaces", 0, "数量小数位"),
            integerOrDefault(payload, "sortNo", 0, "排序"),
            optional(payload, "remark"),
            enabled,
            code
        );
    }

    private void validateProductReferencesBeforeAudit(String code) {
        var rows = jdbcTemplate.queryForList("""
            SELECT p.code
            FROM md_product p
            LEFT JOIN md_product_category category ON category.id = p.product_category_id
            LEFT JOIN md_unit unit_ref ON unit_ref.id = p.unit_id
            LEFT JOIN md_warehouse warehouse ON warehouse.id = p.default_warehouse_id
            LEFT JOIN md_supplier supplier ON supplier.id = p.default_supplier_id
            LEFT JOIN md_production_department department ON department.id = p.default_workshop_id
            WHERE p.code = ?
              AND (
                   category.id IS NULL OR category.enabled = FALSE OR category.audit_status <> 'AUDITED'
                OR unit_ref.id IS NULL OR unit_ref.enabled = FALSE OR unit_ref.audit_status <> 'AUDITED'
                OR (p.default_warehouse_id IS NOT NULL AND (warehouse.id IS NULL OR warehouse.enabled = FALSE OR warehouse.audit_status <> 'AUDITED'))
                OR (p.default_supplier_id IS NOT NULL AND (supplier.id IS NULL OR supplier.enabled = FALSE OR supplier.audit_status <> 'AUDITED'))
                OR (p.default_workshop_id IS NOT NULL AND (department.id IS NULL OR department.enabled = FALSE OR department.audit_status <> 'AUDITED'))
              )
            """, code);
        if (!rows.isEmpty()) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "物料引用的类别、单位、默认仓库、默认供应商或默认生产车间不存在、未审核或已禁用");
        }
    }

    private void assertNotReferencedByProduct(String type, String code, String action) {
        var referenceColumn = productReferenceColumn(type);
        if (referenceColumn == null) {
            return;
        }
        var table = tableName(type);
        var rows = jdbcTemplate.queryForList("SELECT id::text AS id FROM " + table + " WHERE code = ? FOR UPDATE", code);
        if (rows.isEmpty()) {
            return;
        }
        var id = String.valueOf(rows.get(0).get("id"));
        var count = jdbcTemplate.queryForObject(
            "SELECT COUNT(*) FROM md_product WHERE " + referenceColumn + " = ?::uuid",
            Long.class,
            id
        );
        if (count != null && count > 0) {
            throw new ResponseStatusException(HttpStatus.CONFLICT, "该主数据已被物料资料引用，不能" + action + "；请先调整引用它的物料。");
        }
    }

    private String productReferenceColumn(String type) {
        return switch (type) {
            case "productCategory" -> "product_category_id";
            case "unit" -> "unit_id";
            case "warehouse" -> "default_warehouse_id";
            case "supplier" -> "default_supplier_id";
            case "productionDepartment" -> "default_workshop_id";
            default -> null;
        };
    }

    private Map<String, Object> updateProductionDepartment(String code, String name, Map<String, String> payload, boolean enabled) {
        return updateAndReturn("""
            UPDATE md_production_department
            SET name = ?, manager = ?, remark = ?, enabled = ?, audit_status = 'DRAFT', updated_at = now(), version = version + 1
            WHERE code = ?
            RETURNING id::text AS id, system_no::text AS "systemNo", code, name, CASE WHEN audit_status = 'AUDITED' THEN '已审核' ELSE '草稿' END AS "auditStatus"
            """,
            name,
            optional(payload, "manager"),
            optional(payload, "remark"),
            enabled,
            code
        );
    }

    private Map<String, Object> setEnabled(String type, String code, boolean enabled) {
        var current = lockMasterData(type, code);
        var beforeEnabled = Boolean.TRUE.equals(current.get("enabled"));
        var beforeAuditStatus = String.valueOf(current.get("audit_status"));
        if (!enabled) {
            assertNotReferencedByProduct(type, code, "禁用");
        }
        var table = tableName(type);
        var result = updateAndReturn("UPDATE " + table + " SET enabled = ?, updated_at = now(), version = version + 1 WHERE code = ? AND enabled = ? RETURNING " + returningFor(type),
            enabled,
            code,
            beforeEnabled
        );
        logMasterDataChange(
            enabled ? "ENABLE_MASTER_DATA" : "DISABLE_MASTER_DATA",
            type,
            result,
            masterState(beforeAuditStatus, beforeEnabled),
            masterState(beforeAuditStatus, enabled),
            "version=" + current.get("version") + "->" + result.get("version")
        );
        return result;
    }

    private Map<String, Object> setAuditStatus(String type, String code, String auditStatus) {
        var current = lockMasterData(type, code);
        var beforeAuditStatus = String.valueOf(current.get("audit_status"));
        var expectedBefore = "AUDITED".equals(auditStatus) ? "DRAFT" : "AUDITED";
        if (!expectedBefore.equals(beforeAuditStatus)) {
            throw new ResponseStatusException(
                HttpStatus.CONFLICT,
                "AUDITED".equals(auditStatus) ? "只有草稿资料可以审核" : "只有已审核资料可以反审核"
            );
        }
        if ("product".equals(type) && "AUDITED".equals(auditStatus)) {
            validateProductReferencesBeforeAudit(code);
        }
        if ("DRAFT".equals(auditStatus)) {
            assertNotReferencedByProduct(type, code, "反审核");
        }
        var table = tableName(type);
        var enabled = Boolean.TRUE.equals(current.get("enabled"));
        var result = updateAndReturn("UPDATE " + table + " SET audit_status = ?, updated_at = now(), version = version + 1 WHERE code = ? AND audit_status = ? RETURNING " + returningFor(type),
            auditStatus,
            code,
            expectedBefore
        );
        logMasterDataChange(
            "AUDITED".equals(auditStatus) ? "AUDIT_MASTER_DATA" : "REVERSE_MASTER_DATA",
            type,
            result,
            masterState(beforeAuditStatus, enabled),
            masterState(auditStatus, enabled),
            "version=" + current.get("version") + "->" + result.get("version")
        );
        return result;
    }

    private Map<String, Object> deleteProduct(String code) {
        var rows = jdbcTemplate.queryForList("SELECT id::text AS id, audit_status FROM md_product WHERE code = ?", code);
        if (rows.isEmpty()) {
            throw new ResponseStatusException(HttpStatus.NOT_FOUND, "master data not found");
        }
        var row = rows.get(0);
        if ("AUDITED".equals(row.get("audit_status"))) {
            throw new ResponseStatusException(HttpStatus.CONFLICT, "已审核物料不能删除，请先反审核；已有业务往来的物料只能禁用。");
        }
        var productId = String.valueOf(row.get("id"));
        if (productReferenceCount(productId) > 0) {
            throw new ResponseStatusException(HttpStatus.CONFLICT, "该物料已有业务引用，不能删除；请改为禁用。");
        }
        return updateAndReturn("DELETE FROM md_product WHERE code = ? RETURNING " + returningFor("product"), code);
    }

    private long productReferenceCount(String productId) {
        var references = jdbcTemplate.queryForList("""
            SELECT kcu.table_name, kcu.column_name
            FROM information_schema.table_constraints tc
            JOIN information_schema.key_column_usage kcu
              ON tc.constraint_schema = kcu.constraint_schema
             AND tc.constraint_name = kcu.constraint_name
            JOIN information_schema.constraint_column_usage ccu
              ON ccu.constraint_schema = tc.constraint_schema
             AND ccu.constraint_name = tc.constraint_name
            WHERE tc.constraint_type = 'FOREIGN KEY'
              AND tc.table_schema = 'public'
              AND ccu.table_schema = 'public'
              AND ccu.table_name = 'md_product'
              AND ccu.column_name = 'id'
            """);
        long count = 0;
        for (var reference : references) {
            var table = safeIdentifier(String.valueOf(reference.get("table_name")));
            var column = safeIdentifier(String.valueOf(reference.get("column_name")));
            var value = jdbcTemplate.queryForObject("SELECT COUNT(*) FROM " + table + " WHERE " + column + " = ?::uuid", Long.class, productId);
            count += value == null ? 0 : value;
            if (count > 0) {
                return count;
            }
        }
        return count;
    }

    private String safeIdentifier(String value) {
        if (!value.matches("[A-Za-z_][A-Za-z0-9_]*")) {
            throw new ResponseStatusException(HttpStatus.INTERNAL_SERVER_ERROR, "invalid database identifier");
        }
        return value;
    }

    private String returningFor(String type) {
        var draftLabel = A140_MASTER_TYPES.contains(type) ? "未审核" : "草稿";
        var auditStatus = "CASE WHEN audit_status = 'AUDITED' THEN '已审核' ELSE '" + draftLabel + "' END AS \"auditStatus\"";
        var status = "CASE WHEN enabled THEN '启用' ELSE '禁用' END AS status";
        return hasSystemNo(type)
            ? "id::text AS id, system_no::text AS \"systemNo\", code, name, version, " + auditStatus + ", " + status
            : "id::text AS id, code, name, version, " + auditStatus + ", " + status;
    }

    private Map<String, Object> updateAndReturn(String sql, Object... args) {
        var rows = jdbcTemplate.queryForList(sql, args);
        if (rows.isEmpty()) {
            throw new ResponseStatusException(HttpStatus.NOT_FOUND, "master data not found");
        }
        return rows.get(0);
    }

    private String tableName(String type) {
        return switch (type) {
            case "product" -> "md_product";
            case "customer" -> "md_customer";
            case "supplier" -> "md_supplier";
            case "warehouse" -> "md_warehouse";
            case "productName" -> "md_product_name";
            case "productCategory" -> "md_product_category";
            case "unit" -> "md_unit";
            case "productionDepartment" -> "md_production_department";
            case "employee" -> "md_employee";
            case "financialAccount" -> "md_financial_account";
            default -> throw new ResponseStatusException(HttpStatus.NOT_FOUND, "Unsupported master data type");
        };
    }

    private boolean hasSystemNo(String type) {
        return switch (type) {
            case "product", "customer", "supplier", "warehouse", "productionDepartment", "employee", "financialAccount" -> true;
            default -> false;
        };
    }

    private Map<String, Object> lockMasterData(String type, String code) {
        var rows = jdbcTemplate.queryForList(
            "SELECT id::text AS id, code, audit_status, enabled, version FROM " + tableName(type) + " WHERE code = ? FOR UPDATE",
            code
        );
        if (rows.isEmpty()) {
            throw new ResponseStatusException(HttpStatus.NOT_FOUND, "master data not found");
        }
        return rows.getFirst();
    }

    private Map<OperationLogCommand.StateField, Object> masterState(String auditStatus, boolean enabled) {
        return OperationLogCommand.state(
            OperationLogCommand.StateField.AUDIT_STATUS, auditStatus,
            OperationLogCommand.StateField.ENABLED, enabled
        );
    }

    private void logMasterDataChange(
        String action,
        String type,
        Map<String, Object> result,
        Map<OperationLogCommand.StateField, Object> beforeState,
        Map<OperationLogCommand.StateField, Object> afterState,
        String reason
    ) {
        // Direct service/controller fixtures do not represent an HTTP operation and intentionally have no request scope.
        if (TenantContext.current().isEmpty()) {
            return;
        }
        operationLogService.logCurrent(OperationLogCommand.success(
            "MASTER_DATA",
            action,
            tableName(type),
            UUID.fromString(String.valueOf(result.get("id"))),
            String.valueOf(result.get("code")),
            OperationLogCommand.ActorMode.CURRENT_USER,
            null,
            beforeState,
            afterState,
            reason
        ));
    }

    private boolean enabledStatus(Map<String, String> payload) {
        if (payload == null || payload.size() != 1 || !payload.containsKey("status")) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "status 只允许“启用”或“禁用”");
        }
        return switch (String.valueOf(payload.get("status")).trim()) {
            case "启用" -> true;
            case "禁用" -> false;
            default -> throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "status 只允许“启用”或“禁用”");
        };
    }

    private PatchRequest patchRequest(JsonNode requestBody) {
        if (requestBody == null || !requestBody.isObject()) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "请求体必须为 JSON 对象");
        }
        requestBody.fieldNames().forEachRemaining(field -> {
            if (!Set.of("version", "changes").contains(field)) {
                throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "请求外层不允许字段: " + field);
            }
        });
        var versionNode = requestBody.get("version");
        if (versionNode == null || !versionNode.isIntegralNumber() || !versionNode.canConvertToLong() || versionNode.longValue() < 0) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "version 必须存在且为非负整数");
        }
        var changesNode = requestBody.get("changes");
        if (changesNode == null || !changesNode.isObject() || changesNode.isEmpty()) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "changes 必须是至少包含一个字段的对象");
        }
        var changes = new LinkedHashMap<String, JsonNode>();
        changesNode.fields().forEachRemaining(entry -> changes.put(entry.getKey(), entry.getValue()));
        return new PatchRequest(versionNode.longValue(), changes);
    }

    private Map<String, String> legacyPayload(JsonNode requestBody) {
        if (requestBody == null || !requestBody.isObject()) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "请求体必须为 JSON 对象");
        }
        var payload = new LinkedHashMap<String, String>();
        requestBody.fields().forEachRemaining(entry -> {
            var value = entry.getValue();
            if (value != null && !value.isNull() && !value.isValueNode()) {
                throw new ResponseStatusException(HttpStatus.BAD_REQUEST, entry.getKey() + " 必须为标量");
            }
            payload.put(entry.getKey(), value == null || value.isNull() ? null : value.asText());
        });
        return payload;
    }

    private record PatchRequest(long version, Map<String, JsonNode> changes) {
    }

    private String required(Map<String, String> payload, String field) {
        var raw = payload == null ? null : payload.get(field);
        var value = raw == null ? "" : raw.trim();
        if (value.isBlank()) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, field + " is required");
        }
        return value;
    }

    private String optional(Map<String, String> payload, String field) {
        var raw = payload == null ? null : payload.get(field);
        var value = raw == null ? "" : raw.trim();
        return value.isBlank() ? null : value;
    }

    private int integerOrDefault(Map<String, String> payload, String field, int defaultValue, String label) {
        var value = payload.getOrDefault(field, "").trim();
        if (value.isBlank()) {
            return defaultValue;
        }
        try {
            var number = Integer.parseInt(value);
            if (number < 0) {
                throw new ResponseStatusException(HttpStatus.BAD_REQUEST, label + "不能小于 0");
            }
            return number;
        } catch (NumberFormatException ex) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, label + "格式不正确");
        }
    }

    @ExceptionHandler(DataIntegrityViolationException.class)
    @ResponseStatus(HttpStatus.CONFLICT)
    public Map<String, String> conflict() {
        return Map.of("message", "code already exists");
    }
}
