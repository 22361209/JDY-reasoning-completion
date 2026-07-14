package com.jdy.erp.masterdata.api;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.multipart;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.content;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.header;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.util.List;
import java.util.Map;
import java.util.UUID;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.jdy.erp.masterdata.application.MasterDataImportDefinitionRegistry;
import com.jdy.erp.system.security.CurrentSessionService;
import com.jdy.erp.system.tenant.TenantContext;
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
class MasterDataImportControllerIntegrationTest {
    private static final String XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

    @Autowired
    private MockMvc mockMvc;

    @Autowired
    private ObjectMapper objectMapper;

    @Autowired
    private MasterDataImportDefinitionRegistry definitions;

    @Autowired
    private CurrentSessionService currentSessionService;

    @Autowired
    private JdbcTemplate jdbcTemplate;

    @Autowired
    @Qualifier("platformJdbcTemplate")
    private JdbcTemplate platformJdbcTemplate;

    private MockHttpSession admin;
    private String jobId;
    private String secondAdminUsername;

    @BeforeEach
    void setUp() throws Exception {
        admin = login("admin", "admin123");
        bind(admin);
    }

    @AfterEach
    void cleanUp() {
        try {
            if (jobId != null) {
                bind(admin);
                jdbcTemplate.update(
                    "DELETE FROM sys_operation_log WHERE target_type = 'MASTER_DATA_IMPORT' AND target_id = ?::uuid",
                    jobId
                );
                jdbcTemplate.update("DELETE FROM md_import_batch WHERE id = ?::uuid", jobId);
            }
            if (secondAdminUsername != null) {
                platformJdbcTemplate.update("""
                    DELETE FROM sys_operation_log
                    WHERE actor_username = ?
                       OR target_id IN (SELECT id FROM sys_user WHERE username = ?)
                    """, secondAdminUsername, secondAdminUsername);
                platformJdbcTemplate.update("""
                    DELETE FROM sys_session_account_scope
                    WHERE user_id IN (SELECT id FROM sys_user WHERE username = ?)
                    """, secondAdminUsername);
                platformJdbcTemplate.update("""
                    DELETE FROM sys_user_account_set
                    WHERE user_id IN (SELECT id FROM sys_user WHERE username = ?)
                    """, secondAdminUsername);
                platformJdbcTemplate.update("""
                    DELETE FROM sys_user_role
                    WHERE user_id IN (SELECT id FROM sys_user WHERE username = ?)
                    """, secondAdminUsername);
                platformJdbcTemplate.update("DELETE FROM sys_user WHERE username = ?", secondAdminUsername);
            }
        } finally {
            TenantContext.clear();
            RequestContextHolder.resetRequestAttributes();
        }
    }

    @Test
    void onlyCreatingUserCanListReadDownloadOrConfirmJobWithinSameTenant() throws Exception {
        var code = "A143-OWNER-" + UUID.randomUUID().toString().substring(0, 8).toUpperCase();
        var workbook = customerWorkbook(code, "创建者隔离客户");
        jobId = preview(admin, workbook);
        var otherAdmin = createAndLoginSecondAdmin();

        mockMvc.perform(get("/api/master-data/import/jobs").session(otherAdmin))
            .andExpect(status().isOk())
            .andExpect(jsonPath("$.total").value(0));
        mockMvc.perform(get("/api/master-data/import/jobs/{jobId}", jobId).session(otherAdmin))
            .andExpect(status().isNotFound());
        mockMvc.perform(get("/api/master-data/import/jobs/{jobId}/error-receipt", jobId).session(otherAdmin))
            .andExpect(status().isNotFound());
        mockMvc.perform(post("/api/master-data/import/jobs/{jobId}/confirm", jobId).session(otherAdmin))
            .andExpect(status().isNotFound());

        mockMvc.perform(get("/api/master-data/import/jobs/{jobId}", jobId).session(admin))
            .andExpect(status().isOk())
            .andExpect(jsonPath("$.rows[0].payload.code").value(code));
        mockMvc.perform(get("/api/master-data/import/jobs/{jobId}/error-receipt", jobId).session(admin))
            .andExpect(status().isOk())
            .andExpect(content().contentType(XLSX))
            .andExpect(header().string("Content-Disposition", org.hamcrest.Matchers.containsString("attachment")));
        assertThat(customerCount(code)).isZero();
    }

    @Test
    void everyImportEndpointRequiresMasterDataManageBeforeJobLookupOrFileParsing() throws Exception {
        var warehouse = login("warehouse", "warehouse123");
        var invisibleJob = UUID.randomUUID().toString();
        var invalidUpload = new MockMultipartFile(
            "file",
            "not-a-workbook.xlsx",
            XLSX,
            "not an xlsx".getBytes(java.nio.charset.StandardCharsets.UTF_8)
        );

        mockMvc.perform(get("/api/master-data/import/templates").session(warehouse))
            .andExpect(status().isForbidden());
        mockMvc.perform(get("/api/master-data/import/templates/customer").session(warehouse))
            .andExpect(status().isForbidden());
        mockMvc.perform(multipart("/api/master-data/import/jobs/customer/preview")
                .file(invalidUpload)
                .session(warehouse))
            .andExpect(status().isForbidden());
        mockMvc.perform(get("/api/master-data/import/jobs").session(warehouse))
            .andExpect(status().isForbidden());
        mockMvc.perform(get("/api/master-data/import/jobs/{jobId}", invisibleJob).session(warehouse))
            .andExpect(status().isForbidden());
        mockMvc.perform(get("/api/master-data/import/jobs/{jobId}/error-receipt", invisibleJob).session(warehouse))
            .andExpect(status().isForbidden());
        mockMvc.perform(post("/api/master-data/import/jobs/{jobId}/confirm", invisibleJob).session(warehouse))
            .andExpect(status().isForbidden());
    }

    private String preview(MockHttpSession session, byte[] workbook) throws Exception {
        var response = mockMvc.perform(multipart("/api/master-data/import/jobs/customer/preview")
                .file(new MockMultipartFile("file", "owner-customers.xlsx", XLSX, workbook))
                .session(session))
            .andExpect(status().isCreated())
            .andExpect(jsonPath("$.status").value("VALIDATED"))
            .andReturn()
            .getResponse()
            .getContentAsByteArray();
        return objectMapper.readTree(response).path("id").asText();
    }

    private MockHttpSession createAndLoginSecondAdmin() throws Exception {
        secondAdminUsername = "a143-owner-" + UUID.randomUUID().toString().substring(0, 8).toLowerCase();
        var userId = platformJdbcTemplate.queryForObject("""
            INSERT INTO sys_user (username, display_name, password_hash, enabled)
            VALUES (?, 'A143 第二管理员', '{noop}A143-Owner-Test!9', TRUE)
            RETURNING id::text
            """, String.class, secondAdminUsername);
        platformJdbcTemplate.update("""
            INSERT INTO sys_user_role (user_id, role_id)
            SELECT ?::uuid, id
            FROM sys_role
            WHERE code = 'ADMIN'
            """, userId);
        return login(secondAdminUsername, "A143-Owner-Test!9");
    }

    private int customerCount(String code) {
        bind(admin);
        return jdbcTemplate.queryForObject(
            "SELECT count(*)::int FROM md_customer WHERE code = ?",
            Integer.class,
            code
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

    private void bind(MockHttpSession session) {
        TenantContext.clear();
        var request = new MockHttpServletRequest();
        request.setSession(session);
        RequestContextHolder.setRequestAttributes(new ServletRequestAttributes(request));
        TenantContext.setTenant(currentSessionService.currentAccountSet());
    }
}
