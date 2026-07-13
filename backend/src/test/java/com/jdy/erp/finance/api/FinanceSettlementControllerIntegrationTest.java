package com.jdy.erp.finance.api;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;

import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.mock.web.MockHttpSession;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.TransactionDefinition;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.transaction.support.TransactionTemplate;

@SpringBootTest
@AutoConfigureMockMvc
@Transactional
class FinanceSettlementControllerIntegrationTest {
    private static final Set<String> RETIRED_PATTERNS = Set.of(
        "POST /api/finance/receivables/{billNo}/receipt",
        "POST /api/finance/payables/{billNo}/payment"
    );

    @Autowired
    private MockMvc mockMvc;

    @Autowired
    private ObjectMapper objectMapper;

    @Autowired
    @Qualifier("platformJdbcTemplate")
    private JdbcTemplate platformJdbcTemplate;

    @Autowired
    @Qualifier("platformTransactionManager")
    private PlatformTransactionManager platformTransactionManager;

    private String tenantSchema;
    private Set<String> baselineFailureLogIds;

    @BeforeEach
    void captureFailureLogBaseline() {
        tenantSchema = platformJdbcTemplate.queryForObject("""
            SELECT schema_name
            FROM sys_account_set
            WHERE code = 'BLD-TEST'
            """, String.class);
        baselineFailureLogIds = failureLogs().stream()
            .map(row -> String.valueOf(row.get("id")))
            .collect(java.util.stream.Collectors.toCollection(LinkedHashSet::new));
    }

    @AfterEach
    void removeCommittedFailureLogs() {
        var newIds = failureLogs().stream()
            .map(row -> String.valueOf(row.get("id")))
            .filter(id -> !baselineFailureLogIds.contains(id))
            .toList();
        if (newIds.isEmpty()) {
            return;
        }
        var cleanup = new TransactionTemplate(platformTransactionManager);
        cleanup.setPropagationBehavior(TransactionDefinition.PROPAGATION_REQUIRES_NEW);
        cleanup.executeWithoutResult(ignored -> newIds.forEach(id -> platformJdbcTemplate.update(
            "DELETE FROM " + tenantTable("sys_operation_log") + " WHERE id = ?::uuid",
            id
        )));
    }

    @Test
    void retiredImmediateUrlsApplyAuthenticationThenPermissionThenGoneWithoutAnySettlementWrite() throws Exception {
        var before = settlementFacts();
        var privateReceivableNo = "YS-PRIVATE-A141";
        var privatePayableNo = "YF-PRIVATE-A141";

        mockMvc.perform(post("/api/finance/receivables/{billNo}/receipt", privateReceivableNo))
            .andExpect(status().isUnauthorized());
        mockMvc.perform(post("/api/finance/payables/{billNo}/payment", privatePayableNo))
            .andExpect(status().isUnauthorized());

        var warehouse = login("warehouse", "warehouse123");
        mockMvc.perform(post("/api/finance/receivables/{billNo}/receipt", privateReceivableNo).session(warehouse))
            .andExpect(status().isForbidden());
        mockMvc.perform(post("/api/finance/payables/{billNo}/payment", privatePayableNo).session(warehouse))
            .andExpect(status().isForbidden());

        var finance = login("finance", "finance123");
        mockMvc.perform(post("/api/finance/receivables/{billNo}/receipt", privateReceivableNo).session(finance))
            .andExpect(status().isGone())
            .andExpect(jsonPath("$.message").value(org.hamcrest.Matchers.containsString("/api/finance/receipts/draft")));
        mockMvc.perform(post("/api/finance/payables/{billNo}/payment", privatePayableNo).session(finance))
            .andExpect(status().isGone())
            .andExpect(jsonPath("$.message").value(org.hamcrest.Matchers.containsString("/api/finance/payments/draft")));

        assertThat(settlementFacts()).isEqualTo(before);
        var newLogs = failureLogs().stream()
            .filter(row -> !baselineFailureLogIds.contains(String.valueOf(row.get("id"))))
            .toList();
        assertThat(newLogs).hasSize(4);
        assertThat(newLogs).extracting(row -> String.valueOf(row.get("action")))
            .containsExactlyInAnyOrder("WRITE_DENIED", "WRITE_DENIED", "WRITE_FAILED", "WRITE_FAILED");
        assertThat(newLogs).extracting(row -> String.valueOf(row.get("targetNo")))
            .containsOnlyElementsOf(RETIRED_PATTERNS);
        assertThat(objectMapper.writeValueAsString(newLogs))
            .doesNotContain(privateReceivableNo)
            .doesNotContain(privatePayableNo);
    }

    private MockHttpSession login(String username, String password) throws Exception {
        var session = new MockHttpSession();
        mockMvc.perform(post("/api/system/login")
                .session(session)
                .contentType(org.springframework.http.MediaType.APPLICATION_JSON)
                .content(objectMapper.writeValueAsBytes(Map.of(
                    "username", username,
                    "password", password,
                    "accountSetCode", "BLD-TEST"
                ))))
            .andExpect(status().isOk());
        return session;
    }

    private Map<String, Object> settlementFacts() {
        return platformJdbcTemplate.queryForMap("""
            SELECT (SELECT COUNT(*)::bigint FROM %1$s) AS receipt_count,
                   (SELECT COUNT(*)::bigint FROM %2$s) AS payment_count,
                   (SELECT COALESCE(SUM(received_amount), 0) FROM %3$s) AS received_total,
                   (SELECT COALESCE(SUM(paid_amount), 0) FROM %4$s) AS paid_total
            """.formatted(
                tenantTable("ar_receipt"),
                tenantTable("ap_payment"),
                tenantTable("ar_receivable"),
                tenantTable("ap_payable")
            ));
    }

    private List<Map<String, Object>> failureLogs() {
        return platformJdbcTemplate.queryForList("""
            SELECT id::text AS id,
                   action_code AS action,
                   target_no AS "targetNo",
                   COALESCE(failure_reason, '') AS reason,
                   COALESCE(actor_username, '') AS username
            FROM %s
            WHERE target_type = 'http_endpoint'
              AND target_no IN (?, ?)
            ORDER BY operated_at, id
            """.formatted(tenantTable("sys_operation_log")),
            "POST /api/finance/receivables/{billNo}/receipt",
            "POST /api/finance/payables/{billNo}/payment"
        );
    }

    private String tenantTable(String table) {
        return quoteIdentifier(tenantSchema) + "." + quoteIdentifier(table);
    }

    private String quoteIdentifier(String value) {
        if (value == null || !value.matches("[A-Za-z_][A-Za-z0-9_]*")) {
            throw new IllegalStateException("invalid test schema/table identifier");
        }
        return '"' + value + '"';
    }
}
