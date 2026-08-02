package com.jdy.erp.system.application;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.argThat;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verify;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.UUID;

import com.jdy.erp.shared.application.OperationLogCommand;
import com.jdy.erp.shared.application.OperationLogFailureService;
import com.jdy.erp.shared.application.OperationLogService;
import com.jdy.erp.system.security.CurrentSessionService;
import com.jdy.erp.system.tenant.TenantContext;
import com.jdy.erp.system.tenant.TenantDataSourceRegistry;
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
class AccountSetManagementServiceTest {
    @Autowired
    private AccountSetManagementService accountSetManagementService;

    @Autowired
    private AccountSetInitializationService initializationService;

    @Autowired
    private AccountSetMaintenanceService maintenanceService;

    @Autowired
    private CurrentSessionService currentSessionService;

    @Autowired
    @Qualifier("platformJdbcTemplate")
    private JdbcTemplate platformJdbcTemplate;

    @Autowired
    private TenantDataSourceRegistry tenantDataSourceRegistry;

    private final List<String> createdCodes = new ArrayList<>();
    private final List<String> createdSchemas = new ArrayList<>();
    private final List<String> createdBackupSchemas = new ArrayList<>();

    @BeforeEach
    void bindRequest() {
        RequestContextHolder.setRequestAttributes(new ServletRequestAttributes(new MockHttpServletRequest()));
        currentSessionService.login("admin", "admin123", "BLD-TEST");
    }

    @AfterEach
    void cleanUp() {
        TenantContext.clear();
        RequestContextHolder.resetRequestAttributes();
        tenantDataSourceRegistry.close();
        for (var schema : createdBackupSchemas) {
            platformJdbcTemplate.execute("DROP SCHEMA IF EXISTS " + quoteIdentifier(schema) + " CASCADE");
        }
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
    void createAccountSetCreatesTenantSchemaSeedsAndAdminGrant() {
        var code = nextCode("A119C");
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
        var accountSet = result.get("accountSet");
        assertThat(accountSet).isInstanceOf(java.util.Map.class);
        @SuppressWarnings("unchecked")
        var row = (java.util.Map<String, Object>) accountSet;
        var schema = String.valueOf(row.get("schemaName"));
        createdSchemas.add(schema);

        assertThat(schema).startsWith("tenant_a119c");
        assertThat(tableExists(schema, "md_product")).isTrue();
        assertThat(tableExists(schema, "md_employee")).isTrue();
        assertThat(tableExists(schema, "md_financial_account")).isTrue();
        assertThat(tableExists(schema, "sales_order")).isTrue();
        assertThat(tableExists(schema, "ar_receipt_fund_line")).isTrue();
        assertThat(tableExists(schema, "ar_receipt_allocation")).isTrue();
        assertThat(tableExists(schema, "ap_payment_fund_line")).isTrue();
        assertThat(tableExists(schema, "ap_payment_allocation")).isTrue();
        assertThat(tableExists(schema, "sales_return")).isTrue();
        assertThat(tableExists(schema, "sales_return_line")).isTrue();
        assertThat(tableExists(schema, "sales_return_finance_allocation")).isTrue();
        assertThat(tableExists(schema, "md_import_batch")).isTrue();
        assertThat(tableExists(schema, "production_material_scrap")).isTrue();
        assertThat(tableExists(schema, "production_material_scrap_line")).isTrue();
        assertThat(tableExists(schema, "cash_transfer")).isTrue();
        assertThat(tableExists(schema, "cash_transfer_fact")).isTrue();
        assertThat(tableExists(schema, "purchase_plan")).isTrue();
        assertThat(tableExists(schema, "purchase_plan_line")).isTrue();
        assertThat(tableExists(schema, "document_number_sequence")).isTrue();
        assertThat(managedConstraintCount(schema, "p")).isEqualTo(89);
        assertThat(managedConstraintCount(schema, "u")).isEqualTo(85);
        assertThat(managedConstraintCount(schema, "f")).isEqualTo(199);
        assertThat(tenantScopeAccountSetForeignKeyCount(schema)).isZero();
        assertThat(managedConstraintCount(schema, "c")).isEqualTo(117);
        assertThat(countRows(schema, "md_unit")).isGreaterThanOrEqualTo(5);
        assertThat(warehouseNames(schema)).containsExactly(
            "冲压区材料仓",
            "冲压区片件仓",
            "焊接区片件仓",
            "焊接区配件仓",
            "安装区成品仓",
            "安装区配件仓",
            "安装区辅材仓",
            "安装区毛坯仓"
        );
        assertThat(productionDepartmentCodes(schema)).containsExactly("AZ", "BZ", "CY", "HJ", "JG");

        var grants = platformJdbcTemplate.queryForObject("""
            SELECT count(*)::int
            FROM sys_user_account_set uas
            JOIN sys_user u ON u.id = uas.user_id
            JOIN sys_account_set a ON a.id = uas.account_set_id
            WHERE u.username = 'admin'
              AND a.code = ?
              AND uas.enabled = TRUE
            """, Integer.class, code);
        assertThat(grants).isEqualTo(1);

        bindRequest();
        currentSessionService.login("admin", "admin123", code);
        assertThat(currentSessionService.currentAccountSetCode()).isEqualTo(code);
    }

    @Test
    void createAccountSetRefusesASecondRegistrationForTheSameTenantSchema() {
        var firstCode = nextCode("A137S1");
        var secondCode = nextCode("A137S2");
        var schema = "tenant_a137_shared_" + UUID.randomUUID().toString().substring(0, 8);
        var first = accountSetManagementService.createAccountSet(new AccountSetManagementService.AccountSetCreateRequest(
            firstCode, firstCode + " 账套", "测试", null, schema, null, null, "2026-07", "2026-07"
        ));
        @SuppressWarnings("unchecked")
        var firstRow = (Map<String, Object>) first.get("accountSet");
        createdSchemas.add(String.valueOf(firstRow.get("schemaName")));

        assertThatThrownBy(() -> accountSetManagementService.createAccountSet(
            new AccountSetManagementService.AccountSetCreateRequest(
                secondCode, secondCode + " 账套", "测试", null, schema, null, null, "2026-07", "2026-07"
            )
        ))
            .isInstanceOf(org.springframework.web.server.ResponseStatusException.class)
            .hasMessageContaining("schema 已被其他账套使用");
        assertThat(platformJdbcTemplate.queryForObject(
            "SELECT count(*)::int FROM sys_account_set WHERE lower(btrim(schema_name)) = lower(btrim(?))",
            Integer.class,
            schema
        )).isEqualTo(1);
        assertThat(platformJdbcTemplate.queryForObject(
            "SELECT count(*)::int FROM sys_account_set WHERE code = ?",
            Integer.class,
            secondCode
        )).isZero();
    }

    @Test
    void createAccountSetRefusesToAdoptAnExistingUnregisteredSchema() {
        var code = nextCode("A137EX");
        var schema = "tenant_a137_existing_" + UUID.randomUUID().toString().substring(0, 8);
        createdSchemas.add(schema);
        platformJdbcTemplate.execute("CREATE SCHEMA " + quoteIdentifier(schema));

        assertThatThrownBy(() -> accountSetManagementService.createAccountSet(
            new AccountSetManagementService.AccountSetCreateRequest(
                code, code + " 账套", "测试", null, schema, null, null, "2026-07", "2026-07"
            )
        ))
            .isInstanceOf(org.springframework.web.server.ResponseStatusException.class)
            .hasMessageContaining("不允许收编现有 schema");
        assertThat(platformJdbcTemplate.queryForObject(
            "SELECT count(*)::int FROM sys_account_set WHERE code = ?",
            Integer.class,
            code
        )).isZero();
    }

    @Test
    void publicTransitionAccountSetMaintenanceKeepsTheAccountSetScope() {
        var writer = mock(OperationLogService.class);
        var service = new AccountSetMaintenanceService(
            mock(JdbcTemplate.class),
            mock(CurrentSessionService.class),
            mock(com.jdy.erp.system.tenant.TenantSchemaProvisioner.class),
            writer,
            mock(OperationLogFailureService.class),
            mock(org.springframework.transaction.PlatformTransactionManager.class)
        );
        var accountSetId = UUID.fromString("00000000-0000-0000-0000-000000000136");

        service.logAccountSetOperation(
            Map.of("id", accountSetId.toString(), "code", "BLD-TEST", "name", "博莱德测试账套"),
            "public",
            "BACKUP_ACCOUNT_SET",
            "BK-BLD-TEST-A136"
        );

        verify(writer).logTenant(
            argThat(target -> target.accountSetId().equals(accountSetId)
                && target.code().equals("BLD-TEST")
                && target.name().equals("博莱德测试账套")
                && target.schemaName().equals("public")),
            argThat(command -> command.action().equals("BACKUP_ACCOUNT_SET")
                && command.actorMode() == OperationLogCommand.ActorMode.CURRENT_USER)
        );
    }

    @Test
    void initializeCurrentAccountSetClearsOnlyCurrentTenantSchema() {
        var codeA = createManagedAccountSet("A119A");
        var codeB = createManagedAccountSet("A119B");
        var schemaA = schemaFor(codeA);
        var schemaB = schemaFor(codeB);

        createSalesOrderFixture(schemaA, codeA);
        createSalesOrderFixture(schemaB, codeB);
        createImportBatchFixture(schemaA, codeA, "VALIDATED", "initialize-a");
        createImportBatchFixture(schemaB, codeB, "VALIDATED", "initialize-b");

        bindRequest();
        currentSessionService.login("admin", "admin123", codeA);
        TenantContext.setTenant(currentSessionService.currentAccountSet());

        initializationService.initializeCurrentAccountSet(true);

        assertThat(countRows(schemaA, "sales_order")).isZero();
        assertThat(countRows(schemaB, "sales_order")).isEqualTo(1);
        assertThat(countRows(schemaA, "md_import_batch")).isZero();
        assertThat(countRows(schemaB, "md_import_batch")).isEqualTo(1);
        var initialized = platformJdbcTemplate.queryForObject(
            "SELECT initialized FROM sys_account_set WHERE code = ?",
            Boolean.class,
            codeA
        );
        assertThat(initialized).isTrue();
    }

    @Test
    void backupAndRestoreCurrentAccountSetKeepsTenantDataAndLogsAccountSet() {
        var code = createManagedAccountSet("A119OPS");
        var schema = schemaFor(code);
        bindRequest();
        currentSessionService.login("admin", "admin123", code);
        TenantContext.setTenant(currentSessionService.currentAccountSet());

        platformJdbcTemplate.update("""
            INSERT INTO %s.md_product_category (code, name, sort_no, enabled, audit_status)
            VALUES ('OPS', '运维恢复测试', 99, TRUE, 'AUDITED')
            ON CONFLICT (code) DO UPDATE
            SET name = EXCLUDED.name,
                enabled = TRUE,
                audit_status = 'AUDITED'
            """.formatted(quoteIdentifier(schema)));
        platformJdbcTemplate.update("""
            INSERT INTO %s.md_employee (code, name, department, enabled, audit_status)
            VALUES ('OPS-E', '运维恢复员工', '财务部', TRUE, 'AUDITED')
            """.formatted(quoteIdentifier(schema)));
        platformJdbcTemplate.update("""
            INSERT INTO %s.md_financial_account (
                code, name, account_type, bank_name, account_no, account_holder,
                currency, enabled, audit_status
            )
            VALUES ('OPS-USD', '运维恢复美元账户', 'BANK', 'Test Bank', '00123', 'Test Holder',
                    'USD', TRUE, 'AUDITED')
            """.formatted(quoteIdentifier(schema)));
        var unsubmittedImportIds = List.of(
            createImportBatchFixture(schema, code, "VALIDATED", "restore-validated"),
            createImportBatchFixture(schema, code, "INVALID", "restore-invalid"),
            createImportBatchFixture(schema, code, "STALE", "restore-stale"),
            createImportBatchFixture(schema, code, "FAILED", "restore-failed")
        );
        var expiredImportId = createImportBatchFixture(
            schema, code, "EXPIRED", "restore-expired"
        );
        var committedImportId = createImportBatchFixture(
            schema, code, "COMMITTED", "restore-committed"
        );
        var materialScrapBillNo = createMaterialScrapRestoreFixture(schema, code);
        var purchasePlanReservationFixture = createPurchasePlanReservationRestoreFixture(schema, code);

        var backupResult = maintenanceService.backupCurrentAccountSet();
        @SuppressWarnings("unchecked")
        var backup = (java.util.Map<String, Object>) backupResult.get("backup");
        var backupSchema = String.valueOf(backup.get("backupSchemaName"));
        createdBackupSchemas.add(backupSchema);
        assertThat(String.valueOf(backup.get("tableCount"))).isEqualTo("89");
        platformJdbcTemplate.execute("ALTER TABLE %s.md_product_category DROP COLUMN remark".formatted(quoteIdentifier(backupSchema)));
        platformJdbcTemplate.execute("ALTER TABLE %s.sales_order ADD COLUMN is_tax_inclusive BOOLEAN NOT NULL DEFAULT FALSE".formatted(quoteIdentifier(backupSchema)));
        assertPurchasePlanReservations(
            backupSchema,
            purchasePlanReservationFixture,
            new java.math.BigDecimal("10.0000"),
            new java.math.BigDecimal("0.0000")
        );
        var backupLogId = platformJdbcTemplate.queryForObject("""
            SELECT id::text
            FROM %s.sys_operation_log
            WHERE action_code = 'BACKUP_ACCOUNT_SET'
            ORDER BY operated_at DESC
            LIMIT 1
            """.formatted(quoteIdentifier(schema)), String.class);

        platformJdbcTemplate.update("DELETE FROM %s.md_product_category WHERE code = 'OPS'".formatted(quoteIdentifier(schema)));
        platformJdbcTemplate.update("DELETE FROM %s.md_employee WHERE code = 'OPS-E'".formatted(quoteIdentifier(schema)));
        platformJdbcTemplate.update("DELETE FROM %s.md_financial_account WHERE code = 'OPS-USD'".formatted(quoteIdentifier(schema)));
        platformJdbcTemplate.update("DELETE FROM %s.md_import_batch".formatted(quoteIdentifier(schema)));
        platformJdbcTemplate.update(
            "DELETE FROM %s.production_material_scrap WHERE bill_no = ?".formatted(quoteIdentifier(schema)),
            materialScrapBillNo
        );
        platformJdbcTemplate.update("""
            UPDATE %s.purchase_requisition_line
            SET planned_qty = 5
            WHERE id IN (?::uuid, ?::uuid)
            """.formatted(quoteIdentifier(schema)),
            purchasePlanReservationFixture.get("draftLineId"),
            purchasePlanReservationFixture.get("auditedLineId")
        );
        assertThat(countRowsWhere(schema, "md_product_category", "code = 'OPS'")).isZero();
        assertThat(countRowsWhere(schema, "md_employee", "code = 'OPS-E'")).isZero();
        assertThat(countRowsWhere(schema, "md_financial_account", "code = 'OPS-USD'")).isZero();
        assertThat(countRows(schema, "md_import_batch")).isZero();
        assertThat(countRowsWhere(
            schema,
            "production_material_scrap",
            "bill_no = '" + materialScrapBillNo.replace("'", "''") + "'"
        )).isZero();

        maintenanceService.restoreCurrentAccountSet(String.valueOf(backup.get("backupName")));

        assertThat(countRowsWhere(schema, "md_product_category", "code = 'OPS'")).isEqualTo(1);
        assertThat(countRowsWhere(schema, "md_employee", "code = 'OPS-E'")).isEqualTo(1);
        assertThat(platformJdbcTemplate.queryForMap("""
            SELECT currency, account_no AS "accountNo"
            FROM %s.md_financial_account
            WHERE code = 'OPS-USD'
            """.formatted(quoteIdentifier(schema))))
            .containsEntry("currency", "USD")
            .containsEntry("accountNo", "00123");
        for (var importId : unsubmittedImportIds) {
            assertImportBatchState(schema, importId, "EXPIRED", 1L);
        }
        assertImportBatchState(schema, expiredImportId, "EXPIRED", 0L);
        assertImportBatchState(schema, committedImportId, "COMMITTED", 0L);
        assertThat(platformJdbcTemplate.queryForMap("""
            SELECT scrap.status,
                   scrap.business_type AS "businessType",
                   line.scrap_qty AS "scrapQty",
                   line.reissue_qty AS "reissueQty",
                   line.is_stock_in AS "isStockIn",
                   line.stock_in_status AS "stockInStatus"
            FROM %s.production_material_scrap scrap
            JOIN %s.production_material_scrap_line line ON line.scrap_id = scrap.id
            WHERE scrap.bill_no = ?
            """.formatted(quoteIdentifier(schema), quoteIdentifier(schema)), materialScrapBillNo))
            .containsEntry("status", "AUDITED")
            .containsEntry("businessType", "PRODUCTION_SCRAP")
            .containsEntry("scrapQty", new java.math.BigDecimal("2.0000"))
            .containsEntry("reissueQty", new java.math.BigDecimal("1.0000"))
            .containsEntry("isStockIn", false)
            .containsEntry("stockInStatus", "NOT_REQUIRED");
        assertPurchasePlanReservations(
            schema,
            purchasePlanReservationFixture,
            new java.math.BigDecimal("0.0000"),
            new java.math.BigDecimal("7.0000")
        );
        var logRows = platformJdbcTemplate.queryForList("""
            SELECT account_set_code AS "accountSetCode",
                   account_set_name AS "accountSetName"
            FROM %s.sys_operation_log
            WHERE action_code = 'RESTORE_ACCOUNT_SET'
            ORDER BY operated_at DESC
            LIMIT 1
            """.formatted(quoteIdentifier(schema)));
        assertThat(logRows).hasSize(1);
        assertThat(logRows.get(0).get("accountSetCode")).isEqualTo(code);
        assertThat(logRows.get(0).get("accountSetName")).isEqualTo(code + " 账套");
        assertThat(platformJdbcTemplate.queryForObject("""
            SELECT count(*)::int
            FROM %s.sys_operation_log
            WHERE id = ?::uuid
              AND action_code = 'BACKUP_ACCOUNT_SET'
            """.formatted(quoteIdentifier(schema)), Integer.class, backupLogId)).isEqualTo(1);

        platformJdbcTemplate.execute("DROP TABLE %s.md_unit".formatted(quoteIdentifier(backupSchema)));
        assertThatThrownBy(() -> maintenanceService.restoreCurrentAccountSet(String.valueOf(backup.get("backupName"))))
            .isInstanceOf(org.springframework.web.server.ResponseStatusException.class)
            .hasMessageContaining("备份缺少受管表：md_unit");
        assertThat(countRowsWhere(schema, "md_product_category", "code = 'OPS'")).isEqualTo(1);

        assertThatThrownBy(() -> maintenanceService.restoreCurrentAccountSet("missing-" + code))
            .isInstanceOf(org.springframework.web.server.ResponseStatusException.class)
            .hasMessageContaining("备份不存在");
        assertThat(platformJdbcTemplate.queryForObject("""
            SELECT count(*)::int
            FROM %s.sys_operation_log
            WHERE action_code = 'RESTORE_ACCOUNT_SET'
              AND success = FALSE
            """.formatted(quoteIdentifier(schema)), Integer.class)).isEqualTo(1);
        assertThat(platformJdbcTemplate.queryForObject("""
            SELECT count(*)::int
            FROM %s.sys_operation_log
            WHERE id = ?::uuid
              AND action_code = 'BACKUP_ACCOUNT_SET'
            """.formatted(quoteIdentifier(schema)), Integer.class, backupLogId)).isEqualTo(1);
    }

    private String createManagedAccountSet(String prefix) {
        var code = nextCode(prefix);
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
        var row = (java.util.Map<String, Object>) result.get("accountSet");
        createdSchemas.add(String.valueOf(row.get("schemaName")));
        return code;
    }

    private String nextCode(String prefix) {
        var code = prefix + "-" + UUID.randomUUID().toString().substring(0, 8).toUpperCase();
        createdCodes.add(code);
        return code;
    }

    private String schemaFor(String code) {
        return platformJdbcTemplate.queryForObject(
            "SELECT schema_name FROM sys_account_set WHERE code = ?",
            String.class,
            code
        );
    }

    private boolean tableExists(String schema, String tableName) {
        return Boolean.TRUE.equals(platformJdbcTemplate.queryForObject(
            "SELECT to_regclass(?) IS NOT NULL",
            Boolean.class,
            schema + "." + tableName
        ));
    }

    private int countRows(String schema, String tableName) {
        return platformJdbcTemplate.queryForObject(
            "SELECT count(*)::int FROM " + quoteIdentifier(schema) + "." + quoteIdentifier(tableName),
            Integer.class
        );
    }

    private int countRowsWhere(String schema, String tableName, String whereClause) {
        return platformJdbcTemplate.queryForObject(
            "SELECT count(*)::int FROM " + quoteIdentifier(schema) + "." + quoteIdentifier(tableName) + " WHERE " + whereClause,
            Integer.class
        );
    }

    private int managedConstraintCount(String schema, String constraintType) {
        return platformJdbcTemplate.queryForObject("""
            SELECT count(*)::int
            FROM pg_constraint constraint_row
            JOIN pg_class table_row ON table_row.oid = constraint_row.conrelid
            JOIN pg_namespace schema_row ON schema_row.oid = table_row.relnamespace
            JOIN public.sys_tenant_managed_table managed ON managed.table_name = table_row.relname
            WHERE schema_row.nspname = ?
              AND constraint_row.contype = ?
            """, Integer.class, schema, constraintType);
    }

    private int tenantScopeAccountSetForeignKeyCount(String schema) {
        return platformJdbcTemplate.queryForObject("""
            SELECT count(*)::int
            FROM pg_constraint constraint_row
            JOIN pg_class child_table ON child_table.oid = constraint_row.conrelid
            JOIN pg_namespace child_schema ON child_schema.oid = child_table.relnamespace
            JOIN pg_class parent_table ON parent_table.oid = constraint_row.confrelid
            JOIN pg_namespace parent_schema ON parent_schema.oid = parent_table.relnamespace
            WHERE constraint_row.contype = 'f'
              AND child_schema.nspname = ?
              AND parent_schema.nspname = 'public'
              AND parent_table.relname = 'sys_account_set'
              AND child_table.relname IN (
                  'document_number_sequence', 'inv_stock_balance', 'inv_stock_opening', 'inv_stock_txn'
              )
            """, Integer.class, schema);
    }

    private void createSalesOrderFixture(String schema, String code) {
        var customerId = platformJdbcTemplate.queryForObject("""
            INSERT INTO %s.md_customer (code, name, audit_status)
            VALUES (?, ?, 'AUDITED')
            RETURNING id::text
            """.formatted(quoteIdentifier(schema)), String.class, code + "-C", code + " 客户");
        platformJdbcTemplate.update("""
            INSERT INTO %s.sales_order (bill_no, customer_id, bill_date)
            VALUES (?, ?::uuid, current_date)
            """.formatted(quoteIdentifier(schema)), code + "-SO", customerId);
    }

    private String createMaterialScrapRestoreFixture(String schema, String code) {
        var quotedSchema = quoteIdentifier(schema);
        var suffix = UUID.randomUUID().toString().substring(0, 8).toUpperCase();
        var billNo = "CLBF-" + suffix;
        platformJdbcTemplate.execute("""
            WITH category AS (
                SELECT id FROM %1$s.md_product_category WHERE code = 'RAW' LIMIT 1
            ), unit_row AS (
                SELECT id, code FROM %1$s.md_unit WHERE code = 'PCS' LIMIT 1
            ), product AS (
                INSERT INTO %1$s.md_product (
                    code, name, unit, category, product_category_id, unit_id,
                    enabled, audit_status
                )
                SELECT '%2$s-MAT', '材料报废恢复物料', unit_row.code, '原材料',
                       category.id, unit_row.id, TRUE, 'AUDITED'
                FROM category, unit_row
                RETURNING id
            ), warehouse AS (
                SELECT id, code FROM %1$s.md_warehouse WHERE code = 'CK-001' LIMIT 1
            ), workshop AS (
                SELECT id, code, name FROM %1$s.md_production_department WHERE code = 'HJ' LIMIT 1
            ), bom AS (
                INSERT INTO %1$s.prod_bom (code, product_id, qty, enabled)
                SELECT '%2$s-BOM', product.id, 1, TRUE FROM product
                RETURNING id, product_id
            ), task AS (
                INSERT INTO %1$s.production_task (
                    bill_no, bom_id, product_id, warehouse_id, qty, status, department_code
                )
                SELECT '%2$s-TASK', bom.id, bom.product_id, warehouse.id, 10, 'AUDITED', workshop.code
                FROM bom, warehouse, workshop
                RETURNING id
            ), issue AS (
                INSERT INTO %1$s.production_material_issue (bill_no, task_id, status)
                SELECT '%2$s-ISSUE', task.id, 'AUDITED' FROM task
                RETURNING id
            ), issue_line AS (
                INSERT INTO %1$s.production_material_issue_line (
                    issue_id, line_no, product_id, product_code_snapshot,
                    product_name_snapshot, product_spec_snapshot, product_unit_snapshot,
                    warehouse_id, qty, unit_price, amount
                )
                SELECT issue.id, 1, product.id, '%2$s-MAT', '材料报废恢复物料', NULL,
                       'PCS', warehouse.id, 10, 1, 10
                FROM issue, product, warehouse
                RETURNING id, product_id, warehouse_id
            ), scrap AS (
                INSERT INTO %1$s.production_material_scrap (
                    bill_no, bill_date, business_type, source_issue_id,
                    workshop_id, workshop_code_snapshot, workshop_name_snapshot,
                    status, audited_at
                )
                SELECT '%3$s', current_date, 'PRODUCTION_SCRAP', issue.id,
                       workshop.id, workshop.code, workshop.name, 'AUDITED', now()
                FROM issue, workshop
                RETURNING id
            )
            INSERT INTO %1$s.production_material_scrap_line (
                scrap_id, line_no, source_issue_line_id, product_id,
                product_code_snapshot, product_name_snapshot, product_spec_snapshot,
                product_unit_snapshot, source_warehouse_id,
                source_warehouse_code_snapshot, issue_qty_snapshot,
                available_scrap_qty_snapshot, scrap_qty, scrap_reason,
                reissue_qty, is_stock_in, stock_in_status
            )
            SELECT scrap.id, 1, issue_line.id, issue_line.product_id,
                   '%2$s-MAT', '材料报废恢复物料', NULL, 'PCS',
                   issue_line.warehouse_id, warehouse.code, 10, 10, 2,
                   '恢复语义测试', 1, FALSE, 'NOT_REQUIRED'
            FROM scrap, issue_line, warehouse
            """.formatted(
                quotedSchema,
                code.replace("'", "''") + "-" + suffix,
                billNo.replace("'", "''")
            ));
        return billNo;
    }

    private Map<String, String> createPurchasePlanReservationRestoreFixture(String schema, String code) {
        var quotedSchema = quoteIdentifier(schema);
        var suffix = UUID.randomUUID().toString().substring(0, 8).toUpperCase();
        return platformJdbcTemplate.queryForMap("""
            WITH supplier AS (
                INSERT INTO %1$s.md_supplier (code, name, enabled, audit_status)
                VALUES ('%2$s-SUP', '采购计划恢复供应商', TRUE, 'AUDITED')
                RETURNING id, code, name
            ), product AS (
                SELECT id, code, name, spec, unit
                FROM %1$s.md_product
                ORDER BY created_at DESC, id
                LIMIT 1
            ), warehouse AS (
                SELECT id FROM %1$s.md_warehouse ORDER BY code LIMIT 1
            ), draft_requisition AS (
                INSERT INTO %1$s.purchase_requisition (
                    bill_no, supplier_id, supplier_code_snapshot, supplier_name_snapshot,
                    bill_date, department, status, owner_name
                )
                SELECT '%2$s-REQ-D', supplier.id, supplier.code, supplier.name,
                       current_date, '采购部', 'AUDITED', 'A172恢复回归'
                FROM supplier
                RETURNING id
            ), audited_requisition AS (
                INSERT INTO %1$s.purchase_requisition (
                    bill_no, supplier_id, supplier_code_snapshot, supplier_name_snapshot,
                    bill_date, department, status, owner_name
                )
                SELECT '%2$s-REQ-A', supplier.id, supplier.code, supplier.name,
                       current_date, '采购部', 'AUDITED', 'A172恢复回归'
                FROM supplier
                RETURNING id
            ), draft_line AS (
                INSERT INTO %1$s.purchase_requisition_line (
                    requisition_id, line_no, product_id, product_code_snapshot,
                    product_name_snapshot, product_spec_snapshot, product_unit_snapshot,
                    warehouse_id, supplier_id, supplier_code_snapshot,
                    supplier_name_snapshot, qty, ordered_qty, planned_qty
                )
                SELECT draft_requisition.id, 1, product.id, product.code,
                       product.name, product.spec, product.unit, warehouse.id,
                       supplier.id, supplier.code, supplier.name, 10, 0, 10
                FROM draft_requisition, product, warehouse, supplier
                RETURNING id, requisition_id, product_id, product_code_snapshot,
                          product_name_snapshot, product_spec_snapshot,
                          product_unit_snapshot, warehouse_id
            ), audited_line AS (
                INSERT INTO %1$s.purchase_requisition_line (
                    requisition_id, line_no, product_id, product_code_snapshot,
                    product_name_snapshot, product_spec_snapshot, product_unit_snapshot,
                    warehouse_id, supplier_id, supplier_code_snapshot,
                    supplier_name_snapshot, qty, ordered_qty, planned_qty
                )
                SELECT audited_requisition.id, 1, product.id, product.code,
                       product.name, product.spec, product.unit, warehouse.id,
                       supplier.id, supplier.code, supplier.name, 7, 0, 0
                FROM audited_requisition, product, warehouse, supplier
                RETURNING id, requisition_id, product_id, product_code_snapshot,
                          product_name_snapshot, product_spec_snapshot,
                          product_unit_snapshot, warehouse_id
            ), draft_plan AS (
                INSERT INTO %1$s.purchase_plan (
                    bill_no, source_requisition_id, source_requisition_no,
                    supplier_id, supplier_code_snapshot, supplier_name_snapshot,
                    bill_date, department, status, owner_name
                )
                SELECT '%2$s-PLAN-D', draft_line.requisition_id, '%2$s-REQ-D',
                       supplier.id, supplier.code, supplier.name, current_date,
                       '采购部', 'DRAFT', 'A172恢复回归'
                FROM draft_line, supplier
                RETURNING id
            ), audited_plan AS (
                INSERT INTO %1$s.purchase_plan (
                    bill_no, source_requisition_id, source_requisition_no,
                    supplier_id, supplier_code_snapshot, supplier_name_snapshot,
                    bill_date, department, status, owner_name
                )
                SELECT '%2$s-PLAN-A', audited_line.requisition_id, '%2$s-REQ-A',
                       supplier.id, supplier.code, supplier.name, current_date,
                       '采购部', 'AUDITED', 'A172恢复回归'
                FROM audited_line, supplier
                RETURNING id
            ), draft_plan_line AS (
                INSERT INTO %1$s.purchase_plan_line (
                    plan_id, line_no, source_requisition_line_id,
                    source_requisition_no, source_requisition_line_no,
                    product_id, product_code_snapshot, product_name_snapshot,
                    product_spec_snapshot, product_unit_snapshot, warehouse_id, qty
                )
                SELECT draft_plan.id, 1, draft_line.id, '%2$s-REQ-D', 1,
                       draft_line.product_id, draft_line.product_code_snapshot,
                       draft_line.product_name_snapshot, draft_line.product_spec_snapshot,
                       draft_line.product_unit_snapshot, draft_line.warehouse_id, 10
                FROM draft_plan, draft_line
            ), audited_plan_line AS (
                INSERT INTO %1$s.purchase_plan_line (
                    plan_id, line_no, source_requisition_line_id,
                    source_requisition_no, source_requisition_line_no,
                    product_id, product_code_snapshot, product_name_snapshot,
                    product_spec_snapshot, product_unit_snapshot, warehouse_id, qty
                )
                SELECT audited_plan.id, 1, audited_line.id, '%2$s-REQ-A', 1,
                       audited_line.product_id, audited_line.product_code_snapshot,
                       audited_line.product_name_snapshot, audited_line.product_spec_snapshot,
                       audited_line.product_unit_snapshot, audited_line.warehouse_id, 7
                FROM audited_plan, audited_line
            )
            SELECT draft_line.id::text AS "draftLineId",
                   audited_line.id::text AS "auditedLineId"
            FROM draft_line, audited_line
            """.formatted(quotedSchema, (code + "-" + suffix).replace("'", "''")))
            .entrySet().stream()
            .collect(java.util.stream.Collectors.toMap(Map.Entry::getKey, entry -> String.valueOf(entry.getValue())));
    }

    private void assertPurchasePlanReservations(
        String schema,
        Map<String, String> fixture,
        java.math.BigDecimal expectedDraftQty,
        java.math.BigDecimal expectedAuditedQty
    ) {
        assertThat(platformJdbcTemplate.queryForMap("""
            SELECT
                (SELECT planned_qty FROM %1$s.purchase_requisition_line WHERE id = ?::uuid) AS "draftQty",
                (SELECT planned_qty FROM %1$s.purchase_requisition_line WHERE id = ?::uuid) AS "auditedQty"
            """.formatted(quoteIdentifier(schema)), fixture.get("draftLineId"), fixture.get("auditedLineId")))
            .containsEntry("draftQty", expectedDraftQty)
            .containsEntry("auditedQty", expectedAuditedQty);
    }

    private String createImportBatchFixture(
        String schema,
        String accountSetCode,
        String status,
        String fileName
    ) {
        var committed = "COMMITTED".equals(status);
        var expired = "EXPIRED".equals(status);
        var invalid = "INVALID".equals(status) || "STALE".equals(status);
        var failed = "FAILED".equals(status);
        var payloadCleared = committed || expired;
        var rowsPayload = payloadCleared
            ? "[]"
            : invalid
                ? "[{\"rowNo\":3,\"payload\":{\"code\":\"A143-C001\"},\"errors\":[{\"field\":\"code\",\"code\":\"DUPLICATE\"}]}]"
                : "[{\"rowNo\":3,\"payload\":{\"code\":\"A143-C001\"},\"errors\":[]}]";
        return platformJdbcTemplate.queryForObject("""
            INSERT INTO %s.md_import_batch (
                account_set_id,
                account_set_code,
                created_by,
                created_by_username,
                import_type,
                template_version,
                original_file_name,
                file_sha256,
                file_size_bytes,
                status,
                total_rows,
                valid_rows,
                error_rows,
                committed_rows,
                rows_payload,
                failure_reason,
                expires_at,
                committed_at,
                payload_cleared_at
            )
            SELECT account_set.id,
                   account_set.code,
                   actor.id,
                   actor.username,
                   'customer',
                   1,
                   ?,
                   ?,
                   128,
                   ?,
                   1,
                   ?,
                   ?,
                   ?,
                   ?::jsonb,
                   ?,
                   now() + interval '30 minutes',
                   CASE WHEN ? THEN now() ELSE NULL END,
                   CASE WHEN ? THEN now() ELSE NULL END
            FROM public.sys_account_set account_set
            CROSS JOIN public.sys_user actor
            WHERE account_set.code = ?
              AND actor.username = 'admin'
            RETURNING id::text
            """.formatted(quoteIdentifier(schema)),
            String.class,
            fileName + ".xlsx",
            "a".repeat(64),
            status,
            invalid ? 0 : 1,
            invalid ? 1 : 0,
            committed ? 1 : 0,
            rowsPayload,
            failed ? "A143 fixture failure" : null,
            committed,
            payloadCleared,
            accountSetCode
        );
    }

    private void assertImportBatchState(
        String schema,
        String importId,
        String expectedStatus,
        long expectedVersion
    ) {
        assertThat(platformJdbcTemplate.queryForMap("""
            SELECT status,
                   rows_payload::text AS payload,
                   payload_cleared_at IS NOT NULL AS "payloadCleared",
                   version
            FROM %s.md_import_batch
            WHERE id = ?::uuid
            """.formatted(quoteIdentifier(schema)), importId))
            .containsEntry("status", expectedStatus)
            .containsEntry("payload", "[]")
            .containsEntry("payloadCleared", true)
            .containsEntry("version", expectedVersion);
    }

    private List<String> productionDepartmentCodes(String schema) {
        return platformJdbcTemplate.queryForList(
            "SELECT code FROM " + quoteIdentifier(schema) + ".md_production_department ORDER BY code",
            String.class
        );
    }

    private List<String> warehouseNames(String schema) {
        return platformJdbcTemplate.queryForList(
            "SELECT name FROM " + quoteIdentifier(schema) + ".md_warehouse ORDER BY code",
            String.class
        );
    }

    private String quoteIdentifier(String identifier) {
        return "\"" + identifier.replace("\"", "\"\"") + "\"";
    }
}
