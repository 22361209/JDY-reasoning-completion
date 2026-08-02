package com.jdy.erp.system.tenant;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static com.jdy.erp.testsupport.InventoryTraceAssertions.assertExactLifecycle;
import static com.jdy.erp.testsupport.InventoryTraceAssertions.fact;
import static com.jdy.erp.testsupport.InventoryTraceAssertions.reversal;

import java.math.BigDecimal;
import java.time.LocalDate;
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
import com.jdy.erp.sales.application.SalesReturnAppService;
import com.jdy.erp.system.api.ListStubController;
import com.jdy.erp.system.application.AccountSetManagementService;
import com.jdy.erp.system.security.CurrentSessionService;
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

@SpringBootTest
class TenantSalesChainIsolationTest {
    private static final String PRODUCT_CODE = "A119-SALES";
    private static final String CUSTOMER_CODE = "A119-CUST";
    private static final String WAREHOUSE_CODE = "CK-001";

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
    private SalesReturnAppService salesReturnAppService;

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
        var quoteNoA = saveAndAuditQuote("A119 账套A报价");
        assertQuoteSelectable("A119 账套A销售物料", quoteNoA);
        var orderNoA = saveAndAuditOrder(new BigDecimal("6"), quoteNoA);
        assertQuoteConsumed();
        assertOrderSelectableStock("A119 账套A销售物料", orderNoA, "20.0000", "0.0000", "20.0000");
        var noticeNoA = saveAndAuditDeliveryNotice(new BigDecimal("4"), orderNoA);
        assertExactLifecycle(
            jdbcTemplate,
            sourceDocument("delivery_notice", "delivery_notice_line", "bill_id", "bill_date", noticeNoA),
            "DELIVERY_NOTICE", PRODUCT_CODE, WAREHOUSE_CODE,
            fact("DELIVERY_NOTICE_RESERVE", "RESERVE", "0", "20")
        );
        assertDeliveryStock(noticeNoA, "20.0000", "4.0000", "16.0000");
        var outNoA = saveAndAuditSalesOut(new BigDecimal("3"), noticeNoA);
        assertExactLifecycle(
            jdbcTemplate,
            sourceDocument("sales_out", "sales_out_line", "bill_id", "bill_date", outNoA),
            "SALES_OUT", PRODUCT_CODE, WAREHOUSE_CODE,
            fact("SALES_OUT", "AUDIT", "-3", "17")
        );
        assertThatThrownBy(() -> salesOutAppService.audit(outNoA)).hasMessageContaining("已审核");
        salesOutAppService.reverse(outNoA);
        assertExactLifecycle(
            jdbcTemplate,
            sourceDocument("sales_out", "sales_out_line", "bill_id", "bill_date", outNoA),
            "SALES_OUT", PRODUCT_CODE, WAREHOUSE_CODE,
            fact("SALES_OUT", "AUDIT", "-3", "17"),
            reversal("SALES_OUT_REVERSE", "REVERSE", "3", "20", 0)
        );
        salesOutAppService.audit(outNoA);
        assertExactLifecycle(
            jdbcTemplate,
            sourceDocument("sales_out", "sales_out_line", "bill_id", "bill_date", outNoA),
            "SALES_OUT", PRODUCT_CODE, WAREHOUSE_CODE,
            fact("SALES_OUT", "AUDIT", "-3", "17"),
            reversal("SALES_OUT_REVERSE", "REVERSE", "3", "20", 0),
            fact("SALES_OUT", "AUDIT", "-3", "17")
        );
        assertDeliverySelectableRemaining(noticeNoA, "1.0000");
        assertBalance("17.0000", "1.0000", "16.0000");
        assertListContainsOnlyTenantCustomer("sales-order-form-list", "header", "A119 账套A客户", orderNoA);
        assertListContainsOnlyTenantCustomer("sales-order-form-list", "detail", "A119 账套A客户", orderNoA);

        useTenant(tenantB);
        createAuditedCustomer("A119 账套B客户");
        createAuditedMaterial("A119 账套B销售物料");
        saveOpeningStock(new BigDecimal("7"));
        var quoteNoB = saveAndAuditQuote("A119 账套B报价");
        assertQuoteSelectable("A119 账套B销售物料", quoteNoB);
        var orderNoB = saveAndAuditOrder(new BigDecimal("2"), quoteNoB);
        assertOrderSelectableStock("A119 账套B销售物料", orderNoB, "7.0000", "0.0000", "7.0000");
        var noticeNoB = saveAndAuditDeliveryNotice(new BigDecimal("2"), orderNoB);
        assertExactLifecycle(
            jdbcTemplate,
            sourceDocument("delivery_notice", "delivery_notice_line", "bill_id", "bill_date", noticeNoB),
            "DELIVERY_NOTICE", PRODUCT_CODE, WAREHOUSE_CODE,
            fact("DELIVERY_NOTICE_RESERVE", "RESERVE", "0", "7")
        );
        deliveryNoticeAppService.reverse(noticeNoB);
        assertExactLifecycle(
            jdbcTemplate,
            sourceDocument("delivery_notice", "delivery_notice_line", "bill_id", "bill_date", noticeNoB),
            "DELIVERY_NOTICE", PRODUCT_CODE, WAREHOUSE_CODE,
            fact("DELIVERY_NOTICE_RESERVE", "RESERVE", "0", "7"),
            reversal("DELIVERY_NOTICE_RESERVE_REVERSE", "RELEASE", "0", "7", 0)
        );
        deliveryNoticeAppService.audit(noticeNoB);
        assertExactLifecycle(
            jdbcTemplate,
            sourceDocument("delivery_notice", "delivery_notice_line", "bill_id", "bill_date", noticeNoB),
            "DELIVERY_NOTICE", PRODUCT_CODE, WAREHOUSE_CODE,
            fact("DELIVERY_NOTICE_RESERVE", "RESERVE", "0", "7"),
            reversal("DELIVERY_NOTICE_RESERVE_REVERSE", "RELEASE", "0", "7", 0),
            fact("DELIVERY_NOTICE_RESERVE", "RESERVE", "0", "7")
        );
        assertDeliveryStock(noticeNoB, "7.0000", "2.0000", "5.0000");
        assertThat(countCustomersNamed("A119 账套A客户")).isZero();
        assertThat(countProductsNamed("A119 账套A销售物料")).isZero();
        assertListContainsOnlyTenantCustomer("sales-order-form-list", "header", "A119 账套B客户", orderNoB);

        useTenant(tenantA);
        assertBalance("17.0000", "1.0000", "16.0000");
        assertOrderDetailStock(orderNoA, "17.0000", "1.0000", "16.0000");
        assertDeliveryStock(noticeNoA, "17.0000", "1.0000", "16.0000");
        assertThat(countCustomersNamed("A119 账套B客户")).isZero();
        assertThat(countProductsNamed("A119 账套B销售物料")).isZero();
        assertListContainsOnlyTenantCustomer("delivery-notice-form-list", "header", "A119 账套A客户", noticeNoA);
        assertListContainsOnlyTenantCustomer("sales-out-form-list", "header", "A119 账套A客户", outNoA);
    }

    @Test
    void salesReturnUsesTheSameGeneratedNumberWithoutCrossTenantDetailOrListLeakage() {
        var tenantA = createManagedAccountSet("A142SRA");
        var tenantB = createManagedAccountSet("A142SRB");

        useTenant(tenantA);
        createAuditedCustomer("A142 账套A客户");
        createAuditedMaterial("A142 账套A销售物料");
        saveOpeningStock(new BigDecimal("10"));
        var quoteA = saveAndAuditQuote("A142 账套A报价");
        var orderA = saveAndAuditOrder(new BigDecimal("6"), quoteA);
        var noticeA = saveAndAuditDeliveryNotice(new BigDecimal("4"), orderA);
        var outA = saveAndAuditSalesOut(new BigDecimal("3"), noticeA);
        var returnA = saveAndAuditSalesReturn(outA, "A142 账套A退货");
        assertExactLifecycle(
            jdbcTemplate,
            sourceDocument("sales_return", "sales_return_line", "bill_id", "bill_date", returnA),
            "SALES_RETURN", PRODUCT_CODE, WAREHOUSE_CODE,
            fact("SALES_RETURN", "AUDIT", "1", "8")
        );
        salesReturnAppService.reverse(returnA);
        assertExactLifecycle(
            jdbcTemplate,
            sourceDocument("sales_return", "sales_return_line", "bill_id", "bill_date", returnA),
            "SALES_RETURN", PRODUCT_CODE, WAREHOUSE_CODE,
            fact("SALES_RETURN", "AUDIT", "1", "8"),
            reversal("SALES_RETURN_REVERSE", "REVERSE", "-1", "7", 0)
        );
        salesReturnAppService.audit(returnA);
        assertExactLifecycle(
            jdbcTemplate,
            sourceDocument("sales_return", "sales_return_line", "bill_id", "bill_date", returnA),
            "SALES_RETURN", PRODUCT_CODE, WAREHOUSE_CODE,
            fact("SALES_RETURN", "AUDIT", "1", "8"),
            reversal("SALES_RETURN_REVERSE", "REVERSE", "-1", "7", 0),
            fact("SALES_RETURN", "AUDIT", "1", "8")
        );
        assertReturnDetail(returnA, outA, "A142 账套A客户", "CNY");
        assertListContainsOnlyTenantCustomer("sales-return-form-list", "header", "A142 账套A客户", returnA);
        assertBalance("8.0000", "1.0000", "7.0000");

        useTenant(tenantB);
        createAuditedCustomer("A142 账套B客户");
        createAuditedMaterial("A142 账套B销售物料");
        saveOpeningStock(new BigDecimal("10"));
        var quoteB = saveAndAuditQuote("A142 账套B报价");
        var orderB = saveAndAuditOrder(new BigDecimal("6"), quoteB);
        var noticeB = saveAndAuditDeliveryNotice(new BigDecimal("4"), orderB);
        var outB = saveAndAuditSalesOut(new BigDecimal("3"), noticeB);
        var returnB = saveAndAuditSalesReturn(outB, "A142 账套B退货");
        assertExactLifecycle(
            jdbcTemplate,
            sourceDocument("sales_return", "sales_return_line", "bill_id", "bill_date", returnB),
            "SALES_RETURN", PRODUCT_CODE, WAREHOUSE_CODE,
            fact("SALES_RETURN", "AUDIT", "1", "8")
        );
        assertThat(returnB).isEqualTo(returnA);
        assertReturnDetail(returnB, outB, "A142 账套B客户", "CNY");
        assertListContainsOnlyTenantCustomer("sales-return-form-list", "detail", "A142 账套B客户", returnB);

        useTenant(tenantA);
        assertReturnDetail(returnA, outA, "A142 账套A客户", "CNY");
        assertThat(countCustomersNamed("A142 账套B客户")).isZero();
        assertThat(countProductsNamed("A142 账套B销售物料")).isZero();
        assertListContainsOnlyTenantCustomer("sales-return-form-list", "detail", "A142 账套A客户", returnA);
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

    private String saveAndAuditQuote(String remark) {
        var quoteDate = jdbcTemplate.queryForObject("SELECT CURRENT_DATE", LocalDate.class);
        assertThat(quoteDate).as("数据库当前日期").isNotNull();
        var saved = salesQuoteAppService.saveDraft(new SalesQuoteAppService.SalesQuoteDraftRequest(
            null,
            CUSTOMER_CODE,
            quoteDate.toString(),
            "销售部",
            "admin",
            remark,
            quoteDate.plusDays(30).toString(),
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
                quoteDate.plusDays(5).toString()
            ))
        ));
        var billNo = generatedBillNo(saved, "销售报价单");
        salesQuoteAppService.audit(billNo);
        return billNo;
    }

    private String saveAndAuditOrder(BigDecimal qty, String quoteNo) {
        var saved = salesOrderAppService.saveDraft(new SalesOrderAppService.SalesOrderDraftRequest(
            null,
            CUSTOMER_CODE,
            "2026-06-30",
            "销售部",
            "admin",
            "A119 order",
            List.of(new SalesOrderAppService.SalesOrderLineRequest(
                null,
                PRODUCT_CODE,
                WAREHOUSE_CODE,
                quoteNo,
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
        var billNo = generatedBillNo(saved, "销售订单");
        salesOrderAppService.audit(billNo);
        return billNo;
    }

    private String saveAndAuditDeliveryNotice(BigDecimal qty, String orderNo) {
        var saved = deliveryNoticeAppService.saveDraft(new DeliveryNoticeAppService.DeliveryNoticeDraftRequest(
            null,
            orderNo,
            CUSTOMER_CODE,
            "2026-06-30",
            "销售部",
            "admin",
            "A119 delivery notice",
            List.of(new DeliveryNoticeAppService.DeliveryNoticeLineRequest(
                null,
                PRODUCT_CODE,
                WAREHOUSE_CODE,
                orderNo,
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
        var billNo = generatedBillNo(saved, "发货通知单");
        deliveryNoticeAppService.audit(billNo);
        return billNo;
    }

    private String saveAndAuditSalesOut(BigDecimal qty, String noticeNo) {
        var saved = salesOutAppService.saveDraft(new SalesOutAppService.SalesOutDraftRequest(
            null,
            noticeNo,
            CUSTOMER_CODE,
            "2026-06-30",
            "销售部",
            "admin",
            "A119 sales out",
            List.of(new SalesOutAppService.SalesOutLineRequest(
                null,
                PRODUCT_CODE,
                WAREHOUSE_CODE,
                null,
                null,
                noticeNo,
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
        var billNo = generatedBillNo(saved, "销售出库单");
        salesOutAppService.audit(billNo);
        return billNo;
    }

    private String saveAndAuditSalesReturn(String sourceOutNo, String remark) {
        var saved = salesReturnAppService.saveDraft(new SalesReturnAppService.SalesReturnDraftRequest(
            null,
            null,
            "2026-06-30",
            remark,
            List.of(new SalesReturnAppService.SalesReturnLineRequest(
                sourceOutNo,
                1,
                BigDecimal.ONE,
                "A142 return line"
            ))
        ));
        @SuppressWarnings("unchecked")
        var document = (Map<String, Object>) saved.get("document");
        var billNo = String.valueOf(document.get("billNo"));
        assertThat(billNo).as("销售退货单系统生成单号").isNotBlank();
        salesReturnAppService.audit(billNo);
        return billNo;
    }

    private void assertReturnDetail(String billNo, String sourceOutNo, String customerName, String currency) {
        var detail = salesReturnAppService.detail(billNo);
        @SuppressWarnings("unchecked")
        var document = (Map<String, Object>) detail.get("document");
        assertThat(document)
            .containsEntry("billNo", billNo)
            .containsEntry("customer", customerName)
            .containsEntry("currency", currency)
            .containsEntry("status", "AUDITED");
        assertThat(linesOf(detail, "lines"))
            .singleElement()
            .satisfies(line -> assertThat(line).containsEntry("sourceOutNo", sourceOutNo));
    }

    private void assertQuoteSelectable(String productName, String quoteNo) {
        var lines = linesOf(salesQuoteAppService.selectableLines(CUSTOMER_CODE));
        assertThat(lines)
            .singleElement()
            .satisfies(row -> {
                assertThat(row.get("billNo")).isEqualTo(quoteNo);
                assertThat(row.get("productName")).isEqualTo(productName);
            });
    }

    private void assertQuoteConsumed() {
        assertThat(linesOf(salesQuoteAppService.selectableLines(CUSTOMER_CODE))).isEmpty();
    }

    private void assertOrderSelectableStock(String productName, String orderNo, String onHand, String reserved, String available) {
        var lines = linesOf(salesOrderAppService.selectableLines(CUSTOMER_CODE));
        assertThat(lines)
            .singleElement()
            .satisfies(row -> {
                assertThat(row.get("billNo")).isEqualTo(orderNo);
                assertThat(row.get("productName")).isEqualTo(productName);
                assertDecimal(row.get("stockOnHand"), onHand);
                assertDecimal(row.get("stockReserved"), reserved);
                assertDecimal(row.get("stockAvailable"), available);
            });
    }

    private void assertOrderDetailStock(String orderNo, String onHand, String reserved, String available) {
        var lines = linesOf(salesOrderAppService.detail(orderNo), "lines");
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

    private void assertDeliverySelectableRemaining(String noticeNo, String remainingQty) {
        var lines = linesOf(deliveryNoticeAppService.selectableLines(CUSTOMER_CODE));
        assertThat(lines)
            .singleElement()
            .satisfies(row -> {
                assertThat(row.get("billNo")).isEqualTo(noticeNo);
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

    private String generatedBillNo(Map<String, Object> saved, String label) {
        var billNo = (String) saved.get("billNo");
        assertThat(billNo).as(label + "系统生成单号").isNotBlank();
        return billNo;
    }

    private SourceDocument sourceDocument(
        String headerTable,
        String lineTable,
        String lineBillColumn,
        String headerDateColumn,
        String billNo
    ) {
        return new SourceDocument(headerTable, lineTable, lineBillColumn, headerDateColumn, billNo);
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
