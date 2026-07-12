package com.jdy.erp.system.api;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import java.util.UUID;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;

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
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;
import org.springframework.web.server.ResponseStatusException;
import org.springframework.test.web.servlet.setup.MockMvcBuilders;

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
        var controller = controller(mock(PasswordResetRequestService.class), sessionService);
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
        assertThat(jdbcTemplate.queryForObject("""
            SELECT count(*) FROM sys_operation_log
            WHERE module_code = 'SYSTEM'
              AND action_code = 'HANDLE_PASSWORD_RESET_REQUEST'
              AND target_id = ?::uuid
            """, Integer.class, userId)).isEqualTo(1);
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
        var notificationProvider = mock(NotificationProviderService.class);
        when(notificationProvider.currentProviderCode()).thenReturn("LOCAL");
        return new UserManagementController(
            jdbcTemplate,
            sessionService,
            mock(PasswordPolicy.class),
            notificationProvider,
            requestService
        );
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
