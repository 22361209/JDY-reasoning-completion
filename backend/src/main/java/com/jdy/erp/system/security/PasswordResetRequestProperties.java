package com.jdy.erp.system.security;

import java.time.Duration;
import java.util.Arrays;
import java.util.Set;

import org.springframework.beans.factory.SmartInitializingSingleton;
import org.springframework.boot.context.properties.ConfigurationProperties;
import org.springframework.boot.context.properties.EnableConfigurationProperties;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.core.env.Environment;

@ConfigurationProperties(prefix = "jdy.security.password-reset")
public record PasswordResetRequestProperties(
    String redisKeyPrefix,
    String redisHost,
    int redisPort,
    Duration redisConnectTimeout,
    Duration redisReadTimeout,
    Duration globalWindow,
    int globalMaxAttempts,
    Duration sourceWindow,
    int sourceMaxAttempts,
    Duration accountCooldown,
    int accountMaxAttempts,
    int maxPending,
    Duration pendingExpiry,
    Duration historyRetention,
    int cleanupBatchSize,
    long cleanupFixedDelayMs,
    long cleanupInitialDelayMs
) {
    private static final Set<String> RELAXED_PROFILES = Set.of("local", "test", "regression");

    public PasswordResetRequestProperties {
        if (redisKeyPrefix == null || redisKeyPrefix.isBlank() || !redisKeyPrefix.matches(".*\\{[^{}]+}.*")) {
            throw new IllegalArgumentException("密码找回 Redis key 前缀必须包含 hash tag");
        }
        if (redisHost == null || redisHost.isBlank() || redisPort <= 0 || redisPort > 65_535) {
            throw new IllegalArgumentException("密码找回 Redis 连接配置不合法");
        }
        requirePositive(redisConnectTimeout, "redisConnectTimeout");
        requirePositive(redisReadTimeout, "redisReadTimeout");
        if (redisConnectTimeout.toMillis() > Integer.MAX_VALUE || redisReadTimeout.toMillis() > Integer.MAX_VALUE) {
            throw new IllegalArgumentException("Redis 超时不得超过 Integer.MAX_VALUE 毫秒");
        }
        requirePositive(globalWindow, "globalWindow");
        requirePositive(sourceWindow, "sourceWindow");
        requirePositive(accountCooldown, "accountCooldown");
        requirePositive(pendingExpiry, "pendingExpiry");
        requirePositive(historyRetention, "historyRetention");
        requirePositive(globalMaxAttempts, "globalMaxAttempts");
        requirePositive(sourceMaxAttempts, "sourceMaxAttempts");
        requirePositive(accountMaxAttempts, "accountMaxAttempts");
        requirePositive(maxPending, "maxPending");
        requirePositive(cleanupBatchSize, "cleanupBatchSize");
        if (cleanupBatchSize > 500) {
            throw new IllegalArgumentException("cleanupBatchSize 不得超过 500");
        }
        if (cleanupFixedDelayMs <= 0 || cleanupInitialDelayMs < 0) {
            throw new IllegalArgumentException("清理任务时间配置不合法");
        }
    }

    private static void requirePositive(Duration value, String name) {
        if (value == null || value.isZero() || value.isNegative()) {
            throw new IllegalArgumentException(name + " 必须大于 0");
        }
    }

    private static void requirePositive(int value, String name) {
        if (value <= 0) {
            throw new IllegalArgumentException(name + " 必须大于 0");
        }
    }

    static void validateProfileLimits(PasswordResetRequestProperties properties, String... activeProfiles) {
        var relaxed = activeProfiles != null
            && activeProfiles.length > 0
            && Arrays.stream(activeProfiles)
                .map(profile -> profile == null ? "" : profile.trim())
                .allMatch(RELAXED_PROFILES::contains);
        if (relaxed) {
            return;
        }

        var relaxedLimit = properties.globalMaxAttempts() > 100
            || properties.sourceMaxAttempts() > 10
            || properties.accountMaxAttempts() > 1
            || properties.globalWindow().compareTo(Duration.ofMinutes(1)) < 0
            || properties.sourceWindow().compareTo(Duration.ofMinutes(10)) < 0
            || properties.accountCooldown().compareTo(Duration.ofMinutes(15)) < 0;
        if (relaxedLimit) {
            throw new IllegalStateException(
                "非 local/test/regression 环境不得放宽密码找回 Redis 门禁，activeProfiles="
                    + Arrays.toString(activeProfiles == null ? new String[0] : activeProfiles)
            );
        }
    }
}

@Configuration(proxyBeanMethods = false)
@EnableConfigurationProperties(PasswordResetRequestProperties.class)
class PasswordResetRequestConfiguration {
    @Bean
    SmartInitializingSingleton passwordResetProfileLimitGuard(
        PasswordResetRequestProperties properties,
        Environment environment
    ) {
        return () -> PasswordResetRequestProperties.validateProfileLimits(properties, environment.getActiveProfiles());
    }
}
