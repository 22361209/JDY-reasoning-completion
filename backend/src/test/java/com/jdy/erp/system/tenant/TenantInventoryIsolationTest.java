package com.jdy.erp.system.tenant;

import static org.assertj.core.api.Assertions.assertThat;

import java.math.BigDecimal;
import java.time.LocalDate;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.UUID;

import com.jdy.erp.inventory.application.InventoryPostingCommand;
import com.jdy.erp.inventory.application.InventoryPostingCommand.PostingAction;
import com.jdy.erp.inventory.application.InventoryPostingService;
import com.jdy.erp.inventory.application.OpeningStockService;
import com.jdy.erp.inventory.application.OtherStockInAppService;
import com.jdy.erp.inventory.application.StockCountAppService;
import com.jdy.erp.masterdata.api.MasterDataController;
import com.jdy.erp.system.api.ListStubController;
import com.jdy.erp.system.application.AccountSetManagementService;
import com.jdy.erp.system.security.CurrentSessionService;
import com.jdy.erp.testsupport.IsolatedAdminFixture;
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
class TenantInventoryIsolationTest {
    private static final LocalDate INVENTORY_FIXTURE_DATE = LocalDate.of(2026, 6, 30);
    private static final UUID TENANT_A_ADJUST_HEADER_ID = UUID.fromString("a1190000-0000-4000-8000-000000000001");
    private static final UUID TENANT_A_ADJUST_LINE_ID = UUID.fromString("a1190000-0000-4000-8000-000000000002");
    private static final UUID TENANT_A_RESERVATION_HEADER_ID = UUID.fromString("a1190000-0000-4000-8000-000000000003");
    private static final UUID TENANT_A_RESERVATION_LINE_ID = UUID.fromString("a1190000-0000-4000-8000-000000000004");
    private static final UUID TENANT_B_ADJUST_HEADER_ID = UUID.fromString("a1190000-0000-4000-8000-000000000005");
    private static final UUID TENANT_B_ADJUST_LINE_ID = UUID.fromString("a1190000-0000-4000-8000-000000000006");

    @Autowired
    private AccountSetManagementService accountSetManagementService;

    @Autowired
    private CurrentSessionService currentSessionService;

    @Autowired
    private MasterDataController masterDataController;

    @Autowired
    private OpeningStockService openingStockService;

    @Autowired
    private InventoryPostingService inventoryPostingService;

    @Autowired
    private OtherStockInAppService otherStockInAppService;

    @Autowired
    private StockCountAppService stockCountAppService;

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
        fixture = IsolatedAdminFixture.create(platformJdbcTemplate, "inventory");
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
    void inventoryOpeningBalanceTransactionsAndListRowsAreTenantScoped() {
        var tenantA = createManagedAccountSet("A119INVA");
        var tenantB = createManagedAccountSet("A119INVB");

        useTenant(tenantA);
        createAuditedMaterial("A119-INV", "A119 账套A库存物料");
        openingStockService.saveRows(List.of(new OpeningStockService.OpeningStockLineRequest(
            "A119-INV",
            "CK-001",
            new BigDecimal("10"),
            new BigDecimal("2"),
            "A119-4-2 tenant A"
        )));
        saveAndAuditOtherStockIn(new BigDecimal("4"));
        inventoryPostingService.post(InventoryPostingCommand.test(
            "A119-INV", "CK-001", new BigDecimal("5"), "A119_ADJUST_IN", "A119",
            TENANT_A_ADJUST_HEADER_ID, TENANT_A_ADJUST_LINE_ID, "A119-ADJUST-A",
            INVENTORY_FIXTURE_DATE, PostingAction.AUDIT
        ));
        inventoryPostingService.reserve(InventoryPostingCommand.test(
            "A119-INV", "CK-001", new BigDecimal("4"), "A119_RESERVE", "A119",
            TENANT_A_RESERVATION_HEADER_ID, TENANT_A_RESERVATION_LINE_ID, "A119-RESERVATION-A",
            INVENTORY_FIXTURE_DATE, PostingAction.RESERVE
        ));
        inventoryPostingService.shipReserved(InventoryPostingCommand.test(
            "A119-INV", "CK-001", new BigDecimal("3"), "A119_SHIP", "A119",
            TENANT_A_RESERVATION_HEADER_ID, TENANT_A_RESERVATION_LINE_ID, "A119-RESERVATION-A",
            INVENTORY_FIXTURE_DATE, PostingAction.AUDIT
        ));
        inventoryPostingService.releaseReservation(InventoryPostingCommand.test(
            "A119-INV", "CK-001", new BigDecimal("1"), "A119_RELEASE", "A119",
            TENANT_A_RESERVATION_HEADER_ID, TENANT_A_RESERVATION_LINE_ID, "A119-RESERVATION-A",
            INVENTORY_FIXTURE_DATE, PostingAction.RELEASE
        ));
        assertBalance("A119-INV", "16.0000", "0.0000", "16.0000");
        assertStockCountBookQuantity("A119-INV", "16.0000");
        assertThat(openingStockService.rows()).hasSize(1);
        assertThat(txnCount()).isEqualTo(6);
        assertInventoryListRow("A119 账套A库存物料", "16");

        useTenant(tenantB);
        createAuditedMaterial("A119-INV", "A119 账套B库存物料");
        openingStockService.saveRows(List.of(new OpeningStockService.OpeningStockLineRequest(
            "A119-INV",
            "CK-001",
            new BigDecimal("2"),
            new BigDecimal("3"),
            "A119-4-2 tenant B"
        )));
        saveAndAuditOtherStockIn(new BigDecimal("2"));
        inventoryPostingService.post(InventoryPostingCommand.test(
            "A119-INV", "CK-001", new BigDecimal("1"), "A119_ADJUST_IN", "A119",
            TENANT_B_ADJUST_HEADER_ID, TENANT_B_ADJUST_LINE_ID, "A119-ADJUST-B",
            INVENTORY_FIXTURE_DATE, PostingAction.AUDIT
        ));
        assertBalance("A119-INV", "5.0000", "0.0000", "5.0000");
        assertStockCountBookQuantity("A119-INV", "5.0000");
        assertThat(openingStockService.rows()).hasSize(1);
        assertThat(txnCount()).isEqualTo(3);
        assertThat(countProductsNamed("A119 账套A库存物料")).isZero();
        assertInventoryListRow("A119 账套B库存物料", "5");

        useTenant(tenantA);
        assertBalance("A119-INV", "16.0000", "0.0000", "16.0000");
        assertStockCountBookQuantity("A119-INV", "16.0000");
        assertThat(txnCount()).isEqualTo(6);
        assertThat(countProductsNamed("A119 账套B库存物料")).isZero();
        assertInventoryListRow("A119 账套A库存物料", "16");
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

    private void createAuditedMaterial(String code, String name) {
        var nameCode = "PN-" + code;
        masterDataController.create("productName", Map.of(
            "code", nameCode,
            "name", name
        ));
        masterDataController.audit("productName", nameCode);
        masterDataController.create("product", Map.of(
            "code", code,
            "name", name,
            "category", "RAW",
            "unit", "PCS",
            "isInventory", "true",
            "isProduce", "true"
        ));
        masterDataController.audit("product", code);
    }

    private void saveAndAuditOtherStockIn(BigDecimal qty) {
        var draft = otherStockInAppService.saveDraft(new OtherStockInAppService.OtherStockInDraftRequest(
            null,
            null,
            "2026-06-30",
            "A119",
            "admin",
            List.of(new OtherStockInAppService.OtherStockInLineRequest(
                null,
                "A119-INV",
                "CK-001",
                null,
                qty,
                BigDecimal.ONE,
                "A119-4-2 inventory document"
            ))
        ));
        otherStockInAppService.audit(String.valueOf(draft.get("billNo")));
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
              AND w.code = 'CK-001'
            """, productCode);
        assertThat((BigDecimal) row.get("onHand")).isEqualByComparingTo(onHand);
        assertThat((BigDecimal) row.get("reserved")).isEqualByComparingTo(reserved);
        assertThat((BigDecimal) row.get("available")).isEqualByComparingTo(available);
    }

    private void assertInventoryListRow(String productName, String onHand) {
        @SuppressWarnings("unchecked")
        var rows = (List<Map<String, Object>>) listStubController.rows(
            "inventory-query-list",
            "",
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
            .filteredOn(row -> productName.equals(row.get("name")))
            .singleElement()
            .satisfies(row -> assertThat(String.valueOf(row.get("onHand"))).isEqualTo(onHand));
    }

    private void assertStockCountBookQuantity(String productCode, String expectedQuantity) {
        var result = stockCountAppService.bookQuantity(null, productCode, "CK-001");
        assertThat((BigDecimal) result.get("bookQuantity")).isEqualByComparingTo(expectedQuantity);
    }

    private int txnCount() {
        return jdbcTemplate.queryForObject("SELECT count(*)::int FROM inv_stock_txn", Integer.class);
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
