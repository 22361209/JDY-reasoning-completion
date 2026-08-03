package com.jdy.erp.system.security;

import java.io.IOException;
import java.net.InetAddress;
import java.net.UnknownHostException;
import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.nio.channels.FileChannel;
import java.nio.file.NoSuchFileException;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.Path;
import java.nio.file.StandardOpenOption;
import java.nio.file.attribute.BasicFileAttributes;
import java.nio.file.attribute.PosixFileAttributes;
import java.nio.file.attribute.PosixFilePermission;
import java.nio.file.attribute.UserPrincipal;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.Arrays;
import java.util.Comparator;
import java.util.HashSet;
import java.util.HexFormat;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.regex.Pattern;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;

import jakarta.servlet.http.HttpServletRequest;

import com.jdy.erp.inventory.config.InventoryTestAdjustmentProperties;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.core.env.Environment;
import org.springframework.http.HttpStatus;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Component;
import org.springframework.web.server.ResponseStatusException;

@Component
public final class RegressionSharedAdminLoginGuard {
    private static final Logger LOG = LoggerFactory.getLogger(RegressionSharedAdminLoginGuard.class);
    private static final Set<String> ALLOWED_PROFILES = Set.of("local", "test", "regression");
    private static final String TEST_ACCOUNT_SET_CODE = "BLD-TEST";
    private static final String SHARED_ADMIN_USERNAME = "admin";
    private static final int MAIN_BACKEND_PORT = 8080;
    private static final String FENCE_CAPABILITY_HEADER = "X-JDY-Regression-Fence-Capability";
    private static final Pattern RUN_ID = Pattern.compile("^[0-9a-f]{32}$");
    private static final Pattern DIGEST = Pattern.compile("^[0-9a-f]{64}$");
    private static final Pattern FIXTURE_USERNAME = Pattern.compile("^r_[a-z0-9_]{1,58}_[0-9a-f]{12,32}$");
    private static final Pattern FIXTURE_USER_ID = Pattern.compile(
        "^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"
    );
    private static final Pattern RECOVERY_CLAIM = Pattern.compile("^recovery\\.claim\\.(\\d{6})$");
    private static final Set<PosixFilePermission> PRIVATE_DIRECTORY_PERMISSIONS = Set.of(
        PosixFilePermission.OWNER_READ,
        PosixFilePermission.OWNER_WRITE,
        PosixFilePermission.OWNER_EXECUTE
    );
    private static final Set<PosixFilePermission> PRIVATE_FILE_PERMISSIONS = Set.of(
        PosixFilePermission.OWNER_READ,
        PosixFilePermission.OWNER_WRITE
    );
    private static final Set<String> OWNER_KEYS = Set.of(
        "acquiredAt",
        "artifactBaseline",
        "childDetachedSpawnLedger",
        "childPid",
        "childProcessFingerprint",
        "childProcessGuardToken",
        "childProcessLedger",
        "childScript",
        "executionBaseline",
        "latestPublication",
        "ownerRevision",
        "parentProcessFingerprint",
        "pid",
        "requestFenceControlDigest",
        "requestFenceGeneration",
        "runId",
        "secretDir",
        "state",
        "tier",
        "userId",
        "username"
    );
    private static final Set<String> OWNER_STATES = Set.of(
        "creating",
        "baseline-ready",
        "preflight",
        "fixture-created",
        "running",
        "running-child",
        "cleanup",
        "docker-closure-incomplete",
        "process-ownership-incomplete",
        "artifact-residue",
        "release-ready"
    );
    private static final Set<String> RECOVERY_CLAIM_KEYS = Set.of(
        "acquiredAt",
        "epoch",
        "fixtureTargets",
        "parentProcessFingerprint",
        "pid",
        "staleOwner",
        "token"
    );
    private static final ObjectMapper OBJECT_MAPPER = new ObjectMapper();
    private static final long MAXIMUM_CONTROL_JSON_BYTES = 1024 * 1024;

    private final InventoryTestAdjustmentProperties properties;
    private final Environment environment;
    private final Path suiteLockDirectory;
    private final Object sharedAdminLoginMonitor = new Object();
    private int activeSharedAdminLoginCount;

    @Autowired
    public RegressionSharedAdminLoginGuard(
        InventoryTestAdjustmentProperties properties,
        Environment environment
    ) {
        this(
            properties,
            environment,
            Path.of(System.getProperty("java.io.tmpdir"), "jdy-erp-regression-suite.lock")
        );
    }

    RegressionSharedAdminLoginGuard(
        InventoryTestAdjustmentProperties properties,
        Environment environment,
        Path suiteLockDirectory
    ) {
        this.properties = properties;
        this.environment = environment;
        this.suiteLockDirectory = suiteLockDirectory;
    }

    public void rejectSharedAdminCredentialUse(String username, HttpServletRequest request) {
        if (!isSharedAdminUsername(username) || !isRegressionMainBackendRequest(request)) {
            return;
        }
        synchronized (sharedAdminLoginMonitor) {
            rejectIfSuiteLockExists();
        }
    }

    public void rejectSharedAdminSessionReplacement(String targetUsername, HttpServletRequest request) {
        if (!isRegressionMainBackendRequest(request) || !suiteLockExists()) {
            return;
        }
        var session = request.getSession(false);
        if (session == null) {
            return;
        }
        var existingUsername = session.getAttribute(CurrentSessionService.SESSION_USERNAME);
        if (existingUsername != null
            && isSharedAdminUsername(String.valueOf(existingUsername))
            && !isSharedAdminUsername(targetUsername)) {
            throw new ResponseStatusException(
                HttpStatus.LOCKED,
                "回归套件运行期间不能替换共享管理员会话"
            );
        }
    }

    public boolean isSharedAdminLoginGuardActive(HttpServletRequest request) {
        return isRegressionMainBackendRequest(request)
            && suiteLockExists();
    }

    public boolean shouldTrackPotentialSharedAdminLogin(HttpServletRequest request) {
        return shouldTrackPotentialSharedAdminCredentialUse(request);
    }

    public boolean shouldTrackPotentialSharedAdminCredentialUse(HttpServletRequest request) {
        // Password confirmation endpoints do not expose the submitted username to
        // the outer filter. Scope every local regression request so an admin
        // credential check that began immediately before lock publication stays
        // counted through the response/session-save boundary.
        return isRegressionMainBackendRequest(request);
    }

    public RegressionActiveRequestTracker.Lease beginSharedAdminLogin(
        String username,
        HttpServletRequest request
    ) {
        if (!isSharedAdminUsername(username) || !isRegressionMainBackendRequest(request)) {
            return null;
        }
        synchronized (sharedAdminLoginMonitor) {
            rejectIfSuiteLockExists();
            activeSharedAdminLoginCount += 1;
        }
        var closed = new AtomicBoolean();
        return () -> {
            if (!closed.compareAndSet(false, true)) {
                return;
            }
            synchronized (sharedAdminLoginMonitor) {
                if (activeSharedAdminLoginCount <= 0) {
                    throw new IllegalStateException("shared admin login tracker count underflow");
                }
                activeSharedAdminLoginCount -= 1;
                sharedAdminLoginMonitor.notifyAll();
            }
        };
    }

    public int activeSharedAdminLoginCount(HttpServletRequest request) {
        if (!isRegressionMainBackendRequest(request)) {
            return 0;
        }
        // This synchronized read is the drain barrier paired with beginSharedAdminLogin:
        // after the suite lock exists, an entrant is either already counted or rejected.
        synchronized (sharedAdminLoginMonitor) {
            return activeSharedAdminLoginCount;
        }
    }

    public FixtureControlAuthorization requireFixtureControl(
        HttpServletRequest request,
        boolean allowRecoveryClaim,
        String username,
        String userId,
        long generation
    ) {
        if (!isRegressionMainBackendRequest(request)
            || !isLoopback(request)) {
            throw new ResponseStatusException(HttpStatus.FORBIDDEN, "回归测试控制接口不可用");
        }
        try {
            var ownerSnapshot = readValidatedSuiteOwner();
            var capability = request.getHeader(FENCE_CAPABILITY_HEADER);
            if (capability == null || !RUN_ID.matcher(capability).matches()) {
                throw new ResponseStatusException(HttpStatus.FORBIDDEN, "回归测试控制能力无效");
            }
            var expectedDigest = ownerSnapshot.owner().path("requestFenceControlDigest").asText("");
            if (constantTimeEquals(sha256(capability), expectedDigest)) {
                return FixtureControlAuthorization.OWNER;
            }
            if (allowRecoveryClaim
                && recoveryClaimAuthorizes(ownerSnapshot, capability, username, userId, generation)) {
                return FixtureControlAuthorization.RECOVERY;
            }
        } catch (ResponseStatusException exception) {
            throw exception;
        } catch (IOException | RuntimeException exception) {
            // This endpoint is loopback-only and accepts only an opaque
            // capability. Log the validation class, never the capability nor
            // owner contents, so a preflight failure is diagnosable without
            // weakening the response boundary.
            LOG.warn("Regression fixture control metadata was rejected: {}", exception.getMessage());
            throw new ResponseStatusException(HttpStatus.FORBIDDEN, "回归测试控制接口不可用", exception);
        }
        throw new ResponseStatusException(HttpStatus.FORBIDDEN, "回归测试控制能力无效");
    }

    public FixtureControlAuthorization requireFixtureControl(HttpServletRequest request, boolean allowRecoveryClaim) {
        return requireFixtureControl(request, allowRecoveryClaim, "", "", -1L);
    }

    public boolean isRegressionTestCapabilityEnabled() {
        var activeProfiles = environment.getActiveProfiles();
        return activeProfiles.length > 0
            && Arrays.stream(activeProfiles).allMatch(ALLOWED_PROFILES::contains)
            && properties.enabled()
            && properties.allowedAccountSetCodes().contains(TEST_ACCOUNT_SET_CODE);
    }

    private boolean isRegressionMainBackendRequest(HttpServletRequest request) {
        return request != null
            && request.getLocalPort() == MAIN_BACKEND_PORT
            && isRegressionTestCapabilityEnabled();
    }

    private boolean isSharedAdminUsername(String username) {
        return username != null && SHARED_ADMIN_USERNAME.equalsIgnoreCase(username.trim());
    }

    private void rejectIfSuiteLockExists() {
        if (suiteLockExists()) {
            throw new ResponseStatusException(
                HttpStatus.LOCKED,
                "回归套件运行期间已禁用共享管理员登录"
            );
        }
    }

    private boolean suiteLockExists() {
        try {
            Files.readAttributes(
                suiteLockDirectory,
                BasicFileAttributes.class,
                LinkOption.NOFOLLOW_LINKS
            );
            return true;
        } catch (NoSuchFileException exception) {
            return false;
        } catch (IOException | SecurityException exception) {
            // Any uncertain residue at the canonical path is treated as an active
            // suite boundary for shared-admin login. Only a proven ENOENT is absent.
            return true;
        }
    }

    private SuiteOwnerSnapshot readValidatedSuiteOwner() throws IOException {
        var lock = readPrivateDirectory(suiteLockDirectory, null);
        var ownerPath = suiteLockDirectory.resolve("owner.json");
        var owner = readPrivateJson(ownerPath, lock.owner());
        var ownerFields = owner.isObject() ? fieldNames(owner) : Set.<String>of();
        if (!owner.isObject()
            || !ownerFields.equals(OWNER_KEYS)
            || !RUN_ID.matcher(owner.path("runId").asText("")).matches()
            || !DIGEST.matcher(owner.path("requestFenceControlDigest").asText("")).matches()
            || !DIGEST.matcher(owner.path("parentProcessFingerprint").asText("")).matches()
            || !FIXTURE_USERNAME.matcher(owner.path("username").asText("")).matches()
            || !OWNER_STATES.contains(owner.path("state").asText(""))
            || !owner.path("acquiredAt").isTextual()
            || !owner.path("tier").isTextual()
            || !owner.path("secretDir").isTextual()
            || !owner.path("userId").isTextual()
            || !owner.path("childProcessFingerprint").isTextual()
            || !owner.path("childProcessGuardToken").isTextual()
            || !owner.path("pid").canConvertToInt()
            || owner.path("pid").asInt() <= 0
            || !owner.path("ownerRevision").canConvertToLong()
            || owner.path("ownerRevision").asLong() < 0
            || !owner.path("requestFenceGeneration").canConvertToLong()
            || owner.path("requestFenceGeneration").asLong() < -1
            || !owner.path("childPid").canConvertToInt()
            || owner.path("childPid").asInt() < 0
            || !owner.path("childProcessLedger").isArray()
            || owner.path("childProcessLedger").size() > 4096) {
            throw new IOException("regression suite owner schema is invalid (fields=" + ownerFields + ")");
        }
        var expectedSecretDir = suiteLockDirectory.resolve("private").toAbsolutePath().normalize().toString();
        var secretDir = owner.path("secretDir").asText();
        if (!secretDir.isEmpty() && !secretDir.equals(expectedSecretDir)) {
            throw new IOException("regression suite owner private path is invalid");
        }
        return new SuiteOwnerSnapshot(owner, lock.owner());
    }

    private boolean recoveryClaimAuthorizes(
        SuiteOwnerSnapshot ownerSnapshot,
        String capability,
        String username,
        String userId,
        long generation
    ) throws IOException {
        if (!FIXTURE_USERNAME.matcher(String.valueOf(username)).matches()
            || !FIXTURE_USER_ID.matcher(String.valueOf(userId)).matches()
            || generation < 0) {
            return false;
        }
        try (var entries = Files.list(suiteLockDirectory)) {
            var latest = entries
                .map(path -> Map.entry(path, RECOVERY_CLAIM.matcher(path.getFileName().toString())))
                .filter(entry -> entry.getValue().matches())
                .max(Comparator.comparingInt(entry -> Integer.parseInt(entry.getValue().group(1))))
                .orElse(null);
            if (latest == null) {
                return false;
            }
            var epoch = Integer.parseInt(latest.getValue().group(1));
            readPrivateDirectory(latest.getKey(), ownerSnapshot.ownerPrincipal());
            var claim = readPrivateJson(latest.getKey().resolve("claim.json"), ownerSnapshot.ownerPrincipal());
            if (!(claim.isObject()
                && fieldNames(claim).equals(RECOVERY_CLAIM_KEYS)
                && claim.path("epoch").canConvertToInt()
                && claim.path("epoch").asInt() == epoch
                && RUN_ID.matcher(claim.path("token").asText("")).matches()
                && constantTimeEquals(claim.path("token").asText(""), capability)
                && claim.path("pid").canConvertToInt()
                && claim.path("pid").asInt() > 0
                && DIGEST.matcher(claim.path("parentProcessFingerprint").asText("")).matches()
                && claim.path("acquiredAt").isTextual()
                && claim.path("staleOwner").equals(ownerSnapshot.owner())
                && claim.path("fixtureTargets").isArray()
                && claim.path("fixtureTargets").size() <= 1024)) {
                return false;
            }
            String previous = "";
            for (var target : claim.path("fixtureTargets")) {
                if (!target.isObject()
                    || !fieldNames(target).equals(Set.of("generation", "userId", "username"))
                    || !FIXTURE_USERNAME.matcher(target.path("username").asText("")).matches()
                    || !FIXTURE_USER_ID.matcher(target.path("userId").asText("")).matches()
                    || !target.path("generation").canConvertToLong()
                    || target.path("generation").asLong() < 0) {
                    return false;
                }
                String key = target.path("username").asText() + "\u0000"
                    + target.path("userId").asText() + "\u0000" + target.path("generation").asLong();
                if (key.compareTo(previous) <= 0) {
                    return false;
                }
                previous = key;
                if (target.path("username").asText().equals(username)
                    && target.path("userId").asText().equals(userId)
                    && target.path("generation").asLong() == generation) {
                    return true;
                }
            }
            return false;
        }
    }

    private PosixFileAttributes readPrivateDirectory(Path directory, UserPrincipal expectedOwner) throws IOException {
        var attributes = Files.readAttributes(
            directory,
            PosixFileAttributes.class,
            LinkOption.NOFOLLOW_LINKS
        );
        if (!attributes.isDirectory()
            || attributes.isSymbolicLink()
            || !attributes.permissions().equals(PRIVATE_DIRECTORY_PERMISSIONS)
            || (expectedOwner != null && !attributes.owner().equals(expectedOwner))) {
            throw new IOException("regression control directory is not private");
        }
        return attributes;
    }

    private JsonNode readPrivateJson(Path file, UserPrincipal expectedOwner) throws IOException {
        var before = Files.readAttributes(file, PosixFileAttributes.class, LinkOption.NOFOLLOW_LINKS);
        if (!before.isRegularFile()
            || before.isSymbolicLink()
            || !before.permissions().equals(PRIVATE_FILE_PERMISSIONS)
            || !before.owner().equals(expectedOwner)
            || Number.class.cast(Files.getAttribute(file, "unix:nlink", LinkOption.NOFOLLOW_LINKS)).longValue() != 1L
            || before.size() < 2
            || before.size() > MAXIMUM_CONTROL_JSON_BYTES) {
            throw new IOException("regression control file is not one private inode");
        }
        byte[] bytes;
        try (var channel = FileChannel.open(file, StandardOpenOption.READ, LinkOption.NOFOLLOW_LINKS)) {
            var size = channel.size();
            if (size != before.size() || size < 2 || size > MAXIMUM_CONTROL_JSON_BYTES) {
                throw new IOException("regression control file changed before read");
            }
            var buffer = ByteBuffer.allocate(Math.toIntExact(size));
            while (buffer.hasRemaining() && channel.read(buffer) >= 0) {
                // Drain the exact bounded file.
            }
            if (buffer.hasRemaining()) {
                throw new IOException("regression control file read was incomplete");
            }
            bytes = buffer.array();
        }
        var after = Files.readAttributes(file, PosixFileAttributes.class, LinkOption.NOFOLLOW_LINKS);
        if (!before.fileKey().equals(after.fileKey())
            || before.size() != after.size()
            || !before.lastModifiedTime().equals(after.lastModifiedTime())
            || !before.permissions().equals(after.permissions())
            || !before.owner().equals(after.owner())) {
            throw new IOException("regression control file changed during read");
        }
        return OBJECT_MAPPER.readTree(bytes);
    }

    private String sha256(String value) {
        try {
            return HexFormat.of().formatHex(
                MessageDigest.getInstance("SHA-256").digest(value.getBytes(StandardCharsets.UTF_8))
            );
        } catch (NoSuchAlgorithmException exception) {
            throw new IllegalStateException("SHA-256 is unavailable", exception);
        }
    }

    private Set<String> fieldNames(JsonNode node) {
        var names = new HashSet<String>();
        node.fieldNames().forEachRemaining(names::add);
        return names;
    }

    private boolean constantTimeEquals(String left, String right) {
        return MessageDigest.isEqual(
            left.getBytes(StandardCharsets.US_ASCII),
            right.getBytes(StandardCharsets.US_ASCII)
        );
    }

    private boolean isLoopback(HttpServletRequest request) {
        if (request == null || request.getRemoteAddr() == null || request.getRemoteAddr().isBlank()) {
            return false;
        }
        try {
            return InetAddress.getByName(request.getRemoteAddr()).isLoopbackAddress();
        } catch (UnknownHostException exception) {
            return false;
        }
    }

    private record SuiteOwnerSnapshot(JsonNode owner, UserPrincipal ownerPrincipal) {
    }

    public enum FixtureControlAuthorization {
        OWNER,
        RECOVERY
    }
}
