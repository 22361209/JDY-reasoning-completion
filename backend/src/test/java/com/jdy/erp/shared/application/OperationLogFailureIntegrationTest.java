package com.jdy.erp.shared.application;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.contains;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.reset;
import static org.mockito.Mockito.times;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.verifyNoInteractions;
import static org.mockito.Mockito.when;

import java.util.Map;
import java.util.UUID;

import com.jdy.erp.finance.api.FinanceSettlementController;
import com.jdy.erp.shared.api.ResponseStatusExceptionHandler;
import com.jdy.erp.system.security.CurrentSessionService;
import com.jdy.erp.system.security.RequirePermission;
import com.jdy.erp.system.security.WriteAccess;
import com.jdy.erp.shared.domain.BillStatus;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.mockito.ArgumentCaptor;
import org.springframework.mock.web.MockHttpServletRequest;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.TransactionDefinition;
import org.springframework.transaction.support.SimpleTransactionStatus;
import org.springframework.web.context.request.RequestContextHolder;
import org.springframework.web.context.request.ServletRequestAttributes;
import org.springframework.web.servlet.HandlerMapping;
import org.springframework.web.method.HandlerMethod;
import org.springframework.web.server.ResponseStatusException;

class OperationLogFailureIntegrationTest {
    private final OperationLogService operationLogService = mock(OperationLogService.class);
    private final PlatformTransactionManager primaryTransactionManager = transactionManager();
    private final PlatformTransactionManager platformTransactionManager = transactionManager();
    private final OperationLogFailureService failureService = new OperationLogFailureService(
        operationLogService,
        primaryTransactionManager,
        platformTransactionManager
    );

    private MockHttpServletRequest request;

    @BeforeEach
    void bindRequest() {
        request = new MockHttpServletRequest("PUT", "/api/document-lifecycle/salesOrder/XSDD000001/audit");
        RequestContextHolder.setRequestAttributes(new ServletRequestAttributes(request));
    }

    @AfterEach
    void resetRequest() {
        RequestContextHolder.resetRequestAttributes();
    }

    @Test
    void repeatedFailureKeyIsWrittenOnceInRequiresNewAndMarksTheRequestHandled() {
        var command = OperationLogCommand.failure(
            "SALES",
            "AUDIT",
            "sales_order",
            UUID.fromString("00000000-0000-0000-0000-000000000136"),
            "XSDD000001",
            OperationLogCommand.ActorMode.CURRENT_USER,
            null,
            OperationLogCommand.state(OperationLogCommand.StateField.STATUS, "AUDITED"),
            Map.of(),
            "单据状态已变化"
        );
        when(operationLogService.writePlatform(command)).thenReturn(UUID.randomUUID());

        failureService.logPlatformOnce(command);
        failureService.logPlatformOnce(command);

        verify(operationLogService, times(1)).writePlatform(command);
        var definition = ArgumentCaptor.forClass(TransactionDefinition.class);
        verify(platformTransactionManager).getTransaction(definition.capture());
        assertThat(definition.getValue().getPropagationBehavior()).isEqualTo(TransactionDefinition.PROPAGATION_REQUIRES_NEW);
        assertThat(failureService.hasLoggedFailure(request)).isTrue();
    }

    @Test
    void requestFallbackRecordsOnlyTheMappedEndpointWithoutInventingBusinessIdentity() {
        request.setAttribute(
            HandlerMapping.BEST_MATCHING_PATTERN_ATTRIBUTE,
            "/api/document-lifecycle/{type}/{billNo}/audit"
        );
        request.setAttribute(
            HandlerMapping.URI_TEMPLATE_VARIABLES_ATTRIBUTE,
            Map.of("type", "salesOrder", "billNo", "XSDD000001")
        );
        when(operationLogService.writeCurrent(any(OperationLogCommand.class))).thenReturn(UUID.randomUUID());

        failureService.logDeclaredWriteFailureOnce(request, "单据状态已变化");

        var command = ArgumentCaptor.forClass(OperationLogCommand.class);
        verify(operationLogService).writeCurrent(command.capture());
        assertThat(command.getValue().module()).isEqualTo("SECURITY");
        assertThat(command.getValue().action()).isEqualTo("WRITE_FAILED");
        assertThat(command.getValue().targetType()).isEqualTo("http_endpoint");
        assertThat(command.getValue().targetNo()).isEqualTo("PUT /api/document-lifecycle/{type}/{billNo}/audit");
        assertThat(command.getValue().targetId()).isNull();
        assertThat(command.getValue().beforeState()).isEmpty();
        assertThat(command.getValue().afterState()).isEmpty();
    }

    @Test
    void permissionDenialDoesNotPersistPathVariablesOrPretendToBeTheBusinessAction() {
        request = new MockHttpServletRequest("PUT", "/api/system/managed-users/private-user/password");
        request.setAttribute(
            HandlerMapping.BEST_MATCHING_PATTERN_ATTRIBUTE,
            "/api/system/managed-users/{username}/password"
        );
        RequestContextHolder.setRequestAttributes(new ServletRequestAttributes(request));
        when(operationLogService.writeCurrent(any(OperationLogCommand.class))).thenReturn(UUID.randomUUID());

        failureService.logPermissionDeniedOnce(request, "当前角色无权执行该操作：system.role_permission.manage");

        var command = ArgumentCaptor.forClass(OperationLogCommand.class);
        verify(operationLogService).writeCurrent(command.capture());
        assertThat(command.getValue().module()).isEqualTo("SECURITY");
        assertThat(command.getValue().action()).isEqualTo("WRITE_DENIED");
        assertThat(command.getValue().targetType()).isEqualTo("http_endpoint");
        assertThat(command.getValue().targetNo()).isEqualTo("PUT /api/system/managed-users/{username}/password");
        assertThat(command.getValue().targetNo()).doesNotContain("private-user");
        assertThat(command.getValue().beforeState()).isEmpty();
        assertThat(command.getValue().afterState()).isEmpty();
    }

    @Test
    void responseAdviceExcludesAnonymousUnauthorizedProbeNotFoundAndPublicResetNoise() throws Exception {
        var mockedFailures = mock(OperationLogFailureService.class);
        var sessionService = mock(CurrentSessionService.class);
        var handler = new ResponseStatusExceptionHandler(mockedFailures, sessionService);

        when(sessionService.isAuthenticated()).thenReturn(false);
        request.setAttribute(HandlerMapping.BEST_MATCHING_HANDLER_ATTRIBUTE, handler("securedWrite"));
        handler.handle(new ResponseStatusException(HttpStatus.UNAUTHORIZED, "请先登录"), request);
        verify(mockedFailures, never()).logDeclaredWriteFailureOnce(any(), any());

        reset(mockedFailures, sessionService);
        when(sessionService.isAuthenticated()).thenReturn(true);
        handler.handle(new ResponseStatusException(HttpStatus.NOT_FOUND, "单据不存在"), request);
        verify(mockedFailures, never()).logDeclaredWriteFailureOnce(any(), any());

        reset(mockedFailures, sessionService);
        when(sessionService.isAuthenticated()).thenReturn(true);
        request.setAttribute(HandlerMapping.BEST_MATCHING_HANDLER_ATTRIBUTE, handler("publicPasswordReset"));
        handler.handle(new ResponseStatusException(HttpStatus.BAD_REQUEST, "输入过长"), request);
        verify(mockedFailures, never()).logDeclaredWriteFailureOnce(any(), any());

        request.setAttribute(HandlerMapping.BEST_MATCHING_HANDLER_ATTRIBUTE, handler("securedWrite"));
        handler.handle(new ResponseStatusException(HttpStatus.CONFLICT, "单据状态已变化"), request);
        verify(mockedFailures).logDeclaredWriteFailureOnce(request, "单据状态已变化");
    }

    @Test
    void lifecycleSuccessCapturesWhitelistedBeforeAndAfterState() {
        var jdbcTemplate = mock(JdbcTemplate.class);
        var successes = mock(OperationLogService.class);
        var failures = mock(OperationLogFailureService.class);
        var lifecycle = new BillLifecycleService(jdbcTemplate, successes, failures, mock(CurrentSessionService.class));
        var id = "00000000-0000-0000-0000-000000000137";
        when(jdbcTemplate.queryForList(contains("SELECT id::text AS id"), any(Object[].class))).thenReturn(java.util.List.of(Map.of(
            "id", id,
            "billNo", "XSDD000137",
            "status", "DRAFT",
            "closeStatus", "OPEN",
            "frozenStatus", "NORMAL"
        )));
        when(jdbcTemplate.queryForList(contains("UPDATE sales_order"), any(Object[].class))).thenReturn(java.util.List.of(Map.of(
            "id", id,
            "billNo", "XSDD000137",
            "status", "AUDITED",
            "closeStatus", "OPEN",
            "frozenStatus", "NORMAL"
        )));

        lifecycle.transitionAny(
            "sales_order", "XSDD000137", BillStatus.AUDITED, null,
            "SALES", "AUDIT", "sales_order", "销售订单不存在"
        );

        var command = ArgumentCaptor.forClass(OperationLogCommand.class);
        verify(successes).logCurrent(command.capture());
        assertThat(command.getValue().targetId()).isEqualTo(UUID.fromString(id));
        assertThat(command.getValue().targetNo()).isEqualTo("XSDD000137");
        assertThat(command.getValue().beforeState()).containsEntry(OperationLogCommand.StateField.STATUS, "DRAFT");
        assertThat(command.getValue().afterState()).containsEntry(OperationLogCommand.StateField.STATUS, "AUDITED");
        assertThat(command.getValue().beforeState().keySet()).allMatch(java.util.Set.of(
            OperationLogCommand.StateField.STATUS,
            OperationLogCommand.StateField.CLOSE_STATUS,
            OperationLogCommand.StateField.FROZEN_STATUS
        )::contains);
    }

    @Test
    void lifecycleConflictWritesExactlyOneFailureButMissingProbeWritesNone() {
        var jdbcTemplate = mock(JdbcTemplate.class);
        var successes = mock(OperationLogService.class);
        var failures = mock(OperationLogFailureService.class);
        var lifecycle = new BillLifecycleService(jdbcTemplate, successes, failures, mock(CurrentSessionService.class));
        var id = "00000000-0000-0000-0000-000000000138";
        when(jdbcTemplate.queryForList(contains("UPDATE sales_order"), any(Object[].class))).thenReturn(java.util.List.of());
        when(jdbcTemplate.queryForList(contains("SELECT id::text AS id"), any(Object[].class))).thenReturn(java.util.List.of(Map.of(
            "id", id,
            "billNo", "XSDD000138",
            "status", "AUDITED",
            "closeStatus", "OPEN",
            "frozenStatus", "NORMAL"
        )));

        assertThatThrownBy(() -> lifecycle.transition(
            "sales_order", "XSDD000138", BillStatus.DRAFT, BillStatus.AUDITED,
            null, "SALES", "AUDIT", "sales_order", "销售订单已审核"
        )).isInstanceOf(ResponseStatusException.class);

        var command = ArgumentCaptor.forClass(OperationLogCommand.class);
        verify(failures).logCurrentOnce(command.capture());
        assertThat(command.getValue().beforeState()).containsEntry(OperationLogCommand.StateField.STATUS, "AUDITED");
        assertThat(command.getValue().afterState()).isEmpty();

        var probeJdbc = mock(JdbcTemplate.class);
        var probeFailures = mock(OperationLogFailureService.class);
        var probeLifecycle = new BillLifecycleService(
            probeJdbc,
            mock(OperationLogService.class),
            probeFailures,
            mock(CurrentSessionService.class)
        );
        when(probeJdbc.queryForList(any(String.class), any(Object[].class))).thenReturn(java.util.List.of());
        assertThatThrownBy(() -> probeLifecycle.transition(
            "sales_order", "MISSING", BillStatus.DRAFT, BillStatus.AUDITED,
            null, "SALES", "AUDIT", "sales_order", "销售订单不存在"
        )).isInstanceOf(ResponseStatusException.class);
        verifyNoInteractions(probeFailures);
    }

    @Test
    void retiredImmediateSettlementIsGoneAndFailureAuditKeepsOnlyTheEndpointPattern() throws Exception {
        var settlementService = mock(com.jdy.erp.finance.application.FinanceSettlementAppService.class);
        var controller = new FinanceSettlementController(
            settlementService,
            mock(com.jdy.erp.system.security.CurrentPermissionService.class)
        );
        request = new MockHttpServletRequest("POST", "/api/finance/receivables/YS-PRIVATE-139/receipt");
        request.setAttribute(
            HandlerMapping.BEST_MATCHING_PATTERN_ATTRIBUTE,
            "/api/finance/receivables/{billNo}/receipt"
        );
        request.setAttribute(
            HandlerMapping.URI_TEMPLATE_VARIABLES_ATTRIBUTE,
            Map.of("billNo", "YS-PRIVATE-139")
        );
        request.setAttribute(
            HandlerMapping.BEST_MATCHING_HANDLER_ATTRIBUTE,
            new HandlerMethod(
                controller,
                FinanceSettlementController.class.getDeclaredMethod("retiredImmediateReceipt", String.class)
            )
        );
        RequestContextHolder.setRequestAttributes(new ServletRequestAttributes(request));
        var sessionService = mock(CurrentSessionService.class);
        when(sessionService.isAuthenticated()).thenReturn(true);
        when(operationLogService.writeCurrent(any(OperationLogCommand.class))).thenReturn(UUID.randomUUID());
        var handler = new ResponseStatusExceptionHandler(failureService, sessionService);

        var error = org.assertj.core.api.Assertions.catchThrowableOfType(
            () -> controller.retiredImmediateReceipt("YS-PRIVATE-139"),
            ResponseStatusException.class
        );
        assertThat(error.getStatusCode()).isEqualTo(HttpStatus.GONE);
        assertThat(error.getReason()).contains("/api/finance/receipts/draft");
        handler.handle(error, request);

        var command = ArgumentCaptor.forClass(OperationLogCommand.class);
        verify(operationLogService).writeCurrent(command.capture());
        assertThat(command.getValue().module()).isEqualTo("SECURITY");
        assertThat(command.getValue().action()).isEqualTo("WRITE_FAILED");
        assertThat(command.getValue().targetType()).isEqualTo("http_endpoint");
        assertThat(command.getValue().targetNo())
            .isEqualTo("POST /api/finance/receivables/{billNo}/receipt")
            .doesNotContain("YS-PRIVATE-139");
        assertThat(command.getValue().beforeState()).isEmpty();
        assertThat(command.getValue().afterState()).isEmpty();
        verifyNoInteractions(settlementService);
    }

    private HandlerMethod handler(String method) throws Exception {
        return new HandlerMethod(new TestHandlers(), TestHandlers.class.getDeclaredMethod(method));
    }

    private PlatformTransactionManager transactionManager() {
        var transactionManager = mock(PlatformTransactionManager.class);
        when(transactionManager.getTransaction(any(TransactionDefinition.class))).thenReturn(new SimpleTransactionStatus());
        return transactionManager;
    }

    private static final class TestHandlers {
        @RequirePermission("sales.order.audit")
        void securedWrite() {
        }

        @WriteAccess(WriteAccess.Policy.REQUEST_PASSWORD_RESET)
        void publicPasswordReset() {
        }
    }
}
