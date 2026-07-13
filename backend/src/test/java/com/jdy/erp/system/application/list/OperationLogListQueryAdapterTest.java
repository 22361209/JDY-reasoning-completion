package com.jdy.erp.system.application.list;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.verifyNoInteractions;
import static org.mockito.Mockito.when;

import java.util.List;
import java.util.Map;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.jdy.erp.system.tenant.TenantContext;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.mockito.ArgumentCaptor;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.core.RowMapper;
import org.springframework.web.server.ResponseStatusException;

class OperationLogListQueryAdapterTest {
    private final JdbcTemplate tenantJdbcTemplate = mock(JdbcTemplate.class);
    private final JdbcTemplate platformJdbcTemplate = mock(JdbcTemplate.class);
    private final ObjectMapper objectMapper = new ObjectMapper();
    private final ListQuerySupport support = new ListQuerySupport(objectMapper);
    private final OperationLogListQueryAdapter adapter = new OperationLogListQueryAdapter(
        tenantJdbcTemplate,
        platformJdbcTemplate,
        objectMapper
    );

    @AfterEach
    void clearTenantContext() {
        TenantContext.clear();
    }

    @Test
    @SuppressWarnings("unchecked")
    void currentScopeUsesSqlFilteringPaginationAndStableDefaultOrderWithoutLiveJoins() {
        TenantContext.setTenant(Map.of(
            "id", "00000000-0000-0000-0000-000000000001",
            "code", "BLD-TEST",
            "name", "测试账套"
        ));
        stubEmptyQuery(tenantJdbcTemplate);

        var result = adapter.query(
            request("current", "USER", false),
            new ListQueryContract("operation-log-list", "header", List.of(), "operatedAt", "row", "header", "operationLog", true),
            support,
            (listKey, view, pageSize) -> List.of()
        );

        assertThat(result.total()).isZero();
        assertThat(result.sortField()).isEqualTo("operatedAt");
        assertThat(result.sortOrder()).isEqualTo("desc");
        var sql = ArgumentCaptor.forClass(String.class);
        verify(tenantJdbcTemplate).query(sql.capture(), any(RowMapper.class), any(Object[].class));
        assertThat(sql.getValue())
            .contains("l.account_set_id = ?::uuid", "l.account_set_code = ?", "l.actor_type = ?")
            .contains("ORDER BY l.operated_at DESC, l.id DESC LIMIT ? OFFSET ?")
            .doesNotContain(" JOIN ");
        verifyNoInteractions(platformJdbcTemplate);
    }

    @Test
    void platformAndHistoricalScopesUseOnlyPlatformTablePredicates() {
        stubEmptyQuery(platformJdbcTemplate);

        adapter.query(request("platform", "", true), contract(), support, noSeedRows());
        adapter.query(request("historical", "", true), contract(), support, noSeedRows());

        var sql = ArgumentCaptor.forClass(String.class);
        verify(platformJdbcTemplate, org.mockito.Mockito.times(2)).query(sql.capture(), any(RowMapper.class), any(Object[].class));
        assertThat(sql.getAllValues().get(0))
            .contains("l.account_set_id IS NULL", "l.account_set_code = 'platform'")
            .doesNotContain("UNION");
        assertThat(sql.getAllValues().get(1))
            .contains("l.account_set_id IS NULL", "l.account_set_code = ''")
            .doesNotContain("UNION");
        verifyNoInteractions(tenantJdbcTemplate);
    }

    @Test
    void detailReturnsNotFoundWhenIdDoesNotExistInsideSelectedScope() {
        when(platformJdbcTemplate.query(anyString(), any(RowMapper.class), any(Object[].class))).thenReturn(List.of());

        assertThatThrownBy(() -> adapter.detail("00000000-0000-0000-0000-000000000123", "platform"))
            .isInstanceOf(ResponseStatusException.class)
            .hasMessageContaining("404 NOT_FOUND");

        var sql = ArgumentCaptor.forClass(String.class);
        verify(platformJdbcTemplate).query(sql.capture(), any(RowMapper.class), any(Object[].class));
        assertThat(sql.getValue()).contains("l.account_set_code = 'platform'", "l.id = ?::uuid");
    }

    @Test
    void rejectsUnknownScopeAndFilterFieldBeforeQueryingDatabase() {
        assertThatThrownBy(() -> adapter.query(request("all", "", false), contract(), support, noSeedRows()))
            .isInstanceOf(ResponseStatusException.class)
            .hasMessageContaining("400 BAD_REQUEST");

        TenantContext.setTenant(Map.of(
            "id", "00000000-0000-0000-0000-000000000001",
            "code", "BLD-TEST",
            "name", "测试账套"
        ));
        var invalidFilterRequest = new ListQueryRequest(
            "operation-log-list", "", "", 1, 50, "header", "", "desc",
            "{\"unknown\":{\"operator\":\"等于\",\"value\":\"x\"}}",
            "", "", "", "", "", "current", "", "", false
        );
        assertThatThrownBy(() -> adapter.query(invalidFilterRequest, contract(), support, noSeedRows()))
            .isInstanceOf(ResponseStatusException.class)
            .hasMessageContaining("Unsupported operation-log filter field");
        verifyNoInteractions(tenantJdbcTemplate, platformJdbcTemplate);
    }

    private void stubEmptyQuery(JdbcTemplate jdbcTemplate) {
        when(jdbcTemplate.queryForObject(anyString(), eq(Long.class), any(Object[].class))).thenReturn(0L);
        when(jdbcTemplate.query(anyString(), any(RowMapper.class), any(Object[].class))).thenReturn(List.of());
    }

    private ListQueryRequest request(String scope, String actorType, boolean exportMode) {
        return new ListQueryRequest(
            "operation-log-list", "needle", "", 2, 50, "header", "", "desc", "",
            "sales", "AUDIT", "admin", "sales_out", actorType, scope, "2026-07-01", "2026-07-13", exportMode
        );
    }

    private ListQueryContract contract() {
        return new ListQueryContract("operation-log-list", "header", List.of(), "operatedAt", "row", "header", "operationLog", true);
    }

    private ListSeedRowsProvider noSeedRows() {
        return (listKey, view, pageSize) -> List.of();
    }
}
