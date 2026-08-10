package com.jdy.erp.system.api;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.Mockito.doNothing;
import static org.mockito.Mockito.doThrow;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.times;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.verifyNoInteractions;
import static org.mockito.Mockito.when;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.eq;
import org.mockito.ArgumentCaptor;

import java.util.List;
import java.util.Map;

import com.jdy.erp.system.application.list.ListExportColumnProvider;
import com.jdy.erp.system.application.list.ListQueryContractRegistry;
import com.jdy.erp.system.application.list.ListQueryService;
import com.jdy.erp.system.application.list.ListQueryResult;
import com.jdy.erp.system.application.list.ListQueryRequest;
import com.jdy.erp.system.application.list.ListSeedRowsProvider;
import com.jdy.erp.system.application.list.ListStubStateGuard;
import com.jdy.erp.system.application.list.OperationLogListQueryAdapter;
import com.jdy.erp.system.security.CurrentPermissionService;
import org.junit.jupiter.api.Test;
import org.springframework.http.HttpStatus;
import org.springframework.web.server.ResponseStatusException;

class ListStubControllerTest {
    private final ListQueryService listQueryService = mock(ListQueryService.class);
    private final ListSeedRowsProvider seedRowsProvider = mock(ListSeedRowsProvider.class);
    private final CurrentPermissionService currentPermissionService = mock(CurrentPermissionService.class);
    private final OperationLogListQueryAdapter operationLogListQueryAdapter = mock(OperationLogListQueryAdapter.class);
    private final ListStubController controller = new ListStubController(
        listQueryService,
        seedRowsProvider,
        new ListExportColumnProvider(),
        new ListStubStateGuard(new ListQueryContractRegistry(), currentPermissionService),
        operationLogListQueryAdapter
    );

    @Test
    void rowsAndExportRejectUnknownKeysBeforePermissionsOrQueries() {
        for (var listKey : List.of(
            "random-list",
            "random-master-list",
            "random-source-selector",
            "standard-list",
            "error-list",
            "permission-denied-list"
        )) {
            assertNotFound(() -> controller.rows(
                listKey,
                "",
                "",
                1,
                200,
                "header",
                "",
                "asc",
                "",
                "",
                "",
                "",
                "",
                "",
                "current",
                "",
                ""
            ));

            assertNotFound(() -> controller.exportCsv(
                listKey,
                "",
                "",
                1000,
                "header",
                "",
                "asc",
                "",
                "",
                "",
                "",
                "",
                "",
                "current",
                "",
                ""
            ));
        }

        verifyNoInteractions(currentPermissionService, listQueryService, seedRowsProvider);
    }

    @Test
    void realListPermissionsCoverPublicKeysAndEquivalentAliases() {
        var guard = new ListStubStateGuard(new ListQueryContractRegistry(), currentPermissionService);

        List.of(
            "purchase-summary-report",
            "task-track-report",
            "production-task-list",
            "production-task-form-list",
            "stock-count-list",
            "stock-count-form-list",
            "stock-count-gain-list",
            "stock-count-gain-form-list",
            "stock-count-loss-list",
            "stock-count-loss-form-list",
            "sales-return-form-list",
            "sales-out-return-source-selector"
        ).forEach(guard::assertReadable);

        verify(currentPermissionService).requirePermission("purchase.order.audit");
        verify(currentPermissionService, times(3)).requirePermission("production.task.audit");
        verify(currentPermissionService, times(2)).requirePermission("inventory.stock_count.audit");
        verify(currentPermissionService, times(2)).requirePermission("inventory.stock_count_gain.audit");
        verify(currentPermissionService, times(2)).requirePermission("inventory.stock_count_loss.audit");
        verify(currentPermissionService, times(2)).requirePermission("sales.out.audit");
    }

    @Test
    void salesReturnListAndSelectorCannotBypassSalesOutPermission() {
        var guard = new ListStubStateGuard(new ListQueryContractRegistry(), currentPermissionService);
        doThrow(new ResponseStatusException(HttpStatus.FORBIDDEN, "Missing permission"))
            .when(currentPermissionService).requirePermission("sales.out.audit");

        assertForbidden(() -> guard.assertReadable("sales-return-form-list"));
        assertForbidden(() -> guard.assertReadable("sales-out-return-source-selector"));
    }

    @Test
    void stockCountAliasesCannotBypassTheFormListPermission() {
        var guard = new ListStubStateGuard(new ListQueryContractRegistry(), currentPermissionService);
        doThrow(new ResponseStatusException(HttpStatus.FORBIDDEN, "Missing permission"))
            .when(currentPermissionService).requirePermission("inventory.stock_count.audit");

        assertForbidden(() -> guard.assertReadable("stock-count-form-list"));
        assertForbidden(() -> guard.assertReadable("stock-count-list"));
    }

    @Test
    void productionTaskAliasesCannotBypassTheReportPermission() {
        var guard = new ListStubStateGuard(new ListQueryContractRegistry(), currentPermissionService);
        doThrow(new ResponseStatusException(HttpStatus.FORBIDDEN, "Missing permission"))
            .when(currentPermissionService).requirePermission("production.task.audit");

        assertForbidden(() -> guard.assertReadable("task-track-report"));
        assertForbidden(() -> guard.assertReadable("production-task-list"));
        assertForbidden(() -> guard.assertReadable("production-task-form-list"));
    }

    @Test
    void operationLogScopesEnforceRoleAndPermissionMatrix() {
        var guard = new ListStubStateGuard(new ListQueryContractRegistry(), currentPermissionService);
        when(currentPermissionService.currentRoleCode()).thenReturn("FINANCE");
        doNothing().when(currentPermissionService).requirePermission("system.audit_log.view");
        guard.assertReadable("operation-log-list", "current");
        assertForbidden(() -> guard.assertReadable("operation-log-list", "platform"));
        assertForbidden(() -> guard.assertReadable("operation-log-list", "historical"));

        when(currentPermissionService.currentRoleCode()).thenReturn("ADMIN");
        doThrow(new ResponseStatusException(HttpStatus.FORBIDDEN, "Missing permission"))
            .when(currentPermissionService).requirePermission("system.account_set.manage");
        assertForbidden(() -> guard.assertReadable("operation-log-list", "platform"));

        doNothing().when(currentPermissionService).requirePermission("system.account_set.manage");
        guard.assertReadable("operation-log-list", "platform");
        guard.assertReadable("operation-log-list", "historical");

        when(currentPermissionService.currentRoleCode()).thenReturn("WAREHOUSE");
        doThrow(new ResponseStatusException(HttpStatus.FORBIDDEN, "Missing permission"))
            .when(currentPermissionService).requirePermission("system.audit_log.view");
        assertForbidden(() -> guard.assertReadable("operation-log-list", "current"));
    }

    @Test
    void operationLogCsvIncludesStableIdentityColumn() {
        when(currentPermissionService.hasPermission("system.audit_log.view")).thenReturn(true);
        when(listQueryService.query(any(), eq(seedRowsProvider))).thenReturn(new ListQueryResult(
            1, 1000, "header", "operatedAt", "desc", 1,
            List.<Map<String, ?>>of(Map.of("id", "00000000-0000-0000-0000-000000000123", "operatedAt", "2026-07-13 10:00:00"))
        ));

        var response = controller.exportCsv(
            "operation-log-list", "", "", 1000, "header", "", "asc", "",
            "", "", "", "", "", "current", "", ""
        );

        assertThat(response.getBody())
            .contains("日志ID,操作时间,模块,动作,主体类型")
            .contains("00000000-0000-0000-0000-000000000123");
    }

    @Test
    void settlementAccountSnapshotTokenIsPassedThroughWithoutWeakeningTheGuard() {
        when(currentPermissionService.hasPermission("finance.settle")).thenReturn(true);
        when(listQueryService.query(any(), eq(seedRowsProvider))).thenReturn(new ListQueryResult(
            2,
            2,
            "header",
            "",
            "asc",
            3,
            "server-snapshot-token",
            List.<Map<String, ?>>of(Map.of("id", "00000000-0000-0000-0000-000000000003", "code", "C"))
        ));

        var response = controller.rows(
            "financial-account-settlement-selector",
            "",
            "",
            2,
            2,
            "header",
            "",
            "asc",
            "",
            "",
            "",
            "",
            "",
            "",
            "current",
            "",
            "",
            "client-snapshot-token"
        );

        assertThat(response.get("snapshotToken")).isEqualTo("server-snapshot-token");
        var request = ArgumentCaptor.forClass(ListQueryRequest.class);
        verify(listQueryService).query(request.capture(), eq(seedRowsProvider));
        assertThat(request.getValue().snapshotToken()).isEqualTo("client-snapshot-token");
        verify(currentPermissionService).hasPermission("finance.settle");
    }

    private void assertForbidden(Runnable action) {
        assertThatThrownBy(action::run)
            .isInstanceOf(ResponseStatusException.class)
            .satisfies(error -> assertThat(((ResponseStatusException) error).getStatusCode()).isEqualTo(HttpStatus.FORBIDDEN));
    }

    private void assertNotFound(Runnable action) {
        assertThatThrownBy(action::run)
            .isInstanceOf(ResponseStatusException.class)
            .satisfies(error -> assertThat(((ResponseStatusException) error).getStatusCode()).isEqualTo(HttpStatus.NOT_FOUND));
    }
}
