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
import com.jdy.erp.outsourcing.application.OutsourcingDocumentAppService;
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
        currentSessionService.login("admin", "admin123", code);
        TenantContext.setTenant(currentSessionService.currentAccountSet());
    }

    private void createOutsourcingSetup(String parentName, String componentName, String supplierName) {
        masterDataController.create("supplier", Map.of(
            "code", SUPPLIER_CODE,
            "name", supplierName
        ));
        masterDataController.audit("supplier", SUPPLIER_CODE);
        masterDataController.create("product", Map.ofEntries(
            Map.entry("code", PARENT_CODE),
            Map.entry("name", parentName),
            Map.entry("category", "RAW"),
            Map.entry("unit", "PCS"),
            Map.entry("defaultWarehouseCode", WAREHOUSE_CODE),
            Map.entry("defaultSupplierCode", SUPPLIER_CODE),
            Map.entry("isInventory", "true"),
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
