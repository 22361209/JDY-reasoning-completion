package com.jdy.erp.masterdata.application;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.delete;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.patch;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.put;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.stream.Collectors;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.jdy.erp.system.application.list.StubListSeedRowsProvider;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.http.MediaType;
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
class EmployeeFinancialAccountIntegrationTest {
    @Autowired
    private MockMvc mockMvc;

    @Autowired
    private ObjectMapper objectMapper;

    @Autowired
    private JdbcTemplate jdbcTemplate;

    @Autowired
    @Qualifier("platformJdbcTemplate")
    private JdbcTemplate platformJdbcTemplate;

    @Autowired
    @Qualifier("platformTransactionManager")
    private PlatformTransactionManager platformTransactionManager;

    @Autowired
    private StubListSeedRowsProvider listRowsProvider;

    @Test
    void createsEmployeeCashBankAndDepositWithCnyUsdAndRejectsInvalidShapes() throws Exception {
        var admin = login("admin", "admin123");
        var suffix = suffix();
        var employeeCode = "YG-A140-" + suffix;
        create(admin, "employee", Map.ofEntries(
            Map.entry("code", employeeCode),
            Map.entry("name", "A140 员工"),
            Map.entry("position", "会计"),
            Map.entry("department", "财务部"),
            Map.entry("phone", "13800001234"),
            Map.entry("email", "a140@example.test")
        ))
            .andExpect(status().isCreated())
            .andExpect(jsonPath("$.code").value(employeeCode))
            .andExpect(jsonPath("$.version").value(0))
            .andExpect(jsonPath("$.auditStatus").value("未审核"))
            .andExpect(jsonPath("$.status").value("启用"));

        var cashCode = "ZH-A140-C-" + suffix;
        create(admin, "financialAccount", Map.of(
            "code", cashCode,
            "name", "A140 现金美元账户",
            "accountType", "CASH",
            "currency", "USD"
        ))
            .andExpect(status().isCreated())
            .andExpect(jsonPath("$.accountType").value("CASH"))
            .andExpect(jsonPath("$.currency").value("USD"))
            .andExpect(jsonPath("$.accountNo").value(""));

        var bankCode = "ZH-A140-B-" + suffix;
        create(admin, "financialAccount", Map.ofEntries(
            Map.entry("code", bankCode),
            Map.entry("name", "A140 银行账户"),
            Map.entry("accountType", "BANK"),
            Map.entry("bankName", "测试银行"),
            Map.entry("accountNo", "000012340001"),
            Map.entry("accountHolder", "测试户名"),
            Map.entry("currency", "CNY")
        ))
            .andExpect(status().isCreated())
            .andExpect(jsonPath("$.accountNo").value("000012340001"));
        assertThat(jdbcTemplate.queryForObject(
            "SELECT account_no FROM md_financial_account WHERE code = ?",
            String.class,
            bankCode
        )).isEqualTo("000012340001");

        create(admin, "financialAccount", Map.ofEntries(
            Map.entry("code", "ZH-A140-D-" + suffix),
            Map.entry("name", "A140 定期账户"),
            Map.entry("accountType", "DEPOSIT"),
            Map.entry("bankName", "测试银行"),
            Map.entry("accountNo", "00009999"),
            Map.entry("accountHolder", "测试户名"),
            Map.entry("currency", "USD")
        )).andExpect(status().isCreated());

        create(admin, "financialAccount", Map.of(
            "code", "ZH-A140-BAD-C-" + suffix,
            "name", "错误现金账户",
            "accountType", "CASH",
            "currency", "CNY",
            "accountNo", "should-not-exist"
        )).andExpect(status().isBadRequest());
        create(admin, "financialAccount", Map.of(
            "code", "ZH-A140-BAD-B-" + suffix,
            "name", "缺少银行字段",
            "accountType", "BANK",
            "currency", "CNY"
        )).andExpect(status().isBadRequest());
        create(admin, "financialAccount", Map.of(
            "code", "ZH-A140-BAD-U-" + suffix,
            "name", "未知币种",
            "accountType", "CASH",
            "currency", "EUR"
        )).andExpect(status().isBadRequest());
        create(admin, "financialAccount", Map.of(
            "code", "ZH-A140-BAD-T-" + suffix,
            "name", "未知类型",
            "accountType", "OTHER",
            "currency", "CNY"
        )).andExpect(status().isBadRequest());

        create(admin, "employee", Map.of("code", employeeCode, "name", "重码"))
            .andExpect(status().isConflict());

        create(admin, "employee", Map.of("code", "E".repeat(81), "name", "超长编码"))
            .andExpect(status().isBadRequest())
            .andExpect(jsonPath("$.message").value("员工编码不能超过80个字符"));
        create(admin, "employee", Map.of("code", "YG-A140-LONG-" + suffix, "name", "N".repeat(201)))
            .andExpect(status().isBadRequest())
            .andExpect(jsonPath("$.message").value("员工姓名不能超过200个字符"));
        create(admin, "financialAccount", Map.ofEntries(
            Map.entry("code", "ZH-A140-LONG-" + suffix),
            Map.entry("name", "超长账号"),
            Map.entry("accountType", "BANK"),
            Map.entry("bankName", "测试银行"),
            Map.entry("accountNo", "0".repeat(121)),
            Map.entry("accountHolder", "测试户名"),
            Map.entry("currency", "USD")
        ))
            .andExpect(status().isBadRequest())
            .andExpect(jsonPath("$.message").value("账号不能超过120个字符"));
    }

    @Test
    void sparsePatchLifecycleMethodBoundariesAndLogsAreAtomicAndSanitized() throws Exception {
        var admin = login("admin", "admin123");
        var suffix = suffix();
        var employeeCode = "YG-A140-L-" + suffix;
        var secretPhone = "13912345678";
        var secretEmail = "private-a140@example.test";
        create(admin, "employee", Map.ofEntries(
            Map.entry("code", employeeCode),
            Map.entry("name", "A140 生命周期员工"),
            Map.entry("department", "原部门"),
            Map.entry("phone", secretPhone),
            Map.entry("email", secretEmail)
        )).andExpect(status().isCreated());

        mockMvc.perform(patch("/api/master-data/employee/{code}", employeeCode)
                .session(admin)
                .contentType(MediaType.APPLICATION_JSON)
                .content("""
                    {"version":0,"changes":{"name":"A140 新姓名","department":null}}
                    """))
            .andExpect(status().isOk())
            .andExpect(jsonPath("$.version").value(1))
            .andExpect(jsonPath("$.name").value("A140 新姓名"))
            .andExpect(jsonPath("$.department").value(""))
            .andExpect(jsonPath("$.phone").value(secretPhone));

        mockMvc.perform(patch("/api/master-data/employee/{code}", employeeCode)
                .session(admin)
                .contentType(MediaType.APPLICATION_JSON)
                .content("{" + "\"version\":0,\"changes\":{\"position\":\"旧版本不应写入\"}}"))
            .andExpect(status().isConflict());

        var beforeMethodRejections = row("md_employee", employeeCode);
        var failureLogBaseline = methodFailureLogIds();
        try {
            mockMvc.perform(put("/api/master-data/employee/{code}", employeeCode)
                    .session(admin)
                    .contentType(MediaType.APPLICATION_JSON)
                    .content("{\"name\":\"PUT 不应写入\"}"))
                .andExpect(status().isMethodNotAllowed());
            mockMvc.perform(delete("/api/master-data/employee/{code}", employeeCode).session(admin))
                .andExpect(status().isMethodNotAllowed());
            assertThat(row("md_employee", employeeCode)).isEqualTo(beforeMethodRejections);

            var failureLogs = newMethodFailureLogs(failureLogBaseline);
            assertThat(failureLogs).hasSize(2);
            assertThat(failureLogs).anySatisfy(log -> {
                assertThat(log.get("targetNo")).isEqualTo("PUT /api/master-data/{type}/{code}");
                assertThat(log.get("reason")).isEqualTo("该主数据类型只允许使用带 version 的 PATCH 更新");
            });
            assertThat(failureLogs).anySatisfy(log -> {
                assertThat(log.get("targetNo")).isEqualTo("DELETE /api/master-data/{type}/{code}");
                assertThat(log.get("reason")).isEqualTo("该主数据不允许删除，请使用正式禁用动作");
            });
        } finally {
            deleteMethodFailureLogs(newMethodFailureLogs(failureLogBaseline));
        }

        mockMvc.perform(post("/api/master-data/employee/{code}/audit", employeeCode).session(admin))
            .andExpect(status().isOk())
            .andExpect(jsonPath("$.auditStatus").value("已审核"))
            .andExpect(jsonPath("$.version").value(2));
        mockMvc.perform(patch("/api/master-data/employee/{code}", employeeCode)
                .session(admin)
                .contentType(MediaType.APPLICATION_JSON)
                .content("{\"version\":2,\"changes\":{\"remark\":\"审核后不应写入\"}}"))
            .andExpect(status().isConflict());
        mockMvc.perform(post("/api/master-data/employee/{code}/reverse", employeeCode).session(admin))
            .andExpect(status().isOk())
            .andExpect(jsonPath("$.auditStatus").value("未审核"))
            .andExpect(jsonPath("$.version").value(3));
        setStatus(admin, "employee", employeeCode, "禁用")
            .andExpect(status().isOk())
            .andExpect(jsonPath("$.status").value("禁用"))
            .andExpect(jsonPath("$.version").value(4));
        setStatus(admin, "employee", employeeCode, "启用")
            .andExpect(status().isOk())
            .andExpect(jsonPath("$.status").value("启用"))
            .andExpect(jsonPath("$.version").value(5));

        var logs = jdbcTemplate.queryForList("""
            SELECT action_code, COALESCE(failure_reason, '') AS reason,
                   COALESCE(before_state::text, '') AS before_state,
                   COALESCE(after_state::text, '') AS after_state
            FROM sys_operation_log
            WHERE target_no = ?
            ORDER BY operated_at
            """, employeeCode);
        assertThat(logs).extracting(row -> String.valueOf(row.get("action_code")))
            .contains(
                "CREATE_MASTER_DATA",
                "PATCH_MASTER_DATA",
                "AUDIT_MASTER_DATA",
                "REVERSE_MASTER_DATA",
                "DISABLE_MASTER_DATA",
                "ENABLE_MASTER_DATA"
            );
        var serializedLogs = objectMapper.writeValueAsString(logs);
        assertThat(serializedLogs)
            .doesNotContain(secretPhone)
            .doesNotContain(secretEmail)
            .doesNotContain("A140 新姓名");
    }

    @Test
    void financialPatchPreservesLeadingZerosAndSupportsAtomicBankToCashTransition() throws Exception {
        var admin = login("admin", "admin123");
        var code = "ZH-A140-P-" + suffix();
        create(admin, "financialAccount", Map.ofEntries(
            Map.entry("code", code),
            Map.entry("name", "A140 PATCH 账户"),
            Map.entry("accountType", "BANK"),
            Map.entry("bankName", "测试银行"),
            Map.entry("accountNo", "000001"),
            Map.entry("accountHolder", "测试户名"),
            Map.entry("currency", "USD")
        )).andExpect(status().isCreated());

        mockMvc.perform(patch("/api/master-data/financialAccount/{code}", code)
                .session(admin)
                .contentType(MediaType.APPLICATION_JSON)
                .content("{\"version\":0,\"changes\":{\"accountNo\":\"000000009\"}}"))
            .andExpect(status().isOk())
            .andExpect(jsonPath("$.accountNo").value("000000009"))
            .andExpect(jsonPath("$.currency").value("USD"))
            .andExpect(jsonPath("$.version").value(1));

        mockMvc.perform(patch("/api/master-data/financialAccount/{code}", code)
                .session(admin)
                .contentType(MediaType.APPLICATION_JSON)
                .content("""
                    {"version":1,"changes":{"accountType":"CASH","bankName":null,"accountNo":null,"accountHolder":null}}
                    """))
            .andExpect(status().isOk())
            .andExpect(jsonPath("$.accountType").value("CASH"))
            .andExpect(jsonPath("$.accountNo").value(""))
            .andExpect(jsonPath("$.currency").value("USD"))
            .andExpect(jsonPath("$.version").value(2));

        var beforeInvalid = row("md_financial_account", code);
        mockMvc.perform(patch("/api/master-data/financialAccount/{code}", code)
                .session(admin)
                .contentType(MediaType.APPLICATION_JSON)
                .content("{\"version\":2,\"changes\":{\"accountType\":\"BANK\"}}"))
            .andExpect(status().isBadRequest());
        assertThat(row("md_financial_account", code)).isEqualTo(beforeInvalid);
        mockMvc.perform(patch("/api/master-data/financialAccount/{code}", code)
                .session(admin)
                .contentType(MediaType.APPLICATION_JSON)
                .content("{\"version\":2,\"changes\":{\"currency\":\"EUR\"}}"))
            .andExpect(status().isBadRequest());
        assertThat(row("md_financial_account", code)).isEqualTo(beforeInvalid);
    }

    @Test
    void selectorsReturnOnlyAuditedEnabledRowsAndListPermissionsUseTheDeclaredMatrix() throws Exception {
        var admin = login("admin", "admin123");
        var suffix = suffix();
        var employeeAudited = "YG-A140-SA-" + suffix;
        var employeeDraft = "YG-A140-SD-" + suffix;
        var employeeDisabled = "YG-A140-SX-" + suffix;
        for (var code : List.of(employeeAudited, employeeDraft, employeeDisabled)) {
            create(admin, "employee", Map.of("code", code, "name", code)).andExpect(status().isCreated());
        }
        audit(admin, "employee", employeeAudited).andExpect(status().isOk());
        audit(admin, "employee", employeeDisabled).andExpect(status().isOk());
        setStatus(admin, "employee", employeeDisabled, "禁用").andExpect(status().isOk());

        var accountAudited = "ZH-A140-SA-" + suffix;
        var accountDraft = "ZH-A140-SD-" + suffix;
        var accountDisabled = "ZH-A140-SX-" + suffix;
        for (var code : List.of(accountAudited, accountDraft, accountDisabled)) {
            create(admin, "financialAccount", Map.of(
                "code", code,
                "name", code,
                "accountType", "CASH",
                "currency", "CNY"
            )).andExpect(status().isCreated());
        }
        audit(admin, "financialAccount", accountAudited).andExpect(status().isOk());
        audit(admin, "financialAccount", accountDisabled).andExpect(status().isOk());
        setStatus(admin, "financialAccount", accountDisabled, "禁用").andExpect(status().isOk());

        assertThat(codes(listRowsProvider.seedRows("employee-master-selector", "header", 200)))
            .contains(employeeAudited)
            .doesNotContain(employeeDraft, employeeDisabled);
        assertThat(codes(listRowsProvider.seedRows("financial-account-master-selector", "header", 200)))
            .contains(accountAudited)
            .doesNotContain(accountDraft, accountDisabled);
        assertThat(codes(listRowsProvider.seedRows("employee-master-list", "header", 200)))
            .contains(employeeAudited, employeeDraft, employeeDisabled);
        assertThat(codes(listRowsProvider.seedRows("financial-account-master-list", "header", 200)))
            .contains(accountAudited, accountDraft, accountDisabled);

        for (var key : List.of(
            "employee-master-list",
            "employee-master-selector",
            "financial-account-master-list",
            "financial-account-master-selector"
        )) {
            mockMvc.perform(get("/api/lists/{listKey}", key).session(admin))
                .andExpect(status().isOk());
        }

        var finance = login("finance", "finance123");
        mockMvc.perform(get("/api/lists/financial-account-master-list").session(finance))
            .andExpect(status().isOk());
        mockMvc.perform(get("/api/lists/financial-account-master-selector").session(finance))
            .andExpect(status().isOk());
        mockMvc.perform(get("/api/lists/employee-master-list").session(finance))
            .andExpect(status().isForbidden());
        create(finance, "financialAccount", Map.of(
            "code", "ZH-A140-FORBIDDEN-" + suffix,
            "name", "财务角色不应可写",
            "accountType", "CASH",
            "currency", "CNY"
        )).andExpect(status().isForbidden());
        mockMvc.perform(patch("/api/master-data/financialAccount/{code}", accountDraft)
                .session(finance)
                .contentType(MediaType.APPLICATION_JSON)
                .content("{\"version\":0,\"changes\":{\"name\":\"无权写入\"}}"))
            .andExpect(status().isForbidden());
        mockMvc.perform(post("/api/master-data/financialAccount/{code}/audit", accountDraft).session(finance))
            .andExpect(status().isForbidden());
        setStatus(finance, "financialAccount", accountDraft, "禁用")
            .andExpect(status().isForbidden());

        var warehouse = login("warehouse", "warehouse123");
        for (var key : List.of(
            "employee-master-list",
            "employee-master-selector",
            "financial-account-master-list",
            "financial-account-master-selector"
        )) {
            mockMvc.perform(get("/api/lists/{listKey}", key).session(warehouse))
                .andExpect(status().isForbidden());
        }
    }

    private org.springframework.test.web.servlet.ResultActions create(
        MockHttpSession session,
        String type,
        Map<String, String> body
    ) throws Exception {
        return mockMvc.perform(post("/api/master-data/{type}", type)
            .session(session)
            .contentType(MediaType.APPLICATION_JSON)
            .content(objectMapper.writeValueAsBytes(body)));
    }

    private org.springframework.test.web.servlet.ResultActions audit(
        MockHttpSession session,
        String type,
        String code
    ) throws Exception {
        return mockMvc.perform(post("/api/master-data/{type}/{code}/audit", type, code).session(session));
    }

    private org.springframework.test.web.servlet.ResultActions setStatus(
        MockHttpSession session,
        String type,
        String code,
        String statusValue
    ) throws Exception {
        return mockMvc.perform(patch("/api/master-data/{type}/{code}/status", type, code)
            .session(session)
            .contentType(MediaType.APPLICATION_JSON)
            .content(objectMapper.writeValueAsBytes(Map.of("status", statusValue))));
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

    private Map<String, Object> row(String table, String code) {
        if (!List.of("md_employee", "md_financial_account").contains(table)) {
            throw new IllegalArgumentException("unsupported test table");
        }
        return jdbcTemplate.queryForMap("SELECT * FROM " + table + " WHERE code = ?", code);
    }

    private List<String> codes(List<Map<String, ?>> rows) {
        return rows.stream().map(row -> String.valueOf(row.get("code"))).toList();
    }

    private Set<String> methodFailureLogIds() {
        return methodFailureLogs().stream()
            .map(row -> String.valueOf(row.get("id")))
            .collect(Collectors.toUnmodifiableSet());
    }

    private List<Map<String, Object>> newMethodFailureLogs(Set<String> baseline) {
        return methodFailureLogs().stream()
            .filter(row -> !baseline.contains(String.valueOf(row.get("id"))))
            .toList();
    }

    private List<Map<String, Object>> methodFailureLogs() {
        return platformJdbcTemplate.queryForList("""
            SELECT id::text AS id,
                   target_no AS "targetNo",
                   failure_reason AS reason
            FROM sys_operation_log
            WHERE action_code = 'WRITE_FAILED'
              AND actor_username = 'admin'
              AND target_type = 'http_endpoint'
              AND target_no IN (
                  'PUT /api/master-data/{type}/{code}',
                  'DELETE /api/master-data/{type}/{code}'
              )
            """);
    }

    private void deleteMethodFailureLogs(List<Map<String, Object>> logs) {
        if (logs.isEmpty()) {
            return;
        }
        var transaction = new TransactionTemplate(platformTransactionManager);
        transaction.setPropagationBehavior(TransactionDefinition.PROPAGATION_REQUIRES_NEW);
        transaction.executeWithoutResult(ignored -> logs.forEach(log -> platformJdbcTemplate.update(
            "DELETE FROM sys_operation_log WHERE id = ?::uuid",
            log.get("id")
        )));
    }

    private String suffix() {
        return Long.toUnsignedString(System.nanoTime(), 36).toUpperCase();
    }
}
