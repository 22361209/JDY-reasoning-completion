package com.jdy.erp.system.security;

import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.lang.reflect.Method;
import java.util.LinkedHashMap;

import org.junit.jupiter.api.Test;
import org.springframework.web.bind.annotation.RequestMethod;
import org.springframework.web.method.HandlerMethod;
import org.springframework.web.servlet.mvc.method.RequestMappingInfo;

class WriteAccessPolicyContractTest {
    @Test
    void rejectsWhenANamedPolicyMovesToAnotherMethodOrPath() throws Exception {
        var mappings = new LinkedHashMap<RequestMappingInfo, HandlerMethod>();
        mappings.put(
            RequestMappingInfo.paths("/api/system/logout").methods(RequestMethod.PUT).build(),
            handler("login")
        );

        assertThatThrownBy(() -> WriteAccessPolicyContract.validate(mappings))
            .isInstanceOf(IllegalStateException.class)
            .hasMessageContaining("LOGIN expects POST /api/system/login")
            .hasMessageContaining("LOGOUT is not attached");
    }

    @Test
    void rejectsWhenOneNamedPolicyIsReusedByMultipleHandlers() throws Exception {
        var mappings = new LinkedHashMap<RequestMappingInfo, HandlerMethod>();
        mappings.put(
            RequestMappingInfo.paths("/api/system/login").methods(RequestMethod.POST).build(),
            handler("login")
        );
        mappings.put(
            RequestMappingInfo.paths("/api/system/login-alias").methods(RequestMethod.POST).build(),
            handler("secondLogin")
        );

        assertThatThrownBy(() -> WriteAccessPolicyContract.validate(mappings))
            .isInstanceOf(IllegalStateException.class)
            .hasMessageContaining("LOGIN is attached to multiple registered handlers");
    }

    private HandlerMethod handler(String methodName) throws Exception {
        Method method = TestHandlers.class.getDeclaredMethod(methodName);
        return new HandlerMethod(new TestHandlers(), method);
    }

    private static class TestHandlers {
        @WriteAccess(WriteAccess.Policy.LOGIN)
        void login() {
        }

        @WriteAccess(WriteAccess.Policy.LOGIN)
        void secondLogin() {
        }
    }
}
