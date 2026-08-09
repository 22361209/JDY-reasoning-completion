package com.jdy.erp.system.tenant;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static com.jdy.erp.testsupport.InventoryTraceAssertions.assertExactLifecycle;
import static com.jdy.erp.testsupport.InventoryTraceAssertions.fact;
import static com.jdy.erp.testsupport.InventoryTraceAssertions.reversal;

import java.math.BigDecimal;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.UUID;

import com.jdy.erp.finance.application.FinanceSettlementAppService;
import com.jdy.erp.finance.application.FinanceSettlementAppService.AllocationRequest;
import com.jdy.erp.finance.application.FinanceSettlementAppService.FundLineRequest;
import com.jdy.erp.finance.application.FinanceSettlementAppService.SettlementDraftRequest;
import com.jdy.erp.finance.application.FinanceSettlementAppService.SettlementKind;
import com.jdy.erp.masterdata.api.MasterDataController;
import com.jdy.erp.purchase.application.PurchaseInAppService;
import com.jdy.erp.purchase.application.PurchaseOrderAppService;
import com.jdy.erp.purchase.application.PurchaseReturnAppService;
import com.jdy.erp.system.api.ListStubController;
import com.jdy.erp.system.application.AccountSetManagementService;
import com.jdy.erp.system.security.CurrentSessionService;
import com.jdy.erp.testsupport.IsolatedAdminFixture;
import com.jdy.erp.testsupport.InventoryTraceAssertions.SourceDocument;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.mock.web.MockHttpServletRequest;
import org.springframework.web.context.request.RequestContextHolder;
import org.springframework.web.context.request.ServletRequestAttributes;
import org.springframework.web.server.ResponseStatusException;

@SpringBootTest
class TenantPurchaseChainIsolationTest {
    private static final String PRODUCT_CODE = "A119-PUR";
    private static final String SUPPLIER_CODE = "A119-SUP";
    private static final String WAREHOUSE_CODE = "CK-001";
    private static final String REQUISITION_NO = "A119-PR";

    @Autowired
    private AccountSetManagementService accountSetManagementService;

    @Autowired
    private CurrentSessionService currentSessionService;

    @Autowired
    private MasterDataController masterDataController;

    @Autowired
    private PurchaseOrderAppService purchaseOrderAppService;

    @Autowired
    private PurchaseInAppService purchaseInAppService;

    @Autowired
    private PurchaseReturnAppService purchaseReturnAppService;

    @Autowired
    private FinanceSettlementAppService financeSettlementAppService;

    @Autowired
    private ListStubController listStubController;

    @Autowired
    private JdbcTemplate jdbcTemplate;

    @Autowired
    @Qualifier("platformJdbcTemplate")
    private JdbcTemplate platformJdbcTemplate;

    @Autowired
    private TenantDataSourceRegistry tenantDataSourceRegistry;

    private final List<String> createdCodes = new ArrayList<>();
    private final List<String> createdSchemas = new ArrayList<>();
    private IsolatedAdminFixture.Identity fixture;

    @BeforeEach
    void bindRequest() {
        fixture = IsolatedAdminFixture.create(platformJdbcTemplate, "purchase");
        useTenant("BLD-TEST");
    }

    @AfterEach
    void cleanUp() {
        TenantContext.clear();
        RequestContextHolder.resetRequestAttributes();
        tenantDataSourceRegistry.close();
        for (var schema : createdSchemas) {
            platformJdbcTemplate.execute("DROP SCHEMA IF EXISTS " + quoteIdentifier(schema) + " CASCADE");
        }
        for (var code : createdCodes) {
            platformJdbcTemplate.update("""
                DELETE FROM sys_user_account_set
                WHERE account_set_id IN (SELECT id FROM sys_account_set WHERE code = ?)
                """, code);
            platformJdbcTemplate.update("DELETE FROM sys_account_set WHERE code = ?", code);
        }
        IsolatedAdminFixture.remove(platformJdbcTemplate, fixture);
    }

    @Test
    void purchaseRequisitionOrderInReturnAndSummaryAreTenantScoped() {
        var tenantA = createManagedAccountSet("A119PRA");
        var tenantB = createManagedAccountSet("A119PRB");

        useTenant(tenantA);
        createAuditedSupplier("A119 账套A供应商");
        createAuditedMaterial("A119 账套A采购物料");
        createAuditedPurchaseRequisition(new BigDecimal("12"));
        assertRequisitionSelectable("A119 账套A采购物料", "12.0000");
        var orderNoA = saveAndAuditPurchaseOrder(new BigDecimal("8"));
        assertRequisitionSelectable("A119 账套A采购物料", "4.0000");
        assertPurchaseOrderSelectable("A119 账套A采购物料", orderNoA, "0.0000", "8.0000");
        var inNoA = saveAndAuditPurchaseIn(new BigDecimal("5"), orderNoA);
        assertExactLifecycle(
            jdbcTemplate,
            sourceDocument("purchase_in", "purchase_in_line", inNoA),
            "PURCHASE_IN", PRODUCT_CODE, WAREHOUSE_CODE,
            fact("PURCHASE_IN", "AUDIT", "5", "5")
        );
        purchaseInAppService.reverse(inNoA);
        assertPayableFact("YF-CX-" + inNoA, "-56.50", "0", "OPEN");
        assertExactLifecycle(
            jdbcTemplate,
            sourceDocument("purchase_in", "purchase_in_line", inNoA),
            "PURCHASE_IN", PRODUCT_CODE, WAREHOUSE_CODE,
            fact("PURCHASE_IN", "AUDIT", "5", "5"),
            reversal("PURCHASE_IN_REVERSE", "REVERSE", "-5", "0", 0)
        );
        purchaseInAppService.audit(inNoA);
        assertPayableFact("YF-CX-" + inNoA, "-56.50", "0", "REVERSED");
        assertPayableFactCount(inNoA, 2);
        assertExactLifecycle(
            jdbcTemplate,
            sourceDocument("purchase_in", "purchase_in_line", inNoA),
            "PURCHASE_IN", PRODUCT_CODE, WAREHOUSE_CODE,
            fact("PURCHASE_IN", "AUDIT", "5", "5"),
            reversal("PURCHASE_IN_REVERSE", "REVERSE", "-5", "0", 0),
            fact("PURCHASE_IN", "AUDIT", "5", "5")
        );
        assertPurchaseOrderSelectable("A119 账套A采购物料", orderNoA, "5.0000", "3.0000");
        assertBalance("5.0000", "0.0000", "5.0000");
        assertReturnSelectable("A119 账套A采购物料", inNoA, "0.0000", "5.0000");
        var returnNoA = saveAndAuditPurchaseReturn(new BigDecimal("2"), inNoA);
        assertExactLifecycle(
            jdbcTemplate,
            sourceDocument("purchase_return", "purchase_return_line", returnNoA),
            "PURCHASE_RETURN", PRODUCT_CODE, WAREHOUSE_CODE,
            fact("PURCHASE_RETURN", "AUDIT", "-2", "3")
        );
        purchaseReturnAppService.reverse(returnNoA);
        assertPayableFact("YF-TH-CX-" + returnNoA, "22.60", "0", "OPEN");
        assertExactLifecycle(
            jdbcTemplate,
            sourceDocument("purchase_return", "purchase_return_line", returnNoA),
            "PURCHASE_RETURN", PRODUCT_CODE, WAREHOUSE_CODE,
            fact("PURCHASE_RETURN", "AUDIT", "-2", "3"),
            reversal("PURCHASE_RETURN_REVERSE", "REVERSE", "2", "5", 0)
        );
        purchaseReturnAppService.audit(returnNoA);
        assertPayableFact("YF-TH-CX-" + returnNoA, "22.60", "0", "REVERSED");
        assertPayableFactCount(returnNoA, 2);
        assertExactLifecycle(
            jdbcTemplate,
            sourceDocument("purchase_return", "purchase_return_line", returnNoA),
            "PURCHASE_RETURN", PRODUCT_CODE, WAREHOUSE_CODE,
            fact("PURCHASE_RETURN", "AUDIT", "-2", "3"),
            reversal("PURCHASE_RETURN_REVERSE", "REVERSE", "2", "5", 0),
            fact("PURCHASE_RETURN", "AUDIT", "-2", "3")
        );
        assertReturnSelectable("A119 账套A采购物料", inNoA, "2.0000", "3.0000");
        assertBalance("3.0000", "0.0000", "3.0000");
        assertListContainsOnlyTenantSupplier("purchase-requisition-list", "header", "A119 账套A供应商", REQUISITION_NO);
        assertListContainsOnlyTenantSupplier("purchase-order-form-list", "header", "A119 账套A供应商", orderNoA);
        assertListContainsOnlyTenantSupplier("purchase-order-form-list", "detail", "A119 账套A供应商", orderNoA);
        assertListContainsOnlyTenantSupplier("purchase-in-form-list", "header", "A119 账套A供应商", inNoA);
        assertListContainsOnlyTenantSupplier("purchase-return-form-list", "header", "A119 账套A供应商", returnNoA);
        assertPurchaseSummary("A119 账套A供应商", "A119 账套A采购物料", "8", "5", "2", "5");

        useTenant(tenantB);
        createAuditedSupplier("A119 账套B供应商");
        createAuditedMaterial("A119 账套B采购物料");
        createAuditedPurchaseRequisition(new BigDecimal("4"));
        assertRequisitionSelectable("A119 账套B采购物料", "4.0000");
        var orderNoB = saveAndAuditPurchaseOrder(new BigDecimal("3"));
        assertRequisitionSelectable("A119 账套B采购物料", "1.0000");
        var inNoB = saveAndAuditPurchaseIn(new BigDecimal("1"), orderNoB);
        assertExactLifecycle(
            jdbcTemplate,
            sourceDocument("purchase_in", "purchase_in_line", inNoB),
            "PURCHASE_IN", PRODUCT_CODE, WAREHOUSE_CODE,
            fact("PURCHASE_IN", "AUDIT", "1", "1")
        );
        assertPurchaseOrderSelectable("A119 账套B采购物料", orderNoB, "1.0000", "2.0000");
        assertBalance("1.0000", "0.0000", "1.0000");
        assertThat(countSuppliersNamed("A119 账套A供应商")).isZero();
        assertThat(countProductsNamed("A119 账套A采购物料")).isZero();
        assertListContainsOnlyTenantSupplier("purchase-order-form-list", "header", "A119 账套B供应商", orderNoB);
        assertPurchaseSummary("A119 账套B供应商", "A119 账套B采购物料", "3", "1", "0", "2");

        useTenant(tenantA);
        assertRequisitionSelectable("A119 账套A采购物料", "4.0000");
        assertPurchaseOrderSelectable("A119 账套A采购物料", orderNoA, "5.0000", "3.0000");
        assertReturnSelectable("A119 账套A采购物料", inNoA, "2.0000", "3.0000");
        assertBalance("3.0000", "0.0000", "3.0000");
        assertThat(countSuppliersNamed("A119 账套B供应商")).isZero();
        assertThat(countProductsNamed("A119 账套B采购物料")).isZero();
        assertPurchaseSummary("A119 账套A供应商", "A119 账套A采购物料", "8", "5", "2", "5");
    }

    @Test
    void paidPurchaseReturnReversalBlocksReauditAndRollsBackAllRuntimeEffects() {
        var tenant = createManagedAccountSet("A181PAID");
        useTenant(tenant);
        createAuditedSupplier("A181 已核销退货供应商");
        createAuditedMaterial("A181 已核销退货物料");
        createAuditedPurchaseRequisition(new BigDecimal("5"));
        var orderNo = saveAndAuditPurchaseOrder(new BigDecimal("5"));
        var purchaseInNo = saveAndAuditPurchaseIn(new BigDecimal("5"), orderNo);
        var returnNo = saveAndAuditPurchaseReturn(new BigDecimal("2"), purchaseInNo);
        purchaseReturnAppService.reverse(returnNo);

        var reversalBillNo = "YF-TH-CX-" + returnNo;
        var reversal = jdbcTemplate.queryForMap("""
            SELECT id::text AS id,
                   supplier_id::text AS "supplierId"
            FROM ap_payable
            WHERE bill_no = ?
            """, reversalBillNo);
        var accountId = jdbcTemplate.queryForObject("""
            INSERT INTO md_financial_account (
                code, name, account_type, currency, enabled, audit_status
            )
            VALUES ('ZH-A181-PAID-REV', 'A181 已核销反审核事实', 'CASH', 'CNY', TRUE, 'AUDITED')
            RETURNING id::text
            """, String.class);
        var payment = financeSettlementAppService.createDraft(
            SettlementKind.PAYMENT,
            new SettlementDraftRequest(
                null,
                null,
                String.valueOf(reversal.get("supplierId")),
                "2026-06-30",
                "CNY",
                BigDecimal.ONE,
                "A181 已核销反审核事实",
                List.of(new FundLineRequest(
                    1, accountId, "CASH", BigDecimal.ONE, BigDecimal.ZERO, null, "A181"
                )),
                List.of(new AllocationRequest(
                    1, String.valueOf(reversal.get("id")), BigDecimal.ONE, "A181"
                ))
            )
        );
        var paymentBillNo = String.valueOf(payment.get("billNo"));
        financeSettlementAppService.audit(SettlementKind.PAYMENT, paymentBillNo);
        assertPayableFact(reversalBillNo, "22.60", "1", "PART_SETTLED");

        assertThatThrownBy(() -> purchaseReturnAppService.audit(returnNo))
            .isInstanceOfSatisfying(ResponseStatusException.class, exception -> {
                assertThat(exception.getStatusCode().value()).isEqualTo(409);
                assertThat(exception.getReason()).contains("应付反审核事实已发生核销，来源单据不能重新审核");
            });

        assertThat(jdbcTemplate.queryForObject(
            "SELECT status FROM purchase_return WHERE bill_no = ?",
            String.class,
            returnNo
        )).isEqualTo("DRAFT");
        assertBalance("5.0000", "0.0000", "5.0000");
        assertReturnSelectable("A181 已核销退货物料", purchaseInNo, "0.0000", "5.0000");
        assertPayableFact(reversalBillNo, "22.60", "1", "PART_SETTLED");
        assertThat(jdbcTemplate.queryForObject(
            "SELECT status FROM ap_payment WHERE bill_no = ?",
            String.class,
            paymentBillNo
        )).isEqualTo("AUDITED");
        assertThat(jdbcTemplate.queryForObject("""
            SELECT count(*)::int
            FROM ap_payment_allocation allocation
            JOIN ap_payment payment ON payment.id = allocation.payment_id
            WHERE payment.bill_no = ?
            """, Integer.class, paymentBillNo)).isEqualTo(1);
        assertExactLifecycle(
            jdbcTemplate,
            sourceDocument("purchase_return", "purchase_return_line", returnNo),
            "PURCHASE_RETURN", PRODUCT_CODE, WAREHOUSE_CODE,
            fact("PURCHASE_RETURN", "AUDIT", "-2", "3"),
            reversal("PURCHASE_RETURN_REVERSE", "REVERSE", "2", "5", 0)
        );
    }

    private String createManagedAccountSet(String prefix) {
        var code = prefix + "-" + UUID.randomUUID().toString().substring(0, 8).toUpperCase();
        createdCodes.add(code);
        var result = accountSetManagementService.createAccountSet(new AccountSetManagementService.AccountSetCreateRequest(
            code,
            code + " 账套",
            "测试",
            null,
            null,
            null,
            null,
            "2026-06",
            "2026-06"
        ));
        @SuppressWarnings("unchecked")
        var row = (Map<String, Object>) result.get("accountSet");
        createdSchemas.add(String.valueOf(row.get("schemaName")));
        return code;
    }

    private void useTenant(String code) {
        TenantContext.clear();
        RequestContextHolder.setRequestAttributes(new ServletRequestAttributes(new MockHttpServletRequest()));
        currentSessionService.login(fixture.username(), IsolatedAdminFixture.PASSWORD, code);
        TenantContext.setTenant(currentSessionService.currentAccountSet());
    }

    private void createAuditedSupplier(String name) {
        masterDataController.create("supplier", Map.of(
            "code", SUPPLIER_CODE,
            "name", name
        ));
        masterDataController.audit("supplier", SUPPLIER_CODE);
    }

    private void createAuditedMaterial(String name) {
        var nameCode = "PN-" + PRODUCT_CODE;
        masterDataController.create("productName", Map.of(
            "code", nameCode,
            "name", name
        ));
        masterDataController.audit("productName", nameCode);
        masterDataController.create("product", Map.of(
            "code", PRODUCT_CODE,
            "name", name,
            "category", "RAW",
            "unit", "PCS",
            "isPurchase", "true",
            "isInventory", "true"
        ));
        masterDataController.audit("product", PRODUCT_CODE);
    }

    private void createAuditedPurchaseRequisition(BigDecimal qty) {
        var supplierId = lookupId("md_supplier", SUPPLIER_CODE);
        var productId = lookupId("md_product", PRODUCT_CODE);
        var warehouseId = lookupId("md_warehouse", WAREHOUSE_CODE);
        var requisition = jdbcTemplate.queryForMap("""
            INSERT INTO purchase_requisition (bill_no, supplier_id, supplier_code_snapshot, supplier_name_snapshot, bill_date, department, status, owner_name)
            SELECT ?, ?::uuid, code, name, '2026-06-30'::date, '采购部', 'AUDITED', 'A119'
            FROM md_supplier
            WHERE id = ?::uuid
            RETURNING id::text AS id
            """, REQUISITION_NO, supplierId, supplierId);
        jdbcTemplate.update("""
            INSERT INTO purchase_requisition_line (requisition_id, line_no, product_id, product_code_snapshot, product_name_snapshot, product_spec_snapshot, product_unit_snapshot, warehouse_id, qty, plan_delivery_date)
            SELECT ?::uuid, 1, id, code, name, COALESCE(spec, ''), COALESCE(unit, ''), ?::uuid, ?, '2026-07-05'::date
            FROM md_product
            WHERE id = ?::uuid
            """, requisition.get("id"), warehouseId, qty, productId);
    }

    private String saveAndAuditPurchaseOrder(BigDecimal qty) {
        var saved = purchaseOrderAppService.saveDraft(new PurchaseOrderAppService.PurchaseOrderDraftRequest(
            null,
            SUPPLIER_CODE,
            "2026-06-30",
            "采购部",
            "admin",
            List.of(new PurchaseOrderAppService.PurchaseOrderLineRequest(
                null,
                PRODUCT_CODE,
                WAREHOUSE_CODE,
                qty,
                new BigDecimal("10"),
                new BigDecimal("13"),
                "A119 purchase order line",
                "SM-A119",
                REQUISITION_NO,
                1,
                "2026-07-05"
            ))
        ));
        var billNo = generatedBillNo(saved, "采购订单");
        purchaseOrderAppService.audit(billNo);
        return billNo;
    }

    private String saveAndAuditPurchaseIn(BigDecimal qty, String orderNo) {
        var saved = purchaseInAppService.saveDraft(new PurchaseInAppService.PurchaseInDraftRequest(
            null,
            orderNo,
            SUPPLIER_CODE,
            "2026-06-30",
            "采购部",
            "admin",
            List.of(new PurchaseInAppService.PurchaseInLineRequest(
                null,
                PRODUCT_CODE,
                WAREHOUSE_CODE,
                orderNo,
                1,
                qty,
                new BigDecimal("10"),
                new BigDecimal("13"),
                "A119 purchase in line"
            ))
        ));
        var billNo = generatedBillNo(saved, "采购入库单");
        purchaseInAppService.audit(billNo);
        return billNo;
    }

    private String saveAndAuditPurchaseReturn(BigDecimal qty, String purchaseInNo) {
        var saved = purchaseReturnAppService.saveDraft(new PurchaseReturnAppService.PurchaseReturnDraftRequest(
            null,
            SUPPLIER_CODE,
            "2026-06-30",
            "采购部",
            "admin",
            "A119 return",
            List.of(new PurchaseReturnAppService.PurchaseReturnLineRequest(
                null,
                PRODUCT_CODE,
                WAREHOUSE_CODE,
                purchaseInNo,
                1,
                qty,
                new BigDecimal("10"),
                new BigDecimal("13"),
                "A119 purchase return line"
            ))
        ));
        var billNo = generatedBillNo(saved, "采购退货单");
        purchaseReturnAppService.audit(billNo);
        return billNo;
    }

    private void assertRequisitionSelectable(String productName, String remainingQty) {
        var lines = linesOf(purchaseOrderAppService.selectableRequisitionLines(SUPPLIER_CODE));
        assertThat(lines)
            .singleElement()
            .satisfies(row -> {
                assertThat(row.get("billNo")).isEqualTo(REQUISITION_NO);
                assertThat(row.get("productName")).isEqualTo(productName);
                assertDecimal(row.get("remainingQty"), remainingQty);
            });
    }

    private void assertPurchaseOrderSelectable(String productName, String orderNo, String receivedQty, String remainingQty) {
        var lines = linesOf(purchaseOrderAppService.selectableLines(SUPPLIER_CODE));
        assertThat(lines)
            .singleElement()
            .satisfies(row -> {
                assertThat(row.get("billNo")).isEqualTo(orderNo);
                assertThat(row.get("productName")).isEqualTo(productName);
                assertDecimal(row.get("receivedQty"), receivedQty);
                assertDecimal(row.get("remainingQty"), remainingQty);
            });
    }

    private void assertReturnSelectable(String productName, String purchaseInNo, String returnedQty, String remainingQty) {
        var lines = linesOf(purchaseReturnAppService.selectableLines(SUPPLIER_CODE));
        assertThat(lines)
            .singleElement()
            .satisfies(row -> {
                assertThat(row.get("billNo")).isEqualTo(purchaseInNo);
                assertThat(row.get("productName")).isEqualTo(productName);
                assertDecimal(row.get("returnedQty"), returnedQty);
                assertDecimal(row.get("remainingQty"), remainingQty);
            });
    }

    private void assertBalance(String onHand, String reserved, String available) {
        var row = jdbcTemplate.queryForMap("""
            SELECT b.qty_on_hand AS "onHand",
                   b.qty_reserved AS reserved,
                   b.qty_available AS available
            FROM inv_stock_balance b
            JOIN md_product p ON p.id = b.product_id
            JOIN md_warehouse w ON w.id = b.warehouse_id
            WHERE p.code = ?
              AND w.code = ?
            """, PRODUCT_CODE, WAREHOUSE_CODE);
        assertDecimal(row.get("onHand"), onHand);
        assertDecimal(row.get("reserved"), reserved);
        assertDecimal(row.get("available"), available);
    }

    private void assertPayableFact(String billNo, String amount, String paidAmount, String expectedStatus) {
        var fact = jdbcTemplate.queryForMap("""
            SELECT amount,
                   paid_amount AS "paidAmount",
                   status
            FROM ap_payable
            WHERE bill_no = ?
            """, billNo);
        assertDecimal(fact.get("amount"), amount);
        assertDecimal(fact.get("paidAmount"), paidAmount);
        assertThat(fact.get("status")).isEqualTo(expectedStatus);
    }

    private void assertPayableFactCount(String sourceBillNo, int expectedCount) {
        assertThat(jdbcTemplate.queryForObject(
            "SELECT count(*)::int FROM ap_payable WHERE source_bill_no = ?",
            Integer.class,
            sourceBillNo
        )).isEqualTo(expectedCount);
    }

    private void assertListContainsOnlyTenantSupplier(String listKey, String view, String supplierName, String billNo) {
        @SuppressWarnings("unchecked")
        var rows = (List<Map<String, Object>>) listStubController.rows(
            listKey,
            supplierName,
            "",
            1,
            200,
            view,
            "",
            "asc",
            "",
            "",
            "",
            "",
            "",
            "",
            ""
        ).get("rows");
        assertThat(rows)
            .singleElement()
            .satisfies(row -> assertThat(row.get("billNo")).isEqualTo(billNo));
    }

    private void assertPurchaseSummary(String supplierName, String productName, String orderQty, String inQty, String returnQty, String remainingQty) {
        @SuppressWarnings("unchecked")
        var rows = (List<Map<String, Object>>) listStubController.rows(
            "purchase-summary-report",
            supplierName,
            "",
            1,
            200,
            "header",
            "",
            "asc",
            "",
            "",
            "",
            "",
            "",
            "",
            ""
        ).get("rows");
        assertThat(rows)
            .singleElement()
            .satisfies(row -> {
                assertThat(row.get("supplier")).isEqualTo(supplierName);
                assertThat(row.get("productName")).isEqualTo(productName);
                assertThat(row.get("orderQty")).isEqualTo(orderQty);
                assertThat(row.get("inQty")).isEqualTo(inQty);
                assertThat(row.get("returnQty")).isEqualTo(returnQty);
                assertThat(row.get("remainingQty")).isEqualTo(remainingQty);
            });
    }

    @SuppressWarnings("unchecked")
    private List<Map<String, Object>> linesOf(Map<String, Object> payload) {
        return (List<Map<String, Object>>) payload.get("lines");
    }

    private String lookupId(String table, String code) {
        return jdbcTemplate.queryForObject(
            "SELECT id::text FROM " + table + " WHERE code = ?",
            String.class,
            code
        );
    }

    private void assertDecimal(Object actual, String expected) {
        assertThat((BigDecimal) actual).isEqualByComparingTo(expected);
    }

    private String generatedBillNo(Map<String, Object> saved, String label) {
        var billNo = (String) saved.get("billNo");
        assertThat(billNo).as(label + "系统生成单号").isNotBlank();
        return billNo;
    }

    private SourceDocument sourceDocument(String headerTable, String lineTable, String billNo) {
        return new SourceDocument(headerTable, lineTable, "bill_id", "bill_date", billNo);
    }

    private int countSuppliersNamed(String name) {
        return jdbcTemplate.queryForObject(
            "SELECT count(*)::int FROM md_supplier WHERE name = ?",
            Integer.class,
            name
        );
    }

    private int countProductsNamed(String name) {
        return jdbcTemplate.queryForObject(
            "SELECT count(*)::int FROM md_product WHERE name = ?",
            Integer.class,
            name
        );
    }

    private String quoteIdentifier(String identifier) {
        return "\"" + identifier.replace("\"", "\"\"") + "\"";
    }
}
