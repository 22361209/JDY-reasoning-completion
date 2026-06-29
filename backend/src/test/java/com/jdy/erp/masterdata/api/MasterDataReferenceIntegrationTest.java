package com.jdy.erp.masterdata.api;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

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
class MasterDataReferenceIntegrationTest {
    @Autowired
    private MasterDataController controller;

    @Autowired
    private JdbcTemplate jdbcTemplate;

    @Test
    void productStoresAuditedEnabledMasterReferencesAndProtectsReferencedMasters() {
        var code = "CP-REF-" + System.nanoTime();

        controller.create("product", Map.ofEntries(
            Map.entry("code", code),
            Map.entry("name", code),
            Map.entry("category", "成品总成"),
            Map.entry("unit", "只"),
            Map.entry("defaultWarehouseCode", "CK-001"),
            Map.entry("defaultSupplierCode", "GYS-001"),
            Map.entry("defaultWorkshop", "生产部"),
            Map.entry("isSale", "true"),
            Map.entry("isInventory", "true"),
            Map.entry("isProduce", "true")
        ));

        var row = jdbcTemplate.queryForMap("""
            SELECT category.name AS category_name,
                   unit_ref.code AS unit_code,
                   warehouse.code AS warehouse_code,
                   supplier.code AS supplier_code,
                   department.name AS workshop_name
            FROM md_product product
            JOIN md_product_category category ON category.id = product.product_category_id
            JOIN md_unit unit_ref ON unit_ref.id = product.unit_id
            LEFT JOIN md_warehouse warehouse ON warehouse.id = product.default_warehouse_id
            LEFT JOIN md_supplier supplier ON supplier.id = product.default_supplier_id
            LEFT JOIN md_production_department department ON department.id = product.default_workshop_id
            WHERE product.code = ?
            """, code);

        assertThat(row)
            .containsEntry("category_name", "成品总成")
            .containsEntry("unit_code", "只")
            .containsEntry("warehouse_code", "CK-001")
            .containsEntry("supplier_code", "GYS-001")
            .containsEntry("workshop_name", "生产部");

        controller.audit("product", code);

        assertThatThrownBy(() -> controller.updateStatus("unit", "只", Map.of("status", "禁用")))
            .isInstanceOf(ResponseStatusException.class)
            .extracting(ex -> ((ResponseStatusException) ex).getStatusCode())
            .isEqualTo(HttpStatus.CONFLICT);
        assertThatThrownBy(() -> controller.reverseAudit("unit", "只"))
            .isInstanceOf(ResponseStatusException.class)
            .extracting(ex -> ((ResponseStatusException) ex).getStatusCode())
            .isEqualTo(HttpStatus.CONFLICT);
    }

    @Test
    void productRejectsMissingOrInactiveMasterReferencesBeforeInsert() {
        var code = "CP-BAD-REF-" + System.nanoTime();

        assertThatThrownBy(() -> controller.create("product", Map.of(
            "code", code,
            "name", code,
            "category", "不存在的类别",
            "unit", "只"
        )))
            .isInstanceOf(ResponseStatusException.class)
            .extracting(ex -> ((ResponseStatusException) ex).getStatusCode())
            .isEqualTo(HttpStatus.BAD_REQUEST);
    }
}
