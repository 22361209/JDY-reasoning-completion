package com.jdy.erp.shared.application;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.doCallRealMethod;
import static org.mockito.Mockito.doThrow;

import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.Callable;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.Executors;

import com.fasterxml.jackson.databind.node.JsonNodeFactory;
import com.jdy.erp.system.application.AccountSetMaintenanceService;
import com.jdy.erp.system.application.AccountSetManagementService;
import com.jdy.erp.system.security.CurrentSessionService;
import com.jdy.erp.system.tenant.TenantContext;
import com.jdy.erp.system.tenant.TenantDataSourceRegistry;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.mock.web.MockHttpServletRequest;
import org.springframework.test.context.bean.override.mockito.MockitoSpyBean;
import org.springframework.web.context.request.RequestContextHolder;
import org.springframework.web.context.request.ServletRequestAttributes;
import org.springframework.web.server.ResponseStatusException;

@SpringBootTest
class NumberingServiceReliabilityIntegrationTest {
    private static final JsonNodeFactory JSON = JsonNodeFactory.instance;
    private static final String DOCUMENT_TYPE = "stockCountGain";

    @Autowired
    private NumberingService numberingService;

    @Autowired
    private AccountSetManagementService accountSetManagementService;

    @Autowired
    private AccountSetMaintenanceService accountSetMaintenanceService;

    @MockitoSpyBean
    private OperationLogService operationLogService;

    @Autowired
    private CurrentSessionService currentSessionService;

    @Autowired
    private JdbcTemplate jdbcTemplate;

    @Autowired
    @Qualifier("platformJdbcTemplate")
    private JdbcTemplate platformJdbcTemplate;

    @Autowired
    private TenantDataSourceRegistry tenantDataSourceRegistry;

    private String tenantCode;
    private String tenantSchema;
    private Map<String, Object> tenantContext;
    private final List<String> backupSchemas = new ArrayList<>();

    @BeforeEach
    void createIsolatedTenant() {
        bindAndLogin("BLD-TEST");
        tenantCode = "A146-" + UUID.randomUUID().toString().substring(0, 8).toUpperCase();
        var result = accountSetManagementService.createAccountSet(new AccountSetManagementService.AccountSetCreateRequest(
            tenantCode,
            tenantCode + " 编号规则测试账套",
            "A146 regression",
            null,
            null,
            null,
            null,
            "2026-07",
            "2026-07"
        ));
        @SuppressWarnings("unchecked")
        var accountSet = (Map<String, Object>) result.get("accountSet");
        tenantSchema = String.valueOf(accountSet.get("schemaName"));
        bindAndLogin(tenantCode);
        tenantContext = Map.copyOf(currentSessionService.currentAccountSet());
    }

    @AfterEach
    void removeIsolatedTenant() {
        TenantContext.clear();
        RequestContextHolder.resetRequestAttributes();
        tenantDataSourceRegistry.close();
        for (var backupSchema : backupSchemas) {
            if (backupSchema.matches("[a-z][a-z0-9_]{0,62}")) {
                platformJdbcTemplate.execute("DROP SCHEMA IF EXISTS \"" + backupSchema + "\" CASCADE");
            }
        }
        if (tenantSchema != null && tenantSchema.matches("[a-z][a-z0-9_]{0,62}")) {
            platformJdbcTemplate.execute("DROP SCHEMA IF EXISTS \"" + tenantSchema + "\" CASCADE");
        }
        if (tenantCode != null) {
            platformJdbcTemplate.update("DELETE FROM sys_account_set_backup WHERE account_set_code = ?", tenantCode);
            platformJdbcTemplate.update("""
                DELETE FROM sys_user_account_set
                WHERE account_set_id IN (SELECT id FROM sys_account_set WHERE code = ?)
                """, tenantCode);
            platformJdbcTemplate.update("DELETE FROM sys_account_set WHERE code = ?", tenantCode);
        }
    }

    @Test
    void rulesAreReadOnlyUntilSaveAndIssuanceIsSerializedWithoutReuse() throws Exception {
        assertThat(jdbcTemplate.queryForObject("SELECT count(*) FROM document_number_sequence", Integer.class)).isZero();
        var defaults = numberingService.listRules();
        assertThat(defaults).hasSize(28);
        assertThat(defaults).extracting(row -> String.valueOf(row.get("documentType"))).doesNotHaveDuplicates();
        assertThat(defaults).anySatisfy(row -> assertThat(row)
            .containsEntry("documentType", "materialScrap")
            .containsEntry("prefix", "CLBF")
            .containsEntry("label", "材料报废单"));
        assertThat(defaults).anySatisfy(row -> assertThat(row)
            .containsEntry("documentType", "cashTransfer")
            .containsEntry("prefix", "ZJZZ")
            .containsEntry("label", "资金转账单"));
        assertThat(jdbcTemplate.queryForObject("SELECT count(*) FROM document_number_sequence", Integer.class)).isZero();

        var saved = save("A146PY", 6, "100", true, "0");
        assertThat(saved.get("lastNumber")).isEqualTo(100L);
        assertThat(saved.get("version")).isEqualTo("1");
        assertThat(operationLogCount()).isEqualTo(1);

        jdbcTemplate.update("""
            INSERT INTO document_number_sequence (
                account_set_id, document_type, prefix, last_number, width, description, enabled, version
            )
            SELECT account_set_id, 'unknownLegacy', 'LEG', 0, 6, '未知历史行', TRUE, 0
            FROM document_number_sequence
            WHERE document_type = ?
            """, DOCUMENT_TYPE);
        var visible = numberingService.listRules();
        assertThat(visible).hasSize(28);
        assertThat(visible).noneMatch(row -> "unknownLegacy".equals(row.get("documentType")));

        var generated = issueConcurrently(12);
        assertThat(generated).hasSize(12).doesNotHaveDuplicates();
        assertThat(generated.stream().map(this::sequence).sorted().toList())
            .containsExactlyElementsOf(longRange(101, 112));
        var afterIssuance = currentRule();
        assertThat(afterIssuance.get("lastNumber")).isEqualTo(112L);
        assertThat(afterIssuance.get("version")).isEqualTo("13");

        assertConflict(() -> save("A146PY", 6, "112", true, "1"));
        assertConflict(() -> save("A146PY", 6, "111", true, "13"));
        assertThat(currentRule()).containsEntry("lastNumber", 112L).containsEntry("version", "13");

        var updateOutcomes = updateConcurrently("13");
        assertThat(updateOutcomes.stream().filter(UpdateOutcome::success)).hasSize(1);
        assertThat(updateOutcomes.stream().filter(outcome -> outcome.status() == 409)).hasSize(1);
        assertThat(operationLogCount()).isEqualTo(2);

        var afterConcurrentUpdate = currentRule();
        var disabled = save(
            String.valueOf(afterConcurrentUpdate.get("prefix")),
            Number.class.cast(afterConcurrentUpdate.get("width")).intValue(),
            String.valueOf(afterConcurrentUpdate.get("lastNumber")),
            false,
            String.valueOf(afterConcurrentUpdate.get("version"))
        );
        assertThat(disabled.get("enabled")).isEqualTo(false);
        assertConflict(() -> numberingService.nextBillNo(DOCUMENT_TYPE));

        var enabled = save(
            String.valueOf(disabled.get("prefix")),
            Number.class.cast(disabled.get("width")).intValue(),
            String.valueOf(disabled.get("lastNumber")),
            true,
            String.valueOf(disabled.get("version"))
        );
        var resumed = numberingService.nextBillNo(DOCUMENT_TYPE);
        assertThat(sequence(resumed)).isEqualTo(Number.class.cast(enabled.get("lastNumber")).longValue() + 1);

        var beforeMaximum = currentRule();
        var maximum = save("A146PY", 3, "999", true, String.valueOf(beforeMaximum.get("version")));
        assertThat(maximum.get("lastNumber")).isEqualTo(999L);
        assertConflict(() -> numberingService.nextBillNo(DOCUMENT_TYPE));
        assertThat(currentRule()).containsEntry("lastNumber", 999L).containsEntry("version", maximum.get("version"));

        assertThat(operationLogCount()).isEqualTo(5);
        var latestLog = jdbcTemplate.queryForMap("""
            SELECT module_code AS module,
                   action_code AS action,
                   target_type AS target_type,
                   target_no AS target_no,
                   actor_type AS actor_type,
                   actor_username AS actor_username,
                   account_set_code AS account_set_code,
                   before_state,
                   after_state
            FROM sys_operation_log
            WHERE action_code = 'UPDATE_NUMBERING_RULE'
              AND target_no = ?
            ORDER BY operated_at DESC
            LIMIT 1
            """, DOCUMENT_TYPE);
        assertThat(latestLog)
            .containsEntry("module", "SYSTEM")
            .containsEntry("action", "UPDATE_NUMBERING_RULE")
            .containsEntry("target_type", "NUMBERING_RULE")
            .containsEntry("target_no", DOCUMENT_TYPE)
            .containsEntry("actor_type", "USER")
            .containsEntry("actor_username", "admin")
            .containsEntry("account_set_code", tenantCode);
        assertThat(String.valueOf(latestLog.get("before_state"))).contains("prefix", "width", "lastNumber", "enabled", "version");
        assertThat(String.valueOf(latestLog.get("after_state"))).contains("prefix", "width", "lastNumber", "enabled", "version");

        assertThat(platformJdbcTemplate.queryForObject(
            "SELECT count(*) FROM public.document_number_sequence WHERE prefix = 'A146PY'",
            Integer.class
        )).isZero();
    }

    @Test
    void invalidAndUnknownRulesFailWithoutWritesOrSuccessLogs() {
        assertStatus(HttpStatus.BAD_REQUEST, () -> save("BAD PREFIX", 6, "0", true, "0"));
        assertStatus(HttpStatus.BAD_REQUEST, () -> save("OK", 2, "0", true, "0"));
        assertStatus(HttpStatus.BAD_REQUEST, () -> save("OK", 6, "-1", true, "0"));
        assertStatus(HttpStatus.BAD_REQUEST, () -> save("OK", 3, "1000", true, "0"));
        assertStatus(HttpStatus.BAD_REQUEST, () -> numberingService.saveRule(
            "notRegistered",
            "OK",
            6,
            JSON.textNode("0"),
            true,
            JSON.textNode("0")
        ));
        assertThat(jdbcTemplate.queryForObject("SELECT count(*) FROM document_number_sequence", Integer.class)).isZero();
        assertThat(operationLogCount()).isZero();
    }

    @Test
    void issuanceAndRuleUpdateSerializeOnTheSameRowLock() throws Exception {
        save("RACEOLD", 6, "10", true, "0");
        var start = new CountDownLatch(1);
        var executor = Executors.newFixedThreadPool(2);
        try {
            var issuedFuture = executor.submit(() -> {
                TenantContext.setTenant(tenantContext);
                try {
                    start.await();
                    return numberingService.nextBillNo(DOCUMENT_TYPE);
                } finally {
                    TenantContext.clear();
                }
            });
            var updateFuture = executor.submit(() -> concurrentSave(start, "RACENEW", "20", "1"));
            start.countDown();

            var issued = issuedFuture.get();
            var update = updateFuture.get();
            var persisted = currentRule();
            if (update.success()) {
                assertThat(issued).isEqualTo("RACENEW000021");
                assertThat(persisted).containsEntry("prefix", "RACENEW")
                    .containsEntry("lastNumber", 21L)
                    .containsEntry("version", "3");
                assertThat(operationLogCount()).isEqualTo(2);
            } else {
                assertThat(update.status()).isEqualTo(409);
                assertThat(issued).isEqualTo("RACEOLD000011");
                assertThat(persisted).containsEntry("prefix", "RACEOLD")
                    .containsEntry("lastNumber", 11L)
                    .containsEntry("version", "2");
                assertThat(operationLogCount()).isEqualTo(1);
            }
        } finally {
            executor.shutdownNow();
        }
    }

    @Test
    void ruleChangeHonorsBothPersistedAndRequestedPrefixHighWater() {
        save("OLD", 4, "0", true, "0");
        insertFormalBill("OLD0042");
        insertFormalBill("NEW000123");

        assertConflict(() -> save("NEW", 6, "122", true, "1"));
        assertThat(currentRule()).containsEntry("prefix", "OLD")
            .containsEntry("lastNumber", 0L)
            .containsEntry("version", "1");

        var changed = save("NEW", 6, "123", true, "1");
        assertThat(changed).containsEntry("lastNumber", 123L).containsEntry("version", "2");
        assertThat(numberingService.nextBillNo(DOCUMENT_TYPE)).isEqualTo("NEW000124");
    }

    @Test
    void twelveDigitMaximumIssuesOnceThenReturnsConflictWithoutAdvancing() {
        var beforeMaximum = save("MAX", 12, "999999999998", true, "0");
        assertThat(beforeMaximum).containsEntry("version", "1");
        assertThat(numberingService.nextBillNo(DOCUMENT_TYPE)).isEqualTo("MAX999999999999");
        var atMaximum = currentRule();
        assertThat(atMaximum).containsEntry("lastNumber", 999999999999L).containsEntry("version", "2");

        assertConflict(() -> numberingService.nextBillNo(DOCUMENT_TYPE));
        assertThat(currentRule()).containsEntry("lastNumber", 999999999999L).containsEntry("version", "2");
    }

    @Test
    void operationLogFailureRollsBackRuleAndVersionInTheSameTransaction() {
        var before = save("ROLL", 6, "5", true, "0");
        assertThat(operationLogCount()).isEqualTo(1);
        doThrow(new IllegalStateException("A146 forced operation-log failure"))
            .when(operationLogService).logCurrent(any(OperationLogCommand.class));
        try {
            assertThatThrownBy(() -> save("ROLLNEXT", 6, "6", true, String.valueOf(before.get("version"))))
                .isInstanceOf(IllegalStateException.class)
                .hasMessageContaining("forced operation-log failure");
        } finally {
            doCallRealMethod().when(operationLogService).logCurrent(any(OperationLogCommand.class));
        }

        assertThat(currentRule()).containsEntry("prefix", "ROLL")
            .containsEntry("lastNumber", 5L)
            .containsEntry("version", "1");
        assertThat(operationLogCount()).isEqualTo(1);
    }

    @Test
    void realAccountSetMaintenanceBackupAndRestorePreservesBigintVersionAndNoLegacyRule() {
        var persisted = save("RESTORE", 12, "999999999998", true, "0");
        var backupResult = accountSetMaintenanceService.backupCurrentAccountSet();
        @SuppressWarnings("unchecked")
        var backup = (Map<String, Object>) backupResult.get("backup");
        var backupSchema = String.valueOf(backup.get("backupSchemaName"));
        backupSchemas.add(backupSchema);
        assertThat(platformJdbcTemplate.queryForMap("""
            SELECT prefix, last_number AS "lastNumber", width, version
            FROM %s.document_number_sequence
            WHERE document_type = ?
            """.formatted(quoteIdentifier(backupSchema)), DOCUMENT_TYPE))
            .containsEntry("prefix", "RESTORE")
            .containsEntry("lastNumber", 999999999998L)
            .containsEntry("width", 12)
            .containsEntry("version", 1L);

        save("MUTATED", 12, "999999999998", true, String.valueOf(persisted.get("version")));
        accountSetMaintenanceService.restoreCurrentAccountSet(String.valueOf(backup.get("backupName")));

        assertThat(currentRule()).containsEntry("prefix", "RESTORE")
            .containsEntry("lastNumber", 999999999998L)
            .containsEntry("width", 12)
            .containsEntry("version", "1");
        assertThat(jdbcTemplate.queryForObject(
            "SELECT count(*) FROM document_number_sequence WHERE document_type = 'outsourcingSurface'",
            Integer.class
        )).isZero();
        assertThat(platformJdbcTemplate.queryForObject(
            "SELECT count(*) FROM " + quoteIdentifier(backupSchema)
                + ".document_number_sequence WHERE document_type = 'outsourcingSurface'",
            Integer.class
        )).isZero();
    }

    private List<String> issueConcurrently(int count) throws Exception {
        var start = new CountDownLatch(1);
        var executor = Executors.newFixedThreadPool(count);
        try {
            var futures = new ArrayList<java.util.concurrent.Future<String>>();
            for (int index = 0; index < count; index += 1) {
                futures.add(executor.submit(() -> {
                    TenantContext.setTenant(tenantContext);
                    try {
                        start.await();
                        return numberingService.nextBillNo(DOCUMENT_TYPE);
                    } finally {
                        TenantContext.clear();
                    }
                }));
            }
            start.countDown();
            var values = new ArrayList<String>();
            for (var future : futures) values.add(future.get());
            return values;
        } finally {
            executor.shutdownNow();
        }
    }

    private List<UpdateOutcome> updateConcurrently(String version) throws Exception {
        var start = new CountDownLatch(1);
        var executor = Executors.newFixedThreadPool(2);
        try {
            List<Callable<UpdateOutcome>> tasks = List.of(
                () -> concurrentSave(start, "A146A", "120", version),
                () -> concurrentSave(start, "A146B", "130", version)
            );
            var first = executor.submit(tasks.get(0));
            var second = executor.submit(tasks.get(1));
            start.countDown();
            return List.of(first.get(), second.get());
        } finally {
            executor.shutdownNow();
        }
    }

    private UpdateOutcome concurrentSave(CountDownLatch start, String prefix, String lastNumber, String version) throws Exception {
        bindAndLogin(tenantCode);
        try {
            start.await();
            save(prefix, 6, lastNumber, true, version);
            return new UpdateOutcome(true, 200);
        } catch (ResponseStatusException exception) {
            return new UpdateOutcome(false, exception.getStatusCode().value());
        } finally {
            TenantContext.clear();
            RequestContextHolder.resetRequestAttributes();
        }
    }

    @SuppressWarnings("unchecked")
    private Map<String, Object> save(String prefix, int width, String lastNumber, boolean enabled, String version) {
        var result = numberingService.saveRule(
            DOCUMENT_TYPE,
            prefix,
            width,
            JSON.textNode(lastNumber),
            enabled,
            JSON.textNode(version)
        );
        return (Map<String, Object>) result.get("rule");
    }

    private Map<String, Object> currentRule() {
        return numberingService.listRules().stream()
            .filter(row -> DOCUMENT_TYPE.equals(row.get("documentType")))
            .findFirst()
            .orElseThrow();
    }

    private int operationLogCount() {
        return jdbcTemplate.queryForObject("""
            SELECT count(*)
            FROM sys_operation_log
            WHERE action_code = 'UPDATE_NUMBERING_RULE'
              AND target_no = ?
            """, Integer.class, DOCUMENT_TYPE);
    }

    private void insertFormalBill(String billNo) {
        jdbcTemplate.update(
            "INSERT INTO stock_count_gain (bill_no, bill_date) VALUES (?, current_date)",
            billNo
        );
    }

    private long sequence(String billNo) {
        return Long.parseLong(billNo.replaceFirst("^[A-Z0-9_-]+?(?=[0-9]{3,12}$)", ""));
    }

    private List<Long> longRange(long first, long last) {
        var result = new ArrayList<Long>();
        for (long value = first; value <= last; value += 1) result.add(value);
        result.sort(Comparator.naturalOrder());
        return result;
    }

    private void bindAndLogin(String accountSetCode) {
        TenantContext.clear();
        RequestContextHolder.setRequestAttributes(new ServletRequestAttributes(new MockHttpServletRequest()));
        currentSessionService.login("admin", "admin123", accountSetCode);
        TenantContext.setTenant(currentSessionService.currentAccountSet());
    }

    private void assertConflict(Callable<?> action) {
        assertStatus(HttpStatus.CONFLICT, action);
    }

    private void assertStatus(HttpStatus status, Callable<?> action) {
        assertThatThrownBy(action::call)
            .isInstanceOf(ResponseStatusException.class)
            .satisfies(error -> assertThat(((ResponseStatusException) error).getStatusCode()).isEqualTo(status));
    }

    private String quoteIdentifier(String identifier) {
        if (identifier == null || !identifier.matches("[a-z][a-z0-9_]{0,62}")) {
            throw new IllegalArgumentException("unsafe identifier");
        }
        return "\"" + identifier.replace("\"", "\"\"") + "\"";
    }

    private record UpdateOutcome(boolean success, int status) {
    }
}
