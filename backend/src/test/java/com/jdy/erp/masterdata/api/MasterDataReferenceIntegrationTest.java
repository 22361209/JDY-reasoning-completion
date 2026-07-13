package com.jdy.erp.masterdata.api;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.patch;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import java.util.Map;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.NullNode;
import com.jdy.erp.system.application.list.StubListSeedRowsProvider;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.mock.web.MockHttpSession;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.server.ResponseStatusException;

@SpringBootTest
@AutoConfigureMockMvc
@Transactional
class MasterDataReferenceIntegrationTest {
    @Autowired
    private MasterDataController controller;

    @Autowired
    private JdbcTemplate jdbcTemplate;

    @Autowired
    private ObjectMapper objectMapper;

    @Autowired
    private StubListSeedRowsProvider listRowsProvider;

    @Autowired
    private MockMvc mockMvc;

    @Test
    void productStoresAuditedEnabledMasterReferencesAndProtectsReferencedMasters() {
        var code = "CP-REF-" + System.nanoTime();

        controller.create("product", Map.ofEntries(
            Map.entry("code", code),
            Map.entry("name", code),
            Map.entry("category", "成品总成"),
            Map.entry("unit", "只"),
            Map.entry("defaultWarehouseCode", "CK-001"),
            Map.entry("defaultSupplierCode", "GYS-001"),
            Map.entry("defaultWorkshop", "CY"),
            Map.entry("isSale", "true"),
            Map.entry("isInventory", "true"),
            Map.entry("isProduce", "true")
        ));

        var row = jdbcTemplate.queryForMap("""
            SELECT category.name AS category_name,
                   unit_ref.code AS unit_code,
                   warehouse.code AS warehouse_code,
                   supplier.code AS supplier_code,
                   department.name AS workshop_name
            FROM md_product product
            JOIN md_product_category category ON category.id = product.product_category_id
            JOIN md_unit unit_ref ON unit_ref.id = product.unit_id
            LEFT JOIN md_warehouse warehouse ON warehouse.id = product.default_warehouse_id
            LEFT JOIN md_supplier supplier ON supplier.id = product.default_supplier_id
            LEFT JOIN md_production_department department ON department.id = product.default_workshop_id
            WHERE product.code = ?
            """, code);

        assertThat(row)
            .containsEntry("category_name", "成品总成")
            .containsEntry("unit_code", "只")
            .containsEntry("warehouse_code", "CK-001")
            .containsEntry("supplier_code", "GYS-001")
            .containsEntry("workshop_name", "冲压车间");

        controller.audit("product", code);

        assertThatThrownBy(() -> controller.updateStatus("unit", "只", Map.of("status", "禁用")))
            .isInstanceOf(ResponseStatusException.class)
            .extracting(ex -> ((ResponseStatusException) ex).getStatusCode())
            .isEqualTo(HttpStatus.CONFLICT);
        assertThatThrownBy(() -> controller.reverseAudit("unit", "只"))
            .isInstanceOf(ResponseStatusException.class)
            .extracting(ex -> ((ResponseStatusException) ex).getStatusCode())
            .isEqualTo(HttpStatus.CONFLICT);
    }

    @Test
    void productRejectsMissingOrInactiveMasterReferencesBeforeInsert() {
        var code = "CP-BAD-REF-" + System.nanoTime();

        assertThatThrownBy(() -> controller.create("product", Map.of(
            "code", code,
            "name", code,
            "category", "不存在的类别",
            "unit", "只"
        )))
            .isInstanceOf(ResponseStatusException.class)
            .extracting(ex -> ((ResponseStatusException) ex).getStatusCode())
            .isEqualTo(HttpStatus.BAD_REQUEST);
    }

    @Test
    void fourLegacyPutRoutesReturnMethodNotAllowedBeforeReadingLegacyFields() {
        for (var type : new String[] {"product", "customer", "supplier", "warehouse"}) {
            assertThatThrownBy(() -> controller.update(type, "A138-NO-NAME", NullNode.getInstance()))
                .isInstanceOf(ResponseStatusException.class)
                .extracting(ex -> ((ResponseStatusException) ex).getStatusCode())
                .isEqualTo(HttpStatus.METHOD_NOT_ALLOWED);
        }
    }

    @Test
    void patchBoundaryRejectsUnknownOuterKeysInvalidVersionAndEmptyChanges() throws Exception {
        assertThatThrownBy(() -> controller.patch(
            "customer",
            "KH-001",
            objectMapper.readTree("{\"version\":0,\"changes\":{\"remark\":\"x\"},\"extra\":true}")
        ))
            .isInstanceOf(ResponseStatusException.class)
            .extracting(ex -> ((ResponseStatusException) ex).getStatusCode())
            .isEqualTo(HttpStatus.BAD_REQUEST);
        assertThatThrownBy(() -> controller.patch(
            "customer",
            "KH-001",
            objectMapper.readTree("{\"version\":\"0\",\"changes\":{\"remark\":\"x\"}}")
        ))
            .isInstanceOf(ResponseStatusException.class)
            .extracting(ex -> ((ResponseStatusException) ex).getStatusCode())
            .isEqualTo(HttpStatus.BAD_REQUEST);
        assertThatThrownBy(() -> controller.patch(
            "customer",
            "KH-001",
            objectMapper.readTree("{\"version\":0,\"changes\":{}}")
        ))
            .isInstanceOf(ResponseStatusException.class)
            .extracting(ex -> ((ResponseStatusException) ex).getStatusCode())
            .isEqualTo(HttpStatus.BAD_REQUEST);

        for (var invalidBody : new String[] {
            "{\"changes\":{\"remark\":\"x\"}}",
            "{\"version\":-1,\"changes\":{\"remark\":\"x\"}}",
            "{\"version\":1.5,\"changes\":{\"remark\":\"x\"}}",
            "{\"version\":0}",
            "{\"version\":0,\"changes\":null}"
        }) {
            assertThatThrownBy(() -> controller.patch(
                "customer",
                "KH-001",
                objectMapper.readTree(invalidBody)
            ))
                .isInstanceOf(ResponseStatusException.class)
                .extracting(ex -> ((ResponseStatusException) ex).getStatusCode())
                .isEqualTo(HttpStatus.BAD_REQUEST);
        }

        assertThatThrownBy(() -> controller.patch(
            "unknownType",
            "UNKNOWN",
            objectMapper.readTree("{\"version\":0,\"changes\":{\"remark\":\"x\"}}")
        ))
            .isInstanceOf(ResponseStatusException.class)
            .extracting(ex -> ((ResponseStatusException) ex).getStatusCode())
            .isEqualTo(HttpStatus.NOT_FOUND);
    }

    @Test
    void lifecycleResponsesAndFourMasterListsCarryCurrentVersion() {
        var code = "KH-A138-V-" + Long.toUnsignedString(System.nanoTime(), 36).toUpperCase();
        controller.create("customer", Map.of("code", code, "name", "A138 版本客户"));
        var before = jdbcTemplate.queryForObject(
            "SELECT version FROM md_customer WHERE code = ?",
            Long.class,
            code
        );
        var statusResult = controller.updateStatus("customer", code, Map.of("status", "禁用"));
        assertThat(statusResult)
            .containsEntry("status", "禁用")
            .containsEntry("version", before + 1);
        var auditResult = controller.audit("customer", code);
        assertThat(auditResult)
            .containsEntry("status", "禁用")
            .containsEntry("version", before + 2);

        for (var listKey : new String[] {
            "product-master-list",
            "customer-master-list",
            "supplier-master-list",
            "warehouse-master-list"
        }) {
            var rows = listRowsProvider.seedRows(listKey, "header", 100);
            assertThat(rows).isNotEmpty().allSatisfy(row -> assertThat(row.get("version")).isInstanceOf(Number.class));
        }
    }

    @Test
    void realMvcEnforcesPermissionAndWritesSanitizedSuccessLog() throws Exception {
        var code = "KH-A138-HTTP-" + Long.toUnsignedString(System.nanoTime(), 36).toUpperCase();
        controller.create("customer", Map.of("code", code, "name", "A138 HTTP 客户"));
        var version = jdbcTemplate.queryForObject(
            "SELECT version FROM md_customer WHERE code = ?",
            Long.class,
            code
        );

        var warehouseSession = login("warehouse", "warehouse123");
        mockMvc.perform(patch("/api/master-data/customer/{code}", code)
                .session(warehouseSession)
                .contentType(MediaType.APPLICATION_JSON)
                .content("{\"version\":" + version + ",\"changes\":{\"remark\":\"无权写入\"}}"))
            .andExpect(status().isForbidden());
        assertThat(jdbcTemplate.queryForObject(
            "SELECT remark FROM md_customer WHERE code = ?",
            String.class,
            code
        )).isNull();

        var adminSession = login("admin", "admin123");
        mockMvc.perform(patch("/api/master-data/customer/{code}", code)
                .session(adminSession)
                .contentType(MediaType.APPLICATION_JSON)
                .content("{\"version\":" + version + ",\"changes\":{\"remark\":\"有权写入\"}}"))
            .andExpect(status().isOk())
            .andExpect(jsonPath("$.version").value(version + 1))
            .andExpect(jsonPath("$.remark").value("有权写入"));

        var log = jdbcTemplate.queryForMap("""
            SELECT failure_reason AS reason, before_state::text AS before_state, after_state::text AS after_state
            FROM sys_operation_log
            WHERE action_code = 'PATCH_MASTER_DATA'
              AND target_no = ?
            ORDER BY operated_at DESC
            LIMIT 1
            """, code);
        assertThat(String.valueOf(log.get("reason")))
            .contains("fields=remark")
            .contains("version=" + version + "->" + (version + 1))
            .doesNotContain("有权写入");
        assertThat(String.valueOf(log.get("before_state"))).contains("auditStatus", "enabled");
        assertThat(String.valueOf(log.get("after_state"))).contains("auditStatus", "enabled");
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
