package com.jdy.erp.finance.application;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.math.BigDecimal;
import java.util.List;

import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.server.ResponseStatusException;

@SpringBootTest
@Transactional
class SalesReturnFinanceAppServiceIntegrationTest {
    @Autowired
    private JdbcTemplate jdbcTemplate;

    @Autowired
    private SalesReturnFinanceAppService financeService;

    @Test
    void auditSplitsOffsetAndPendingWithoutChangingCashThenReverseRestoresExactly() {
        var suffix = suffix();
        var customerId = insertCustomer("KH-A142-F-" + suffix);
        var first = insertSource(customerId, "CNY", "XSCK-A142-F1-" + suffix, "100.00", "30.00");
        var second = insertSource(customerId, "CNY", "XSCK-A142-F2-" + suffix, "50.00", "50.00");
        var returnNo = "XSTH-A142-F-" + suffix;
        insertReturn(returnNo, customerId, "CNY", "100.00", List.of(
            new ReturnLine(first, "80.00"),
            new ReturnLine(second, "20.00")
        ));

        var result = financeService.applyAudit(returnNo);

        assertThat(result.offsetAmount()).isEqualByComparingTo("70.00");
        assertThat(result.pendingRefundAmount()).isEqualByComparingTo("30.00");
        assertThat(receivable(first.receivableId()))
            .containsEntry("receivedAmount", new BigDecimal("30.00"))
            .containsEntry("returnOffsetAmount", new BigDecimal("70.00"))
            .containsEntry("status", "SETTLED");
        assertThat(receivable(second.receivableId()))
            .containsEntry("receivedAmount", new BigDecimal("50.00"))
            .containsEntry("returnOffsetAmount", new BigDecimal("0.00"))
            .containsEntry("status", "SETTLED");
        assertThat(jdbcTemplate.queryForList("""
            SELECT source_out_no AS "sourceOutNo",
                   return_amount AS "returnAmount",
                   offset_amount AS "offsetAmount",
                   pending_refund_amount AS "pendingRefundAmount",
                   refunded_amount AS "refundedAmount"
            FROM sales_return_finance_allocation
            WHERE sales_return_id = (SELECT id FROM sales_return WHERE bill_no = ?)
            ORDER BY source_out_no
            """, returnNo)).containsExactly(
                java.util.Map.of(
                    "sourceOutNo", first.sourceOutNo(),
                    "returnAmount", new BigDecimal("80.00"),
                    "offsetAmount", new BigDecimal("70.00"),
                    "pendingRefundAmount", new BigDecimal("10.00"),
                    "refundedAmount", new BigDecimal("0.00")
                ),
                java.util.Map.of(
                    "sourceOutNo", second.sourceOutNo(),
                    "returnAmount", new BigDecimal("20.00"),
                    "offsetAmount", new BigDecimal("0.00"),
                    "pendingRefundAmount", new BigDecimal("20.00"),
                    "refundedAmount", new BigDecimal("0.00")
                )
            );

        markReturnAudited(returnNo);
        var reversed = financeService.reverseAudit(returnNo);

        assertThat(reversed.offsetAmount()).isEqualByComparingTo("70.00");
        assertThat(reversed.pendingRefundAmount()).isEqualByComparingTo("30.00");
        assertThat(receivable(first.receivableId()))
            .containsEntry("receivedAmount", new BigDecimal("30.00"))
            .containsEntry("returnOffsetAmount", new BigDecimal("0.00"))
            .containsEntry("status", "PART_SETTLED");
        assertThat(receivable(second.receivableId()))
            .containsEntry("receivedAmount", new BigDecimal("50.00"))
            .containsEntry("returnOffsetAmount", new BigDecimal("0.00"))
            .containsEntry("status", "SETTLED");
        assertThat(allocationCount(returnNo)).isZero();
    }

    @Test
    void reverseRejectsConsumedPendingRefundWithoutChangingReceivable() {
        var suffix = suffix();
        var customerId = insertCustomer("KH-A142-U-" + suffix);
        var source = insertSource(customerId, "USD", "XSCK-A142-U-" + suffix, "100.00", "90.00");
        var returnNo = "XSTH-A142-U-" + suffix;
        insertReturn(returnNo, customerId, "USD", "20.00", List.of(new ReturnLine(source, "20.00")));
        assertThat(financeService.applyAudit(returnNo).pendingRefundAmount()).isEqualByComparingTo("10.00");
        markReturnAudited(returnNo);
        jdbcTemplate.update("""
            UPDATE sales_return_finance_allocation
            SET refunded_amount = 1.00
            WHERE sales_return_id = (SELECT id FROM sales_return WHERE bill_no = ?)
            """, returnNo);

        assertThatThrownBy(() -> financeService.reverseAudit(returnNo))
            .isInstanceOf(ResponseStatusException.class)
            .hasMessageContaining("待退款已被下游消费");
        assertThat(receivable(source.receivableId()))
            .containsEntry("receivedAmount", new BigDecimal("90.00"))
            .containsEntry("returnOffsetAmount", new BigDecimal("10.00"))
            .containsEntry("status", "SETTLED");
        assertThat(allocationCount(returnNo)).isEqualTo(1);
    }

    @Test
    void reverseRequiresLastAuditedAllocationForEachReceivable() {
        var suffix = suffix();
        var customerId = insertCustomer("KH-A142-LIFO-" + suffix);
        var source = insertSource(customerId, "CNY", "XSCK-A142-LIFO-" + suffix, "100.00", "0.00");
        var firstReturnNo = "XSTH-A142-L1-" + suffix;
        var secondReturnNo = "XSTH-A142-L2-" + suffix;
        insertReturn(firstReturnNo, customerId, "CNY", "80.00", List.of(new ReturnLine(source, "80.00")));
        insertReturn(secondReturnNo, customerId, "CNY", "40.00", List.of(new ReturnLine(source, "40.00")));

        assertThat(financeService.applyAudit(firstReturnNo).offsetAmount()).isEqualByComparingTo("80.00");
        markReturnAudited(firstReturnNo);
        assertThat(financeService.applyAudit(secondReturnNo))
            .satisfies(result -> {
                assertThat(result.offsetAmount()).isEqualByComparingTo("20.00");
                assertThat(result.pendingRefundAmount()).isEqualByComparingTo("20.00");
            });
        markReturnAudited(secondReturnNo);

        assertThatThrownBy(() -> financeService.reverseAudit(firstReturnNo))
            .isInstanceOf(ResponseStatusException.class)
            .hasMessageContaining("先反审核后续销售退货");
        assertThat(receivable(source.receivableId()))
            .containsEntry("returnOffsetAmount", new BigDecimal("100.00"))
            .containsEntry("status", "SETTLED");
        assertThat(allocationCount(firstReturnNo)).isEqualTo(1);
        assertThat(allocationCount(secondReturnNo)).isEqualTo(1);

        assertThat(financeService.reverseAudit(secondReturnNo))
            .satisfies(result -> {
                assertThat(result.offsetAmount()).isEqualByComparingTo("20.00");
                assertThat(result.pendingRefundAmount()).isEqualByComparingTo("20.00");
            });
        markReturnAudited(firstReturnNo);
        assertThat(financeService.reverseAudit(firstReturnNo).offsetAmount()).isEqualByComparingTo("80.00");
        assertThat(receivable(source.receivableId()))
            .containsEntry("returnOffsetAmount", new BigDecimal("0.00"))
            .containsEntry("status", "OPEN");
    }

    @Test
    void auditIgnoresLegacyNonPositiveArAndFailsClosedWithoutOneExactPositiveSource() {
        var suffix = suffix();
        var customerId = insertCustomer("KH-A142-Z-" + suffix);
        var source = insertSource(customerId, "CNY", "XSCK-A142-Z-" + suffix, "100.00", "0.00");
        jdbcTemplate.update("DELETE FROM ar_receivable WHERE id = ?::uuid", source.receivableId());
        jdbcTemplate.update("""
            INSERT INTO ar_receivable (
                bill_no, source_bill_no, customer_id, bill_date, amount,
                received_amount, return_offset_amount, currency, status
            )
            VALUES (?, ?, ?::uuid, DATE '2026-07-14', 0, 0, 0, 'CNY', 'OPEN')
            """, "YS-ZERO-" + suffix, source.sourceOutNo(), customerId);
        var returnNo = "XSTH-A142-Z-" + suffix;
        insertReturn(returnNo, customerId, "CNY", "10.00", List.of(new ReturnLine(source, "10.00")));

        assertThatThrownBy(() -> financeService.applyAudit(returnNo))
            .isInstanceOf(ResponseStatusException.class)
            .hasMessageContaining("普通正应收");
        assertThat(allocationCount(returnNo)).isZero();
        assertThat(jdbcTemplate.queryForObject(
            "SELECT return_offset_amount FROM ar_receivable WHERE bill_no = ?",
            BigDecimal.class,
            "YS-ZERO-" + suffix
        )).isEqualByComparingTo("0.00");
    }

    private String insertCustomer(String code) {
        return jdbcTemplate.queryForObject(
            "INSERT INTO md_customer (code, name, enabled) VALUES (?, ?, TRUE) RETURNING id::text",
            String.class,
            code,
            code
        );
    }

    private SourceFixture insertSource(
        String customerId,
        String currency,
        String sourceOutNo,
        String receivableAmount,
        String receivedAmount
    ) {
        var productId = jdbcTemplate.queryForObject(
            "SELECT id::text FROM md_product WHERE code = 'CP-001'",
            String.class
        );
        var warehouseId = jdbcTemplate.queryForObject(
            "SELECT id::text FROM md_warehouse WHERE code = 'CK-001'",
            String.class
        );
        var sourceOutId = jdbcTemplate.queryForObject("""
            INSERT INTO sales_out (
                bill_no, customer_id, bill_date, status, total_amount, currency
            )
            VALUES (?, ?::uuid, DATE '2026-07-14', 'AUDITED', ?, ?)
            RETURNING id::text
            """, String.class, sourceOutNo, customerId, new BigDecimal(receivableAmount), currency);
        var sourceLineId = jdbcTemplate.queryForObject("""
            INSERT INTO sales_out_line (
                bill_id, line_no, product_id, warehouse_id, qty, unit_price,
                amount, tax_rate, tax_amount, price_tax_total
            )
            VALUES (?::uuid, 1, ?::uuid, ?::uuid, 100, 1.00, 100.00, 0, 0, 100.00)
            RETURNING id::text
            """, String.class, sourceOutId, productId, warehouseId);
        var status = new BigDecimal(receivedAmount).compareTo(BigDecimal.ZERO) == 0
            ? "OPEN"
            : new BigDecimal(receivedAmount).compareTo(new BigDecimal(receivableAmount)) == 0
                ? "SETTLED"
                : "PART_SETTLED";
        var receivableId = jdbcTemplate.queryForObject("""
            INSERT INTO ar_receivable (
                bill_no, source_bill_no, customer_id, bill_date, amount,
                received_amount, return_offset_amount, currency, status
            )
            VALUES (?, ?, ?::uuid, DATE '2026-07-14', ?, ?, 0, ?, ?)
            RETURNING id::text
            """, String.class,
            "YS-" + sourceOutNo,
            sourceOutNo,
            customerId,
            new BigDecimal(receivableAmount),
            new BigDecimal(receivedAmount),
            currency,
            status
        );
        return new SourceFixture(sourceOutNo, sourceLineId, productId, warehouseId, receivableId);
    }

    private void insertReturn(
        String billNo,
        String customerId,
        String currency,
        String totalAmount,
        List<ReturnLine> lines
    ) {
        var returnId = jdbcTemplate.queryForObject("""
            INSERT INTO sales_return (
                bill_no, customer_id, bill_date, status, total_amount, currency
            )
            VALUES (?, ?::uuid, DATE '2026-07-14', 'DRAFT', ?, ?)
            RETURNING id::text
            """, String.class, billNo, customerId, new BigDecimal(totalAmount), currency);
        var lineNo = 1;
        for (var line : lines) {
            jdbcTemplate.update("""
                INSERT INTO sales_return_line (
                    bill_id, line_no, source_out_line_id, source_out_no, source_line_no,
                    product_id, product_code_snapshot, product_name_snapshot,
                    product_unit_snapshot, warehouse_id, qty, unit_price, amount,
                    tax_rate, tax_amount, price_tax_total
                )
                VALUES (
                    ?::uuid, ?, ?::uuid, ?, 1, ?::uuid, 'CP-001', '控制臂总成',
                    '只', ?::uuid, 1, ?, ?, 0, 0, ?
                )
                """,
                returnId,
                lineNo++,
                line.source().sourceLineId(),
                line.source().sourceOutNo(),
                line.source().productId(),
                line.source().warehouseId(),
                new BigDecimal(line.returnAmount()),
                new BigDecimal(line.returnAmount()),
                new BigDecimal(line.returnAmount())
            );
        }
    }

    private void markReturnAudited(String billNo) {
        jdbcTemplate.update("UPDATE sales_return SET status = 'AUDITED' WHERE bill_no = ?", billNo);
    }

    private java.util.Map<String, Object> receivable(String id) {
        return jdbcTemplate.queryForMap("""
            SELECT received_amount AS "receivedAmount",
                   return_offset_amount AS "returnOffsetAmount",
                   status
            FROM ar_receivable
            WHERE id = ?::uuid
            """, id);
    }

    private int allocationCount(String billNo) {
        return jdbcTemplate.queryForObject("""
            SELECT COUNT(*)::int
            FROM sales_return_finance_allocation
            WHERE sales_return_id = (SELECT id FROM sales_return WHERE bill_no = ?)
            """, Integer.class, billNo);
    }

    private String suffix() {
        return Long.toUnsignedString(System.nanoTime(), 36).toUpperCase();
    }

    private record SourceFixture(
        String sourceOutNo,
        String sourceLineId,
        String productId,
        String warehouseId,
        String receivableId
    ) {
    }

    private record ReturnLine(SourceFixture source, String returnAmount) {
    }
}
