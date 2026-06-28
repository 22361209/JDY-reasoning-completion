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
        return setEnabled(type, code, false);
    }

    private Map<String, Object> createProduct(String code, String name, Map<String, String> payload, boolean enabled) {
        var unit = required(payload, "unit");
        return jdbcTemplate.queryForMap("""
            INSERT INTO md_product (
                code, name, short_name, barcode, brand, spec, category, product_type, unit, net_weight, gross_weight,
                oe_no, position_name, surface_treatment,
                is_purchase, is_sale, is_inventory, is_produce, is_subcontract,
                default_warehouse_code, default_workshop, sale_unit, purchase_unit, bom_unit, default_supplier_code, issue_warehouse_code, issue_method,
                tax_rate, default_sale_price, cost_price, min_sale_price, purchase_price, max_purchase_price, subcontract_price, wholesale_price, retail_price,
                min_stock_qty, safety_stock_qty, max_stock_qty, remark, enabled
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            RETURNING id::text AS id, system_no::text AS "systemNo", code, name
            """,
            code,
            name,
            optional(payload, "shortName"),
            optional(payload, "barcode"),
            optional(payload, "brand"),
            payload.getOrDefault("spec", ""),
            payload.getOrDefault("category", "成品总成"),
            payload.getOrDefault("productType", "普通"),
            unit,
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
            optional(payload, "defaultWarehouseCode"),
            optional(payload, "defaultWorkshop"),
            payload.getOrDefault("saleUnit", unit),
            payload.getOrDefault("purchaseUnit", unit),
            payload.getOrDefault("bomUnit", unit),
            optional(payload, "defaultSupplierCode"),
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
        var unit = required(payload, "unit");
        return updateAndReturn("""
            UPDATE md_product
            SET name = ?, short_name = ?, barcode = ?, brand = ?, spec = ?, category = ?, product_type = ?, unit = ?, net_weight = ?, gross_weight = ?,
                oe_no = ?, position_name = ?, surface_treatment = ?,
                is_purchase = ?, is_sale = ?, is_inventory = ?, is_produce = ?, is_subcontract = ?,
                default_warehouse_code = ?, default_workshop = ?, sale_unit = ?, purchase_unit = ?, bom_unit = ?, default_supplier_code = ?, issue_warehouse_code = ?, issue_method = ?,
                tax_rate = ?, default_sale_price = ?, cost_price = ?, min_sale_price = ?, purchase_price = ?, max_purchase_price = ?, subcontract_price = ?,
                wholesale_price = ?, retail_price = ?, min_stock_qty = ?, safety_stock_qty = ?, max_stock_qty = ?, remark = ?,
                enabled = ?, audit_status = 'DRAFT', updated_at = now(), version = version + 1
            WHERE code = ?
            RETURNING id::text AS id, system_no::text AS "systemNo", code, name
            """,
            name,
            optional(payload, "shortName"),
            optional(payload, "barcode"),
            optional(payload, "brand"),
            payload.getOrDefault("spec", ""),
            payload.getOrDefault("category", "成品总成"),
            payload.getOrDefault("productType", "普通"),
            unit,
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
            optional(payload, "defaultWarehouseCode"),
            optional(payload, "defaultWorkshop"),
            payload.getOrDefault("saleUnit", unit),
            payload.getOrDefault("purchaseUnit", unit),
            payload.getOrDefault("bomUnit", unit),
            optional(payload, "defaultSupplierCode"),
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
        var table = tableName(type);
        return updateAndReturn("UPDATE " + table + " SET enabled = ?, updated_at = now(), version = version + 1 WHERE code = ? RETURNING " + returningFor(type),
            enabled,
            code
        );
    }

    private Map<String, Object> setAuditStatus(String type, String code, String auditStatus) {
        var table = tableName(type);
        return updateAndReturn("UPDATE " + table + " SET audit_status = ?, updated_at = now(), version = version + 1 WHERE code = ? RETURNING " + returningFor(type),
            auditStatus,
            code
        );
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
