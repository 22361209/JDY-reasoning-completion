package com.jdy.erp.system.security;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatCode;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Set;
import java.util.UUID;

import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;

@SpringBootTest
class PasswordResetRateLimiterIntegrationTest {
    @Autowired
    private PasswordResetRequestProperties productionProperties;

    private final Set<String> cleanupKeys = new LinkedHashSet<>();

    @AfterEach
    void cleanupRedisKeys() {
        if (!cleanupKeys.isEmpty()) {
            var command = new ArrayList<String>();
            command.add("DEL");
            command.addAll(cleanupKeys);
            redisCommand(command);
        }
    }

    @Test
    void productionDefaultsAreEnabledAndBounded() {
        assertThat(productionProperties.globalWindow()).isEqualTo(Duration.ofMinutes(1));
        assertThat(productionProperties.globalMaxAttempts()).isEqualTo(100);
        assertThat(productionProperties.sourceWindow()).isEqualTo(Duration.ofMinutes(10));
        assertThat(productionProperties.sourceMaxAttempts()).isEqualTo(10);
        assertThat(productionProperties.accountCooldown()).isEqualTo(Duration.ofMinutes(15));
        assertThat(productionProperties.accountMaxAttempts()).isEqualTo(1);
        assertThat(productionProperties.maxPending()).isEqualTo(50);
        assertThat(productionProperties.pendingExpiry()).isEqualTo(Duration.ofHours(72));
        assertThat(productionProperties.historyRetention()).isEqualTo(Duration.ofDays(90));
        assertThat(productionProperties.cleanupBatchSize()).isEqualTo(500);
        assertThatCode(() -> PasswordResetRequestProperties.validateProfileLimits(productionProperties))
            .doesNotThrowAnyException();
    }

    @Test
    void onlyExclusivelyNonProductionProfilesMayRelaxRedisLimits() {
        var relaxed = properties(1_000, 1_000, 2);

        assertThatCode(() -> PasswordResetRequestProperties.validateProfileLimits(relaxed, "local"))
            .doesNotThrowAnyException();
        assertThatCode(() -> PasswordResetRequestProperties.validateProfileLimits(relaxed, "test", "regression"))
            .doesNotThrowAnyException();
        assertThatThrownBy(() -> PasswordResetRequestProperties.validateProfileLimits(relaxed))
            .isInstanceOf(IllegalStateException.class);
        assertThatThrownBy(() -> PasswordResetRequestProperties.validateProfileLimits(relaxed, "production"))
            .isInstanceOf(IllegalStateException.class);
        assertThatThrownBy(() -> PasswordResetRequestProperties.validateProfileLimits(relaxed, "LOCAL"))
            .isInstanceOf(IllegalStateException.class);
        assertThatThrownBy(() -> PasswordResetRequestProperties.validateProfileLimits(relaxed, "local", "production"))
            .isInstanceOf(IllegalStateException.class);
    }

    @Test
    void accountLimitRejectsAtomicallyWithoutIncrementingGlobalOrSource() {
        var properties = properties(10, 10, 1);
        var limiter = new PasswordResetRateLimiter(properties);
        var source = "192.0.2.10";
        var username = "a135-account-user";
        var keys = limiter.keyNames(source, username);
        cleanupKeys.addAll(keys);

        assertThat(limiter.tryAcquire(source, username)).isTrue();
        assertThat(limiter.tryAcquire(source, username)).isFalse();

        assertThat(redisGet(keys.get(0))).isEqualTo("1");
        assertThat(redisGet(keys.get(1))).isEqualTo("1");
        assertThat(redisGet(keys.get(2))).isEqualTo("1");
        assertBoundedTtl(keys.get(0), properties.globalWindow());
        assertBoundedTtl(keys.get(1), properties.sourceWindow());
        assertBoundedTtl(keys.get(2), properties.accountCooldown());
        assertThat(keys).allMatch(key -> !key.contains(source) && !key.contains(username));
    }

    @Test
    void sourceAndGlobalLimitsDoNotCreateOrIncrementAnyKeyAfterRejection() {
        var sourceProperties = properties(10, 2, 1);
        var sourceLimiter = new PasswordResetRateLimiter(sourceProperties);
        var source = "192.0.2.20";
        var firstKeys = sourceLimiter.keyNames(source, "a135-source-a");
        var secondKeys = sourceLimiter.keyNames(source, "a135-source-b");
        var rejectedKeys = sourceLimiter.keyNames(source, "a135-source-c");
        cleanupKeys.addAll(firstKeys);
        cleanupKeys.addAll(secondKeys);
        cleanupKeys.addAll(rejectedKeys);

        assertThat(sourceLimiter.tryAcquire(source, "a135-source-a")).isTrue();
        assertThat(sourceLimiter.tryAcquire(source, "a135-source-b")).isTrue();
        assertThat(sourceLimiter.tryAcquire(source, "a135-source-c")).isFalse();
        assertThat(redisGet(firstKeys.get(0))).isEqualTo("2");
        assertThat(redisGet(firstKeys.get(1))).isEqualTo("2");
        assertThat(redisGet(rejectedKeys.get(2))).isNull();

        cleanupRedisKeys();
        cleanupKeys.clear();

        var globalProperties = properties(2, 10, 1);
        var globalLimiter = new PasswordResetRateLimiter(globalProperties);
        var globalA = globalLimiter.keyNames("192.0.2.31", "a135-global-a");
        var globalB = globalLimiter.keyNames("192.0.2.32", "a135-global-b");
        var globalRejected = globalLimiter.keyNames("192.0.2.33", "a135-global-c");
        cleanupKeys.addAll(globalA);
        cleanupKeys.addAll(globalB);
        cleanupKeys.addAll(globalRejected);

        assertThat(globalLimiter.tryAcquire("192.0.2.31", "a135-global-a")).isTrue();
        assertThat(globalLimiter.tryAcquire("192.0.2.32", "a135-global-b")).isTrue();
        assertThat(globalLimiter.tryAcquire("192.0.2.33", "a135-global-c")).isFalse();
        assertThat(redisGet(globalA.get(0))).isEqualTo("2");
        assertThat(redisGet(globalRejected.get(1))).isNull();
        assertThat(redisGet(globalRejected.get(2))).isNull();
    }

    @Test
    void redisFailureFailsClosed() {
        var properties = properties(10, 10, 1);
        var limiter = new PasswordResetRateLimiter(properties) {
            @Override
            protected Long execute(java.util.List<String> keys, String... arguments) {
                throw new IllegalStateException("redis unavailable");
            }
        };

        assertThat(limiter.tryAcquire("192.0.2.40", "a135-failure-user")).isFalse();
    }

    private PasswordResetRequestProperties properties(int globalMax, int sourceMax, int accountMax) {
        return new PasswordResetRequestProperties(
            "a135:test:{password-reset-" + UUID.randomUUID() + "}",
            productionProperties.redisHost(),
            productionProperties.redisPort(),
            Duration.ofSeconds(1),
            Duration.ofSeconds(1),
            Duration.ofMinutes(1),
            globalMax,
            Duration.ofMinutes(2),
            sourceMax,
            Duration.ofMinutes(3),
            accountMax,
            50,
            Duration.ofHours(72),
            Duration.ofDays(90),
            10,
            3_600_000,
            60_000
        );
    }

    private void assertBoundedTtl(String key, Duration maximum) {
        var ttl = Long.parseLong(redisCommand(List.of("PTTL", key)));
        assertThat(ttl).isPositive().isLessThanOrEqualTo(maximum.toMillis());
    }

    private String redisGet(String key) {
        return redisCommand(List.of("GET", key));
    }

    private String redisCommand(List<String> command) {
        try (var socket = new Socket()) {
            socket.connect(
                new InetSocketAddress(productionProperties.redisHost(), productionProperties.redisPort()),
                1_000
            );
            socket.setSoTimeout(1_000);
            writeCommand(socket.getOutputStream(), command);
            return readReply(socket.getInputStream());
        } catch (IOException error) {
            throw new IllegalStateException("Redis test command failed", error);
        }
    }

    private void writeCommand(OutputStream output, List<String> command) throws IOException {
        output.write(("*" + command.size() + "\r\n").getBytes(StandardCharsets.US_ASCII));
        for (var argument : command) {
            var bytes = argument.getBytes(StandardCharsets.UTF_8);
            output.write(("$" + bytes.length + "\r\n").getBytes(StandardCharsets.US_ASCII));
            output.write(bytes);
            output.write("\r\n".getBytes(StandardCharsets.US_ASCII));
        }
        output.flush();
    }

    private String readReply(InputStream input) throws IOException {
        var type = input.read();
        if (type == ':' || type == '+') {
            return readLine(input);
        }
        if (type == '$') {
            var length = Integer.parseInt(readLine(input));
            if (length < 0) {
                return null;
            }
            var bytes = input.readNBytes(length);
            if (bytes.length != length || input.read() != '\r' || input.read() != '\n') {
                throw new IOException("incomplete Redis bulk reply");
            }
            return new String(bytes, StandardCharsets.UTF_8);
        }
        if (type == '-') {
            throw new IllegalStateException("Redis test error: " + readLine(input));
        }
        throw new IOException("unexpected Redis reply type " + type);
    }

    private String readLine(InputStream input) throws IOException {
        var buffer = new ByteArrayOutputStream();
        while (true) {
            var value = input.read();
            if (value < 0) {
                throw new IOException("incomplete Redis line");
            }
            if (value == '\r') {
                if (input.read() != '\n') {
                    throw new IOException("invalid Redis line ending");
                }
                return buffer.toString(StandardCharsets.UTF_8);
            }
            buffer.write(value);
        }
    }
}
