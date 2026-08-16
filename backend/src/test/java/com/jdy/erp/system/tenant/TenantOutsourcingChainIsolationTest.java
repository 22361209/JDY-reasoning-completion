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
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;
import java.util.function.Supplier;

import com.jdy.erp.inventory.application.OpeningStockService;
import com.jdy.erp.masterdata.api.MasterDataController;
import com.jdy.erp.outsourcing.application.OutsourcingDocumentAppService;
import com.jdy.erp.production.application.ProductionTaskAppService;
import com.jdy.erp.system.api.ListStubController;
import com.jdy.erp.system.application.AccountSetManagementService;
import com.jdy.erp.system.security.CurrentSessionService;
import com.jdy.erp.testsupport.IsolatedAdminFixture;
import com.jdy.erp.testsupport.InventoryTraceAssertions.SourceDocument;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.mock.web.MockHttpServletRequest;
import org.springframework.http.HttpStatus;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;
import org.springframework.web.server.ResponseStatusException;
import org.springframework.web.context.request.RequestContextHolder;
import org.springframework.web.context.request.ServletRequestAttributes;

@SpringBootTest
class TenantOutsourcingChainIsolationTest {
    private static final String PARENT_CODE = "A119-OUT-FG";
    private static final String COMPONENT_CODE = "A119-OUT-MAT";
    private static final String SUPPLIER_CODE = "A119-OUT-SUP";
    private static final String WAREHOUSE_CODE = "CK-001";
    private static final String BOM_CODE = "BOM-A119-OUT";

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
    private OutsourcingDocumentAppService outsourcingDocumentAppService;

    @Autowired
    private ListStubController listStubController;

    @Autowired
    private JdbcTemplate jdbcTemplate;

    @Autowired
    @Qualifier("platformJdbcTemplate")
    private JdbcTemplate platformJdbcTemplate;

    @Autowired
    private TenantDataSourceRegistry tenantDataSourceRegistry;

    @Autowired
    private PlatformTransactionManager transactionManager;

    private final List<String> createdCodes = new ArrayList<>();
    private final List<String> createdSchemas = new ArrayList<>();
    private IsolatedAdminFixture.Identity fixture;

    @BeforeEach
    void bindRequest() {
        fixture = IsolatedAdminFixture.create(platformJdbcTemplate, "outsourcing");
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
    void outsourcingWorkOrderIssueReceiptAndAdjustmentsAreTenantScoped() {
        var tenantA = createManagedAccountSet("A119OWA");
        var tenantB = createManagedAccountSet("A119OWB");

        useTenant(tenantA);
        createOutsourcingSetup("A119 账套A委外母件", "A119 账套A委外子件", "A119 账套A委外供应商");
        saveComponentOpeningStock(new BigDecimal("30"));
        createAuditedBom();
        var tenantAFlow = runOutsourcingChain(
            new BigDecimal("5"),
            new BigDecimal("4"),
            BigDecimal.ONE,
            BigDecimal.ONE,
            "A119 账套A委外母件",
            "A119 账套A委外子件",
            "A119 账套A委外供应商"
        );
        assertBalance(COMPONENT_CODE, "20.0000", "0.0000", "20.0000");
        assertBalance(PARENT_CODE, "2.0000", "0.0000", "2.0000");
        assertListContainsSingle("outsourcing-work-order-list", "A119 账套A委外母件", tenantAFlow.workOrderBillNo());
        assertListContainsSingle("outsourcing-issue-list", "A119 账套A委外子件", tenantAFlow.issueBillNo());
        assertListContainsSingle("outsourcing-receipt-list", "A119 账套A委外母件", tenantAFlow.receiptBillNo());
        assertListContainsSingle("outsourcing-return-list", "A119 账套A委外母件", tenantAFlow.returnBillNo());
        assertListContainsSingle("outsourcing-scrap-list", "A119 账套A委外母件", tenantAFlow.scrapBillNo());

        useTenant(tenantB);
        createOutsourcingSetup("A119 账套B委外母件", "A119 账套B委外子件", "A119 账套B委外供应商");
        saveComponentOpeningStock(new BigDecimal("8"));
        createAuditedBom();
        var tenantBFlow = runOutsourcingChain(
            new BigDecimal("2"),
            new BigDecimal("2"),
            BigDecimal.ONE,
            BigDecimal.ONE,
            "A119 账套B委外母件",
            "A119 账套B委外子件",
            "A119 账套B委外供应商"
        );
        assertBalance(COMPONENT_CODE, "4.0000", "0.0000", "4.0000");
        assertBalance(PARENT_CODE, "0.0000", "0.0000", "0.0000");
        assertThat(countProductsNamed("A119 账套A委外母件")).isZero();
        assertThat(countProductsNamed("A119 账套A委外子件")).isZero();
        assertListContainsSingle("outsourcing-work-order-list", "A119 账套B委外母件", tenantBFlow.workOrderBillNo());
        assertListContainsSingle("outsourcing-issue-list", "A119 账套B委外子件", tenantBFlow.issueBillNo());

        useTenant(tenantA);
        assertBalance(COMPONENT_CODE, "20.0000", "0.0000", "20.0000");
        assertBalance(PARENT_CODE, "2.0000", "0.0000", "2.0000");
        assertThat(countProductsNamed("A119 账套B委外母件")).isZero();
        assertThat(countProductsNamed("A119 账套B委外子件")).isZero();
        assertListContainsSingle("outsourcing-work-order-list", "A119 账套A委外母件", tenantAFlow.workOrderBillNo());
        assertListContainsSingle("outsourcing-scrap-list", "A119 账套A委外母件", tenantAFlow.scrapBillNo());
    }

    @Test
    void returnAndScrapShareOneAuditedReceiptCapacityAndReverseReleasesIt() {
        var tenant = createManagedAccountSet("A186CAP");
        useTenant(tenant);
        createOutsourcingSetup("A186 处置母件", "A186 处置子件", "A186 处置供应商");
        createAuditedBom();

        var workOrder = outsourcingDocumentAppService.saveWorkOrder(new OutsourcingDocumentAppService.WorkOrderRequest(
            null,
            SUPPLIER_CODE,
            PARENT_CODE,
            BigDecimal.ONE,
            "2026-08-16",
            "A186 cumulative disposal guard",
            null,
            null
        ));
        var workOrderBillNo = String.valueOf(workOrder.get("billNo"));
        outsourcingDocumentAppService.auditWorkOrder(workOrderBillNo);
        var receipt = outsourcingDocumentAppService.pushReceipt(
            workOrderBillNo,
            new OutsourcingDocumentAppService.QtyRequest(BigDecimal.ONE)
        );
        var receiptBillNo = String.valueOf(receipt.get("billNo"));
        outsourcingDocumentAppService.auditReceipt(receiptBillNo);

        var returnBill = outsourcingDocumentAppService.pushReturn(
            receiptBillNo,
            new OutsourcingDocumentAppService.QtyRequest(BigDecimal.ONE)
        );
        var scrapBill = outsourcingDocumentAppService.pushScrap(
            receiptBillNo,
            new OutsourcingDocumentAppService.QtyRequest(BigDecimal.ONE)
        );
        var returnBillNo = String.valueOf(returnBill.get("billNo"));
        var scrapBillNo = String.valueOf(scrapBill.get("billNo"));

        outsourcingDocumentAppService.auditReturn(returnBillNo);
        var balanceAfterReturn = balanceQty(PARENT_CODE);
        var transactionCountAfterReturn = transactionCountForAdjustment(returnBillNo, scrapBillNo);
        assertThatThrownBy(() -> outsourcingDocumentAppService.auditScrap(scrapBillNo))
            .isInstanceOfSatisfying(ResponseStatusException.class, exception -> {
                assertThat(exception.getStatusCode()).isEqualTo(HttpStatus.CONFLICT);
                assertThat(exception.getReason()).contains("累计数量不能超过");
            });
        assertThat(adjustmentStatus("outsourcing_scrap", scrapBillNo)).isEqualTo("DRAFT");
        assertThat(receiptDisposalQty(receiptBillNo)).isEqualByComparingTo("1");
        assertThat(balanceQty(PARENT_CODE)).isEqualByComparingTo(balanceAfterReturn);
        assertThat(transactionCountForAdjustment(returnBillNo, scrapBillNo)).isEqualTo(transactionCountAfterReturn);

        outsourcingDocumentAppService.reverseReturn(returnBillNo);
        assertThat(receiptDisposalQty(receiptBillNo)).isEqualByComparingTo("0");
        outsourcingDocumentAppService.auditScrap(scrapBillNo);
        assertThat(adjustmentStatus("outsourcing_scrap", scrapBillNo)).isEqualTo("AUDITED");
        assertThat(receiptDisposalQty(receiptBillNo)).isEqualByComparingTo("1");
    }

    @Test
    @Timeout(value = 60, unit = TimeUnit.SECONDS)
    void concurrentReturnAndScrapAuditsAllowExactlyOneSharedCapacityClaim() throws Exception {
        var tenant = createManagedAccountSet("A186RACE");
        useTenant(tenant);
        createOutsourcingSetup("A186 并发母件", "A186 并发子件", "A186 并发供应商");
        createAuditedBom();
        var accountSet = currentSessionService.currentAccountSet();
        assertConcurrentCapacityClaim(accountSet, createAuditedReceipt("A186 return first"), "return");
        assertConcurrentCapacityClaim(accountSet, createAuditedReceipt("A186 scrap first"), "scrap");
    }

    @Test
    @Timeout(value = 60, unit = TimeUnit.SECONDS)
    void receiptPushAndParentReverseSerializeInBothCommitOrders() throws Exception {
        var tenant = createManagedAccountSet("A186PUSH");
        useTenant(tenant);
        createOutsourcingSetup("A186 推单母件", "A186 推单子件", "A186 推单供应商");
        createAuditedBom();
        var accountSet = currentSessionService.currentAccountSet();

        var sameKindReceipt = createAuditedReceipt("A186 same-kind push");
        assertConcurrentSameKindPushReturnsOneDraft(accountSet, sameKindReceipt);

        var pushFirstReceipt = createAuditedReceipt("A186 push first");
        assertPushCommitWinsAndParentReverseFails(accountSet, pushFirstReceipt);

        var reverseFirstReceipt = createAuditedReceipt("A186 reverse first");
        assertParentReverseCommitWinsAndPushFails(accountSet, reverseFirstReceipt);
    }

    @Test
    void legacyOverallocatedReceiptCanBeRecoveredByExactReverse() {
        var tenant = createManagedAccountSet("A186LEG");
        useTenant(tenant);
        createOutsourcingSetup("A186 历史母件", "A186 历史子件", "A186 历史供应商");
        createAuditedBom();
        openingStockService.saveRows(List.of(new OpeningStockService.OpeningStockLineRequest(
            PARENT_CODE,
            WAREHOUSE_CODE,
            BigDecimal.ONE,
            BigDecimal.ONE,
            "A186 legacy over-allocation recovery"
        )));
        var receiptBillNo = createAuditedReceipt("A186 legacy over-allocation");
        var returnBillNo = String.valueOf(outsourcingDocumentAppService.pushReturn(
            receiptBillNo, new OutsourcingDocumentAppService.QtyRequest(BigDecimal.ONE)
        ).get("billNo"));
        var scrapBillNo = String.valueOf(outsourcingDocumentAppService.pushScrap(
            receiptBillNo, new OutsourcingDocumentAppService.QtyRequest(BigDecimal.ONE)
        ).get("billNo"));

        outsourcingDocumentAppService.auditReturn(returnBillNo);
        setReceiptCounter(receiptBillNo, "returned_qty", BigDecimal.ZERO);
        outsourcingDocumentAppService.auditScrap(scrapBillNo);
        setReceiptCounter(receiptBillNo, "returned_qty", BigDecimal.ONE);
        assertThat(receiptDisposalQty(receiptBillNo)).isEqualByComparingTo("2");
        var balanceBeforeReverse = balanceQty(PARENT_CODE);
        var txnCountBeforeReverse = transactionCountForAdjustment(returnBillNo, scrapBillNo);

        outsourcingDocumentAppService.reverseScrap(scrapBillNo);

        assertThat(adjustmentStatus("outsourcing_return", returnBillNo)).isEqualTo("AUDITED");
        assertThat(adjustmentStatus("outsourcing_scrap", scrapBillNo)).isEqualTo("DRAFT");
        assertThat(receiptDisposalQty(receiptBillNo)).isEqualByComparingTo("1");
        assertThat(balanceQty(PARENT_CODE)).isEqualByComparingTo(balanceBeforeReverse.add(BigDecimal.ONE));
        assertThat(transactionCountForAdjustment(returnBillNo, scrapBillNo)).isEqualTo(txnCountBeforeReverse + 1);
    }

    private OutsourcingFlow runOutsourcingChain(
        BigDecimal workQty,
        BigDecimal receiptQty,
        BigDecimal returnQty,
        BigDecimal scrapQty,
        String parentName,
        String componentName,
        String supplierName
    ) {
        var componentBefore = balanceQty(COMPONENT_CODE);
        var componentQty = workQty.multiply(new BigDecimal("2"));
        var workOrder = outsourcingDocumentAppService.saveWorkOrder(new OutsourcingDocumentAppService.WorkOrderRequest(
            null,
            SUPPLIER_CODE,
            PARENT_CODE,
            workQty,
            "2026-07-05",
            "A119 outsourcing",
            null,
            null
        ));
        var workOrderBillNo = String.valueOf(workOrder.get("billNo"));
        assertThat(workOrder.get("status")).isEqualTo("DRAFT");
        assertWorkOrderDetail(workOrderBillNo, parentName, componentName, supplierName, workQty.multiply(new BigDecimal("2")));
        outsourcingDocumentAppService.auditWorkOrder(workOrderBillNo);
        assertSourceRemaining("issue", workOrderBillNo, workQty.multiply(new BigDecimal("2")));
        assertSourceRemaining("receipt", workOrderBillNo, workQty);

        var issue = outsourcingDocumentAppService.pushIssue(workOrderBillNo);
        var issueBillNo = String.valueOf(issue.get("billNo"));
        outsourcingDocumentAppService.auditIssue(issueBillNo);
        var componentAfterIssue = componentBefore.subtract(componentQty);
        outsourcingDocumentAppService.reverseIssue(issueBillNo);
        outsourcingDocumentAppService.auditIssue(issueBillNo);
        assertExactLifecycle(
            jdbcTemplate,
            outsourcingDocument("outsourcing_material_issue", "outsourcing_material_issue_line", "issue_id", issueBillNo),
            "OUTSOURCING_MATERIAL_ISSUE", COMPONENT_CODE, WAREHOUSE_CODE,
            fact("OUTSOURCING_ISSUE", "AUDIT", componentQty.negate().toPlainString(), componentAfterIssue.toPlainString()),
            reversal("OUTSOURCING_ISSUE_REVERSE", "REVERSE", componentQty.toPlainString(), componentBefore.toPlainString(), 0),
            fact("OUTSOURCING_ISSUE", "AUDIT", componentQty.negate().toPlainString(), componentAfterIssue.toPlainString())
        );
        assertNoIssueSources(workOrderBillNo);

        var receipt = outsourcingDocumentAppService.pushReceipt(workOrderBillNo, new OutsourcingDocumentAppService.QtyRequest(receiptQty));
        var receiptBillNo = String.valueOf(receipt.get("billNo"));
        outsourcingDocumentAppService.auditReceipt(receiptBillNo);
        outsourcingDocumentAppService.reverseReceipt(receiptBillNo);
        outsourcingDocumentAppService.auditReceipt(receiptBillNo);
        assertExactLifecycle(
            jdbcTemplate,
            outsourcingDocument("outsourcing_receipt", "outsourcing_receipt_line", "receipt_id", receiptBillNo),
            "OUTSOURCING_RECEIPT", PARENT_CODE, WAREHOUSE_CODE,
            fact("OUTSOURCING_RECEIPT", "AUDIT", receiptQty.toPlainString(), receiptQty.toPlainString()),
            reversal("OUTSOURCING_RECEIPT_REVERSE", "REVERSE", receiptQty.negate().toPlainString(), "0", 0),
            fact("OUTSOURCING_RECEIPT", "AUDIT", receiptQty.toPlainString(), receiptQty.toPlainString())
        );
        assertReceiptSourceRemaining(receiptBillNo, receiptQty);

        var returnBill = outsourcingDocumentAppService.pushReturn(receiptBillNo, new OutsourcingDocumentAppService.QtyRequest(returnQty));
        var returnBillNo = String.valueOf(returnBill.get("billNo"));
        outsourcingDocumentAppService.auditReturn(returnBillNo);
        var parentAfterReturn = receiptQty.subtract(returnQty);
        outsourcingDocumentAppService.reverseReturn(returnBillNo);
        outsourcingDocumentAppService.auditReturn(returnBillNo);
        assertExactLifecycle(
            jdbcTemplate,
            outsourcingDocument("outsourcing_return", "outsourcing_return_line", "return_id", returnBillNo),
            "OUTSOURCING_RETURN", PARENT_CODE, WAREHOUSE_CODE,
            fact("OUTSOURCING_RETURN", "AUDIT", returnQty.negate().toPlainString(), parentAfterReturn.toPlainString()),
            reversal("OUTSOURCING_RETURN_REVERSE", "REVERSE", returnQty.toPlainString(), receiptQty.toPlainString(), 0),
            fact("OUTSOURCING_RETURN", "AUDIT", returnQty.negate().toPlainString(), parentAfterReturn.toPlainString())
        );
        assertReceiptSourceRemaining(receiptBillNo, receiptQty.subtract(returnQty));

        var scrap = outsourcingDocumentAppService.pushScrap(receiptBillNo, new OutsourcingDocumentAppService.QtyRequest(scrapQty));
        var scrapBillNo = String.valueOf(scrap.get("billNo"));
        outsourcingDocumentAppService.auditScrap(scrapBillNo);
        var parentAfterScrap = parentAfterReturn.subtract(scrapQty);
        outsourcingDocumentAppService.reverseScrap(scrapBillNo);
        outsourcingDocumentAppService.auditScrap(scrapBillNo);
        assertExactLifecycle(
            jdbcTemplate,
            outsourcingDocument("outsourcing_scrap", "outsourcing_scrap_line", "scrap_id", scrapBillNo),
            "OUTSOURCING_SCRAP", PARENT_CODE, WAREHOUSE_CODE,
            fact("OUTSOURCING_SCRAP", "AUDIT", scrapQty.negate().toPlainString(), parentAfterScrap.toPlainString()),
            reversal("OUTSOURCING_SCRAP_REVERSE", "REVERSE", scrapQty.toPlainString(), parentAfterReturn.toPlainString(), 0),
            fact("OUTSOURCING_SCRAP", "AUDIT", scrapQty.negate().toPlainString(), parentAfterScrap.toPlainString())
        );
        assertReceiptSourceRemaining(receiptBillNo, receiptQty.subtract(returnQty).subtract(scrapQty));
        return new OutsourcingFlow(workOrderBillNo, issueBillNo, receiptBillNo, returnBillNo, scrapBillNo);
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

    private void createOutsourcingSetup(String parentName, String componentName, String supplierName) {
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
            Map.entry("defaultSupplierCode", SUPPLIER_CODE),
            Map.entry("isInventory", "true"),
            Map.entry("isProduce", "true"),
            Map.entry("isSubcontract", "true")
        ));
        masterDataController.audit("product", PARENT_CODE);
        masterDataController.create("product", Map.ofEntries(
            Map.entry("code", COMPONENT_CODE),
            Map.entry("name", componentName),
            Map.entry("category", "RAW"),
            Map.entry("unit", "PCS"),
            Map.entry("defaultWarehouseCode", WAREHOUSE_CODE),
            Map.entry("isInventory", "true")
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
            "A119-4-6 outsourcing chain"
        )));
    }

    private void createAuditedBom() {
        productionTaskAppService.saveBom(new ProductionTaskAppService.BomRequest(
            BOM_CODE,
            PARENT_CODE,
            BigDecimal.ONE,
            "委外BOM",
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

    @SuppressWarnings("unchecked")
    private void assertWorkOrderDetail(String billNo, String parentName, String componentName, String supplierName, BigDecimal componentQty) {
        var detail = outsourcingDocumentAppService.workOrderDetail(billNo);
        assertThat(detail.get("supplierName")).isEqualTo(supplierName);
        var lines = (List<Map<String, Object>>) detail.get("lines");
        assertThat(lines)
            .singleElement()
            .satisfies(row -> {
                assertThat(row.get("productName")).isEqualTo(parentName);
                assertThat(row.get("bomCode")).isEqualTo(BOM_CODE);
            });
        var components = (List<Map<String, Object>>) detail.get("components");
        assertThat(components)
            .singleElement()
            .satisfies(row -> {
                assertThat(row.get("productName")).isEqualTo(componentName);
                assertDecimal(row.get("qty"), componentQty.toPlainString());
            });
    }

    private void assertSourceRemaining(String target, String billNo, BigDecimal qty) {
        var rows = outsourcingDocumentAppService.workOrderSources(target);
        assertThat(rows)
            .filteredOn(row -> billNo.equals(row.get("billNo")))
            .singleElement()
            .satisfies(row -> assertDecimal(row.get("remainingQty"), qty.toPlainString()));
    }

    private void assertNoIssueSources(String billNo) {
        assertThat(outsourcingDocumentAppService.workOrderSources("issue"))
            .noneSatisfy(row -> assertThat(row.get("billNo")).isEqualTo(billNo));
    }

    private void assertReceiptSourceRemaining(String receiptBillNo, BigDecimal qty) {
        var rows = outsourcingDocumentAppService.receiptSources("return");
        if (qty.compareTo(BigDecimal.ZERO) <= 0) {
            assertThat(rows).noneSatisfy(row -> assertThat(row.get("billNo")).isEqualTo(receiptBillNo));
            return;
        }
        assertThat(rows)
            .filteredOn(row -> receiptBillNo.equals(row.get("billNo")))
            .singleElement()
            .satisfies(row -> assertDecimal(row.get("remainingQty"), qty.toPlainString()));
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

    private BigDecimal balanceQty(String productCode) {
        return jdbcTemplate.queryForObject("""
            SELECT b.qty_on_hand
            FROM inv_stock_balance b
            JOIN md_product p ON p.id = b.product_id
            JOIN md_warehouse w ON w.id = b.warehouse_id
            WHERE p.code = ?
              AND w.code = ?
            """, BigDecimal.class, productCode, WAREHOUSE_CODE);
    }

    private String adjustmentStatus(String table, String billNo) {
        return jdbcTemplate.queryForObject(
            "SELECT status FROM " + table + " WHERE bill_no = ?",
            String.class,
            billNo
        );
    }

    private BigDecimal receiptDisposalQty(String receiptBillNo) {
        return jdbcTemplate.queryForObject("""
            SELECT line.returned_qty + line.scrapped_qty
            FROM outsourcing_receipt_line line
            JOIN outsourcing_receipt receipt ON receipt.id = line.receipt_id
            WHERE receipt.bill_no = ?
            """, BigDecimal.class, receiptBillNo);
    }

    private int transactionCountForAdjustment(String returnBillNo, String scrapBillNo) {
        return jdbcTemplate.queryForObject("""
            SELECT count(*)::int
            FROM inv_stock_txn
            WHERE source_bill_no IN (?, ?)
            """, Integer.class, returnBillNo, scrapBillNo);
    }

    private String createAuditedReceipt(String remark) {
        var workOrder = outsourcingDocumentAppService.saveWorkOrder(new OutsourcingDocumentAppService.WorkOrderRequest(
            null,
            SUPPLIER_CODE,
            PARENT_CODE,
            BigDecimal.ONE,
            "2026-08-16",
            remark,
            null,
            null
        ));
        var workOrderBillNo = String.valueOf(workOrder.get("billNo"));
        outsourcingDocumentAppService.auditWorkOrder(workOrderBillNo);
        var receipt = outsourcingDocumentAppService.pushReceipt(
            workOrderBillNo,
            new OutsourcingDocumentAppService.QtyRequest(BigDecimal.ONE)
        );
        var receiptBillNo = String.valueOf(receipt.get("billNo"));
        outsourcingDocumentAppService.auditReceipt(receiptBillNo);
        return receiptBillNo;
    }

    private void assertConcurrentCapacityClaim(
        Map<String, Object> accountSet,
        String receiptBillNo,
        String winnerKind
    ) throws Exception {
        var returnBillNo = String.valueOf(outsourcingDocumentAppService.pushReturn(
            receiptBillNo, new OutsourcingDocumentAppService.QtyRequest(BigDecimal.ONE)
        ).get("billNo"));
        var scrapBillNo = String.valueOf(outsourcingDocumentAppService.pushScrap(
            receiptBillNo, new OutsourcingDocumentAppService.QtyRequest(BigDecimal.ONE)
        ).get("billNo"));
        var winnerBillNo = "return".equals(winnerKind) ? returnBillNo : scrapBillNo;
        var contenderKind = "return".equals(winnerKind) ? "scrap" : "return";
        var contenderBillNo = "return".equals(contenderKind) ? returnBillNo : scrapBillNo;
        var winnerLocked = new CountDownLatch(1);
        var releaseWinner = new CountDownLatch(1);
        var contenderStarted = new CountDownLatch(1);
        try (var executor = Executors.newFixedThreadPool(2)) {
            var winner = executor.submit(() -> withTenant(accountSet, () ->
                new TransactionTemplate(transactionManager).execute(status -> {
                    var result = auditAdjustment(winnerKind, winnerBillNo);
                    winnerLocked.countDown();
                    await(releaseWinner);
                    return String.valueOf(result.get("status"));
                })
            ));
            assertThat(winnerLocked.await(10, TimeUnit.SECONDS)).isTrue();

            var contender = executor.submit(() -> withTenant(accountSet, () -> {
                contenderStarted.countDown();
                return auditAdjustmentResult(contenderKind, contenderBillNo);
            }));
            assertThat(contenderStarted.await(10, TimeUnit.SECONDS)).isTrue();
            assertThatThrownBy(() -> contender.get(250, TimeUnit.MILLISECONDS))
                .isInstanceOf(TimeoutException.class);

            releaseWinner.countDown();
            assertThat(winner.get(10, TimeUnit.SECONDS)).isEqualTo("AUDITED");
            assertThat(contender.get(10, TimeUnit.SECONDS)).isEqualTo("CONFLICT");
        } finally {
            releaseWinner.countDown();
        }

        assertThat(adjustmentStatus(
            "return".equals(winnerKind) ? "outsourcing_return" : "outsourcing_scrap",
            winnerBillNo
        )).isEqualTo("AUDITED");
        assertThat(adjustmentStatus(
            "return".equals(contenderKind) ? "outsourcing_return" : "outsourcing_scrap",
            contenderBillNo
        )).isEqualTo("DRAFT");
        assertThat(receiptDisposalQty(receiptBillNo)).isEqualByComparingTo("1");
        assertThat(transactionCountForAdjustment(returnBillNo, scrapBillNo)).isEqualTo(1);
    }

    private void assertConcurrentSameKindPushReturnsOneDraft(
        Map<String, Object> accountSet,
        String receiptBillNo
    ) throws Exception {
        var firstCreated = new CountDownLatch(1);
        var releaseFirst = new CountDownLatch(1);
        var secondStarted = new CountDownLatch(1);
        try (var executor = Executors.newFixedThreadPool(2)) {
            var first = executor.submit(() -> withTenant(accountSet, () ->
                new TransactionTemplate(transactionManager).execute(status -> {
                    var pushed = outsourcingDocumentAppService.pushReturn(
                        receiptBillNo, new OutsourcingDocumentAppService.QtyRequest(BigDecimal.ONE)
                    );
                    firstCreated.countDown();
                    await(releaseFirst);
                    return String.valueOf(pushed.get("billNo"));
                })
            ));
            assertThat(firstCreated.await(10, TimeUnit.SECONDS)).isTrue();
            var second = executor.submit(() -> withTenant(accountSet, () -> {
                secondStarted.countDown();
                return String.valueOf(outsourcingDocumentAppService.pushReturn(
                    receiptBillNo, new OutsourcingDocumentAppService.QtyRequest(BigDecimal.ONE)
                ).get("billNo"));
            }));
            assertThat(secondStarted.await(10, TimeUnit.SECONDS)).isTrue();
            assertThatThrownBy(() -> second.get(250, TimeUnit.MILLISECONDS))
                .isInstanceOf(TimeoutException.class);
            releaseFirst.countDown();
            assertThat(second.get(10, TimeUnit.SECONDS)).isEqualTo(first.get(10, TimeUnit.SECONDS));
        } finally {
            releaseFirst.countDown();
        }
        assertThat(jdbcTemplate.queryForObject("""
            SELECT count(*)::int
            FROM outsourcing_return adjustment
            JOIN outsourcing_receipt receipt ON receipt.id = adjustment.source_receipt_id
            WHERE receipt.bill_no = ?
              AND adjustment.status <> 'VOID'
            """, Integer.class, receiptBillNo)).isOne();
    }

    private void assertPushCommitWinsAndParentReverseFails(
        Map<String, Object> accountSet,
        String receiptBillNo
    ) throws Exception {
        var pushCreated = new CountDownLatch(1);
        var releasePush = new CountDownLatch(1);
        var reverseStarted = new CountDownLatch(1);
        try (var executor = Executors.newFixedThreadPool(2)) {
            var push = executor.submit(() -> withTenant(accountSet, () ->
                new TransactionTemplate(transactionManager).execute(status -> {
                    var result = outsourcingDocumentAppService.pushScrap(
                        receiptBillNo, new OutsourcingDocumentAppService.QtyRequest(BigDecimal.ONE)
                    );
                    pushCreated.countDown();
                    await(releasePush);
                    return String.valueOf(result.get("billNo"));
                })
            ));
            assertThat(pushCreated.await(10, TimeUnit.SECONDS)).isTrue();
            var reverse = executor.submit(() -> withTenant(accountSet, () -> {
                reverseStarted.countDown();
                return reverseReceiptResult(receiptBillNo);
            }));
            assertThat(reverseStarted.await(10, TimeUnit.SECONDS)).isTrue();
            assertThatThrownBy(() -> reverse.get(250, TimeUnit.MILLISECONDS))
                .isInstanceOf(TimeoutException.class);
            releasePush.countDown();
            assertThat(push.get(10, TimeUnit.SECONDS)).isNotBlank();
            assertThat(reverse.get(10, TimeUnit.SECONDS)).isEqualTo("CONFLICT");
        } finally {
            releasePush.countDown();
        }
        assertThat(receiptStatus(receiptBillNo)).isEqualTo("AUDITED");
    }

    private void assertParentReverseCommitWinsAndPushFails(
        Map<String, Object> accountSet,
        String receiptBillNo
    ) throws Exception {
        var reverseApplied = new CountDownLatch(1);
        var releaseReverse = new CountDownLatch(1);
        var pushStarted = new CountDownLatch(1);
        try (var executor = Executors.newFixedThreadPool(2)) {
            var reverse = executor.submit(() -> withTenant(accountSet, () ->
                new TransactionTemplate(transactionManager).execute(status -> {
                    var result = outsourcingDocumentAppService.reverseReceipt(receiptBillNo);
                    reverseApplied.countDown();
                    await(releaseReverse);
                    return String.valueOf(result.get("status"));
                })
            ));
            assertThat(reverseApplied.await(10, TimeUnit.SECONDS)).isTrue();
            var push = executor.submit(() -> withTenant(accountSet, () -> {
                pushStarted.countDown();
                try {
                    outsourcingDocumentAppService.pushReturn(
                        receiptBillNo, new OutsourcingDocumentAppService.QtyRequest(BigDecimal.ONE)
                    );
                    return "CREATED";
                } catch (ResponseStatusException exception) {
                    return exception.getStatusCode().value() == 409 ? "CONFLICT" : "HTTP_" + exception.getStatusCode().value();
                }
            }));
            assertThat(pushStarted.await(10, TimeUnit.SECONDS)).isTrue();
            assertThatThrownBy(() -> push.get(250, TimeUnit.MILLISECONDS))
                .isInstanceOf(TimeoutException.class);
            releaseReverse.countDown();
            assertThat(reverse.get(10, TimeUnit.SECONDS)).isEqualTo("DRAFT");
            assertThat(push.get(10, TimeUnit.SECONDS)).isEqualTo("HTTP_400");
        } finally {
            releaseReverse.countDown();
        }
        assertThat(receiptStatus(receiptBillNo)).isEqualTo("DRAFT");
    }

    private Map<String, Object> auditAdjustment(String kind, String billNo) {
        return "return".equals(kind)
            ? outsourcingDocumentAppService.auditReturn(billNo)
            : outsourcingDocumentAppService.auditScrap(billNo);
    }

    private String auditAdjustmentResult(String kind, String billNo) {
        try {
            return String.valueOf(auditAdjustment(kind, billNo).get("status"));
        } catch (ResponseStatusException exception) {
            return exception.getStatusCode().value() == 409 ? "CONFLICT" : "HTTP_" + exception.getStatusCode().value();
        }
    }

    private String reverseReceiptResult(String receiptBillNo) {
        try {
            return String.valueOf(outsourcingDocumentAppService.reverseReceipt(receiptBillNo).get("status"));
        } catch (ResponseStatusException exception) {
            return exception.getStatusCode().value() == 409 ? "CONFLICT" : "HTTP_" + exception.getStatusCode().value();
        }
    }

    private String receiptStatus(String receiptBillNo) {
        return jdbcTemplate.queryForObject(
            "SELECT status FROM outsourcing_receipt WHERE bill_no = ?",
            String.class,
            receiptBillNo
        );
    }

    private void setReceiptCounter(String receiptBillNo, String column, BigDecimal value) {
        if (!List.of("returned_qty", "scrapped_qty").contains(column)) {
            throw new IllegalArgumentException("unsupported receipt counter");
        }
        jdbcTemplate.update("""
            UPDATE outsourcing_receipt_line line
            SET %s = ?
            FROM outsourcing_receipt receipt
            WHERE receipt.id = line.receipt_id
              AND receipt.bill_no = ?
            """.formatted(column), value, receiptBillNo);
    }

    private <T> T withTenant(Map<String, Object> accountSet, Supplier<T> action) {
        try {
            var servletRequest = new MockHttpServletRequest();
            servletRequest.getSession(true).setAttribute(CurrentSessionService.SESSION_USERNAME, fixture.username());
            RequestContextHolder.setRequestAttributes(new ServletRequestAttributes(servletRequest));
            TenantContext.setTenant(accountSet);
            return action.get();
        } finally {
            TenantContext.clear();
            RequestContextHolder.resetRequestAttributes();
        }
    }

    private void await(CountDownLatch latch) {
        try {
            if (!latch.await(10, TimeUnit.SECONDS)) {
                throw new IllegalStateException("A186 concurrency gate timed out");
            }
        } catch (InterruptedException exception) {
            Thread.currentThread().interrupt();
            throw new IllegalStateException("A186 concurrency gate interrupted", exception);
        }
    }

    private SourceDocument outsourcingDocument(
        String headerTable,
        String lineTable,
        String lineBillColumn,
        String billNo
    ) {
        return new SourceDocument(headerTable, lineTable, lineBillColumn, "bill_date", billNo);
    }

    private void assertListContainsSingle(String listKey, String keyword, String billNo) {
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
            .satisfies(row -> assertThat(row.get("billNo")).isEqualTo(billNo));
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

    private record OutsourcingFlow(String workOrderBillNo, String issueBillNo, String receiptBillNo, String returnBillNo, String scrapBillNo) {
    }
}
