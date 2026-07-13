package com.jdy.erp.masterdata.application;

import java.math.BigDecimal;
import java.util.ArrayList;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;

import com.fasterxml.jackson.databind.JsonNode;
import org.springframework.dao.DataIntegrityViolationException;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.server.ResponseStatusException;

@Service
public class MasterDataPatchService {
    private static final Map<String, MasterDefinition> DEFINITIONS = Map.of(
        "product", new MasterDefinition("md_product", Map.ofEntries(
            Map.entry("name", requiredText("name", "物料名称", 200)),
            Map.entry("shortName", optionalText("short_name", "物料简称", 120)),
            Map.entry("barcode", optionalText("barcode", "条码", 120)),
            Map.entry("brand", optionalText("brand", "品牌", 120)),
            Map.entry("spec", optionalText("spec", "规格型号", 200)),
            Map.entry("category", requiredReference("category", "product_category_id", "md_product_category", "物料类别", ReferenceDisplay.NAME)),
            Map.entry("productType", requiredText("product_type", "物料类型", 80)),
            Map.entry("unit", requiredReference("unit", "unit_id", "md_unit", "计量单位", ReferenceDisplay.CODE)),
            Map.entry("netWeight", optionalDecimal("net_weight", "净重")),
            Map.entry("grossWeight", optionalDecimal("gross_weight", "毛重")),
            Map.entry("oeNo", optionalText("oe_no", "OE 号", 120)),
            Map.entry("positionName", optionalText("position_name", "位置", 120)),
            Map.entry("surfaceTreatment", optionalText("surface_treatment", "表面处理", 120)),
            Map.entry("isPurchase", requiredBoolean("is_purchase", "可采购")),
            Map.entry("isSale", requiredBoolean("is_sale", "可销售")),
            Map.entry("isInventory", requiredBoolean("is_inventory", "可库存")),
            Map.entry("isProduce", requiredBoolean("is_produce", "可自制")),
            Map.entry("isSubcontract", requiredBoolean("is_subcontract", "可委外")),
            Map.entry("defaultWarehouseCode", optionalReference("default_warehouse_code", "default_warehouse_id", "md_warehouse", "默认仓库", ReferenceDisplay.CODE)),
            Map.entry("defaultWorkshop", optionalReference("default_workshop", "default_workshop_id", "md_production_department", "默认生产车间", ReferenceDisplay.NAME)),
            Map.entry("saleUnit", optionalText("sale_unit", "销售单位", 80)),
            Map.entry("purchaseUnit", optionalText("purchase_unit", "采购单位", 80)),
            Map.entry("bomUnit", optionalText("bom_unit", "BOM 单位", 80)),
            Map.entry("defaultSupplierCode", optionalReference("default_supplier_code", "default_supplier_id", "md_supplier", "默认供应商", ReferenceDisplay.CODE)),
            Map.entry("issueWarehouseCode", optionalText("issue_warehouse_code", "发料仓库", 80)),
            Map.entry("issueMethod", requiredText("issue_method", "发料方式", 80)),
            Map.entry("taxRate", requiredDecimal("tax_rate", "税率")),
            Map.entry("defaultSalePrice", optionalDecimal("default_sale_price", "默认销售价")),
            Map.entry("costPrice", optionalDecimal("cost_price", "成本价")),
            Map.entry("minSalePrice", optionalDecimal("min_sale_price", "最低销售价")),
            Map.entry("purchasePrice", optionalDecimal("purchase_price", "采购价")),
            Map.entry("maxPurchasePrice", optionalDecimal("max_purchase_price", "最高采购价")),
            Map.entry("subcontractPrice", optionalDecimal("subcontract_price", "委外价")),
            Map.entry("wholesalePrice", optionalDecimal("wholesale_price", "批发价")),
            Map.entry("retailPrice", optionalDecimal("retail_price", "零售价")),
            Map.entry("minStockQty", optionalDecimal("min_stock_qty", "最低库存数量")),
            Map.entry("safetyStockQty", optionalDecimal("safety_stock_qty", "安全库存数量")),
            Map.entry("maxStockQty", optionalDecimal("max_stock_qty", "最高库存数量")),
            Map.entry("remark", optionalText("remark", "备注", 0)),
            Map.entry("drawingFileName", optionalText("drawing_file_name", "图纸名称", 255)),
            Map.entry("drawingFileData", optionalRawText("drawing_file_data", "图纸内容")),
            Map.entry("imageFileNames", optionalText("image_file_names", "图片名称", 0)),
            Map.entry("imageFileData", optionalRawText("image_file_data", "图片内容"))
        )),
        "customer", new MasterDefinition("md_customer", Map.ofEntries(
            Map.entry("name", requiredText("name", "客户名称", 200)),
            Map.entry("shortName", optionalText("short_name", "客户简称", 120)),
            Map.entry("customerLevel", requiredText("customer_level", "客户等级", 80)),
            Map.entry("contact", optionalText("contact", "联系人", 120)),
            Map.entry("phone", optionalText("phone", "电话", 80)),
            Map.entry("region", optionalText("region", "地区", 160)),
            Map.entry("taxNo", optionalText("tax_no", "税号", 120)),
            Map.entry("address", optionalText("address", "地址", 300)),
            Map.entry("creditLimit", optionalDecimal("credit_limit", "信用额度")),
            Map.entry("settlementMethod", requiredText("settlement_method", "结算方式", 80)),
            Map.entry("ownerName", optionalText("owner_name", "负责人", 120)),
            Map.entry("remark", optionalText("remark", "备注", 0))
        )),
        "supplier", new MasterDefinition("md_supplier", Map.ofEntries(
            Map.entry("name", requiredText("name", "供应商名称", 200)),
            Map.entry("shortName", optionalText("short_name", "供应商简称", 120)),
            Map.entry("supplierLevel", requiredText("supplier_level", "供应商等级", 80)),
            Map.entry("contact", optionalText("contact", "联系人", 120)),
            Map.entry("phone", optionalText("phone", "电话", 80)),
            Map.entry("taxNo", optionalText("tax_no", "税号", 120)),
            Map.entry("address", optionalText("address", "地址", 300)),
            Map.entry("bankAccount", optionalText("bank_account", "银行账户", 200)),
            Map.entry("settlementMethod", requiredText("settlement_method", "结算方式", 80)),
            Map.entry("ownerName", optionalText("owner_name", "负责人", 120)),
            Map.entry("remark", optionalText("remark", "备注", 0))
        )),
        "warehouse", new MasterDefinition("md_warehouse", Map.ofEntries(
            Map.entry("name", requiredText("name", "仓库名称", 200)),
            Map.entry("warehouseType", requiredText("warehouse_type", "仓库类型", 80)),
            Map.entry("manager", optionalText("manager", "仓管员", 120)),
            Map.entry("phone", optionalText("phone", "电话", 80)),
            Map.entry("address", optionalText("address", "地址", 300)),
            Map.entry("stockPolicy", stockPolicy("allow_negative_stock", "负库存策略")),
            Map.entry("remark", optionalText("remark", "备注", 0))
        )),
        "employee", new MasterDefinition("md_employee", Map.ofEntries(
            Map.entry("name", requiredText("name", "员工姓名", 200)),
            Map.entry("position", optionalText("position", "岗位", 120)),
            Map.entry("department", optionalText("department", "部门", 160)),
            Map.entry("phone", optionalText("phone", "手机", 80)),
            Map.entry("email", optionalText("email", "邮箱", 200)),
            Map.entry("remark", optionalText("remark", "备注", 0))
        )),
        "financialAccount", new MasterDefinition("md_financial_account", Map.ofEntries(
            Map.entry("name", requiredText("name", "账户名称", 200)),
            Map.entry("accountType", accountType("account_type", "账户类型")),
            Map.entry("bankName", optionalText("bank_name", "开户行", 200)),
            Map.entry("accountNo", optionalText("account_no", "账号", 120)),
            Map.entry("accountHolder", optionalText("account_holder", "户名", 200)),
            Map.entry("currency", currency("currency", "币种")),
            Map.entry("remark", optionalText("remark", "备注", 0))
        ))
    );

    private final JdbcTemplate jdbcTemplate;

    public MasterDataPatchService(JdbcTemplate jdbcTemplate) {
        this.jdbcTemplate = jdbcTemplate;
    }

    @Transactional
    public PatchResult patch(String type, String code, long expectedVersion, Map<String, JsonNode> changes) {
        var definition = DEFINITIONS.get(type);
        if (definition == null) {
            throw new ResponseStatusException(HttpStatus.NOT_FOUND, "Unsupported master data type");
        }
        var normalizedCode = code == null ? "" : code.trim();
        if (normalizedCode.isBlank()) {
            throw badRequest("主数据编码不能为空");
        }
        if (expectedVersion < 0) {
            throw badRequest("version 必须为非负整数");
        }
        if (changes == null || changes.isEmpty()) {
            throw badRequest("changes 至少包含一个字段");
        }
        for (var field : changes.keySet()) {
            if (!definition.fields().containsKey(field)) {
                throw badRequest("不允许更新字段: " + field);
            }
        }

        var financialColumns = "financialAccount".equals(type)
            ? ", account_type, bank_name, account_no, account_holder, currency"
            : "";
        var currentRows = jdbcTemplate.queryForList("""
            SELECT id::text AS id, code, name, version, audit_status, enabled%s
            FROM %s
            WHERE code = ?
            FOR UPDATE
            """.formatted(financialColumns, definition.table()), normalizedCode);
        if (currentRows.isEmpty()) {
            throw new ResponseStatusException(HttpStatus.NOT_FOUND, "主数据不存在");
        }
        var current = currentRows.getFirst();
        var auditStatus = String.valueOf(current.get("audit_status"));
        var currentVersion = ((Number) current.get("version")).longValue();
        if (!"DRAFT".equals(auditStatus)) {
            throw new ResponseStatusException(HttpStatus.CONFLICT, "资料已审核，请先正式反审核后再编辑");
        }
        if (currentVersion != expectedVersion) {
            throw new ResponseStatusException(HttpStatus.CONFLICT, "资料已被其他操作更新，请刷新后重试");
        }
        if ("financialAccount".equals(type)) {
            validateFinancialAccountShape(current, changes, definition);
        }

        var assignments = new ArrayList<Assignment>();
        changes.forEach((field, node) -> addAssignment(
            assignments,
            definition.fields().get(field),
            node
        ));

        var clauses = new ArrayList<String>();
        var arguments = new ArrayList<Object>();
        assignments.forEach(assignment -> {
            clauses.add(assignment.expression());
            arguments.add(assignment.value());
        });
        clauses.add("updated_at = now()");
        clauses.add("version = version + 1");
        arguments.add(current.get("id"));
        arguments.add(normalizedCode);
        arguments.add(expectedVersion);

        var sql = """
            UPDATE %s
            SET %s
            WHERE id = ?::uuid
              AND code = ?
              AND version = ?
              AND audit_status = 'DRAFT'
            RETURNING id::text AS id,
                      system_no::text AS "systemNo",
                      code,
                      name,
                      version,
                      CASE WHEN audit_status = 'AUDITED' THEN '已审核' ELSE '草稿' END AS "auditStatus",
                      CASE WHEN enabled THEN '启用' ELSE '禁用' END AS status
            """.formatted(definition.table(), String.join(", ", clauses));

        final List<Map<String, Object>> updatedRows;
        try {
            updatedRows = jdbcTemplate.queryForList(sql, arguments.toArray());
        } catch (DataIntegrityViolationException exception) {
            throw badRequest("字段值不符合主数据约束");
        }
        if (updatedRows.isEmpty()) {
            throw new ResponseStatusException(HttpStatus.CONFLICT, "资料已被其他操作更新，请刷新后重试");
        }
        var updated = normalizedRow(type, normalizedCode);
        var changedFields = changes.keySet().stream().sorted().toList();
        return new PatchResult(
            updated,
            UUID.fromString(String.valueOf(updated.get("id"))),
            definition.table(),
            normalizedCode,
            expectedVersion,
            ((Number) updated.get("version")).longValue(),
            Boolean.TRUE.equals(current.get("enabled")),
            changedFields
        );
    }

    private void validateFinancialAccountShape(
        Map<String, Object> current,
        Map<String, JsonNode> changes,
        MasterDefinition definition
    ) {
        var accountType = enumAfterChange(current, changes, definition, "accountType", "account_type", Set.of("CASH", "BANK", "DEPOSIT"));
        enumAfterChange(current, changes, definition, "currency", "currency", Set.of("CNY", "USD"));
        var bankName = optionalTextAfterChange(current, changes, definition, "bankName", "bank_name");
        var accountNo = optionalTextAfterChange(current, changes, definition, "accountNo", "account_no");
        var accountHolder = optionalTextAfterChange(current, changes, definition, "accountHolder", "account_holder");
        if ("CASH".equals(accountType)) {
            if (bankName != null || accountNo != null || accountHolder != null) {
                throw badRequest("CASH 账户不得填写开户行、账号或户名");
            }
            return;
        }
        if (bankName == null || accountNo == null || accountHolder == null) {
            throw badRequest("BANK/DEPOSIT 账户必须填写开户行、账号和户名");
        }
    }

    private String enumAfterChange(
        Map<String, Object> current,
        Map<String, JsonNode> changes,
        MasterDefinition definition,
        String field,
        String column,
        Set<String> allowedValues
    ) {
        var node = changes.get(field);
        return node == null
            ? String.valueOf(current.get(column))
            : enumValue(node, definition.fields().get(field), allowedValues);
    }

    private String optionalTextAfterChange(
        Map<String, Object> current,
        Map<String, JsonNode> changes,
        MasterDefinition definition,
        String field,
        String column
    ) {
        if (!changes.containsKey(field)) {
            var value = current.get(column);
            return value == null ? null : String.valueOf(value);
        }
        var node = changes.get(field);
        if (node == null || node.isNull()) {
            return null;
        }
        return (String) normalizedText(node, definition.fields().get(field), true);
    }

    private Map<String, Object> normalizedRow(String type, String code) {
        var sql = switch (type) {
            case "product" -> """
                SELECT id::text AS id,
                       system_no::text AS "systemNo",
                       code,
                       name,
                       COALESCE(short_name, '') AS "shortName",
                       COALESCE(barcode, '') AS barcode,
                       COALESCE(brand, '') AS brand,
                       COALESCE(spec, '') AS spec,
                       category,
                       product_type AS "productType",
                       unit,
                       trim(to_char(net_weight, 'FM9999999990.00')) AS "netWeight",
                       trim(to_char(gross_weight, 'FM9999999990.00')) AS "grossWeight",
                       COALESCE(oe_no, '') AS "oeNo",
                       COALESCE(position_name, '') AS "positionName",
                       COALESCE(surface_treatment, '') AS "surfaceTreatment",
                       CASE WHEN is_purchase THEN '是' ELSE '否' END AS "isPurchase",
                       CASE WHEN is_sale THEN '是' ELSE '否' END AS "isSale",
                       CASE WHEN is_inventory THEN '是' ELSE '否' END AS "isInventory",
                       CASE WHEN is_produce THEN '是' ELSE '否' END AS "isProduce",
                       CASE WHEN is_subcontract THEN '是' ELSE '否' END AS "isSubcontract",
                       COALESCE(default_warehouse_code, '') AS "defaultWarehouseCode",
                       COALESCE(default_workshop, '') AS "defaultWorkshop",
                       COALESCE(sale_unit, unit) AS "saleUnit",
                       COALESCE(purchase_unit, unit) AS "purchaseUnit",
                       COALESCE(bom_unit, unit) AS "bomUnit",
                       COALESCE(default_supplier_code, '') AS "defaultSupplierCode",
                       COALESCE(issue_warehouse_code, '') AS "issueWarehouseCode",
                       issue_method AS "issueMethod",
                       trim(to_char(tax_rate, 'FM9999999990.####')) AS "taxRate",
                       trim(to_char(default_sale_price, 'FM9999999990.00')) AS "defaultSalePrice",
                       trim(to_char(cost_price, 'FM9999999990.00')) AS "costPrice",
                       trim(to_char(min_sale_price, 'FM9999999990.00')) AS "minSalePrice",
                       trim(to_char(purchase_price, 'FM9999999990.00')) AS "purchasePrice",
                       trim(to_char(max_purchase_price, 'FM9999999990.00')) AS "maxPurchasePrice",
                       trim(to_char(subcontract_price, 'FM9999999990.00')) AS "subcontractPrice",
                       trim(to_char(wholesale_price, 'FM9999999990.00')) AS "wholesalePrice",
                       trim(to_char(retail_price, 'FM9999999990.00')) AS "retailPrice",
                       trim(to_char(min_stock_qty, 'FM9999999990.####')) AS "minStockQty",
                       trim(to_char(safety_stock_qty, 'FM9999999990.####')) AS "safetyStockQty",
                       trim(to_char(max_stock_qty, 'FM9999999990.####')) AS "maxStockQty",
                       COALESCE(remark, '') AS remark,
                       COALESCE(drawing_file_name, '') AS "drawingFileName",
                       COALESCE(image_file_names, '') AS "imageFileNames",
                       version,
                       CASE WHEN enabled THEN '启用' ELSE '禁用' END AS status,
                       CASE WHEN audit_status = 'AUDITED' THEN '已审核' ELSE '未审核' END AS "auditStatus",
                       to_char(updated_at, 'YYYY-MM-DD HH24:MI') AS "updatedAt"
                FROM md_product
                WHERE code = ?
                """;
            case "customer" -> """
                SELECT id::text AS id,
                       system_no::text AS "systemNo",
                       code,
                       name,
                       COALESCE(short_name, '') AS "shortName",
                       customer_level AS "customerLevel",
                       COALESCE(contact, '') AS contact,
                       COALESCE(phone, '') AS phone,
                       COALESCE(region, '') AS region,
                       COALESCE(tax_no, '') AS "taxNo",
                       COALESCE(address, '') AS address,
                       trim(to_char(credit_limit, 'FM9999999990.00')) AS "creditLimit",
                       settlement_method AS "settlementMethod",
                       COALESCE(owner_name, '') AS "ownerName",
                       COALESCE(remark, '') AS remark,
                       version,
                       CASE WHEN enabled THEN '启用' ELSE '禁用' END AS status,
                       CASE WHEN audit_status = 'AUDITED' THEN '已审核' ELSE '未审核' END AS "auditStatus"
                FROM md_customer
                WHERE code = ?
                """;
            case "supplier" -> """
                SELECT id::text AS id,
                       system_no::text AS "systemNo",
                       code,
                       name,
                       COALESCE(short_name, '') AS "shortName",
                       supplier_level AS "supplierLevel",
                       COALESCE(contact, '') AS contact,
                       COALESCE(phone, '') AS phone,
                       COALESCE(tax_no, '') AS "taxNo",
                       COALESCE(address, '') AS address,
                       COALESCE(bank_account, '') AS "bankAccount",
                       settlement_method AS "settlementMethod",
                       COALESCE(owner_name, '') AS "ownerName",
                       COALESCE(remark, '') AS remark,
                       version,
                       CASE WHEN enabled THEN '启用' ELSE '禁用' END AS status,
                       CASE WHEN audit_status = 'AUDITED' THEN '已审核' ELSE '未审核' END AS "auditStatus"
                FROM md_supplier
                WHERE code = ?
                """;
            case "warehouse" -> """
                SELECT id::text AS id,
                       system_no::text AS "systemNo",
                       code,
                       name,
                       warehouse_type AS "warehouseType",
                       COALESCE(manager, '') AS manager,
                       COALESCE(phone, '') AS phone,
                       COALESCE(address, '') AS address,
                       CASE WHEN allow_negative_stock THEN '允许负库存' ELSE '不允许负库存' END AS "stockPolicy",
                       COALESCE(remark, '') AS remark,
                       version,
                       CASE WHEN enabled THEN '启用' ELSE '禁用' END AS status,
                       CASE WHEN audit_status = 'AUDITED' THEN '已审核' ELSE '未审核' END AS "auditStatus"
                FROM md_warehouse
                WHERE code = ?
                """;
            case "employee" -> """
                SELECT id::text AS id,
                       system_no::text AS "systemNo",
                       code,
                       name,
                       COALESCE(position, '') AS position,
                       COALESCE(department, '') AS department,
                       COALESCE(phone, '') AS phone,
                       COALESCE(email, '') AS email,
                       COALESCE(remark, '') AS remark,
                       version,
                       CASE WHEN enabled THEN '启用' ELSE '禁用' END AS status,
                       CASE WHEN audit_status = 'AUDITED' THEN '已审核' ELSE '未审核' END AS "auditStatus",
                       to_char(updated_at, 'YYYY-MM-DD HH24:MI') AS "updatedAt"
                FROM md_employee
                WHERE code = ?
                """;
            case "financialAccount" -> """
                SELECT id::text AS id,
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
                       CASE WHEN enabled THEN '启用' ELSE '禁用' END AS status,
                       CASE WHEN audit_status = 'AUDITED' THEN '已审核' ELSE '未审核' END AS "auditStatus",
                       to_char(updated_at, 'YYYY-MM-DD HH24:MI') AS "updatedAt"
                FROM md_financial_account
                WHERE code = ?
                """;
            default -> throw new ResponseStatusException(HttpStatus.NOT_FOUND, "Unsupported master data type");
        };
        return jdbcTemplate.queryForMap(sql, code);
    }

    private void addAssignment(
        List<Assignment> assignments,
        FieldSpec spec,
        JsonNode node
    ) {
        if (spec.type() == ValueType.REFERENCE) {
            var reference = referenceValue(node, spec);
            assignments.add(new Assignment(spec.column() + " = ?", reference.displayValue()));
            assignments.add(new Assignment(spec.reference().idColumn() + " = ?::uuid", reference.id()));
            return;
        }
        var value = scalarValue(node, spec);
        assignments.add(new Assignment(spec.column() + " = ?", value));
    }

    private Object scalarValue(JsonNode node, FieldSpec spec) {
        if (node == null || node.isNull()) {
            if (!spec.nullable()) {
                throw badRequest(spec.label() + "不能为 null");
            }
            return null;
        }
        return switch (spec.type()) {
            case TEXT -> normalizedText(node, spec, true);
            case RAW_TEXT -> normalizedText(node, spec, false);
            case DECIMAL -> decimalValue(node, spec.label());
            case BOOLEAN -> {
                if (!node.isBoolean()) {
                    throw badRequest(spec.label() + "必须为布尔值");
                }
                yield node.booleanValue();
            }
            case STOCK_POLICY -> {
                if (!node.isTextual()) {
                    throw badRequest(spec.label() + "必须为字符串");
                }
                yield switch (node.textValue()) {
                    case "允许负库存" -> true;
                    case "不允许负库存" -> false;
                    default -> throw badRequest(spec.label() + "只允许“允许负库存”或“不允许负库存”");
                };
            }
            case ACCOUNT_TYPE -> enumValue(node, spec, Set.of("CASH", "BANK", "DEPOSIT"));
            case CURRENCY -> enumValue(node, spec, Set.of("CNY", "USD"));
            case REFERENCE -> throw new IllegalStateException("引用字段必须单独解析");
        };
    }

    private String enumValue(JsonNode node, FieldSpec spec, java.util.Set<String> allowedValues) {
        if (!node.isTextual()) {
            throw badRequest(spec.label() + "必须为字符串");
        }
        var value = node.textValue().trim();
        if (!allowedValues.contains(value)) {
            throw badRequest(spec.label() + "只允许 " + String.join("/", allowedValues));
        }
        return value;
    }

    private Object normalizedText(JsonNode node, FieldSpec spec, boolean trim) {
        if (!node.isTextual()) {
            throw badRequest(spec.label() + "必须为字符串");
        }
        var value = trim ? node.textValue().trim() : node.textValue();
        if (value.isBlank()) {
            if (spec.nullable()) {
                return null;
            }
            throw badRequest(spec.label() + "不能为空");
        }
        if (spec.maxLength() > 0 && value.length() > spec.maxLength()) {
            throw badRequest(spec.label() + "长度不能超过 " + spec.maxLength());
        }
        return value;
    }

    private BigDecimal decimalValue(JsonNode node, String label) {
        if (!node.isNumber()) {
            throw badRequest(label + "必须为数值");
        }
        var value = node.decimalValue();
        if (value.compareTo(BigDecimal.ZERO) < 0) {
            throw badRequest(label + "不能小于 0");
        }
        return value;
    }

    private ReferenceValue referenceValue(JsonNode node, FieldSpec spec) {
        if (node == null || node.isNull()) {
            if (!spec.nullable()) {
                throw badRequest(spec.label() + "不能为 null");
            }
            return ReferenceValue.empty();
        }
        if (!node.isTextual()) {
            throw badRequest(spec.label() + "必须为字符串");
        }
        var normalized = node.textValue().trim();
        if (normalized.isBlank()) {
            if (!spec.nullable()) {
                throw badRequest(spec.label() + "不能为空");
            }
            return ReferenceValue.empty();
        }
        var reference = spec.reference();
        var rows = jdbcTemplate.queryForList("""
            SELECT id::text AS id, code, name
            FROM %s
            WHERE enabled = TRUE
              AND audit_status = 'AUDITED'
              AND (code = ? OR name = ?)
            ORDER BY CASE WHEN code = ? THEN 0 ELSE 1 END, code
            LIMIT 2
            FOR SHARE
            """.formatted(reference.table()), normalized, normalized, normalized);
        if (rows.isEmpty()) {
            throw badRequest(spec.label() + "不存在、未审核或已禁用");
        }
        var hasExactCode = rows.stream().anyMatch(row -> normalized.equals(String.valueOf(row.get("code"))));
        if (rows.size() > 1 && !hasExactCode) {
            throw badRequest(spec.label() + "名称不唯一，请输入编码");
        }
        var row = rows.getFirst();
        var displayValue = reference.display() == ReferenceDisplay.CODE
            ? String.valueOf(row.get("code"))
            : String.valueOf(row.get("name"));
        return new ReferenceValue(String.valueOf(row.get("id")), displayValue);
    }

    private ResponseStatusException badRequest(String message) {
        return new ResponseStatusException(HttpStatus.BAD_REQUEST, message);
    }

    private static FieldSpec requiredText(String column, String label, int maxLength) {
        return new FieldSpec(column, label, ValueType.TEXT, false, maxLength, null);
    }

    private static FieldSpec optionalText(String column, String label, int maxLength) {
        return new FieldSpec(column, label, ValueType.TEXT, true, maxLength, null);
    }

    private static FieldSpec optionalRawText(String column, String label) {
        return new FieldSpec(column, label, ValueType.RAW_TEXT, true, 0, null);
    }

    private static FieldSpec requiredDecimal(String column, String label) {
        return new FieldSpec(column, label, ValueType.DECIMAL, false, 0, null);
    }

    private static FieldSpec optionalDecimal(String column, String label) {
        return new FieldSpec(column, label, ValueType.DECIMAL, true, 0, null);
    }

    private static FieldSpec requiredBoolean(String column, String label) {
        return new FieldSpec(column, label, ValueType.BOOLEAN, false, 0, null);
    }

    private static FieldSpec stockPolicy(String column, String label) {
        return new FieldSpec(column, label, ValueType.STOCK_POLICY, false, 0, null);
    }

    private static FieldSpec accountType(String column, String label) {
        return new FieldSpec(column, label, ValueType.ACCOUNT_TYPE, false, 0, null);
    }

    private static FieldSpec currency(String column, String label) {
        return new FieldSpec(column, label, ValueType.CURRENCY, false, 0, null);
    }

    private static FieldSpec requiredReference(
        String displayColumn,
        String idColumn,
        String table,
        String label,
        ReferenceDisplay display
    ) {
        return new FieldSpec(displayColumn, label, ValueType.REFERENCE, false, 0, new ReferenceSpec(table, idColumn, display));
    }

    private static FieldSpec optionalReference(
        String displayColumn,
        String idColumn,
        String table,
        String label,
        ReferenceDisplay display
    ) {
        return new FieldSpec(displayColumn, label, ValueType.REFERENCE, true, 0, new ReferenceSpec(table, idColumn, display));
    }

    public record PatchResult(
        Map<String, Object> body,
        UUID id,
        String targetType,
        String code,
        long previousVersion,
        long version,
        boolean enabled,
        List<String> changedFields
    ) {
        public PatchResult {
            body = Collections.unmodifiableMap(new LinkedHashMap<>(body));
            changedFields = List.copyOf(changedFields);
        }
    }

    private record MasterDefinition(String table, Map<String, FieldSpec> fields) {
    }

    private record FieldSpec(
        String column,
        String label,
        ValueType type,
        boolean nullable,
        int maxLength,
        ReferenceSpec reference
    ) {
    }

    private record ReferenceSpec(String table, String idColumn, ReferenceDisplay display) {
    }

    private record Assignment(String expression, Object value) {
    }

    private record ReferenceValue(String id, String displayValue) {
        static ReferenceValue empty() {
            return new ReferenceValue(null, null);
        }
    }

    private enum ValueType {
        TEXT,
        RAW_TEXT,
        DECIMAL,
        BOOLEAN,
        STOCK_POLICY,
        ACCOUNT_TYPE,
        CURRENCY,
        REFERENCE
    }

    private enum ReferenceDisplay {
        CODE,
        NAME
    }
}
