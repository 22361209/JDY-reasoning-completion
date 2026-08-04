package com.jdy.erp.system.security;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatCode;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.attribute.PosixFilePermissions;
import java.security.MessageDigest;
import java.util.HexFormat;
import java.util.List;
import java.util.UUID;

import com.jdy.erp.inventory.config.InventoryTestAdjustmentProperties;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.http.HttpStatus;
import org.springframework.mock.env.MockEnvironment;
import org.springframework.mock.web.MockHttpServletRequest;
import org.springframework.mock.web.MockHttpSession;
import org.springframework.web.server.ResponseStatusException;

class RegressionSharedAdminLoginGuardTest {
    private static final String CONTROL_TOKEN = "c".repeat(32);
    @TempDir
    Path tempDirectory;

    @Test
    void mainPortRejectsSharedAdminBeforeLoginWheneverTheSuiteLockExists() throws Exception {
        var lockDirectory = tempDirectory.resolve("jdy-erp-regression-suite.lock");
        Files.createDirectory(lockDirectory);
        Files.writeString(lockDirectory.resolve("owner.json"), "{}");
        var guard = guard(true, new String[] {"local", "regression"}, List.of("BLD-TEST"), lockDirectory);
        var request = request(8080, "127.0.0.1");

        assertThat(guard.isSharedAdminLoginGuardActive(request)).isTrue();
        assertThatThrownBy(() -> guard.rejectSharedAdminCredentialUse(" admin ", request))
            .isInstanceOfSatisfying(ResponseStatusException.class, exception ->
                assertThat(exception.getStatusCode()).isEqualTo(HttpStatus.LOCKED));
        assertThatCode(() -> guard.rejectSharedAdminCredentialUse("r_suite_0123456789ab", request)).doesNotThrowAnyException();
    }

    @Test
    void lockActivationDrainBarrierCountsEarlierLoginUntilRequestCompletion() throws Exception {
        var lockDirectory = tempDirectory.resolve("jdy-erp-regression-suite.lock");
        var guard = guard(true, new String[] {"local", "regression"}, List.of("BLD-TEST"), lockDirectory);
        var request = request(8080, "127.0.0.1");

        var lease = guard.beginSharedAdminLogin("admin", request);
        assertThat(lease).isNotNull();
        assertThat(guard.activeSharedAdminLoginCount(request)).isEqualTo(1);

        Files.createDirectory(lockDirectory);
        Files.writeString(lockDirectory.resolve("owner.json"), "{}");
        assertThat(guard.isSharedAdminLoginGuardActive(request)).isTrue();
        assertThat(guard.activeSharedAdminLoginCount(request)).isEqualTo(1);
        assertThatThrownBy(() -> guard.beginSharedAdminLogin("admin", request))
            .isInstanceOfSatisfying(ResponseStatusException.class, exception ->
                assertThat(exception.getStatusCode()).isEqualTo(HttpStatus.LOCKED));

        lease.close();
        assertThat(guard.activeSharedAdminLoginCount(request)).isZero();
        assertThatCode(lease::close).doesNotThrowAnyException();
    }

    @Test
    void activeSuiteRejectsFixtureLoginThatWouldOverwriteSharedAdminSession() throws Exception {
        var lockDirectory = tempDirectory.resolve("jdy-erp-regression-suite.lock");
        Files.createDirectory(lockDirectory);
        Files.writeString(lockDirectory.resolve("owner.json"), "{}");
        var guard = guard(true, new String[] {"local", "regression"}, List.of("BLD-TEST"), lockDirectory);
        var request = request(8080, "127.0.0.1");
        var session = (MockHttpSession) request.getSession(true);
        session.setAttribute(CurrentSessionService.SESSION_USERNAME, "admin");

        assertThatThrownBy(() -> guard.rejectSharedAdminSessionReplacement(
            "r_suite_0123456789ab",
            request
        )).isInstanceOfSatisfying(ResponseStatusException.class, exception ->
            assertThat(exception.getStatusCode()).isEqualTo(HttpStatus.LOCKED));

        assertThat(session.isInvalid()).isFalse();
        assertThat(session.getAttribute(CurrentSessionService.SESSION_USERNAME)).isEqualTo("admin");
        assertThatCode(() -> guard.rejectSharedAdminSessionReplacement("admin", request))
            .doesNotThrowAnyException();
    }

    @Test
    void incompleteCanonicalLockFailsClosedForLoginButNotForFixtureControl() throws Exception {
        var lockDirectory = tempDirectory.resolve("jdy-erp-regression-suite.lock");
        Files.createDirectory(lockDirectory);
        var guard = guard(true, new String[] {"local", "regression"}, List.of("BLD-TEST"), lockDirectory);
        var request = request(8080, "127.0.0.1");

        assertThat(guard.isSharedAdminLoginGuardActive(request)).isTrue();
        assertThatThrownBy(() -> guard.rejectSharedAdminCredentialUse("admin", request))
            .isInstanceOfSatisfying(ResponseStatusException.class, exception ->
                assertThat(exception.getStatusCode()).isEqualTo(HttpStatus.LOCKED));
        assertThatThrownBy(() -> guard.requireFixtureControl(request, false))
            .isInstanceOfSatisfying(ResponseStatusException.class, exception ->
                assertThat(exception.getStatusCode()).isEqualTo(HttpStatus.FORBIDDEN));
    }

    @Test
    void isolatedPortsAndIncompleteTestCapabilitiesRemainUnaffected() throws Exception {
        var lockDirectory = tempDirectory.resolve("jdy-erp-regression-suite.lock");
        Files.createDirectory(lockDirectory);
        Files.writeString(lockDirectory.resolve("owner.json"), "{}");

        assertThat(guard(true, new String[] {"local", "regression"}, List.of("BLD-TEST"), lockDirectory)
            .isSharedAdminLoginGuardActive(request(18080, "127.0.0.1"))).isFalse();
        assertThat(guard(false, new String[] {"local", "regression"}, List.of("BLD-TEST"), lockDirectory)
            .isSharedAdminLoginGuardActive(request(8080, "127.0.0.1"))).isFalse();
        assertThat(guard(true, new String[] {"local", "prod"}, List.of("BLD-TEST"), lockDirectory)
            .isSharedAdminLoginGuardActive(request(8080, "127.0.0.1"))).isFalse();
        assertThat(guard(true, new String[] {"local", "unknown"}, List.of("BLD-TEST"), lockDirectory)
            .isSharedAdminLoginGuardActive(request(8080, "127.0.0.1"))).isFalse();
        assertThat(guard(true, new String[] {}, List.of("BLD-TEST"), lockDirectory)
            .isSharedAdminLoginGuardActive(request(8080, "127.0.0.1"))).isFalse();
        assertThat(guard(true, new String[] {"local", "regression"}, List.of(), lockDirectory)
            .isSharedAdminLoginGuardActive(request(8080, "127.0.0.1"))).isFalse();
    }

    @Test
    void fixtureControlRequiresMainPortSuiteLockCapabilityAndLoopback() throws Exception {
        var lockDirectory = tempDirectory.resolve("jdy-erp-regression-suite.lock");
        Files.createDirectory(lockDirectory);
        writeValidOwner(lockDirectory, CONTROL_TOKEN);
        var guard = guard(
            true,
            new String[] {"test"},
            List.of("BLD-TEST"),
            lockDirectory
        );

        var authorized = request(8080, "::1");
        authorized.addHeader("X-JDY-Regression-Fence-Capability", CONTROL_TOKEN);
        assertThatCode(() -> guard.requireFixtureControl(authorized, false)).doesNotThrowAnyException();
        assertThatThrownBy(() -> guard.requireFixtureControl(request(8080, "192.0.2.10"), false))
            .isInstanceOfSatisfying(ResponseStatusException.class, exception ->
                assertThat(exception.getStatusCode()).isEqualTo(HttpStatus.FORBIDDEN));
        assertThatThrownBy(() -> guard.requireFixtureControl(request(18080, "127.0.0.1"), false))
            .isInstanceOf(ResponseStatusException.class);
        assertThatThrownBy(() -> guard.requireFixtureControl(request(8080, "127.0.0.1"), false))
            .isInstanceOf(ResponseStatusException.class);
        Files.delete(lockDirectory.resolve("owner.json"));
        assertThatThrownBy(() -> guard.requireFixtureControl(request(8080, "127.0.0.1"), false))
            .isInstanceOf(ResponseStatusException.class);
    }

    @Test
    void recoveryClaimOnlyAuthorizesItsExactSignedFixtureTargets() throws Exception {
        var lockDirectory = tempDirectory.resolve("jdy-erp-regression-suite.lock");
        Files.createDirectory(lockDirectory);
        Files.setPosixFilePermissions(lockDirectory, PosixFilePermissions.fromString("rwx------"));
        var owner = writeValidOwner(lockDirectory, CONTROL_TOKEN);
        var recoveryToken = "e".repeat(32);
        var userId = UUID.randomUUID();
        var username = "r_aux_0123456789ab";
        var claimDirectory = lockDirectory.resolve("recovery.claim.000001");
        Files.createDirectory(claimDirectory);
        Files.setPosixFilePermissions(claimDirectory, PosixFilePermissions.fromString("rwx------"));
        var claim = """
            {
              "epoch":1,
              "token":"%s",
              "pid":12346,
              "parentProcessFingerprint":"%s",
              "staleOwner":%s,
              "fixtureTargets":[{"generation":7,"userId":"%s","username":"%s"}],
              "acquiredAt":"2026-08-03T00:00:01Z"
            }
            """.formatted(recoveryToken, "b".repeat(64), owner, userId, username);
        var claimPath = claimDirectory.resolve("claim.json");
        Files.writeString(claimPath, claim);
        Files.setPosixFilePermissions(claimPath, PosixFilePermissions.fromString("rw-------"));
        var guard = guard(true, new String[] {"local", "regression"}, List.of("BLD-TEST"), lockDirectory);
        var authorized = request(8080, "127.0.0.1");
        authorized.addHeader("X-JDY-Regression-Fence-Capability", recoveryToken);

        assertThat(guard.requireFixtureControl(
            authorized, true, username, userId.toString(), 7L
        )).isEqualTo(RegressionSharedAdminLoginGuard.FixtureControlAuthorization.RECOVERY);
        assertThatThrownBy(() -> guard.requireFixtureControl(
            authorized, true, "r_other_0123456789ab", userId.toString(), 7L
        )).isInstanceOfSatisfying(ResponseStatusException.class, exception ->
            assertThat(exception.getStatusCode()).isEqualTo(HttpStatus.FORBIDDEN));
        assertThatThrownBy(() -> guard.requireFixtureControl(
            authorized, false, username, userId.toString(), 7L
        )).isInstanceOfSatisfying(ResponseStatusException.class, exception ->
            assertThat(exception.getStatusCode()).isEqualTo(HttpStatus.FORBIDDEN));
    }

    private String writeValidOwner(Path lockDirectory, String controlToken) throws Exception {
        Files.setPosixFilePermissions(lockDirectory, PosixFilePermissions.fromString("rwx------"));
        var digest = HexFormat.of().formatHex(
            MessageDigest.getInstance("SHA-256").digest(controlToken.getBytes(java.nio.charset.StandardCharsets.UTF_8))
        );
        var owner = """
            {
              "runId":"%s",
              "tier":"full",
              "username":"r_full_000000000000000000000000",
              "requestFenceControlDigest":"%s",
              "pid":12345,
              "state":"running",
              "userId":"",
              "requestFenceGeneration":-1,
              "secretDir":"",
              "childPid":0,
              "childScript":"",
              "childProcessFingerprint":"",
              "childProcessGuardToken":"",
              "childDetachedSpawnLedger":null,
              "childProcessLedger":[],
              "diagnosticError":"",
              "artifactBaseline":null,
              "executionBaseline":null,
              "latestPublication":null,
              "ownerRevision":0,
              "parentProcessFingerprint":"%s",
              "acquiredAt":"2026-08-03T00:00:00Z",
              "updatedAt":"2026-08-03T00:00:00Z"
            }
            """.formatted("a".repeat(32), digest, "d".repeat(64));
        var ownerPath = lockDirectory.resolve("owner.json");
        Files.writeString(ownerPath, owner);
        Files.setPosixFilePermissions(ownerPath, PosixFilePermissions.fromString("rw-------"));
        return owner;
    }

    private RegressionSharedAdminLoginGuard guard(
        boolean enabled,
        String[] profiles,
        List<String> accountSetCodes,
        Path lockDirectory
    ) {
        var environment = new MockEnvironment();
        environment.setActiveProfiles(profiles);
        return new RegressionSharedAdminLoginGuard(
            new InventoryTestAdjustmentProperties(enabled, accountSetCodes),
            environment,
            lockDirectory
        );
    }

    private MockHttpServletRequest request(int localPort, String remoteAddress) {
        var request = new MockHttpServletRequest();
        request.setLocalPort(localPort);
        request.setRemoteAddr(remoteAddress);
        return request;
    }
}
