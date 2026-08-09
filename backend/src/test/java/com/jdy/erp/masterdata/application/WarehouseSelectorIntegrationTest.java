package com.jdy.erp.masterdata.application;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.patch;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import java.util.LinkedHashSet;
import java.util.Map;
import java.util.Set;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.http.MediaType;
import org.springframework.mock.web.MockHttpSession;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.transaction.annotation.Transactional;

@SpringBootTest
@AutoConfigureMockMvc
@Transactional
class WarehouseSelectorIntegrationTest {
    @Autowired
    private MockMvc mockMvc;

    @Autowired
    private ObjectMapper objectMapper;

    @Test
    void selectorImmediatelyTracksAuditedEnabledWarehousesAndSearchesByCodeOrName() throws Exception {
        var admin = login("admin", "admin123");
        var suffix = Long.toUnsignedString(System.nanoTime(), 36).toUpperCase();
        var audited = "CK-A179-SA-" + suffix;
        var draft = "CK-A179-SD-" + suffix;
        var disabled = "CK-A179-SX-" + suffix;
        var auditedName = "A179 可选仓 " + suffix;
        var draftName = "A179 草稿仓 " + suffix;
        var disabledName = "A179 禁用仓 " + suffix;

        createWarehouse(admin, audited, auditedName);
        createWarehouse(admin, draft, draftName);
        createWarehouse(admin, disabled, disabledName);

        assertThat(selectorCodes(admin, audited)).doesNotContain(audited);

        auditWarehouse(admin, audited);
        auditWarehouse(admin, disabled);
        setWarehouseStatus(admin, disabled, "禁用");

        assertThat(selectorCodes(admin, audited)).containsExactly(audited);
        assertThat(selectorCodes(admin, auditedName)).containsExactly(audited);
        assertThat(selectorCodes(admin, suffix))
            .contains(audited)
            .doesNotContain(draft, disabled);
        assertThat(listCodes(admin, "warehouse-master-list", suffix))
            .contains(audited, draft, disabled);
    }

    private void createWarehouse(MockHttpSession session, String code, String name) throws Exception {
        mockMvc.perform(post("/api/master-data/warehouse")
                .session(session)
                .contentType(MediaType.APPLICATION_JSON)
                .content(objectMapper.writeValueAsBytes(Map.of(
                    "code", code,
                    "name", name,
                    "warehouseType", "普通仓"
                ))))
            .andExpect(status().isCreated());
    }

    private void auditWarehouse(MockHttpSession session, String code) throws Exception {
        mockMvc.perform(post("/api/master-data/warehouse/{code}/audit", code).session(session))
            .andExpect(status().isOk());
    }

    private void setWarehouseStatus(MockHttpSession session, String code, String statusValue) throws Exception {
        mockMvc.perform(patch("/api/master-data/warehouse/{code}/status", code)
                .session(session)
                .contentType(MediaType.APPLICATION_JSON)
                .content(objectMapper.writeValueAsBytes(Map.of("status", statusValue))))
            .andExpect(status().isOk());
    }

    private Set<String> selectorCodes(MockHttpSession session, String keyword) throws Exception {
        return listCodes(session, "warehouse-master-selector", keyword);
    }

    private Set<String> listCodes(MockHttpSession session, String listKey, String keyword) throws Exception {
        var response = mockMvc.perform(get("/api/lists/{listKey}", listKey)
                .session(session)
                .queryParam("keyword", keyword)
                .queryParam("page", "1")
                .queryParam("pageSize", "200"))
            .andExpect(status().isOk())
            .andReturn()
            .getResponse()
            .getContentAsByteArray();
        JsonNode root = objectMapper.readTree(response);
        var codes = new LinkedHashSet<String>();
        root.path("rows").forEach(row -> codes.add(row.path("code").asText()));
        return codes;
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
