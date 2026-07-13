package com.jdy.erp.system.application;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.doAnswer;
import static org.mockito.Mockito.doThrow;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.put;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;
import java.util.concurrent.atomic.AtomicInteger;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.jdy.erp.shared.application.OperationLogCommand;
import com.jdy.erp.shared.application.OperationLogService;
import com.jdy.erp.system.security.CurrentSessionService;
import com.jdy.erp.system.tenant.TenantContext;
import com.jdy.erp.system.tenant.TenantDataSourceRegistry;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.http.MediaType;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.mock.web.MockHttpServletRequest;
import org.springframework.mock.web.MockHttpSession;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.context.bean.override.mockito.MockitoSpyBean;
import org.springframework.web.context.request.RequestContextHolder;
import org.springframework.web.context.request.ServletRequestAttributes;
import org.springframework.web.server.ResponseStatusException;

@SpringBootTest
@AutoConfigureMockMvc
class EmployeeAccountLinkServiceIntegrationTest {
    private final String fixturePrefix = "a140link" + UUID.randomUUID().toString().replace("-", "").substring(0, 10);

    @Autowired
    private MockMvc mockMvc;

    @Autowired
    private ObjectMapper objectMapper;

    @Autowired
    @Qualifier("platformJdbcTemplate")
    private JdbcTemplate platformJdbcTemplate;

    @Autowired
    private JdbcTemplate tenantJdbcTemplate;

    @Autowired
    private EmployeeAccountLinkService service;

    @Autowired
    private CurrentSessionService currentSessionService;

    @Autowired
    private AccountSetManagementService accountSetManagementService;

    @Autowired
    private TenantDataSourceRegistry tenantDataSourceRegistry;

    @MockitoSpyBean
    private OperationLogService operationLogService;

    private Map<String, Object> accountSet;

    @BeforeEach
    void setUp() {
        accountSet = platformJdbcTemplate.queryForMap("""
            SELECT id::text AS id,
                   code,
                   name,
                   COALESCE(database_name, '') AS "databaseName",
                   COALESCE(schema_name, '') AS "schemaName",
                   COALESCE(redis_key_prefix, '') AS "redisKeyPrefix",
                   COALESCE(attachment_prefix, '') AS "attachmentPrefix"
            FROM sys_account_set
            WHERE code = 'BLD-TEST'
            """);
    }

    @AfterEach
    void cleanup() {
        RequestContextHolder.resetRequestAttributes();
        TenantContext.setTenant(accountSet);
        try {
            tenantJdbcTemplate.update(
                "DELETE FROM sys_operation_log WHERE actor_username LIKE ? OR target_no LIKE ?",
                fixturePrefix + "%",
                fixturePrefix + "%"
            );
            tenantJdbcTemplate.update("DELETE FROM md_employee WHERE code LIKE ?", fixturePrefix + "%");
        } finally {
            TenantContext.clear();
        }
        platformJdbcTemplate.update("""
            DELETE FROM sys_user_role
            WHERE user_id IN (SELECT id FROM sys_user WHERE username LIKE ?)
            """, fixturePrefix + "%");
        platformJdbcTemplate.update(
            "DELETE FROM sys_operation_log WHERE actor_username LIKE ? OR target_no LIKE ?",
            fixturePrefix + "%",
            fixturePrefix + "%"
        );
        platformJdbcTemplate.update("""
            DELETE FROM sys_user_account_set
            WHERE user_id IN (SELECT id FROM sys_user WHERE username LIKE ?)
            """, fixturePrefix + "%");
        platformJdbcTemplate.update("DELETE FROM sys_user WHERE username LIKE ?", fixturePrefix + "%");
    }

    @Test
    void linksAndUnlinksOnlyCurrentAccountGrantWithCasAndSanitizedTenantLog() throws Exception {
        var firstEmployee = fixturePrefix + "e1";
        var secondEmployee = fixturePrefix + "e2";
        var firstUser = createGrantedUser("u1");
        var secondUser = createGrantedUser("u2");
        createEmployee(firstEmployee, "员工一", true, "AUDITED", "13800000000", "first@example.invalid");
        createEmployee(secondEmployee, "员工二", true, "AUDITED", "13900000000", "second@example.invalid");
        var admin = login("admin", "admin123");

        var scopeToken = currentScopeToken(admin, firstUser);

        mockMvc.perform(put("/api/system/current-account-employee-links/{username}", firstUser)
                .session(admin)
                .contentType(MediaType.APPLICATION_JSON)
                .content(linkBody(firstEmployee, 0, scopeToken)))
            .andExpect(status().isOk())
            .andExpect(jsonPath("$.employeeLinks[?(@.username == '%s')].employeeCode".formatted(firstUser)).value(firstEmployee))
            .andExpect(jsonPath("$.employeeLinks[?(@.username == '%s')].employeeName".formatted(firstUser)).value("员工一"))
            .andExpect(jsonPath("$.employeeLinks[?(@.username == '%s')].grantVersion".formatted(firstUser)).value(1))
            .andExpect(jsonPath("$.employeeLinks[?(@.username == '%s')].scopeToken".formatted(firstUser)).value(scopeToken));

        mockMvc.perform(put("/api/system/current-account-employee-links/{username}", secondUser)
                .session(admin)
                .contentType(MediaType.APPLICATION_JSON)
                .content(linkBody(firstEmployee, 0, scopeToken)))
            .andExpect(status().isConflict());
        assertGrant(secondUser, null, 0);

        mockMvc.perform(put("/api/system/current-account-employee-links/{username}", firstUser)
                .session(admin)
                .contentType(MediaType.APPLICATION_JSON)
                .content(linkBody(secondEmployee, 0, scopeToken)))
            .andExpect(status().isConflict());
        assertGrant(firstUser, firstEmployee, 1);

        mockMvc.perform(put("/api/system/current-account-employee-links/{username}", firstUser)
                .session(admin)
                .contentType(MediaType.APPLICATION_JSON)
                .content("{\"employeeCode\":\"" + secondEmployee + "\",\"version\":1,\"scopeToken\":\""
                    + scopeToken + "\",\"accountSetCode\":\"OTHER\"}"))
            .andExpect(status().isBadRequest());
        assertGrant(firstUser, firstEmployee, 1);

        mockMvc.perform(put("/api/system/current-account-employee-links/{username}", firstUser)
                .session(admin)
                .contentType(MediaType.APPLICATION_JSON)
                .content(linkBody(null, 1, scopeToken)))
            .andExpect(status().isOk())
            .andExpect(jsonPath("$.employeeLinks[?(@.username == '%s')].employeeCode".formatted(firstUser)).value(""))
            .andExpect(jsonPath("$.employeeLinks[?(@.username == '%s')].grantVersion".formatted(firstUser)).value(2));
        assertGrant(firstUser, null, 2);

        TenantContext.setTenant(accountSet);
        try {
            var logs = tenantJdbcTemplate.queryForList("""
                SELECT action_code AS action,
                       target_no AS "targetNo",
                       COALESCE(failure_reason, '') AS reason,
                       account_set_code AS "accountSetCode"
                FROM sys_operation_log
                WHERE target_no LIKE ?
                ORDER BY operated_at
                """, fixturePrefix + "%");
            assertThat(logs).hasSize(2);
            assertThat(logs).extracting(row -> row.get("action"))
                .containsExactly("LINK_EMPLOYEE_ACCOUNT", "UNLINK_EMPLOYEE_ACCOUNT");
            assertThat(logs).allSatisfy(row -> {
                assertThat(row.get("accountSetCode")).isEqualTo("BLD-TEST");
                assertThat(row.toString())
                    .doesNotContain("13800000000")
                    .doesNotContain("first@example.invalid");
            });
        } finally {
            TenantContext.clear();
        }
    }

    @Test
    void rejectsInactiveEmployeeMissingGrantWrongPayloadAndSessionTenantMismatchWithoutWrites() throws Exception {
        var draftEmployee = fixturePrefix + "draft";
        var disabledEmployee = fixturePrefix + "disabled";
        var grantedUser = createGrantedUser("eligible");
        var ungrantedUser = createUser("ungranted", false);
        createEmployee(draftEmployee, "草稿员工", true, "DRAFT", null, null);
        createEmployee(disabledEmployee, "禁用员工", false, "AUDITED", null, null);
        var admin = login("admin", "admin123");
        var scopeToken = currentScopeToken(admin, grantedUser);

        for (var employeeCode : new String[] {draftEmployee, disabledEmployee}) {
            mockMvc.perform(put("/api/system/current-account-employee-links/{username}", grantedUser)
                    .session(admin)
                    .contentType(MediaType.APPLICATION_JSON)
                    .content(linkBody(employeeCode, 0, scopeToken)))
                .andExpect(status().isConflict());
            assertGrant(grantedUser, null, 0);
        }

        mockMvc.perform(put("/api/system/current-account-employee-links/{username}", ungrantedUser)
                .session(admin)
                .contentType(MediaType.APPLICATION_JSON)
                .content(linkBody(null, 0, scopeToken)))
            .andExpect(status().isConflict());

        for (var invalidBody : new String[] {
            "{\"employeeCode\":7,\"version\":0,\"scopeToken\":\"" + scopeToken + "\"}",
            "{\"employeeCode\":null,\"version\":-1,\"scopeToken\":\"" + scopeToken + "\"}",
            "{\"employeeCode\":null,\"version\":1.5,\"scopeToken\":\"" + scopeToken + "\"}",
            "{\"employeeCode\":null,\"version\":1.0000000000000000000000000001,\"scopeToken\":\"" + scopeToken + "\"}",
            "{\"employeeCode\":null,\"version\":9223372036854775808,\"scopeToken\":\"" + scopeToken + "\"}",
            "{\"employeeCode\":null,\"scopeToken\":\"" + scopeToken + "\"}",
            "{\"version\":0,\"scopeToken\":\"" + scopeToken + "\"}",
            "{\"employeeCode\":\"   \",\"version\":0,\"scopeToken\":\"" + scopeToken + "\"}",
            "{\"employeeCode\":null,\"version\":0}",
            "{\"employeeCode\":null,\"version\":0,\"scopeToken\":\"   \"}"
        }) {
            mockMvc.perform(put("/api/system/current-account-employee-links/{username}", grantedUser)
                    .session(admin)
                    .contentType(MediaType.APPLICATION_JSON)
                    .content(invalidBody))
                .andExpect(status().isBadRequest());
            assertGrant(grantedUser, null, 0);
        }

        bind(admin);
        TenantContext.setTenant(Map.of(
            "id", UUID.randomUUID().toString(),
            "code", "STALE",
            "name", "旧会话账套",
            "databaseName", "",
            "schemaName", "public",
            "redisKeyPrefix", "stale",
            "attachmentPrefix", "stale"
        ));
        try {
            assertThatThrownBy(service::currentAccountLinks)
                .isInstanceOf(ResponseStatusException.class)
                .hasMessageContaining("当前会话账套已变化");
        } finally {
            TenantContext.clear();
            RequestContextHolder.resetRequestAttributes();
        }
        assertGrant(grantedUser, null, 0);
    }

    @Test
    void missingSessionScopeTokenFailsClosedWithoutMintingReplacementOrWritingLink() throws Exception {
        var username = createGrantedUser("missing-scope");
        var employeeCode = fixturePrefix + "missing-scope-employee";
        createEmployee(employeeCode, "缺失作用域员工", true, "AUDITED", null, null);
        var admin = login("admin", "admin123");
        var oldScopeToken = String.valueOf(admin.getAttribute(CurrentSessionService.SESSION_ACCOUNT_SET_SCOPE_TOKEN));
        assertThat(oldScopeToken).isNotBlank();

        synchronized (admin) {
            admin.removeAttribute(CurrentSessionService.SESSION_ACCOUNT_SET_SCOPE_TOKEN);
        }

        mockMvc.perform(get("/api/system/current-account-employee-links").session(admin))
            .andExpect(status().isConflict());
        assertThat(admin.getAttribute(CurrentSessionService.SESSION_ACCOUNT_SET_SCOPE_TOKEN)).isNull();

        mockMvc.perform(put("/api/system/current-account-employee-links/{username}", username)
                .session(admin)
                .contentType(MediaType.APPLICATION_JSON)
                .content(linkBody(employeeCode, 0, oldScopeToken)))
            .andExpect(status().isConflict());

        assertThat(admin.getAttribute(CurrentSessionService.SESSION_ACCOUNT_SET_SCOPE_TOKEN)).isNull();
        assertGrant(username, null, 0);
        assertTenantLinkLogCount(accountSet, username, 0);
    }

    @Test
    void revokingAccountGrantReleasesEmployeeForAnotherAccountAndWritesTenantAudit() throws Exception {
        var linkedUser = createGrantedUser("revoked-owner");
        var replacementUser = createGrantedUser("revoked-replacement");
        var employeeCode = fixturePrefix + "revoked-employee";
        createEmployee(employeeCode, "撤销授权员工", true, "AUDITED", null, null);
        var admin = login("admin", "admin123");
        var scopeToken = currentScopeToken(admin, linkedUser);
        linkViaHttp(admin, linkedUser, employeeCode, 0, scopeToken, 200);

        Map<String, Object> retainedTenant = null;
        try {
            bind(admin);
            retainedTenant = createAccountSet("A140R-" + UUID.randomUUID().toString().substring(0, 8).toUpperCase());
            RequestContextHolder.resetRequestAttributes();
            var linkedUserId = platformJdbcTemplate.queryForObject(
                "SELECT id::text FROM sys_user WHERE username = ?",
                String.class,
                linkedUser
            );
            platformJdbcTemplate.update("""
                INSERT INTO sys_user_account_set (user_id, account_set_id, role_code, is_default, enabled)
                VALUES (?::uuid, ?::uuid, 'MEMBER', FALSE, TRUE)
                """, linkedUserId, retainedTenant.get("id"));

            mockMvc.perform(put("/api/system/managed-users/{username}/account-sets", linkedUser)
                    .session(admin)
                    .contentType(MediaType.APPLICATION_JSON)
                    .content(objectMapper.writeValueAsString(Map.of(
                        "accountSetCodes", List.of(retainedTenant.get("code")),
                        "defaultAccountSetCode", retainedTenant.get("code")
                    ))))
                .andExpect(status().isOk());

            var revokedGrant = platformJdbcTemplate.queryForMap("""
                SELECT enabled, employee_code AS "employeeCode", version
                FROM sys_user_account_set
                WHERE user_id = ?::uuid
                  AND account_set_id = ?::uuid
                """, linkedUserId, accountSet.get("id"));
            assertThat(revokedGrant.get("enabled")).isEqualTo(false);
            assertThat(revokedGrant.get("employeeCode")).isNull();
            assertThat(Number.class.cast(revokedGrant.get("version")).longValue()).isEqualTo(3);

            TenantContext.setTenant(accountSet);
            try {
                var logs = tenantJdbcTemplate.queryForList("""
                    SELECT action_code AS action, COALESCE(failure_reason, '') AS reason
                    FROM sys_operation_log
                    WHERE target_no = ?
                    ORDER BY operated_at, id
                    """, linkedUser + ":" + employeeCode);
                assertThat(logs).hasSize(2);
                assertThat(logs).extracting(row -> row.get("action"))
                    .containsExactly("LINK_EMPLOYEE_ACCOUNT", "UNLINK_EMPLOYEE_ACCOUNT");
                assertThat(logs.getLast().get("reason"))
                    .isEqualTo("employeeCode=" + employeeCode + ";source=grant_revoked");
            } finally {
                TenantContext.clear();
            }

            var replacementScopeToken = currentScopeToken(admin, replacementUser);
            linkViaHttp(admin, replacementUser, employeeCode, 0, replacementScopeToken, 200);
            assertGrant(replacementUser, employeeCode, 1);
        } finally {
            RequestContextHolder.resetRequestAttributes();
            TenantContext.clear();
            tenantDataSourceRegistry.close();
            if (retainedTenant != null) {
                platformJdbcTemplate.update("""
                    UPDATE sys_user
                    SET default_account_set_id = ?::uuid
                    WHERE default_account_set_id = ?::uuid
                      AND username LIKE ?
                    """, accountSet.get("id"), retainedTenant.get("id"), fixturePrefix + "%");
                platformJdbcTemplate.update(
                    "DELETE FROM sys_operation_log WHERE target_id = ?::uuid",
                    retainedTenant.get("id")
                );
                platformJdbcTemplate.update(
                    "DELETE FROM sys_user_account_set WHERE account_set_id = ?::uuid",
                    retainedTenant.get("id")
                );
                platformJdbcTemplate.execute(
                    "DROP SCHEMA IF EXISTS " + quoteIdentifier(String.valueOf(retainedTenant.get("schemaName"))) + " CASCADE"
                );
                platformJdbcTemplate.update("DELETE FROM sys_account_set WHERE id = ?::uuid", retainedTenant.get("id"));
            }
        }
    }

    @Test
    void rejectsStaleScopeWhenAuthorizationFallbackChangesResolvedTenantWithoutRotatingRawSession() throws Exception {
        Map<String, Object> fallbackTenant = null;
        try {
            var admin = login("admin", "admin123");
            bind(admin);
            fallbackTenant = createAccountSet("A140F-" + UUID.randomUUID().toString().substring(0, 8).toUpperCase());
            RequestContextHolder.resetRequestAttributes();

            var caller = createGrantedUser("scope-fallback");
            var callerId = platformJdbcTemplate.queryForObject(
                "SELECT id::text FROM sys_user WHERE username = ?",
                String.class,
                caller
            );
            platformJdbcTemplate.update("""
                INSERT INTO sys_user_account_set (user_id, account_set_id, role_code, is_default, enabled)
                VALUES (?::uuid, ?::uuid, 'MEMBER', TRUE, TRUE)
                """, callerId, fallbackTenant.get("id"));
            var callerSession = login(caller, "A140-Test-Password!9");
            var staleScopeToken = String.valueOf(callerSession.getAttribute(CurrentSessionService.SESSION_ACCOUNT_SET_SCOPE_TOKEN));
            platformJdbcTemplate.update("""
                UPDATE sys_user_account_set
                SET enabled = FALSE
                WHERE user_id = ?::uuid
                  AND account_set_id = ?::uuid
                """, callerId, accountSet.get("id"));

            bind(callerSession);
            TenantContext.setTenant(fallbackTenant);
            assertThat(staleScopeToken).isNotBlank();
            assertThatThrownBy(service::currentAccountLinks)
                .isInstanceOf(ResponseStatusException.class)
                .hasMessageContaining("当前会话账套已变化");
        } finally {
            TenantContext.clear();
            RequestContextHolder.resetRequestAttributes();
            tenantDataSourceRegistry.close();
            if (fallbackTenant != null) {
                platformJdbcTemplate.update(
                    "DELETE FROM sys_operation_log WHERE target_id = ?::uuid",
                    fallbackTenant.get("id")
                );
                platformJdbcTemplate.update(
                    "DELETE FROM sys_user_account_set WHERE account_set_id = ?::uuid",
                    fallbackTenant.get("id")
                );
                platformJdbcTemplate.execute(
                    "DROP SCHEMA IF EXISTS " + quoteIdentifier(String.valueOf(fallbackTenant.get("schemaName"))) + " CASCADE"
                );
                platformJdbcTemplate.update("DELETE FROM sys_account_set WHERE id = ?::uuid", fallbackTenant.get("id"));
            }
        }
    }

    @Test
    void rollsBackPlatformGrantWhenTenantAuditWriteFails() throws Exception {
        var employeeCode = fixturePrefix + "atomic";
        var username = createGrantedUser("atomic-user");
        createEmployee(employeeCode, "原子日志员工", true, "AUDITED", null, null);
        var admin = login("admin", "admin123");
        var scopeToken = currentScopeToken(admin, username);
        bind(admin);
        TenantContext.setTenant(accountSet);
        doThrow(new IllegalStateException("A140 injected tenant log failure"))
            .when(operationLogService).logTenant(any(), any());

        try {
            assertThatThrownBy(() -> service.saveCurrentAccountLink(username, employeeCode, 0, scopeToken))
                .isInstanceOf(IllegalStateException.class)
                .hasMessageContaining("injected tenant log failure");
        } finally {
            TenantContext.clear();
            RequestContextHolder.resetRequestAttributes();
        }

        assertGrant(username, null, 0);
        TenantContext.setTenant(accountSet);
        try {
            assertThat(tenantJdbcTemplate.queryForObject(
                "SELECT count(*) FROM sys_operation_log WHERE target_no LIKE ?",
                Integer.class,
                username + "%"
            )).isZero();
        } finally {
            TenantContext.clear();
        }
    }

    @Test
    void warehouseCannotReadOrWriteEmployeeLinks() throws Exception {
        var username = createGrantedUser("permission");
        var warehouse = login("warehouse", "warehouse123");

        mockMvc.perform(get("/api/system/current-account-employee-links").session(warehouse))
            .andExpect(status().isForbidden());
        mockMvc.perform(put("/api/system/current-account-employee-links/{username}", username)
                .session(warehouse)
                .contentType(MediaType.APPLICATION_JSON)
                .content("{\"employeeCode\":null,\"version\":0,\"scopeToken\":\"permission-denied\"}"))
            .andExpect(status().isForbidden());
        assertGrant(username, null, 0);
    }

    @Test
    void concurrentCasAllowsOneLinkAndDisabledEmployeeDoesNotDisableLogin() throws Exception {
        var firstEmployee = fixturePrefix + "race-a";
        var secondEmployee = fixturePrefix + "race-b";
        var username = createGrantedUser("race-user");
        createEmployee(firstEmployee, "并发员工甲", true, "AUDITED", null, null);
        createEmployee(secondEmployee, "并发员工乙", true, "AUDITED", null, null);
        var admin = login("admin", "admin123");
        var scopeToken = currentScopeToken(admin, username);
        var start = new CountDownLatch(1);
        var successes = new AtomicInteger();
        var conflicts = new AtomicInteger();

        try (var executor = Executors.newFixedThreadPool(2)) {
            var first = executor.submit(() -> raceLink(admin, username, firstEmployee, scopeToken, start, successes, conflicts));
            var second = executor.submit(() -> raceLink(admin, username, secondEmployee, scopeToken, start, successes, conflicts));
            start.countDown();
            first.get(20, TimeUnit.SECONDS);
            second.get(20, TimeUnit.SECONDS);
        }

        assertThat(successes.get()).isEqualTo(1);
        assertThat(conflicts.get()).isEqualTo(1);
        var persisted = platformJdbcTemplate.queryForMap("""
            SELECT uas.employee_code AS "employeeCode", uas.version
            FROM sys_user_account_set uas
            JOIN sys_user u ON u.id = uas.user_id
            WHERE u.username = ?
              AND uas.account_set_id = ?::uuid
            """, username, accountSet.get("id"));
        assertThat(persisted.get("employeeCode")).isIn(firstEmployee, secondEmployee);
        assertThat(Number.class.cast(persisted.get("version")).longValue()).isEqualTo(1);

        TenantContext.setTenant(accountSet);
        try {
            tenantJdbcTemplate.update(
                "UPDATE md_employee SET enabled = FALSE, version = version + 1 WHERE code = ?",
                persisted.get("employeeCode")
            );
        } finally {
            TenantContext.clear();
        }
        var employeeSession = login(username, "A140-Test-Password!9");
        mockMvc.perform(get("/api/system/session").session(employeeSession))
            .andExpect(status().isOk())
            .andExpect(jsonPath("$.authenticated").value(true))
            .andExpect(jsonPath("$.user.username").value(username));
        assertGrant(username, String.valueOf(persisted.get("employeeCode")), 1);
    }

    @Test
    void sameEmployeeCodeAndGrantAreIsolatedAcrossTwoTenantsAndStaleSwitchedRequestFails() throws Exception {
        var admin = login("admin", "admin123");
        bind(admin);
        var codeA = "A140A-" + UUID.randomUUID().toString().substring(0, 8).toUpperCase();
        var codeB = "A140B-" + UUID.randomUUID().toString().substring(0, 8).toUpperCase();
        Map<String, Object> tenantA = null;
        Map<String, Object> tenantB = null;
        var createdTenants = new java.util.ArrayList<Map<String, Object>>();
        var username = createUser("tenant-user", false);
        var employeeCode = fixturePrefix + "same";
        try {
            tenantA = createAccountSet(codeA);
            createdTenants.add(tenantA);
            tenantB = createAccountSet(codeB);
            createdTenants.add(tenantB);
            var userId = platformJdbcTemplate.queryForObject(
                "SELECT id::text FROM sys_user WHERE username = ?",
                String.class,
                username
            );
            for (var tenant : List.of(tenantA, tenantB)) {
                platformJdbcTemplate.update("""
                    INSERT INTO sys_user_account_set (user_id, account_set_id, role_code, is_default, enabled)
                    VALUES (?::uuid, ?::uuid, 'MEMBER', FALSE, TRUE)
                    """, userId, tenant.get("id"));
            }
            insertTenantEmployee(tenantA, employeeCode, "租户甲员工");
            insertTenantEmployee(tenantB, employeeCode, "租户乙员工");

            switchAccountSet(admin, codeA);
            var staleTokenA = currentScopeToken(admin, username);
            linkViaHttp(admin, username, employeeCode, 0, staleTokenA, 200);
            mockMvc.perform(get("/api/system/current-account-employee-links").session(admin))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.employeeLinks[?(@.username == '%s')].employeeName".formatted(username)).value("租户甲员工"))
                .andExpect(jsonPath("$.employeeLinks[?(@.username == '%s')].scopeToken".formatted(username)).value(staleTokenA));

            switchAccountSet(admin, codeB);
            switchAccountSet(admin, codeA);
            linkViaHttp(admin, username, employeeCode, 1, staleTokenA, 409);
            assertTenantGrant(username, tenantA, employeeCode, 1);
            assertTenantGrant(username, tenantB, null, 0);
            assertTenantLinkLogCount(tenantA, username, 1);
            assertTenantLinkLogCount(tenantB, username, 0);
            var tokenAAfterDirectReturn = currentScopeToken(admin, username);
            assertThat(tokenAAfterDirectReturn).isNotEqualTo(staleTokenA);

            switchAccountSet(admin, codeB);
            linkViaHttp(admin, username, employeeCode, 0, staleTokenA, 409);
            assertTenantGrant(username, tenantA, employeeCode, 1);
            assertTenantGrant(username, tenantB, null, 0);
            assertTenantLinkLogCount(tenantA, username, 1);
            assertTenantLinkLogCount(tenantB, username, 0);

            var tokenB = currentScopeToken(admin, username);
            assertThat(tokenB).isNotEqualTo(staleTokenA);
            linkViaHttp(admin, username, employeeCode, 0, tokenB, 200);
            mockMvc.perform(get("/api/system/current-account-employee-links").session(admin))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.employeeLinks[?(@.username == '%s')].employeeName".formatted(username)).value("租户乙员工"))
                .andExpect(jsonPath("$.employeeLinks[?(@.username == '%s')].scopeToken".formatted(username)).value(tokenB));

            assertTenantGrant(username, tenantA, employeeCode, 1);
            assertTenantGrant(username, tenantB, employeeCode, 1);
            assertTenantLinkLogCount(tenantA, username, 1);
            assertTenantLinkLogCount(tenantB, username, 1);

            switchAccountSet(admin, codeA);
            linkViaHttp(admin, username, employeeCode, 1, staleTokenA, 409);
            assertTenantGrant(username, tenantA, employeeCode, 1);
            assertTenantGrant(username, tenantB, employeeCode, 1);
            assertTenantLinkLogCount(tenantA, username, 1);
            assertTenantLinkLogCount(tenantB, username, 1);
            var tokenAAfterReturn = currentScopeToken(admin, username);
            assertThat(tokenAAfterReturn)
                .isNotEqualTo(staleTokenA)
                .isNotEqualTo(tokenAAfterDirectReturn)
                .isNotEqualTo(tokenB);
        } finally {
            RequestContextHolder.resetRequestAttributes();
            TenantContext.clear();
            tenantDataSourceRegistry.close();
            for (var tenant : createdTenants) {
                if (tenant == null) {
                    continue;
                }
                deleteSwitchAccountSetLogs(tenant);
                platformJdbcTemplate.update(
                    "DELETE FROM sys_operation_log WHERE target_id = ?::uuid",
                    tenant.get("id")
                );
                platformJdbcTemplate.update(
                    "DELETE FROM sys_user_account_set WHERE account_set_id = ?::uuid",
                    tenant.get("id")
                );
                platformJdbcTemplate.execute("DROP SCHEMA IF EXISTS " + quoteIdentifier(String.valueOf(tenant.get("schemaName"))) + " CASCADE");
                platformJdbcTemplate.update("DELETE FROM sys_account_set WHERE id = ?::uuid", tenant.get("id"));
            }
        }
    }

    @Test
    void accountSwitchWaitsForLinkTransactionAcrossDistinctSessionWrappers() throws Exception {
        var username = createGrantedUser("switch-race");
        var employeeCode = fixturePrefix + "switch-race-employee";
        createEmployee(employeeCode, "切换竞态员工", true, "AUDITED", null, null);
        var admin = login("admin", "admin123");
        var scopeTokenA = currentScopeToken(admin, username);
        var linkSession = copySession(admin);
        var switchSession = copySession(admin);
        Map<String, Object> tenantB = null;
        var logEntered = new CountDownLatch(1);
        var releaseLink = new CountDownLatch(1);
        try {
            bind(admin);
            tenantB = createAccountSet("A140B-" + UUID.randomUUID().toString().substring(0, 8).toUpperCase());
            RequestContextHolder.resetRequestAttributes();
            var userId = platformJdbcTemplate.queryForObject(
                "SELECT id::text FROM sys_user WHERE username = ?",
                String.class,
                username
            );
            platformJdbcTemplate.update("""
                INSERT INTO sys_user_account_set (user_id, account_set_id, role_code, is_default, enabled)
                VALUES (?::uuid, ?::uuid, 'MEMBER', FALSE, TRUE)
                """, userId, tenantB.get("id"));
            insertTenantEmployee(tenantB, employeeCode, "切换后租户员工");

            doAnswer(invocation -> {
                var command = invocation.getArgument(1, OperationLogCommand.class);
                if ("LINK_EMPLOYEE_ACCOUNT".equals(command.action())) {
                    logEntered.countDown();
                    if (!releaseLink.await(10, TimeUnit.SECONDS)) {
                        throw new IllegalStateException("A140 link transaction release timed out");
                    }
                }
                return invocation.callRealMethod();
            }).when(operationLogService).logTenant(any(), any());

            try (var executor = Executors.newFixedThreadPool(2)) {
                var linkFuture = executor.submit(() -> {
                    bind(linkSession);
                    TenantContext.setTenant(accountSet);
                    try {
                        return service.saveCurrentAccountLink(username, employeeCode, 0, scopeTokenA);
                    } finally {
                        TenantContext.clear();
                        RequestContextHolder.resetRequestAttributes();
                    }
                });
                assertThat(logEntered.await(10, TimeUnit.SECONDS)).isTrue();

                var switchStarted = new CountDownLatch(1);
                var tenantBCode = String.valueOf(tenantB.get("code"));
                var switchFuture = executor.submit(() -> {
                    switchStarted.countDown();
                    switchAccountSet(switchSession, tenantBCode);
                    return true;
                });
                assertThat(switchStarted.await(10, TimeUnit.SECONDS)).isTrue();
                try {
                    assertThatThrownBy(() -> switchFuture.get(250, TimeUnit.MILLISECONDS))
                        .isInstanceOf(TimeoutException.class);
                } finally {
                    releaseLink.countDown();
                }

                assertThat(linkFuture.get(20, TimeUnit.SECONDS)).isNotEmpty();
                assertThat(switchFuture.get(20, TimeUnit.SECONDS)).isTrue();
            }

            assertThat(switchSession.getAttribute(CurrentSessionService.SESSION_ACCOUNT_SET_CODE)).isEqualTo(tenantB.get("code"));
            assertThat(String.valueOf(switchSession.getAttribute(CurrentSessionService.SESSION_ACCOUNT_SET_SCOPE_TOKEN)))
                .isNotBlank()
                .isNotEqualTo(scopeTokenA);
            assertThat(linkSession.getAttribute(CurrentSessionService.SESSION_ACCOUNT_SET_CODE)).isEqualTo("BLD-TEST");
            assertThat(linkSession.getAttribute(CurrentSessionService.SESSION_ACCOUNT_SET_SCOPE_TOKEN)).isEqualTo(scopeTokenA);
            assertTenantGrant(username, accountSet, employeeCode, 1);
            assertTenantGrant(username, tenantB, null, 0);
            assertTenantLinkLogCount(accountSet, username, 1);
            assertTenantLinkLogCount(tenantB, username, 0);
            linkViaHttp(linkSession, username, employeeCode, 1, scopeTokenA, 409);
            assertTenantGrant(username, accountSet, employeeCode, 1);
            assertTenantGrant(username, tenantB, null, 0);
            assertTenantLinkLogCount(tenantB, username, 0);
        } finally {
            releaseLink.countDown();
            RequestContextHolder.resetRequestAttributes();
            TenantContext.clear();
            tenantDataSourceRegistry.close();
            if (tenantB != null) {
                deleteSwitchAccountSetLogs(tenantB);
                platformJdbcTemplate.update(
                    "DELETE FROM sys_operation_log WHERE target_id = ?::uuid",
                    tenantB.get("id")
                );
                platformJdbcTemplate.update(
                    "DELETE FROM sys_user_account_set WHERE account_set_id = ?::uuid",
                    tenantB.get("id")
                );
                platformJdbcTemplate.execute(
                    "DROP SCHEMA IF EXISTS " + quoteIdentifier(String.valueOf(tenantB.get("schemaName"))) + " CASCADE"
                );
                platformJdbcTemplate.update("DELETE FROM sys_account_set WHERE id = ?::uuid", tenantB.get("id"));
            }
        }
    }

    @Test
    void failedSwitchTransactionDoesNotPublishUncommittedSessionScope() throws Exception {
        var username = createGrantedUser("switch-rollback");
        var accountSetCode = "A140-RB-" + UUID.randomUUID().toString().substring(0, 8).toUpperCase();
        var accountSetId = UUID.randomUUID().toString();
        platformJdbcTemplate.update("""
            INSERT INTO sys_account_set (
                id, code, name, environment, database_name, schema_name,
                attachment_prefix, redis_key_prefix, accounting_period, business_period,
                enabled, initialized
            )
            VALUES (?::uuid, ?, ?, 'A140测试', current_database(), current_schema(), ?, ?,
                    '2026-07', '2026-07', TRUE, TRUE)
            """, accountSetId, accountSetCode, accountSetCode + " 账套", "account-sets/" + accountSetCode, accountSetCode);
        var userId = platformJdbcTemplate.queryForObject(
            "SELECT id::text FROM sys_user WHERE username = ?",
            String.class,
            username
        );
        platformJdbcTemplate.update("""
            INSERT INTO sys_user_account_set (user_id, account_set_id, role_code, is_default, enabled)
            VALUES (?::uuid, ?::uuid, 'MEMBER', FALSE, TRUE)
            """, userId, accountSetId);
        var session = login(username, "A140-Test-Password!9");
        var originalAccountSetId = String.valueOf(session.getAttribute(CurrentSessionService.SESSION_ACCOUNT_SET_ID));
        var originalAccountSetCode = String.valueOf(session.getAttribute(CurrentSessionService.SESSION_ACCOUNT_SET_CODE));
        var originalScopeToken = String.valueOf(session.getAttribute(CurrentSessionService.SESSION_ACCOUNT_SET_SCOPE_TOKEN));
        var sessionToken = String.valueOf(session.getAttribute(CurrentSessionService.SESSION_TOKEN));

        try {
            doAnswer(invocation -> {
                var command = invocation.getArgument(0, OperationLogCommand.class);
                if ("SWITCH_ACCOUNT_SET".equals(command.action())) {
                    throw new IllegalStateException("A140 injected switch log failure");
                }
                return invocation.callRealMethod();
            }).when(operationLogService).logPlatform(any());

            bind(session);
            assertThatThrownBy(() -> currentSessionService.switchAccountSet(accountSetCode))
                .isInstanceOf(IllegalStateException.class)
                .hasMessage("A140 injected switch log failure");

            assertThat(session.getAttribute(CurrentSessionService.SESSION_ACCOUNT_SET_ID)).isEqualTo(originalAccountSetId);
            assertThat(session.getAttribute(CurrentSessionService.SESSION_ACCOUNT_SET_CODE)).isEqualTo(originalAccountSetCode);
            assertThat(session.getAttribute(CurrentSessionService.SESSION_ACCOUNT_SET_SCOPE_TOKEN)).isEqualTo(originalScopeToken);
            var authority = platformJdbcTemplate.queryForMap("""
                SELECT account_set_id::text AS "accountSetId", scope_token::text AS "scopeToken"
                FROM sys_session_account_scope
                WHERE session_token = ?::uuid
                """, sessionToken);
            assertThat(authority.get("accountSetId")).isEqualTo(originalAccountSetId);
            assertThat(authority.get("scopeToken")).isEqualTo(originalScopeToken);
        } finally {
            RequestContextHolder.resetRequestAttributes();
            platformJdbcTemplate.update(
                "DELETE FROM sys_operation_log WHERE account_set_id = ?::uuid OR target_id = ?::uuid",
                accountSetId,
                accountSetId
            );
            platformJdbcTemplate.update("DELETE FROM sys_user_account_set WHERE account_set_id = ?::uuid", accountSetId);
            platformJdbcTemplate.update("DELETE FROM sys_account_set WHERE id = ?::uuid", accountSetId);
        }
    }

    private String createGrantedUser(String suffix) {
        return createUser(suffix, true);
    }

    private void raceLink(
        MockHttpSession admin,
        String username,
        String employeeCode,
        String scopeToken,
        CountDownLatch start,
        AtomicInteger successes,
        AtomicInteger conflicts
    ) {
        try {
            start.await();
            bind(admin);
            TenantContext.setTenant(accountSet);
            service.saveCurrentAccountLink(username, employeeCode, 0, scopeToken);
            successes.incrementAndGet();
        } catch (ResponseStatusException exception) {
            if (exception.getStatusCode().value() == 409) {
                conflicts.incrementAndGet();
                return;
            }
            throw exception;
        } catch (InterruptedException exception) {
            Thread.currentThread().interrupt();
            throw new IllegalStateException("A140 concurrent link interrupted", exception);
        } finally {
            TenantContext.clear();
            RequestContextHolder.resetRequestAttributes();
        }
    }

    @SuppressWarnings("unchecked")
    private Map<String, Object> createAccountSet(String code) {
        var result = accountSetManagementService.createAccountSet(new AccountSetManagementService.AccountSetCreateRequest(
            code,
            code + " 账套",
            "A140测试",
            null,
            null,
            null,
            null,
            "2026-07",
            "2026-07"
        ));
        return (Map<String, Object>) result.get("accountSet");
    }

    private void insertTenantEmployee(Map<String, Object> tenant, String code, String name) {
        platformJdbcTemplate.update("""
            INSERT INTO %s.md_employee (code, name, enabled, audit_status)
            VALUES (?, ?, TRUE, 'AUDITED')
            """.formatted(quoteIdentifier(String.valueOf(tenant.get("schemaName")))), code, name);
    }

    private void switchAccountSet(MockHttpSession session, String accountSetCode) throws Exception {
        mockMvc.perform(post("/api/system/account-sets/current")
                .session(session)
                .contentType(MediaType.APPLICATION_JSON)
                .content("{\"accountSetCode\":\"" + accountSetCode + "\"}"))
            .andExpect(status().isOk())
            .andExpect(jsonPath("$.current.code").value(accountSetCode));
    }

    private void linkViaHttp(
        MockHttpSession session,
        String username,
        String employeeCode,
        long version,
        String scopeToken,
        int expectedStatus
    ) throws Exception {
        mockMvc.perform(put("/api/system/current-account-employee-links/{username}", username)
                .session(session)
                .contentType(MediaType.APPLICATION_JSON)
                .content(linkBody(employeeCode, version, scopeToken)))
            .andExpect(status().is(expectedStatus));
    }

    private String currentScopeToken(MockHttpSession session, String username) throws Exception {
        var response = mockMvc.perform(get("/api/system/current-account-employee-links").session(session))
            .andExpect(status().isOk())
            .andReturn()
            .getResponse()
            .getContentAsString();
        var links = objectMapper.readTree(response).path("employeeLinks");
        for (var link : links) {
            if (username.equals(link.path("username").asText())) {
                var scopeToken = link.path("scopeToken").asText();
                assertThat(scopeToken).isNotBlank();
                return scopeToken;
            }
        }
        throw new AssertionError("员工关联 API 未返回用户 " + username + " 的 scopeToken");
    }

    private String linkBody(String employeeCode, long version, String scopeToken) throws Exception {
        var body = new LinkedHashMap<String, Object>();
        body.put("employeeCode", employeeCode);
        body.put("version", version);
        body.put("scopeToken", scopeToken);
        return objectMapper.writeValueAsString(body);
    }

    private void assertTenantLinkLogCount(Map<String, Object> tenant, String username, int expectedCount) {
        var count = platformJdbcTemplate.queryForObject("""
            SELECT count(*)
            FROM %s.sys_operation_log
            WHERE target_no LIKE ?
            """.formatted(quoteIdentifier(String.valueOf(tenant.get("schemaName")))), Integer.class, username + ":%");
        assertThat(count).isEqualTo(expectedCount);
    }

    private void deleteSwitchAccountSetLogs(Map<String, Object> tenant) {
        platformJdbcTemplate.update("""
            DELETE FROM sys_operation_log
            WHERE action_code = 'SWITCH_ACCOUNT_SET'
              AND actor_username = 'admin'
              AND target_type = 'sys_setting'
              AND target_id IS NULL
              AND failure_reason = ?
            """, "account_set=" + tenant.get("code"));
    }

    private void assertTenantGrant(
        String username,
        Map<String, Object> tenant,
        String employeeCode,
        long version
    ) {
        var row = platformJdbcTemplate.queryForMap("""
            SELECT uas.employee_code AS "employeeCode", uas.version
            FROM sys_user_account_set uas
            JOIN sys_user u ON u.id = uas.user_id
            WHERE u.username = ?
              AND uas.account_set_id = ?::uuid
            """, username, tenant.get("id"));
        assertThat(row.get("employeeCode")).isEqualTo(employeeCode);
        assertThat(Number.class.cast(row.get("version")).longValue()).isEqualTo(version);
    }

    private String quoteIdentifier(String identifier) {
        if (identifier == null || !identifier.matches("[a-z][a-z0-9_]{0,62}")) {
            throw new IllegalArgumentException("invalid test schema identifier");
        }
        return "\"" + identifier.replace("\"", "\"\"") + "\"";
    }

    private String createUser(String suffix, boolean grantCurrentAccount) {
        var username = fixturePrefix + suffix;
        var userId = platformJdbcTemplate.queryForObject("""
            INSERT INTO sys_user (username, display_name, password_hash, enabled)
            VALUES (?, ?, '{noop}A140-Test-Password!9', TRUE)
            RETURNING id::text
            """, String.class, username, "A140 " + suffix);
        platformJdbcTemplate.update("""
            INSERT INTO sys_user_role (user_id, role_id)
            SELECT ?::uuid, id
            FROM sys_role
            WHERE code = 'WAREHOUSE'
            """, userId);
        if (grantCurrentAccount) {
            platformJdbcTemplate.update("""
                INSERT INTO sys_user_account_set (user_id, account_set_id, role_code, is_default, enabled)
                VALUES (?::uuid, ?::uuid, 'MEMBER', FALSE, TRUE)
                """, userId, accountSet.get("id"));
        }
        return username;
    }

    private void createEmployee(
        String code,
        String name,
        boolean enabled,
        String auditStatus,
        String phone,
        String email
    ) {
        TenantContext.setTenant(accountSet);
        try {
            tenantJdbcTemplate.update("""
                INSERT INTO md_employee (code, name, phone, email, enabled, audit_status)
                VALUES (?, ?, ?, ?, ?, ?)
                """, code, name, phone, email, enabled, auditStatus);
        } finally {
            TenantContext.clear();
        }
    }

    private void assertGrant(String username, String employeeCode, long version) {
        var row = platformJdbcTemplate.queryForMap("""
            SELECT uas.employee_code AS "employeeCode", uas.version
            FROM sys_user_account_set uas
            JOIN sys_user u ON u.id = uas.user_id
            WHERE u.username = ?
              AND uas.account_set_id = ?::uuid
            """, username, accountSet.get("id"));
        assertThat(row.get("employeeCode")).isEqualTo(employeeCode);
        assertThat(Number.class.cast(row.get("version")).longValue()).isEqualTo(version);
    }

    private MockHttpSession login(String username, String password) throws Exception {
        var session = new MockHttpSession();
        mockMvc.perform(post("/api/system/login")
                .session(session)
                .contentType(MediaType.APPLICATION_JSON)
                .content("{\"username\":\"" + username + "\",\"password\":\"" + password + "\",\"accountSetCode\":\"BLD-TEST\"}"))
            .andExpect(status().isOk());
        return session;
    }

    private void bind(MockHttpSession session) {
        var request = new MockHttpServletRequest();
        request.setSession(session);
        RequestContextHolder.setRequestAttributes(new ServletRequestAttributes(request));
    }

    private MockHttpSession copySession(MockHttpSession source) {
        var copy = new MockHttpSession();
        for (var name : Collections.list(source.getAttributeNames())) {
            copy.setAttribute(name, source.getAttribute(name));
        }
        return copy;
    }
}
