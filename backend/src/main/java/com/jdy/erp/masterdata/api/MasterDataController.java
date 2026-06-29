package com.jdy.erp.masterdata.api;

import java.math.BigDecimal;
import java.util.Map;

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

@RestController
@RequestMapping("/api/master-data")
public class MasterDataController {
    private final JdbcTemplate jdbcTemplate;

    public MasterDataController(JdbcTemplate jdbcTemplate) {
        this.jdbcTemplate = jdbcTemplate;
    }

    @PostMapping("/{type}")
    @RequirePermission("master.data.manage")
    @ResponseStatus(HttpStatus.CREATED)
    public Map<String, Object> create(@PathVariable String type, @RequestBody Map<String, String> payload) {
        var code = required(payload, "code");
        var name = "unit".equals(type) ? payload.getOrDefault("name", code).trim() : required(payload, "name");
        if (name.isBlank()) {
            name = code;
        }
        var enabled = !"禁用".equals(payload.getOrDefault("status", "启用"));
        return switch (type) {
            case "product" -> createProduct(code, name, payload, enabled);
            case "customer" -> createCustomer(code, name, payload, enabled);
            case "supplier" -> createSupplier(code, name, payload, enabled);
            case "warehouse" -> createWarehouse(code, name, payload, enabled);
            case "productCategory" -> createProductCategory(code, name, payload, enabled);
            case "unit" -> createUnit(code, name, payload, enabled);
            case "productionDepartment" -> createProductionDepartment(code, name, payload, enabled);
            default -> throw new ResponseStatusException(HttpStatus.NOT_FOUND, "Unsupported master data type");
        };
    }

    @PutMapping("/{type}/{code}")
    @RequirePermission("master.data.manage")
    public Map<String, Object> update(@PathVariable String type, @PathVariable String code, @RequestBody Map<String, String> payload) {
        var name = "unit".equals(type) ? payload.getOrDefault("name", code).trim() : required(payload, "name");
        if (name.isBlank()) {
            name = code;
        }
        var enabled = !"禁用".equals(payload.getOrDefault("status", "启用"));
        return switch (type) {
            case "product" -> updateProduct(code, name, payload, enabled);
            case "customer" -> updateCustomer(code, name, payload, enabled);
            case "supplier" -> updateSupplier(code, name, payload, enabled);
            case "warehouse" -> updateWarehouse(code, name, payload, enabled);
            case "productCategory" -> updateProductCategory(code, name, payload, enabled);
            case "unit" -> updateUnit(code, name, payload, enabled);
            case "productionDepartment" -> updateProductionDepartment(code, name, payload, enabled);
            default -> throw new ResponseStatusException(HttpStatus.NOT_FOUND, "Unsupported master data type");
        };
    }

    @PatchMapping("/{type}/{code}/status")
    @RequirePermission("master.data.manage")
    public Map<String, Object> updateStatus(@PathVariable String type, @PathVariable String code, @RequestBody Map<String, String> payload) {
        var enabled = !"禁用".equals(payload.getOrDefault("status", "启用"));
        return setEnabled(type, code, enabled);
    }

    @PostMapping("/{type}/{code}/audit")
    @RequirePermission("master.data.manage")
    public Map<String, Object> audit(@PathVariable String type, @PathVariable String code) {
        return setAuditStatus(type, code, "AUDITED");
    }

    @PostMapping("/{type}/{code}/reverse")
    @RequirePermission("master.data.manage")
    public Map<String, Object> reverseAudit(@PathVariable String type, @PathVariable String code) {
        return setAuditStatus(type, code, "DRAFT");
    }

    @DeleteMapping("/{type}/{code}")
    @RequirePermission("master.data.manage")
    public Map<String, Object> delete(@PathVariable String type, @PathVariable String code) {
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
        var rows = jdbcTemplate.queryForList("SELECT id::text AS id FROM " + table + " WHERE code = ?", code);
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
        var auditStatus = "CASE WHEN audit_status = 'AUDITED' THEN '已审核' ELSE '草稿' END AS \"auditStatus\"";
        return hasSystemNo(type)
            ? "id::text AS id, system_no::text AS \"systemNo\", code, name, " + auditStatus
            : "id::text AS id, code, name, " + auditStatus;
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
            default -> throw new ResponseStatusException(HttpStatus.NOT_FOUND, "Unsupported master data type");
        };
    }

    private boolean hasSystemNo(String type) {
        return switch (type) {
            case "product", "customer", "supplier", "warehouse", "productionDepartment" -> true;
            default -> false;
        };
    }

    private String required(Map<String, String> payload, String field) {
        var value = payload.getOrDefault(field, "").trim();
        if (value.isBlank()) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, field + " is required");
        }
        return value;
    }

    private String optional(Map<String, String> payload, String field) {
        var value = payload.getOrDefault(field, "").trim();
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
