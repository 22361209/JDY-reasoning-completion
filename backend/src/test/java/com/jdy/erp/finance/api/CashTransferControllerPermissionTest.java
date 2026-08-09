package com.jdy.erp.finance.api;

import static org.assertj.core.api.Assertions.assertThat;

import java.lang.reflect.Method;

import com.jdy.erp.system.security.RequirePermission;
import org.junit.jupiter.api.Test;

class CashTransferControllerPermissionTest {
    private static final String CASH_TRANSFER_PERMISSION = "finance.cash_transfer.audit";

    @Test
    void everyCashTransferEndpointRequiresTheCashTransferPermission() throws Exception {
        assertPermission("detail", String.class);
        assertPermission("saveDraft", com.jdy.erp.finance.application.CashTransferAppService.CashTransferDraftRequest.class);
        assertPermission("audit", String.class);
        assertPermission("reverse", String.class);
    }

    private void assertPermission(String methodName, Class<?>... parameterTypes) throws Exception {
        Method method = CashTransferController.class.getDeclaredMethod(methodName, parameterTypes);
        var permission = method.getAnnotation(RequirePermission.class);

        assertThat(permission)
            .as("CashTransferController.%s must declare a permission", methodName)
            .isNotNull();
        assertThat(permission.value()).isEqualTo(CASH_TRANSFER_PERMISSION);
    }
}
