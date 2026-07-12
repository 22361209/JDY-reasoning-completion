package com.jdy.erp.shared.application;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import java.lang.reflect.Method;
import java.util.Map;

import com.jdy.erp.shared.api.BillLifecycleController;
import com.jdy.erp.shared.api.DocumentLockController;
import com.jdy.erp.system.security.CurrentPermissionService;
import com.jdy.erp.system.security.CurrentSessionService;
import com.jdy.erp.system.security.RequireDocumentPermission;
import com.jdy.erp.system.security.WriteAccess;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.CsvSource;
import org.springframework.http.HttpStatus;
import org.springframework.web.server.ResponseStatusException;

class BillLifecyclePermissionIntegrationTest {
    private static final Map<String, String> EXPECTED_PERMISSIONS = Map.ofEntries(
        Map.entry("salesQuote", "sales.order.audit"),
        Map.entry("salesOrder", "sales.order.audit"),
        Map.entry("deliveryNotice", "sales.out.audit"),
        Map.entry("salesOut", "sales.out.audit"),
        Map.entry("purchaseOrder", "purchase.order.audit"),
        Map.entry("purchaseIn", "purchase.in.audit"),
        Map.entry("purchaseReturn", "purchase.return.audit"),
        Map.entry("productionTask", "production.task.audit"),
        Map.entry("materialIssue", "production.document.audit"),
        Map.entry("productIn", "production.document.audit"),
        Map.entry("otherStockIn", "inventory.other_stock_in.audit"),
        Map.entry("otherStockOut", "inventory.other_stock_out.audit"),
        Map.entry("stockTransfer", "inventory.stock_transfer.audit"),
        Map.entry("stockCount", "inventory.stock_count.audit"),
        Map.entry("stockCountGain", "inventory.stock_count_gain.audit"),
        Map.entry("stockCountLoss", "inventory.stock_count_loss.audit")
    );

    @ParameterizedTest
    @CsvSource({
        "salesQuote,sales.order.audit",
        "salesOrder,sales.order.audit",
        "deliveryNotice,sales.out.audit",
        "salesOut,sales.out.audit",
        "purchaseOrder,purchase.order.audit",
        "purchaseIn,purchase.in.audit",
        "purchaseReturn,purchase.return.audit",
        "productionTask,production.task.audit",
        "materialIssue,production.document.audit",
        "productIn,production.document.audit",
        "otherStockIn,inventory.other_stock_in.audit",
        "otherStockOut,inventory.other_stock_out.audit",
        "stockTransfer,inventory.stock_transfer.audit",
        "stockCount,inventory.stock_count.audit",
        "stockCountGain,inventory.stock_count_gain.audit",
        "stockCountLoss,inventory.stock_count_loss.audit"
    })
    void mapsEverySupportedDocumentTypeToItsExistingModulePermission(String type, String permission) {
        var policy = new DocumentPermissionPolicy(mock(CurrentPermissionService.class));

        assertThat(policy.permissionCode(type)).isEqualTo(permission);
    }

    @Test
    void exposesExactlyTheSixteenContractedDocumentTypes() {
        var policy = new DocumentPermissionPolicy(mock(CurrentPermissionService.class));

        assertThat(policy.supportedDocumentTypes()).containsExactlyInAnyOrderElementsOf(EXPECTED_PERMISSIONS.keySet());
    }

    @Test
    void documentLocksDeriveTheirSupportedTypesFromThePermissionRegistry() {
        var policy = new DocumentPermissionPolicy(mock(CurrentPermissionService.class));
        var lockService = new DocumentLockService(
            mock(org.springframework.jdbc.core.JdbcTemplate.class),
            mock(CurrentSessionService.class),
            mock(CurrentPermissionService.class),
            policy
        );

        assertThat(EXPECTED_PERMISSIONS.keySet())
            .allMatch(lockService::supportsDocumentType);
        assertThat(lockService.supportsDocumentType("unknown")).isFalse();
    }

    @Test
    void rejectsMissingPermissionBeforeTheControllerCanWrite() {
        var permissionService = mock(CurrentPermissionService.class);
        when(permissionService.hasPermission("sales.order.audit")).thenReturn(false);
        var policy = new DocumentPermissionPolicy(permissionService);

        assertThatThrownBy(() -> policy.requirePermission("salesOrder"))
            .isInstanceOfSatisfying(ResponseStatusException.class, error -> {
                assertThat(error.getStatusCode()).isEqualTo(HttpStatus.FORBIDDEN);
                assertThat(error.getReason()).contains("sales.order.audit");
            });
        verify(permissionService).hasPermission("sales.order.audit");
    }

    @Test
    void allowsTheMappedPermission() {
        var permissionService = mock(CurrentPermissionService.class);
        when(permissionService.hasPermission("inventory.stock_transfer.audit")).thenReturn(true);
        var policy = new DocumentPermissionPolicy(permissionService);

        policy.requirePermission("stockTransfer");

        verify(permissionService).hasPermission("inventory.stock_transfer.audit");
    }

    @Test
    void rejectsUnknownDocumentTypeAsNotFound() {
        var policy = new DocumentPermissionPolicy(mock(CurrentPermissionService.class));

        assertThatThrownBy(() -> policy.requirePermission("unknown"))
            .isInstanceOfSatisfying(ResponseStatusException.class, error ->
                assertThat(error.getStatusCode()).isEqualTo(HttpStatus.NOT_FOUND));
    }

    @Test
    void lifecycleAndLockEndpointsDeclareTheExpectedAccessSemantics() throws Exception {
        assertThat(BillLifecycleController.class.isAnnotationPresent(RequireDocumentPermission.class)).isTrue();
        assertThat(method(DocumentLockController.class, "status").isAnnotationPresent(RequireDocumentPermission.class)).isTrue();
        assertThat(method(DocumentLockController.class, "acquire").isAnnotationPresent(RequireDocumentPermission.class)).isTrue();
        var releaseAccess = method(DocumentLockController.class, "release").getAnnotation(WriteAccess.class);
        assertThat(releaseAccess).isNotNull();
        assertThat(releaseAccess.value()).isEqualTo(WriteAccess.Mode.AUTHENTICATED);
    }

    private Method method(Class<?> type, String name) {
        return java.util.Arrays.stream(type.getDeclaredMethods())
            .filter(method -> method.getName().equals(name))
            .findFirst()
            .orElseThrow();
    }
}
