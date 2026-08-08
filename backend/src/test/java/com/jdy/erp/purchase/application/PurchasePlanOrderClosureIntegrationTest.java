package com.jdy.erp.purchase.application;

import static org.assertj.core.api.Assertions.assertThat;

import java.math.BigDecimal;
import java.time.LocalDate;
import java.util.Map;
import java.util.UUID;

import com.jdy.erp.shared.application.OperationLogService;
import com.jdy.erp.system.security.CurrentSessionService;
import com.jdy.erp.system.tenant.TenantContext;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.mock.web.MockHttpServletRequest;
import org.springframework.test.context.bean.override.mockito.MockitoBean;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.context.request.RequestContextHolder;
import org.springframework.web.context.request.ServletRequestAttributes;

@SpringBootTest
@Transactional
class PurchasePlanOrderClosureIntegrationTest {
    @Autowired
    private JdbcTemplate jdbcTemplate;

    @Autowired
    private PurchasePlanAppService purchasePlanAppService;

    @Autowired
    private PurchaseOrderAppService purchaseOrderAppService;

    @MockitoBean
    private OperationLogService operationLogService;

    @BeforeEach
    void bindAuthenticatedDefaultTenant() {
        var accountSet = jdbcTemplate.queryForMap("""
            SELECT id::text AS id, code, name, COALESCE(schema_name, '') AS "schemaName"
            FROM sys_account_set
            WHERE code = 'BLD-TEST'
            """);
        var request = new MockHttpServletRequest();
        request.getSession(true).setAttribute(CurrentSessionService.SESSION_USERNAME, "admin");
        RequestContextHolder.setRequestAttributes(new ServletRequestAttributes(request));
        TenantContext.setTenant(accountSet);
    }

    @AfterEach
    void clearRequestScope() {
        TenantContext.clear();
        RequestContextHolder.resetRequestAttributes();
    }

    @Test
    void planPriceSnapshotSurvivesMasterDataChangeAndOrderReverseReleasesQuantity() {
        var suffix = UUID.randomUUID().toString().replace("-", "").substring(0, 12).toUpperCase();
        var supplier = jdbcTemplate.queryForMap("""
            SELECT id::text AS id, code, name
            FROM md_supplier
            WHERE enabled = TRUE AND audit_status = 'AUDITED'
            ORDER BY code
            LIMIT 1
            """);
        var product = jdbcTemplate.queryForMap("""
            SELECT id::text AS id, code, name, COALESCE(spec, '') AS spec, COALESCE(unit, '') AS unit
            FROM md_product
            WHERE enabled = TRUE AND audit_status = 'AUDITED'
            ORDER BY code
            LIMIT 1
            """);
        var warehouse = jdbcTemplate.queryForMap("""
            SELECT id::text AS id
            FROM md_warehouse
            WHERE enabled = TRUE AND audit_status = 'AUDITED'
            ORDER BY code
            LIMIT 1
            """);
        var requisitionNo = "A176-PR-" + suffix;
        var planNo = "A176-PP-" + suffix;
        var quantity = new BigDecimal("2");
        var snapshotPrice = new BigDecimal("17.50");
        var snapshotTaxRate = new BigDecimal("6");

        var requisition = jdbcTemplate.queryForMap("""
            INSERT INTO purchase_requisition (
                bill_no, supplier_id, supplier_code_snapshot, supplier_name_snapshot,
                bill_date, department, status, owner_name
            ) VALUES (?, ?::uuid, ?, ?, ?::date, '采购部', 'AUDITED', 'A176 regression')
            RETURNING id::text AS id
            """, requisitionNo, supplier.get("id"), supplier.get("code"), supplier.get("name"), LocalDate.now());
        var requisitionLine = jdbcTemplate.queryForMap("""
            INSERT INTO purchase_requisition_line (
                requisition_id, line_no, product_id, product_code_snapshot, product_name_snapshot,
                product_spec_snapshot, product_unit_snapshot, warehouse_id, supplier_id,
                supplier_code_snapshot, supplier_name_snapshot, qty, plan_delivery_date
            ) VALUES (?::uuid, 1, ?::uuid, ?, ?, ?, ?, ?::uuid, ?::uuid, ?, ?, ?, ?::date)
            RETURNING id::text AS id
            """,
            requisition.get("id"), product.get("id"), product.get("code"), product.get("name"), product.get("spec"), product.get("unit"),
            warehouse.get("id"), supplier.get("id"), supplier.get("code"), supplier.get("name"), quantity, LocalDate.now().plusDays(7));
        var plan = jdbcTemplate.queryForMap("""
            INSERT INTO purchase_plan (
                bill_no, source_requisition_id, source_requisition_no,
                supplier_id, supplier_code_snapshot, supplier_name_snapshot,
                bill_date, department, status, owner_name
            ) VALUES (?, ?::uuid, ?, ?::uuid, ?, ?, ?::date, '采购部', 'AUDITED', 'A176 regression')
            RETURNING id::text AS id
            """,
            planNo, requisition.get("id"), requisitionNo, supplier.get("id"), supplier.get("code"), supplier.get("name"), LocalDate.now());
        jdbcTemplate.update("""
            INSERT INTO purchase_plan_line (
                plan_id, line_no, source_requisition_line_id, source_requisition_no, source_requisition_line_no,
                product_id, product_code_snapshot, product_name_snapshot, product_spec_snapshot, product_unit_snapshot,
                warehouse_id, qty, unit_price_snapshot, tax_rate_snapshot, plan_delivery_date
            ) VALUES (?::uuid, 1, ?::uuid, ?, 1, ?::uuid, ?, ?, ?, ?, ?::uuid, ?, ?, ?, ?::date)
            """,
            plan.get("id"), requisitionLine.get("id"), requisitionNo, product.get("id"), product.get("code"), product.get("name"),
            product.get("spec"), product.get("unit"), warehouse.get("id"), quantity, snapshotPrice, snapshotTaxRate, LocalDate.now().plusDays(7));

        jdbcTemplate.update("UPDATE md_product SET purchase_price = 999, tax_rate = 13 WHERE id = ?::uuid", product.get("id"));

        var pushed = purchasePlanAppService.pushDownOrder(planNo);
        var orderNo = String.valueOf(pushed.get("purchaseOrderBillNo"));
        var orderLine = jdbcTemplate.queryForMap("""
            SELECT unit_price AS "unitPrice", tax_rate AS "taxRate", source_purchase_plan_no AS "sourcePlanNo"
            FROM purchase_order_line line
            JOIN purchase_order purchase_order ON purchase_order.id = line.order_id
            WHERE purchase_order.bill_no = ?
            """, orderNo);
        assertThat((BigDecimal) orderLine.get("unitPrice")).isEqualByComparingTo(snapshotPrice);
        assertThat((BigDecimal) orderLine.get("taxRate")).isEqualByComparingTo(snapshotTaxRate);
        assertThat(orderLine.get("sourcePlanNo")).isEqualTo(planNo);

        purchaseOrderAppService.audit(orderNo);
        assertThat(planOrderedQuantity(plan.get("id"))).isEqualByComparingTo(quantity);

        purchaseOrderAppService.reverse(orderNo);
        assertThat(planOrderedQuantity(plan.get("id"))).isEqualByComparingTo(BigDecimal.ZERO);
        assertThat(jdbcTemplate.queryForObject("SELECT status FROM purchase_order WHERE bill_no = ?", String.class, orderNo))
            .isEqualTo("DRAFT");
    }

    private BigDecimal planOrderedQuantity(Object planId) {
        return jdbcTemplate.queryForObject(
            "SELECT ordered_qty FROM purchase_plan_line WHERE plan_id = ?::uuid AND line_no = 1",
            BigDecimal.class,
            planId
        );
    }
}
