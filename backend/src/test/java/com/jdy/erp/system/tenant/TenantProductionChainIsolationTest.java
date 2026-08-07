package com.jdy.erp.system.tenant;

import static org.assertj.core.api.Assertions.assertThat;
import static com.jdy.erp.testsupport.InventoryTraceAssertions.assertExactLifecycle;
import static com.jdy.erp.testsupport.InventoryTraceAssertions.fact;
import static com.jdy.erp.testsupport.InventoryTraceAssertions.reversal;

import java.math.BigDecimal;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.UUID;

import com.jdy.erp.inventory.application.OpeningStockService;
import com.jdy.erp.masterdata.api.MasterDataController;
import com.jdy.erp.production.application.MaterialIssueAppService;
import com.jdy.erp.production.application.ProductInAppService;
import com.jdy.erp.production.application.ProductionTaskAppService;
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
class TenantProductionChainIsolationTest {
    private static final String PARENT_CODE = "A119-PROD-FG";
    private static final String COMPONENT_CODE = "A119-PROD-MAT";
    private static final String SUPPLIER_CODE = "A119-PROD-SUP";
    private static final String DEPARTMENT_CODE = "A119-PROD-DEPT";
    private static final String WAREHOUSE_CODE = "CK-001";
    private static final String BOM_CODE = "BOM-A119-PROD";

    @Autowired
    private AccountSetManagementService accountSetManagementService;

    @Autowired
    private CurrentSessionService currentSessionService;

    @Autowired
    private MasterDataController masterDataController;

    @Autowired
    private OpeningStockService openingStockService;

    @Autowired
    private ProductionTaskAppService productionTaskAppService;

    @Autowired
    private MaterialIssueAppService materialIssueAppService;

    @Autowired
    private ProductInAppService productInAppService;

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
    void productionPlanTaskIssueCompletionAndKitAnalysisAreTenantScoped() {
        var tenantA = createManagedAccountSet("A119PRA");
        var tenantB = createManagedAccountSet("A119PRB");

        useTenant(tenantA);
        createProductionSetup("A119 账套A母件", "A119 账套A子件", "A119 账套A供应商");
        saveComponentOpeningStock(new BigDecimal("30"));
        createAuditedBom();
        var planNoA = createPlan(new BigDecimal("5"));
        assertKitAnalysis(planNoA, "A119 账套A子件", "10.0000", "30.0000", "0.0000");
        var taskBillNoA = pushDownPlanAndAssertPurchaseRequisition(planNoA, "A119 账套A供应商", "A119 账套A子件", "10.0000");
        var issueNoA = saveAndAuditIssue(taskBillNoA);
        assertBalance(COMPONENT_CODE, "20.0000", "0.0000", "20.0000");
        var productInNoA = completeFromIssue(issueNoA, new BigDecimal("5"));
        assertExactLifecycle(
            jdbcTemplate,
            productInDocument(productInNoA),
            "PRODUCTION_COMPLETION", PARENT_CODE, WAREHOUSE_CODE,
            fact("PRODUCTION_COMPLETE", "AUDIT", "5", "5")
        );
        productInAppService.reverse(productInNoA);
        assertExactLifecycle(
            jdbcTemplate,
            productInDocument(productInNoA),
            "PRODUCTION_COMPLETION", PARENT_CODE, WAREHOUSE_CODE,
            fact("PRODUCTION_COMPLETE", "AUDIT", "5", "5"),
            reversal("PRODUCTION_COMPLETE_REVERSE", "REVERSE", "-5", "0", 0)
        );
        productInAppService.audit(productInNoA);
        assertExactLifecycle(
            jdbcTemplate,
            productInDocument(productInNoA),
            "PRODUCTION_COMPLETION", PARENT_CODE, WAREHOUSE_CODE,
            fact("PRODUCTION_COMPLETE", "AUDIT", "5", "5"),
            reversal("PRODUCTION_COMPLETE_REVERSE", "REVERSE", "-5", "0", 0),
            fact("PRODUCTION_COMPLETE", "AUDIT", "5", "5")
        );
        assertBalance(PARENT_CODE, "5.0000", "0.0000", "5.0000");
        assertKitAnalysis(planNoA, "A119 账套A子件", "10.0000", "20.0000", "0.0000");
        assertListContainsSingle("production-plan-list", "A119 账套A母件", planNoA);
        assertListContainsSingle("production-task-list", taskBillNoA, taskBillNoA);
        assertListContainsSingle("material-issue-list", issueNoA, issueNoA);
        assertListContainsSingle("product-in-list", productInNoA, productInNoA);

        useTenant(tenantB);
        createProductionSetup("A119 账套B母件", "A119 账套B子件", "A119 账套B供应商");
        saveComponentOpeningStock(new BigDecimal("4"));
        createAuditedBom();
        var planNoB = createPlan(BigDecimal.ONE);
        assertKitAnalysis(planNoB, "A119 账套B子件", "2.0000", "4.0000", "0.0000");
        var taskBillNoB = pushDownPlanAndAssertPurchaseRequisition(planNoB, "A119 账套B供应商", "A119 账套B子件", "2.0000");
        var issueNoB = saveAndAuditIssue(taskBillNoB);
        assertBalance(COMPONENT_CODE, "2.0000", "0.0000", "2.0000");
        var productInNoB = completeFromIssue(issueNoB, BigDecimal.ONE);
        assertExactLifecycle(
            jdbcTemplate,
            productInDocument(productInNoB),
            "PRODUCTION_COMPLETION", PARENT_CODE, WAREHOUSE_CODE,
            fact("PRODUCTION_COMPLETE", "AUDIT", "1", "1")
        );
        assertBalance(PARENT_CODE, "1.0000", "0.0000", "1.0000");
        assertThat(countProductsNamed("A119 账套A母件")).isZero();
        assertThat(countProductsNamed("A119 账套A子件")).isZero();
        assertListContainsSingle("production-plan-list", "A119 账套B母件", planNoB);
        assertListContainsSingle("production-task-list", taskBillNoB, taskBillNoB);

        useTenant(tenantA);
        assertKitAnalysis(planNoA, "A119 账套A子件", "10.0000", "20.0000", "0.0000");
        assertBalance(COMPONENT_CODE, "20.0000", "0.0000", "20.0000");
        assertBalance(PARENT_CODE, "5.0000", "0.0000", "5.0000");
        assertThat(countProductsNamed("A119 账套B母件")).isZero();
        assertThat(countProductsNamed("A119 账套B子件")).isZero();
        assertListContainsSingle("production-plan-list", "A119 账套A母件", planNoA);
        assertListContainsSingle("product-in-list", productInNoA, productInNoA);
    }

    @Test
    void materialIssueDraftKeepsRequestedQtyAndShowsTaskContext() {
        var tenant = createManagedAccountSet("A119PRQ");
        useTenant(tenant);
        createProductionSetup("A119 数量母件", "A119 数量子件", "A119 数量供应商");
        saveComponentOpeningStock(new BigDecimal("30"));
        createAuditedBom();
        var planNo = createPlan(new BigDecimal("5"));
        var taskBillNo = pushDownPlanAndAssertPurchaseRequisition(planNo, "A119 数量供应商", "A119 数量子件", "10.0000");

        var savedIssue = materialIssueAppService.saveDraft(new MaterialIssueAppService.IssueDraftRequest(
            null,
            taskBillNo,
            WAREHOUSE_CODE,
            List.of(new MaterialIssueAppService.IssueLineRequest(null, null, COMPONENT_CODE, WAREHOUSE_CODE, new BigDecimal("3")))
        ));
        var issueNo = generatedBillNo(savedIssue, "生产领料单");

        var detail = materialIssueAppService.detail(issueNo);
        @SuppressWarnings("unchecked")
        var productInfo = (Map<String, Object>) detail.get("productInfo");
        assertThat(productInfo.get("productCode")).isEqualTo(PARENT_CODE);
        assertDecimal(productInfo.get("taskQty"), "5.0000");
        assertDecimal(productInfo.get("remainingQty"), "5.0000");

        @SuppressWarnings("unchecked")
        var lines = (List<Map<String, Object>>) detail.get("lines");
        assertThat(lines)
            .singleElement()
            .satisfies(row -> {
                assertThat(row.get("productCode")).isEqualTo(COMPONENT_CODE);
                assertDecimal(row.get("remainingQty"), "10.0000");
                assertDecimal(row.get("stockAvailable"), "30.0000");
                assertDecimal(row.get("qty"), "3.0000");
            });
    }

    @Test
    void materialIssueDraftMatchesRequestedQtyBySourceLineNoWhenComponentRepeats() {
        var tenant = createManagedAccountSet("A119DUP");
        useTenant(tenant);
        createProductionSetup("A119 重复母件", "A119 重复子件", "A119 重复供应商");
        saveComponentOpeningStock(new BigDecimal("30"));
        createAuditedDuplicateBom();
        var planNo = createPlan(BigDecimal.ONE);
        var result = productionTaskAppService.pushDownPlan(planNo);
        @SuppressWarnings("unchecked")
        var tasks = (List<Map<String, Object>>) result.get("productionTasks");
        var taskBillNo = String.valueOf(tasks.get(0).get("billNo"));
        productionTaskAppService.auditTask(taskBillNo);

        var savedIssue = materialIssueAppService.saveDraft(new MaterialIssueAppService.IssueDraftRequest(
            null,
            taskBillNo,
            WAREHOUSE_CODE,
            List.of(
                new MaterialIssueAppService.IssueLineRequest(null, 1, COMPONENT_CODE, WAREHOUSE_CODE, new BigDecimal("1")),
                new MaterialIssueAppService.IssueLineRequest(null, 2, COMPONENT_CODE, WAREHOUSE_CODE, new BigDecimal("2"))
            )
        ));
        var issueNo = generatedBillNo(savedIssue, "生产领料单");

        var detail = materialIssueAppService.detail(issueNo);
        @SuppressWarnings("unchecked")
        var lines = (List<Map<String, Object>>) detail.get("lines");
        assertThat(lines).hasSize(2);
        assertThat(lines).allSatisfy(row -> assertThat(row.get("productCode")).isEqualTo(COMPONENT_CODE));
        assertThat(lines.get(0).get("sourceLineNo")).isEqualTo(1);
        assertDecimal(lines.get(0).get("qty"), "1.0000");
        assertThat(lines.get(1).get("sourceLineNo")).isEqualTo(2);
        assertDecimal(lines.get(1).get("qty"), "2.0000");
    }

    @Test
    void materialIssueReverseRestoresTaskIssuedQtyAndInventory() {
        var tenant = createManagedAccountSet("A119RVI");
        useTenant(tenant);
        createProductionSetup("A119 反审母件", "A119 反审子件", "A119 反审供应商");
        saveComponentOpeningStock(new BigDecimal("30"));
        createAuditedBom();
        var planNo = createPlan(new BigDecimal("5"));
        var taskBillNo = pushDownPlanAndAssertPurchaseRequisition(planNo, "A119 反审供应商", "A119 反审子件", "10.0000");

        var issueNo = saveAndAuditIssue(taskBillNo);
        assertTaskIssued(taskBillNo, "5.0000", "AUDITED");
        assertTaskSnapshotIssued(taskBillNo, "10.0000");
        assertBalance(COMPONENT_CODE, "20.0000", "0.0000", "20.0000");

        materialIssueAppService.reverse(issueNo);

        assertTaskIssued(taskBillNo, "0.0000", "AUDITED");
        assertTaskSnapshotIssued(taskBillNo, "0.0000");
        assertBalance(COMPONENT_CODE, "30.0000", "0.0000", "30.0000");
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

    private void createProductionSetup(String parentName, String componentName, String supplierName) {
        masterDataController.create("productionDepartment", Map.of(
            "code", DEPARTMENT_CODE,
            "name", "A119 生产车间"
        ));
        masterDataController.audit("productionDepartment", DEPARTMENT_CODE);
        masterDataController.create("supplier", Map.of(
            "code", SUPPLIER_CODE,
            "name", supplierName
        ));
        masterDataController.audit("supplier", SUPPLIER_CODE);
        createAuditedProductName("PN-" + PARENT_CODE, parentName);
        createAuditedProductName("PN-" + COMPONENT_CODE, componentName);
        masterDataController.create("product", Map.ofEntries(
            Map.entry("code", PARENT_CODE),
            Map.entry("name", parentName),
            Map.entry("category", "RAW"),
            Map.entry("unit", "PCS"),
            Map.entry("defaultWarehouseCode", WAREHOUSE_CODE),
            Map.entry("defaultWorkshop", DEPARTMENT_CODE),
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
            Map.entry("isInventory", "true"),
            Map.entry("isPurchase", "true")
        ));
        masterDataController.audit("product", COMPONENT_CODE);
    }

    private void createAuditedProductName(String code, String name) {
        masterDataController.create("productName", Map.of(
            "code", code,
            "name", name
        ));
        masterDataController.audit("productName", code);
    }

    private void saveComponentOpeningStock(BigDecimal qty) {
        openingStockService.saveRows(List.of(new OpeningStockService.OpeningStockLineRequest(
            COMPONENT_CODE,
            WAREHOUSE_CODE,
            qty,
            BigDecimal.ONE,
            "A119-4-5 production chain"
        )));
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

    private void createAuditedDuplicateBom() {
        productionTaskAppService.saveBom(new ProductionTaskAppService.BomRequest(
            BOM_CODE,
            PARENT_CODE,
            BigDecimal.ONE,
            "生产BOM",
            "",
            List.of(
                new ProductionTaskAppService.BomLineRequest(
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
                ),
                new ProductionTaskAppService.BomLineRequest(
                    COMPONENT_CODE,
                    new BigDecimal("4"),
                    BigDecimal.ONE,
                    new BigDecimal("4"),
                    new BigDecimal("4"),
                    "按单领料",
                    WAREHOUSE_CODE,
                    BigDecimal.ZERO,
                    BigDecimal.ZERO,
                    null
                )
            )
        ));
        productionTaskAppService.auditBom(BOM_CODE);
    }

    private String createPlan(BigDecimal qty) {
        var saved = productionTaskAppService.createPlan(new ProductionTaskAppService.PlanRequest(
            null,
            PARENT_CODE,
            null,
            null,
            qty,
            "SELF",
            null,
            "2026-07-05"
        ));
        var planNo = generatedBillNo(saved, "生产计划");
        productionTaskAppService.auditPlan(planNo);
        return planNo;
    }

    private String pushDownPlanAndAssertPurchaseRequisition(String planNo, String supplierName, String productName, String qty) {
        var result = productionTaskAppService.pushDownPlan(planNo);
        @SuppressWarnings("unchecked")
        var tasks = (List<Map<String, Object>>) result.get("productionTasks");
        assertThat(tasks).singleElement().satisfies(row -> assertDecimal(row.get("qty"), qty.equals("10.0000") ? "5.0000" : "1.0000"));
        @SuppressWarnings("unchecked")
        var requisitions = (List<Map<String, Object>>) result.get("purchaseRequisitions");
        assertThat(requisitions)
            .singleElement()
            .satisfies(row -> assertThat(row.get("supplier")).isEqualTo(supplierName));
        assertListContainsSingle("purchase-requisition-list", supplierName, String.valueOf(requisitions.get(0).get("billNo")));
        var lines = selectableRequisitionLines(supplierName);
        assertThat(lines)
            .singleElement()
            .satisfies(row -> {
                assertThat(row.get("productName")).isEqualTo(productName);
                assertDecimal(row.get("remainingQty"), qty);
            });
        var taskBillNo = String.valueOf(tasks.get(0).get("billNo"));
        productionTaskAppService.auditTask(taskBillNo);
        return taskBillNo;
    }

    private String saveAndAuditIssue(String taskBillNo) {
        var saved = materialIssueAppService.saveDraft(new MaterialIssueAppService.IssueDraftRequest(
            null,
            taskBillNo,
            WAREHOUSE_CODE,
            List.of(new MaterialIssueAppService.IssueLineRequest(null, null, null, WAREHOUSE_CODE, null))
        ));
        var issueNo = generatedBillNo(saved, "生产领料单");
        materialIssueAppService.audit(issueNo);
        return issueNo;
    }

    private String completeFromIssue(String issueNo, BigDecimal qty) {
        var saved = productInAppService.completeFromIssue(issueNo, new ProductInAppService.CompleteRequest(
            null,
            qty,
            null
        ));
        var productInNo = generatedBillNo(saved, "产品入库单");
        jdbcTemplate.update("""
            UPDATE production_completion
            SET created_at = TIMESTAMPTZ '2026-07-13 16:30:00+00'
            WHERE bill_no = ?
            """, productInNo);
        productInAppService.audit(productInNo);
        @SuppressWarnings("unchecked")
        var document = (Map<String, Object>) productInAppService.detail(productInNo).get("document");
        assertThat(document.get("billDate")).isEqualTo("2026-07-14");
        return productInNo;
    }

    private void assertKitAnalysis(String planNo, String productName, String requiredQty, String availableQty, String shortageQty) {
        var rows = productionTaskAppService.kitAnalysis(planNo);
        assertThat(rows)
            .singleElement()
            .satisfies(row -> {
                assertThat(row.get("materialName")).isEqualTo(productName);
                assertDecimal(row.get("requiredQty"), requiredQty);
                assertDecimal(row.get("availableQty"), availableQty);
                assertDecimal(row.get("shortageQty"), shortageQty);
            });
        assertListContainsSingleField("kit-analysis-list", productName, "planNo", planNo);
    }

    private void assertBalance(String productCode, String onHand, String reserved, String available) {
        var row = jdbcTemplate.queryForMap("""
            SELECT b.qty_on_hand AS "onHand",
                   b.qty_reserved AS reserved,
                   b.qty_available AS available
            FROM inv_stock_balance b
            JOIN md_product p ON p.id = b.product_id
            JOIN md_warehouse w ON w.id = b.warehouse_id
            WHERE p.code = ?
              AND w.code = ?
            """, productCode, WAREHOUSE_CODE);
        assertDecimal(row.get("onHand"), onHand);
        assertDecimal(row.get("reserved"), reserved);
        assertDecimal(row.get("available"), available);
    }

    private void assertTaskIssued(String taskBillNo, String issuedQty, String status) {
        var row = jdbcTemplate.queryForMap("""
            SELECT issued_qty AS "issuedQty", status
            FROM production_task
            WHERE bill_no = ?
            """, taskBillNo);
        assertDecimal(row.get("issuedQty"), issuedQty);
        assertThat(row.get("status")).isEqualTo(status);
    }

    private void assertTaskSnapshotIssued(String taskBillNo, String issuedQty) {
        var row = jdbcTemplate.queryForMap("""
            SELECT COALESCE(SUM(snapshot.issued_qty), 0) AS "issuedQty"
            FROM production_task_material_snapshot snapshot
            JOIN production_task task ON task.id = snapshot.task_id
            WHERE task.bill_no = ?
            """, taskBillNo);
        assertDecimal(row.get("issuedQty"), issuedQty);
    }

    private void assertListContainsSingle(String listKey, String keyword, String billNo) {
        assertListContainsSingleField(listKey, keyword, "billNo", billNo);
    }

    private void assertListContainsSingleField(String listKey, String keyword, String field, String value) {
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
        assertThat(rows)
            .singleElement()
            .satisfies(row -> assertThat(row.get(field)).isEqualTo(value));
    }

    @SuppressWarnings("unchecked")
    private List<Map<String, Object>> selectableRequisitionLines(String supplierName) {
        var payload = listStubController.rows(
            "purchase-requisition-list",
            supplierName,
            "",
            1,
            200,
            "detail",
            "",
            "asc",
            "",
            "",
            "",
            "",
            "",
            "",
            ""
        );
        return (List<Map<String, Object>>) payload.get("rows");
    }

    private String generatedBillNo(Map<String, Object> saved, String label) {
        var billNo = (String) saved.get("billNo");
        assertThat(billNo).as(label + "系统生成单号").isNotBlank();
        return billNo;
    }

    private SourceDocument productInDocument(String billNo) {
        return new SourceDocument(
            "production_completion",
            "production_completion_line",
            "completion_id",
            "created_at",
            billNo
        );
    }

    private int countProductsNamed(String name) {
        return jdbcTemplate.queryForObject(
            "SELECT count(*)::int FROM md_product WHERE name = ?",
            Integer.class,
            name
        );
    }

    private void assertDecimal(Object actual, String expected) {
        assertThat(new BigDecimal(String.valueOf(actual).replace(",", ""))).isEqualByComparingTo(expected);
    }

    private String quoteIdentifier(String identifier) {
        return "\"" + identifier.replace("\"", "\"\"") + "\"";
    }
}
