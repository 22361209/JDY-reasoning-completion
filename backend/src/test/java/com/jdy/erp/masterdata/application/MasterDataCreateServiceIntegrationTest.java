package com.jdy.erp.masterdata.application;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.math.BigDecimal;
import java.util.Map;

import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.server.ResponseStatusException;

@SpringBootTest
@Transactional
class MasterDataCreateServiceIntegrationTest {
    @Autowired
    private MasterDataCreateService service;

    @Autowired
    private MasterDataImportDefinitionRegistry importDefinitions;

    @Autowired
    private JdbcTemplate jdbcTemplate;

    @Test
    void manualCreateKeepsExistingContractsForEightImportTypesAndProductionDepartment() {
        var suffix = suffix();
        var categoryCode = "LB-A143-" + suffix;
        var unitCode = "DW-A143-" + suffix;
        var customerCode = "KH-A143-" + suffix;
        var supplierCode = "GYS-A143-" + suffix;
        var warehouseCode = "CK-A143-" + suffix;
        var employeeCode = "YG-A143-" + suffix;
        var accountCode = "ZH-A143-" + suffix;
        var departmentCode = "BM-A143-" + suffix;
        var productCode = "CP-A143-" + suffix;

        assertThat(service.create("productCategory", Map.of(
            "code", categoryCode,
            "name", "A143 类别 " + suffix
        ))).containsEntry("code", categoryCode);
        assertThat(service.create("unit", Map.of("code", unitCode)))
            .containsEntry("code", unitCode)
            .containsEntry("name", unitCode);
        assertThat(service.create("customer", Map.of("code", customerCode, "name", "A143 客户")))
            .containsEntry("code", customerCode);
        assertThat(service.create("supplier", Map.of("code", supplierCode, "name", "A143 供应商")))
            .containsEntry("code", supplierCode);
        assertThat(service.create("warehouse", Map.of("code", warehouseCode, "name", "A143 仓库")))
            .containsEntry("code", warehouseCode);
        assertThat(service.create("employee", Map.of("code", employeeCode, "name", "A143 员工")))
            .containsEntry("version", 0L)
            .containsEntry("auditStatus", "未审核")
            .containsEntry("status", "启用");
        assertThat(service.create("financialAccount", Map.of(
            "code", accountCode,
            "name", "A143 现金账户",
            "accountType", "CASH",
            "currency", "USD"
        )))
            .containsEntry("version", 0L)
            .containsEntry("currency", "USD")
            .containsEntry("auditStatus", "未审核");
        assertThat(service.create("productionDepartment", Map.of(
            "code", departmentCode,
            "name", "A143 生产部门"
        )))
            .containsEntry("code", departmentCode)
            .containsEntry("auditStatus", "草稿");

        var reference = auditedCategoryAndUnit();
        maintainAuditedProductName("A143 手工物料");
        assertThat(service.create("product", Map.of(
            "code", productCode,
            "name", "A143 手工物料",
            "category", String.valueOf(reference.get("category_name")),
            "unit", String.valueOf(reference.get("unit_code"))
        ))).containsEntry("code", productCode);

        assertThat(jdbcTemplate.queryForMap("""
            SELECT customer_level, settlement_method, enabled, audit_status, version
            FROM md_customer
            WHERE code = ?
            """, customerCode))
            .containsEntry("customer_level", "普通客户")
            .containsEntry("settlement_method", "月结")
            .containsEntry("enabled", true)
            .containsEntry("audit_status", "DRAFT")
            .containsEntry("version", 0L);
        assertThat(jdbcTemplate.queryForMap("""
            SELECT warehouse_type, allow_negative_stock, enabled, audit_status, version
            FROM md_warehouse
            WHERE code = ?
            """, warehouseCode))
            .containsEntry("warehouse_type", "普通仓")
            .containsEntry("allow_negative_stock", false)
            .containsEntry("enabled", true)
            .containsEntry("audit_status", "DRAFT")
            .containsEntry("version", 0L);
        assertThat(jdbcTemplate.queryForMap("""
            SELECT is_purchase, is_sale, is_inventory, is_produce, is_subcontract, tax_rate, enabled, audit_status, version
            FROM md_product
            WHERE code = ?
            """, productCode))
            .containsEntry("is_purchase", false)
            .containsEntry("is_sale", false)
            .containsEntry("is_inventory", true)
            .containsEntry("is_produce", false)
            .containsEntry("is_subcontract", false)
            .containsEntry("enabled", true)
            .containsEntry("audit_status", "DRAFT")
            .containsEntry("version", 0L);
    }

    @Test
    void validateCreateIsWriteFreeDoesNotConsumeSystemNumberAndDetectsExistingCode() {
        var code = "KH-A143-VALIDATE-" + suffix();
        var sequenceBefore = jdbcTemplate.queryForObject(
            "SELECT last_value FROM md_customer_system_no_seq",
            Long.class
        );

        var validated = service.validateCreate("customer", Map.of("code", code, "name", "只校验客户"));

        assertThat(validated)
            .extracting(
                MasterDataCreateService.ValidatedCreate::type,
                MasterDataCreateService.ValidatedCreate::code,
                MasterDataCreateService.ValidatedCreate::name,
                MasterDataCreateService.ValidatedCreate::enabled
            )
            .containsExactly("customer", code, "只校验客户", true);
        assertThat(jdbcTemplate.queryForObject(
            "SELECT COUNT(*) FROM md_customer WHERE code = ?",
            Long.class,
            code
        )).isZero();
        assertThat(jdbcTemplate.queryForObject(
            "SELECT last_value FROM md_customer_system_no_seq",
            Long.class
        )).isEqualTo(sequenceBefore);
        assertThatThrownBy(() -> validated.normalizedPayload().put("name", "不可修改"))
            .isInstanceOf(UnsupportedOperationException.class);

        service.create("customer", Map.of("code", code, "name", "已创建客户"));
        assertThatThrownBy(() -> service.validateCreate("customer", Map.of("code", code, "name", "重复客户")))
            .isInstanceOf(ResponseStatusException.class)
            .satisfies(exception -> assertThat(((ResponseStatusException) exception).getStatusCode())
                .isEqualTo(HttpStatus.CONFLICT));
    }

    @Test
    void importStrictUsesCodesOnlyAndAppliesCallerOwnedExplicitDefaults() {
        var reference = auditedCategoryAndUnit();
        var categoryCode = String.valueOf(reference.get("category_code"));
        var categoryName = String.valueOf(reference.get("category_name"));
        var unitCode = String.valueOf(reference.get("unit_code"));
        var code = "CP-A143-STRICT-" + suffix();
        maintainAuditedProductName("A143 严格导入物料");
        var basePayload = Map.of(
            "code", code,
            "name", "A143 严格导入物料",
            "category", categoryName,
            "unit", unitCode
        );

        assertThat(service.validateCreate("product", basePayload).code()).isEqualTo(code);
        assertThatThrownBy(() -> service.validateCreate(
            "product",
            basePayload,
            MasterDataCreateService.CreateOptions.importStrict(Map.of())
        ))
            .isInstanceOf(ResponseStatusException.class)
            .satisfies(exception -> assertThat(((ResponseStatusException) exception).getStatusCode())
                .isEqualTo(HttpStatus.BAD_REQUEST));

        var defaults = importDefinitions.require("product").defaults();
        var strictPayload = Map.of(
            "code", code,
            "name", "A143 严格导入物料",
            "category", categoryCode,
            "unit", unitCode,
            "isSale", ""
        );
        var options = MasterDataCreateService.CreateOptions.importStrict(defaults);
        var validated = service.validateCreate("product", strictPayload, options);
        assertThat(validated.normalizedPayload())
            .containsEntry("isSale", "是")
            .containsEntry("isProduce", "是")
            .containsEntry("taxRate", "13")
            .containsEntry("productType", "普通")
            .containsEntry("issueMethod", "按单领料");

        service.create("product", strictPayload, options);
        var row = jdbcTemplate.queryForMap("""
            SELECT category_ref.code AS category_code,
                   unit_ref.code AS unit_code,
                   product.is_purchase,
                   product.is_sale,
                   product.is_inventory,
                   product.is_produce,
                   product.is_subcontract,
                   product.tax_rate,
                   product.enabled,
                   product.audit_status,
                   product.version
            FROM md_product product
            JOIN md_product_category category_ref ON category_ref.id = product.product_category_id
            JOIN md_unit unit_ref ON unit_ref.id = product.unit_id
            WHERE product.code = ?
            """, code);
        assertThat(row)
            .containsEntry("category_code", categoryCode)
            .containsEntry("unit_code", unitCode)
            .containsEntry("is_purchase", false)
            .containsEntry("is_sale", true)
            .containsEntry("is_inventory", true)
            .containsEntry("is_produce", true)
            .containsEntry("is_subcontract", false)
            .containsEntry("enabled", true)
            .containsEntry("audit_status", "DRAFT")
            .containsEntry("version", 0L);
        assertThat((BigDecimal) row.get("tax_rate")).isEqualByComparingTo("13");
    }

    @Test
    void unsupportedTypeFailsBeforeAnyDatabaseWrite() {
        assertThatThrownBy(() -> service.create("productionDepartmentImport", Map.of(
            "code", "NOPE",
            "name", "不支持"
        )))
            .isInstanceOf(ResponseStatusException.class)
            .satisfies(exception -> assertThat(((ResponseStatusException) exception).getStatusCode())
                .isEqualTo(HttpStatus.NOT_FOUND));
    }

    private Map<String, Object> auditedCategoryAndUnit() {
        return jdbcTemplate.queryForMap("""
            SELECT category.code AS category_code,
                   category.name AS category_name,
                   unit_ref.code AS unit_code
            FROM md_product_category category
            CROSS JOIN LATERAL (
                SELECT code
                FROM md_unit
                WHERE enabled = TRUE
                  AND audit_status = 'AUDITED'
                ORDER BY code
                LIMIT 1
            ) unit_ref
            WHERE category.enabled = TRUE
              AND category.audit_status = 'AUDITED'
              AND category.code <> category.name
              AND NOT EXISTS (
                  SELECT 1
                  FROM md_product_category category_code_collision
                  WHERE category_code_collision.code = category.name
              )
            ORDER BY category.code
            LIMIT 1
            """);
    }

    private String suffix() {
        return Long.toUnsignedString(System.nanoTime(), 36).toUpperCase();
    }

    private void maintainAuditedProductName(String name) {
        jdbcTemplate.update("""
            INSERT INTO md_product_name (code, name, enabled, audit_status)
            VALUES (?, ?, TRUE, 'AUDITED')
            ON CONFLICT (name) DO UPDATE
            SET enabled = TRUE,
                audit_status = 'AUDITED'
            """, "PN-A143-" + suffix(), name);
    }
}
