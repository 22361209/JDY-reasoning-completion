package com.jdy.erp.shared.application;

import java.util.UUID;

import jakarta.servlet.http.HttpServletRequest;

import com.jdy.erp.system.security.CurrentSessionService;
import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Component;
import org.springframework.web.context.request.RequestContextHolder;
import org.springframework.web.context.request.ServletRequestAttributes;
import org.springframework.web.server.ResponseStatusException;

@Component
public final class OperationActorProvider {
    private static final String REQUEST_ACTOR_ATTRIBUTE = OperationActorProvider.class.getName() + ".currentActor";

    private final JdbcTemplate platformJdbcTemplate;

    public OperationActorProvider(@Qualifier("platformJdbcTemplate") JdbcTemplate platformJdbcTemplate) {
        this.platformJdbcTemplate = platformJdbcTemplate;
    }

    public OperationActor currentUser() {
        var request = currentRequest();
        if (request == null) {
            throw new ResponseStatusException(HttpStatus.UNAUTHORIZED, "当前请求没有认证用户");
        }
        var cached = request.getAttribute(REQUEST_ACTOR_ATTRIBUTE);
        if (cached instanceof OperationActor actor) {
            actor.validateForNewWrite();
            return actor;
        }
        var session = request.getSession(false);
        var username = session == null ? null : session.getAttribute(CurrentSessionService.SESSION_USERNAME);
        if (username == null || String.valueOf(username).isBlank()) {
            throw new ResponseStatusException(HttpStatus.UNAUTHORIZED, "请先登录");
        }
        var actor = userByUsername(String.valueOf(username));
        request.setAttribute(REQUEST_ACTOR_ATTRIBUTE, actor);
        return actor;
    }

    /**
     * Captures the immutable actor snapshot immediately after session authentication.
     * Later mutations in the same request (password generation, display name, enabled)
     * must not change or invalidate the operation-time identity recorded by the writer.
     */
    public OperationActor captureCurrentUser() {
        return currentUser();
    }

    public OperationActor user(UUID userId) {
        var rows = platformJdbcTemplate.queryForList("""
            SELECT id::text AS id, username, display_name AS "displayName"
            FROM sys_user
            WHERE id = ?::uuid
              AND enabled = TRUE
            """, userId);
        if (rows.isEmpty()) {
            throw new ResponseStatusException(HttpStatus.UNAUTHORIZED, "操作日志用户不存在或已停用");
        }
        return actor(rows.getFirst());
    }

    public OperationActor system() {
        return OperationActor.system();
    }

    public OperationActor anonymous() {
        return OperationActor.anonymous();
    }

    public OperationActor resolve(OperationLogCommand command) {
        return switch (command.actorMode()) {
            case CURRENT_USER -> currentUser();
            case EXPLICIT_USER -> command.explicitActor();
            case SYSTEM -> system();
            case ANONYMOUS -> anonymous();
        };
    }

    private OperationActor userByUsername(String username) {
        var rows = platformJdbcTemplate.queryForList("""
            SELECT id::text AS id, username, display_name AS "displayName"
            FROM sys_user
            WHERE username = ?
              AND enabled = TRUE
            """, username);
        if (rows.isEmpty()) {
            throw new ResponseStatusException(HttpStatus.UNAUTHORIZED, "当前用户不存在或已停用");
        }
        return actor(rows.getFirst());
    }

    private OperationActor actor(java.util.Map<String, Object> row) {
        var actor = OperationActor.user(
            UUID.fromString(String.valueOf(row.get("id"))),
            String.valueOf(row.get("username")),
            String.valueOf(row.get("displayName"))
        );
        actor.validateForNewWrite();
        return actor;
    }

    private HttpServletRequest currentRequest() {
        var attributes = RequestContextHolder.getRequestAttributes();
        if (attributes instanceof ServletRequestAttributes servletAttributes) {
            return servletAttributes.getRequest();
        }
        return null;
    }
}
