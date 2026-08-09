package com.jdy.erp.purchase.application;

import static org.assertj.core.api.Assertions.assertThat;

import java.math.BigDecimal;
import java.time.LocalDate;
import java.util.List;
import java.util.Map;
import java.util.UUID;

import com.jdy.erp.system.tenant.TenantContext;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.transaction.annotation.Transactional;

@SpringBootTest
@Transactional
class PurchaseOrderRemarkIntegrationTest {
    @Autowired
    private JdbcTemplate jdbcTemplate;

    @Autowired
    private PurchaseOrderAppService purchaseOrderAppService;

    @BeforeEach
    void bindDefaultTenant() {
        TenantContext.setTenant(jdbcTemplate.queryForMap("""
            SELECT id::text AS id, code, name, COALESCE(schema_name, '') AS "schemaName"
            FROM sys_account_set
            WHERE code = 'BLD-TEST'
            """));
    }

    @AfterEach
    void clearTenant() {
        TenantContext.clear();
    }

    @Test
    void remarkPersistsOnCreateAndDraftUpdateWhileLegacyRequestsRemainCompatible() {
        var suffix = UUID.randomUUID().toString().replace("-", "").substring(0, 12).toUpperCase();
        var supplierCode = jdbcTemplate.queryForObject("""
            SELECT code
            FROM md_supplier
            WHERE enabled = TRUE AND audit_status = 'AUDITED'
            ORDER BY code
            LIMIT 1
            """, String.class);
        var product = jdbcTemplate.queryForMap("""
            SELECT id::text AS id, code
            FROM md_product
            WHERE enabled = TRUE AND audit_status = 'AUDITED'
            ORDER BY code
            LIMIT 1
            """);
        var warehouseCode = jdbcTemplate.queryForObject("""
            SELECT code
            FROM md_warehouse
            WHERE enabled = TRUE AND audit_status = 'AUDITED'
            ORDER BY code
            LIMIT 1
            """, String.class);
        var lines = List.of(new PurchaseOrderAppService.PurchaseOrderLineRequest(
            String.valueOf(product.get("id")),
            String.valueOf(product.get("code")),
            warehouseCode,
            BigDecimal.ONE,
            new BigDecimal("12.50"),
            new BigDecimal("13"),
            "A181 remark line " + suffix,
            "",
            null,
            null,
            LocalDate.now().plusDays(7).toString()
        ));
        var legacyRequest = new PurchaseOrderAppService.PurchaseOrderDraftRequest(
            null, supplierCode, LocalDate.now().toString(), "采购部", "A181", lines
        );
        var legacyCurrencyRequest = new PurchaseOrderAppService.PurchaseOrderDraftRequest(
            null, supplierCode, LocalDate.now().toString(), "采购部", "A181", "CNY", lines
        );
        assertThat(legacyRequest.remark()).isNull();
        assertThat(legacyCurrencyRequest.remark()).isNull();

        var created = purchaseOrderAppService.saveDraft(new PurchaseOrderAppService.PurchaseOrderDraftRequest(
            null,
            supplierCode,
            LocalDate.now().toString(),
            "采购部",
            "A181",
            "CNY",
            "A181 创建备注 " + suffix,
            lines
        ));
        var billNo = String.valueOf(created.get("billNo"));
        assertThat(document(purchaseOrderAppService.detail(billNo)))
            .containsEntry("remark", "A181 创建备注 " + suffix);

        purchaseOrderAppService.saveDraft(new PurchaseOrderAppService.PurchaseOrderDraftRequest(
            billNo,
            supplierCode,
            LocalDate.now().toString(),
            "采购部",
            "A181",
            "CNY",
            "A181 更新备注 " + suffix,
            lines
        ));
        assertThat(jdbcTemplate.queryForObject(
            "SELECT remark FROM purchase_order WHERE bill_no = ?",
            String.class,
            billNo
        )).isEqualTo("A181 更新备注 " + suffix);
        assertThat(document(purchaseOrderAppService.detail(billNo)))
            .containsEntry("remark", "A181 更新备注 " + suffix);
    }

    @SuppressWarnings("unchecked")
    private Map<String, Object> document(Map<String, Object> detail) {
        return (Map<String, Object>) detail.get("document");
    }
}
