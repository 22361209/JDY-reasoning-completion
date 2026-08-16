package com.jdy.erp.system.api;

import static org.assertj.core.api.Assertions.assertThat;
import static org.hamcrest.Matchers.hasItem;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.patch;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.put;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.http.MediaType;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.mock.web.MockHttpSession;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.transaction.annotation.Transactional;

@SpringBootTest
@AutoConfigureMockMvc
@Transactional(transactionManager = "platformTransactionManager")
class RolePermissionControllerIntegrationTest {
    @Autowired
    private MockMvc mockMvc;

    @Autowired
    @Qualifier("platformJdbcTemplate")
    private JdbcTemplate platformJdbcTemplate;

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
        } finally {
            mockMvc.perform(post("/api/system/logout").session(settlementOnly))
                .andExpect(status().isOk());
        }
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
