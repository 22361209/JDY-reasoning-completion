package com.jdy.erp.system.api;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.verifyNoInteractions;
import static org.mockito.Mockito.when;

import java.util.List;
import java.util.Map;

import com.jdy.erp.system.security.CurrentSessionService;
import com.jdy.erp.system.security.PasswordPolicy;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.jdbc.core.JdbcTemplate;

class SystemShellControllerResponseTest {
    private CurrentSessionService currentSessionService;
    private PasswordPolicy passwordPolicy;
    private SystemShellController controller;

    @BeforeEach
    void setUp() {
        currentSessionService = mock(CurrentSessionService.class);
        passwordPolicy = mock(PasswordPolicy.class);
        controller = new SystemShellController(mock(JdbcTemplate.class), currentSessionService, passwordPolicy);
    }

    @Test
    void anonymousSessionReturnsOnlyAuthenticationStateWithoutReadingTenantOrSecurity() {
        when(currentSessionService.isAuthenticated()).thenReturn(false);

        var response = controller.session();

        assertThat(response).containsExactly(Map.entry("authenticated", false));
        verify(currentSessionService, never()).currentAccountSet();
        verify(currentSessionService, never()).sessionTimeoutMinutes();
        verify(currentSessionService, never()).currentSessionMaxInactiveIntervalSeconds();
        verifyNoInteractions(passwordPolicy);
    }

    @Test
    void anonymousAccountSetChoicesContainOnlyCodeAndName() {
        when(currentSessionService.isAuthenticated()).thenReturn(false);
        when(currentSessionService.availableAccountSets()).thenReturn(List.of(fullAccountSet()));

        var response = controller.accountSets();

        assertThat(response).containsOnlyKeys("accountSets");
        assertThat(response.get("accountSets")).isEqualTo(List.of(Map.of(
            "code", "BLD-TEST",
            "name", "博莱德机械测试账套"
        )));
        verify(currentSessionService, never()).currentAccountSet();
    }

    @Test
    void authenticatedSessionKeepsTheExistingTenantPeriodAndSecurityShape() {
        var accountSet = fullAccountSet();
        var user = Map.<String, Object>of(
            "name", "本地管理员",
            "username", "admin",
            "role", "系统管理员",
            "roleCode", "ADMIN",
            "permissionCodes", List.of("system.account_set.manage")
        );
        var policy = Map.<String, Object>of(
            "minLength", 8,
            "requireUppercase", true,
            "requireLowercase", true,
            "requireDigit", true,
            "requireSymbol", true
        );
        when(currentSessionService.isAuthenticated()).thenReturn(true);
        when(currentSessionService.currentAccountSet()).thenReturn(accountSet);
        when(currentSessionService.currentUser()).thenReturn(user);
        when(currentSessionService.sessionTimeoutMinutes()).thenReturn(30);
        when(currentSessionService.currentSessionMaxInactiveIntervalSeconds()).thenReturn(1800);
        when(passwordPolicy.currentPolicyMap()).thenReturn(policy);

        var response = controller.session();

        assertThat(response).containsOnlyKeys("authenticated", "user", "tenant", "period", "security");
        assertThat(response.get("authenticated")).isEqualTo(true);
        assertThat(response.get("user")).isEqualTo(user);
        assertThat(response.get("tenant")).isEqualTo(Map.of(
            "id", accountSet.get("id"),
            "code", accountSet.get("code"),
            "name", accountSet.get("name"),
            "environment", accountSet.get("environment"),
            "databaseName", accountSet.get("databaseName"),
            "schemaName", accountSet.get("schemaName"),
            "attachmentPrefix", accountSet.get("attachmentPrefix"),
            "redisKeyPrefix", accountSet.get("redisKeyPrefix"),
            "initialized", accountSet.get("initialized")
        ));
        assertThat(response.get("period")).isEqualTo(Map.of(
            "accounting", accountSet.get("accountingPeriod"),
            "business", accountSet.get("businessPeriod")
        ));
        assertThat(response.get("security")).isEqualTo(Map.of(
            "sessionTimeoutMinutes", 30,
            "sessionMaxInactiveSeconds", 1800,
            "passwordPolicy", policy
        ));
    }

    @Test
    void authenticatedAccountSetResponseKeepsTheExistingFullMaps() {
        var accountSet = fullAccountSet();
        when(currentSessionService.isAuthenticated()).thenReturn(true);
        when(currentSessionService.availableAccountSets()).thenReturn(List.of(accountSet));
        when(currentSessionService.currentAccountSet()).thenReturn(accountSet);

        var response = controller.accountSets();

        assertThat(response).containsExactlyInAnyOrderEntriesOf(Map.of(
            "accountSets", List.of(accountSet),
            "current", accountSet
        ));
    }

    private Map<String, Object> fullAccountSet() {
        return Map.ofEntries(
            Map.entry("id", "00000000-0000-0000-0000-000000000001"),
            Map.entry("code", "BLD-TEST"),
            Map.entry("name", "博莱德机械测试账套"),
            Map.entry("environment", "本地开发"),
            Map.entry("databaseName", "jdy_erp"),
            Map.entry("schemaName", "public"),
            Map.entry("attachmentPrefix", "account-sets/BLD-TEST"),
            Map.entry("redisKeyPrefix", "BLD-TEST"),
            Map.entry("accountingPeriod", "2026-06"),
            Map.entry("businessPeriod", "2026-06"),
            Map.entry("enabled", true),
            Map.entry("initialized", true)
        );
    }
}
