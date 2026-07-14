package com.jdy.erp.shared.application;

import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.put;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import java.util.Map;

import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.http.MediaType;
import org.springframework.mock.web.MockHttpSession;
import org.springframework.test.web.servlet.MockMvc;

@SpringBootTest
@AutoConfigureMockMvc
class NumberingControllerPermissionIntegrationTest {
    @Autowired
    private MockMvc mockMvc;

    @Autowired
    private ObjectMapper objectMapper;

    @Test
    void rulesEndpointsEnforceAuthenticationPermissionRegistryAndVersion() throws Exception {
        var warehouse = login("warehouse", "warehouse123");
        var admin = login("admin", "admin123");

        mockMvc.perform(get("/api/numbering/rules"))
            .andExpect(status().isUnauthorized());
        mockMvc.perform(put("/api/numbering/rules/stockCountGain")
                .contentType(MediaType.APPLICATION_JSON)
                .content(ruleBody("PY", 6, "0", true, "0")))
            .andExpect(status().isUnauthorized());

        mockMvc.perform(get("/api/numbering/rules").session(warehouse))
            .andExpect(status().isForbidden());
        mockMvc.perform(put("/api/numbering/rules/stockCountGain")
                .session(warehouse)
                .contentType(MediaType.APPLICATION_JSON)
                .content(ruleBody("PY", 6, "0", true, "0")))
            .andExpect(status().isForbidden());

        mockMvc.perform(get("/api/numbering/rules").session(admin))
            .andExpect(status().isOk())
            .andExpect(jsonPath("$.rules.length()").value(26))
            .andExpect(jsonPath("$.rules[0].version").isString());

        mockMvc.perform(put("/api/numbering/rules/notRegistered")
                .session(admin)
                .contentType(MediaType.APPLICATION_JSON)
                .content(ruleBody("OK", 6, "0", true, "0")))
            .andExpect(status().isBadRequest());
        mockMvc.perform(put("/api/numbering/rules/stockCountGain")
                .session(admin)
                .contentType(MediaType.APPLICATION_JSON)
                .content(objectMapper.writeValueAsBytes(Map.of(
                    "prefix", "PY",
                    "width", 6,
                    "lastNumber", "0",
                    "enabled", true
                ))))
            .andExpect(status().isBadRequest());
    }

    private byte[] ruleBody(String prefix, int width, String lastNumber, boolean enabled, String version) throws Exception {
        return objectMapper.writeValueAsBytes(Map.of(
            "prefix", prefix,
            "width", width,
            "lastNumber", lastNumber,
            "enabled", enabled,
            "version", version
        ));
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
