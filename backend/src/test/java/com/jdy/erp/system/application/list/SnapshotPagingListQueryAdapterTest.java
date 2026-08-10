package com.jdy.erp.system.application.list;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.util.List;
import java.util.Map;
import java.util.concurrent.atomic.AtomicReference;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.jdy.erp.system.tenant.TenantContext;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.http.HttpStatus;
import org.springframework.web.server.ResponseStatusException;

class SnapshotPagingListQueryAdapterTest {
    private final SnapshotPagingListQueryAdapter adapter = new SnapshotPagingListQueryAdapter();
    private final ListQueryContract contract = new ListQueryContractRegistry()
        .contractFor(SnapshotPagingListQueryAdapter.LIST_KEY, "header");
    private final ListQuerySupport support = new ListQuerySupport(new ObjectMapper());
    private final AtomicReference<List<Map<String, ?>>> candidates = new AtomicReference<>(List.of(
        account("00000000-0000-0000-0000-00000000000a", "A"),
        account("00000000-0000-0000-0000-00000000000b", "B"),
        account("00000000-0000-0000-0000-00000000000c", "C")
    ));
    private final ListSeedRowsProvider provider = (listKey, view, pageSize) -> candidates.get();

    @BeforeEach
    void setTenant() {
        setTenant("00000000-0000-0000-0000-000000000001", "BLD-TEST", "public");
    }

    @AfterEach
    void clearTenant() {
        TenantContext.clear();
    }

    @Test
    void stableTokenContinuesAcrossPagesAndMissingTokenFailsClosed() {
        var first = query(1, "");

        assertThat(first.snapshotToken()).isNotBlank();
        assertThat(first.total()).isEqualTo(3);
        assertThat(first.rows()).extracting(row -> String.valueOf(row.get("code"))).containsExactly("A", "B");
        assertConflict(() -> query(2, ""), "缺少快照标识");

        var second = query(2, first.snapshotToken());
        assertThat(second.snapshotToken()).isEqualTo(first.snapshotToken());
        assertThat(second.rows()).extracting(row -> String.valueOf(row.get("code"))).containsExactly("C");
    }

    @Test
    void equalCountReplacementInvalidatesTheOldTokenAndFreshTraversalIsComplete() {
        var first = query(1, "");
        candidates.set(List.of(
            account("00000000-0000-0000-0000-00000000000b", "B"),
            account("00000000-0000-0000-0000-00000000000c", "C"),
            account("00000000-0000-0000-0000-00000000000d", "D")
        ));

        assertConflict(() -> query(2, first.snapshotToken()), "数据已变化");

        var refreshedFirst = query(1, "");
        var refreshedSecond = query(2, refreshedFirst.snapshotToken());
        assertThat(refreshedFirst.snapshotToken()).isNotEqualTo(first.snapshotToken());
        assertThat(List.of(refreshedFirst, refreshedSecond).stream()
            .flatMap(result -> result.rows().stream())
            .map(row -> String.valueOf(row.get("code"))))
            .containsExactly("B", "C", "D");
    }

    @Test
    void tokenCannotBeReusedAcrossTenantsOrQueryShapes() {
        var first = query(1, "");

        setTenant("00000000-0000-0000-0000-000000000002", "SECOND", "tenant_second");
        assertConflict(() -> query(2, first.snapshotToken()), "数据已变化");

        setTenant("00000000-0000-0000-0000-000000000001", "BLD-TEST", "public");
        assertConflict(() -> adapter.query(
            request(2, 3, first.snapshotToken()), contract, support, provider
        ), "数据已变化");
        assertConflict(() -> query(2, "forged-token"), "数据已变化");
    }

    private ListQueryResult query(int page, String snapshotToken) {
        return adapter.query(request(page, 2, snapshotToken), contract, support, provider);
    }

    private ListQueryRequest request(int page, int pageSize, String snapshotToken) {
        return new ListQueryRequest(
            SnapshotPagingListQueryAdapter.LIST_KEY,
            "",
            "",
            page,
            pageSize,
            "header",
            "",
            "asc",
            "",
            "",
            "",
            "",
            "",
            "",
            "current",
            "",
            "",
            snapshotToken,
            false
        );
    }

    private Map<String, ?> account(String id, String code) {
        return Map.of(
            "id", id,
            "code", code,
            "name", "Account " + code,
            "accountType", "CASH",
            "bankName", "",
            "currency", "CNY"
        );
    }

    private void setTenant(String id, String code, String schema) {
        TenantContext.setTenant(Map.of(
            "id", id,
            "code", code,
            "name", code,
            "databaseName", "jdy_erp",
            "schemaName", schema,
            "redisKeyPrefix", code.toLowerCase(),
            "attachmentPrefix", "account-sets/" + code.toLowerCase()
        ));
    }

    private void assertConflict(Runnable action, String message) {
        assertThatThrownBy(action::run)
            .isInstanceOfSatisfying(ResponseStatusException.class, exception -> {
                assertThat(exception.getStatusCode()).isEqualTo(HttpStatus.CONFLICT);
                assertThat(exception.getReason()).contains(message);
            });
    }
}
