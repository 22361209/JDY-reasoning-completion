package com.jdy.erp.system.tenant;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.multipart;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.UUID;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.jdy.erp.masterdata.application.MasterDataImportDefinitionRegistry;
import com.jdy.erp.masterdata.application.MasterDataImportService;
import com.jdy.erp.system.application.AccountSetManagementService;
import com.jdy.erp.system.security.CurrentSessionService;
import org.apache.poi.ss.usermodel.SheetVisibility;
import org.apache.poi.xssf.usermodel.XSSFWorkbook;
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
import org.springframework.mock.web.MockMultipartFile;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.web.context.request.RequestContextHolder;
import org.springframework.web.context.request.ServletRequestAttributes;

@SpringBootTest
@AutoConfigureMockMvc
class TenantMasterDataImportIsolationTest {
    @Autowired
    private AccountSetManagementService accountSetManagementService;

    @Autowired
    private CurrentSessionService currentSessionService;

    @Autowired
    private MasterDataImportDefinitionRegistry definitions;

    @Autowired
    private MasterDataImportService importService;

    @Autowired
    private MockMvc mockMvc;

    @Autowired
    private ObjectMapper objectMapper;

    @Autowired
    @Qualifier("platformJdbcTemplate")
    private JdbcTemplate platformJdbcTemplate;

    @Autowired
    private TenantDataSourceRegistry tenantDataSourceRegistry;

    private final List<String> createdCodes = new ArrayList<>();
    private final List<String> createdAccountSetIds = new ArrayList<>();
    private final List<String> createdSchemas = new ArrayList<>();
    private final List<String> createdPublicJobIds = new ArrayList<>();
    private MockHttpSession admin;

    @BeforeEach
    void setUp() throws Exception {
        admin = login("admin", "admin123", "BLD-TEST");
        bind(admin);
    }

    @AfterEach
    void cleanUp() {
        TenantContext.clear();
        RequestContextHolder.resetRequestAttributes();
        tenantDataSourceRegistry.close();
        for (var schema : createdSchemas) {
            platformJdbcTemplate.execute("DROP SCHEMA IF EXISTS " + quoteIdentifier(schema) + " CASCADE");
        }
        for (int index = 0; index < createdCodes.size(); index++) {
            var code = createdCodes.get(index);
            var accountSetId = createdAccountSetIds.get(index);
            platformJdbcTemplate.update("""
                DELETE FROM sys_operation_log
                WHERE module_code = 'SYSTEM'
                  AND action_code = 'CREATE_ACCOUNT_SET'
                  AND target_type = 'sys_account_set'
                  AND target_id = ?::uuid
                  AND target_no = ?
                """, accountSetId, code);
            platformJdbcTemplate.update("""
                DELETE FROM sys_user_account_set
                WHERE account_set_id IN (SELECT id FROM sys_account_set WHERE code = ?)
                """, code);
            platformJdbcTemplate.update("DELETE FROM sys_account_set WHERE code = ?", code);
        }
        for (var jobId : createdPublicJobIds) {
            platformJdbcTemplate.update(
                "DELETE FROM sys_operation_log WHERE target_type = 'MASTER_DATA_IMPORT' AND target_id = ?::uuid",
                jobId
            );
            platformJdbcTemplate.update("DELETE FROM public.md_import_batch WHERE id = ?::uuid", jobId);
        }
    }

    @Test
    void tokenAndPayloadAreInvisibleAcrossTenantsAndOnlyOriginTenantReceivesRows() throws Exception {
        var tenantA = createManagedAccountSet("A143-TA");
        var tenantB = createManagedAccountSet("A143-TB");
        var code = "A143-TENANT-" + UUID.randomUUID().toString().substring(0, 8).toUpperCase();
        var workbook = customerWorkbook(code, "跨账套隔离客户");

        switchAccountSet(admin, String.valueOf(tenantA.get("code")));
        var previewResponse = mockMvc.perform(multipart("/api/master-data/import/jobs/customer/preview")
                .file(new MockMultipartFile(
                    "file",
                    "tenant-a-customers.xlsx",
                    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                    workbook
                ))
                .session(admin))
            .andExpect(status().isCreated())
            .andExpect(jsonPath("$.status").value("VALIDATED"))
            .andExpect(jsonPath("$.rows[0].payload.code").value(code))
            .andReturn()
            .getResponse()
            .getContentAsByteArray();
        var jobId = objectMapper.readTree(previewResponse).path("id").asText();

        switchAccountSet(admin, String.valueOf(tenantB.get("code")));
        mockMvc.perform(get("/api/master-data/import/jobs/{jobId}", jobId).session(admin))
            .andExpect(status().isNotFound());
        mockMvc.perform(get("/api/master-data/import/jobs/{jobId}/error-receipt", jobId).session(admin))
            .andExpect(status().isNotFound());
        mockMvc.perform(post("/api/master-data/import/jobs/{jobId}/confirm", jobId).session(admin))
            .andExpect(status().isNotFound());
        mockMvc.perform(get("/api/master-data/import/jobs").session(admin))
            .andExpect(status().isOk())
            .andExpect(jsonPath("$.total").value(0));

        assertThat(countInTenant(tenantB, "md_import_batch", "id", jobId)).isZero();
        assertThat(countInTenant(tenantB, "md_customer", "code", code)).isZero();
        assertThat(countInTenant(tenantA, "md_import_batch", "id", jobId)).isOne();
        assertThat(countInTenant(tenantA, "md_customer", "code", code)).isZero();

        switchAccountSet(admin, String.valueOf(tenantA.get("code")));
        mockMvc.perform(post("/api/master-data/import/jobs/{jobId}/confirm", jobId).session(admin))
            .andExpect(status().isOk())
            .andExpect(jsonPath("$.status").value("COMMITTED"))
            .andExpect(jsonPath("$.committedRows").value(1));

        assertThat(countInTenant(tenantA, "md_customer", "code", code)).isOne();
        assertThat(countInTenant(tenantB, "md_customer", "code", code)).isZero();
    }

    @Test
    void scheduledExpirySweepClearsAbandonedPayloadWithoutOwnerOrRequestContext() throws Exception {
        var publicJobId = previewCustomerJob(
            "public-sentinel.xlsx",
            customerWorkbook("A143-PUBLIC-" + randomSuffix(), "public 过期哨兵")
        );
        createdPublicJobIds.add(publicJobId);
        platformJdbcTemplate.update("""
            UPDATE public.md_import_batch
            SET created_at = now() - interval '1 hour',
                expires_at = now() - interval '1 minute',
                updated_at = now()
            WHERE id = ?::uuid
            """, publicJobId);
        var publicStateBefore = importBatchState("public.md_import_batch", publicJobId);

        var tenant = createManagedAccountSet("A143-EXP");
        switchAccountSet(admin, String.valueOf(tenant.get("code")));
        var abandonedCode = "A143-ABANDONED-" + randomSuffix();
        var liveCode = "A143-LIVE-" + randomSuffix();
        var committedCode = "A143-COMMITTED-" + randomSuffix();
        var abandonedJobId = previewCustomerJob(
            "abandoned-customers.xlsx",
            customerWorkbook(abandonedCode, "无主过期客户")
        );
        var liveJobId = previewCustomerJob("live-customers.xlsx", customerWorkbook(liveCode, "未过期客户"));
        var committedJobId = previewCustomerJob(
            "committed-customers.xlsx",
            customerWorkbook(committedCode, "已提交客户")
        );
        mockMvc.perform(post("/api/master-data/import/jobs/{jobId}/confirm", committedJobId).session(admin))
            .andExpect(status().isOk())
            .andExpect(jsonPath("$.status").value("COMMITTED"))
            .andExpect(jsonPath("$.committedRows").value(1));
        var qualifiedBatchTable = quoteIdentifier(String.valueOf(tenant.get("schemaName")))
            + ".md_import_batch";
        platformJdbcTemplate.update("""
            UPDATE %s
            SET created_by = ?::uuid,
                created_by_username = 'a143-revoked-owner',
                created_at = now() - interval '1 hour',
                expires_at = now() - interval '1 minute',
                updated_at = now()
            WHERE id = ?::uuid
            """.formatted(qualifiedBatchTable), UUID.randomUUID().toString(), abandonedJobId);
        var liveStateBefore = importBatchState(qualifiedBatchTable, liveJobId);
        var committedStateBefore = importBatchState(qualifiedBatchTable, committedJobId);
        var brokenTenant = createManagedAccountSet("A143-BAD");
        assertThat(String.valueOf(brokenTenant.get("code")))
            .isLessThan(String.valueOf(tenant.get("code")));
        platformJdbcTemplate.execute(
            "DROP TABLE " + quoteIdentifier(String.valueOf(brokenTenant.get("schemaName"))) + ".md_import_batch"
        );
        platformJdbcTemplate.update("""
            UPDATE sys_account_set
            SET enabled = FALSE,
                initialized = FALSE
            WHERE id = ?::uuid
            """, String.valueOf(tenant.get("id")));
        assertThat(platformJdbcTemplate.queryForMap("""
            SELECT enabled, initialized
            FROM sys_account_set
            WHERE id = ?::uuid
            """, String.valueOf(tenant.get("id"))))
            .containsEntry("enabled", false)
            .containsEntry("initialized", false);

        TenantContext.clear();
        RequestContextHolder.resetRequestAttributes();
        importService.expireOverdueImportBatches();
        importService.expireOverdueImportBatches();

        assertThat(importBatchState(qualifiedBatchTable, abandonedJobId))
            .containsEntry("status", "EXPIRED")
            .containsEntry("rowsPayload", "[]")
            .containsEntry("payloadCleared", true)
            .containsEntry("version", 1L);
        assertThat(importBatchState(qualifiedBatchTable, liveJobId)).isEqualTo(liveStateBefore);
        assertThat(importBatchState(qualifiedBatchTable, committedJobId)).isEqualTo(committedStateBefore);
        assertThat(importBatchState("public.md_import_batch", publicJobId)).isEqualTo(publicStateBefore);
        assertThat(TenantContext.current()).isEmpty();
        assertThat(countInTenant(tenant, "md_customer", "code", abandonedCode)).isZero();
        assertThat(countInTenant(tenant, "md_customer", "code", liveCode)).isZero();
        assertThat(countInTenant(tenant, "md_customer", "code", committedCode)).isOne();
    }

    private String previewCustomerJob(String fileName, byte[] workbook) throws Exception {
        var previewResponse = mockMvc.perform(multipart("/api/master-data/import/jobs/customer/preview")
                .file(new MockMultipartFile(
                    "file",
                    fileName,
                    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                    workbook
                ))
                .session(admin))
            .andExpect(status().isCreated())
            .andExpect(jsonPath("$.status").value("VALIDATED"))
            .andReturn()
            .getResponse()
            .getContentAsByteArray();
        return objectMapper.readTree(previewResponse).path("id").asText();
    }

    private Map<String, Object> importBatchState(String qualifiedBatchTable, String jobId) {
        if (!qualifiedBatchTable.matches("(?:public|\"[a-z][a-z0-9_]{0,62}\")\\.md_import_batch")) {
            throw new IllegalArgumentException("invalid test batch table");
        }
        return platformJdbcTemplate.queryForMap("""
            SELECT status,
                   rows_payload::text AS "rowsPayload",
                   payload_cleared_at IS NOT NULL AS "payloadCleared",
                   version
            FROM %s
            WHERE id = ?::uuid
            """.formatted(qualifiedBatchTable), jobId);
    }

    private String randomSuffix() {
        return UUID.randomUUID().toString().substring(0, 8).toUpperCase();
    }

    @SuppressWarnings("unchecked")
    private Map<String, Object> createManagedAccountSet(String prefix) {
        bind(admin);
        var code = prefix + "-" + UUID.randomUUID().toString().substring(0, 8).toUpperCase();
        var result = accountSetManagementService.createAccountSet(new AccountSetManagementService.AccountSetCreateRequest(
            code,
            code + " 账套",
            "A143测试",
            null,
            null,
            null,
            null,
            "2026-07",
            "2026-07"
        ));
        var accountSet = (Map<String, Object>) result.get("accountSet");
        createdCodes.add(code);
        createdAccountSetIds.add(String.valueOf(accountSet.get("id")));
        createdSchemas.add(String.valueOf(accountSet.get("schemaName")));
        return accountSet;
    }

    private int countInTenant(Map<String, Object> tenant, String table, String field, String value) {
        var allowedTable = switch (table) {
            case "md_import_batch", "md_customer" -> table;
            default -> throw new IllegalArgumentException("Unexpected table");
        };
        var allowedField = switch (field) {
            case "id", "code" -> field;
            default -> throw new IllegalArgumentException("Unexpected field");
        };
        return platformJdbcTemplate.queryForObject(
            "SELECT count(*)::int FROM " + quoteIdentifier(String.valueOf(tenant.get("schemaName")))
                + "." + allowedTable + " WHERE " + allowedField + "::text = ?",
            Integer.class,
            value
        );
    }

    private byte[] customerWorkbook(String code, String name) throws IOException {
        var definition = definitions.require("customer");
        try (var workbook = new XSSFWorkbook();
             var output = new ByteArrayOutputStream()) {
            var data = workbook.createSheet(MasterDataImportDefinitionRegistry.DATA_SHEET);
            data.createRow(0).createCell(0).setCellValue(definition.title() + "导入模板");
            var header = data.createRow(1);
            for (int column = 0; column < definition.headers().size(); column++) {
                header.createCell(column).setCellValue(definition.headers().get(column));
            }
            var row = data.createRow(2);
            setByKey(row, definition, "code", code);
            setByKey(row, definition, "name", name);
            workbook.createSheet(MasterDataImportDefinitionRegistry.GUIDE_SHEET)
                .createRow(0)
                .createCell(0)
                .setCellValue("填写说明");
            var meta = workbook.createSheet(MasterDataImportDefinitionRegistry.META_SHEET);
            var metadata = List.of(
                List.of("key", "value"),
                List.of("contract", "A143"),
                List.of("type", definition.type()),
                List.of("version", "1"),
                List.of("dataSheet", MasterDataImportDefinitionRegistry.DATA_SHEET),
                List.of("headerRow", "2"),
                List.of("maxDataRows", "5000")
            );
            for (int index = 0; index < metadata.size(); index++) {
                var metaRow = meta.createRow(index);
                metaRow.createCell(0).setCellValue(metadata.get(index).get(0));
                metaRow.createCell(1).setCellValue(metadata.get(index).get(1));
            }
            meta.protectSheet("");
            workbook.setSheetVisibility(workbook.getSheetIndex(meta), SheetVisibility.VERY_HIDDEN);
            workbook.write(output);
            return output.toByteArray();
        }
    }

    private void setByKey(
        org.apache.poi.ss.usermodel.Row row,
        MasterDataImportDefinitionRegistry.ImportDefinition definition,
        String key,
        String value
    ) {
        for (int column = 0; column < definition.fields().size(); column++) {
            if (definition.fields().get(column).key().equals(key)) {
                row.createCell(column).setCellValue(value);
                return;
            }
        }
        throw new IllegalArgumentException("Unknown field: " + key);
    }

    private void switchAccountSet(MockHttpSession session, String accountSetCode) throws Exception {
        mockMvc.perform(post("/api/system/account-sets/current")
                .session(session)
                .contentType(MediaType.APPLICATION_JSON)
                .content(objectMapper.writeValueAsBytes(Map.of("accountSetCode", accountSetCode))))
            .andExpect(status().isOk())
            .andExpect(jsonPath("$.current.code").value(accountSetCode));
    }

    private MockHttpSession login(String username, String password, String accountSetCode) throws Exception {
        var session = new MockHttpSession();
        mockMvc.perform(post("/api/system/login")
                .session(session)
                .contentType(MediaType.APPLICATION_JSON)
                .content(objectMapper.writeValueAsBytes(Map.of(
                    "username", username,
                    "password", password,
                    "accountSetCode", accountSetCode
                ))))
            .andExpect(status().isOk());
        return session;
    }

    private void bind(MockHttpSession session) {
        TenantContext.clear();
        var request = new MockHttpServletRequest();
        request.setSession(session);
        RequestContextHolder.setRequestAttributes(new ServletRequestAttributes(request));
        TenantContext.setTenant(currentSessionService.currentAccountSet());
    }

    private String quoteIdentifier(String identifier) {
        if (identifier == null || !identifier.matches("[a-z][a-z0-9_]{0,62}")) {
            throw new IllegalArgumentException("invalid test schema identifier");
        }
        return "\"" + identifier.replace("\"", "\"\"") + "\"";
    }
}
