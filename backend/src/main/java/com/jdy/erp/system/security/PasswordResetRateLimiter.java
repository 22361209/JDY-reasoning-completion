package com.jdy.erp.system.security;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.ArrayList;
import java.util.HexFormat;
import java.util.List;
import java.util.concurrent.atomic.AtomicLong;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Component;

@Component
public class PasswordResetRateLimiter {
    private static final Logger LOGGER = LoggerFactory.getLogger(PasswordResetRateLimiter.class);
    private static final long WARNING_INTERVAL_MS = 60_000L;
    private static final String RATE_LIMIT_SCRIPT = """
        local global_count = tonumber(redis.call('GET', KEYS[1]) or '0')
        local source_count = tonumber(redis.call('GET', KEYS[2]) or '0')
        local account_count = tonumber(redis.call('GET', KEYS[3]) or '0')

        if global_count >= tonumber(ARGV[1])
            or source_count >= tonumber(ARGV[2])
            or account_count >= tonumber(ARGV[3]) then
            return 0
        end

        local function increment_with_ttl(key, ttl)
            local count = redis.call('INCR', key)
            if count == 1 then
                redis.call('PEXPIRE', key, ttl)
            end
        end

        increment_with_ttl(KEYS[1], ARGV[4])
        increment_with_ttl(KEYS[2], ARGV[5])
        increment_with_ttl(KEYS[3], ARGV[6])
        return 1
        """;

    private final PasswordResetRequestProperties properties;
    private final AtomicLong nextWarningAt = new AtomicLong();

    public PasswordResetRateLimiter(PasswordResetRequestProperties properties) {
        this.properties = properties;
    }

    public boolean tryAcquire(String remoteAddress, String username) {
        var keys = keyNames(remoteAddress, username);
        try {
            var result = execute(
                keys,
                Integer.toString(properties.globalMaxAttempts()),
                Integer.toString(properties.sourceMaxAttempts()),
                Integer.toString(properties.accountMaxAttempts()),
                Long.toString(properties.globalWindow().toMillis()),
                Long.toString(properties.sourceWindow().toMillis()),
                Long.toString(properties.accountCooldown().toMillis())
            );
            return Long.valueOf(1L).equals(result);
        } catch (RuntimeException error) {
            warnUnavailable(error);
            return false;
        }
    }

    protected Long execute(List<String> keys, String... arguments) {
        var command = new ArrayList<String>(2 + keys.size() + arguments.length);
        command.add("EVAL");
        command.add(RATE_LIMIT_SCRIPT);
        command.add(Integer.toString(keys.size()));
        command.addAll(keys);
        command.addAll(List.of(arguments));
        try (var socket = new Socket()) {
            socket.connect(
                new InetSocketAddress(properties.redisHost(), properties.redisPort()),
                Math.toIntExact(properties.redisConnectTimeout().toMillis())
            );
            socket.setSoTimeout(Math.toIntExact(properties.redisReadTimeout().toMillis()));
            writeCommand(socket.getOutputStream(), command);
            return readIntegerReply(socket.getInputStream());
        } catch (IOException error) {
            throw new IllegalStateException("Redis EVAL 执行失败", error);
        }
    }

    List<String> keyNames(String remoteAddress, String username) {
        var prefix = properties.redisKeyPrefix();
        return List.of(
            prefix + ":global",
            prefix + ":source:" + sha256(remoteAddress),
            prefix + ":account:" + sha256(username)
        );
    }

    private String sha256(String value) {
        try {
            var digest = MessageDigest.getInstance("SHA-256");
            return HexFormat.of().formatHex(digest.digest(normalized(value).getBytes(StandardCharsets.UTF_8)));
        } catch (NoSuchAlgorithmException error) {
            throw new IllegalStateException("JVM 缺少 SHA-256", error);
        }
    }

    private String normalized(String value) {
        return value == null ? "" : value.trim();
    }

    private void warnUnavailable(RuntimeException error) {
        var now = System.currentTimeMillis();
        var next = nextWarningAt.get();
        if (now >= next && nextWarningAt.compareAndSet(next, now + WARNING_INTERVAL_MS)) {
            LOGGER.warn("密码找回 Redis 限流不可用，本次申请已 fail-closed 且未持久化", error);
        }
    }

    private void writeCommand(OutputStream output, List<String> command) throws IOException {
        writeAscii(output, "*" + command.size() + "\r\n");
        for (var argument : command) {
            var bytes = argument.getBytes(StandardCharsets.UTF_8);
            writeAscii(output, "$" + bytes.length + "\r\n");
            output.write(bytes);
            writeAscii(output, "\r\n");
        }
        output.flush();
    }

    private Long readIntegerReply(InputStream input) throws IOException {
        var type = input.read();
        if (type == ':') {
            return Long.parseLong(readLine(input));
        }
        if (type == '-') {
            throw new IllegalStateException("Redis EVAL 拒绝执行：" + readLine(input));
        }
        throw new IllegalStateException("Redis EVAL 返回类型不正确：" + type);
    }

    private String readLine(InputStream input) throws IOException {
        var buffer = new ByteArrayOutputStream();
        while (true) {
            var value = input.read();
            if (value < 0) {
                throw new IOException("Redis 响应提前结束");
            }
            if (value == '\r') {
                if (input.read() != '\n') {
                    throw new IOException("Redis 响应行结束符不正确");
                }
                return buffer.toString(StandardCharsets.UTF_8);
            }
            buffer.write(value);
        }
    }

    private void writeAscii(OutputStream output, String value) throws IOException {
        output.write(value.getBytes(StandardCharsets.US_ASCII));
    }
}
