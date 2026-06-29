package com.jdy.erp.system.security;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.util.List;
import java.util.UUID;

import jakarta.servlet.http.HttpSession;

import com.jdy.erp.system.api.UserManagementController;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.mock.web.MockHttpServletRequest;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.context.request.RequestContextHolder;
import org.springframework.web.context.request.ServletRequestAttributes;
import org.springframework.web.server.ResponseStatusException;

@SpringBootTest
@Transactional
class CurrentSessionServiceAccountSetAuthorizationTest {
    @Autowired
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
}
