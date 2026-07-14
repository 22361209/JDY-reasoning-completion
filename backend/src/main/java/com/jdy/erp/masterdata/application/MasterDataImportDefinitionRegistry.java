package com.jdy.erp.masterdata.application;

import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;

import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Component;
import org.springframework.web.server.ResponseStatusException;

@Component
public final class MasterDataImportDefinitionRegistry {
    public static final int TEMPLATE_VERSION = 1;
    public static final int MAX_DATA_ROWS = 5_000;
    public static final int MAX_COLUMNS = 64;
    public static final long MAX_FILE_BYTES = 10L * 1024 * 1024;
    public static final long MAX_EXPANDED_BYTES = 50L * 1024 * 1024;
    public static final int MAX_CELL_CHARACTERS = 32_767;
    public static final String DATA_SHEET = "导入数据";
    public static final String GUIDE_SHEET = "填写说明";
    public static final String META_SHEET = "__meta";

    private final Map<String, ImportDefinition> definitions;

    public MasterDataImportDefinitionRegistry() {
        var ordered = new LinkedHashMap<String, ImportDefinition>();
        register(ordered, definition(
            "productCategory", "物料类别", "product-category.xlsx",
            List.of(
                text("code", "类别编码", true, 80, true),
                text("name", "类别名称", true, 120, false),
                text("parentCode", "上级类别编码", false, 80, true),
                integer("sortNo", "排序", false, "0"),
                enumeration("status", "状态", false, Set.of("启用", "禁用"), "启用"),
                text("remark", "备注", false, MAX_CELL_CHARACTERS, false)
            ),
            Map.of()
        ));
        register(ordered, definition(
            "unit", "计量单位", "unit.xlsx",
            List.of(
                text("code", "单位名称/编码", true, 80, true),
                integer("decimalPlaces", "数量小数位", false, "0"),
                integer("sortNo", "排序", false, "0"),
                enumeration("status", "状态", false, Set.of("启用", "禁用"), "启用"),
                text("remark", "备注", false, MAX_CELL_CHARACTERS, false)
            ),
            Map.of()
        ));
        register(ordered, definition(
            "customer", "客户", "customer.xlsx",
            List.of(
                text("code", "客户编码", true, 80, true),
                text("name", "客户名称", true, 200, false),
                text("contact", "联系人", false, 120, false),
                text("phone", "电话", false, 80, true),
                text("region", "地区", false, 160, false),
                text("address", "地址", false, 300, false),
                enumeration("status", "状态", false, Set.of("启用", "禁用"), "启用"),
                text("remark", "备注", false, MAX_CELL_CHARACTERS, false)
            ),
            Map.of()
        ));
        register(ordered, definition(
            "supplier", "供应商", "supplier.xlsx",
            List.of(
                text("code", "供应商编码", true, 80, true),
                text("name", "供应商名称", true, 200, false),
                text("contact", "联系人", false, 120, false),
                text("phone", "电话", false, 80, true),
                text("address", "地址", false, 300, false),
                enumeration("status", "状态", false, Set.of("启用", "禁用"), "启用"),
                text("remark", "备注", false, MAX_CELL_CHARACTERS, false)
            ),
            Map.of()
        ));
        register(ordered, definition(
            "warehouse", "仓库", "warehouse.xlsx",
            List.of(
                text("code", "仓库编码", true, 80, true),
                text("name", "仓库名称", true, 200, false),
                enumeration(
                    "warehouseType", "仓库类型", false,
                    Set.of("普通仓", "成品仓", "原料仓", "半成品仓", "不良品仓", "虚拟仓"), "普通仓"
                ),
                text("manager", "仓管员", false, 120, false),
                text("address", "仓库地址", false, 300, false),
                enumeration("status", "状态", false, Set.of("启用", "禁用"), "启用"),
                text("remark", "备注", false, MAX_CELL_CHARACTERS, false)
            ),
            Map.of()
        ));
        register(ordered, definition(
            "employee", "员工", "employee.xlsx",
            List.of(
                text("code", "员工编码", true, 80, true),
                text("name", "员工姓名", true, 200, false),
                text("position", "岗位", false, 120, false),
                text("department", "部门", false, 160, false),
                text("phone", "手机", false, 80, true),
                text("email", "邮箱", false, 200, false),
                enumeration("status", "状态", false, Set.of("启用", "禁用"), "启用"),
                text("remark", "备注", false, MAX_CELL_CHARACTERS, false)
            ),
            Map.of()
        ));
        register(ordered, definition(
            "financialAccount", "账户资料", "financial-account.xlsx",
            List.of(
                text("code", "账户编码", true, 80, true),
                text("name", "账户名称", true, 200, false),
                enumeration("accountType", "账户类型", true, Set.of("CASH", "BANK", "DEPOSIT"), null),
                enumeration("currency", "币种", true, Set.of("CNY", "USD"), null),
                text("bankName", "开户行", false, 200, false),
                text("accountNo", "账号", false, 120, true),
                text("accountHolder", "户名", false, 200, false),
                enumeration("status", "状态", false, Set.of("启用", "禁用"), "启用"),
                text("remark", "备注", false, MAX_CELL_CHARACTERS, false)
            ),
            Map.of()
        ));
        register(ordered, definition(
            "product", "物料", "product.xlsx",
            List.of(
                text("code", "物料编码", true, 80, true),
                text("name", "物料名称", true, 200, false),
                text("category", "物料类别编码", true, 80, true),
                text("spec", "规格型号", false, 200, false),
                text("unit", "计量单位编码", true, 40, true),
                decimal("netWeight", "净重", false, 18, 2, null),
                decimal("grossWeight", "毛重", false, 18, 2, null),
                text("surfaceTreatment", "表面处理", false, 120, false),
                bool("isSale", "可销售", false, "是"),
                bool("isPurchase", "可采购", false, "否"),
                bool("isInventory", "可库存", false, "是"),
                bool("isProduce", "可自制", false, "是"),
                bool("isSubcontract", "可委外", false, "否"),
                decimal("purchasePrice", "采购价", false, 18, 6, null),
                decimal("costPrice", "参考成本", false, 18, 6, null),
                decimal("minSalePrice", "最低销售价", false, 18, 6, null),
                decimal("taxRate", "税率(%)", false, 8, 4, "13"),
                decimal("minStockQty", "最低库存数量", false, 18, 4, null),
                decimal("safetyStockQty", "安全库存数量", false, 18, 4, null),
                decimal("maxStockQty", "最高库存数量", false, 18, 4, null),
                text("defaultWorkshop", "默认生产车间编码", false, 80, true),
                text("defaultWarehouseCode", "默认仓库编码", false, 80, true),
                text("defaultSupplierCode", "默认供应商编码", false, 80, true)
            ),
            Map.of("productType", "普通", "issueMethod", "按单领料")
        ));
        definitions = Collections.unmodifiableMap(ordered);
    }

    public List<ImportDefinition> all() {
        return List.copyOf(definitions.values());
    }

    public ImportDefinition require(String type) {
        var definition = definitions.get(type);
        if (definition == null) {
            throw new ResponseStatusException(HttpStatus.NOT_FOUND, "不支持的主数据导入类型");
        }
        return definition;
    }

    private static ImportDefinition definition(
        String type,
        String title,
        String fileName,
        List<FieldDefinition> fields,
        Map<String, String> hiddenDefaults
    ) {
        return new ImportDefinition(type, title, fileName, fields, hiddenDefaults);
    }

    private static void register(Map<String, ImportDefinition> target, ImportDefinition definition) {
        if (target.put(definition.type(), definition) != null) {
            throw new IllegalStateException("重复导入类型: " + definition.type());
        }
    }

    private static FieldDefinition text(
        String key,
        String header,
        boolean required,
        int maxLength,
        boolean textOnly
    ) {
        return new FieldDefinition(key, header, required, FieldKind.TEXT, Set.of(), null, maxLength, 0, 0, textOnly);
    }

    private static FieldDefinition integer(String key, String header, boolean required, String defaultValue) {
        return new FieldDefinition(key, header, required, FieldKind.INTEGER, Set.of(), defaultValue, 0, 10, 0, false);
    }

    private static FieldDefinition decimal(
        String key,
        String header,
        boolean required,
        int precision,
        int scale,
        String defaultValue
    ) {
        return new FieldDefinition(key, header, required, FieldKind.DECIMAL, Set.of(), defaultValue, 0, precision, scale, false);
    }

    private static FieldDefinition bool(String key, String header, boolean required, String defaultValue) {
        return new FieldDefinition(
            key, header, required, FieldKind.BOOLEAN, Set.of("是", "否", "true", "false"), defaultValue, 0, 0, 0, false
        );
    }

    private static FieldDefinition enumeration(
        String key,
        String header,
        boolean required,
        Set<String> values,
        String defaultValue
    ) {
        return new FieldDefinition(key, header, required, FieldKind.ENUM, values, defaultValue, 0, 0, 0, false);
    }

    public enum FieldKind {
        TEXT,
        INTEGER,
        DECIMAL,
        BOOLEAN,
        ENUM
    }

    public record FieldDefinition(
        String key,
        String header,
        boolean required,
        FieldKind kind,
        Set<String> allowedValues,
        String defaultValue,
        int maxLength,
        int precision,
        int scale,
        boolean textOnly
    ) {
        public FieldDefinition {
            allowedValues = Set.copyOf(allowedValues);
        }

        public String workbookHeader() {
            return required ? "*" + header : header;
        }
    }

    public record ImportDefinition(
        String type,
        String title,
        String fileName,
        List<FieldDefinition> fields,
        Map<String, String> hiddenDefaults
    ) {
        public ImportDefinition {
            fields = List.copyOf(fields);
            hiddenDefaults = Map.copyOf(hiddenDefaults);
            var seenKeys = new java.util.HashSet<String>();
            var seenHeaders = new java.util.HashSet<String>();
            for (var field : fields) {
                if (!seenKeys.add(field.key()) || !seenHeaders.add(field.workbookHeader())) {
                    throw new IllegalArgumentException("导入定义包含重复字段或表头: " + type);
                }
            }
        }

        public String resourcePath() {
            return "master-data-import/" + fileName;
        }

        public List<String> headers() {
            return fields.stream().map(FieldDefinition::workbookHeader).toList();
        }

        public Map<String, String> defaults() {
            var result = new LinkedHashMap<String, String>();
            fields.stream()
                .filter(field -> field.defaultValue() != null)
                .forEach(field -> result.put(field.key(), field.defaultValue()));
            result.putAll(hiddenDefaults);
            return Collections.unmodifiableMap(result);
        }
    }
}
