package com.jdy.erp.inventory.api;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.argThat;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.verifyNoInteractions;
import static org.mockito.Mockito.when;

import java.math.BigDecimal;
import java.util.List;
import java.util.Map;

import com.jdy.erp.inventory.application.InventoryPostingCommand.PostingAction;
import com.jdy.erp.inventory.application.InventoryPostingCommand.TraceQuality;
import com.jdy.erp.inventory.application.InventoryPostingService;
import com.jdy.erp.inventory.application.InventoryTestAdjustmentAccessPolicy;
import com.jdy.erp.inventory.config.InventoryTestAdjustmentProperties;
import com.jdy.erp.system.security.CurrentSessionService;
import com.jdy.erp.system.security.RequirePermission;
import org.junit.jupiter.api.Test;
import org.springframework.core.env.Environment;
import org.springframework.http.HttpStatus;
import org.springframework.web.server.ResponseStatusException;

class InventoryDirectWriteBoundaryIntegrationTest {
    @Test
    void enablesOnlyAnExplicitAllowedProfileSwitchAndAccountSet() {
        var environment = mock(Environment.class);
        when(environment.getActiveProfiles()).thenReturn(new String[] {"local"});
        var session = mock(CurrentSessionService.class);
        when(session.currentAccountSetCode()).thenReturn("bld-test");
        var properties = new InventoryTestAdjustmentProperties(true, List.of(" BLD-TEST "));
        var policy = new InventoryTestAdjustmentAccessPolicy(properties, environment, session);

        assertThat(policy.isEnabledForAccountSet("BLD-TEST")).isTrue();
        policy.requireAllowed();
        verify(session).currentAccountSetCode();
    }

    @Test
    void rejectsDefaultDisabledNonTestProfileAndNonAllowlistedAccountSet() {
        var environment = mock(Environment.class);
        var session = mock(CurrentSessionService.class);

        when(environment.getActiveProfiles()).thenReturn(new String[0]);
        assertThat(policy(false, List.of(), environment, session).isEnabledForAccountSet("BLD-TEST")).isFalse();

        when(environment.getActiveProfiles()).thenReturn(new String[] {"production"});
        assertThat(policy(true, List.of("BLD-TEST"), environment, session).isEnabledForAccountSet("BLD-TEST")).isFalse();

        when(environment.getActiveProfiles()).thenReturn(new String[] {"local", "production"});
        assertThat(policy(true, List.of("BLD-TEST"), environment, session).isEnabledForAccountSet("BLD-TEST")).isFalse();

        when(environment.getActiveProfiles()).thenReturn(new String[] {"regression"});
        assertThat(policy(true, List.of("BLD-TEST"), environment, session).isEnabledForAccountSet("BLD-PROD")).isFalse();
    }

    @Test
    void forbiddenPolicyStopsBeforeInventoryPosting() {
        var postingService = mock(InventoryPostingService.class);
        var accessPolicy = mock(InventoryTestAdjustmentAccessPolicy.class);
        var controller = new InventoryAdjustmentController(postingService, accessPolicy);
        var denied = new ResponseStatusException(HttpStatus.FORBIDDEN, "测试库存入口未开启");
        org.mockito.Mockito.doThrow(denied).when(accessPolicy).requireAllowed();

        assertThatThrownBy(() -> controller.adjust(request("A134_TEST_ADJUSTMENT", "A134:denied")))
            .isSameAs(denied);
        verifyNoInteractions(postingService);
    }

    @Test
    void rejectsFormalInventorySourceMasqueradingWithoutPosting() {
        var postingService = mock(InventoryPostingService.class);
        var accessPolicy = mock(InventoryTestAdjustmentAccessPolicy.class);
        var controller = new InventoryAdjustmentController(postingService, accessPolicy);

        assertThatThrownBy(() -> controller.adjust(request("SALES_OUT", "SALES_OUT:XSCK000001")))
            .isInstanceOfSatisfying(ResponseStatusException.class, error ->
                assertThat(error.getStatusCode()).isEqualTo(HttpStatus.BAD_REQUEST));
        verify(accessPolicy).requireAllowed();
        verifyNoInteractions(postingService);
    }

    @Test
    void validTestSourcePostsExactlyOnceAfterAllAccessChecks() {
        var postingService = mock(InventoryPostingService.class);
        var accessPolicy = mock(InventoryTestAdjustmentAccessPolicy.class);
        var controller = new InventoryAdjustmentController(postingService, accessPolicy);
        var expected = Map.<String, Object>of("ok", true);
        when(postingService.post(argThat(command ->
            command != null
                && "CP-001".equals(command.productCode())
                && "CK-001".equals(command.warehouseCode())
                && new BigDecimal("2.5").compareTo(command.quantity()) == 0
                && "A134_TEST_ADJUSTMENT".equals(command.txnType())
                && "A134:allowed".equals(command.sourceBillType())
                && "A134:allowed".equals(command.sourceBillNo())
                && command.sourceBillId() != null
                && command.sourceBillLineId() != null
                && command.sourceBillDate() != null
                && command.postingAction() == PostingAction.AUDIT
                && command.traceQuality() == TraceQuality.TEST
        ))).thenReturn(expected);

        assertThat(controller.adjust(request("A134_TEST_ADJUSTMENT", "A134:allowed"))).isEqualTo(expected);
        verify(accessPolicy).requireAllowed();
        verify(postingService).post(argThat(command ->
            command != null
                && "A134_TEST_ADJUSTMENT".equals(command.txnType())
                && "A134:allowed".equals(command.sourceBillType())
                && command.traceQuality() == TraceQuality.TEST
        ));
    }

    @Test
    void adjustmentRequiresExistingAdministratorPermissionAndLegacyControllersAreGone() throws Exception {
        var access = InventoryAdjustmentController.class
            .getDeclaredMethod("adjust", InventoryAdjustmentController.InventoryAdjustmentRequest.class)
            .getAnnotation(RequirePermission.class);

        assertThat(access).isNotNull();
        assertThat(access.value()).isEqualTo("system.account_set.manage");
        assertThatThrownBy(() -> Class.forName("com.jdy.erp.inventory.api.InventoryBusinessFlowController"))
            .isInstanceOf(ClassNotFoundException.class);
    }

    private InventoryTestAdjustmentAccessPolicy policy(
        boolean enabled,
        List<String> allowedAccountSets,
        Environment environment,
        CurrentSessionService session
    ) {
        return new InventoryTestAdjustmentAccessPolicy(
            new InventoryTestAdjustmentProperties(enabled, allowedAccountSets),
            environment,
            session
        );
    }

    private InventoryAdjustmentController.InventoryAdjustmentRequest request(String txnType, String sourceBillType) {
        return new InventoryAdjustmentController.InventoryAdjustmentRequest(
            "CP-001",
            "CK-001",
            new BigDecimal("2.5"),
            txnType,
            sourceBillType
        );
    }
}
