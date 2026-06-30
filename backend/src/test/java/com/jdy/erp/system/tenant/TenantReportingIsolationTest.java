package com.jdy.erp.system.tenant;

import static org.assertj.core.api.Assertions.assertThat;

import java.math.BigDecimal;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.UUID;

import com.jdy.erp.inventory.application.OpeningStockService;
import com.jdy.erp.masterdata.api.MasterDataController;
import com.jdy.erp.production.application.ProductionTaskAppService;
import com.jdy.erp.purchase.application.PurchaseInAppService;
import com.jdy.erp.purchase.application.PurchaseOrderAppService;
import com.jdy.erp.reports.api.DocumentOutputController;
import com.jdy.erp.sales.application.DeliveryNoticeAppService;
import com.jdy.erp.sales.application.SalesOrderAppService;
import com.jdy.erp.sales.application.SalesOutAppService;
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
class TenantReportingIsolationTest {
    private static final String PARENT_CODE = "A119-RPT-FG";
    private static final String COMPONENT_CODE = "A119-RPT-MAT";
    private static final String CUSTOMER_CODE = "A119-RPT-CUST";
    private static final String SUPPLIER_CODE = "A119-RPT-SUP";
    private static final String DEPARTMENT_CODE = "A119-RPT-DEPT";
    private static final String WAREHOUSE_CODE = "CK-001";
    private static final String BOM_CODE = "BOM-A119-RPT";
    private static final String SALES_ORDER_NO = "A119-RPT-SO";
    private static final String DELIVERY_NOTICE_NO = "A119-RPT-DN";
    private static final String SALES_OUT_NO = "A119-RPT-SOUT";
    private static final String PURCHASE_ORDER_NO = "A119-RPT-PO";
    private static final String PURCHASE_IN_NO = "A119-RPT-PIN";
    private static final String PLAN_NO = "A119-RPT-PLAN";

    @Autowired
    private AccountSetManagementService accountSetManagementService;

    @Autowired
    private CurrentSessionService currentSessionService;

    @Autowired
    private MasterDataController masterDataController;

    @Autowired
    private OpeningStockService openingStockService;

    @Autowired
    private SalesOrderAppService salesOrderAppService;

    @Autowired
    private DeliveryNoticeAppService deliveryNoticeAppService;

    @Autowired
    private SalesOutAppService salesOutAppService;

    @Autowired
    private PurchaseOrderAppService purchaseOrderAppService;

    @Autowired
    private PurchaseInAppService purchaseInAppService;

    @Autowired
    private ProductionTaskAppService productionTaskAppService;

    @Autowired
    private ListStubController listStubController;

    @Autowired
    private DocumentOutputController documentOutputController;

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
    void reportsExportsPrintsAndTemplatesAreTenantScoped() {
        var tenantA = createManagedAccountSet("A119RPA");
        var tenantB = createManagedAccountSet("A119RPB");

        useTenant(tenantA);
        var tenantAState = createReportFixture(
            "A119 报表A客户",
            "A119 报表A供应商",
            "A119 报表A成品",
            "A119 报表A材料",
            "A119 报表A公司",
            new BigDecimal("9"),
            new BigDecimal("12"),
            new BigDecimal("3"),
            new BigDecimal("7"),
            new BigDecimal("4"),
            new BigDecimal("5"),
            new BigDecimal("20"),
            new BigDecimal("30")
        );
        assertReportState(tenantAState);

        useTenant(tenantB);
        var tenantBState = createReportFixture(
            "A119 报表B客户",
            "A119 报表B供应商",
            "A119 报表B成品",
            "A119 报表B材料",
            "A119 报表B公司",
            new BigDecimal("2"),
            new BigDecimal("3"),
            BigDecimal.ONE,
            new BigDecimal("2"),
            BigDecimal.ONE,
            BigDecimal.ONE,
            new BigDecimal("5"),
            new BigDecimal("8")
        );
        assertReportState(tenantBState);
        assertRowsEmpty("inventory-query-list", tenantAState.componentName());
        assertRowsEmpty("purchase-summary-report", tenantAState.supplierName());

        useTenant(tenantA);
        assertReportState(tenantAState);
        assertRowsEmpty("inventory-query-list", tenantBState.componentName());
        assertRowsEmpty("purchase-summary-report", tenantBState.supplierName());
    }

    private ReportState createReportFixture(
        String customerName,
        String supplierName,
        String parentName,
        String componentName,
        String companyName,
        BigDecimal parentOpeningQty,
        BigDecimal componentOpeningQty,
        BigDecimal salesQty,
        BigDecimal purchaseOrderQty,
        BigDecimal purchaseInQty,
        BigDecimal planQty,
        BigDecimal safetyQty,
        BigDecimal maxQty
    ) {
        createMasterData(customerName, supplierName, parentName, componentName);
        saveOpeningStock(PARENT_CODE, parentOpeningQty);
        saveOpeningStock(COMPONENT_CODE, componentOpeningQty);
        saveStockAlertSetting(safetyQty, maxQty);
        saveAndAuditSalesOrder(salesQty);
        saveAndAuditDeliveryNotice(salesQty);
        saveAndAuditSalesOut(salesQty);
        saveAndAuditPurchaseOrder(purchaseOrderQty);
        saveAndAuditPurchaseIn(purchaseInQty);
        createAuditedBom();
        createPlan(planQty);
        var taskBillNo = pushDownPlan();
        savePrintTemplate(companyName);
        return new ReportState(
            customerName,
            supplierName,
            parentName,
            componentName,
            companyName,
            taskBillNo,
            parentOpeningQty.subtract(salesQty),
            componentOpeningQty.add(purchaseInQty),
            salesQty,
            purchaseOrderQty,
            purchaseInQty,
            planQty.multiply(new BigDecimal("2")),
            safetyQty
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
        currentSessionService.login("admin", "admin123", code);
        TenantContext.setTenant(currentSessionService.currentAccountSet());
    }

    private void createMasterData(String customerName, String supplierName, String parentName, String componentName) {
        masterDataController.create("productionDepartment", Map.of(
            "code", DEPARTMENT_CODE,
            "name", "A119 报表车间"
        ));
        masterDataController.audit("productionDepartment", DEPARTMENT_CODE);
        masterDataController.create("customer", Map.of(
            "code", CUSTOMER_CODE,
            "name", customerName
        ));
        masterDataController.audit("customer", CUSTOMER_CODE);
        masterDataController.create("supplier", Map.of(
            "code", SUPPLIER_CODE,
            "name", supplierName
        ));
        masterDataController.audit("supplier", SUPPLIER_CODE);
        masterDataController.create("product", Map.ofEntries(
            Map.entry("code", PARENT_CODE),
            Map.entry("name", parentName),
            Map.entry("category", "FINISHED"),
            Map.entry("unit", "PCS"),
            Map.entry("defaultWarehouseCode", WAREHOUSE_CODE),
            Map.entry("defaultWorkshop", DEPARTMENT_CODE),
            Map.entry("isSale", "true"),
            Map.entry("isInventory", "true"),
            Map.entry("isProduce", "true")
        ));
        masterDataController.audit("product", PARENT_CODE);
        masterDataController.create("product", Map.ofEntries(
            Map.entry("code", COMPONENT_CODE),
            Map.entry("name", componentName),
            Map.entry("category", "RAW"),
            Map.entry("unit", "PCS"),
            Map.entry("defaultWarehouseCode", WAREHOUSE_CODE),
            Map.entry("defaultSupplierCode", SUPPLIER_CODE),
            Map.entry("isPurchase", "true"),
            Map.entry("isInventory", "true")
        ));
        masterDataController.audit("product", COMPONENT_CODE);
    }

    private void saveOpeningStock(String productCode, BigDecimal qty) {
        openingStockService.saveRows(List.of(new OpeningStockService.OpeningStockLineRequest(
            productCode,
            WAREHOUSE_CODE,
            qty,
            BigDecimal.ONE,
            "A119-4-7 reporting"
        )));
    }

    private void saveStockAlertSetting(BigDecimal safetyQty, BigDecimal maxQty) {
        jdbcTemplate.update("""
            INSERT INTO inv_safety_stock_setting (product_id, warehouse_id, safety_qty, max_qty)
            SELECT p.id, w.id, ?, ?
            FROM md_product p
            JOIN md_warehouse w ON w.code = ?
            WHERE p.code = ?
            ON CONFLICT (product_id, warehouse_id) DO UPDATE
            SET safety_qty = EXCLUDED.safety_qty,
                max_qty = EXCLUDED.max_qty,
                updated_at = now()
            """, safetyQty, maxQty, WAREHOUSE_CODE, COMPONENT_CODE);
    }

    private void saveAndAuditSalesOrder(BigDecimal qty) {
        salesOrderAppService.saveDraft(new SalesOrderAppService.SalesOrderDraftRequest(
            SALES_ORDER_NO,
            CUSTOMER_CODE,
            "2026-06-30",
            "销售部",
            "admin",
            "A119 reporting sales order",
            false,
            List.of(new SalesOrderAppService.SalesOrderLineRequest(
                null,
                PARENT_CODE,
                WAREHOUSE_CODE,
                null,
                null,
                qty,
                new BigDecimal("15"),
                new BigDecimal("13"),
                "CM-A119-RPT",
                "CO-A119-RPT",
                "A119 reporting order line",
                "2026-07-05"
            ))
        ));
        salesOrderAppService.audit(SALES_ORDER_NO);
    }

    private void saveAndAuditDeliveryNotice(BigDecimal qty) {
        deliveryNoticeAppService.saveDraft(new DeliveryNoticeAppService.DeliveryNoticeDraftRequest(
            DELIVERY_NOTICE_NO,
            SALES_ORDER_NO,
            CUSTOMER_CODE,
            "2026-06-30",
            "销售部",
            "admin",
            "A119 reporting delivery notice",
            false,
            List.of(new DeliveryNoticeAppService.DeliveryNoticeLineRequest(
                null,
                PARENT_CODE,
                WAREHOUSE_CODE,
                SALES_ORDER_NO,
                1,
                qty,
                new BigDecimal("15"),
                new BigDecimal("13"),
                "CM-A119-RPT",
                "CO-A119-RPT",
                "A119 reporting delivery line",
                "2026-07-05"
            ))
        ));
        deliveryNoticeAppService.audit(DELIVERY_NOTICE_NO);
    }

    private void saveAndAuditSalesOut(BigDecimal qty) {
        salesOutAppService.saveDraft(new SalesOutAppService.SalesOutDraftRequest(
            SALES_OUT_NO,
            DELIVERY_NOTICE_NO,
            CUSTOMER_CODE,
            "2026-06-30",
            "销售部",
            "admin",
            "A119 reporting sales out",
            false,
            List.of(new SalesOutAppService.SalesOutLineRequest(
                null,
                PARENT_CODE,
                WAREHOUSE_CODE,
                null,
                null,
                DELIVERY_NOTICE_NO,
                1,
                qty,
                new BigDecimal("15"),
                new BigDecimal("13"),
                "CM-A119-RPT",
                "CO-A119-RPT",
                "A119 reporting out line",
                "2026-07-05"
            ))
        ));
        salesOutAppService.audit(SALES_OUT_NO);
    }

    private void saveAndAuditPurchaseOrder(BigDecimal qty) {
        purchaseOrderAppService.saveDraft(new PurchaseOrderAppService.PurchaseOrderDraftRequest(
            PURCHASE_ORDER_NO,
            SUPPLIER_CODE,
            "2026-06-30",
            "采购部",
            "admin",
            false,
            List.of(new PurchaseOrderAppService.PurchaseOrderLineRequest(
                null,
                COMPONENT_CODE,
                WAREHOUSE_CODE,
                qty,
                new BigDecimal("10"),
                new BigDecimal("13"),
                "A119 reporting purchase order line",
                "SM-A119-RPT",
                null,
                null,
                "2026-07-05"
            ))
        ));
        purchaseOrderAppService.audit(PURCHASE_ORDER_NO);
    }

    private void saveAndAuditPurchaseIn(BigDecimal qty) {
        purchaseInAppService.saveDraft(new PurchaseInAppService.PurchaseInDraftRequest(
            PURCHASE_IN_NO,
            PURCHASE_ORDER_NO,
            SUPPLIER_CODE,
            "2026-06-30",
            "采购部",
            "admin",
            false,
            List.of(new PurchaseInAppService.PurchaseInLineRequest(
                null,
                COMPONENT_CODE,
                WAREHOUSE_CODE,
                PURCHASE_ORDER_NO,
                1,
                qty,
                new BigDecimal("10"),
                new BigDecimal("13"),
                "A119 reporting purchase in line"
            ))
        ));
        purchaseInAppService.audit(PURCHASE_IN_NO);
    }

    private void createAuditedBom() {
        productionTaskAppService.saveBom(new ProductionTaskAppService.BomRequest(
            BOM_CODE,
            PARENT_CODE,
            BigDecimal.ONE,
            "生产BOM",
            "",
            List.of(new ProductionTaskAppService.BomLineRequest(
                COMPONENT_CODE,
                new BigDecimal("2"),
                BigDecimal.ONE,
                new BigDecimal("2"),
                new BigDecimal("2"),
                "按单领料",
                WAREHOUSE_CODE,
                BigDecimal.ZERO,
                BigDecimal.ZERO,
                null
            ))
        ));
        productionTaskAppService.auditBom(BOM_CODE);
    }

    private void createPlan(BigDecimal qty) {
        productionTaskAppService.createPlan(new ProductionTaskAppService.PlanRequest(
            PLAN_NO,
            PARENT_CODE,
            null,
            null,
            qty,
            "SELF",
            null,
            "2026-07-05"
        ));
    }

    private String pushDownPlan() {
        var result = productionTaskAppService.pushDownPlan(PLAN_NO);
        @SuppressWarnings("unchecked")
        var tasks = (List<Map<String, Object>>) result.get("productionTasks");
        assertThat(tasks).singleElement();
        return String.valueOf(tasks.get(0).get("billNo"));
    }

    private void savePrintTemplate(String companyName) {
        documentOutputController.savePrintTemplate(
            "sales-order",
            new DocumentOutputController.PrintTemplateRequest(
                "A119-RPT",
                "A119 报表隔离模板",
                null,
                companyName,
                "A119 报表隔离页眉",
                "A119 报表隔离页脚",
                true,
                false,
                true,
                "A4",
                "PORTRAIT",
                BigDecimal.valueOf(12),
                BigDecimal.valueOf(12),
                BigDecimal.valueOf(12),
                BigDecimal.valueOf(12),
                1
            )
        );
    }

    private void assertReportState(ReportState state) {
        assertThat(singleRow("inventory-query-list", state.componentName()))
            .satisfies(row -> {
                assertThat(row.get("name")).isEqualTo(state.componentName());
                assertThat(row.get("available")).isEqualTo(decimalText(state.componentAvailable()));
            });
        assertThat(singleRow("stock-alert-list", state.componentName()))
            .satisfies(row -> {
                assertThat(row.get("productName")).isEqualTo(state.componentName());
                assertThat(row.get("available")).isEqualTo(decimalText(state.componentAvailable()));
                assertThat(row.get("safetyQty")).isEqualTo(decimalText(state.safetyQty()));
            });
        assertThat(singleRow("purchase-summary-report", state.supplierName()))
            .satisfies(row -> {
                assertThat(row.get("supplier")).isEqualTo(state.supplierName());
                assertThat(row.get("productName")).isEqualTo(state.componentName());
                assertThat(row.get("orderQty")).isEqualTo(decimalText(state.purchaseOrderQty()));
                assertThat(row.get("inQty")).isEqualTo(decimalText(state.purchaseInQty()));
                assertThat(row.get("remainingQty")).isEqualTo(decimalText(state.purchaseOrderQty().subtract(state.purchaseInQty())));
            });
        assertThat(singleRow("kit-analysis-list", state.componentName()))
            .satisfies(row -> {
                assertThat(row.get("materialName")).isEqualTo(state.componentName());
                assertThat(row.get("requiredQty")).isEqualTo(decimalText(state.requiredQty()));
                assertThat(row.get("availableQty")).isEqualTo(decimalText(state.componentAvailable()));
            });
        assertThat(singleRow("task-track-report", state.taskBillNo()))
            .satisfies(row -> {
                assertThat(row.get("billNo")).isEqualTo(state.taskBillNo());
                assertThat(row.get("productName")).isEqualTo(state.parentName());
            });
        assertThat(singleRow("receivable-list", state.customerName()))
            .satisfies(row -> {
                assertThat(row.get("billNo")).isEqualTo("YS-" + SALES_OUT_NO);
                assertThat(row.get("customer")).isEqualTo(state.customerName());
            });
        assertThat(singleRow("payable-list", state.supplierName()))
            .satisfies(row -> {
                assertThat(row.get("billNo")).isEqualTo("YF-" + PURCHASE_IN_NO);
                assertThat(row.get("supplier")).isEqualTo(state.supplierName());
            });
        assertListExportContainsOnlyTenant("purchase-summary-report", state.supplierName(), state.componentName());
        assertDocumentOutput(state);
        assertPrintTemplate(state.companyName());
    }

    private Map<String, Object> singleRow(String listKey, String keyword) {
        @SuppressWarnings("unchecked")
        var rows = (List<Map<String, Object>>) listStubController.rows(
            listKey,
            keyword,
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
        assertThat(rows).singleElement();
        return rows.get(0);
    }

    private void assertRowsEmpty(String listKey, String keyword) {
        @SuppressWarnings("unchecked")
        var rows = (List<Map<String, Object>>) listStubController.rows(
            listKey,
            keyword,
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
        assertThat(rows).isEmpty();
    }

    private void assertListExportContainsOnlyTenant(String listKey, String keyword, String expectedText) {
        var csv = listStubController.exportCsv(listKey, keyword, "", 1000, "header", "", "asc", "", "", "", "", "", "", "").getBody();
        assertThat(csv).contains(keyword).contains(expectedText);
    }

    private void assertDocumentOutput(ReportState state) {
        var html = documentOutputController.printHtml("sales-order", SALES_ORDER_NO).getBody();
        assertThat(html)
            .contains(state.companyName())
            .contains(state.customerName())
            .contains(state.parentName())
            .doesNotContain(oppositeMarker(state.companyName()))
            .doesNotContain(oppositeMarker(state.customerName()));
        var csv = documentOutputController.exportCsv("sales-order", SALES_ORDER_NO).getBody();
        assertThat(csv)
            .contains(state.customerName())
            .contains(state.parentName())
            .doesNotContain(oppositeMarker(state.customerName()))
            .doesNotContain(oppositeMarker(state.parentName()));
    }

    private void assertPrintTemplate(String companyName) {
        var template = documentOutputController.printTemplateConfig("sales-order");
        assertThat(template.get("companyName")).isEqualTo(companyName);
        var templates = documentOutputController.printTemplates();
        assertThat(templates)
            .filteredOn(row -> "sales-order".equals(row.get("documentType")))
            .singleElement()
            .satisfies(row -> assertThat(row.get("companyName")).isEqualTo(companyName));
    }

    private String oppositeMarker(String text) {
        if (text.contains("报表A")) {
            return text.replace("报表A", "报表B");
        }
        if (text.contains("报表B")) {
            return text.replace("报表B", "报表A");
        }
        return "__no_opposite_marker__";
    }

    private String decimalText(BigDecimal value) {
        return value.stripTrailingZeros().toPlainString();
    }

    private String quoteIdentifier(String identifier) {
        return "\"" + identifier.replace("\"", "\"\"") + "\"";
    }

    private record ReportState(
        String customerName,
        String supplierName,
        String parentName,
        String componentName,
        String companyName,
        String taskBillNo,
        BigDecimal parentAvailable,
        BigDecimal componentAvailable,
        BigDecimal salesQty,
        BigDecimal purchaseOrderQty,
        BigDecimal purchaseInQty,
        BigDecimal requiredQty,
        BigDecimal safetyQty
    ) {
    }
}
