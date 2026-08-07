package com.jdy.erp.testsupport;

import java.util.UUID;

import org.springframework.jdbc.core.JdbcTemplate;

/** Test-only ADMIN identity.  Never authenticate integration tests as the shared admin. */
public final class IsolatedAdminFixture {
    public static final String PASSWORD = "a119-fixture-password";

    private IsolatedAdminFixture() {
    }

    public static Identity create(JdbcTemplate platformJdbcTemplate, String label) {
        var username = "a119-" + label + "-" + UUID.randomUUID().toString().substring(0, 8).toLowerCase();
        var id = platformJdbcTemplate.queryForObject("""
            INSERT INTO sys_user (username, display_name, password_hash, enabled, default_account_set_id)
            SELECT ?, 'A119 isolated integration fixture', ?, TRUE, id
            FROM sys_account_set WHERE code = 'BLD-TEST'
            RETURNING id::text
            """, String.class, username, "{noop}" + PASSWORD);
        platformJdbcTemplate.update("""
            INSERT INTO sys_user_role (user_id, role_id)
            SELECT ?::uuid, id FROM sys_role WHERE code = 'ADMIN'
            """, id);
        platformJdbcTemplate.update("""
            INSERT INTO sys_user_account_set (user_id, account_set_id, role_code, is_default, enabled)
            SELECT ?::uuid, id, 'ADMIN', TRUE, TRUE FROM sys_account_set WHERE code = 'BLD-TEST'
            """, id);
        return new Identity(username, id);
    }

    public static void remove(JdbcTemplate platformJdbcTemplate, Identity identity) {
        if (identity == null) return;
        platformJdbcTemplate.update("DELETE FROM sys_operation_log WHERE actor_username = ? OR operated_by = ?::uuid",
            identity.username(), identity.id());
        platformJdbcTemplate.update("DELETE FROM sys_session_account_scope WHERE user_id = ?::uuid", identity.id());
        platformJdbcTemplate.update("DELETE FROM sys_user_account_set WHERE user_id = ?::uuid", identity.id());
        platformJdbcTemplate.update("DELETE FROM sys_user_role WHERE user_id = ?::uuid", identity.id());
        platformJdbcTemplate.update("DELETE FROM sys_user WHERE id = ?::uuid", identity.id());
    }

    public record Identity(String username, String id) {
    }
}
