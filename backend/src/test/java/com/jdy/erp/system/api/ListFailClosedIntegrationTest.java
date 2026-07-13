package com.jdy.erp.system.api;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatCode;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.times;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.verifyNoInteractions;
import static org.mockito.Mockito.when;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import java.util.List;
import java.util.Map;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.jdy.erp.system.application.list.ListExportColumnProvider;
import com.jdy.erp.system.application.list.ListQueryContract;
import com.jdy.erp.system.application.list.ListQueryContractRegistry;
import com.jdy.erp.system.application.list.ListQueryRequest;
import com.jdy.erp.system.application.list.ListQueryService;
import com.jdy.erp.system.application.list.ListQuerySupport;
import com.jdy.erp.system.application.list.ListSeedRowsProvider;
import com.jdy.erp.system.application.list.ListStubStateGuard;
import com.jdy.erp.system.application.list.OperationLogListQueryAdapter;
import com.jdy.erp.system.application.list.SourceSelectorListQueryAdapter;
import com.jdy.erp.system.application.list.StubListSeedRowsProvider;
import com.jdy.erp.system.security.CurrentPermissionService;
import com.jdy.erp.system.tenant.TenantDataScopeService;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.web.servlet.setup.MockMvcBuilders;
import org.springframework.web.server.ResponseStatusException;

@SpringBootTest
class ListFailClosedIntegrationTest {
    @Autowired
    private StubListSeedRowsProvider realSeedRowsProvider;

    @Test
    void unknownQueryAndExportReturn404BeforePermissionAdapterOrProvider() throws Exception {
        var listQueryService = mock(ListQueryService.class);
        var seedRowsProvider = mock(ListSeedRowsProvider.class);
        var permissionService = mock(CurrentPermissionService.class);
        var operationLogAdapter = mock(OperationLogListQueryAdapter.class);
        var controller = new ListStubController(
            listQueryService,
            seedRowsProvider,
            new ListExportColumnProvider(),
            new ListStubStateGuard(new ListQueryContractRegistry(), permissionService),
            operationLogAdapter
        );
        var mockMvc = MockMvcBuilders.standaloneSetup(controller).build();

        for (var listKey : List.of(
            "random-list",
            "random-master-list",
            "random-source-selector",
            "random-master-selector",
            "employee-master-selector-lookalike",
            "financial-account-master-selector-lookalike",
            "standard-list",
            "error-list",
            "permission-denied-list",
            "sales-detail-report",
            "sales-profit-report",
            "stock-flow-report",
            "scrap-report",
            "ar-summary-report",
            "coding-rule-list"
        )) {
            mockMvc.perform(get("/api/lists/{listKey}", listKey))
                .andExpect(status().isNotFound());
            mockMvc.perform(get("/api/lists/{listKey}/export.csv", listKey))
                .andExpect(status().isNotFound());
        }

        verifyNoInteractions(permissionService, listQueryService, seedRowsProvider, operationLogAdapter);
    }

    @Test
    void providerAndSourceSelectorRemainFailFastIfTheSharedGuardIsBypassed() {
        var jdbcTemplate = mock(JdbcTemplate.class);
        var tenantDataScopeService = mock(TenantDataScopeService.class);
        var provider = new StubListSeedRowsProvider(jdbcTemplate, tenantDataScopeService);
        assertNotFound(() -> provider.seedRows("random-list", "header", 200));

        var selector = new SourceSelectorListQueryAdapter(jdbcTemplate, tenantDataScopeService);
        var request = new ListQueryRequest(
            "random-source-selector", "", "", 1, 200, "detail", "", "asc", "",
            "", "", "", "", "", "current", "", "", false
        );
        var contract = new ListQueryContract(
            request.listKey(), "detail", List.of("billNo"), "billDate", "row", "detail", "sourceSelector", false
        );
        assertNotFound(() -> selector.query(
            request,
            contract,
            new ListQuerySupport(new ObjectMapper()),
            mock(ListSeedRowsProvider.class)
        ));

        verifyNoInteractions(jdbcTemplate, tenantDataScopeService);
    }

    @Test
    void employeeAndFinancialAccountKeysAreExactAndUseExplicitOrPermissionPolicies() {
        var registry = new ListQueryContractRegistry();
        for (var listKey : List.of(
            "employee-master-list",
            "employee-master-selector",
            "financial-account-master-list",
            "financial-account-master-selector"
        )) {
            assertThatCode(() -> registry.contractFor(listKey, "header"))
                .as(listKey)
                .doesNotThrowAnyException();
        }
        assertNotFound(() -> registry.contractFor("unknown-master-selector", "header"));
        assertNotFound(() -> registry.contractFor("employee-master-selector-copy", "header"));

        var employeePermission = mock(CurrentPermissionService.class);
        when(employeePermission.hasPermission("master.data.manage")).thenReturn(false);
        when(employeePermission.hasPermission("system.role_permission.manage")).thenReturn(true);
        var employeeGuard = new ListStubStateGuard(registry, employeePermission);
        employeeGuard.assertReadable("employee-master-list");
        employeeGuard.assertReadable("employee-master-selector");
        verify(employeePermission, times(2)).hasPermission("master.data.manage");
        verify(employeePermission, times(2)).hasPermission("system.role_permission.manage");

        var financePermission = mock(CurrentPermissionService.class);
        when(financePermission.hasPermission("master.data.manage")).thenReturn(false);
        when(financePermission.hasPermission("finance.settle")).thenReturn(true);
        var financeGuard = new ListStubStateGuard(registry, financePermission);
        financeGuard.assertReadable("financial-account-master-list");
        financeGuard.assertReadable("financial-account-master-selector");
        verify(financePermission, times(2)).hasPermission("master.data.manage");
        verify(financePermission, times(2)).hasPermission("finance.settle");

        var deniedPermission = mock(CurrentPermissionService.class);
        var deniedGuard = new ListStubStateGuard(registry, deniedPermission);
        assertForbidden(() -> deniedGuard.assertReadable("employee-master-list"));
        assertForbidden(() -> deniedGuard.assertReadable("financial-account-master-selector"));
    }

    @Test
    void employeeAndFinancialAccountSelectorsForceAuditedAndEnabledInProviderSql() {
        var jdbcTemplate = mock(JdbcTemplate.class);
        when(jdbcTemplate.queryForList(anyString())).thenReturn(List.of());
        var tenantDataScopeService = mock(TenantDataScopeService.class);
        var provider = new StubListSeedRowsProvider(jdbcTemplate, tenantDataScopeService);

        provider.seedRows("employee-master-selector", "header", 200);
        provider.seedRows("financial-account-master-selector", "header", 200);

        var sql = org.mockito.Mockito.mockingDetails(jdbcTemplate).getInvocations().stream()
            .filter(invocation -> "queryForList".equals(invocation.getMethod().getName()))
            .map(invocation -> String.valueOf((Object) invocation.getArgument(0)))
            .toList();
        assertThat(sql).hasSize(2);
        assertThat(sql.get(0))
            .contains("FROM md_employee", "WHERE enabled = TRUE AND audit_status = 'AUDITED'")
            .doesNotContain("md_product");
        assertThat(sql.get(1))
            .contains("FROM md_financial_account", "WHERE enabled = TRUE AND audit_status = 'AUDITED'")
            .doesNotContain("md_product");
        verifyNoInteractions(tenantDataScopeService);
    }

    @Test
    void stockCountHeaderProvidersUseOnlyTheirRealTablesAndFixedFields() {
        var jdbcTemplate = mock(JdbcTemplate.class);
        var tenantDataScopeService = mock(TenantDataScopeService.class);
        var stockCountRow = Map.<String, Object>ofEntries(
            Map.entry("billDate", "2026-07-13"),
            Map.entry("billNo", "PD-A139"),
            Map.entry("businessType", "盘点单"),
            Map.entry("status", "草稿"),
            Map.entry("department", "仓储部"),
            Map.entry("productCode", "A139-MAT"),
            Map.entry("productName", "A139 物料"),
            Map.entry("warehouse", "成品仓"),
            Map.entry("unit", "件"),
            Map.entry("netWeight", "1.00"),
            Map.entry("grossWeight", "1.20"),
            Map.entry("systemQty", "10"),
            Map.entry("countedQty", "11"),
            Map.entry("diffQty", "1")
        );
        var diffRow = Map.<String, Object>ofEntries(
            Map.entry("billDate", "2026-07-13"),
            Map.entry("billNo", "PY-A139"),
            Map.entry("sourceBillNo", "PD-A139"),
            Map.entry("status", "草稿"),
            Map.entry("productCode", "A139-MAT"),
            Map.entry("productName", "A139 物料"),
            Map.entry("warehouse", "成品仓"),
            Map.entry("unit", "件"),
            Map.entry("netWeight", "1.00"),
            Map.entry("grossWeight", "1.20"),
            Map.entry("qty", "1"),
            Map.entry("amount", "10.00")
        );
        when(jdbcTemplate.queryForList(anyString()))
            .thenReturn(List.of(stockCountRow), List.of(diffRow), List.of(diffRow));
        var provider = new StubListSeedRowsProvider(jdbcTemplate, tenantDataScopeService);

        var stockCount = provider.seedRows("stock-count-form-list", "header", 200).getFirst();
        var stockGain = provider.seedRows("stock-count-gain-form-list", "header", 200).getFirst();
        var stockLoss = provider.seedRows("stock-count-loss-form-list", "header", 200).getFirst();

        assertThat(stockCount.keySet()).containsExactlyInAnyOrder(
            "billDate", "billNo", "businessType", "status", "department", "productCode", "productName",
            "warehouse", "unit", "netWeight", "grossWeight", "systemQty", "countedQty", "diffQty"
        );
        assertThat(stockGain.keySet()).containsExactlyInAnyOrder(
            "billDate", "billNo", "sourceBillNo", "status", "productCode", "productName", "warehouse",
            "unit", "netWeight", "grossWeight", "qty", "amount"
        );
        assertThat(stockLoss.keySet()).containsExactlyInAnyOrderElementsOf(stockGain.keySet());

        var sql = org.mockito.Mockito.mockingDetails(jdbcTemplate).getInvocations().stream()
            .filter(invocation -> "queryForList".equals(invocation.getMethod().getName()))
            .map(invocation -> String.valueOf((Object) invocation.getArgument(0)))
            .toList();
        assertThat(sql).hasSize(3);
        assertThat(sql.get(0))
            .contains("FROM stock_count b", "line.system_qty", "line.counted_qty", "line.diff_qty")
            .doesNotContain("sales_order", "customer", "priceTaxTotal", "outStatus");
        assertThat(sql.get(1))
            .contains("FROM stock_count_gain b", "FROM stock_count_gain_line candidate", "source.bill_no")
            .doesNotContain("sales_order", "customer", "priceTaxTotal", "outStatus");
        assertThat(sql.get(2))
            .contains("FROM stock_count_loss b", "FROM stock_count_loss_line candidate", "source.bill_no")
            .doesNotContain("sales_order", "customer", "priceTaxTotal", "outStatus");
        verifyNoInteractions(tenantDataScopeService);
    }

    @Test
    void stockCountHeaderSqlExecutesAgainstTheConfiguredDataSchema() {
        for (var listKey : List.of(
            "stock-count-form-list",
            "stock-count-gain-form-list",
            "stock-count-loss-form-list"
        )) {
            assertThatCode(() -> realSeedRowsProvider.seedRows(listKey, "header", 200))
                .as(listKey)
                .doesNotThrowAnyException();
        }
    }

    private void assertNotFound(Runnable action) {
        assertThatThrownBy(action::run)
            .isInstanceOfSatisfying(ResponseStatusException.class, error ->
                assertThat(error.getStatusCode()).isEqualTo(HttpStatus.NOT_FOUND));
    }

    private void assertForbidden(Runnable action) {
        assertThatThrownBy(action::run)
            .isInstanceOfSatisfying(ResponseStatusException.class, error ->
                assertThat(error.getStatusCode()).isEqualTo(HttpStatus.FORBIDDEN));
    }
}
