package com.jdy.erp.masterdata.application;

import java.math.BigDecimal;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Set;

import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.server.ResponseStatusException;

@Service
public class MasterDataCreateService {
    private static final Set<String> SUPPORTED_TYPES = Set.of(
        "product",
        "customer",
        "supplier",
        "warehouse",
        "productCategory",
        "unit",
        "productionDepartment",
        "employee",
        "financialAccount"
    );
    private static final Set<String> A140_MASTER_TYPES = Set.of("employee", "financialAccount");
    private static final Set<String> EMPLOYEE_CREATE_FIELDS = Set.of(
        "code", "name", "position", "department", "phone", "email", "remark", "status"
    );
    private static final Set<String> FINANCIAL_ACCOUNT_CREATE_FIELDS = Set.of(
        "code", "name", "accountType", "bankName", "accountNo", "accountHolder", "currency", "remark", "status"
    );

    private final JdbcTemplate jdbcTemplate;

    public MasterDataCreateService(JdbcTemplate jdbcTemplate) {
        this.jdbcTemplate = jdbcTemplate;
    }

    /**
     * Validates and normalizes a create request without writing a master-data row or consuming a sequence.
     * Database reads are limited to current-tenant duplicate and reference checks through the routed data source.
     */
    public ValidatedCreate validateCreate(String type, Map<String, String> payload) {
        return validateCreate(type, payload, CreateOptions.manual());
    }

    public ValidatedCreate validateCreate(String type, Map<String, String> payload, CreateOptions options) {
        return prepare(type, payload, options, false).validated();
    }

    @Transactional
    public Map<String, Object> create(String type, Map<String, String> payload) {
        return create(type, payload, CreateOptions.manual());
    }

    @Transactional
    public Map<String, Object> create(String type, Map<String, String> payload, CreateOptions options) {
        return insert(prepare(type, payload, options, true));
    }

    private PreparedCreate prepare(
        String type,
        Map<String, String> payload,
        CreateOptions options,
        boolean lockReferences
    ) {
        if (!SUPPORTED_TYPES.contains(type)) {
            throw new ResponseStatusException(HttpStatus.NOT_FOUND, "Unsupported master data type");
        }
        var effectivePayload = effectivePayload(payload, options);
        var code = required(effectivePayload, "code");
        var name = "unit".equals(type)
            ? valueOrDefault(effectivePayload, "name", code).trim()
            : required(effectivePayload, "name");
        if (name.isBlank()) {
            name = code;
        }
        var enabled = A140_MASTER_TYPES.contains(type)
            ? createEnabledStatus(effectivePayload)
            : legacyEnabledStatus(effectivePayload);

        var values = switch (type) {
            case "product" -> productValues(effectivePayload, options.referenceMode(), lockReferences);
            case "customer" -> customerValues(effectivePayload);
            case "supplier" -> supplierValues(effectivePayload);
            case "warehouse" -> warehouseValues(effectivePayload);
            case "productCategory" -> productCategoryValues(effectivePayload);
            case "unit" -> unitValues(effectivePayload);
            case "productionDepartment" -> productionDepartmentValues(effectivePayload);
            case "employee" -> employeeValues(effectivePayload, code, name);
            case "financialAccount" -> financialAccountValues(effectivePayload, code, name);
            default -> throw new ResponseStatusException(HttpStatus.NOT_FOUND, "Unsupported master data type");
        };

        if ("employee".equals(type)) {
            code = String.valueOf(values.get("code"));
            name = String.valueOf(values.get("name"));
        } else if ("financialAccount".equals(type)) {
            code = String.valueOf(values.get("code"));
            name = String.valueOf(values.get("name"));
        }
        assertCreateUnique(type, code, name);
        var normalizedPayload = immutablePayload(effectivePayload);
        return new PreparedCreate(
            new ValidatedCreate(type, code, name, enabled, normalizedPayload),
            Collections.unmodifiableMap(new LinkedHashMap<>(values))
        );
    }

    private Map<String, String> effectivePayload(Map<String, String> payload, CreateOptions options) {
        Objects.requireNonNull(options, "options");
        var effective = new LinkedHashMap<String, String>();
        if (payload != null) {
            effective.putAll(payload);
        }
        options.explicitDefaults().forEach((field, defaultValue) -> {
            var current = effective.get(field);
            if (current == null || current.trim().isBlank()) {
                effective.put(field, defaultValue);
            }
        });
        return effective;
    }

    private Map<String, String> immutablePayload(Map<String, String> payload) {
        return Collections.unmodifiableMap(new LinkedHashMap<>(payload));
    }

    private Map<String, Object> productValues(
        Map<String, String> payload,
        ReferenceMode referenceMode,
        boolean lockReferences
    ) {
        var category = requiredReference(
            "md_product_category",
            required(payload, "category"),
            "物料类别",
            referenceMode,
            lockReferences
        );
        var unit = requiredReference(
            "md_unit",
            required(payload, "unit"),
            "计量单位",
            referenceMode,
            lockReferences
        );
        var defaultWarehouse = optionalReference(
            "md_warehouse",
            optional(payload, "defaultWarehouseCode"),
            "默认仓库",
            referenceMode,
            lockReferences
        );
        var defaultSupplier = optionalReference(
            "md_supplier",
            optional(payload, "defaultSupplierCode"),
            "默认供应商",
            referenceMode,
            lockReferences
        );
        var defaultWorkshop = optionalReference(
            "md_production_department",
            optional(payload, "defaultWorkshop"),
            "默认生产车间",
            referenceMode,
            lockReferences
        );
        var values = new LinkedHashMap<String, Object>();
        values.put("category", category);
        values.put("unit", unit);
        values.put("defaultWarehouse", defaultWarehouse);
        values.put("defaultSupplier", defaultSupplier);
        values.put("defaultWorkshop", defaultWorkshop);
        values.put("netWeight", optionalDecimal(payload, "netWeight", "净重"));
        values.put("grossWeight", optionalDecimal(payload, "grossWeight", "毛重"));
        values.put("isPurchase", checked(payload, "isPurchase"));
        values.put("isSale", checked(payload, "isSale"));
        values.put("isInventory", checked(payload, "isInventory", true));
        values.put("isProduce", checked(payload, "isProduce"));
        values.put("isSubcontract", checked(payload, "isSubcontract"));
        values.put("taxRate", decimalOrDefault(payload, "taxRate", BigDecimal.valueOf(13)));
        values.put("defaultSalePrice", defaultSalePrice(payload));
        values.put("costPrice", optionalDecimal(payload, "costPrice", "成本价"));
        values.put("minSalePrice", optionalDecimal(payload, "minSalePrice", "最低销售价"));
        values.put("purchasePrice", optionalDecimal(payload, "purchasePrice", "采购价"));
        values.put("maxPurchasePrice", optionalDecimal(payload, "maxPurchasePrice", "最高采购价"));
        values.put("subcontractPrice", optionalDecimal(payload, "subcontractPrice", "委外价"));
        values.put("wholesalePrice", optionalDecimal(payload, "wholesalePrice", "批发价"));
        values.put("retailPrice", optionalDecimal(payload, "retailPrice", "零售价"));
        values.put("minStockQty", optionalDecimal(payload, "minStockQty", "最低库存数量"));
        values.put("safetyStockQty", optionalDecimal(payload, "safetyStockQty", "安全库存数量"));
        values.put("maxStockQty", optionalDecimal(payload, "maxStockQty", "最高库存数量"));
        return values;
    }

    private Map<String, Object> customerValues(Map<String, String> payload) {
        var values = new LinkedHashMap<String, Object>();
        values.put("creditLimit", optionalDecimal(payload, "creditLimit", "信用额度"));
        return values;
    }

    private Map<String, Object> supplierValues(Map<String, String> payload) {
        return Map.of();
    }

    private Map<String, Object> warehouseValues(Map<String, String> payload) {
        return Map.of(
            "allowNegative",
            "允许负库存".equals(valueOrDefault(payload, "stockPolicy", "不允许负库存"))
        );
    }

    private Map<String, Object> productCategoryValues(Map<String, String> payload) {
        return Map.of("sortNo", integerOrDefault(payload, "sortNo", 0, "排序"));
    }

    private Map<String, Object> unitValues(Map<String, String> payload) {
        return Map.of(
            "decimalPlaces", integerOrDefault(payload, "decimalPlaces", 0, "数量小数位"),
            "sortNo", integerOrDefault(payload, "sortNo", 0, "排序")
        );
    }

    private Map<String, Object> productionDepartmentValues(Map<String, String> payload) {
        return Map.of();
    }

    private Map<String, Object> employeeValues(Map<String, String> payload, String code, String name) {
        assertOnlyFields(payload, EMPLOYEE_CREATE_FIELDS);
        var values = new LinkedHashMap<String, Object>();
        values.put("code", boundedRequired(code, "员工编码", 80));
        values.put("name", boundedRequired(name, "员工姓名", 200));
        values.put("position", boundedOptional(payload, "position", "岗位", 120));
        values.put("department", boundedOptional(payload, "department", "部门", 160));
        values.put("phone", boundedOptional(payload, "phone", "手机", 80));
        values.put("email", boundedOptional(payload, "email", "邮箱", 200));
        return values;
    }

    private Map<String, Object> financialAccountValues(Map<String, String> payload, String code, String name) {
        assertOnlyFields(payload, FINANCIAL_ACCOUNT_CREATE_FIELDS);
        var values = new LinkedHashMap<String, Object>();
        values.put("code", boundedRequired(code, "账户编码", 80));
        values.put("name", boundedRequired(name, "账户名称", 200));
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
        values.put("accountType", accountType);
        values.put("currency", currency);
        values.put("bankName", bankName);
        values.put("accountNo", accountNo);
        values.put("accountHolder", accountHolder);
        return values;
    }

    private Map<String, Object> insert(PreparedCreate prepared) {
        var validated = prepared.validated();
        return switch (validated.type()) {
            case "product" -> insertProduct(validated, prepared.values());
            case "customer" -> insertCustomer(validated, prepared.values());
            case "supplier" -> insertSupplier(validated);
            case "warehouse" -> insertWarehouse(validated, prepared.values());
            case "productCategory" -> insertProductCategory(validated, prepared.values());
            case "unit" -> insertUnit(validated, prepared.values());
            case "productionDepartment" -> insertProductionDepartment(validated);
            case "employee" -> insertEmployee(validated, prepared.values());
            case "financialAccount" -> insertFinancialAccount(validated, prepared.values());
            default -> throw new ResponseStatusException(HttpStatus.NOT_FOUND, "Unsupported master data type");
        };
    }

    private Map<String, Object> insertProduct(ValidatedCreate validated, Map<String, Object> values) {
        var payload = validated.normalizedPayload();
        var category = reference(values, "category");
        var unit = reference(values, "unit");
        var defaultWarehouse = reference(values, "defaultWarehouse");
        var defaultSupplier = reference(values, "defaultSupplier");
        var defaultWorkshop = reference(values, "defaultWorkshop");
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
            validated.code(),
            validated.name(),
            optional(payload, "shortName"),
            optional(payload, "barcode"),
            optional(payload, "brand"),
            valueOrDefault(payload, "spec", ""),
            category.name(),
            category.id(),
            valueOrDefault(payload, "productType", "普通"),
            unit.code(),
            unit.id(),
            values.get("netWeight"),
            values.get("grossWeight"),
            optional(payload, "oeNo"),
            optional(payload, "positionName"),
            optional(payload, "surfaceTreatment"),
            values.get("isPurchase"),
            values.get("isSale"),
            values.get("isInventory"),
            values.get("isProduce"),
            values.get("isSubcontract"),
            defaultWarehouse.codeOrNull(),
            defaultWarehouse.idOrNull(),
            defaultWorkshop.nameOrNull(),
            defaultWorkshop.idOrNull(),
            valueOrDefault(payload, "saleUnit", unit.code()),
            valueOrDefault(payload, "purchaseUnit", unit.code()),
            valueOrDefault(payload, "bomUnit", unit.code()),
            defaultSupplier.codeOrNull(),
            defaultSupplier.idOrNull(),
            optional(payload, "issueWarehouseCode"),
            valueOrDefault(payload, "issueMethod", "按单领料"),
            values.get("taxRate"),
            values.get("defaultSalePrice"),
            values.get("costPrice"),
            values.get("minSalePrice"),
            values.get("purchasePrice"),
            values.get("maxPurchasePrice"),
            values.get("subcontractPrice"),
            values.get("wholesalePrice"),
            values.get("retailPrice"),
            values.get("minStockQty"),
            values.get("safetyStockQty"),
            values.get("maxStockQty"),
            optional(payload, "remark"),
            optional(payload, "drawingFileName"),
            optional(payload, "drawingFileData"),
            optional(payload, "imageFileNames"),
            optional(payload, "imageFileData"),
            validated.enabled()
        );
    }

    private Map<String, Object> insertCustomer(ValidatedCreate validated, Map<String, Object> values) {
        var payload = validated.normalizedPayload();
        return jdbcTemplate.queryForMap("""
            INSERT INTO md_customer (
                code, name, short_name, customer_level, contact, phone, region, tax_no,
                address, credit_limit, settlement_method, owner_name, remark, enabled
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            RETURNING id::text AS id, system_no::text AS "systemNo", code, name
            """,
            validated.code(),
            validated.name(),
            optional(payload, "shortName"),
            valueOrDefault(payload, "customerLevel", "普通客户"),
            valueOrDefault(payload, "contact", ""),
            valueOrDefault(payload, "phone", ""),
            valueOrDefault(payload, "region", ""),
            optional(payload, "taxNo"),
            optional(payload, "address"),
            values.get("creditLimit"),
            valueOrDefault(payload, "settlementMethod", "月结"),
            optional(payload, "ownerName"),
            optional(payload, "remark"),
            validated.enabled()
        );
    }

    private Map<String, Object> insertSupplier(ValidatedCreate validated) {
        var payload = validated.normalizedPayload();
        return jdbcTemplate.queryForMap("""
            INSERT INTO md_supplier (
                code, name, short_name, supplier_level, contact, phone, tax_no,
                address, bank_account, settlement_method, owner_name, remark, enabled
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            RETURNING id::text AS id, system_no::text AS "systemNo", code, name
            """,
            validated.code(),
            validated.name(),
            optional(payload, "shortName"),
            valueOrDefault(payload, "supplierLevel", "普通供应商"),
            valueOrDefault(payload, "contact", ""),
            valueOrDefault(payload, "phone", ""),
            optional(payload, "taxNo"),
            optional(payload, "address"),
            optional(payload, "bankAccount"),
            valueOrDefault(payload, "settlementMethod", "月结"),
            optional(payload, "ownerName"),
            optional(payload, "remark"),
            validated.enabled()
        );
    }

    private Map<String, Object> insertWarehouse(ValidatedCreate validated, Map<String, Object> values) {
        var payload = validated.normalizedPayload();
        return jdbcTemplate.queryForMap("""
            INSERT INTO md_warehouse (code, name, warehouse_type, manager, phone, address, allow_negative_stock, remark, enabled)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            RETURNING id::text AS id, system_no::text AS "systemNo", code, name
            """,
            validated.code(),
            validated.name(),
            valueOrDefault(payload, "warehouseType", "普通仓"),
            optional(payload, "manager"),
            optional(payload, "phone"),
            optional(payload, "address"),
            values.get("allowNegative"),
            optional(payload, "remark"),
            validated.enabled()
        );
    }

    private Map<String, Object> insertEmployee(ValidatedCreate validated, Map<String, Object> values) {
        var payload = validated.normalizedPayload();
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
            validated.code(),
            validated.name(),
            values.get("position"),
            values.get("department"),
            values.get("phone"),
            values.get("email"),
            optional(payload, "remark"),
            validated.enabled()
        );
    }

    private Map<String, Object> insertFinancialAccount(ValidatedCreate validated, Map<String, Object> values) {
        var payload = validated.normalizedPayload();
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
            validated.code(),
            validated.name(),
            values.get("accountType"),
            values.get("bankName"),
            values.get("accountNo"),
            values.get("accountHolder"),
            values.get("currency"),
            optional(payload, "remark"),
            validated.enabled()
        );
    }

    private Map<String, Object> insertProductCategory(ValidatedCreate validated, Map<String, Object> values) {
        var payload = validated.normalizedPayload();
        return jdbcTemplate.queryForMap("""
            INSERT INTO md_product_category (code, name, parent_code, sort_no, remark, enabled)
            VALUES (?, ?, ?, ?, ?, ?)
            RETURNING id::text AS id, code, name
            """,
            validated.code(),
            validated.name(),
            optional(payload, "parentCode"),
            values.get("sortNo"),
            optional(payload, "remark"),
            validated.enabled()
        );
    }

    private Map<String, Object> insertUnit(ValidatedCreate validated, Map<String, Object> values) {
        var payload = validated.normalizedPayload();
        return jdbcTemplate.queryForMap("""
            INSERT INTO md_unit (code, name, decimal_places, sort_no, remark, enabled)
            VALUES (?, ?, ?, ?, ?, ?)
            RETURNING id::text AS id,
                      code,
                      name,
                      version,
                      CASE WHEN enabled THEN '启用' ELSE '禁用' END AS status,
                      CASE WHEN audit_status = 'AUDITED' THEN '已审核' ELSE '未审核' END AS "auditStatus"
            """,
            validated.code(),
            validated.name(),
            values.get("decimalPlaces"),
            values.get("sortNo"),
            optional(payload, "remark"),
            validated.enabled()
        );
    }

    private Map<String, Object> insertProductionDepartment(ValidatedCreate validated) {
        var payload = validated.normalizedPayload();
        return jdbcTemplate.queryForMap("""
            INSERT INTO md_production_department (code, name, manager, remark, enabled, audit_status)
            VALUES (?, ?, ?, ?, ?, 'DRAFT')
            RETURNING id::text AS id,
                      system_no::text AS "systemNo",
                      code,
                      name,
                      version,
                      CASE WHEN enabled THEN '启用' ELSE '禁用' END AS status,
                      CASE WHEN audit_status = 'AUDITED' THEN '已审核' ELSE '未审核' END AS "auditStatus"
            """,
            validated.code(),
            validated.name(),
            optional(payload, "manager"),
            optional(payload, "remark"),
            validated.enabled()
        );
    }

    private void assertCreateUnique(String type, String code, String name) {
        var table = tableName(type);
        if (!jdbcTemplate.queryForList("SELECT 1 FROM " + table + " WHERE code = ? LIMIT 1", code).isEmpty()) {
            throw new ResponseStatusException(HttpStatus.CONFLICT, "code already exists");
        }
        if (Set.of("productCategory", "unit").contains(type)
            && !jdbcTemplate.queryForList("SELECT 1 FROM " + table + " WHERE name = ? LIMIT 1", name).isEmpty()) {
            throw new ResponseStatusException(HttpStatus.CONFLICT, "code already exists");
        }
    }

    private MasterReference requiredReference(
        String table,
        String value,
        String label,
        ReferenceMode referenceMode,
        boolean lockReference
    ) {
        return resolveReference(table, value, label, true, referenceMode, lockReference);
    }

    private MasterReference optionalReference(
        String table,
        String value,
        String label,
        ReferenceMode referenceMode,
        boolean lockReference
    ) {
        return resolveReference(table, value, label, false, referenceMode, lockReference);
    }

    private MasterReference resolveReference(
        String table,
        String value,
        String label,
        boolean required,
        ReferenceMode referenceMode,
        boolean lockReference
    ) {
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
        var lockClause = lockReference ? " FOR SHARE" : "";
        final List<Map<String, Object>> rows;
        if (referenceMode == ReferenceMode.CODE_ONLY) {
            rows = jdbcTemplate.queryForList("""
                SELECT id::text AS id, code, name
                FROM %s
                WHERE enabled = TRUE
                  AND audit_status = 'AUDITED'
                  AND code = ?
                LIMIT 1%s
                """.formatted(table, lockClause), normalized);
        } else {
            rows = jdbcTemplate.queryForList("""
                SELECT id::text AS id, code, name
                FROM %s
                WHERE enabled = TRUE
                  AND audit_status = 'AUDITED'
                  AND (code = ? OR name = ?)
                ORDER BY CASE WHEN code = ? THEN 0 ELSE 1 END, code
                LIMIT 2%s
                """.formatted(table, lockClause), normalized, normalized, normalized);
        }
        if (rows.isEmpty()) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, label + "不存在、未审核或已禁用");
        }
        var hasExactCode = rows.stream().anyMatch(row -> normalized.equals(String.valueOf(row.get("code"))));
        if (rows.size() > 1 && !hasExactCode) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, label + "名称不唯一，请输入编码");
        }
        var row = rows.getFirst();
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

    private MasterReference reference(Map<String, Object> values, String field) {
        return (MasterReference) values.get(field);
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

    private String valueOrDefault(Map<String, String> payload, String field, String defaultValue) {
        return payload.getOrDefault(field, defaultValue);
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

    private int integerOrDefault(Map<String, String> payload, String field, int defaultValue, String label) {
        var value = valueOrDefault(payload, field, "").trim();
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
        var value = valueOrDefault(payload, field, "").trim();
        if (value.isBlank()) {
            return defaultValue;
        }
        return parseNonNegativeDecimal(value, field);
    }

    private BigDecimal optionalDecimal(Map<String, String> payload, String field, String label) {
        var value = valueOrDefault(payload, field, "").trim();
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

    private BigDecimal defaultSalePrice(Map<String, String> payload) {
        var value = valueOrDefault(payload, "defaultSalePrice", "").trim();
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

    private boolean legacyEnabledStatus(Map<String, String> payload) {
        return !"禁用".equals(valueOrDefault(payload, "status", "启用"));
    }

    private boolean createEnabledStatus(Map<String, String> payload) {
        if (!payload.containsKey("status")) {
            return true;
        }
        return switch (String.valueOf(payload.get("status")).trim()) {
            case "启用" -> true;
            case "禁用" -> false;
            default -> throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "status 只允许“启用”或“禁用”");
        };
    }

    public enum ReferenceMode {
        CODE_OR_NAME,
        CODE_ONLY
    }

    public record CreateOptions(ReferenceMode referenceMode, Map<String, String> explicitDefaults) {
        public CreateOptions {
            Objects.requireNonNull(referenceMode, "referenceMode");
            Objects.requireNonNull(explicitDefaults, "explicitDefaults");
            explicitDefaults = Collections.unmodifiableMap(new LinkedHashMap<>(explicitDefaults));
        }

        public static CreateOptions manual() {
            return new CreateOptions(ReferenceMode.CODE_OR_NAME, Map.of());
        }

        public static CreateOptions importStrict(Map<String, String> explicitDefaults) {
            return new CreateOptions(ReferenceMode.CODE_ONLY, explicitDefaults);
        }
    }

    public record ValidatedCreate(
        String type,
        String code,
        String name,
        boolean enabled,
        Map<String, String> normalizedPayload
    ) {
    }

    private record PreparedCreate(ValidatedCreate validated, Map<String, Object> values) {
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
}
