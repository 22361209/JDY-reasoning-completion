package com.jdy.erp.system.tenant;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static com.jdy.erp.testsupport.InventoryTraceAssertions.assertExactLifecycle;
import static com.jdy.erp.testsupport.InventoryTraceAssertions.fact;
import static com.jdy.erp.testsupport.InventoryTraceAssertions.reversal;

import java.math.BigDecimal;
import java.time.LocalDate;
import java.util.ArrayList;
import java.util.LinkedHashSet;
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
    private static final String FIXTURE_PASSWORD = "A174-Tenant-Test!9";
    private static final String SHARED_ADMIN_USERNAME = "admin";

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
    private String fixtureUsername;
    private String fixtureUserId;
    private LocalDate databaseDate;
    private LocalDate baseDate;
    private SharedAdminSessionSnapshot sharedAdminSessionBefore;

    @BeforeEach
    void bindRequest() {
        TenantContext.clear();
        RequestContextHolder.resetRequestAttributes();
        sharedAdminSessionBefore = sharedAdminSessionSnapshot();
        databaseDate = platformJdbcTemplate.queryForObject("SELECT CURRENT_DATE", LocalDate.class);
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
            var failure = new AssertionError("tenant sales fixture cleanup failed");
            errors.forEach(failure::addSuppressed);
            throw failure;
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
        fixtureUsername = "a174-sales-" + UUID.randomUUID().toString().substring(0, 8).toLowerCase();
        fixtureUserId = platformJdbcTemplate.queryForObject("""
            INSERT INTO sys_user (username, display_name, password_hash, enabled, default_account_set_id)
            SELECT ?, 'A174 销售 tenant 测试', ?, TRUE, id
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
        var saved = salesQuoteAppService.saveDraft(new SalesQuoteAppService.SalesQuoteDraftRequest(
            null,
            CUSTOMER_CODE,
            businessDate(0),
            "销售部",
            fixtureUsername,
            remark,
            databaseDate.toString(),
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
                businessDate(5)
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
            businessDate(1),
            "销售部",
            fixtureUsername,
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
                businessDate(5)
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
            businessDate(2),
            "销售部",
            fixtureUsername,
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
                businessDate(5)
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
            businessDate(3),
            "销售部",
            fixtureUsername,
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
                businessDate(5)
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
            businessDate(4),
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

    private record SharedAdminSessionSnapshot(String userState, String scopeState) {
    }
}
