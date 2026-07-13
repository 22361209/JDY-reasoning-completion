package com.jdy.erp.system.security;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;

import jakarta.servlet.http.HttpSession;

import com.jdy.erp.system.api.UserManagementController;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.mock.web.MockHttpServletRequest;
import org.springframework.mock.web.MockHttpSession;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.context.request.RequestContextHolder;
import org.springframework.web.context.request.ServletRequestAttributes;
import org.springframework.web.server.ResponseStatusException;

@SpringBootTest
@Transactional(transactionManager = "platformTransactionManager")
class CurrentSessionServiceAccountSetAuthorizationTest {
    @Autowired
    @Qualifier("platformJdbcTemplate")
    private JdbcTemplate jdbcTemplate;

    @Autowired
    private CurrentSessionService currentSessionService;

    @Autowired
    private UserManagementController userManagementController;

    private MockHttpServletRequest request;

    @BeforeEach
    void bindRequest() {
        request = new MockHttpServletRequest();
        RequestContextHolder.setRequestAttributes(new ServletRequestAttributes(request));
    }

    @AfterEach
    void clearRequest() {
        RequestContextHolder.resetRequestAttributes();
    }

    @Test
    void loginPageCanListEnabledAccountSetsBeforeAuthentication() {
        var accountSets = currentSessionService.availableAccountSets();

        assertThat(accountSets)
            .extracting(row -> row.get("code"))
            .contains("BLD-TEST");
    }

    @Test
    void nonAdminCannotLoginToUnassignedAccountSet() {
        var accountSetCode = insertAccountSet("A119-BLOCKED");

        assertThatThrownBy(() -> currentSessionService.login("warehouse", "warehouse123", accountSetCode))
            .isInstanceOf(ResponseStatusException.class)
            .satisfies(error -> assertThat(((ResponseStatusException) error).getStatusCode()).isEqualTo(HttpStatus.FORBIDDEN));
    }

    @Test
    void nonAdminAvailableAccountSetsAreFilteredByGrant() {
        var accountSetCode = insertAccountSet("A119-HIDDEN");

        currentSessionService.login("warehouse", "warehouse123", "BLD-TEST");
        var accountSets = currentSessionService.availableAccountSets();

        assertThat(accountSets)
            .extracting(row -> row.get("code"))
            .contains("BLD-TEST")
            .doesNotContain(accountSetCode);
    }

    @Test
    void adminCanLoginToAnyEnabledAccountSet() {
        var accountSetCode = insertAccountSet("A119-ADMIN");

        currentSessionService.login("admin", "admin123", accountSetCode);

        HttpSession session = request.getSession(false);
        assertThat(session).isNotNull();
        assertThat(session.getAttribute(CurrentSessionService.SESSION_ACCOUNT_SET_CODE)).isEqualTo(accountSetCode);
        assertThat(session.getAttribute(CurrentSessionService.SESSION_ACCOUNT_SET_SCOPE_TOKEN)).isNotNull();
    }

    @Test
    void accountSetScopeTokenRotatesOnEverySwitchIncludingDirectReturn() {
        var accountSetA = insertAccountSet("A140-SCOPE-A");
        var accountSetB = insertAccountSet("A140-SCOPE-B");

        currentSessionService.login("admin", "admin123", accountSetA);
        HttpSession session = request.getSession(false);
        assertThat(session).isNotNull();
        var tokenA = String.valueOf(session.getAttribute(CurrentSessionService.SESSION_ACCOUNT_SET_SCOPE_TOKEN));

        currentSessionService.switchAccountSet(accountSetB);
        var tokenB = String.valueOf(session.getAttribute(CurrentSessionService.SESSION_ACCOUNT_SET_SCOPE_TOKEN));
        currentSessionService.switchAccountSet(accountSetA);
        var tokenAAfterReturn = String.valueOf(session.getAttribute(CurrentSessionService.SESSION_ACCOUNT_SET_SCOPE_TOKEN));

        assertThat(tokenA).isNotBlank();
        assertThat(tokenB).isNotBlank().isNotEqualTo(tokenA);
        assertThat(tokenAAfterReturn).isNotBlank().isNotEqualTo(tokenA).isNotEqualTo(tokenB);
    }

    @Test
    void accountSetIdCodeAndScopeTokenPublishAsOneSessionSnapshot() throws Exception {
        var session = new BlockingScopeSession();
        var accountSetA = Map.<String, Object>of("id", UUID.randomUUID(), "code", "A140-ATOMIC-A");
        var accountSetB = Map.<String, Object>of("id", UUID.randomUUID(), "code", "A140-ATOMIC-B");
        currentSessionService.setSessionAccountSet(session, accountSetA);
        var oldToken = String.valueOf(session.getAttribute(CurrentSessionService.SESSION_ACCOUNT_SET_SCOPE_TOKEN));
        session.blockAfterAccountSetId = true;
        var readerStarted = new CountDownLatch(1);
        var readerFinished = new CountDownLatch(1);

        try (var executor = Executors.newFixedThreadPool(2)) {
            var switchFuture = executor.submit(() -> currentSessionService.setSessionAccountSet(session, accountSetB));
            assertThat(session.accountSetIdWritten.await(5, TimeUnit.SECONDS)).isTrue();
            var readerFuture = executor.submit(() -> {
                readerStarted.countDown();
                synchronized (session) {
                    try {
                        return List.of(
                            String.valueOf(session.getAttribute(CurrentSessionService.SESSION_ACCOUNT_SET_ID)),
                            String.valueOf(session.getAttribute(CurrentSessionService.SESSION_ACCOUNT_SET_CODE)),
                            String.valueOf(session.getAttribute(CurrentSessionService.SESSION_ACCOUNT_SET_SCOPE_TOKEN))
                        );
                    } finally {
                        readerFinished.countDown();
                    }
                }
            });
            assertThat(readerStarted.await(5, TimeUnit.SECONDS)).isTrue();
            assertThat(readerFinished.await(200, TimeUnit.MILLISECONDS)).isFalse();

            session.releaseAccountSetWrite.countDown();
            switchFuture.get(5, TimeUnit.SECONDS);
            var snapshot = readerFuture.get(5, TimeUnit.SECONDS);
            assertThat(snapshot).containsExactly(
                String.valueOf(accountSetB.get("id")),
                String.valueOf(accountSetB.get("code")),
                String.valueOf(session.getAttribute(CurrentSessionService.SESSION_ACCOUNT_SET_SCOPE_TOKEN))
            );
            assertThat(snapshot.get(2)).isNotBlank().isNotEqualTo(oldToken);
        } finally {
            session.releaseAccountSetWrite.countDown();
        }
    }

    @Test
    void adminCanGrantAccountSetToNonAdminUser() {
        var accountSetCode = insertAccountSet("A119-GRANTED");

        currentSessionService.login("admin", "admin123", "BLD-TEST");
        userManagementController.saveUserAccountSets(
            "warehouse",
            new UserManagementController.AccountSetGrantRequest(List.of(accountSetCode), accountSetCode)
        );
        bindRequest();

        currentSessionService.login("warehouse", "warehouse123", accountSetCode);

        HttpSession session = request.getSession(false);
        assertThat(session).isNotNull();
        assertThat(session.getAttribute(CurrentSessionService.SESSION_ACCOUNT_SET_CODE)).isEqualTo(accountSetCode);
    }

    private String insertAccountSet(String prefix) {
        var code = prefix + "-" + UUID.randomUUID().toString().substring(0, 8).toUpperCase();
        jdbcTemplate.update("""
            INSERT INTO sys_account_set (
                code, name, environment, database_name, schema_name, attachment_prefix, redis_key_prefix,
                accounting_period, business_period, enabled, initialized
            )
            VALUES (?, ?, '测试隔离', current_database(), current_schema(), ?, ?, '2026-06', '2026-06', TRUE, TRUE)
            """, code, code + " 账套", "account-sets/" + code, code);
        return code;
    }

    private static final class BlockingScopeSession extends MockHttpSession {
        private final CountDownLatch accountSetIdWritten = new CountDownLatch(1);
        private final CountDownLatch releaseAccountSetWrite = new CountDownLatch(1);
        private volatile boolean blockAfterAccountSetId;

        @Override
        public void setAttribute(String name, Object value) {
            super.setAttribute(name, value);
            if (!blockAfterAccountSetId || !CurrentSessionService.SESSION_ACCOUNT_SET_ID.equals(name)) {
                return;
            }
            accountSetIdWritten.countDown();
            try {
                if (!releaseAccountSetWrite.await(5, TimeUnit.SECONDS)) {
                    throw new IllegalStateException("A140 atomic session write was not released");
                }
            } catch (InterruptedException exception) {
                Thread.currentThread().interrupt();
                throw new IllegalStateException("A140 atomic session write interrupted", exception);
            }
        }
    }
}
