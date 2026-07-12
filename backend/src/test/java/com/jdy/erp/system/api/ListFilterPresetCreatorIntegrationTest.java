package com.jdy.erp.system.api;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.Mockito.clearInvocations;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import java.util.Map;

import com.jdy.erp.system.security.CurrentSessionService;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.context.bean.override.mockito.MockitoBean;
import org.springframework.transaction.annotation.Transactional;

@SpringBootTest
@Transactional
class ListFilterPresetCreatorIntegrationTest {
    @Autowired
    private ListFilterPresetController controller;

    @Autowired
    private JdbcTemplate jdbcTemplate;

    @MockitoBean
    private CurrentSessionService currentSessionService;

    private String adminUserId;

    @BeforeEach
    void setUpCurrentUser() {
        adminUserId = jdbcTemplate.queryForObject(
            "SELECT id::text FROM sys_user WHERE username = 'admin'",
            String.class
        );
        when(currentSessionService.currentUserId()).thenReturn(adminUserId);
        when(currentSessionService.currentUsername()).thenReturn("admin");
        when(currentSessionService.currentRoleCode()).thenReturn("ADMIN");
        clearInvocations(currentSessionService);
    }

    @Test
    void newPersonalPresetStoresTheImmutableCreatorWithoutChangingLegacyRows() {
        var listKey = "a135-creator-" + System.nanoTime();
        var name = "A135 creator fixture";
        var completeBaseline = completePresetSnapshot();
        var legacyBaseline = legacyPresetSnapshot();

        try {
            var saved = controller.save(listKey, personalRequest(name, "new-value"));
            var id = String.valueOf(saved.get("id"));
            var stored = jdbcTemplate.queryForMap("""
                SELECT id::text AS id,
                       role_code AS "roleCode",
                       user_name AS "userName",
                       created_by::text AS "createdBy"
                FROM sys_list_filter_preset
                WHERE id = ?::uuid
                """, id);

            assertThat(stored)
                .containsEntry("id", id)
                .containsEntry("roleCode", "ADMIN")
                .containsEntry("userName", "admin")
                .containsEntry("createdBy", adminUserId);
            assertThat(legacyPresetSnapshot()).isEqualTo(legacyBaseline);
        } finally {
            deleteExactFixture(listKey, name);
            assertThat(completePresetSnapshot()).isEqualTo(completeBaseline);
            assertThat(legacyPresetSnapshot()).isEqualTo(legacyBaseline);
        }
    }

    @Test
    void updatingAnExistingPresetDoesNotBackfillItsMissingCreator() {
        var listKey = "a135-existing-" + System.nanoTime();
        var name = "A135 existing fixture";
        var completeBaseline = completePresetSnapshot();
        var legacyBaseline = legacyPresetSnapshot();
        var fixtureId = jdbcTemplate.queryForObject("""
            INSERT INTO sys_list_filter_preset (
                list_key, name, role_code, user_name, query, column_filters,
                shared, is_default, read_only, created_by
            )
            VALUES (?, ?, 'ADMIN', 'admin', '{"value":"old-value"}'::jsonb, '{}'::jsonb,
                    TRUE, FALSE, FALSE, NULL)
            RETURNING id::text
            """, String.class, listKey, name);

        try {
            var saved = controller.save(listKey, personalRequest(name, "updated-value"));
            var stored = jdbcTemplate.queryForMap("""
                SELECT id::text AS id,
                       created_by::text AS "createdBy",
                       query->>'value' AS value
                FROM sys_list_filter_preset
                WHERE id = ?::uuid
                """, fixtureId);

            assertThat(saved.get("id")).isEqualTo(fixtureId);
            assertThat(stored.get("id")).isEqualTo(fixtureId);
            assertThat(stored.get("createdBy")).isNull();
            assertThat(stored.get("value")).isEqualTo("updated-value");
            verify(currentSessionService, never()).currentUserId();
            assertThat(legacyPresetSnapshot()).isEqualTo(legacyBaseline);
        } finally {
            var deleted = jdbcTemplate.update("""
                DELETE FROM sys_list_filter_preset
                WHERE id = ?::uuid
                  AND list_key = ?
                  AND name = ?
                  AND role_code = 'ADMIN'
                  AND user_name = 'admin'
                """, fixtureId, listKey, name);
            assertThat(deleted).isEqualTo(1);
            assertThat(completePresetSnapshot()).isEqualTo(completeBaseline);
            assertThat(legacyPresetSnapshot()).isEqualTo(legacyBaseline);
        }
    }

    private ListFilterPresetController.PresetRequest personalRequest(String name, String value) {
        return new ListFilterPresetController.PresetRequest(
            name,
            "PERSONAL",
            "WAREHOUSE",
            "forged-user",
            Map.of("value", value),
            Map.of(),
            true,
            false
        );
    }

    private void deleteExactFixture(String listKey, String name) {
        var fixtureIds = jdbcTemplate.queryForList("""
            SELECT id::text
            FROM sys_list_filter_preset
            WHERE list_key = ?
              AND name = ?
              AND role_code = 'ADMIN'
              AND user_name = 'admin'
            """, String.class, listKey, name);
        assertThat(fixtureIds).hasSize(1);
        var deleted = jdbcTemplate.update("""
            DELETE FROM sys_list_filter_preset
            WHERE id = ?::uuid
              AND list_key = ?
              AND name = ?
              AND role_code = 'ADMIN'
              AND user_name = 'admin'
            """, fixtureIds.getFirst(), listKey, name);
        assertThat(deleted).isEqualTo(1);
    }

    private String completePresetSnapshot() {
        return jdbcTemplate.queryForObject("""
            SELECT COALESCE(jsonb_agg(to_jsonb(preset) ORDER BY preset.id::text), '[]'::jsonb)::text
            FROM sys_list_filter_preset preset
            """, String.class);
    }

    private String legacyPresetSnapshot() {
        return jdbcTemplate.queryForObject("""
            SELECT COALESCE(jsonb_agg(to_jsonb(preset) ORDER BY preset.id::text), '[]'::jsonb)::text
            FROM sys_list_filter_preset preset
            WHERE preset.user_name = '本地管理员'
            """, String.class);
    }
}
