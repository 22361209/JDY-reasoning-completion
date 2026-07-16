package com.jdy.erp.masterdata.application;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.math.BigDecimal;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.jdy.erp.masterdata.api.MasterDataController;
import com.jdy.erp.system.application.AccountSetManagementService;
import com.jdy.erp.system.security.CurrentSessionService;
import com.jdy.erp.system.tenant.TenantContext;
import com.jdy.erp.system.tenant.TenantDataSourceRegistry;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.mock.web.MockHttpServletRequest;
import org.springframework.transaction.annotation.Propagation;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.context.request.RequestContextHolder;
import org.springframework.web.context.request.ServletRequestAttributes;
import org.springframework.web.server.ResponseStatusException;

@SpringBootTest
@Transactional
class MasterDataPatchServiceIntegrationTest {
    @Autowired
    private MasterDataPatchService service;

    @Autowired
    private MasterDataController controller;

    @Autowired
    private JdbcTemplate jdbcTemplate;

    @Autowired
    private ObjectMapper objectMapper;

    @Autowired
    private AccountSetManagementService accountSetManagementService;

    @Autowired
    private CurrentSessionService currentSessionService;

    @Autowired
    @Qualifier("platformJdbcTemplate")
    private JdbcTemplate platformJdbcTemplate;

    @Autowired
    private TenantDataSourceRegistry tenantDataSourceRegistry;

    @Test
    void sparsePatchPreservesEveryUndeclaredColumnForAllFourTypes() {
        var suffix = suffix();
        var productCode = "CP-A138-" + suffix;
        controller.create("product", Map.ofEntries(
            Map.entry("code", productCode),
            Map.entry("name", "A138 物料"),
            Map.entry("category", "成品总成"),
            Map.entry("unit", "只"),
            Map.entry("shortName", "旧简称"),
            Map.entry("barcode", "BAR-" + suffix),
            Map.entry("brand", "旧品牌"),
            Map.entry("spec", "旧规格"),
            Map.entry("defaultWarehouseCode", "CK-001"),
            Map.entry("defaultSupplierCode", "GYS-001"),
            Map.entry("defaultWorkshop", "CY"),
            Map.entry("defaultSalePrice", "12.34"),
            Map.entry("drawingFileName", "old.pdf"),
            Map.entry("drawingFileData", "old-pdf-data"),
            Map.entry("imageFileNames", "old.png"),
            Map.entry("imageFileData", "old-image-data"),
            Map.entry("remark", "旧备注")
        ));
        var productResult = assertOnlyChanged(
            "product", "md_product", productCode, "remark", "remark", text("新备注")
        );
        assertThat(productResult.body())
            .containsEntry("code", productCode)
            .containsEntry("remark", "新备注")
            .containsKeys("id", "systemNo", "name", "version", "auditStatus", "status", "defaultSalePrice", "drawingFileName");

        var customerCode = "KH-A138-" + suffix;
        controller.create("customer", Map.ofEntries(
            Map.entry("code", customerCode),
            Map.entry("name", "A138 客户"),
            Map.entry("contact", "旧联系人"),
            Map.entry("phone", "13800000000"),
            Map.entry("region", "广东广州"),
            Map.entry("address", "旧地址"),
            Map.entry("creditLimit", "88.00"),
            Map.entry("remark", "旧备注")
        ));
        var customerResult = assertOnlyChanged(
            "customer", "md_customer", customerCode, "contact", "contact", text("新联系人")
        );
        assertThat(customerResult.body())
            .containsEntry("contact", "新联系人")
            .containsKeys("id", "systemNo", "code", "name", "version", "auditStatus", "status", "creditLimit");

        var supplierCode = "GYS-A138-" + suffix;
        controller.create("supplier", Map.ofEntries(
            Map.entry("code", supplierCode),
            Map.entry("name", "A138 供应商"),
            Map.entry("contact", "旧联系人"),
            Map.entry("phone", "13900000000"),
            Map.entry("address", "旧地址"),
            Map.entry("bankAccount", "旧账户"),
            Map.entry("remark", "旧备注")
        ));
        var supplierResult = assertOnlyChanged(
            "supplier", "md_supplier", supplierCode, "address", "address", text("新地址")
        );
        assertThat(supplierResult.body())
            .containsEntry("address", "新地址")
            .containsKeys("id", "systemNo", "code", "name", "version", "auditStatus", "status", "bankAccount");

        var warehouseCode = "CK-A138-" + suffix;
        controller.create("warehouse", Map.ofEntries(
            Map.entry("code", warehouseCode),
            Map.entry("name", "A138 仓库"),
            Map.entry("warehouseType", "成品仓"),
            Map.entry("manager", "旧仓管"),
            Map.entry("phone", "13700000000"),
            Map.entry("address", "旧地址"),
            Map.entry("stockPolicy", "不允许负库存"),
            Map.entry("remark", "旧备注")
        ));
        var warehouseResult = assertOnlyChanged(
            "warehouse", "md_warehouse", warehouseCode, "manager", "manager", text("新仓管")
        );
        assertThat(warehouseResult.body())
            .containsEntry("manager", "新仓管")
            .containsEntry("stockPolicy", "不允许负库存")
            .containsKeys("id", "systemNo", "code", "name", "version", "auditStatus", "status");
    }

    @Test
    void explicitNullClearsNullableFieldWhileZeroAndFalseRemainRealValues() {
        var suffix = suffix();
        var customerCode = "KH-A138-N-" + suffix;
        controller.create("customer", Map.of(
            "code", customerCode,
            "name", "A138 可清空客户",
            "address", "待清空地址"
        ));
        var customerVersion = version("md_customer", customerCode);
        service.patch("customer", customerCode, customerVersion, changes("address", null));
        assertThat(jdbcTemplate.queryForObject(
            "SELECT address FROM md_customer WHERE code = ?",
            String.class,
            customerCode
        )).isNull();

        var productCode = "CP-A138-Z-" + suffix;
        controller.create("product", Map.ofEntries(
            Map.entry("code", productCode),
            Map.entry("name", "A138 零值物料"),
            Map.entry("category", "成品总成"),
            Map.entry("unit", "只"),
            Map.entry("isSale", "true"),
            Map.entry("defaultSalePrice", "9.99")
        ));
        var productVersion = version("md_product", productCode);
        var result = service.patch("product", productCode, productVersion, changes(
            "isSale", false,
            "defaultSalePrice", BigDecimal.ZERO
        ));
        var row = jdbcTemplate.queryForMap(
            "SELECT is_sale, default_sale_price FROM md_product WHERE code = ?",
            productCode
        );
        assertThat(row).containsEntry("is_sale", false);
        assertThat((BigDecimal) row.get("default_sale_price")).isEqualByComparingTo(BigDecimal.ZERO);
        assertThat(result.body())
            .containsEntry("isSale", "否")
            .containsEntry("defaultSalePrice", "0.00");
    }

    @Test
    void unitAndProductionDepartmentUseSparsePatchWithVersionAndLifecycleGuards() {
        var suffix = suffix();
        var unitCode = "UNIT-A160-" + suffix;
        controller.create("unit", Map.ofEntries(
            Map.entry("code", unitCode),
            Map.entry("decimalPlaces", "2"),
            Map.entry("sortNo", "7"),
            Map.entry("remark", "单位原备注")
        ));
        var unitBefore = row("md_unit", unitCode);
        var unitVersion = ((Number) unitBefore.get("version")).longValue();
        service.patch("unit", unitCode, unitVersion, changes("decimalPlaces", 3));
        var unitAfter = row("md_unit", unitCode);
        assertThat(unitAfter.get("decimal_places")).isEqualTo(3);
        assertThat(unitAfter.get("sort_no")).isEqualTo(unitBefore.get("sort_no"));
        assertThat(unitAfter.get("remark")).isEqualTo(unitBefore.get("remark"));
        assertThat(unitAfter.get("version")).isEqualTo(unitVersion + 1);
        assertStatus(HttpStatus.CONFLICT, () -> service.patch("unit", unitCode, unitVersion, changes("sortNo", 8)));
        assertThat(row("md_unit", unitCode)).isEqualTo(unitAfter);
        assertStatus(HttpStatus.BAD_REQUEST, () -> service.patch(
            "unit", unitCode, unitVersion + 1, changes("decimalPlaces", 1.5)
        ));

        var departmentCode = "DEPT-A160-" + suffix;
        controller.create("productionDepartment", Map.ofEntries(
            Map.entry("code", departmentCode),
            Map.entry("name", "A160 生产部门"),
            Map.entry("manager", "原负责人"),
            Map.entry("remark", "部门原备注")
        ));
        var departmentBefore = row("md_production_department", departmentCode);
        var departmentVersion = ((Number) departmentBefore.get("version")).longValue();
        service.patch("productionDepartment", departmentCode, departmentVersion, changes("manager", "新负责人"));
        var departmentAfter = row("md_production_department", departmentCode);
        assertThat(departmentAfter.get("manager")).isEqualTo("新负责人");
        assertThat(departmentAfter.get("name")).isEqualTo(departmentBefore.get("name"));
        assertThat(departmentAfter.get("remark")).isEqualTo(departmentBefore.get("remark"));
        assertThat(departmentAfter.get("version")).isEqualTo(departmentVersion + 1);

        controller.audit("productionDepartment", departmentCode);
        var auditedVersion = version("md_production_department", departmentCode);
        assertStatus(HttpStatus.CONFLICT, () -> service.patch(
            "productionDepartment", departmentCode, auditedVersion, changes("manager", "不应写入")
        ));
        assertThat(version("md_production_department", departmentCode)).isEqualTo(auditedVersion);
    }

    @Test
    void rejectsUnknownRequiredLifecycleAndWrongJsonTypesWithoutChangingRow() {
        var code = "KH-A138-BAD-" + suffix();
        controller.create("customer", Map.of(
            "code", code,
            "name", "A138 校验客户",
            "remark", "保持"
        ));
        var before = row("md_customer", code);
        var currentVersion = ((Number) before.get("version")).longValue();

        assertStatus(HttpStatus.BAD_REQUEST, () -> service.patch(
            "customer", code, currentVersion, changes("unknownField", "x")
        ));
        assertStatus(HttpStatus.BAD_REQUEST, () -> service.patch(
            "customer", code, currentVersion, changes("name", null)
        ));
        assertStatus(HttpStatus.BAD_REQUEST, () -> service.patch(
            "customer", code, currentVersion, changes("status", "禁用")
        ));
        assertStatus(HttpStatus.BAD_REQUEST, () -> service.patch(
            "customer", code, currentVersion, changes("version", 99)
        ));

        var productCode = "CP-A138-TYPE-" + suffix();
        controller.create("product", Map.of(
            "code", productCode,
            "name", "A138 类型物料",
            "category", "成品总成",
            "unit", "只"
        ));
        var productVersion = version("md_product", productCode);
        assertStatus(HttpStatus.BAD_REQUEST, () -> service.patch(
            "product", productCode, productVersion, changes("isSale", "true")
        ));
        assertStatus(HttpStatus.BAD_REQUEST, () -> service.patch(
            "product", productCode, productVersion, changes("taxRate", "13")
        ));

        assertThat(row("md_customer", code)).isEqualTo(before);
        assertThat(version("md_product", productCode)).isEqualTo(productVersion);
    }

    @Test
    void allFourTypesRejectUnknownRequiredAndLifecycleFieldsWithoutVersionChange() {
        var suffix = suffix();
        var productCode = "CP-A138-NEG-" + suffix;
        controller.create("product", Map.of(
            "code", productCode,
            "name", "A138 负向物料",
            "category", "成品总成",
            "unit", "只"
        ));
        var customerCode = "KH-A138-NEG-" + suffix;
        controller.create("customer", Map.of("code", customerCode, "name", "A138 负向客户"));
        var supplierCode = "GYS-A138-NEG-" + suffix;
        controller.create("supplier", Map.of("code", supplierCode, "name", "A138 负向供应商"));
        var warehouseCode = "CK-A138-NEG-" + suffix;
        controller.create("warehouse", Map.of("code", warehouseCode, "name", "A138 负向仓库"));

        for (var target : List.of(
            new PatchTarget("product", "md_product", productCode),
            new PatchTarget("customer", "md_customer", customerCode),
            new PatchTarget("supplier", "md_supplier", supplierCode),
            new PatchTarget("warehouse", "md_warehouse", warehouseCode)
        )) {
            var currentVersion = version(target.table(), target.code());
            assertStatus(HttpStatus.BAD_REQUEST, () -> service.patch(
                target.type(), target.code(), currentVersion, changes("unknownField", "x")
            ));
            assertStatus(HttpStatus.BAD_REQUEST, () -> service.patch(
                target.type(), target.code(), currentVersion, changes("name", null)
            ));
            assertStatus(HttpStatus.BAD_REQUEST, () -> service.patch(
                target.type(), target.code(), currentVersion, changes("status", "禁用")
            ));
            assertThat(version(target.table(), target.code())).isEqualTo(currentVersion);
        }
    }

    @Test
    void staleAuditedAndMissingRowsReturnTheirRealStatuses() {
        var staleCode = "GYS-A138-STALE-" + suffix();
        controller.create("supplier", Map.of("code", staleCode, "name", "A138 并发供应商"));
        var staleVersion = version("md_supplier", staleCode);
        service.patch("supplier", staleCode, staleVersion, changes("remark", "先保存"));
        assertStatus(HttpStatus.CONFLICT, () -> service.patch(
            "supplier", staleCode, staleVersion, changes("remark", "后保存")
        ));
        assertThat(jdbcTemplate.queryForObject(
            "SELECT remark FROM md_supplier WHERE code = ?",
            String.class,
            staleCode
        )).isEqualTo("先保存");

        var auditedCode = "CK-A138-AUD-" + suffix();
        controller.create("warehouse", Map.of("code", auditedCode, "name", "A138 已审核仓库"));
        jdbcTemplate.update("UPDATE md_warehouse SET audit_status = 'AUDITED' WHERE code = ?", auditedCode);
        var auditedVersion = version("md_warehouse", auditedCode);
        assertStatus(HttpStatus.CONFLICT, () -> service.patch(
            "warehouse", auditedCode, auditedVersion, changes("remark", "不应写入")
        ));
        assertThat(version("md_warehouse", auditedCode)).isEqualTo(auditedVersion);

        assertStatus(HttpStatus.NOT_FOUND, () -> service.patch(
            "customer", "KH-A138-NOT-FOUND", 0, changes("remark", "x")
        ));
    }

    @Test
    void productReferencesUpdateInPairsAndInvalidReferenceRollsBackWholePatch() {
        var code = "CP-A138-REF-" + suffix();
        controller.create("product", Map.ofEntries(
            Map.entry("code", code),
            Map.entry("name", "A138 引用物料"),
            Map.entry("category", "成品总成"),
            Map.entry("unit", "只"),
            Map.entry("defaultWarehouseCode", "CK-001"),
            Map.entry("defaultSupplierCode", "GYS-001")
        ));
        var firstVersion = version("md_product", code);
        service.patch("product", code, firstVersion, changes(
            "defaultWarehouseCode", "CK-002",
            "defaultSupplierCode", null
        ));
        var references = jdbcTemplate.queryForMap("""
            SELECT product.default_warehouse_code,
                   warehouse.code AS warehouse_code,
                   product.default_supplier_code,
                   product.default_supplier_id
            FROM md_product product
            LEFT JOIN md_warehouse warehouse ON warehouse.id = product.default_warehouse_id
            WHERE product.code = ?
            """, code);
        assertThat(references)
            .containsEntry("default_warehouse_code", "CK-002")
            .containsEntry("warehouse_code", "CK-002");
        assertThat(references.get("default_supplier_code")).isNull();
        assertThat(references.get("default_supplier_id")).isNull();

        var beforeInvalidPatch = row("md_product", code);
        var secondVersion = ((Number) beforeInvalidPatch.get("version")).longValue();
        var invalidChanges = new LinkedHashMap<String, JsonNode>();
        invalidChanges.put("name", text("不应留下的新名称"));
        invalidChanges.put("defaultWarehouseCode", text("不存在仓库"));
        assertStatus(HttpStatus.BAD_REQUEST, () -> service.patch(
            "product", code, secondVersion, invalidChanges
        ));
        assertThat(row("md_product", code)).isEqualTo(beforeInvalidPatch);
    }

    @Test
    void warehouseStockPolicyReturnsTheCanonicalBusinessLabel() {
        var code = "CK-A138-POL-" + suffix();
        controller.create("warehouse", Map.of(
            "code", code,
            "name", "A138 策略仓库",
            "stockPolicy", "不允许负库存"
        ));
        var result = service.patch(
            "warehouse",
            code,
            version("md_warehouse", code),
            changes("stockPolicy", "允许负库存")
        );
        assertThat(result.body()).containsEntry("stockPolicy", "允许负库存");
        assertThat(jdbcTemplate.queryForObject(
            "SELECT allow_negative_stock FROM md_warehouse WHERE code = ?",
            Boolean.class,
            code
        )).isTrue();
    }

    @Test
    @Transactional(propagation = Propagation.NOT_SUPPORTED)
    void sparsePatchUsesOnlyTheCurrentTenantSchema() {
        var suffix = suffix();
        var accountSetCode = "A138ISO-" + suffix.substring(0, Math.min(8, suffix.length()));
        var recordCode = "KH-A138-ISO-" + suffix;
        String schemaName = null;
        try {
            useTenant("BLD-TEST");
            @SuppressWarnings("unchecked")
            var accountSet = (Map<String, Object>) accountSetManagementService.createAccountSet(
                new AccountSetManagementService.AccountSetCreateRequest(
                    accountSetCode,
                    accountSetCode + " 隔离账套",
                    "测试",
                    null,
                    null,
                    null,
                    null,
                    "2026-06",
                    "2026-06"
                )
            ).get("accountSet");
            schemaName = String.valueOf(accountSet.get("schemaName"));

            useTenant("BLD-TEST");
            controller.create("customer", Map.of("code", recordCode, "name", "public 原值"));

            useTenant(accountSetCode);
            controller.create("customer", Map.of("code", recordCode, "name", "tenant 原值"));
            var tenantVersion = version("md_customer", recordCode);
            var body = objectMapper.createObjectNode();
            body.put("version", tenantVersion);
            body.set("changes", objectMapper.createObjectNode().put("name", "tenant 新值"));
            controller.patch("customer", recordCode, body);
            assertThat(jdbcTemplate.queryForObject(
                "SELECT name FROM md_customer WHERE code = ?",
                String.class,
                recordCode
            )).isEqualTo("tenant 新值");

            useTenant("BLD-TEST");
            assertThat(jdbcTemplate.queryForObject(
                "SELECT name FROM md_customer WHERE code = ?",
                String.class,
                recordCode
            )).isEqualTo("public 原值");
        } finally {
            TenantContext.clear();
            RequestContextHolder.resetRequestAttributes();
            tenantDataSourceRegistry.close();
            platformJdbcTemplate.update("DELETE FROM public.md_customer WHERE code = ?", recordCode);
            if (schemaName != null && schemaName.matches("[a-z][a-z0-9_]{0,62}")) {
                platformJdbcTemplate.execute("DROP SCHEMA IF EXISTS \"" + schemaName + "\" CASCADE");
            }
            platformJdbcTemplate.update("""
                DELETE FROM public.sys_user_account_set
                WHERE account_set_id IN (SELECT id FROM public.sys_account_set WHERE code = ?)
                """, accountSetCode);
            platformJdbcTemplate.update("DELETE FROM public.sys_account_set WHERE code = ?", accountSetCode);
            platformJdbcTemplate.update("DELETE FROM public.sys_operation_log WHERE target_no = ?", accountSetCode);
        }
    }

    private MasterDataPatchService.PatchResult assertOnlyChanged(
        String type,
        String table,
        String code,
        String apiField,
        String databaseColumn,
        JsonNode value
    ) {
        var before = row(table, code);
        var beforeVersion = ((Number) before.get("version")).longValue();
        var result = service.patch(type, code, beforeVersion, Map.of(apiField, value));
        var after = row(table, code);
        assertThat(((Number) after.get("version")).longValue()).isEqualTo(beforeVersion + 1);

        var expectedUnchanged = new LinkedHashMap<>(before);
        var actualUnchanged = new LinkedHashMap<>(after);
        for (var ignored : new String[] {databaseColumn, "version", "updated_at"}) {
            expectedUnchanged.remove(ignored);
            actualUnchanged.remove(ignored);
        }
        assertThat(actualUnchanged).isEqualTo(expectedUnchanged);
        return result;
    }

    private Map<String, Object> row(String table, String code) {
        if (!SetOfTables.SUPPORTED.containsKey(table)) {
            throw new IllegalArgumentException("unsupported test table");
        }
        return jdbcTemplate.queryForMap("SELECT * FROM " + table + " WHERE code = ?", code);
    }

    private long version(String table, String code) {
        return jdbcTemplate.queryForObject(
            "SELECT version FROM " + table + " WHERE code = ?",
            Long.class,
            code
        );
    }

    private LinkedHashMap<String, JsonNode> changes(Object... pairs) {
        var changes = new LinkedHashMap<String, JsonNode>();
        for (var index = 0; index < pairs.length; index += 2) {
            changes.put(String.valueOf(pairs[index]), objectMapper.valueToTree(pairs[index + 1]));
        }
        return changes;
    }

    private JsonNode text(String value) {
        return objectMapper.valueToTree(value);
    }

    private void assertStatus(HttpStatus status, Runnable action) {
        assertThatThrownBy(action::run)
            .isInstanceOf(ResponseStatusException.class)
            .satisfies(exception -> assertThat(((ResponseStatusException) exception).getStatusCode()).isEqualTo(status));
    }

    private String suffix() {
        return Long.toUnsignedString(System.nanoTime(), 36).toUpperCase();
    }

    private void useTenant(String accountSetCode) {
        TenantContext.clear();
        RequestContextHolder.resetRequestAttributes();
        RequestContextHolder.setRequestAttributes(new ServletRequestAttributes(new MockHttpServletRequest()));
        currentSessionService.login("admin", "admin123", accountSetCode);
        TenantContext.setTenant(currentSessionService.currentAccountSet());
    }

    private static final class SetOfTables {
        private static final Map<String, Boolean> SUPPORTED = Map.of(
            "md_product", true,
            "md_customer", true,
            "md_supplier", true,
            "md_warehouse", true,
            "md_unit", true,
            "md_production_department", true
        );

        private SetOfTables() {
        }
    }

    private record PatchTarget(String type, String table, String code) {
    }
}
