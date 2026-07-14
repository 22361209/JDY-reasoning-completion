package com.jdy.erp.testsupport;

import static org.assertj.core.api.Assertions.assertThat;

import java.math.BigDecimal;
import java.util.Arrays;
import java.util.List;
import java.util.Map;

import org.springframework.jdbc.core.JdbcTemplate;

/**
 * Dynamic A147 lifecycle assertions shared by the existing formal document
 * integration tests. Every call resolves the persisted header/line first and
 * then proves that the immutable inventory facts retained that exact identity.
 */
public final class InventoryTraceAssertions {
    private InventoryTraceAssertions() {
    }

    public static ExpectedFact fact(String txnType, String action, String qtyDelta, String qtyOnHandAfter) {
        return new ExpectedFact(txnType, action, qtyDelta, qtyOnHandAfter, null);
    }

    public static ExpectedFact reversal(
        String txnType,
        String action,
        String qtyDelta,
        String qtyOnHandAfter,
        int reversalOfIndex
    ) {
        return new ExpectedFact(txnType, action, qtyDelta, qtyOnHandAfter, reversalOfIndex);
    }

    public static void assertExactLifecycle(
        JdbcTemplate jdbcTemplate,
        SourceDocument sourceDocument,
        String sourceBillType,
        String productCode,
        String warehouseCode,
        ExpectedFact... expectedFacts
    ) {
        assertThat(expectedFacts).as("生命周期矩阵必须声明预期库存事实").isNotEmpty();
        var headerTable = identifier(sourceDocument.headerTable());
        var lineTable = identifier(sourceDocument.lineTable());
        var lineBillColumn = identifier(sourceDocument.lineBillColumn());
        var dateExpression = sourceDateExpression(sourceDocument.headerDateColumn());
        var sourceRows = jdbcTemplate.queryForList("""
            SELECT header.id::text AS "sourceBillId",
                   line.id::text AS "sourceBillLineId",
                   header.bill_no AS "sourceBillNo",
                   to_char(%s, 'YYYY-MM-DD') AS "sourceBillDate"
            FROM %s header
            JOIN %s line ON line.%s = header.id
            WHERE header.bill_no = ?
            ORDER BY line.line_no, line.id
            """.formatted(dateExpression, headerTable, lineTable, lineBillColumn), sourceDocument.billNo());
        assertThat(sourceRows)
            .as("%s 应精确解析一个持久化来源行", sourceDocument.billNo())
            .hasSize(1);
        var source = sourceRows.getFirst();
        var expectedInventoryScopeId = jdbcTemplate.queryForObject("""
            SELECT balance.account_set_id::text
            FROM inv_stock_balance balance
            JOIN md_product product ON product.id = balance.product_id
            JOIN md_warehouse warehouse ON warehouse.id = balance.warehouse_id
            WHERE product.code = ?
              AND warehouse.code = ?
            """, String.class, productCode, warehouseCode);
        var expectedTxnTypes = Arrays.stream(expectedFacts).map(ExpectedFact::txnType).distinct().toList();
        var placeholders = String.join(", ", expectedTxnTypes.stream().map(ignored -> "?").toList());
        var parameters = new java.util.ArrayList<Object>();
        parameters.add(source.get("sourceBillId"));
        parameters.add(source.get("sourceBillLineId"));
        parameters.add(sourceBillType);
        parameters.add(productCode);
        parameters.add(warehouseCode);
        parameters.addAll(expectedTxnTypes);
        var facts = jdbcTemplate.queryForList("""
            SELECT txn.id::text AS id,
                   txn.account_set_id::text AS "accountSetId",
                   txn.txn_type AS "txnType",
                   txn.source_bill_type AS "sourceBillType",
                   txn.source_bill_id::text AS "sourceBillId",
                   txn.source_bill_line_id::text AS "sourceBillLineId",
                   txn.source_bill_no AS "sourceBillNo",
                   to_char(txn.source_bill_date, 'YYYY-MM-DD') AS "sourceBillDate",
                   txn.posting_action AS "postingAction",
                   txn.trace_quality AS "traceQuality",
                   txn.qty_delta AS "qtyDelta",
                   txn.qty_on_hand_after AS "qtyOnHandAfter",
                   txn.reversal_of_txn_id::text AS "reversalOfTxnId"
            FROM inv_stock_txn txn
            JOIN md_product product ON product.id = txn.product_id
            JOIN md_warehouse warehouse ON warehouse.id = txn.warehouse_id
            WHERE txn.source_bill_id = ?::uuid
              AND txn.source_bill_line_id = ?::uuid
              AND txn.source_bill_type = ?
              AND product.code = ?
              AND warehouse.code = ?
              AND txn.txn_type IN (%s)
            ORDER BY txn.occurred_at, txn.id
            """.formatted(placeholders), parameters.toArray());
        assertThat(facts)
            .as("%s / %s 生命周期库存事实数量", sourceBillType, sourceDocument.billNo())
            .hasSize(expectedFacts.length);

        for (var index = 0; index < expectedFacts.length; index += 1) {
            var actual = facts.get(index);
            var expected = expectedFacts[index];
            assertThat(actual)
                .containsEntry("accountSetId", expectedInventoryScopeId)
                .containsEntry("txnType", expected.txnType())
                .containsEntry("sourceBillType", sourceBillType)
                .containsEntry("sourceBillId", source.get("sourceBillId"))
                .containsEntry("sourceBillLineId", source.get("sourceBillLineId"))
                .containsEntry("sourceBillNo", source.get("sourceBillNo"))
                .containsEntry("sourceBillDate", source.get("sourceBillDate"))
                .containsEntry("postingAction", expected.action())
                .containsEntry("traceQuality", "EXACT");
            assertThat((BigDecimal) actual.get("qtyDelta")).isEqualByComparingTo(expected.qtyDelta());
            assertThat((BigDecimal) actual.get("qtyOnHandAfter")).isEqualByComparingTo(expected.qtyOnHandAfter());
            if (expected.reversalOfIndex() == null) {
                assertThat(actual.get("reversalOfTxnId")).isNull();
            } else {
                assertThat(expected.reversalOfIndex()).isBetween(0, index - 1);
                assertThat(actual.get("reversalOfTxnId"))
                    .isEqualTo(facts.get(expected.reversalOfIndex()).get("id"));
            }
        }
    }

    private static String identifier(String value) {
        assertThat(value).matches("^[a-z][a-z0-9_]{0,62}$");
        return "\"" + value + "\"";
    }

    private static String sourceDateExpression(String column) {
        var identifier = "header." + identifier(column);
        return "created_at".equals(column)
            ? "(" + identifier + " AT TIME ZONE 'Asia/Shanghai')::date"
            : identifier + "::date";
    }

    public record SourceDocument(
        String headerTable,
        String lineTable,
        String lineBillColumn,
        String headerDateColumn,
        String billNo
    ) {
    }

    public record ExpectedFact(
        String txnType,
        String action,
        String qtyDelta,
        String qtyOnHandAfter,
        Integer reversalOfIndex
    ) {
    }
}
