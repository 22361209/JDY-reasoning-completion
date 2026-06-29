package com.jdy.erp.system.tenant;

import static org.assertj.core.api.Assertions.assertThat;

import java.math.BigDecimal;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.UUID;

import com.jdy.erp.inventory.application.OpeningStockService;
import com.jdy.erp.masterdata.api.MasterDataController;
import com.jdy.erp.sales.application.DeliveryNoticeAppService;
import com.jdy.erp.sales.application.SalesOrderAppService;
import com.jdy.erp.sales.application.SalesOutAppService;
import com.jdy.erp.sales.application.SalesQuoteAppService;
import com.jdy.erp.system.api.ListStubController;
import com.jdy.erp.system.application.AccountSetManagementService;
import com.jdy.erp.system.security.CurrentSessionService;
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

@SpringBootTest
class TenantSalesChainIsolationTest {
    private static final String PRODUCT_CODE = "A119-SALES";
    private static final String CUSTOMER_CODE = "A119-CUST";
    private static final String WAREHOUSE_CODE = "CK-001";
    private static final String QUOTE_NO = "A119-SQ";
    private static final String ORDER_NO = "A119-SO";
    private static final String NOTICE_NO = "A119-DN";
    private static final String OUT_NO = "A119-SOUT";

    @Autowired
    private AccountSetManagementService accountSetManagementService;

    @Autowired
    private CurrentSessionService currentSessionService;

    @Autowired
    private MasterDataController masterDataController;

    @Autowired
    private OpeningStockService openingStockService;

    @Autowired
    private SalesQuoteAppService salesQuoteAppService;

    @Autowired
    private SalesOrderAppService salesOrderAppService;

    @Autowired
    private DeliveryNoticeAppService deliveryNoticeAppService;

    @Autowired
    private SalesOutAppService salesOutAppService;

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

    @BeforeEach
    void bindRequest() {
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
    }

    @Test
    void salesDocumentsSourceSelectionListsAndInventoryReadsAreTenantScoped() {
        var tenantA = createManagedAccountSet("A119SLA");
        var tenantB = createManagedAccountSet("A119SLB");

        useTenant(tenantA);
        createAuditedCustomer("A119 账套A客户");
        createAuditedMaterial("A119 账套A销售物料");
        saveOpeningStock(new BigDecimal("20"));
        saveAndAuditQuote("A119 账套A报价");
        assertQuoteSelectable("A119 账套A销售物料");
        saveAndAuditOrder(new BigDecimal("6"));
        assertQuoteConsumed();
        assertOrderSelectableStock("A119 账套A销售物料", "20.0000", "0.0000", "20.0000");
        saveAndAuditDeliveryNotice(new BigDecimal("4"));
        assertDeliveryStock(NOTICE_NO, "20.0000", "4.0000", "16.0000");
        saveAndAuditSalesOut(new BigDecimal("3"));
        assertDeliverySelectableRemaining("1.0000");
        assertBalance("17.0000", "1.0000", "16.0000");
        assertListContainsOnlyTenantCustomer("sales-order-form-list", "header", "A119 账套A客户", ORDER_NO);
        assertListContainsOnlyTenantCustomer("sales-order-form-list", "detail", "A119 账套A客户", ORDER_NO);

        useTenant(tenantB);
        createAuditedCustomer("A119 账套B客户");
        createAuditedMaterial("A119 账套B销售物料");
        saveOpeningStock(new BigDecimal("7"));
        saveAndAuditQuote("A119 账套B报价");
        assertQuoteSelectable("A119 账套B销售物料");
        saveAndAuditOrder(new BigDecimal("2"));
        assertOrderSelectableStock("A119 账套B销售物料", "7.0000", "0.0000", "7.0000");
        saveAndAuditDeliveryNotice(new BigDecimal("2"));
        assertDeliveryStock(NOTICE_NO, "7.0000", "2.0000", "5.0000");
        assertThat(countCustomersNamed("A119 账套A客户")).isZero();
        assertThat(countProductsNamed("A119 账套A销售物料")).isZero();
        assertListContainsOnlyTenantCustomer("sales-order-form-list", "header", "A119 账套B客户", ORDER_NO);

        useTenant(tenantA);
        assertBalance("17.0000", "1.0000", "16.0000");
        assertOrderDetailStock("17.0000", "1.0000", "16.0000");
        assertDeliveryStock(NOTICE_NO, "17.0000", "1.0000", "16.0000");
        assertThat(countCustomersNamed("A119 账套B客户")).isZero();
        assertThat(countProductsNamed("A119 账套B销售物料")).isZero();
        assertListContainsOnlyTenantCustomer("delivery-notice-form-list", "header", "A119 账套A客户", NOTICE_NO);
        assertListContainsOnlyTenantCustomer("sales-out-form-list", "header", "A119 账套A客户", OUT_NO);
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
        currentSessionService.login("admin", "admin123", code);
        TenantContext.setTenant(currentSessionService.currentAccountSet());
    }

    private void createAuditedCustomer(String name) {
        masterDataController.create("customer", Map.of(
            "code", CUSTOMER_CODE,
            "name", name
        ));
        masterDataController.audit("customer", CUSTOMER_CODE);
    }

    private void createAuditedMaterial(String name) {
        masterDataController.create("product", Map.of(
            "code", PRODUCT_CODE,
            "name", name,
            "category", "RAW",
            "unit", "PCS",
            "isSale", "true",
            "isInventory", "true"
        ));
        masterDataController.audit("product", PRODUCT_CODE);
    }

    private void saveOpeningStock(BigDecimal qty) {
        openingStockService.saveRows(List.of(new OpeningStockService.OpeningStockLineRequest(
            PRODUCT_CODE,
            WAREHOUSE_CODE,
            qty,
            BigDecimal.ONE,
            "A119-4-3 sales chain"
        )));
    }

    private void saveAndAuditQuote(String remark) {
        salesQuoteAppService.saveDraft(new SalesQuoteAppService.SalesQuoteDraftRequest(
            QUOTE_NO,
            CUSTOMER_CODE,
            "2026-06-30",
            "销售部",
            "admin",
            remark,
            false,
            "2026-07-30",
            List.of(new SalesQuoteAppService.SalesQuoteLineRequest(
                null,
                PRODUCT_CODE,
                WAREHOUSE_CODE,
                new BigDecimal("6"),
                new BigDecimal("10"),
                new BigDecimal("13"),
                "CM-A119",
                "CO-A119",
                "A119 quote line",
                "2026-07-05"
            ))
        ));
        salesQuoteAppService.audit(QUOTE_NO);
    }

    private void saveAndAuditOrder(BigDecimal qty) {
        salesOrderAppService.saveDraft(new SalesOrderAppService.SalesOrderDraftRequest(
            ORDER_NO,
            CUSTOMER_CODE,
            "2026-06-30",
            "销售部",
            "admin",
            "A119 order",
            false,
            List.of(new SalesOrderAppService.SalesOrderLineRequest(
                null,
                PRODUCT_CODE,
                WAREHOUSE_CODE,
                QUOTE_NO,
                1,
                qty,
                new BigDecimal("10"),
                new BigDecimal("13"),
                "CM-A119",
                "CO-A119",
                "A119 order line",
                "2026-07-05"
            ))
        ));
        salesOrderAppService.audit(ORDER_NO);
    }

    private void saveAndAuditDeliveryNotice(BigDecimal qty) {
        deliveryNoticeAppService.saveDraft(new DeliveryNoticeAppService.DeliveryNoticeDraftRequest(
            NOTICE_NO,
            ORDER_NO,
            CUSTOMER_CODE,
            "2026-06-30",
            "销售部",
            "admin",
            "A119 delivery notice",
            false,
            List.of(new DeliveryNoticeAppService.DeliveryNoticeLineRequest(
                null,
                PRODUCT_CODE,
                WAREHOUSE_CODE,
                ORDER_NO,
                1,
                qty,
                new BigDecimal("10"),
                new BigDecimal("13"),
                "CM-A119",
                "CO-A119",
                "A119 notice line",
                "2026-07-05"
            ))
        ));
        deliveryNoticeAppService.audit(NOTICE_NO);
    }

    private void saveAndAuditSalesOut(BigDecimal qty) {
        salesOutAppService.saveDraft(new SalesOutAppService.SalesOutDraftRequest(
            OUT_NO,
            NOTICE_NO,
            CUSTOMER_CODE,
            "2026-06-30",
            "销售部",
            "admin",
            "A119 sales out",
            false,
            List.of(new SalesOutAppService.SalesOutLineRequest(
                null,
                PRODUCT_CODE,
                WAREHOUSE_CODE,
                null,
                null,
                NOTICE_NO,
                1,
                qty,
                new BigDecimal("10"),
                new BigDecimal("13"),
                "CM-A119",
                "CO-A119",
                "A119 out line",
                "2026-07-05"
            ))
        ));
        salesOutAppService.audit(OUT_NO);
    }

    private void assertQuoteSelectable(String productName) {
        var lines = linesOf(salesQuoteAppService.selectableLines(CUSTOMER_CODE));
        assertThat(lines)
            .singleElement()
            .satisfies(row -> {
                assertThat(row.get("billNo")).isEqualTo(QUOTE_NO);
                assertThat(row.get("productName")).isEqualTo(productName);
            });
    }

    private void assertQuoteConsumed() {
        assertThat(linesOf(salesQuoteAppService.selectableLines(CUSTOMER_CODE))).isEmpty();
    }

    private void assertOrderSelectableStock(String productName, String onHand, String reserved, String available) {
        var lines = linesOf(salesOrderAppService.selectableLines(CUSTOMER_CODE));
        assertThat(lines)
            .singleElement()
            .satisfies(row -> {
                assertThat(row.get("billNo")).isEqualTo(ORDER_NO);
                assertThat(row.get("productName")).isEqualTo(productName);
                assertDecimal(row.get("stockOnHand"), onHand);
                assertDecimal(row.get("stockReserved"), reserved);
                assertDecimal(row.get("stockAvailable"), available);
            });
    }

    private void assertOrderDetailStock(String onHand, String reserved, String available) {
        var lines = linesOf(salesOrderAppService.detail(ORDER_NO), "lines");
        assertThat(lines)
            .singleElement()
            .satisfies(row -> {
                assertDecimal(row.get("stockOnHand"), onHand);
                assertDecimal(row.get("stockReserved"), reserved);
                assertDecimal(row.get("stockAvailable"), available);
            });
    }

    private void assertDeliveryStock(String billNo, String onHand, String reserved, String available) {
        var lines = linesOf(deliveryNoticeAppService.detail(billNo), "lines");
        assertThat(lines)
            .singleElement()
            .satisfies(row -> {
                assertDecimal(row.get("stockOnHand"), onHand);
                assertDecimal(row.get("stockReserved"), reserved);
                assertDecimal(row.get("stockAvailable"), available);
            });
    }

    private void assertDeliverySelectableRemaining(String remainingQty) {
        var lines = linesOf(deliveryNoticeAppService.selectableLines(CUSTOMER_CODE));
        assertThat(lines)
            .singleElement()
            .satisfies(row -> {
                assertThat(row.get("billNo")).isEqualTo(NOTICE_NO);
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

    private void assertListContainsOnlyTenantCustomer(String listKey, String view, String customerName, String billNo) {
        @SuppressWarnings("unchecked")
        var rows = (List<Map<String, Object>>) listStubController.rows(
            listKey,
            customerName,
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

    @SuppressWarnings("unchecked")
    private List<Map<String, Object>> linesOf(Map<String, Object> payload) {
        return (List<Map<String, Object>>) payload.get("lines");
    }

    @SuppressWarnings("unchecked")
    private List<Map<String, Object>> linesOf(Map<String, Object> payload, String key) {
        return (List<Map<String, Object>>) payload.get(key);
    }

    private void assertDecimal(Object actual, String expected) {
        assertThat((BigDecimal) actual).isEqualByComparingTo(expected);
    }

    private int countCustomersNamed(String name) {
        return jdbcTemplate.queryForObject(
            "SELECT count(*)::int FROM md_customer WHERE name = ?",
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
