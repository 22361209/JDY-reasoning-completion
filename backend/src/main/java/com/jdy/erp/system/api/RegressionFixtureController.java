package com.jdy.erp.system.api;

import java.time.Duration;
import java.util.Locale;
import java.util.Map;
import java.util.UUID;
import java.util.regex.Pattern;

import jakarta.servlet.http.HttpServletRequest;

import com.jdy.erp.system.security.RegressionActiveRequestTracker;
import com.jdy.erp.system.security.RegressionSharedAdminLoginGuard;
import com.jdy.erp.system.security.WriteAccess;
import com.jdy.erp.system.security.WriteAccess.Policy;
import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.server.ResponseStatusException;

@RestController
@RequestMapping("/api/system")
public class RegressionFixtureController {
    private static final Pattern FIXTURE_USERNAME = Pattern.compile("^r_[a-z0-9_]{1,58}_[0-9a-f]{12,32}$");
    private static final Duration DRAIN_TIMEOUT = Duration.ofSeconds(30);

    private final JdbcTemplate jdbcTemplate;
    private final RegressionActiveRequestTracker requestTracker;
    private final RegressionSharedAdminLoginGuard accessGuard;

    public RegressionFixtureController(
        @Qualifier("platformJdbcTemplate") JdbcTemplate jdbcTemplate,
        RegressionActiveRequestTracker requestTracker,
        RegressionSharedAdminLoginGuard accessGuard
    ) {
        this.jdbcTemplate = jdbcTemplate;
        this.requestTracker = requestTracker;
        this.accessGuard = accessGuard;
    }

    @PostMapping("/regression-request-fence")
    @WriteAccess(Policy.MANAGE_REGRESSION_REQUEST_FENCE)
    public Map<String, Object> manage(
        HttpServletRequest servletRequest,
        @RequestBody FenceRequest request
    ) {
        var action = parseAction(request == null ? null : request.action());
        var userId = parseUserId(request == null ? null : request.userId());
        var username = parseUsername(request == null ? null : request.username());
        var expectedGeneration = parseGeneration(request == null ? null : request.generation());
        var authorization = accessGuard.requireFixtureControl(
            servletRequest,
            action == Action.CLOSE_AND_DRAIN,
            username,
            userId.toString(),
            expectedGeneration
        );
        var fixture = requireOwnedFixture(userId, username);
        var currentGeneration = Number.class.cast(fixture.get("sessionGeneration")).longValue();
        RegressionActiveRequestTracker.Snapshot snapshot;
        if (action == Action.OPEN) {
            if (authorization != RegressionSharedAdminLoginGuard.FixtureControlAuthorization.OWNER) {
                throw new ResponseStatusException(HttpStatus.FORBIDDEN, "回归恢复能力不可打开请求门");
            }
            if (!Boolean.TRUE.equals(fixture.get("enabled"))) {
                throw new ResponseStatusException(HttpStatus.CONFLICT, "仅可为已启用的回归测试身份打开请求门");
            }
            if (expectedGeneration != currentGeneration) {
                throw new ResponseStatusException(HttpStatus.CONFLICT, "回归测试身份请求门代际已失效");
            }
            snapshot = requestTracker.open(userId, expectedGeneration);
        } else {
            if (expectedGeneration > currentGeneration
                || (authorization == RegressionSharedAdminLoginGuard.FixtureControlAuthorization.OWNER
                    && expectedGeneration != currentGeneration)) {
                throw new ResponseStatusException(HttpStatus.CONFLICT, "回归测试身份请求门代际尚未生效");
            }
            snapshot = requestTracker.closeAndDrain(userId, expectedGeneration, DRAIN_TIMEOUT);
        }
        return Map.of(
            "state", snapshot.state().name(),
            "activeCount", snapshot.activeCount()
        );
    }

    private Map<String, Object> requireOwnedFixture(UUID userId, String username) {
        var rows = jdbcTemplate.queryForList("""
            SELECT enabled,
                   session_generation AS "sessionGeneration",
                   (created_by = id) AS "ownedCreated",
                   (updated_by = id) AS "ownedUpdated"
            FROM sys_user
            WHERE id = ?::uuid
              AND username = ?
            """, userId.toString(), username);
        if (rows.size() != 1
            || !Boolean.TRUE.equals(rows.getFirst().get("ownedCreated"))
            || !Boolean.TRUE.equals(rows.getFirst().get("ownedUpdated"))) {
            throw new ResponseStatusException(HttpStatus.FORBIDDEN, "回归测试身份所有权校验失败");
        }
        return rows.getFirst();
    }

    private Action parseAction(String rawAction) {
        if (rawAction == null || rawAction.isBlank()) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "缺少回归测试请求门动作");
        }
        try {
            return Action.valueOf(rawAction.trim().toUpperCase(Locale.ROOT));
        } catch (IllegalArgumentException exception) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "回归测试请求门动作不正确", exception);
        }
    }

    private UUID parseUserId(String rawUserId) {
        if (rawUserId == null || rawUserId.isBlank()) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "缺少回归测试用户 ID");
        }
        var normalized = rawUserId.trim().toLowerCase(Locale.ROOT);
        try {
            var userId = UUID.fromString(normalized);
            if (!userId.toString().equals(normalized)) {
                throw new IllegalArgumentException("non-canonical UUID");
            }
            return userId;
        } catch (IllegalArgumentException exception) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "回归测试用户 ID 不正确", exception);
        }
    }

    private String parseUsername(String rawUsername) {
        if (rawUsername == null || !rawUsername.equals(rawUsername.trim()) || !FIXTURE_USERNAME.matcher(rawUsername).matches()) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "回归测试用户名不在受控 r_ 命名空间");
        }
        return rawUsername;
    }

    private long parseGeneration(Long generation) {
        if (generation == null || generation < 0) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "回归测试请求门代际不正确");
        }
        return generation;
    }

    public record FenceRequest(String action, String userId, String username, Long generation) {
    }

    private enum Action {
        OPEN,
        CLOSE_AND_DRAIN
    }
}
