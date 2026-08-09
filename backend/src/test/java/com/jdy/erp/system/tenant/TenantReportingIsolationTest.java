package com.jdy.erp.system.tenant;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.when;

import java.math.BigDecimal;
import java.time.LocalDate;
import java.util.ArrayList;
import java.util.LinkedHashSet;
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
import com.jdy.erp.system.security.CurrentPermissionService;
import com.jdy.erp.system.security.CurrentSessionService;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.mock.web.MockHttpServletRequest;
import org.springframework.test.context.bean.override.mockito.MockitoBean;
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
    private static final String FIXTURE_PASSWORD = "A174-Tenant-Test!9";
    private static final String SHARED_ADMIN_USERNAME = "admin";

    @Autowired
    private AccountSetManagementService accountSetManagementService;

    @Autowired
    private CurrentSessionService currentSessionService;

    @MockitoBean
    private CurrentPermissionService currentPermissionService;

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
    private String fixtureUsername;
    private String fixtureUserId;
    private LocalDate baseDate;
    private SharedAdminSessionSnapshot sharedAdminSessionBefore;

    @BeforeEach
    void bindRequest() {
        // Tenant/report isolation is the contract under test. Permission enforcement has
        // dedicated tests, so this fixture must not inherit mutable shared ADMIN grants.
        when(currentPermissionService.currentRoleCode()).thenReturn("ADMIN");
        when(currentPermissionService.hasPermission(anyString())).thenReturn(true);
        TenantContext.clear();
        RequestContextHolder.resetRequestAttributes();
        sharedAdminSessionBefore = sharedAdminSessionSnapshot();
        var databaseDate = platformJdbcTemplate.queryForObject("SELECT CURRENT_DATE", LocalDate.class);
        assertThat(databaseDate).as("数据库当前日期").isNotNull();
        baseDate = databaseDate.minusMonths(1).withDayOfMonth(1);
        createFixtureIdentity();
        RequestContextHolder.setRequestAttributes(new ServletRequestAttributes(new MockHttpServletRequest()));
        currentSessionService.login(fixtureUsername, FIXTURE_PASSWORD, "BLD-TEST");
        TenantContext.setTenant(currentSessionService.currentAccountSet());
    }

    @AfterEach
    void cleanUp() {
        var errors = new ArrayList<Throwable>();
        try {
            clean(errors, "logout fixture identity", currentSessionService::logout);
            TenantContext.clear();
            clean(errors, "close tenant data sources", tenantDataSourceRegistry::close);

            var schemasToDrop = new LinkedHashSet<>(createdSchemas);
            for (var code : createdCodes) {
                clean(errors, "resolve schema for " + code, () -> schemasToDrop.addAll(platformJdbcTemplate.queryForList(
                    "SELECT schema_name FROM sys_account_set WHERE code = ? AND schema_name IS NOT NULL",
                    String.class,
                    code
                )));
            }
            for (var schema : schemasToDrop) {
                clean(errors, "drop schema " + schema, () -> platformJdbcTemplate.execute(
                    "DROP SCHEMA IF EXISTS " + quoteIdentifier(schema) + " CASCADE"
                ));
            }
            var tenantActorSchemasRemoved = actorSchemasRemoved(schemasToDrop, errors);
            for (var code : createdCodes) {
                clean(errors, "delete account-set grants for " + code, () -> platformJdbcTemplate.update("""
                    DELETE FROM sys_user_account_set
                    WHERE account_set_id IN (SELECT id FROM sys_account_set WHERE code = ?)
                    """, code));
                clean(errors, "delete account set " + code, () ->
                    platformJdbcTemplate.update("DELETE FROM sys_account_set WHERE code = ?", code));
            }
            deleteFixtureIdentity(errors, tenantActorSchemasRemoved);
            clean(errors, "verify fixture residue", () -> assertFixtureRemoved(schemasToDrop));
            if (sharedAdminSessionBefore != null) {
                clean(errors, "verify shared admin session unchanged", () ->
                    assertThat(sharedAdminSessionSnapshot()).isEqualTo(sharedAdminSessionBefore));
            }
        } finally {
            TenantContext.clear();
            RequestContextHolder.resetRequestAttributes();
        }
        if (!errors.isEmpty()) {
            var failure = new AssertionError("tenant reporting fixture cleanup failed");
            errors.forEach(failure::addSuppressed);
            throw failure;
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
        var salesOrderNo = saveAndAuditSalesOrder(salesQty);
        var deliveryNoticeNo = saveAndAuditDeliveryNotice(salesQty, salesOrderNo);
        var salesOutNo = saveAndAuditSalesOut(salesQty, deliveryNoticeNo);
        var purchaseOrderNo = saveAndAuditPurchaseOrder(purchaseOrderQty);
        var purchaseInNo = saveAndAuditPurchaseIn(purchaseInQty, purchaseOrderNo);
        createAuditedBom();
        var planNo = createPlan(planQty);
        var taskBillNo = pushDownPlan(planNo);
        savePrintTemplate(companyName);
        return new ReportState(
            customerName,
            supplierName,
            parentName,
            componentName,
            companyName,
            salesOrderNo,
            salesOutNo,
            purchaseInNo,
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
        var currentPeriod = baseDate.toString().substring(0, 7);
        var result = accountSetManagementService.createAccountSet(new AccountSetManagementService.AccountSetCreateRequest(
            code,
            code + " 账套",
            "测试",
            null,
            null,
            null,
            null,
            currentPeriod,
            currentPeriod
        ));
        @SuppressWarnings("unchecked")
        var row = (Map<String, Object>) result.get("accountSet");
        createdSchemas.add(String.valueOf(row.get("schemaName")));
        return code;
    }

    private void useTenant(String code) {
        TenantContext.clear();
        currentSessionService.switchAccountSet(code);
        TenantContext.setTenant(currentSessionService.currentAccountSet());
    }

    private void createFixtureIdentity() {
        fixtureUsername = "a174-report-" + UUID.randomUUID().toString().substring(0, 8).toLowerCase();
        fixtureUserId = platformJdbcTemplate.queryForObject("""
            INSERT INTO sys_user (username, display_name, password_hash, enabled, default_account_set_id)
            SELECT ?, 'A174 报表 tenant 测试', ?, TRUE, id
            FROM sys_account_set
            WHERE code = 'BLD-TEST'
            RETURNING id::text
            """, String.class, fixtureUsername, "{noop}" + FIXTURE_PASSWORD);
        platformJdbcTemplate.update("""
            INSERT INTO sys_user_role (user_id, role_id)
            SELECT ?::uuid, id
            FROM sys_role
            WHERE code = 'ADMIN'
            """, fixtureUserId);
        platformJdbcTemplate.update("""
            INSERT INTO sys_user_account_set (user_id, account_set_id, role_code, is_default, enabled)
            SELECT ?::uuid, id, 'ADMIN', TRUE, TRUE
            FROM sys_account_set
            WHERE code = 'BLD-TEST'
            """, fixtureUserId);
    }

    private boolean actorSchemasRemoved(LinkedHashSet<String> schemas, List<Throwable> errors) {
        try {
            for (var schema : schemas) {
                var remaining = platformJdbcTemplate.queryForObject(
                    "SELECT count(*) FROM pg_namespace WHERE nspname = ?",
                    Integer.class,
                    schema
                );
                if (remaining == null || remaining != 0) {
                    errors.add(new IllegalStateException("tenant actor schema was not removed: " + schema));
                    return false;
                }
            }
            return true;
        } catch (Throwable error) {
            errors.add(new IllegalStateException("verify tenant actor schemas removed", error));
            return false;
        }
    }

    private void deleteFixtureIdentity(List<Throwable> errors, boolean tenantActorSchemasRemoved) {
        if (fixtureUsername == null) {
            return;
        }
        var publicActorLogsCleared = false;
        try {
            platformJdbcTemplate.update("""
                DELETE FROM sys_operation_log
                WHERE actor_username = ? OR operated_by = ?::uuid
                """, fixtureUsername, fixtureUserId);
            var remaining = platformJdbcTemplate.queryForObject("""
                SELECT count(*)
                FROM sys_operation_log
                WHERE actor_username = ? OR operated_by = ?::uuid
                """, Integer.class, fixtureUsername, fixtureUserId);
            if (remaining == null || remaining != 0) {
                throw new IllegalStateException("public actor operation logs were not cleared");
            }
            publicActorLogsCleared = true;
        } catch (Throwable error) {
            errors.add(new IllegalStateException("delete and verify fixture operation logs", error));
        }
        clean(errors, "delete fixture session scopes", () -> platformJdbcTemplate.update("""
            DELETE FROM sys_session_account_scope
            WHERE user_id IN (SELECT id FROM sys_user WHERE username = ?)
            """, fixtureUsername));
        clean(errors, "delete fixture account-set grants", () -> platformJdbcTemplate.update("""
            DELETE FROM sys_user_account_set
            WHERE user_id IN (SELECT id FROM sys_user WHERE username = ?)
            """, fixtureUsername));
        clean(errors, "delete fixture roles", () -> platformJdbcTemplate.update("""
            DELETE FROM sys_user_role
            WHERE user_id IN (SELECT id FROM sys_user WHERE username = ?)
            """, fixtureUsername));
        if (tenantActorSchemasRemoved && publicActorLogsCleared) {
            clean(errors, "delete fixture user", () ->
                platformJdbcTemplate.update("DELETE FROM sys_user WHERE username = ?", fixtureUsername));
        } else {
            clean(errors, "disable retained fixture user", () -> platformJdbcTemplate.update(
                "UPDATE sys_user SET enabled = FALSE WHERE username = ?",
                fixtureUsername
            ));
            errors.add(new IllegalStateException(
                "fixture identity retained because actor-bearing schema or operation-log cleanup was incomplete"
            ));
        }
    }

    private void assertFixtureRemoved(LinkedHashSet<String> schemasToDrop) {
        assertThat(platformJdbcTemplate.queryForObject(
            "SELECT count(*) FROM sys_user WHERE username = ?",
            Integer.class,
            fixtureUsername
        )).isZero();
        if (fixtureUserId != null) {
            assertThat(platformJdbcTemplate.queryForObject(
                "SELECT count(*) FROM sys_session_account_scope WHERE user_id = ?::uuid",
                Integer.class,
                fixtureUserId
            )).isZero();
            assertThat(platformJdbcTemplate.queryForObject("""
                SELECT count(*)
                FROM sys_operation_log
                WHERE actor_username = ? OR operated_by = ?::uuid
                """, Integer.class, fixtureUsername, fixtureUserId)).isZero();
        }
        for (var code : createdCodes) {
            assertThat(platformJdbcTemplate.queryForObject(
                "SELECT count(*) FROM sys_account_set WHERE code = ?",
                Integer.class,
                code
            )).isZero();
        }
        for (var schema : schemasToDrop) {
            assertThat(platformJdbcTemplate.queryForObject(
                "SELECT count(*) FROM pg_namespace WHERE nspname = ?",
                Integer.class,
                schema
            )).isZero();
        }
    }

    private SharedAdminSessionSnapshot sharedAdminSessionSnapshot() {
        var userState = platformJdbcTemplate.queryForObject("""
            SELECT jsonb_build_object(
                'activeSessionToken', active_session_token,
                'activeSessionStartedAt', active_session_started_at,
                'lastSessionReplacedAt', last_session_replaced_at,
                'lastLoginAt', last_login_at,
                'sessionGeneration', session_generation,
                'version', version
            )::text
            FROM sys_user
            WHERE username = ?
            """, String.class, SHARED_ADMIN_USERNAME);
        var scopeState = platformJdbcTemplate.queryForObject("""
            SELECT COALESCE(jsonb_agg(jsonb_build_object(
                'sessionToken', scope.session_token::text,
                'accountSetId', scope.account_set_id::text,
                'scopeToken', scope.scope_token::text,
                'version', scope.version,
                'updatedAt', scope.updated_at
            ) ORDER BY scope.session_token), '[]'::jsonb)::text
            FROM sys_session_account_scope scope
            JOIN sys_user user_row ON user_row.id = scope.user_id
            WHERE user_row.username = ?
            """, String.class, SHARED_ADMIN_USERNAME);
        return new SharedAdminSessionSnapshot(userState, scopeState);
    }

    private void clean(List<Throwable> errors, String action, Runnable step) {
        try {
            step.run();
        } catch (Throwable error) {
            errors.add(new IllegalStateException(action, error));
        }
    }

    private String businessDate(int daysAfterBase) {
        return baseDate.plusDays(daysAfterBase).toString();
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
        createAuditedProductName("PN-" + PARENT_CODE, parentName);
        createAuditedProductName("PN-" + COMPONENT_CODE, componentName);
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

    private void createAuditedProductName(String code, String name) {
        masterDataController.create("productName", Map.of(
            "code", code,
            "name", name
        ));
        masterDataController.audit("productName", code);
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

    private String saveAndAuditSalesOrder(BigDecimal qty) {
        var saved = salesOrderAppService.saveDraft(new SalesOrderAppService.SalesOrderDraftRequest(
            null,
            CUSTOMER_CODE,
            businessDate(0),
            "销售部",
            fixtureUsername,
            "A119 reporting sales order",
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
                businessDate(5)
            ))
        ));
        var billNo = generatedBillNo(saved, "销售订单");
        salesOrderAppService.audit(billNo);
        return billNo;
    }

    private String saveAndAuditDeliveryNotice(BigDecimal qty, String salesOrderNo) {
        var saved = deliveryNoticeAppService.saveDraft(new DeliveryNoticeAppService.DeliveryNoticeDraftRequest(
            null,
            salesOrderNo,
            CUSTOMER_CODE,
            businessDate(1),
            "销售部",
            fixtureUsername,
            "A119 reporting delivery notice",
            List.of(new DeliveryNoticeAppService.DeliveryNoticeLineRequest(
                null,
                PARENT_CODE,
                WAREHOUSE_CODE,
                salesOrderNo,
                1,
                qty,
                new BigDecimal("15"),
                new BigDecimal("13"),
                "CM-A119-RPT",
                "CO-A119-RPT",
                "A119 reporting delivery line",
                businessDate(5)
            ))
        ));
        var billNo = generatedBillNo(saved, "发货通知单");
        deliveryNoticeAppService.audit(billNo);
        return billNo;
    }

    private String saveAndAuditSalesOut(BigDecimal qty, String deliveryNoticeNo) {
        var saved = salesOutAppService.saveDraft(new SalesOutAppService.SalesOutDraftRequest(
            null,
            deliveryNoticeNo,
            CUSTOMER_CODE,
            businessDate(2),
            "销售部",
            fixtureUsername,
            "A119 reporting sales out",
            List.of(new SalesOutAppService.SalesOutLineRequest(
                null,
                PARENT_CODE,
                WAREHOUSE_CODE,
                null,
                null,
                deliveryNoticeNo,
                1,
                qty,
                new BigDecimal("15"),
                new BigDecimal("13"),
                "CM-A119-RPT",
                "CO-A119-RPT",
                "A119 reporting out line",
                businessDate(5)
            ))
        ));
        var billNo = generatedBillNo(saved, "销售出库单");
        salesOutAppService.audit(billNo);
        return billNo;
    }

    private String saveAndAuditPurchaseOrder(BigDecimal qty) {
        var saved = purchaseOrderAppService.saveDraft(new PurchaseOrderAppService.PurchaseOrderDraftRequest(
            null,
            SUPPLIER_CODE,
            businessDate(0),
            "采购部",
            fixtureUsername,
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
                businessDate(5)
            ))
        ));
        var billNo = generatedBillNo(saved, "采购订单");
        purchaseOrderAppService.audit(billNo);
        return billNo;
    }

    private String saveAndAuditPurchaseIn(BigDecimal qty, String purchaseOrderNo) {
        var saved = purchaseInAppService.saveDraft(new PurchaseInAppService.PurchaseInDraftRequest(
            null,
            purchaseOrderNo,
            SUPPLIER_CODE,
            businessDate(1),
            "采购部",
            fixtureUsername,
            List.of(new PurchaseInAppService.PurchaseInLineRequest(
                null,
                COMPONENT_CODE,
                WAREHOUSE_CODE,
                purchaseOrderNo,
                1,
                qty,
                new BigDecimal("10"),
                new BigDecimal("13"),
                "A119 reporting purchase in line"
            ))
        ));
        var billNo = generatedBillNo(saved, "采购入库单");
        purchaseInAppService.audit(billNo);
        return billNo;
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

    private String createPlan(BigDecimal qty) {
        var saved = productionTaskAppService.createPlan(new ProductionTaskAppService.PlanRequest(
            null,
            PARENT_CODE,
            null,
            null,
            qty,
            "SELF",
            null,
            businessDate(5)
        ));
        var planNo = generatedBillNo(saved, "生产计划");
        productionTaskAppService.auditPlan(planNo);
        return planNo;
    }

    private String pushDownPlan(String planNo) {
        var result = productionTaskAppService.pushDownPlan(planNo);
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
                assertThat(row.get("billNo")).isEqualTo("YS-" + state.salesOutNo());
                assertThat(row.get("customer")).isEqualTo(state.customerName());
            });
        assertThat(singleRow("payable-list", state.supplierName()))
            .satisfies(row -> {
                assertThat(row.get("billNo")).isEqualTo("YF-" + state.purchaseInNo());
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
        var html = documentOutputController.printHtml("sales-order", state.salesOrderNo()).getBody();
        assertThat(html)
            .contains(state.companyName())
            .contains(state.customerName())
            .contains(state.parentName())
            .doesNotContain(oppositeMarker(state.companyName()))
            .doesNotContain(oppositeMarker(state.customerName()));
        var csv = documentOutputController.exportCsv("sales-order", state.salesOrderNo()).getBody();
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

    private String generatedBillNo(Map<String, Object> saved, String label) {
        var billNo = (String) saved.get("billNo");
        assertThat(billNo).as(label + "系统生成单号").isNotBlank();
        return billNo;
    }

    private String quoteIdentifier(String identifier) {
        return "\"" + identifier.replace("\"", "\"\"") + "\"";
    }

    private record SharedAdminSessionSnapshot(String userState, String scopeState) {
    }

    private record ReportState(
        String customerName,
        String supplierName,
        String parentName,
        String componentName,
        String companyName,
        String salesOrderNo,
        String salesOutNo,
        String purchaseInNo,
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
