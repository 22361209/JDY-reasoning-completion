package com.jdy.erp.system.application.list;

import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.Base64;
import java.util.List;
import java.util.Map;

import com.jdy.erp.system.tenant.TenantContext;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Component;
import org.springframework.web.server.ResponseStatusException;

@Component
public class SnapshotPagingListQueryAdapter implements ListQueryAdapter {
    static final String LIST_KEY = "financial-account-settlement-selector";
    private static final String TOKEN_VERSION = "financial-account-settlement-snapshot-v1";

    @Override
    public String key() {
        return "snapshotPaging";
    }

    @Override
    public ListQueryResult query(
        ListQueryRequest request,
        ListQueryContract contract,
        ListQuerySupport support,
        ListSeedRowsProvider seedRowsProvider
    ) {
        if (!LIST_KEY.equals(request.listKey()) || !LIST_KEY.equals(contract.listKey())) {
            throw new IllegalStateException("Snapshot paging adapter only supports " + LIST_KEY);
        }

        var tokens = support.keywordTokens(request.keyword());
        var filters = support.columnFilters(request);
        var rows = seedRowsProvider
            .seedRows(request.listKey(), request.normalizedView(), request.pageSize())
            .stream()
            .filter(row -> support.matchesKeywordTokens(row, contract.keywordFields(), tokens))
            .filter(row -> support.matchesDateRange(row, contract.dateField(), request.dateFrom(), request.dateTo()))
            .filter(row -> support.matchesColumnFilters(row, filters))
            .toList();
        if (support.hasText(request.sortField())) {
            rows = rows.stream()
                .sorted(support.comparator(request.sortField(), request.sortOrder()))
                .toList();
        }

        var snapshotToken = snapshotToken(request, rows);
        var suppliedToken = normalized(request.snapshotToken());
        if (!request.exportMode() && request.page() > 1 && suppliedToken.isBlank()) {
            throw snapshotConflict("资金账户分页缺少快照标识，请重新加载");
        }
        if (!suppliedToken.isBlank() && !constantTimeEquals(snapshotToken, suppliedToken)) {
            throw snapshotConflict("资金账户数据已变化，请重新加载");
        }

        var total = rows.size();
        var pagedRows = request.exportMode()
            ? rows
            : rows.stream()
                .skip((long) (request.page() - 1) * request.pageSize())
                .limit(request.pageSize())
                .toList();
        return new ListQueryResult(
            request.page(),
            request.pageSize(),
            request.normalizedView(),
            request.sortField(),
            request.sortOrder(),
            total,
            snapshotToken,
            pagedRows
        );
    }

    private String snapshotToken(ListQueryRequest request, List<Map<String, ?>> rows) {
        var tenant = TenantContext.requireTenant();
        var digest = sha256();
        update(digest, TOKEN_VERSION);
        update(digest, tenant.accountSetId());
        update(digest, tenant.accountSetCode());
        update(digest, tenant.databaseName());
        update(digest, tenant.schemaName());
        update(digest, request.listKey());
        update(digest, request.keyword());
        update(digest, request.legacyStatus());
        update(digest, Integer.toString(request.pageSize()));
        update(digest, request.normalizedView());
        update(digest, request.sortField());
        update(digest, request.sortOrder());
        update(digest, request.columnFiltersJson());
        update(digest, request.module());
        update(digest, request.action());
        update(digest, request.operator());
        update(digest, request.targetType());
        update(digest, request.actorType());
        update(digest, request.scope());
        update(digest, request.dateFrom());
        update(digest, request.dateTo());
        update(digest, Integer.toString(rows.size()));
        for (var row : rows) {
            var keys = row.keySet().stream().sorted().toList();
            update(digest, Integer.toString(keys.size()));
            for (var key : keys) {
                update(digest, key);
                var value = row.get(key);
                update(digest, value == null ? null : String.valueOf(value));
            }
        }
        return Base64.getUrlEncoder().withoutPadding().encodeToString(digest.digest());
    }

    private MessageDigest sha256() {
        try {
            return MessageDigest.getInstance("SHA-256");
        } catch (NoSuchAlgorithmException exception) {
            throw new IllegalStateException("SHA-256 is unavailable", exception);
        }
    }

    private void update(MessageDigest digest, String value) {
        if (value == null) {
            digest.update(ByteBuffer.allocate(Integer.BYTES).putInt(-1).array());
            return;
        }
        var bytes = value.getBytes(StandardCharsets.UTF_8);
        digest.update(ByteBuffer.allocate(Integer.BYTES).putInt(bytes.length).array());
        digest.update(bytes);
    }

    private boolean constantTimeEquals(String expected, String actual) {
        return MessageDigest.isEqual(
            expected.getBytes(StandardCharsets.US_ASCII),
            actual.getBytes(StandardCharsets.US_ASCII)
        );
    }

    private String normalized(String value) {
        return value == null ? "" : value.trim();
    }

    private ResponseStatusException snapshotConflict(String message) {
        return new ResponseStatusException(HttpStatus.CONFLICT, message);
    }
}
