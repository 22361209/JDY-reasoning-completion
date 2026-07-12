package com.jdy.erp.system.api;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

import com.jdy.erp.system.application.ListFilterPresetAccessPolicy;
import com.jdy.erp.system.security.CurrentPermissionService;
import com.jdy.erp.system.security.CurrentSessionService;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.http.HttpStatus;
import org.springframework.web.server.ResponseStatusException;

class ListFilterPresetAuthorizationIntegrationTest {
    private CurrentSessionService sessionService;
    private CurrentPermissionService permissionService;
    private ListFilterPresetAccessPolicy policy;

    @BeforeEach
    void setUp() {
        sessionService = mock(CurrentSessionService.class);
        permissionService = mock(CurrentPermissionService.class);
        when(sessionService.currentRoleCode()).thenReturn("WAREHOUSE");
        when(sessionService.currentDisplayName()).thenReturn("仓库员");
        policy = new ListFilterPresetAccessPolicy(sessionService, permissionService);
    }

    @Test
    void personalScopeAlwaysUsesTheCurrentSessionInsteadOfRequestedIdentity() {
        var scope = policy.resolveWriteScope("PERSONAL", "ADMIN");

        assertThat(scope.roleCode()).isEqualTo("WAREHOUSE");
        assertThat(scope.userName()).isEqualTo("仓库员");
    }

    @Test
    void lowPermissionUserCannotCreateRoleOrGeneralPresets() {
        when(permissionService.hasPermission("system.role_permission.manage")).thenReturn(false);

        assertForbidden(() -> policy.resolveWriteScope("ROLE", "ADMIN"));
        assertForbidden(() -> policy.resolveWriteScope("GENERAL", null));
        assertForbidden(() -> policy.resolveWriteScope("", "ADMIN"));
    }

    @Test
    void managerCanCreateExplicitRoleAndGeneralScopes() {
        when(permissionService.hasPermission("system.role_permission.manage")).thenReturn(true);

        var role = policy.resolveWriteScope("ROLE", "WAREHOUSE");
        var general = policy.resolveWriteScope("GENERAL", null);

        assertThat(role.roleCode()).isEqualTo("WAREHOUSE");
        assertThat(role.userName()).isNull();
        assertThat(general.roleCode()).isNull();
        assertThat(general.userName()).isNull();
    }

    @Test
    void userCanDeleteOnlyTheExactCurrentPersonalScope() {
        policy.requireCanModifyStoredScope("WAREHOUSE", "仓库员");

        assertForbidden(() -> policy.requireCanModifyStoredScope("ADMIN", "本地管理员"));
        assertForbidden(() -> policy.requireCanModifyStoredScope("WAREHOUSE", "其他仓库员"));
    }

    @Test
    void roleAndGeneralDeleteRequireManagerPermission() {
        when(permissionService.hasPermission("system.role_permission.manage")).thenReturn(false);
        assertForbidden(() -> policy.requireCanModifyStoredScope("WAREHOUSE", null));
        assertForbidden(() -> policy.requireCanModifyStoredScope(null, null));

        when(permissionService.hasPermission("system.role_permission.manage")).thenReturn(true);
        policy.requireCanModifyStoredScope("WAREHOUSE", null);
        policy.requireCanModifyStoredScope(null, null);
    }

    @Test
    void invalidOrIncompleteScopeIsRejectedBeforePersistence() {
        assertThatThrownBy(() -> policy.resolveWriteScope("OTHER", null))
            .isInstanceOfSatisfying(ResponseStatusException.class, error ->
                assertThat(error.getStatusCode()).isEqualTo(HttpStatus.BAD_REQUEST));
        assertThatThrownBy(() -> policy.resolveWriteScope("ROLE", ""))
            .isInstanceOfSatisfying(ResponseStatusException.class, error ->
                assertThat(error.getStatusCode()).isEqualTo(HttpStatus.BAD_REQUEST));
    }

    private void assertForbidden(ThrowingCall call) {
        assertThatThrownBy(call::run)
            .isInstanceOfSatisfying(ResponseStatusException.class, error ->
                assertThat(error.getStatusCode()).isEqualTo(HttpStatus.FORBIDDEN));
    }

    @FunctionalInterface
    private interface ThrowingCall {
        void run();
    }
}
