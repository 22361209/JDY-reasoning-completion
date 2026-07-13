package com.jdy.erp.system.application;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.function.Function;
import java.util.stream.Collectors;

import com.jdy.erp.shared.application.OperationLogCommand;
import com.jdy.erp.shared.application.OperationLogService;
import com.jdy.erp.system.security.CurrentSessionService;
import com.jdy.erp.system.tenant.TenantContext;
import jakarta.servlet.http.HttpSession;
import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.dao.DataIntegrityViolationException;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;
import org.springframework.web.context.request.RequestContextHolder;
import org.springframework.web.context.request.ServletRequestAttributes;
import org.springframework.web.server.ResponseStatusException;

@Service
public class EmployeeAccountLinkService {
    private final JdbcTemplate platformJdbcTemplate;
    private final JdbcTemplate tenantJdbcTemplate;
    private final CurrentSessionService currentSessionService;
    private final OperationLogService operationLogService;
    private final TransactionTemplate platformTransactions;

    public EmployeeAccountLinkService(
        @Qualifier("platformJdbcTemplate") JdbcTemplate platformJdbcTemplate,
        JdbcTemplate tenantJdbcTemplate,
        CurrentSessionService currentSessionService,
        OperationLogService operationLogService,
        @Qualifier("platformTransactionManager") PlatformTransactionManager platformTransactionManager
    ) {
        this.platformJdbcTemplate = platformJdbcTemplate;
        this.tenantJdbcTemplate = tenantJdbcTemplate;
        this.currentSessionService = currentSessionService;
        this.operationLogService = operationLogService;
        this.platformTransactions = new TransactionTemplate(platformTransactionManager);
    }

    public List<Map<String, Object>> currentAccountLinks() {
        var tenant = requireCurrentSessionTenant();
        var session = requireCurrentSession();
        var scopeToken = currentScopeToken(tenant, session, false);
        return currentAccountLinks(tenant, scopeToken);
    }

    private List<Map<String, Object>> currentAccountLinks(TenantContext.Snapshot tenant, String scopeToken) {
        var grants = platformJdbcTemplate.queryForList("""
            SELECT uas.id::text AS "grantId",
                   u.username,
                   COALESCE(uas.employee_code, '') AS "employeeCode",
                   uas.version AS "grantVersion"
            FROM sys_user_account_set uas
            JOIN sys_user u ON u.id = uas.user_id
            WHERE uas.account_set_id = ?::uuid
              AND uas.enabled = TRUE
            ORDER BY u.username
            """, tenant.accountSetId());
        var employeeCodes = grants.stream()
            .map(row -> String.valueOf(row.get("employeeCode")))
            .filter(code -> !code.isBlank())
            .distinct()
            .toList();
        var employees = employeesByCode(employeeCodes);
        var result = new ArrayList<Map<String, Object>>(grants.size());
        for (var grant : grants) {
            var employeeCode = String.valueOf(grant.get("employeeCode"));
            var employee = employees.get(employeeCode);
            var row = new LinkedHashMap<String, Object>();
            row.put("grantId", grant.get("grantId"));
            row.put("username", grant.get("username"));
            row.put("grantVersion", grant.get("grantVersion"));
            row.put("scopeToken", scopeToken);
            row.put("employeeCode", employeeCode);
            row.put("employeeName", employee == null ? "" : employee.get("name"));
            row.put("employeeEnabled", employee != null && Boolean.TRUE.equals(employee.get("enabled")));
            row.put("employeeAuditStatus", employee == null ? "" : employee.get("auditStatus"));
            result.add(row);
        }
        return List.copyOf(result);
    }

    public List<Map<String, Object>> saveCurrentAccountLink(
        String username,
        String employeeCode,
        long version,
        String scopeToken
    ) {
        var normalizedUsername = required(username, "用户名", 80);
        if (version < 0) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "授权版本不正确");
        }
        var tenant = requireCurrentSessionTenant();
        var session = requireCurrentSession();
        var normalizedScopeToken = required(scopeToken, "账套作用域令牌", 80);
        return platformTransactions.execute(ignored -> {
            var currentScopeToken = currentScopeToken(tenant, session, true);
            if (!currentScopeToken.equals(normalizedScopeToken)) {
                throw new ResponseStatusException(HttpStatus.CONFLICT, "当前会话账套已变化，请刷新后重试");
            }
            return saveCurrentAccountLink(
                tenant,
                normalizedUsername,
                employeeCode,
                version,
                currentScopeToken
            );
        });
    }

    private List<Map<String, Object>> saveCurrentAccountLink(
        TenantContext.Snapshot tenant,
        String normalizedUsername,
        String employeeCode,
        long version,
        String scopeToken
    ) {
        var normalizedEmployeeCode = normalizedEmployeeCode(employeeCode);
        var grants = platformJdbcTemplate.queryForList("""
            SELECT uas.id::text AS id,
                   COALESCE(uas.employee_code, '') AS "employeeCode",
                   uas.version
            FROM sys_user_account_set uas
            JOIN sys_user u ON u.id = uas.user_id
            WHERE u.username = ?
              AND uas.account_set_id = ?::uuid
              AND uas.enabled = TRUE
            FOR UPDATE OF uas
            """, normalizedUsername, tenant.accountSetId());
        if (grants.isEmpty()) {
            throw new ResponseStatusException(HttpStatus.CONFLICT, "目标用户没有当前账套授权");
        }
        var grant = grants.getFirst();
        var currentVersion = Number.class.cast(grant.get("version")).longValue();
        if (currentVersion != version) {
            throw new ResponseStatusException(HttpStatus.CONFLICT, "账套授权版本已变化，请刷新后重试");
        }
        var previousEmployeeCode = String.valueOf(grant.get("employeeCode"));
        if (normalizedEmployeeCode != null) {
            requireLinkableEmployee(normalizedEmployeeCode);
        }
        var nextEmployeeCode = normalizedEmployeeCode == null ? "" : normalizedEmployeeCode;
        if (previousEmployeeCode.equals(nextEmployeeCode)) {
            return currentAccountLinks(tenant, scopeToken);
        }
        int updated;
        try {
            updated = platformJdbcTemplate.update("""
                UPDATE sys_user_account_set
                SET employee_code = ?,
                    updated_at = now(),
                    version = version + 1
                WHERE id = ?::uuid
                  AND account_set_id = ?::uuid
                  AND enabled = TRUE
                  AND version = ?
                """, normalizedEmployeeCode, grant.get("id"), tenant.accountSetId(), version);
        } catch (DataIntegrityViolationException exception) {
            throw new ResponseStatusException(HttpStatus.CONFLICT, "该员工已关联当前账套中的其他账号", exception);
        }
        if (updated != 1) {
            throw new ResponseStatusException(HttpStatus.CONFLICT, "账套授权版本已变化，请刷新后重试");
        }
        var action = normalizedEmployeeCode == null ? "UNLINK_EMPLOYEE_ACCOUNT" : "LINK_EMPLOYEE_ACCOUNT";
        var loggedEmployeeCode = normalizedEmployeeCode == null ? previousEmployeeCode : normalizedEmployeeCode;
        operationLogService.logTenant(new OperationLogService.TenantTarget(
            UUID.fromString(tenant.accountSetId()),
            tenant.accountSetCode(),
            tenant.accountSetName(),
            tenant.schemaName()
        ), OperationLogCommand.success(
            "SYSTEM",
            action,
            "sys_user_account_set",
            UUID.fromString(String.valueOf(grant.get("id"))),
            normalizedUsername + ":" + loggedEmployeeCode,
            OperationLogCommand.ActorMode.CURRENT_USER,
            null,
            Map.of(),
            Map.of(),
            "employeeCode=" + loggedEmployeeCode
        ));
        return currentAccountLinks(tenant, scopeToken);
    }

    private TenantContext.Snapshot requireCurrentSessionTenant() {
        final TenantContext.Snapshot tenant;
        try {
            tenant = TenantContext.requireTenant();
        } catch (IllegalStateException exception) {
            throw new ResponseStatusException(HttpStatus.CONFLICT, "员工关联必须在当前账套上下文执行", exception);
        }
        var sessionAccountSetId = currentSessionService.currentAccountSetId();
        if (!tenant.accountSetId().equals(sessionAccountSetId)) {
            throw new ResponseStatusException(HttpStatus.CONFLICT, "当前会话账套已变化，请刷新后重试");
        }
        return tenant;
    }

    private HttpSession requireCurrentSession() {
        var attributes = RequestContextHolder.getRequestAttributes();
        if (!(attributes instanceof ServletRequestAttributes servletAttributes)) {
            throw new ResponseStatusException(HttpStatus.UNAUTHORIZED, "请先登录");
        }
        var session = servletAttributes.getRequest().getSession(false);
        if (session == null) {
            throw new ResponseStatusException(HttpStatus.UNAUTHORIZED, "请先登录");
        }
        return session;
    }

    private String currentScopeToken(TenantContext.Snapshot tenant, HttpSession session, boolean lock) {
        var sessionAccountSetId = sessionAttribute(session, CurrentSessionService.SESSION_ACCOUNT_SET_ID);
        var sessionAccountSetCode = sessionAttribute(session, CurrentSessionService.SESSION_ACCOUNT_SET_CODE);
        var sessionUsername = sessionAttribute(session, CurrentSessionService.SESSION_USERNAME);
        if (!tenant.accountSetId().equals(sessionAccountSetId)
            || !tenant.accountSetCode().equals(sessionAccountSetCode)) {
            throw new ResponseStatusException(HttpStatus.CONFLICT, "当前会话账套已变化，请刷新后重试");
        }
        var sessionToken = requiredSessionUuid(
            sessionAttribute(session, CurrentSessionService.SESSION_TOKEN),
            "当前会话账套作用域已失效，请重新登录"
        );
        var sessionScopeToken = requiredSessionUuid(
            sessionAttribute(session, CurrentSessionService.SESSION_ACCOUNT_SET_SCOPE_TOKEN),
            "当前会话账套作用域已失效，请重新登录"
        );
        var rows = platformJdbcTemplate.queryForList("""
            SELECT scope.account_set_id::text AS "accountSetId",
                   account_set.code AS "accountSetCode",
                   scope.scope_token::text AS "scopeToken",
                   account_user.username
            FROM sys_session_account_scope scope
            JOIN sys_user account_user ON account_user.id = scope.user_id
            JOIN sys_account_set account_set ON account_set.id = scope.account_set_id
            WHERE scope.session_token = ?::uuid
            %s
            """.formatted(lock ? "FOR UPDATE OF scope" : ""), sessionToken);
        if (rows.size() != 1) {
            throw new ResponseStatusException(HttpStatus.CONFLICT, "当前会话账套作用域已失效，请重新登录");
        }
        var authority = rows.getFirst();
        if (!tenant.accountSetId().equals(String.valueOf(authority.get("accountSetId")))
            || !tenant.accountSetCode().equals(String.valueOf(authority.get("accountSetCode")))
            || !sessionScopeToken.equals(String.valueOf(authority.get("scopeToken")))
            || sessionUsername == null
            || !sessionUsername.equals(String.valueOf(authority.get("username")))) {
            throw new ResponseStatusException(HttpStatus.CONFLICT, "当前会话账套已变化，请刷新后重试");
        }
        return sessionScopeToken;
    }

    private String requiredSessionUuid(String value, String message) {
        if (value == null || value.isBlank()) {
            throw new ResponseStatusException(HttpStatus.CONFLICT, message);
        }
        try {
            return UUID.fromString(value).toString();
        } catch (IllegalArgumentException exception) {
            throw new ResponseStatusException(HttpStatus.CONFLICT, message, exception);
        }
    }

    private String sessionAttribute(HttpSession session, String name) {
        var value = session.getAttribute(name);
        return value == null ? null : String.valueOf(value);
    }

    private void requireLinkableEmployee(String employeeCode) {
        var rows = tenantJdbcTemplate.queryForList("""
            SELECT enabled, audit_status AS "auditStatus"
            FROM md_employee
            WHERE code = ?
            """, employeeCode);
        if (rows.isEmpty()) {
            throw new ResponseStatusException(HttpStatus.NOT_FOUND, "当前账套员工不存在");
        }
        var employee = rows.getFirst();
        if (!Boolean.TRUE.equals(employee.get("enabled")) || !"AUDITED".equals(employee.get("auditStatus"))) {
            throw new ResponseStatusException(HttpStatus.CONFLICT, "只能关联已审核且启用的员工");
        }
    }

    private Map<String, Map<String, Object>> employeesByCode(List<String> employeeCodes) {
        if (employeeCodes.isEmpty()) {
            return Map.of();
        }
        var placeholders = String.join(", ", employeeCodes.stream().map(ignored -> "?").toList());
        return tenantJdbcTemplate.queryForList("""
            SELECT code,
                   name,
                   enabled,
                   audit_status AS "auditStatus"
            FROM md_employee
            WHERE code IN (%s)
            """.formatted(placeholders), employeeCodes.toArray()).stream().collect(Collectors.toMap(
                row -> String.valueOf(row.get("code")),
                Function.identity()
            ));
    }

    private String required(String value, String label, int maxLength) {
        var normalized = optional(value, label, maxLength);
        if (normalized == null) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, label + "不能为空");
        }
        return normalized;
    }

    private String optional(String value, String label, int maxLength) {
        if (value == null || value.isBlank()) {
            return null;
        }
        var normalized = value.trim();
        if (normalized.length() > maxLength) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, label + "不能超过" + maxLength + "个字符");
        }
        return normalized;
    }

    private String normalizedEmployeeCode(String value) {
        if (value == null) {
            return null;
        }
        if (value.isBlank()) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "解除关联必须显式提交 employeeCode: null");
        }
        return optional(value, "员工编码", 80);
    }
}
