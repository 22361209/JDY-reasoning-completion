package com.jdy.erp.masterdata.api;

import java.math.BigDecimal;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Set;
import java.util.UUID;

import com.fasterxml.jackson.databind.JsonNode;
import com.jdy.erp.masterdata.application.MasterDataPatchService;
import com.jdy.erp.shared.application.OperationLogCommand;
import com.jdy.erp.shared.application.OperationLogService;
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
        "product", "customer", "supplier", "warehouse", "employee", "financialAccount"
    );
    private static final Set<String> EMPLOYEE_CREATE_FIELDS = Set.of(
        "code", "name", "position", "department", "phone", "email", "remark", "status"
    );
    private static final Set<String> FINANCIAL_ACCOUNT_CREATE_FIELDS = Set.of(
        "code", "name", "accountType", "bankName", "accountNo", "accountHolder", "currency", "remark", "status"
    );

    private final JdbcTemplate jdbcTemplate;
    private final MasterDataPatchService masterDataPatchService;
    private final OperationLogService operationLogService;

    public MasterDataController(
        JdbcTemplate jdbcTemplate,
        MasterDataPatchService masterDataPatchService,
        OperationLogService operationLogService
    ) {
        this.jdbcTemplate = jdbcTemplate;
        this.masterDataPatchService = masterDataPatchService;
        this.operationLogService = operationLogService;
    }

    @PostMapping("/{type}")
    @RequirePermission("master.data.manage")
    @ResponseStatus(HttpStatus.CREATED)
    @Transactional
    public Map<String, Object> create(@PathVariable String type, @RequestBody Map<String, String> payload) {
        var code = required(payload, "code");
        var name = "unit".equals(type) ? payload.getOrDefault("name", code).trim() : required(payload, "name");
        if (name.isBlank()) {
            name = code;
        }
        var enabled = A140_MASTER_TYPES.contains(type)
            ? createEnabledStatus(payload)
            : !"禁用".equals(payload.getOrDefault("status", "启用"));
        var result = switch (type) {
            case "product" -> createProduct(code, name, payload, enabled);
            case "customer" -> createCustomer(code, name, payload, enabled);
            case "supplier" -> createSupplier(code, name, payload, enabled);
            case "warehouse" -> createWarehouse(code, name, payload, enabled);
            case "productCategory" -> createProductCategory(code, name, payload, enabled);
            case "unit" -> createUnit(code, name, payload, enabled);
            case "productionDepartment" -> createProductionDepartment(code, name, payload, enabled);
            case "employee" -> createEmployee(code, name, payload, enabled);
            case "financialAccount" -> createFinancialAccount(code, name, payload, enabled);
            default -> throw new ResponseStatusException(HttpStatus.NOT_FOUND, "Unsupported master data type");
        };
        if (A140_MASTER_TYPES.contains(type)) {
            logMasterDataChange(
                "CREATE_MASTER_DATA",
                type,
                result,
                Map.of(),
                masterState("DRAFT", enabled),
                "fields=" + String.join(",", payload.keySet().stream().sorted().toList()) + "; version=0"
            );
        }
        return result;
    }

    @PutMapping("/{type}/{code}")
    @RequirePermission("master.data.manage")
    public Map<String, Object> update(@PathVariable String type, @PathVariable String code, @RequestBody JsonNode requestBody) {
        if (SPARSE_PATCH_TYPES.contains(type)) {
            throw new ResponseStatusException(HttpStatus.METHOD_NOT_ALLOWED, "该主数据类型只允许使用带 version 的 PATCH 更新");
        }
        if (!Set.of("productCategory", "unit", "productionDepartment").contains(type)) {
            throw new ResponseStatusException(HttpStatus.NOT_FOUND, "Unsupported master data type");
        }
        var payload = legacyPayload(requestBody);
        var name = "unit".equals(type) ? payload.getOrDefault("name", code).trim() : required(payload, "name");
        if (name.isBlank()) {
            name = code;
        }
        var enabled = !"禁用".equals(payload.getOrDefault("status", "启用"));
        return switch (type) {
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

    private Map<String, Object> createProduct(String code, String name, Map<String, String> payload, boolean enabled) {
        var category = requiredReference("md_product_category", required(payload, "category"), "物料类别");
        var unit = requiredReference("md_unit", required(payload, "unit"), "计量单位");
        var defaultWarehouse = optionalReference("md_warehouse", optional(payload, "defaultWarehouseCode"), "默认仓库");
        var defaultSupplier = optionalReference("md_supplier", optional(payload, "defaultSupplierCode"), "默认供应商");
        var defaultWorkshop = optionalReference("md_production_department", optional(payload, "defaultWorkshop"), "默认生产车间");
        return jdbcTemplate.queryForMap("""
            INSERT INTO md_product (
                code, name, short_name, barcode, brand, spec, category, product_category_id, product_type, unit, unit_id, net_weight, gross_weight,
                oe_no, position_name, surface_treatment,
                is_purchase, is_sale, is_inventory, is_produce, is_subcontract,
                default_warehouse_code, default_warehouse_id, default_workshop, default_workshop_id, sale_unit, purchase_unit, bom_unit,
                default_supplier_code, default_supplier_id, issue_warehouse_code, issue_method,
                tax_rate, default_sale_price, cost_price, min_sale_price, purchase_price, max_purchase_price, subcontract_price, wholesale_price, retail_price,
                min_stock_qty, safety_stock_qty, max_stock_qty, remark, drawing_file_name, drawing_file_data, image_file_names, image_file_data, enabled
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?::uuid, ?, ?, ?::uuid, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?::uuid, ?, ?::uuid, ?, ?, ?, ?, ?::uuid, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            RETURNING id::text AS id, system_no::text AS "systemNo", code, name
            """,
            code,
            name,
            optional(payload, "shortName"),
            optional(payload, "barcode"),
            optional(payload, "brand"),
            payload.getOrDefault("spec", ""),
            category.name(),
            category.id(),
            payload.getOrDefault("productType", "普通"),
            unit.code(),
            unit.id(),
            optionalDecimal(payload, "netWeight", "净重"),
            optionalDecimal(payload, "grossWeight", "毛重"),
            optional(payload, "oeNo"),
            optional(payload, "positionName"),
            optional(payload, "surfaceTreatment"),
            checked(payload, "isPurchase"),
            checked(payload, "isSale"),
            checked(payload, "isInventory", true),
            checked(payload, "isProduce"),
            checked(payload, "isSubcontract"),
            defaultWarehouse.codeOrNull(),
            defaultWarehouse.idOrNull(),
            defaultWorkshop.nameOrNull(),
            defaultWorkshop.idOrNull(),
            payload.getOrDefault("saleUnit", unit.code()),
            payload.getOrDefault("purchaseUnit", unit.code()),
            payload.getOrDefault("bomUnit", unit.code()),
            defaultSupplier.codeOrNull(),
            defaultSupplier.idOrNull(),
            optional(payload, "issueWarehouseCode"),
            payload.getOrDefault("issueMethod", "按单领料"),
            decimalOrDefault(payload, "taxRate", BigDecimal.valueOf(13)),
            defaultSalePrice(payload),
            optionalDecimal(payload, "costPrice", "成本价"),
            optionalDecimal(payload, "minSalePrice", "最低销售价"),
            optionalDecimal(payload, "purchasePrice", "采购价"),
            optionalDecimal(payload, "maxPurchasePrice", "最高采购价"),
            optionalDecimal(payload, "subcontractPrice", "委外价"),
            optionalDecimal(payload, "wholesalePrice", "批发价"),
            optionalDecimal(payload, "retailPrice", "零售价"),
            optionalDecimal(payload, "minStockQty", "最低库存数量"),
            optionalDecimal(payload, "safetyStockQty", "安全库存数量"),
            optionalDecimal(payload, "maxStockQty", "最高库存数量"),
            optional(payload, "remark"),
            optional(payload, "drawingFileName"),
            optional(payload, "drawingFileData"),
            optional(payload, "imageFileNames"),
            optional(payload, "imageFileData"),
            enabled
        );
    }

    private Map<String, Object> createCustomer(String code, String name, Map<String, String> payload, boolean enabled) {
        return jdbcTemplate.queryForMap("""
            INSERT INTO md_customer (
                code, name, short_name, customer_level, contact, phone, region, tax_no,
                address, credit_limit, settlement_method, owner_name, remark, enabled
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            RETURNING id::text AS id, system_no::text AS "systemNo", code, name
            """,
            code,
            name,
            optional(payload, "shortName"),
            payload.getOrDefault("customerLevel", "普通客户"),
            payload.getOrDefault("contact", ""),
            payload.getOrDefault("phone", ""),
            payload.getOrDefault("region", ""),
            optional(payload, "taxNo"),
            optional(payload, "address"),
            optionalDecimal(payload, "creditLimit", "信用额度"),
            payload.getOrDefault("settlementMethod", "月结"),
            optional(payload, "ownerName"),
            optional(payload, "remark"),
            enabled
        );
    }

    private Map<String, Object> createSupplier(String code, String name, Map<String, String> payload, boolean enabled) {
        return jdbcTemplate.queryForMap("""
            INSERT INTO md_supplier (
                code, name, short_name, supplier_level, contact, phone, tax_no,
                address, bank_account, settlement_method, owner_name, remark, enabled
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            RETURNING id::text AS id, system_no::text AS "systemNo", code, name
            """,
            code,
            name,
            optional(payload, "shortName"),
            payload.getOrDefault("supplierLevel", "普通供应商"),
            payload.getOrDefault("contact", ""),
            payload.getOrDefault("phone", ""),
            optional(payload, "taxNo"),
            optional(payload, "address"),
            optional(payload, "bankAccount"),
            payload.getOrDefault("settlementMethod", "月结"),
            optional(payload, "ownerName"),
            optional(payload, "remark"),
            enabled
        );
    }

    private Map<String, Object> createWarehouse(String code, String name, Map<String, String> payload, boolean enabled) {
        var allowNegative = "允许负库存".equals(payload.getOrDefault("stockPolicy", "不允许负库存"));
        return jdbcTemplate.queryForMap("""
            INSERT INTO md_warehouse (code, name, warehouse_type, manager, phone, address, allow_negative_stock, remark, enabled)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            RETURNING id::text AS id, system_no::text AS "systemNo", code, name
            """,
            code,
            name,
            payload.getOrDefault("warehouseType", "普通仓"),
            optional(payload, "manager"),
            optional(payload, "phone"),
            optional(payload, "address"),
            allowNegative,
            optional(payload, "remark"),
            enabled
        );
    }

    private Map<String, Object> createEmployee(String code, String name, Map<String, String> payload, boolean enabled) {
        assertOnlyFields(payload, EMPLOYEE_CREATE_FIELDS);
        code = boundedRequired(code, "员工编码", 80);
        name = boundedRequired(name, "员工姓名", 200);
        return jdbcTemplate.queryForMap("""
            INSERT INTO md_employee (code, name, position, department, phone, email, remark, enabled)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            RETURNING id::text AS id,
                      system_no::text AS "systemNo",
                      code,
                      name,
                      COALESCE(position, '') AS position,
                      COALESCE(department, '') AS department,
                      COALESCE(phone, '') AS phone,
                      COALESCE(email, '') AS email,
                      COALESCE(remark, '') AS remark,
                      version,
                      CASE WHEN audit_status = 'AUDITED' THEN '已审核' ELSE '未审核' END AS "auditStatus",
                      CASE WHEN enabled THEN '启用' ELSE '禁用' END AS status,
                      to_char(updated_at, 'YYYY-MM-DD HH24:MI') AS "updatedAt"
            """,
            code,
            name,
            boundedOptional(payload, "position", "岗位", 120),
            boundedOptional(payload, "department", "部门", 160),
            boundedOptional(payload, "phone", "手机", 80),
            boundedOptional(payload, "email", "邮箱", 200),
            optional(payload, "remark"),
            enabled
        );
    }

    private Map<String, Object> createFinancialAccount(String code, String name, Map<String, String> payload, boolean enabled) {
        assertOnlyFields(payload, FINANCIAL_ACCOUNT_CREATE_FIELDS);
        code = boundedRequired(code, "账户编码", 80);
        name = boundedRequired(name, "账户名称", 200);
        var accountType = requiredOneOf(payload, "accountType", Set.of("CASH", "BANK", "DEPOSIT"));
        var currency = requiredOneOf(payload, "currency", Set.of("CNY", "USD"));
        var bankName = boundedOptional(payload, "bankName", "开户行", 200);
        var accountNo = boundedOptional(payload, "accountNo", "账号", 120);
        var accountHolder = boundedOptional(payload, "accountHolder", "户名", 200);
        if ("CASH".equals(accountType)) {
            if (bankName != null || accountNo != null || accountHolder != null) {
                throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "CASH 账户不得填写开户行、账号或户名");
            }
        } else if (bankName == null || accountNo == null || accountHolder == null) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "BANK/DEPOSIT 账户必须填写开户行、账号和户名");
        }
        return jdbcTemplate.queryForMap("""
            INSERT INTO md_financial_account (
                code, name, account_type, bank_name, account_no, account_holder, currency, remark, enabled
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            RETURNING id::text AS id,
                      system_no::text AS "systemNo",
                      code,
                      name,
                      account_type AS "accountType",
                      COALESCE(bank_name, '') AS "bankName",
                      COALESCE(account_no, '') AS "accountNo",
                      COALESCE(account_holder, '') AS "accountHolder",
                      currency,
                      COALESCE(remark, '') AS remark,
                      version,
                      CASE WHEN audit_status = 'AUDITED' THEN '已审核' ELSE '未审核' END AS "auditStatus",
                      CASE WHEN enabled THEN '启用' ELSE '禁用' END AS status,
                      to_char(updated_at, 'YYYY-MM-DD HH24:MI') AS "updatedAt"
            """,
            code,
            name,
            accountType,
            bankName,
            accountNo,
            accountHolder,
            currency,
            optional(payload, "remark"),
            enabled
        );
    }

    private Map<String, Object> updateProduct(String code, String name, Map<String, String> payload, boolean enabled) {
        var category = requiredReference("md_product_category", required(payload, "category"), "物料类别");
        var unit = requiredReference("md_unit", required(payload, "unit"), "计量单位");
        var defaultWarehouse = optionalReference("md_warehouse", optional(payload, "defaultWarehouseCode"), "默认仓库");
        var defaultSupplier = optionalReference("md_supplier", optional(payload, "defaultSupplierCode"), "默认供应商");
        var defaultWorkshop = optionalReference("md_production_department", optional(payload, "defaultWorkshop"), "默认生产车间");
        return updateAndReturn("""
            UPDATE md_product
            SET name = ?, short_name = ?, barcode = ?, brand = ?, spec = ?, category = ?, product_category_id = ?::uuid, product_type = ?, unit = ?, unit_id = ?::uuid, net_weight = ?, gross_weight = ?,
                oe_no = ?, position_name = ?, surface_treatment = ?,
                is_purchase = ?, is_sale = ?, is_inventory = ?, is_produce = ?, is_subcontract = ?,
                default_warehouse_code = ?, default_warehouse_id = ?::uuid, default_workshop = ?, default_workshop_id = ?::uuid,
                sale_unit = ?, purchase_unit = ?, bom_unit = ?, default_supplier_code = ?, default_supplier_id = ?::uuid, issue_warehouse_code = ?, issue_method = ?,
                tax_rate = ?, default_sale_price = ?, cost_price = ?, min_sale_price = ?, purchase_price = ?, max_purchase_price = ?, subcontract_price = ?,
                wholesale_price = ?, retail_price = ?, min_stock_qty = ?, safety_stock_qty = ?, max_stock_qty = ?, remark = ?,
                drawing_file_name = ?, drawing_file_data = COALESCE(NULLIF(?, ''), drawing_file_data),
                image_file_names = ?, image_file_data = COALESCE(NULLIF(?, ''), image_file_data),
                enabled = ?, audit_status = 'DRAFT', updated_at = now(), version = version + 1
            WHERE code = ?
            RETURNING id::text AS id, system_no::text AS "systemNo", code, name
            """,
            name,
            optional(payload, "shortName"),
            optional(payload, "barcode"),
            optional(payload, "brand"),
            payload.getOrDefault("spec", ""),
            category.name(),
            category.id(),
            payload.getOrDefault("productType", "普通"),
            unit.code(),
            unit.id(),
            optionalDecimal(payload, "netWeight", "净重"),
            optionalDecimal(payload, "grossWeight", "毛重"),
            optional(payload, "oeNo"),
            optional(payload, "positionName"),
            optional(payload, "surfaceTreatment"),
            checked(payload, "isPurchase"),
            checked(payload, "isSale"),
            checked(payload, "isInventory", true),
            checked(payload, "isProduce"),
            checked(payload, "isSubcontract"),
            defaultWarehouse.codeOrNull(),
            defaultWarehouse.idOrNull(),
            defaultWorkshop.nameOrNull(),
            defaultWorkshop.idOrNull(),
            payload.getOrDefault("saleUnit", unit.code()),
            payload.getOrDefault("purchaseUnit", unit.code()),
            payload.getOrDefault("bomUnit", unit.code()),
            defaultSupplier.codeOrNull(),
            defaultSupplier.idOrNull(),
            optional(payload, "issueWarehouseCode"),
            payload.getOrDefault("issueMethod", "按单领料"),
            decimalOrDefault(payload, "taxRate", BigDecimal.valueOf(13)),
            defaultSalePrice(payload),
            optionalDecimal(payload, "costPrice", "成本价"),
            optionalDecimal(payload, "minSalePrice", "最低销售价"),
            optionalDecimal(payload, "purchasePrice", "采购价"),
            optionalDecimal(payload, "maxPurchasePrice", "最高采购价"),
            optionalDecimal(payload, "subcontractPrice", "委外价"),
            optionalDecimal(payload, "wholesalePrice", "批发价"),
            optionalDecimal(payload, "retailPrice", "零售价"),
            optionalDecimal(payload, "minStockQty", "最低库存数量"),
            optionalDecimal(payload, "safetyStockQty", "安全库存数量"),
            optionalDecimal(payload, "maxStockQty", "最高库存数量"),
            optional(payload, "remark"),
            optional(payload, "drawingFileName"),
            optional(payload, "drawingFileData"),
            optional(payload, "imageFileNames"),
            optional(payload, "imageFileData"),
            enabled,
            code
        );
    }

    private Map<String, Object> createProductCategory(String code, String name, Map<String, String> payload, boolean enabled) {
        return jdbcTemplate.queryForMap("""
            INSERT INTO md_product_category (code, name, parent_code, sort_no, remark, enabled)
            VALUES (?, ?, ?, ?, ?, ?)
            RETURNING id::text AS id, code, name
            """,
            code,
            name,
            optional(payload, "parentCode"),
            integerOrDefault(payload, "sortNo", 0, "排序"),
            optional(payload, "remark"),
            enabled
        );
    }

    private Map<String, Object> createUnit(String code, String name, Map<String, String> payload, boolean enabled) {
        return jdbcTemplate.queryForMap("""
            INSERT INTO md_unit (code, name, decimal_places, sort_no, remark, enabled)
            VALUES (?, ?, ?, ?, ?, ?)
            RETURNING id::text AS id, code, name
            """,
            code,
            name,
            integerOrDefault(payload, "decimalPlaces", 0, "数量小数位"),
            integerOrDefault(payload, "sortNo", 0, "排序"),
            optional(payload, "remark"),
            enabled
        );
    }

    private Map<String, Object> createProductionDepartment(String code, String name, Map<String, String> payload, boolean enabled) {
        return jdbcTemplate.queryForMap("""
            INSERT INTO md_production_department (code, name, manager, remark, enabled, audit_status)
            VALUES (?, ?, ?, ?, ?, 'DRAFT')
            RETURNING id::text AS id, system_no::text AS "systemNo", code, name, CASE WHEN audit_status = 'AUDITED' THEN '已审核' ELSE '草稿' END AS "auditStatus"
            """,
            code,
            name,
            optional(payload, "manager"),
            optional(payload, "remark"),
            enabled
        );
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

    private MasterReference requiredReference(String table, String value, String label) {
        return resolveReference(table, value, label, true);
    }

    private MasterReference optionalReference(String table, String value, String label) {
        return resolveReference(table, value, label, false);
    }

    private MasterReference resolveReference(String table, String value, String label, boolean required) {
        if (!isSupportedReferenceTable(table)) {
            throw new IllegalArgumentException("Unsupported reference table: " + table);
        }
        var normalized = value == null ? "" : value.trim();
        if (normalized.isBlank()) {
            if (required) {
                throw new ResponseStatusException(HttpStatus.BAD_REQUEST, label + "必填");
            }
            return MasterReference.empty();
        }
        var rows = jdbcTemplate.queryForList("""
            SELECT id::text AS id, code, name
            FROM %s
            WHERE enabled = TRUE
              AND audit_status = 'AUDITED'
              AND (code = ? OR name = ?)
            ORDER BY CASE WHEN code = ? THEN 0 ELSE 1 END, code
            LIMIT 2
            """.formatted(table), normalized, normalized, normalized);
        if (rows.isEmpty()) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, label + "不存在、未审核或已禁用");
        }
        var hasExactCode = rows.stream().anyMatch(row -> normalized.equals(String.valueOf(row.get("code"))));
        if (rows.size() > 1 && !hasExactCode) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, label + "名称不唯一，请输入编码");
        }
        var row = rows.get(0);
        return new MasterReference(
            String.valueOf(row.get("id")),
            String.valueOf(row.get("code")),
            String.valueOf(row.get("name"))
        );
    }

    private boolean isSupportedReferenceTable(String table) {
        return switch (table) {
            case "md_product_category", "md_unit", "md_warehouse", "md_supplier", "md_production_department" -> true;
            default -> false;
        };
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

    private record MasterReference(String id, String code, String name) {
        static MasterReference empty() {
            return new MasterReference(null, null, null);
        }

        String idOrNull() {
            return id;
        }

        String codeOrNull() {
            return code;
        }

        String nameOrNull() {
            return name;
        }
    }

    private BigDecimal defaultSalePrice(Map<String, String> payload) {
        var value = payload.getOrDefault("defaultSalePrice", "").trim();
        if (value.isBlank()) {
            return null;
        }
        try {
            var price = new BigDecimal(value);
            if (price.compareTo(BigDecimal.ZERO) < 0) {
                throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "默认销售价不能小于 0");
            }
            return price;
        } catch (NumberFormatException ex) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "默认销售价格式不正确");
        }
    }

    private Map<String, Object> updateCustomer(String code, String name, Map<String, String> payload, boolean enabled) {
        return updateAndReturn("""
            UPDATE md_customer
            SET name = ?, short_name = ?, customer_level = ?, contact = ?, phone = ?, region = ?, tax_no = ?,
                address = ?, credit_limit = ?, settlement_method = ?, owner_name = ?, remark = ?,
                enabled = ?, audit_status = 'DRAFT', updated_at = now(), version = version + 1
            WHERE code = ?
            RETURNING id::text AS id, system_no::text AS "systemNo", code, name
            """,
            name,
            optional(payload, "shortName"),
            payload.getOrDefault("customerLevel", "普通客户"),
            payload.getOrDefault("contact", ""),
            payload.getOrDefault("phone", ""),
            payload.getOrDefault("region", ""),
            optional(payload, "taxNo"),
            optional(payload, "address"),
            optionalDecimal(payload, "creditLimit", "信用额度"),
            payload.getOrDefault("settlementMethod", "月结"),
            optional(payload, "ownerName"),
            optional(payload, "remark"),
            enabled,
            code
        );
    }

    private Map<String, Object> updateSupplier(String code, String name, Map<String, String> payload, boolean enabled) {
        return updateAndReturn("""
            UPDATE md_supplier
            SET name = ?, short_name = ?, supplier_level = ?, contact = ?, phone = ?, tax_no = ?,
                address = ?, bank_account = ?, settlement_method = ?, owner_name = ?, remark = ?,
                enabled = ?, audit_status = 'DRAFT', updated_at = now(), version = version + 1
            WHERE code = ?
            RETURNING id::text AS id, system_no::text AS "systemNo", code, name
            """,
            name,
            optional(payload, "shortName"),
            payload.getOrDefault("supplierLevel", "普通供应商"),
            payload.getOrDefault("contact", ""),
            payload.getOrDefault("phone", ""),
            optional(payload, "taxNo"),
            optional(payload, "address"),
            optional(payload, "bankAccount"),
            payload.getOrDefault("settlementMethod", "月结"),
            optional(payload, "ownerName"),
            optional(payload, "remark"),
            enabled,
            code
        );
    }

    private Map<String, Object> updateWarehouse(String code, String name, Map<String, String> payload, boolean enabled) {
        var allowNegative = "允许负库存".equals(payload.getOrDefault("stockPolicy", "不允许负库存"));
        return updateAndReturn("""
            UPDATE md_warehouse
            SET name = ?, warehouse_type = ?, manager = ?, phone = ?, address = ?, allow_negative_stock = ?, remark = ?,
                enabled = ?, audit_status = 'DRAFT', updated_at = now(), version = version + 1
            WHERE code = ?
            RETURNING id::text AS id, system_no::text AS "systemNo", code, name
            """,
            name,
            payload.getOrDefault("warehouseType", "普通仓"),
            optional(payload, "manager"),
            optional(payload, "phone"),
            optional(payload, "address"),
            allowNegative,
            optional(payload, "remark"),
            enabled,
            code
        );
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
        if (A140_MASTER_TYPES.contains(type)) {
            var current = lockA140Master(type, code);
            var beforeEnabled = Boolean.TRUE.equals(current.get("enabled"));
            var beforeAuditStatus = String.valueOf(current.get("audit_status"));
            var result = updateAndReturn(
                "UPDATE " + tableName(type)
                    + " SET enabled = ?, updated_at = now(), version = version + 1 WHERE code = ? RETURNING "
                    + returningFor(type),
                enabled,
                code
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
        if (!enabled) {
            assertNotReferencedByProduct(type, code, "禁用");
        }
        var table = tableName(type);
        return updateAndReturn("UPDATE " + table + " SET enabled = ?, updated_at = now(), version = version + 1 WHERE code = ? RETURNING " + returningFor(type),
            enabled,
            code
        );
    }

    private Map<String, Object> setAuditStatus(String type, String code, String auditStatus) {
        if (A140_MASTER_TYPES.contains(type)) {
            var current = lockA140Master(type, code);
            var beforeAuditStatus = String.valueOf(current.get("audit_status"));
            var expectedBefore = "AUDITED".equals(auditStatus) ? "DRAFT" : "AUDITED";
            if (!expectedBefore.equals(beforeAuditStatus)) {
                throw new ResponseStatusException(
                    HttpStatus.CONFLICT,
                    "AUDITED".equals(auditStatus) ? "只有草稿资料可以审核" : "只有已审核资料可以反审核"
                );
            }
            var enabled = Boolean.TRUE.equals(current.get("enabled"));
            var result = updateAndReturn(
                "UPDATE " + tableName(type)
                    + " SET audit_status = ?, updated_at = now(), version = version + 1"
                    + " WHERE code = ? AND audit_status = ? RETURNING " + returningFor(type),
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
        if ("product".equals(type) && "AUDITED".equals(auditStatus)) {
            validateProductReferencesBeforeAudit(code);
        }
        if ("DRAFT".equals(auditStatus)) {
            assertNotReferencedByProduct(type, code, "反审核");
        }
        var table = tableName(type);
        return updateAndReturn("UPDATE " + table + " SET audit_status = ?, updated_at = now(), version = version + 1 WHERE code = ? RETURNING " + returningFor(type),
            auditStatus,
            code
        );
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

    private Map<String, Object> lockA140Master(String type, String code) {
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

    private boolean createEnabledStatus(Map<String, String> payload) {
        if (payload == null || !payload.containsKey("status")) {
            return true;
        }
        return switch (String.valueOf(payload.get("status")).trim()) {
            case "启用" -> true;
            case "禁用" -> false;
            default -> throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "status 只允许“启用”或“禁用”");
        };
    }

    private String requiredOneOf(Map<String, String> payload, String field, Set<String> allowed) {
        var value = required(payload, field);
        if (!allowed.contains(value)) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, field + " 只允许 " + String.join("/", allowed));
        }
        return value;
    }

    private void assertOnlyFields(Map<String, String> payload, Set<String> allowed) {
        if (payload == null) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "请求体必须为 JSON 对象");
        }
        payload.keySet().stream()
            .filter(field -> !allowed.contains(field))
            .findFirst()
            .ifPresent(field -> {
                throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "不允许创建字段: " + field);
            });
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

    private String boundedRequired(String value, String label, int maxLength) {
        var normalized = value == null ? "" : value.trim();
        if (normalized.isBlank()) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, label + "不能为空");
        }
        if (normalized.length() > maxLength) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, label + "不能超过" + maxLength + "个字符");
        }
        return normalized;
    }

    private String boundedOptional(Map<String, String> payload, String field, String label, int maxLength) {
        var value = optional(payload, field);
        if (value != null && value.length() > maxLength) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, label + "不能超过" + maxLength + "个字符");
        }
        return value;
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

    private boolean checked(Map<String, String> payload, String field) {
        return checked(payload, field, false);
    }

    private boolean checked(Map<String, String> payload, String field, boolean defaultValue) {
        var value = payload.get(field);
        if (value == null || value.isBlank()) {
            return defaultValue;
        }
        return "true".equalsIgnoreCase(value) || "是".equals(value) || "1".equals(value) || "on".equalsIgnoreCase(value);
    }

    private BigDecimal decimalOrDefault(Map<String, String> payload, String field, BigDecimal defaultValue) {
        var value = payload.getOrDefault(field, "").trim();
        if (value.isBlank()) {
            return defaultValue;
        }
        return parseNonNegativeDecimal(value, field);
    }

    private BigDecimal optionalDecimal(Map<String, String> payload, String field, String label) {
        var value = payload.getOrDefault(field, "").trim();
        if (value.isBlank()) {
            return null;
        }
        return parseNonNegativeDecimal(value, label);
    }

    private BigDecimal parseNonNegativeDecimal(String value, String label) {
        try {
            var decimal = new BigDecimal(value);
            if (decimal.compareTo(BigDecimal.ZERO) < 0) {
                throw new ResponseStatusException(HttpStatus.BAD_REQUEST, label + "不能小于 0");
            }
            return decimal;
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
