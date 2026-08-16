package com.jdy.erp.masterdata.api;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.patch;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import java.math.BigDecimal;
import java.util.List;
import java.util.Map;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.NullNode;
import com.jdy.erp.inventory.application.OtherStockInAppService;
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
    private OtherStockInAppService otherStockInAppService;

    @Autowired
    private MockMvc mockMvc;

    @Test
    void productStoresAuditedEnabledMasterReferencesAndProtectsReferencedMasters() {
        var code = "CP-REF-" + System.nanoTime();

        controller.create("productName", Map.of("code", code, "name", code));
        controller.audit("productName", code);
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
    void referencedSupplierCanBeDisabledButCannotBeReverseAuditedAndSelectorTracksEnabledState() {
        var suffix = Long.toUnsignedString(System.nanoTime(), 36).toUpperCase();
        var supplierCode = "GYS-A186-" + suffix;
        var purchaseOrderNo = "CGDD-A186-" + suffix;

        controller.create("supplier", Map.of("code", supplierCode, "name", "A186 引用供应商"));
        controller.audit("supplier", supplierCode);
        jdbcTemplate.update("""
            INSERT INTO purchase_order (bill_no, supplier_id, bill_date, status)
            SELECT ?, id, CURRENT_DATE, 'DRAFT'
            FROM md_supplier
            WHERE code = ?
            """, purchaseOrderNo, supplierCode);

        var disabled = controller.updateStatus("supplier", supplierCode, Map.of("status", "禁用"));
        assertThat(disabled).containsEntry("status", "禁用").containsEntry("auditStatus", "已审核");
        assertThat(jdbcTemplate.queryForObject("""
            SELECT count(*)::int
            FROM purchase_order purchase
            JOIN md_supplier supplier ON supplier.id = purchase.supplier_id
            WHERE purchase.bill_no = ? AND supplier.code = ?
            """, Integer.class, purchaseOrderNo, supplierCode)).isOne();
        assertThat(listRowsProvider.seedRows("supplier-master-selector", "header", 200))
            .extracting(row -> String.valueOf(row.get("code")))
            .doesNotContain(supplierCode);
        assertThat(listRowsProvider.seedRows("supplier-master-list", "header", 200))
            .filteredOn(row -> supplierCode.equals(String.valueOf(row.get("code"))))
            .singleElement()
            .extracting(row -> String.valueOf(row.get("status")))
            .isEqualTo("禁用");

        assertThatThrownBy(() -> controller.reverseAudit("supplier", supplierCode))
            .isInstanceOf(ResponseStatusException.class)
            .extracting(ex -> ((ResponseStatusException) ex).getStatusCode())
            .isEqualTo(HttpStatus.CONFLICT);
        assertThat(jdbcTemplate.queryForObject(
            "SELECT audit_status FROM md_supplier WHERE code = ?",
            String.class,
            supplierCode
        )).isEqualTo("AUDITED");

        controller.updateStatus("supplier", supplierCode, Map.of("status", "启用"));
        assertThat(listRowsProvider.seedRows("supplier-master-selector", "header", 200))
            .extracting(row -> String.valueOf(row.get("code")))
            .contains(supplierCode);
    }

    @Test
    void productWithBomReferenceCannotBeReverseAudited() {
        var suffix = Long.toUnsignedString(System.nanoTime(), 36).toUpperCase();
        var productCode = "CP-A186-BOM-" + suffix;
        var productNameCode = "PN-A186-BOM-" + suffix;
        var bomCode = "BOM-A186-" + suffix;
        controller.create("productName", Map.of("code", productNameCode, "name", "A186 BOM 物料"));
        controller.audit("productName", productNameCode);
        controller.create("product", Map.of(
            "code", productCode,
            "name", "A186 BOM 物料",
            "category", "成品总成",
            "unit", "只",
            "isInventory", "true",
            "isProduce", "true"
        ));
        controller.audit("product", productCode);
        jdbcTemplate.update("""
            INSERT INTO prod_bom (code, product_id, qty, enabled, audit_status, bom_category, is_current)
            SELECT ?, id, 1, TRUE, 'AUDITED', '自制BOM', TRUE
            FROM md_product
            WHERE code = ?
            """, bomCode, productCode);

        assertThatThrownBy(() -> controller.reverseAudit("product", productCode))
            .isInstanceOf(ResponseStatusException.class)
            .hasMessageContaining("BOM")
            .extracting(ex -> ((ResponseStatusException) ex).getStatusCode())
            .isEqualTo(HttpStatus.CONFLICT);
        assertThat(jdbcTemplate.queryForObject(
            "SELECT audit_status FROM md_product WHERE code = ?",
            String.class,
            productCode
        )).isEqualTo("AUDITED");
    }

    @Test
    void disabledSupplierCannotBeSubmittedByTypingItsCodeIntoOtherStockIn() {
        var suffix = Long.toUnsignedString(System.nanoTime(), 36).toUpperCase();
        var supplierCode = "GYS-A186-DIS-" + suffix;
        controller.create("supplier", Map.of("code", supplierCode, "name", "A186 禁用候选供应商"));
        controller.audit("supplier", supplierCode);
        controller.updateStatus("supplier", supplierCode, Map.of("status", "禁用"));

        assertThatThrownBy(() -> otherStockInAppService.saveDraft(new OtherStockInAppService.OtherStockInDraftRequest(
            null,
            supplierCode,
            "2026-08-16",
            "仓储部",
            "A186",
            List.of(new OtherStockInAppService.OtherStockInLineRequest(
                null,
                "CP-001",
                "CK-001",
                null,
                BigDecimal.ONE,
                BigDecimal.ONE,
                "A186 disabled supplier guard"
            ))
        )))
            .isInstanceOf(ResponseStatusException.class)
            .hasMessageContaining("未审核或已禁用")
            .extracting(ex -> ((ResponseStatusException) ex).getStatusCode())
            .isEqualTo(HttpStatus.BAD_REQUEST);
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
    void sparsePatchMasterRoutesReturnMethodNotAllowedBeforeReadingLegacyFields() {
        for (var type : new String[] {"product", "customer", "supplier", "warehouse", "unit", "productionDepartment"}) {
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
        assertThatThrownBy(() -> controller.audit("customer", code))
            .isInstanceOf(ResponseStatusException.class)
            .extracting(ex -> ((ResponseStatusException) ex).getStatusCode())
            .isEqualTo(HttpStatus.CONFLICT);
        assertThat(jdbcTemplate.queryForObject(
            "SELECT version FROM md_customer WHERE code = ?",
            Long.class,
            code
        )).isEqualTo(before + 2);

        var reverseResult = controller.reverseAudit("customer", code);
        assertThat(reverseResult).containsEntry("version", before + 3);
        assertThatThrownBy(() -> controller.reverseAudit("customer", code))
            .isInstanceOf(ResponseStatusException.class)
            .extracting(ex -> ((ResponseStatusException) ex).getStatusCode())
            .isEqualTo(HttpStatus.CONFLICT);
        assertThat(jdbcTemplate.queryForObject(
            "SELECT version FROM md_customer WHERE code = ?",
            Long.class,
            code
        )).isEqualTo(before + 3);

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
        var adminSession = login("admin", "admin123");
        mockMvc.perform(post("/api/master-data/customer")
                .session(adminSession)
                .contentType(MediaType.APPLICATION_JSON)
                .content("{\"code\":\"" + code + "\",\"name\":\"A138 HTTP 客户\"}"))
            .andExpect(status().isCreated());
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

        mockMvc.perform(patch("/api/master-data/customer/{code}", code)
                .session(adminSession)
                .contentType(MediaType.APPLICATION_JSON)
                .content("{\"version\":" + version + ",\"changes\":{\"remark\":\"有权写入\"}}"))
            .andExpect(status().isOk())
            .andExpect(jsonPath("$.version").value(version + 1))
            .andExpect(jsonPath("$.remark").value("有权写入"));

        mockMvc.perform(patch("/api/master-data/customer/{code}/status", code)
                .session(adminSession)
                .contentType(MediaType.APPLICATION_JSON)
                .content("{\"status\":\"禁用\"}"))
            .andExpect(status().isOk());
        mockMvc.perform(post("/api/master-data/customer/{code}/audit", code).session(adminSession))
            .andExpect(status().isOk());
        mockMvc.perform(post("/api/master-data/customer/{code}/reverse", code).session(adminSession))
            .andExpect(status().isOk());

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

        var lifecycleLogs = jdbcTemplate.queryForList("""
            SELECT action_code, actor_username, account_set_code
            FROM sys_operation_log
            WHERE target_no = ?
              AND action_code IN ('CREATE_MASTER_DATA', 'DISABLE_MASTER_DATA', 'AUDIT_MASTER_DATA', 'REVERSE_MASTER_DATA')
            """, code);
        assertThat(lifecycleLogs)
            .extracting(row -> String.valueOf(row.get("action_code")))
            .containsExactlyInAnyOrder(
                "CREATE_MASTER_DATA",
                "DISABLE_MASTER_DATA",
                "AUDIT_MASTER_DATA",
                "REVERSE_MASTER_DATA"
            );
        assertThat(lifecycleLogs).allSatisfy(row -> assertThat(row)
            .containsEntry("actor_username", "admin")
            .containsEntry("account_set_code", "BLD-TEST"));
        var createAfterState = jdbcTemplate.queryForObject("""
            SELECT after_state::text
            FROM sys_operation_log
            WHERE action_code = 'CREATE_MASTER_DATA' AND target_no = ?
            ORDER BY operated_at DESC
            LIMIT 1
            """, String.class, code);
        assertThat(createAfterState).contains("auditStatus", "DRAFT", "enabled", "true");
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
