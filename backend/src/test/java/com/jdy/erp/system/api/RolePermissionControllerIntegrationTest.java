package com.jdy.erp.system.api;

import static org.assertj.core.api.Assertions.assertThat;
import static org.hamcrest.Matchers.hasItem;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.patch;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.put;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import java.util.ArrayList;
import java.util.HashSet;
import java.util.Set;
import java.util.UUID;

import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.http.MediaType;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.mock.web.MockHttpSession;
import org.springframework.test.context.transaction.AfterTransaction;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.TransactionDefinition;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.transaction.support.TransactionTemplate;

@SpringBootTest
@AutoConfigureMockMvc
@Transactional(transactionManager = "platformTransactionManager")
class RolePermissionControllerIntegrationTest {
    @Autowired
    private MockMvc mockMvc;

    @Autowired
    @Qualifier("platformJdbcTemplate")
    private JdbcTemplate platformJdbcTemplate;

    @Autowired
    @Qualifier("platformTransactionManager")
    private PlatformTransactionManager platformTransactionManager;

    private UUID settlementOnlyUserId;
    private String settlementOnlyUsername;
    private boolean settlementOnlyPermissionAssertionsCompleted;

    @Test
    void adminCreatesMinimalRoleAtomicallyAndReadersRemainPermissionGuarded() throws Exception {
        var admin = login("admin", "admin123");
        var warehouse = login("warehouse", "warehouse123");
        var roleCode = "A186_ROLE_" + Long.toUnsignedString(System.nanoTime(), 36).toUpperCase();

        mockMvc.perform(get("/api/system/role-permissions"))
            .andExpect(status().isUnauthorized());
        mockMvc.perform(get("/api/system/role-permissions").session(warehouse))
            .andExpect(status().isForbidden());
        mockMvc.perform(post("/api/system/roles")
                .session(warehouse)
                .contentType(MediaType.APPLICATION_JSON)
                .content("{\"code\":\"" + roleCode + "\",\"name\":\"A186 无权角色\",\"permissionCodes\":[]}"))
            .andExpect(status().isForbidden());

        mockMvc.perform(post("/api/system/roles")
                .session(admin)
                .contentType(MediaType.APPLICATION_JSON)
                .content("{\"code\":\"" + roleCode + "\",\"name\":\"A186 最小角色\",\"permissionCodes\":[\"inventory.stock.view\"]}"))
            .andExpect(status().isCreated())
            .andExpect(jsonPath("$.roles[*].code").value(hasItem(roleCode)));

        assertThat(platformJdbcTemplate.queryForObject(
            "SELECT count(*)::int FROM sys_role WHERE code = ? AND name = ? AND enabled = TRUE",
            Integer.class,
            roleCode,
            "A186 最小角色"
        )).isOne();
        assertThat(platformJdbcTemplate.queryForList("""
            SELECT permission_code
            FROM sys_permission
            WHERE role_id = (SELECT id FROM sys_role WHERE code = ?)
              AND enabled = TRUE
            """, String.class, roleCode)).containsExactly("inventory.stock.view");
        var log = platformJdbcTemplate.queryForMap("""
            SELECT actor_username, before_state::text AS before_state, after_state::text AS after_state
            FROM sys_operation_log
            WHERE action_code = 'CREATE_ROLE'
              AND target_no = ?
            ORDER BY operated_at DESC
            LIMIT 1
            """, roleCode);
        assertThat(log).containsEntry("actor_username", "admin");
        assertThat(String.valueOf(log.get("after_state")))
            .contains(roleCode, "A186 最小角色", "inventory.stock.view")
            .doesNotContain("admin123");
    }

    @Test
    void invalidUnknownDuplicateAndNullRoleRequestsFailClosed() throws Exception {
        var admin = login("admin", "admin123");
        var roleCode = "A186_DUP_" + Long.toUnsignedString(System.nanoTime(), 36).toUpperCase();

        mockMvc.perform(post("/api/system/roles")
                .session(admin)
                .contentType(MediaType.APPLICATION_JSON)
                .content("{\"code\":\"?\",\"name\":\"非法角色\",\"permissionCodes\":[]}"))
            .andExpect(status().isBadRequest());
        mockMvc.perform(post("/api/system/roles")
                .session(admin)
                .contentType(MediaType.APPLICATION_JSON)
                .content("{\"code\":\"A" + "ß".repeat(40) + "\",\"name\":\"正规化后过长角色\",\"permissionCodes\":[]}"))
            .andExpect(status().isBadRequest());
        mockMvc.perform(post("/api/system/roles")
                .session(admin)
                .contentType(MediaType.APPLICATION_JSON)
                .content("{\"code\":\"" + roleCode + "\",\"name\":\"未知权限角色\",\"permissionCodes\":[\"not.a.permission\"]}"))
            .andExpect(status().isBadRequest());
        assertThat(platformJdbcTemplate.queryForObject(
            "SELECT count(*)::int FROM sys_role WHERE code = ?",
            Integer.class,
            roleCode
        )).isZero();

        var validBody = "{\"code\":\"" + roleCode + "\",\"name\":\"唯一编码角色\",\"permissionCodes\":[]}";
        mockMvc.perform(post("/api/system/roles")
                .session(admin)
                .contentType(MediaType.APPLICATION_JSON)
                .content(validBody))
            .andExpect(status().isCreated());
        mockMvc.perform(post("/api/system/roles")
                .session(admin)
                .contentType(MediaType.APPLICATION_JSON)
                .content(validBody))
            .andExpect(status().isConflict());
        assertThat(platformJdbcTemplate.queryForObject(
            "SELECT count(*)::int FROM sys_role WHERE code = ?",
            Integer.class,
            roleCode
        )).isOne();

        mockMvc.perform(put("/api/system/roles/{roleCode}/permissions", roleCode)
                .session(admin)
                .contentType(MediaType.APPLICATION_JSON)
                .content("null"))
            .andExpect(status().isBadRequest());
    }

    @Test
    void dynamicallyCreatedSettlementOnlyRoleCanReadAccountsButCannotMutateMasterData() throws Exception {
        var admin = login("admin", "admin123");
        var suffix = Long.toUnsignedString(System.nanoTime(), 36).toUpperCase();
        var roleCode = "A186_SETTLE_" + suffix;
        var username = "a186settle" + suffix.toLowerCase();
        var forbiddenAccountCode = "ZH-A186-FORBIDDEN-" + suffix;

        mockMvc.perform(post("/api/system/roles")
                .session(admin)
                .contentType(MediaType.APPLICATION_JSON)
                .content("{\"code\":\"" + roleCode + "\",\"name\":\"A186 仅结算\",\"permissionCodes\":[\"finance.settle\"]}"))
            .andExpect(status().isCreated());
        mockMvc.perform(post("/api/system/managed-users")
                .session(admin)
                .contentType(MediaType.APPLICATION_JSON)
                .content("""
                    {"username":"%s","displayName":"A186 仅结算用户","roleCode":"%s","password":"A186-Settle-123!","enabled":true,"accountSetCodes":["BLD-TEST"],"defaultAccountSetCode":"BLD-TEST"}
                    """.formatted(username, roleCode)))
            .andExpect(status().isOk());

        settlementOnlyUsername = username;
        settlementOnlyUserId = platformJdbcTemplate.queryForObject(
            "SELECT id FROM sys_user WHERE username = ? AND display_name = 'A186 仅结算用户'",
            UUID.class,
            username
        );
        assertThat(settlementOnlyUserId).isNotNull();

        var settlementOnly = login(username, "A186-Settle-123!");
        try {
            mockMvc.perform(get("/api/lists/financial-account-master-list").session(settlementOnly))
                .andExpect(status().isOk());
            mockMvc.perform(get("/api/lists/financial-account-master-selector").session(settlementOnly))
                .andExpect(status().isOk());
            mockMvc.perform(get("/api/lists/employee-master-list").session(settlementOnly))
                .andExpect(status().isForbidden());

            mockMvc.perform(post("/api/master-data/financialAccount")
                    .session(settlementOnly)
                    .contentType(MediaType.APPLICATION_JSON)
                    .content("""
                        {"code":"%s","name":"无权账户","accountType":"CASH","currency":"CNY"}
                        """.formatted(forbiddenAccountCode)))
                .andExpect(status().isForbidden());
            mockMvc.perform(patch("/api/master-data/financialAccount/{code}", "A186-NOT-FOUND")
                    .session(settlementOnly)
                    .contentType(MediaType.APPLICATION_JSON)
                    .content("{\"version\":0,\"changes\":{\"name\":\"无权修改\"}}"))
                .andExpect(status().isForbidden());
            mockMvc.perform(post("/api/master-data/financialAccount/{code}/audit", "A186-NOT-FOUND").session(settlementOnly))
                .andExpect(status().isForbidden());
            mockMvc.perform(patch("/api/master-data/financialAccount/{code}/status", "A186-NOT-FOUND")
                    .session(settlementOnly)
                    .contentType(MediaType.APPLICATION_JSON)
                    .content("{\"status\":\"禁用\"}"))
                .andExpect(status().isForbidden());
            assertThat(platformJdbcTemplate.queryForObject(
                "SELECT count(*)::int FROM md_financial_account WHERE code = ?",
                Integer.class,
                forbiddenAccountCode
            )).isZero();
            settlementOnlyPermissionAssertionsCompleted = true;
        } finally {
            mockMvc.perform(post("/api/system/logout").session(settlementOnly))
                .andExpect(status().isOk());
        }
    }

    @AfterTransaction
    void removeCommittedDeniedWriteLogsForRolledBackSettlementOnlyUser() {
        if (settlementOnlyUserId == null || settlementOnlyUsername == null) {
            return;
        }

        var expectedTargets = Set.of(
            "POST /api/master-data/{type}",
            "PATCH /api/master-data/{type}/{code}",
            "POST /api/master-data/{type}/{code}/audit",
            "PATCH /api/master-data/{type}/{code}/status"
        );
        var rows = platformJdbcTemplate.queryForList("""
            SELECT id, module_code, action_code, target_type, target_id, target_no,
                   before_state, after_state, success, failure_reason,
                   operated_by, account_set_id, account_set_code,
                   actor_type, actor_username, actor_display_name
            FROM sys_operation_log
            WHERE operated_by = ? OR actor_username = ?
            ORDER BY id
            """, settlementOnlyUserId, settlementOnlyUsername);
        var logIds = rows.stream()
            .filter(row -> settlementOnlyUserId.equals(row.get("operated_by"))
                && settlementOnlyUsername.equals(row.get("actor_username")))
            .map(row -> UUID.fromString(String.valueOf(row.get("id"))))
            .toList();

        var transaction = new TransactionTemplate(platformTransactionManager);
        transaction.setPropagationBehavior(TransactionDefinition.PROPAGATION_REQUIRES_NEW);
        var deleted = transaction.execute(status -> {
            if (logIds.isEmpty()) {
                return 0;
            }
            var placeholders = String.join(",", logIds.stream().map(ignored -> "?").toList());
            var arguments = new ArrayList<Object>(logIds);
            arguments.add(settlementOnlyUserId);
            arguments.add(settlementOnlyUsername);
            return platformJdbcTemplate.update("""
                DELETE FROM sys_operation_log
                WHERE id IN (%s)
                  AND operated_by = ?
                  AND actor_username = ?
                """.formatted(placeholders), arguments.toArray());
        });

        assertThat(rows).hasSizeLessThanOrEqualTo(expectedTargets.size());
        var actualTargets = new HashSet<String>();
        for (var row : rows) {
            var target = String.valueOf(row.get("target_no"));
            assertThat(expectedTargets).contains(target);
            assertThat(actualTargets.add(target)).as("denied endpoint must be unique: %s", target).isTrue();
            assertThat(row)
                .containsEntry("module_code", "SECURITY")
                .containsEntry("action_code", "WRITE_DENIED")
                .containsEntry("target_type", "http_endpoint")
                .containsEntry("success", false)
                .containsEntry("failure_reason", "当前角色无权执行该操作：master.data.manage")
                .containsEntry("operated_by", settlementOnlyUserId)
                .containsEntry("account_set_id", UUID.fromString("00000000-0000-0000-0000-000000000001"))
                .containsEntry("account_set_code", "BLD-TEST")
                .containsEntry("actor_type", "USER")
                .containsEntry("actor_username", settlementOnlyUsername)
                .containsEntry("actor_display_name", "A186 仅结算用户");
            assertThat(row.get("target_id")).isNull();
            assertThat(row.get("before_state")).isNull();
            assertThat(row.get("after_state")).isNull();
        }
        if (settlementOnlyPermissionAssertionsCompleted) {
            assertThat(actualTargets).containsExactlyInAnyOrderElementsOf(expectedTargets);
        }
        assertThat(deleted).isEqualTo(logIds.size());
        assertThat(platformJdbcTemplate.queryForObject("""
            SELECT count(*)::int
            FROM sys_operation_log
            WHERE operated_by = ? OR actor_username = ?
            """, Integer.class, settlementOnlyUserId, settlementOnlyUsername)).isZero();

        settlementOnlyUserId = null;
        settlementOnlyUsername = null;
        settlementOnlyPermissionAssertionsCompleted = false;
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
}
