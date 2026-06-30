package com.jdy.erp.shared.application;

import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;

import com.jdy.erp.system.tenant.TenantContext;

@Service
public class OperationLogService {
    private final JdbcTemplate jdbcTemplate;

    public OperationLogService(JdbcTemplate jdbcTemplate) {
        this.jdbcTemplate = jdbcTemplate;
    }

    public void log(String module, String action, String targetType, String targetId, boolean success, String reason) {
        var context = TenantContext.current().orElse(null);
        var accountSetId = context == null || !context.isTenant() || context.accountSetId().isBlank() ? null : context.accountSetId();
        var accountSetCode = context == null ? "" : context.accountSetCode();
        var accountSetName = context == null ? "" : context.accountSetName();
        jdbcTemplate.update("""
            INSERT INTO sys_operation_log (
                module_code, action_code, target_type, target_id, success, failure_reason,
                account_set_id, account_set_code, account_set_name
            )
            VALUES (?, ?, ?, ?::uuid, ?, ?, ?::uuid, ?, ?)
            """, module, action, targetType, targetId, success, reason, accountSetId, accountSetCode, accountSetName);
    }
}
