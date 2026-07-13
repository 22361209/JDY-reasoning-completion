package com.jdy.erp.system.api;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.times;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;
import static org.mockito.ArgumentMatchers.argThat;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import java.util.UUID;
import java.util.List;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;

import com.jdy.erp.shared.application.OperationLogService;
import com.jdy.erp.shared.application.OperationLogCommand;
import com.jdy.erp.system.application.NotificationProviderService;
import com.jdy.erp.system.application.PasswordResetRequestService;
import com.jdy.erp.system.security.CurrentSessionService;
import com.jdy.erp.system.security.PasswordPolicy;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.dao.DataIntegrityViolationException;
import org.springframework.http.MediaType;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.mock.web.MockHttpServletRequest;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;
import org.springframework.web.server.ResponseStatusException;
import org.springframework.test.web.servlet.setup.MockMvcBuilders;
import org.springframework.web.context.request.RequestContextHolder;
import org.springframework.web.context.request.ServletRequestAttributes;

@SpringBootTest
class UserManagementPasswordResetIntegrationTest {
    private final String fixturePrefix = "a135umc" + UUID.randomUUID().toString().replace("-", "").substring(0, 10);

    @Autowired
    @Qualifier("platformJdbcTemplate")
    private JdbcTemplate jdbcTemplate;

    @Autowired
    @Qualifier("platformTransactionManager")
    private PlatformTransactionManager transactionManager;

    private TransactionTemplate transactions;

    @Autowired
    private UserManagementController managedController;

    @Autowired
    private CurrentSessionService currentSessionService;

    @BeforeEach
    void setUp() {
        transactions = new TransactionTemplate(transactionManager);
    }

    @AfterEach
    void cleanupFixtures() {
        RequestContextHolder.resetRequestAttributes();
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
    void createUpdateAndChangeOwnPasswordWriteUserActorWithoutSecrets() {
        bindRequest();
        currentSessionService.login("admin", "admin123", "BLD-TEST");
        var username = fixturePrefix + "actor";
        var initialPassword = "A136-Initial-Password!5";
        var changedPassword = "A136-Changed-Password!6";

        managedController.createUser(new UserManagementController.UserRequest(
            username,
            "A136 初始姓名",
            "WAREHOUSE",
            initialPassword,
            true,
            List.of("BLD-TEST"),
            "BLD-TEST"
        ));
        managedController.updateUser(username, new UserManagementController.UserRequest(
            username,
            "A136 更新姓名",
            "FINANCE",
            null,
            true,
            List.of("BLD-TEST"),
            "BLD-TEST"
        ));

        bindRequest();
        assertThatThrownBy(() -> currentSessionService.login(username, "wrong-password", "BLD-TEST"))
            .isInstanceOf(ResponseStatusException.class)
            .hasMessageContaining("用户名或密码错误");
        bindRequest();
        currentSessionService.login(username, initialPassword, "BLD-TEST");
        managedController.changePassword(new UserManagementController.ChangePasswordRequest(initialPassword, changedPassword));

        var userId = userId(username);
        var rows = jdbcTemplate.queryForList("""
            SELECT action_code AS action,
                   actor_type AS "actorType",
                   actor_username AS "actorUsername",
                   COALESCE(before_state::text, '') AS before,
                   COALESCE(after_state::text, '') AS after,
                   COALESCE(failure_reason, '') AS reason
            FROM sys_operation_log
            WHERE target_id = ?::uuid
              AND action_code IN ('CREATE_USER', 'UPDATE_USER', 'CHANGE_OWN_PASSWORD')
            ORDER BY operated_at, action_code
            """, userId);
        assertThat(rows).hasSize(3);
        assertThat(rows).allSatisfy(row -> {
            assertThat(row.get("actorType")).isEqualTo("USER");
            var serialized = row.get("before") + " " + row.get("after") + " " + row.get("reason");
            assertThat(serialized)
                .doesNotContain(initialPassword)
                .doesNotContain(changedPassword)
                .doesNotContain("{noop}")
                .doesNotContainIgnoringCase("password");
        });
        assertThat(rows).anySatisfy(row -> {
            assertThat(row.get("action")).isEqualTo("CREATE_USER");
            assertThat(row.get("actorUsername")).isEqualTo("admin");
            assertThat(row.get("after")).asString().contains("A136 初始姓名", "WAREHOUSE");
        });
        assertThat(rows).anySatisfy(row -> {
            assertThat(row.get("action")).isEqualTo("UPDATE_USER");
            assertThat(row.get("actorUsername")).isEqualTo("admin");
            assertThat(row.get("before")).asString().contains("A136 初始姓名", "WAREHOUSE");
            assertThat(row.get("after")).asString().contains("A136 更新姓名", "FINANCE");
        });
        assertThat(rows).anySatisfy(row -> {
            assertThat(row.get("action")).isEqualTo("CHANGE_OWN_PASSWORD");
            assertThat(row.get("actorUsername")).isEqualTo(username);
        });
        assertThat(jdbcTemplate.queryForMap("""
            SELECT actor_type AS "actorType",
                   operated_by AS "operatedBy",
                   actor_username AS "actorUsername"
            FROM sys_operation_log
            WHERE target_id = ?::uuid
              AND action_code = 'LOGIN'
              AND success = FALSE
            ORDER BY operated_at DESC
            LIMIT 1
            """, userId))
            .containsEntry("actorType", "ANONYMOUS")
            .containsEntry("operatedBy", null)
            .containsEntry("actorUsername", null);
        assertThat(jdbcTemplate.queryForMap("""
            SELECT actor_type AS "actorType", actor_username AS "actorUsername"
            FROM sys_operation_log
            WHERE target_id = ?::uuid
              AND action_code = 'LOGIN'
              AND success = TRUE
            ORDER BY operated_at DESC
            LIMIT 1
            """, userId))
            .containsEntry("actorType", "USER")
            .containsEntry("actorUsername", username);
    }

    @Test
    void publicEndpointAlwaysReturnsTheSameBodyAndRejectsOversizedInputWith400() throws Exception {
        var requestService = mock(PasswordResetRequestService.class);
        var controller = controller(requestService, mock(CurrentSessionService.class));
        var mockMvc = MockMvcBuilders.standaloneSetup(controller).build();
        var expectedMessage = "已提交找回申请，请联系管理员完成身份核验和密码重置。";

        var known = mockMvc.perform(post("/api/system/password-reset-requests")
                .with(request -> {
                    request.setRemoteAddr("192.0.2.201");
                    return request;
                })
                .contentType(MediaType.APPLICATION_JSON)
                .content("{\"username\":\"admin\",\"contactNote\":\"已知账号\"}"))
            .andExpect(status().isOk())
            .andExpect(jsonPath("$.ok").value(true))
            .andExpect(jsonPath("$.message").value(expectedMessage))
            .andReturn().getResponse().getContentAsString();
        var unknown = mockMvc.perform(post("/api/system/password-reset-requests")
                .with(request -> {
                    request.setRemoteAddr("192.0.2.202");
                    return request;
                })
                .contentType(MediaType.APPLICATION_JSON)
                .content("{\"username\":\"missing-a135-user\",\"contactNote\":\"未知账号\"}"))
            .andExpect(status().isOk())
            .andExpect(jsonPath("$.ok").value(true))
            .andExpect(jsonPath("$.message").value(expectedMessage))
            .andReturn().getResponse().getContentAsString();

        assertThat(unknown).isEqualTo(known);
        verify(requestService).submit("admin", "已知账号", "192.0.2.201");
        verify(requestService).submit("missing-a135-user", "未知账号", "192.0.2.202");

        mockMvc.perform(post("/api/system/password-reset-requests")
                .contentType(MediaType.APPLICATION_JSON)
                .content("{\"username\":\"" + "u".repeat(81) + "\",\"contactNote\":\"\"}"))
            .andExpect(status().isBadRequest());
        mockMvc.perform(post("/api/system/password-reset-requests")
                .contentType(MediaType.APPLICATION_JSON)
                .content("{\"username\":\"admin\",\"contactNote\":\"" + "n".repeat(241) + "\"}"))
            .andExpect(status().isBadRequest());
    }

    @Test
    void concurrentHandlersProduceOneTransitionOneNotificationAndOneSuccessLog() throws Exception {
        var username = createUser("handle");
        var userId = userId(username);
        var requestId = createPendingRequest(username, userId);
        var sessionService = mock(CurrentSessionService.class);
        when(sessionService.currentUsername()).thenReturn("admin");
        var operationLogService = mock(OperationLogService.class);
        var controller = controller(mock(PasswordResetRequestService.class), sessionService, operationLogService);
        var successes = new AtomicInteger();
        var conflicts = new AtomicInteger();
        var start = new CountDownLatch(1);

        try (var executor = Executors.newFixedThreadPool(2)) {
            var first = executor.submit(() -> handleConcurrently(controller, requestId, start, successes, conflicts));
            var second = executor.submit(() -> handleConcurrently(controller, requestId, start, successes, conflicts));
            start.countDown();
            first.get(20, TimeUnit.SECONDS);
            second.get(20, TimeUnit.SECONDS);
        }

        assertThat(successes.get()).isEqualTo(1);
        assertThat(conflicts.get()).isEqualTo(1);
        assertThat(jdbcTemplate.queryForObject(
            "SELECT status FROM sys_password_reset_request WHERE id = ?::uuid",
            String.class,
            requestId
        )).isEqualTo("REJECTED");
        assertThat(jdbcTemplate.queryForObject("""
            SELECT count(*) FROM sys_notification_outbox
            WHERE source_type = 'sys_password_reset_request'
              AND source_id = ?::uuid
              AND template_code = 'PASSWORD_RESET_REJECTED'
            """, Integer.class, requestId)).isEqualTo(1);
        verify(operationLogService, times(1)).logPlatform(argThat(command ->
            command != null
                && "HANDLE_PASSWORD_RESET_REQUEST".equals(command.action())
                && userId.equals(String.valueOf(command.targetId()))
                && command.beforeState().get(OperationLogCommand.StateField.REQUEST_STATUS).equals("PENDING")
                && command.afterState().get(OperationLogCommand.StateField.REQUEST_STATUS).equals("REJECTED")
        ));
    }

    @Test
    void migrationRejectsUnknownPendingRows() {
        assertThatThrownBy(() -> jdbcTemplate.update("""
            INSERT INTO sys_password_reset_request (username, contact_note, status, requested_user_id)
            VALUES (?, '未知账号', 'PENDING', NULL)
            """, fixturePrefix + "unknown"))
            .isInstanceOf(DataIntegrityViolationException.class);
    }

    private UserManagementController controller(
        PasswordResetRequestService requestService,
        CurrentSessionService sessionService
    ) {
        return controller(requestService, sessionService, mock(OperationLogService.class));
    }

    private UserManagementController controller(
        PasswordResetRequestService requestService,
        CurrentSessionService sessionService,
        OperationLogService operationLogService
    ) {
        var notificationProvider = mock(NotificationProviderService.class);
        when(notificationProvider.currentProviderCode()).thenReturn("LOCAL");
        return new UserManagementController(
            jdbcTemplate,
            sessionService,
            mock(PasswordPolicy.class),
            notificationProvider,
            requestService,
            operationLogService
        );
    }

    private void bindRequest() {
        RequestContextHolder.setRequestAttributes(new ServletRequestAttributes(new MockHttpServletRequest()));
    }

    private void handleConcurrently(
        UserManagementController controller,
        String requestId,
        CountDownLatch start,
        AtomicInteger successes,
        AtomicInteger conflicts
    ) {
        try {
            start.await();
        } catch (InterruptedException error) {
            Thread.currentThread().interrupt();
            throw new IllegalStateException("concurrent handler test interrupted", error);
        }
        try {
            transactions.executeWithoutResult(ignored -> controller.handlePasswordResetRequest(
                requestId,
                new UserManagementController.PasswordResetHandleRequest("REJECTED", "A135 并发核验")
            ));
            successes.incrementAndGet();
        } catch (ResponseStatusException error) {
            if (error.getStatusCode().value() == 409) {
                conflicts.incrementAndGet();
                return;
            }
            throw error;
        }
    }

    private String createUser(String suffix) {
        var username = fixturePrefix + suffix;
        jdbcTemplate.update("""
            INSERT INTO sys_user (username, display_name, password_hash, enabled)
            VALUES (?, 'A135 并发处理测试', '{noop}A135-Test-Password!', TRUE)
            """, username);
        return username;
    }

    private String userId(String username) {
        return jdbcTemplate.queryForObject(
            "SELECT id::text FROM sys_user WHERE username = ?",
            String.class,
            username
        );
    }

    private String createPendingRequest(String username, String userId) {
        return jdbcTemplate.queryForObject("""
            INSERT INTO sys_password_reset_request (username, contact_note, requested_user_id)
            VALUES (?, 'A135 并发通知联系说明', ?::uuid)
            RETURNING id::text
            """, String.class, username, userId);
    }
}
