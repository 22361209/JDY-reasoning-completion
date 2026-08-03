package com.jdy.erp.system.api;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

import com.jdy.erp.inventory.application.InventoryTestAdjustmentAccessPolicy;
import com.jdy.erp.system.security.RegressionSharedAdminLoginGuard;
import org.junit.jupiter.api.Test;
import org.springframework.mock.web.MockHttpServletRequest;

class SystemHealthControllerTest {

    @Test
    void reportsTheInjectedDevelopmentBuildFingerprint() {
        var adjustmentPolicy = mock(InventoryTestAdjustmentAccessPolicy.class);
        var loginGuard = mock(RegressionSharedAdminLoginGuard.class);
        var request = new MockHttpServletRequest();
        when(adjustmentPolicy.isEnabledForAccountSet("BLD-TEST")).thenReturn(true);
        when(loginGuard.isSharedAdminLoginGuardActive(request)).thenReturn(true);
        when(loginGuard.activeSharedAdminLoginCount(request)).thenReturn(2);

        var health = new SystemHealthController(adjustmentPolicy, loginGuard, " 012345abcdef ").health(request);

        assertThat(health)
            .containsEntry("status", "UP")
            .containsEntry("service", "jdy-erp")
            .containsEntry("devBuildFingerprint", "012345abcdef")
            .containsEntry("testInventoryAdjustmentApi", true)
            .containsEntry("regressionSharedAdminLoginGuard", true)
            .containsEntry("regressionSharedAdminLoginActiveCount", 2);
    }

    @Test
    void leavesTheFingerprintEmptyForExternalOrDefaultStarts() {
        var adjustmentPolicy = mock(InventoryTestAdjustmentAccessPolicy.class);
        var loginGuard = mock(RegressionSharedAdminLoginGuard.class);
        var request = new MockHttpServletRequest();

        var health = new SystemHealthController(adjustmentPolicy, loginGuard, null).health(request);

        assertThat(health).containsEntry("devBuildFingerprint", "");
    }
}
