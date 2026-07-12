package com.jdy.erp.system.api;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

import com.jdy.erp.inventory.application.InventoryTestAdjustmentAccessPolicy;
import org.junit.jupiter.api.Test;

class SystemHealthControllerTest {

    @Test
    void reportsTheInjectedDevelopmentBuildFingerprint() {
        var adjustmentPolicy = mock(InventoryTestAdjustmentAccessPolicy.class);
        when(adjustmentPolicy.isEnabledForAccountSet("BLD-TEST")).thenReturn(true);

        var health = new SystemHealthController(adjustmentPolicy, " 012345abcdef ").health();

        assertThat(health)
            .containsEntry("status", "UP")
            .containsEntry("service", "jdy-erp")
            .containsEntry("devBuildFingerprint", "012345abcdef")
            .containsEntry("testInventoryAdjustmentApi", true);
    }

    @Test
    void leavesTheFingerprintEmptyForExternalOrDefaultStarts() {
        var adjustmentPolicy = mock(InventoryTestAdjustmentAccessPolicy.class);

        var health = new SystemHealthController(adjustmentPolicy, null).health();

        assertThat(health).containsEntry("devBuildFingerprint", "");
    }
}
