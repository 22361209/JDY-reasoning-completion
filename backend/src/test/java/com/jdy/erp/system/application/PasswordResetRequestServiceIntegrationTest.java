package com.jdy.erp.system.application;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.clearInvocations;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.reset;
import static org.mockito.Mockito.verifyNoInteractions;
import static org.mockito.Mockito.when;

import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.util.ArrayList;
import java.util.UUID;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;

import com.jdy.erp.shared.application.OperationLogService;
import com.jdy.erp.system.security.PasswordResetRateLimiter;
import com.jdy.erp.system.security.PasswordResetRequestProperties;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;

@SpringBootTest(properties = "jdy.security.password-reset.cleanup-initial-delay-ms=3600000")
class PasswordResetRequestServiceIntegrationTest {
    private final String fixturePrefix = "a135prs" + UUID.randomUUID().toString().replace("-", "").substring(0, 10);

    @Autowired
    @Qualifier("platformJdbcTemplate")
    private JdbcTemplate jdbcTemplate;

    @Autowired
    @Qualifier("platformTransactionManager")
    private PlatformTransactionManager transactionManager;

    @Autowired
    private OperationLogService operationLogService;

    private TransactionTemplate transactions;

    @BeforeEach
    void setUp() {
        transactions = new TransactionTemplate(transactionManager);
    }

    @AfterEach
    void cleanupFixtures() {
        jdbcTemplate.update("""
            DELETE FROM sys_notification_outbox
            WHERE recipient_user_id IN (SELECT id FROM sys_user WHERE username LIKE ?)
               OR source_id IN (SELECT id FROM sys_password_reset_request WHERE username LIKE ?)
            """, fixturePrefix + "%", fixturePrefix + "%");
        jdbcTemplate.update("""
            DELETE FROM sys_operation_log
            WHERE target_id IN (SELECT id FROM sys_user WHERE username LIKE ?)
               OR failure_reason LIKE ?
            """, fixturePrefix + "%", "%" + fixturePrefix + "%");
        jdbcTemplate.update("DELETE FROM sys_password_reset_request WHERE username LIKE ?", fixturePrefix + "%");
        jdbcTemplate.update("DELETE FROM sys_user_role WHERE user_id IN (SELECT id FROM sys_user WHERE username LIKE ?)", fixturePrefix + "%");
        jdbcTemplate.update("DELETE FROM sys_user_account_set WHERE user_id IN (SELECT id FROM sys_user WHERE username LIKE ?)", fixturePrefix + "%");
        jdbcTemplate.update("DELETE FROM sys_user WHERE username LIKE ?", fixturePrefix + "%");
    }

    @Test
    void knownUserCreatesExactlyOnePendingAndUnknownUserCreatesNothing() {
        var username = createUser("known");
        var unknownUsername = fixturePrefix + "unknown";
        var service = service(properties(50, 500), allowingLimiter());
        var logsBefore = requestLogCount();

        submit(service, username, "首次联系说明", "192.0.2.101");
        submit(service, unknownUsername, "未知账号联系说明", "192.0.2.102");

        var rows = jdbcTemplate.queryForList("""
            SELECT username, contact_note AS "contactNote", status, version
            FROM sys_password_reset_request
            WHERE username IN (?, ?)
            """, username, unknownUsername);
        assertThat(rows).singleElement().satisfies(row -> {
            assertThat(row.get("username")).isEqualTo(username);
            assertThat(row.get("contactNote")).isEqualTo("首次联系说明");
            assertThat(row.get("status")).isEqualTo("PENDING");
            assertThat(row.get("version")).isEqualTo(0L);
        });
        assertThat(requestLogCount() - logsBefore).isEqualTo(1);
        assertThat(jdbcTemplate.queryForMap("""
            SELECT actor_type AS "actorType", operated_by AS "operatedBy"
            FROM sys_operation_log
            WHERE action_code = 'PASSWORD_RESET_REQUEST'
              AND target_id = (SELECT id FROM sys_user WHERE username = ?)
            ORDER BY operated_at DESC
            LIMIT 1
            """, username))
            .containsEntry("actorType", "ANONYMOUS")
            .containsEntry("operatedBy", null);
        assertThat(jdbcTemplate.queryForObject("""
            SELECT count(*)
            FROM sys_notification_outbox
            WHERE recipient_username = ?
            """, Integer.class, unknownUsername)).isZero();
    }

    @Test
    void limiterDenialOrFailureDoesNotTouchJdbcOrTransactionManager() {
        var isolatedJdbc = mock(JdbcTemplate.class);
        var isolatedTransactions = mock(PlatformTransactionManager.class);
        var limiter = mock(PasswordResetRateLimiter.class);
        when(limiter.tryAcquire(anyString(), anyString())).thenReturn(false);
        var service = new PasswordResetRequestService(
            isolatedJdbc,
            limiter,
            properties(50, 500),
            isolatedTransactions,
            mock(OperationLogService.class)
        );
        clearInvocations(isolatedJdbc, isolatedTransactions);

        service.submit("a135-denied", "限流拒绝", "192.0.2.200");

        verifyNoInteractions(isolatedJdbc, isolatedTransactions);

        reset(limiter);
        when(limiter.tryAcquire(anyString(), anyString())).thenThrow(new IllegalStateException("redis failed"));
        clearInvocations(isolatedJdbc, isolatedTransactions);

        service.submit("a135-failed", "Redis 失败", "192.0.2.201");

        verifyNoInteractions(isolatedJdbc, isolatedTransactions);
    }

    @Test
    void unknownUserDoesNotMutateAnyTableEvenWhenAnOldPendingRequestExists() {
        var oldPendingUser = createUser("unknown-snapshot-old");
        insertRequest(oldPendingUser, "PENDING", "73 hours", null);
        var service = service(properties(50, 500, Duration.ofHours(72)), allowingLimiter());
        var before = passwordResetDatabaseSnapshot();

        service.submit(fixturePrefix + "missing", "未知账号", "192.0.2.202");

        assertThat(passwordResetDatabaseSnapshot()).isEqualTo(before);
        assertThat(jdbcTemplate.queryForObject(
            "SELECT status FROM sys_password_reset_request WHERE username = ?",
            String.class,
            oldPendingUser
        )).isEqualTo("PENDING");
    }

    @Test
    void duplicateDoesNotChangeTheFirstPendingRequest() {
        var username = createUser("duplicate");
        var service = service(properties(50, 500), allowingLimiter());
        submit(service, username, "原始联系说明", "192.0.2.103");
        var before = requestSnapshot(username);

        submit(service, username, "攻击者覆盖内容", "192.0.2.104");

        assertThat(requestSnapshot(username)).isEqualTo(before);
        assertThat(jdbcTemplate.queryForObject("""
            SELECT count(*) FROM sys_password_reset_request
            WHERE username = ? AND status = 'PENDING'
            """, Integer.class, username)).isEqualTo(1);
    }

    @Test
    void databaseCooldownStillBlocksAfterThePendingRequestWasHandled() {
        var username = createUser("cooldown");
        var service = service(properties(50, 500), allowingLimiter());
        submit(service, username, "冷却原始申请", "192.0.2.105");
        jdbcTemplate.update("""
            UPDATE sys_password_reset_request
            SET status = 'DONE', handled_at = now(), version = version + 1
            WHERE username = ? AND status = 'PENDING'
            """, username);
        var logsBefore = requestLogCount();

        submit(service, username, "冷却期内的第二次申请", "192.0.2.106");

        assertThat(jdbcTemplate.queryForObject(
            "SELECT count(*) FROM sys_password_reset_request WHERE username = ?",
            Integer.class,
            username
        )).isEqualTo(1);
        assertThat(requestLogCount()).isEqualTo(logsBefore);
    }

    @Test
    void deniedRateLimitFailsClosedBeforeAnyPersistence() {
        var username = createUser("rate-denied");
        var limiter = mock(PasswordResetRateLimiter.class);
        when(limiter.tryAcquire(anyString(), anyString())).thenReturn(false);
        var service = service(properties(50, 500), limiter);
        var logsBefore = requestLogCount();

        submit(service, username, "Redis 拒绝时不落库", "192.0.2.107");

        assertThat(jdbcTemplate.queryForObject(
            "SELECT count(*) FROM sys_password_reset_request WHERE username = ?",
            Integer.class,
            username
        )).isZero();
        assertThat(requestLogCount()).isEqualTo(logsBefore);
    }

    @Test
    void twentyConcurrentSubmissionsStillCreateOnePendingAndOneLog() throws Exception {
        var username = createUser("concurrent");
        var service = service(properties(50, 500), allowingLimiter());
        var logsBefore = requestLogCount();
        var start = new CountDownLatch(1);
        var tasks = new ArrayList<java.util.concurrent.Future<?>>();
        try (var executor = Executors.newFixedThreadPool(20)) {
            for (var index = 0; index < 20; index++) {
                var taskIndex = index;
                tasks.add(executor.submit(() -> {
                    start.await();
                    submit(service, username, "并发联系说明-" + taskIndex, "192.0.2." + (120 + taskIndex));
                    return null;
                }));
            }
            start.countDown();
            for (var task : tasks) {
                task.get(20, TimeUnit.SECONDS);
            }
        }

        assertThat(jdbcTemplate.queryForObject("""
            SELECT count(*) FROM sys_password_reset_request
            WHERE username = ? AND status = 'PENDING'
            """, Integer.class, username)).isEqualTo(1);
        assertThat(requestLogCount() - logsBefore).isEqualTo(1);
    }

    @Test
    void pendingCapRejectsTheNextKnownUserWithoutSideEffects() {
        var firstUsername = createUser("cap-a");
        var rejectedUsername = createUser("cap-b");
        var service = service(properties(1, 500), allowingLimiter());
        submit(service, firstUsername, "佔用唯一待处理名额", "192.0.2.150");
        var logsBefore = requestLogCount();

        submit(service, rejectedUsername, "超过待处理上限", "192.0.2.151");

        assertThat(jdbcTemplate.queryForObject(
            "SELECT count(*) FROM sys_password_reset_request WHERE username = ?",
            Integer.class,
            rejectedUsername
        )).isZero();
        assertThat(requestLogCount()).isEqualTo(logsBefore);
    }

    @Test
    void cleanupExpiresPendingAndDeletesOnlyOneConfiguredBatchOfOldHistory() {
        transactions.executeWithoutResult(status -> {
            var pendingUser = createUser("expire");
            insertRequest(pendingUser, "PENDING", "73 hours", null);
            for (var index = 0; index < 3; index++) {
                insertRequest(createUser("old-" + index), "DONE", "100 days", "91 days");
            }
            var recentUser = createUser("recent");
            insertRequest(recentUser, "DONE", "10 days", "10 days");
            var service = service(properties(50, 2, Duration.ofHours(72)), allowingLimiter());
            var operationLogsBefore = jdbcTemplate.queryForObject("SELECT count(*) FROM sys_operation_log", Integer.class);
            var outboxBefore = jdbcTemplate.queryForObject("SELECT count(*) FROM sys_notification_outbox", Integer.class);

            service.cleanupExpiredAndOldRequests();

            assertThat(jdbcTemplate.queryForObject("""
                SELECT status FROM sys_password_reset_request WHERE username = ?
                """, String.class, pendingUser)).isEqualTo("EXPIRED");
            assertThat(jdbcTemplate.queryForObject("""
                SELECT count(*) FROM sys_password_reset_request
                WHERE username LIKE ? AND username LIKE '%old-%'
                """, Integer.class, fixturePrefix + "%")).isEqualTo(1);
            assertThat(jdbcTemplate.queryForObject(
                "SELECT count(*) FROM sys_password_reset_request WHERE username = ?",
                Integer.class,
                recentUser
            )).isEqualTo(1);
            assertThat(jdbcTemplate.queryForObject("SELECT count(*) FROM sys_operation_log", Integer.class))
                .isEqualTo(operationLogsBefore);
            assertThat(jdbcTemplate.queryForObject("SELECT count(*) FROM sys_notification_outbox", Integer.class))
                .isEqualTo(outboxBefore);
            status.setRollbackOnly();
        });
    }

    @Test
    void migrationDedupContractKeepsTheEarliestRequestAndExpiresOnlyLaterRows() throws Exception {
        var migration = Files.readString(Path.of("src/main/resources/db/migration/V96__password_reset_request_abuse_limits.sql"));
        assertThat(migration).contains("ORDER BY requested_at ASC, id ASC");

        var rows = jdbcTemplate.queryForList("""
            WITH candidates(id, contact_note, requested_at) AS (
                VALUES
                    ('00000000-0000-0000-0000-000000000001'::uuid, '最早申请', TIMESTAMPTZ '2026-01-01 00:00:00+00'),
                    ('00000000-0000-0000-0000-000000000002'::uuid, '稍后申请', TIMESTAMPTZ '2026-01-01 00:01:00+00')
            ), ranked AS (
                SELECT contact_note,
                       requested_at,
                       row_number() OVER (ORDER BY requested_at ASC, id ASC) AS row_no
                FROM candidates
            )
            SELECT contact_note AS "contactNote",
                   requested_at AS "requestedAt",
                   CASE WHEN row_no = 1 THEN 'PENDING' ELSE 'EXPIRED' END AS status
            FROM ranked
            ORDER BY requested_at
            """);
        assertThat(rows).hasSize(2);
        assertThat(rows.get(0).get("contactNote")).isEqualTo("最早申请");
        assertThat(rows.get(0).get("status")).isEqualTo("PENDING");
        assertThat(rows.get(1).get("contactNote")).isEqualTo("稍后申请");
        assertThat(rows.get(1).get("status")).isEqualTo("EXPIRED");
        assertThat(rows.get(0).get("requestedAt")).isNotEqualTo(rows.get(1).get("requestedAt"));
    }

    private PasswordResetRequestService service(
        PasswordResetRequestProperties properties,
        PasswordResetRateLimiter limiter
    ) {
        return new PasswordResetRequestService(jdbcTemplate, limiter, properties, transactionManager, operationLogService);
    }

    private PasswordResetRateLimiter allowingLimiter() {
        var limiter = mock(PasswordResetRateLimiter.class);
        when(limiter.tryAcquire(anyString(), anyString())).thenReturn(true);
        return limiter;
    }

    private PasswordResetRequestProperties properties(int maxPending, int cleanupBatchSize) {
        return properties(maxPending, cleanupBatchSize, Duration.ofDays(36_500));
    }

    private PasswordResetRequestProperties properties(
        int maxPending,
        int cleanupBatchSize,
        Duration pendingExpiry
    ) {
        return new PasswordResetRequestProperties(
            "a135:test:{password-reset-service}",
            "localhost",
            6379,
            Duration.ofSeconds(1),
            Duration.ofSeconds(1),
            Duration.ofMinutes(1),
            100,
            Duration.ofMinutes(10),
            10,
            Duration.ofMinutes(15),
            1,
            maxPending,
            pendingExpiry,
            Duration.ofDays(90),
            cleanupBatchSize,
            3_600_000,
            60_000
        );
    }

    private void submit(
        PasswordResetRequestService service,
        String username,
        String contactNote,
        String remoteAddress
    ) {
        service.submit(username, contactNote, remoteAddress);
    }

    private String createUser(String suffix) {
        var username = fixturePrefix + suffix;
        jdbcTemplate.update("""
            INSERT INTO sys_user (username, display_name, password_hash, enabled)
            VALUES (?, ?, '{noop}A135-Test-Password!', TRUE)
            """, username, "A135 密码找回测试");
        return username;
    }

    private void insertRequest(String username, String status, String requestedAgo, String handledAgo) {
        jdbcTemplate.update("""
            INSERT INTO sys_password_reset_request (
                username, contact_note, requested_user_id, status, requested_at, handled_at
            )
            SELECT ?, '清理测试', id, ?, now() - (?::interval),
                   CASE WHEN ?::text IS NULL THEN NULL ELSE now() - (?::interval) END
            FROM sys_user
            WHERE username = ?
            """, username, status, requestedAgo, handledAgo, handledAgo, username);
    }

    private java.util.Map<String, Object> requestSnapshot(String username) {
        return jdbcTemplate.queryForMap("""
            SELECT id::text AS id,
                   contact_note AS "contactNote",
                   requested_at AS "requestedAt",
                   version
            FROM sys_password_reset_request
            WHERE username = ? AND status = 'PENDING'
            """, username);
    }

    private int requestLogCount() {
        return jdbcTemplate.queryForObject("""
            SELECT count(*)
            FROM sys_operation_log
            WHERE module_code = 'SYSTEM'
              AND action_code = 'PASSWORD_RESET_REQUEST'
            """, Integer.class);
    }

    private String passwordResetDatabaseSnapshot() {
        return jdbcTemplate.queryForObject("""
            SELECT jsonb_build_object(
                'requests', (
                    SELECT md5(COALESCE(string_agg(to_jsonb(row_value)::text, E'\\n' ORDER BY row_value.id::text), ''))
                    FROM sys_password_reset_request row_value
                ),
                'logs', (
                    SELECT md5(COALESCE(string_agg(to_jsonb(row_value)::text, E'\\n' ORDER BY row_value.id::text), ''))
                    FROM sys_operation_log row_value
                ),
                'outbox', (
                    SELECT md5(COALESCE(string_agg(to_jsonb(row_value)::text, E'\\n' ORDER BY row_value.id::text), ''))
                    FROM sys_notification_outbox row_value
                )
            )::text
            """, String.class);
    }
}
