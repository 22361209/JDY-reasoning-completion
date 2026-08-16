package com.jdy.erp.system.api;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatCode;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.doThrow;
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
            "warehouse-master-selector",
            "supplier-master-selector",
            "financial-account-master-list",
            "financial-account-master-selector"
        )) {
            assertThatCode(() -> registry.contractFor(listKey, "header"))
                .as(listKey)
                .doesNotThrowAnyException();
        }
        assertNotFound(() -> registry.contractFor("unknown-master-selector", "header"));
        assertNotFound(() -> registry.contractFor("employee-master-selector-copy", "header"));
        assertThat(registry.contractFor("supplier-master-selector", "header").keywordFields())
            .containsExactly("code", "name");

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

        for (var permissionCode : List.of(
            "master.data.manage",
            "purchase.order.audit",
            "purchase.in.audit",
            "purchase.return.audit",
            "inventory.other_stock_in.audit"
        )) {
            var allowedPermission = mock(CurrentPermissionService.class);
            when(allowedPermission.hasPermission(permissionCode)).thenReturn(true);
            assertThatCode(() -> new ListStubStateGuard(registry, allowedPermission)
                .assertReadable("supplier-master-selector"))
                .as(permissionCode)
                .doesNotThrowAnyException();
        }

        for (var unrelatedPermissionCode : List.of(
            "inventory.stock_count.audit",
            "inventory.stock_count_gain.audit",
            "inventory.stock_count_loss.audit",
            "inventory.stock.view"
        )) {
            var unrelatedPermission = mock(CurrentPermissionService.class);
            when(unrelatedPermission.hasPermission(unrelatedPermissionCode)).thenReturn(true);
            assertForbidden(() -> new ListStubStateGuard(registry, unrelatedPermission)
                .assertReadable("supplier-master-selector"));
        }

        var supplierMasterPermission = mock(CurrentPermissionService.class);
        when(supplierMasterPermission.hasPermission("purchase.order.audit")).thenReturn(true);
        doThrow(new ResponseStatusException(HttpStatus.FORBIDDEN, "Missing permission: master.data.manage"))
            .when(supplierMasterPermission).requirePermission("master.data.manage");
        var supplierMasterGuard = new ListStubStateGuard(registry, supplierMasterPermission);
        supplierMasterGuard.assertReadable("supplier-master-selector");
        assertForbidden(() -> supplierMasterGuard.assertReadable("supplier-master-list"));
        verify(supplierMasterPermission).requirePermission("master.data.manage");

        var deniedPermission = mock(CurrentPermissionService.class);
        var deniedGuard = new ListStubStateGuard(registry, deniedPermission);
        assertForbidden(() -> deniedGuard.assertReadable("employee-master-list"));
        assertForbidden(() -> deniedGuard.assertReadable("supplier-master-selector"));
        assertForbidden(() -> deniedGuard.assertReadable("financial-account-master-selector"));
    }

    @Test
    void warehouseEmployeeAndFinancialAccountSelectorsForceAuditedAndEnabledInProviderSql() {
        var jdbcTemplate = mock(JdbcTemplate.class);
        when(jdbcTemplate.queryForList(anyString())).thenAnswer(invocation -> {
            var sql = String.valueOf((Object) invocation.getArgument(0));
            if (sql.contains("FROM md_supplier")) {
                return List.of(Map.of(
                    "id", "00000000-0000-0000-0000-000000000186",
                    "code", "A186-SUPPLIER",
                    "name", "A186 供应商",
                    "status", "启用",
                    "auditStatus", "已审核"
                ));
            }
            return List.of();
        });
        var tenantDataScopeService = mock(TenantDataScopeService.class);
        var provider = new StubListSeedRowsProvider(jdbcTemplate, tenantDataScopeService);

        provider.seedRows("warehouse-master-selector", "header", 200);
        provider.seedRows("supplier-master-selector", "header", 200);
        provider.seedRows("employee-master-selector", "header", 200);
        provider.seedRows("financial-account-master-selector", "header", 200);

        var sql = org.mockito.Mockito.mockingDetails(jdbcTemplate).getInvocations().stream()
            .filter(invocation -> "queryForList".equals(invocation.getMethod().getName()))
            .map(invocation -> String.valueOf((Object) invocation.getArgument(0)))
            .toList();
        assertThat(sql).hasSize(4);
        assertThat(sql.get(0))
            .contains("FROM md_warehouse", "WHERE enabled = TRUE AND audit_status = 'AUDITED'")
            .doesNotContain("md_product");
        assertThat(sql.get(1))
            .contains("FROM md_supplier", "WHERE enabled = TRUE", "audit_status = 'AUDITED'")
            .doesNotContain("bank_account", "tax_no", "address", "remark", "version");
        assertThat(provider.seedRows("supplier-master-selector", "header", 200))
            .hasSize(1)
            .allSatisfy(row -> assertThat(row.keySet())
                .containsExactlyInAnyOrder("id", "code", "name", "status", "auditStatus"));
        assertThat(sql.get(2))
            .contains("FROM md_employee", "WHERE enabled = TRUE AND audit_status = 'AUDITED'")
            .doesNotContain("md_product");
        assertThat(sql.get(3))
            .contains("FROM md_financial_account", "WHERE enabled = TRUE AND audit_status = 'AUDITED'")
            .doesNotContain("md_product");
        verifyNoInteractions(tenantDataScopeService);
    }

    @Test
    void formalSettlementListsAndSelectorsUseExactKeysAndFinancePermissionMatrix() {
        var registry = new ListQueryContractRegistry();
        var listKeys = List.of("ar-receipt-form-list", "ap-payment-form-list");
        var selectorKeys = List.of(
            "ar-receivable-settlement-source-selector",
            "ap-payable-settlement-source-selector"
        );
        for (var listKey : listKeys) {
            assertThatCode(() -> registry.contractFor(listKey, "header"))
                .as(listKey)
                .doesNotThrowAnyException();
        }
        for (var listKey : selectorKeys) {
            assertThat(registry.contractFor(listKey, "header").adapterKey()).isEqualTo("sourceSelector");
        }
        assertNotFound(() -> registry.contractFor("ar-receipt-list", "header"));
        assertNotFound(() -> registry.contractFor("ap-payment-source-selector", "header"));

        var reportPermission = mock(CurrentPermissionService.class);
        when(reportPermission.hasPermission("finance.report.view")).thenReturn(true);
        var reportGuard = new ListStubStateGuard(registry, reportPermission);
        listKeys.forEach(reportGuard::assertReadable);
        selectorKeys.forEach(key -> assertForbidden(() -> reportGuard.assertReadable(key)));
        assertForbidden(() -> reportGuard.assertReadable("financial-account-settlement-selector"));

        var masterPermission = mock(CurrentPermissionService.class);
        when(masterPermission.hasPermission("master.data.manage")).thenReturn(true);
        var masterGuard = new ListStubStateGuard(registry, masterPermission);
        masterGuard.assertReadable("financial-account-master-selector");
        assertForbidden(() -> masterGuard.assertReadable("financial-account-settlement-selector"));

        var cashTransferPermission = mock(CurrentPermissionService.class);
        when(cashTransferPermission.hasPermission("finance.cash_transfer.audit")).thenReturn(true);
        var cashTransferGuard = new ListStubStateGuard(registry, cashTransferPermission);
        cashTransferGuard.assertReadable("financial-account-settlement-selector");
        assertForbidden(() -> cashTransferGuard.assertReadable("financial-account-master-list"));
        assertForbidden(() -> cashTransferGuard.assertReadable("financial-account-master-selector"));
        listKeys.forEach(key -> assertForbidden(() -> cashTransferGuard.assertReadable(key)));
        selectorKeys.forEach(key -> assertForbidden(() -> cashTransferGuard.assertReadable(key)));

        var settlePermission = mock(CurrentPermissionService.class);
        when(settlePermission.hasPermission("finance.settle")).thenReturn(true);
        var settleGuard = new ListStubStateGuard(registry, settlePermission);
        listKeys.forEach(settleGuard::assertReadable);
        selectorKeys.forEach(settleGuard::assertReadable);
        settleGuard.assertReadable("financial-account-settlement-selector");

        assertThat(registry.contractFor("financial-account-settlement-selector", "detail").keywordFields())
            .contains("currency", "bankName")
            .doesNotContain("accountNo", "accountHolder");
    }

    @Test
    void formalSettlementSourceSelectorsArePositiveSameCurrencyRealFinanceQueries() {
        var jdbcTemplate = mock(JdbcTemplate.class);
        when(jdbcTemplate.queryForObject(anyString(), org.mockito.ArgumentMatchers.eq(Long.class), org.mockito.ArgumentMatchers.any(Object[].class)))
            .thenReturn(0L);
        when(jdbcTemplate.queryForList(anyString(), org.mockito.ArgumentMatchers.any(Object[].class))).thenReturn(List.of());
        var tenantDataScopeService = mock(TenantDataScopeService.class);
        var selector = new SourceSelectorListQueryAdapter(jdbcTemplate, tenantDataScopeService);
        var registry = new ListQueryContractRegistry();
        var support = new ListQuerySupport(new ObjectMapper());

        for (var listKey : List.of(
            "ar-receivable-settlement-source-selector",
            "ap-payable-settlement-source-selector"
        )) {
            var request = new ListQueryRequest(
                listKey,
                "A141",
                "",
                1,
                200,
                "detail",
                "billDate",
                "desc",
                "{\"currency\":{\"operator\":\"等于\",\"value\":\"USD\"},\"partyId\":{\"operator\":\"等于\",\"value\":\"00000000-0000-0000-0000-000000000141\"}}",
                "",
                "",
                "",
                "",
                "",
                "current",
                "",
                "",
                false
            );
            assertThat(selector.query(request, registry.contractFor(listKey, "detail"), support, mock(ListSeedRowsProvider.class)).rows())
                .isEmpty();
        }

        var sql = org.mockito.Mockito.mockingDetails(jdbcTemplate).getInvocations().stream()
            .filter(invocation -> List.of("queryForObject", "queryForList").contains(invocation.getMethod().getName()))
            .map(invocation -> String.valueOf((Object) invocation.getArgument(0)))
            .toList();
        assertThat(sql).hasSize(4);
        assertThat(String.join("\n", sql))
            .contains("FROM ar_receivable ar", "FROM ap_payable ap")
            .contains("amount > 0", "unsettledAmount", "source.\"currency\"", "source.\"partyId\"")
            .doesNotContain("md_product", "sales_order_line");
        verifyNoInteractions(tenantDataScopeService);
    }

    @Test
    void formalSettlementListProvidersReadTheirRealHeadersAndExposeCurrency() {
        var jdbcTemplate = mock(JdbcTemplate.class);
        when(jdbcTemplate.queryForList(anyString())).thenReturn(List.of());
        var tenantDataScopeService = mock(TenantDataScopeService.class);
        var provider = new StubListSeedRowsProvider(jdbcTemplate, tenantDataScopeService);

        provider.seedRows("ar-receipt-form-list", "header", 200);
        provider.seedRows("ap-payment-form-list", "header", 200);
        provider.seedRows("ar-receivable-list", "header", 200);
        provider.seedRows("ap-payable-list", "header", 200);
        provider.seedRows("financial-account-settlement-selector", "detail", 200);

        var sql = org.mockito.Mockito.mockingDetails(jdbcTemplate).getInvocations().stream()
            .filter(invocation -> "queryForList".equals(invocation.getMethod().getName()))
            .map(invocation -> String.valueOf((Object) invocation.getArgument(0)))
            .toList();
        assertThat(sql).hasSize(5);
        assertThat(sql.get(0)).contains(
            "FROM ar_receipt h",
            "h.currency",
            "h.amount::text AS amount",
            "h.version::text AS version",
            "h.legacy_imported"
        );
        assertThat(sql.get(1)).contains(
            "FROM ap_payment h",
            "h.currency",
            "h.amount::text AS amount",
            "h.version::text AS version",
            "h.legacy_imported"
        );
        assertThat(sql.get(2)).contains("FROM ar_receivable ar", "ar.currency");
        assertThat(sql.get(3)).contains("FROM ap_payable ap", "ap.currency");
        assertThat(sql.get(4))
            .contains("FROM md_financial_account", "enabled = TRUE", "audit_status = 'AUDITED'")
            .doesNotContain("account_no", "account_holder");
        verifyNoInteractions(tenantDataScopeService);
    }

    @Test
    void formalSettlementHeaderSqlExecutesAgainstTheConfiguredDataSchema() {
        for (var listKey : List.of("ar-receipt-form-list", "ap-payment-form-list")) {
            assertThatCode(() -> realSeedRowsProvider.seedRows(listKey, "header", 200))
                .as(listKey)
                .doesNotThrowAnyException();
        }
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
