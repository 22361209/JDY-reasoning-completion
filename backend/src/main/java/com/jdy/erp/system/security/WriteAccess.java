package com.jdy.erp.system.security;

import java.lang.annotation.ElementType;
import java.lang.annotation.Retention;
import java.lang.annotation.RetentionPolicy;
import java.lang.annotation.Target;

import org.springframework.web.bind.annotation.RequestMethod;

@Target(ElementType.METHOD)
@Retention(RetentionPolicy.RUNTIME)
public @interface WriteAccess {
    Policy value();

    enum Mode {
        PUBLIC,
        AUTHENTICATED,
        REQUEST_SCOPED_PERMISSION
    }

    enum Policy {
        LOGIN(Mode.PUBLIC, RequestMethod.POST, "/api/system/login"),
        LOGOUT(Mode.PUBLIC, RequestMethod.POST, "/api/system/logout"),
        REQUEST_PASSWORD_RESET(Mode.PUBLIC, RequestMethod.POST, "/api/system/password-reset-requests"),
        MANAGE_REGRESSION_REQUEST_FENCE(Mode.PUBLIC, RequestMethod.POST, "/api/system/regression-request-fence"),
        CHANGE_OWN_PASSWORD(Mode.AUTHENTICATED, RequestMethod.PUT, "/api/system/password"),
        SWITCH_AUTHORIZED_ACCOUNT_SET(Mode.AUTHENTICATED, RequestMethod.POST, "/api/system/account-sets/current"),
        RELEASE_OWN_DOCUMENT_LOCK(Mode.AUTHENTICATED, RequestMethod.DELETE, "/api/document-locks/{type}/{billNo}"),
        SAVE_LIST_PRESET(Mode.REQUEST_SCOPED_PERMISSION, RequestMethod.POST, "/api/list-presets/{listKey}"),
        DELETE_LIST_PRESET(Mode.REQUEST_SCOPED_PERMISSION, RequestMethod.DELETE, "/api/list-presets/{listKey}/{id}");

        private final Mode mode;
        private final RequestMethod method;
        private final String path;

        Policy(Mode mode, RequestMethod method, String path) {
            this.mode = mode;
            this.method = method;
            this.path = path;
        }

        public Mode mode() {
            return mode;
        }

        public RequestMethod method() {
            return method;
        }

        public String path() {
            return path;
        }

        public boolean matches(String requestMethod, String requestPath) {
            return method.name().equals(requestMethod) && path.equals(requestPath);
        }
    }
}
