package com.jdy.erp.system.api;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyBoolean;
import static org.mockito.ArgumentMatchers.anyLong;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.lenient;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.verifyNoInteractions;
import static org.mockito.Mockito.when;

import java.util.List;
import java.util.Map;
import java.util.UUID;

import com.jdy.erp.system.security.RegressionActiveRequestTracker;
import com.jdy.erp.system.security.RegressionSharedAdminLoginGuard;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.mock.web.MockHttpServletRequest;
import org.springframework.web.server.ResponseStatusException;

class RegressionFixtureControllerTest {
    private static final String USERNAME = "r_full_000000000000000000000000";
    private final UUID userId = UUID.randomUUID();
    private final JdbcTemplate jdbcTemplate = mock(JdbcTemplate.class);
    private final RegressionActiveRequestTracker tracker = new RegressionActiveRequestTracker();
    private final RegressionSharedAdminLoginGuard accessGuard = mock(RegressionSharedAdminLoginGuard.class);
    private final RegressionFixtureController controller = new RegressionFixtureController(
        jdbcTemplate,
        tracker,
        accessGuard
    );
    private final MockHttpServletRequest servletRequest = new MockHttpServletRequest();

    @BeforeEach
    void authorizeOwnerCapability() {
        lenient().when(accessGuard.requireFixtureControl(
            any(), anyBoolean(), anyString(), anyString(), anyLong()
        )).thenReturn(RegressionSharedAdminLoginGuard.FixtureControlAuthorization.OWNER);
    }

    @Test
    void opensEnabledOwnedFixtureAndClosesItWithoutExposingIdentityData() {
        ownedFixture(true, true, true);

        var opened = controller.manage(servletRequest, request("OPEN"));
        var closed = controller.manage(servletRequest, request("CLOSE_AND_DRAIN"));

        assertThat(opened).containsExactlyInAnyOrderEntriesOf(Map.of("state", "OPEN", "activeCount", 0));
        assertThat(closed).containsExactlyInAnyOrderEntriesOf(Map.of("state", "CLOSED", "activeCount", 0));
        assertThat(opened).doesNotContainKeys("userId", "username", "password");
        verify(accessGuard).requireFixtureControl(
            servletRequest, false, USERNAME, userId.toString(), 7L
        );
        verify(accessGuard).requireFixtureControl(
            servletRequest, true, USERNAME, userId.toString(), 7L
        );
        verify(jdbcTemplate, org.mockito.Mockito.times(2))
            .queryForList(anyString(), any(Object[].class));
    }

    @Test
    void closeAcceptsAnOwnedDisabledTombstoneButOpenDoesNot() {
        ownedFixture(false, true, true);

        assertThat(controller.manage(servletRequest, request("CLOSE_AND_DRAIN")))
            .containsEntry("state", "CLOSED")
            .containsEntry("activeCount", 0);
        assertThatThrownBy(() -> controller.manage(servletRequest, request("OPEN")))
            .isInstanceOfSatisfying(ResponseStatusException.class, exception ->
                assertThat(exception.getStatusCode()).isEqualTo(HttpStatus.CONFLICT));
    }

    @Test
    void rejectsNamespaceAndOwnershipDriftBeforeChangingFenceState() {
        assertThatThrownBy(() -> controller.manage(
            servletRequest,
            new RegressionFixtureController.FenceRequest("OPEN", userId.toString(), "admin", 7L)
        )).isInstanceOfSatisfying(ResponseStatusException.class, exception ->
            assertThat(exception.getStatusCode()).isEqualTo(HttpStatus.BAD_REQUEST));
        verifyNoInteractions(jdbcTemplate);

        ownedFixture(true, true, false);
        assertThatThrownBy(() -> controller.manage(servletRequest, request("OPEN")))
            .isInstanceOfSatisfying(ResponseStatusException.class, exception ->
                assertThat(exception.getStatusCode()).isEqualTo(HttpStatus.FORBIDDEN));
        assertThat(tracker.snapshot(userId).activeCount()).isZero();
    }

    @Test
    void delayedOldGenerationCannotOpenOrCloseAReenabledFixture() {
        ownedFixture(true, true, true, 8L);
        tracker.open(userId, 8L);

        assertThatThrownBy(() -> controller.manage(servletRequest, request("OPEN", 7L)))
            .isInstanceOfSatisfying(ResponseStatusException.class, exception ->
                assertThat(exception.getStatusCode()).isEqualTo(HttpStatus.CONFLICT));
        assertThatThrownBy(() -> controller.manage(servletRequest, request("CLOSE_AND_DRAIN", 7L)))
            .isInstanceOfSatisfying(ResponseStatusException.class, exception ->
                assertThat(exception.getStatusCode()).isEqualTo(HttpStatus.CONFLICT));
        assertThat(tracker.snapshot(userId).state()).isEqualTo(RegressionActiveRequestTracker.FenceState.OPEN);
    }

    @Test
    void ownerCapabilityCannotCloseAnOldGenerationWhenTrackerWasRestarted() {
        ownedFixture(false, true, true, 8L);

        assertThatThrownBy(() -> controller.manage(servletRequest, request("CLOSE_AND_DRAIN", 7L)))
            .isInstanceOfSatisfying(ResponseStatusException.class, exception ->
                assertThat(exception.getStatusCode()).isEqualTo(HttpStatus.CONFLICT));
        assertThat(tracker.snapshot(userId).state()).isEqualTo(RegressionActiveRequestTracker.FenceState.OPEN);
    }

    @Test
    void recoveryCapabilityCanOnlyCloseItsAuthorizedHistoricalGeneration() {
        ownedFixture(false, true, true, 8L);
        when(accessGuard.requireFixtureControl(
            any(), anyBoolean(), anyString(), anyString(), anyLong()
        )).thenReturn(RegressionSharedAdminLoginGuard.FixtureControlAuthorization.RECOVERY);

        assertThat(controller.manage(servletRequest, request("CLOSE_AND_DRAIN", 7L)))
            .containsEntry("state", "CLOSED");
        assertThatThrownBy(() -> controller.manage(servletRequest, request("OPEN", 8L)))
            .isInstanceOfSatisfying(ResponseStatusException.class, exception ->
                assertThat(exception.getStatusCode()).isEqualTo(HttpStatus.FORBIDDEN));
    }

    @SuppressWarnings("unchecked")
    private void ownedFixture(boolean enabled, boolean ownedCreated, boolean ownedUpdated) {
        ownedFixture(enabled, ownedCreated, ownedUpdated, 7L);
    }

    @SuppressWarnings("unchecked")
    private void ownedFixture(boolean enabled, boolean ownedCreated, boolean ownedUpdated, long generation) {
        when(jdbcTemplate.queryForList(anyString(), any(Object[].class))).thenReturn(List.of(Map.of(
            "enabled", enabled,
            "sessionGeneration", generation,
            "ownedCreated", ownedCreated,
            "ownedUpdated", ownedUpdated
        )));
    }

    private RegressionFixtureController.FenceRequest request(String action) {
        return request(action, 7L);
    }

    private RegressionFixtureController.FenceRequest request(String action, long generation) {
        return new RegressionFixtureController.FenceRequest(action, userId.toString(), USERNAME, generation);
    }
}
