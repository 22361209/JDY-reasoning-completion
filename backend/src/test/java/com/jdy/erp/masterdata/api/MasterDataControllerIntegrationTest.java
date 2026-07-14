package com.jdy.erp.masterdata.api;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import java.util.Map;

import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.http.MediaType;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.mock.web.MockHttpSession;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.transaction.annotation.Transactional;

@SpringBootTest
@AutoConfigureMockMvc
@Transactional
class MasterDataControllerIntegrationTest {
    @Autowired
    private MockMvc mockMvc;

    @Autowired
    private ObjectMapper objectMapper;

    @Autowired
    private JdbcTemplate jdbcTemplate;

    @Test
    void manualPostDelegatesToSharedCreateContractAndKeepsLegacyResponseAndDefaults() throws Exception {
        var admin = login("admin", "admin123");
        var suffix = Long.toUnsignedString(System.nanoTime(), 36).toUpperCase();
        var customerCode = "KH-A143-HTTP-" + suffix;
        var unitCode = "DW-A143-HTTP-" + suffix;

        mockMvc.perform(post("/api/master-data/customer")
                .session(admin)
                .contentType(MediaType.APPLICATION_JSON)
                .content(objectMapper.writeValueAsBytes(Map.of(
                    "code", customerCode,
                    "name", "A143 HTTP 客户"
                ))))
            .andExpect(status().isCreated())
            .andExpect(jsonPath("$.id").isString())
            .andExpect(jsonPath("$.systemNo").isString())
            .andExpect(jsonPath("$.code").value(customerCode))
            .andExpect(jsonPath("$.name").value("A143 HTTP 客户"));

        assertThat(jdbcTemplate.queryForMap("""
            SELECT customer_level, settlement_method, enabled, audit_status, version
            FROM md_customer
            WHERE code = ?
            """, customerCode))
            .containsEntry("customer_level", "普通客户")
            .containsEntry("settlement_method", "月结")
            .containsEntry("enabled", true)
            .containsEntry("audit_status", "DRAFT")
            .containsEntry("version", 0L);

        mockMvc.perform(post("/api/master-data/unit")
                .session(admin)
                .contentType(MediaType.APPLICATION_JSON)
                .content(objectMapper.writeValueAsBytes(Map.of("code", unitCode))))
            .andExpect(status().isCreated())
            .andExpect(jsonPath("$.code").value(unitCode))
            .andExpect(jsonPath("$.name").value(unitCode));

        mockMvc.perform(post("/api/master-data/customer")
                .session(admin)
                .contentType(MediaType.APPLICATION_JSON)
                .content(objectMapper.writeValueAsBytes(Map.of(
                    "code", customerCode,
                    "name", "重复客户"
                ))))
            .andExpect(status().isConflict());
        mockMvc.perform(post("/api/master-data/unsupported")
                .session(admin)
                .contentType(MediaType.APPLICATION_JSON)
                .content(objectMapper.writeValueAsBytes(Map.of(
                    "code", "UNSUPPORTED",
                    "name", "不支持"
                ))))
            .andExpect(status().isNotFound());
    }

    @Test
    void manualPostStillEnforcesPermissionBeforeCreateServiceWork() throws Exception {
        var warehouse = login("warehouse", "warehouse123");
        var code = "KH-A143-DENY-" + Long.toUnsignedString(System.nanoTime(), 36).toUpperCase();

        mockMvc.perform(post("/api/master-data/customer")
                .session(warehouse)
                .contentType(MediaType.APPLICATION_JSON)
                .content(objectMapper.writeValueAsBytes(Map.of("code", code, "name", "无权客户"))))
            .andExpect(status().isForbidden());

        assertThat(jdbcTemplate.queryForObject(
            "SELECT COUNT(*) FROM md_customer WHERE code = ?",
            Long.class,
            code
        )).isZero();
    }

    private MockHttpSession login(String username, String password) throws Exception {
        var session = new MockHttpSession();
        mockMvc.perform(post("/api/system/login")
                .session(session)
                .contentType(MediaType.APPLICATION_JSON)
                .content(objectMapper.writeValueAsBytes(Map.of(
                    "username", username,
                    "password", password,
                    "accountSetCode", "BLD-TEST"
                ))))
            .andExpect(status().isOk());
        return session;
    }
}
