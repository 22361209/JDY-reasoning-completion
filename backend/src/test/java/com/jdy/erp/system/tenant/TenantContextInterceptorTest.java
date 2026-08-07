package com.jdy.erp.system.tenant;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.lang.reflect.Method;

import com.jdy.erp.system.security.CurrentSessionService;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.http.HttpStatus;
import org.springframework.mock.web.MockHttpServletRequest;
import org.springframework.mock.web.MockHttpServletResponse;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.context.request.RequestContextHolder;
import org.springframework.web.context.request.ServletRequestAttributes;
import org.springframework.web.method.HandlerMethod;
import org.springframework.web.server.ResponseStatusException;

@SpringBootTest
@Transactional
class TenantContextInterceptorTest {
    @Autowired
    private TenantContextInterceptor tenantContextInterceptor;

    @Autowired
    private CurrentSessionService currentSessionService;

    @Autowired
    private TenantResourceLocator tenantResourceLocator;

    private MockHttpServletRequest request;
    private MockHttpServletResponse response;
    private HandlerMethod handler;

    @BeforeEach
    void setUp() throws NoSuchMethodException {
        request = new MockHttpServletRequest();
        response = new MockHttpServletResponse();
        RequestContextHolder.setRequestAttributes(new ServletRequestAttributes(request));
        Method method = DummyHandler.class.getDeclaredMethod("handle");
        handler = new HandlerMethod(new DummyHandler(), method);
    }

    @AfterEach
    void tearDown() {
        TenantContext.clear();
        RequestContextHolder.resetRequestAttributes();
    }

    @Test
    void platformPathUsesPlatformContextWithoutLogin() {
        request.setRequestURI("/api/system/session");

        tenantContextInterceptor.preHandle(request, response, handler);

        assertThat(TenantContext.current()).isPresent();
        assertThat(TenantContext.current().orElseThrow().scope()).isEqualTo(TenantContext.Scope.PLATFORM);

        tenantContextInterceptor.afterCompletion(request, response, handler, null);
        assertThat(TenantContext.current()).isEmpty();
    }

    @Test
    void regressionFenceControlUsesPlatformContextWithoutLogin() {
        request.setRequestURI("/api/system/regression-request-fence");

        tenantContextInterceptor.preHandle(request, response, handler);

        assertThat(TenantContext.current()).isPresent();
        assertThat(TenantContext.current().orElseThrow().scope()).isEqualTo(TenantContext.Scope.PLATFORM);
    }

    @Test
    void businessPathWithoutLoginIsRejectedBeforeTenantRouting() {
        request.setRequestURI("/api/sales-orders/draft");

        assertThatThrownBy(() -> tenantContextInterceptor.preHandle(request, response, handler))
            .isInstanceOf(ResponseStatusException.class)
            .satisfies(error -> assertThat(((ResponseStatusException) error).getStatusCode()).isEqualTo(HttpStatus.UNAUTHORIZED));
        assertThat(TenantContext.current()).isEmpty();
    }

    @Test
    void businessPathWithLoginSetsTenantContextAndResourcePrefixes() {
        currentSessionService.login("admin", "admin123", "BLD-TEST");
        request.setRequestURI("/api/sales-orders/draft");

        tenantContextInterceptor.preHandle(request, response, handler);

        var context = TenantContext.current().orElseThrow();
        assertThat(context.scope()).isEqualTo(TenantContext.Scope.TENANT);
        assertThat(context.accountSetCode()).isEqualTo("BLD-TEST");
        assertThat(tenantResourceLocator.redisKey("locks/sales-order")).isEqualTo("BLD-TEST:locks/sales-order");
        assertThat(tenantResourceLocator.attachmentPath("materials/a.pdf")).isEqualTo("account-sets/BLD-TEST/materials/a.pdf");
    }

    static class DummyHandler {
        void handle() {
        }
    }
}
