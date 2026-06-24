package com.jdy.erp.system.security;

import java.util.Map;

import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Component;
import org.springframework.web.server.ResponseStatusException;

@Component
public class PasswordPolicy {
    private static final int DEFAULT_MIN_LENGTH = 8;
    private static final int MIN_LENGTH = 6;
    private static final int MAX_LENGTH = 64;
    private static final String MIN_LENGTH_KEY = "security.password_min_length";
    private static final String REQUIRE_UPPERCASE_KEY = "security.password_require_uppercase";
    private static final String REQUIRE_LOWERCASE_KEY = "security.password_require_lowercase";
    private static final String REQUIRE_DIGIT_KEY = "security.password_require_digit";
    private static final String REQUIRE_SYMBOL_KEY = "security.password_require_symbol";

    private final JdbcTemplate jdbcTemplate;
    private final CurrentSessionService currentSessionService;

    public PasswordPolicy(JdbcTemplate jdbcTemplate, CurrentSessionService currentSessionService) {
        this.jdbcTemplate = jdbcTemplate;
        this.currentSessionService = currentSessionService;
    }

    public void validate(String password) {
        var policy = currentPolicy();
        if (password == null || password.isBlank()) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "密码不能为空");
        }
        if (password.length() < policy.minLength()) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "密码至少 " + policy.minLength() + " 位");
        }
        if (policy.requireUppercase() && !password.matches(".*[A-Z].*")) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "密码需包含大写字母");
        }
        if (policy.requireLowercase() && !password.matches(".*[a-z].*")) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "密码需包含小写字母");
        }
        if (policy.requireDigit() && !password.matches(".*\\d.*")) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "密码需包含数字");
        }
        if (policy.requireSymbol() && !password.matches(".*[^A-Za-z0-9].*")) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "密码需包含符号");
        }
    }

    public Policy currentPolicy() {
        return new Policy(
            settingInt(MIN_LENGTH_KEY, DEFAULT_MIN_LENGTH),
            settingBoolean(REQUIRE_UPPERCASE_KEY, true),
            settingBoolean(REQUIRE_LOWERCASE_KEY, true),
            settingBoolean(REQUIRE_DIGIT_KEY, true),
            settingBoolean(REQUIRE_SYMBOL_KEY, true)
        );
    }

    public Map<String, Object> currentPolicyMap() {
        var policy = currentPolicy();
        return Map.of(
            "minLength", policy.minLength(),
            "requireUppercase", policy.requireUppercase(),
            "requireLowercase", policy.requireLowercase(),
            "requireDigit", policy.requireDigit(),
            "requireSymbol", policy.requireSymbol()
        );
    }

    public void updatePolicy(Integer minLength, Boolean requireUppercase, Boolean requireLowercase, Boolean requireDigit, Boolean requireSymbol) {
        var normalizedMinLength = normalizeMinLength(minLength);
        var normalizedRequireUppercase = requireUppercase == null || requireUppercase;
        var normalizedRequireLowercase = requireLowercase == null || requireLowercase;
        var normalizedRequireDigit = requireDigit == null || requireDigit;
        var normalizedRequireSymbol = requireSymbol == null || requireSymbol;
        upsert(MIN_LENGTH_KEY, String.valueOf(normalizedMinLength));
        upsert(REQUIRE_UPPERCASE_KEY, String.valueOf(normalizedRequireUppercase));
        upsert(REQUIRE_LOWERCASE_KEY, String.valueOf(normalizedRequireLowercase));
        upsert(REQUIRE_DIGIT_KEY, String.valueOf(normalizedRequireDigit));
        upsert(REQUIRE_SYMBOL_KEY, String.valueOf(normalizedRequireSymbol));
        logSetting(
            "password_policy=minLength:" + normalizedMinLength
                + ",upper:" + normalizedRequireUppercase
                + ",lower:" + normalizedRequireLowercase
                + ",digit:" + normalizedRequireDigit
                + ",symbol:" + normalizedRequireSymbol
        );
    }

    private void upsert(String key, String value) {
        jdbcTemplate.update("""
            INSERT INTO sys_setting (setting_key, setting_value, updated_by)
            VALUES (?, ?, (SELECT id FROM sys_user WHERE username = ?))
            ON CONFLICT (setting_key) DO UPDATE
            SET setting_value = EXCLUDED.setting_value,
                updated_at = now(),
                updated_by = EXCLUDED.updated_by,
                version = sys_setting.version + 1
            """, key, value, currentSessionService.currentUsername());
    }

    private int settingInt(String key, int defaultValue) {
        var values = jdbcTemplate.queryForList("SELECT setting_value FROM sys_setting WHERE setting_key = ?", String.class, key);
        if (values.isEmpty()) {
            return defaultValue;
        }
        return normalizeMinLength(values.get(0));
    }

    private boolean settingBoolean(String key, boolean defaultValue) {
        var values = jdbcTemplate.queryForList("SELECT setting_value FROM sys_setting WHERE setting_key = ?", String.class, key);
        if (values.isEmpty()) {
            return defaultValue;
        }
        return Boolean.parseBoolean(values.get(0));
    }

    private int normalizeMinLength(Object rawValue) {
        int value;
        try {
            if (rawValue instanceof Number number) {
                value = number.intValue();
            } else {
                value = Integer.parseInt(String.valueOf(rawValue).trim());
            }
        } catch (RuntimeException exception) {
            value = DEFAULT_MIN_LENGTH;
        }
        if (value < MIN_LENGTH || value > MAX_LENGTH) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "密码最小长度需在 " + MIN_LENGTH + "-" + MAX_LENGTH + " 之间");
        }
        return value;
    }

    private void logSetting(String reason) {
        jdbcTemplate.update("""
            INSERT INTO sys_operation_log (module_code, action_code, target_type, success, failure_reason, operated_by)
            SELECT 'SYSTEM', 'UPDATE_SECURITY_SETTING', 'sys_setting', TRUE, ?, id
            FROM sys_user
            WHERE username = ?
            """, reason, currentSessionService.currentUsername());
    }

    public record Policy(int minLength, boolean requireUppercase, boolean requireLowercase, boolean requireDigit, boolean requireSymbol) {
    }
}
