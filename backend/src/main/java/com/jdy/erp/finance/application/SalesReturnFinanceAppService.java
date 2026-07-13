package com.jdy.erp.finance.application;

import java.math.BigDecimal;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;

import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.server.ResponseStatusException;

/**
 * Owns the sales-return AR offset and pending-refund facts. The sales module
 * invokes this service inside its document audit/reverse transaction and never
 * writes finance tables directly.
 */
@Service
public class SalesReturnFinanceAppService {
    private final JdbcTemplate jdbcTemplate;

    public SalesReturnFinanceAppService(JdbcTemplate jdbcTemplate) {
        this.jdbcTemplate = jdbcTemplate;
    }

    @Transactional
    public FinanceResult applyAudit(String returnBillNo) {
        var header = loadReturnHeader(returnBillNo, true);
        if (!"DRAFT".equals(header.status())) {
            throw conflict("只有草稿销售退货单可以生成财务分配");
        }
        var existing = jdbcTemplate.queryForObject(
            "SELECT COUNT(*)::int FROM sales_return_finance_allocation WHERE sales_return_id = ?::uuid",
            Integer.class,
            header.id()
        );
        if (existing != null && existing != 0) {
            throw conflict("草稿销售退货单存在异常财务分配，不能重复审核");
        }

        var returnAmounts = loadReturnAmounts(header.id());
        if (returnAmounts.isEmpty()) {
            throw conflict("销售退货单缺少来源明细");
        }
        var returnTotal = returnAmounts.stream()
            .map(SourceReturnAmount::returnAmount)
            .reduce(zero(), BigDecimal::add);
        if (header.totalAmount().compareTo(BigDecimal.ZERO) <= 0
            || returnTotal.compareTo(header.totalAmount()) != 0) {
            throw conflict("销售退货单审核金额必须大于 0 且与明细含税金额一致");
        }

        var allocations = new java.util.ArrayList<PendingAllocation>();
        var uniqueReceivables = new java.util.HashSet<UUID>();
        for (var source : returnAmounts) {
            var receivable = findReceivable(header, source.sourceOutNo());
            if (!uniqueReceivables.add(receivable.id())) {
                throw conflict("不同来源出库不能映射到同一来源应收");
            }
            allocations.add(new PendingAllocation(source, receivable.id()));
        }

        var lockedReceivables = lockReceivables(
            allocations.stream().map(PendingAllocation::receivableId).toList()
        );
        var offsetTotal = zero();
        var pendingTotal = zero();
        for (var allocation : allocations) {
            var source = allocation.source();
            var receivable = lockedReceivables.get(allocation.receivableId());
            validateReceivable(header, source.sourceOutNo(), receivable);

            var unsettled = receivable.unsettledAmount();
            var offset = source.returnAmount().min(unsettled);
            var pending = source.returnAmount().subtract(offset);
            jdbcTemplate.update("""
                INSERT INTO sales_return_finance_allocation (
                    sales_return_id, receivable_id, source_out_no, receivable_bill_no,
                    currency, source_amount, received_before, return_offset_before,
                    unsettled_before, return_amount, offset_amount,
                    pending_refund_amount, refunded_amount, created_at, updated_at
                )
                VALUES (
                    ?::uuid, ?::uuid, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0,
                    clock_timestamp(), clock_timestamp()
                )
                """,
                header.id(),
                receivable.id(),
                source.sourceOutNo(),
                receivable.billNo(),
                header.currency(),
                receivable.amount(),
                receivable.receivedAmount(),
                receivable.returnOffsetAmount(),
                unsettled,
                source.returnAmount(),
                offset,
                pending
            );

            var newOffset = receivable.returnOffsetAmount().add(offset);
            var changed = jdbcTemplate.update("""
                UPDATE ar_receivable
                SET return_offset_amount = ?,
                    status = ?,
                    updated_at = now()
                WHERE id = ?::uuid
                  AND amount > 0
                  AND received_amount >= 0
                  AND return_offset_amount >= 0
                  AND received_amount + return_offset_amount + ? <= amount
                """,
                newOffset,
                settlementStatus(receivable.amount(), receivable.receivedAmount().add(newOffset)),
                receivable.id(),
                offset
            );
            if (changed != 1) {
                throw conflict("来源应收实时未收余额已变化，请刷新后重试");
            }
            offsetTotal = offsetTotal.add(offset);
            pendingTotal = pendingTotal.add(pending);
        }
        return new FinanceResult(offsetTotal, pendingTotal);
    }

    @Transactional
    public FinanceResult reverseAudit(String returnBillNo) {
        var header = loadReturnHeader(returnBillNo, true);
        if (!"AUDITED".equals(header.status())) {
            throw conflict("只有已审核销售退货单可以释放财务分配");
        }
        var allocations = loadAllocations(header.id());
        if (allocations.isEmpty()) {
            throw conflict("已审核销售退货单缺少财务分配事实");
        }
        if (allocations.stream().anyMatch(row -> row.refundedAmount().compareTo(BigDecimal.ZERO) != 0)) {
            throw conflict("销售退货待退款已被下游消费，不能反审核");
        }

        var lockedReceivables = lockReceivables(
            allocations.stream().map(ReturnAllocation::receivableId).toList()
        );
        assertNoLaterAuditedAllocations(header.id(), allocations);
        var offsetTotal = zero();
        var pendingTotal = zero();
        for (var allocation : allocations) {
            var receivable = lockedReceivables.get(allocation.receivableId());
            validateReceivable(header, allocation.sourceOutNo(), receivable);
            if (!allocation.currency().equals(header.currency())
                || !allocation.receivableBillNo().equals(receivable.billNo())
                || allocation.sourceAmount().compareTo(receivable.amount()) != 0
                || allocation.returnAmount().compareTo(
                    allocation.offsetAmount().add(allocation.pendingRefundAmount())
                ) != 0
                || receivable.returnOffsetAmount().compareTo(
                    allocation.returnOffsetBefore().add(allocation.offsetAmount())
                ) != 0) {
                throw conflict("来源应收或销售退货财务快照已变化，不能安全反审核");
            }

            var newOffset = receivable.returnOffsetAmount().subtract(allocation.offsetAmount());
            var changed = jdbcTemplate.update("""
                UPDATE ar_receivable
                SET return_offset_amount = ?,
                    status = ?,
                    updated_at = now()
                WHERE id = ?::uuid
                  AND return_offset_amount >= ?
                """,
                newOffset,
                settlementStatus(receivable.amount(), receivable.receivedAmount().add(newOffset)),
                receivable.id(),
                allocation.offsetAmount()
            );
            if (changed != 1) {
                throw conflict("来源应收退货冲销额已变化，不能安全反审核");
            }
            offsetTotal = offsetTotal.add(allocation.offsetAmount());
            pendingTotal = pendingTotal.add(allocation.pendingRefundAmount());
        }

        var deleted = jdbcTemplate.update(
            "DELETE FROM sales_return_finance_allocation WHERE sales_return_id = ?::uuid",
            header.id()
        );
        if (deleted != allocations.size()) {
            throw conflict("销售退货财务分配已变化，不能安全反审核");
        }
        return new FinanceResult(offsetTotal, pendingTotal);
    }

    private ReturnHeader loadReturnHeader(String billNo, boolean lock) {
        if (billNo == null || billNo.isBlank()) {
            throw conflict("销售退货单号不能为空");
        }
        var rows = jdbcTemplate.queryForList("""
            SELECT id::text AS id,
                   bill_no AS "billNo",
                   customer_id::text AS "customerId",
                   currency,
                   total_amount AS "totalAmount",
                   status
            FROM sales_return
            WHERE bill_no = ?
            %s
            """.formatted(lock ? "FOR UPDATE" : ""), billNo.trim());
        if (rows.isEmpty()) {
            throw new ResponseStatusException(HttpStatus.NOT_FOUND, "销售退货单不存在");
        }
        var row = rows.getFirst();
        return new ReturnHeader(
            uuid(row.get("id")),
            String.valueOf(row.get("billNo")),
            uuid(row.get("customerId")),
            String.valueOf(row.get("currency")),
            decimal(row.get("totalAmount")),
            String.valueOf(row.get("status"))
        );
    }

    private List<SourceReturnAmount> loadReturnAmounts(UUID returnId) {
        return jdbcTemplate.queryForList("""
            SELECT source_out_no AS "sourceOutNo",
                   SUM(price_tax_total) AS "returnAmount"
            FROM sales_return_line
            WHERE bill_id = ?::uuid
            GROUP BY source_out_no
            ORDER BY source_out_no
            """, returnId).stream().map(row -> new SourceReturnAmount(
                String.valueOf(row.get("sourceOutNo")),
                decimal(row.get("returnAmount"))
            )).toList();
    }

    private ReceivableState findReceivable(ReturnHeader header, String sourceOutNo) {
        var rows = jdbcTemplate.queryForList("""
            SELECT id::text AS id,
                   bill_no AS "billNo",
                   source_bill_no AS "sourceBillNo",
                   customer_id::text AS "customerId",
                   currency,
                   amount,
                   received_amount AS "receivedAmount",
                   return_offset_amount AS "returnOffsetAmount",
                   status
            FROM ar_receivable
            WHERE source_bill_no = ?
              AND customer_id = ?::uuid
              AND currency = ?
              AND amount > 0
            ORDER BY id
            """, sourceOutNo, header.customerId(), header.currency());
        if (rows.size() != 1) {
            throw conflict("来源销售出库必须且只能存在一张同客户同币种的普通正应收：" + sourceOutNo);
        }
        return receivable(rows.getFirst());
    }

    private Map<UUID, ReceivableState> lockReceivables(List<UUID> receivableIds) {
        var ids = receivableIds.stream()
            .distinct()
            .sorted(Comparator.comparing(UUID::toString))
            .toList();
        var result = new LinkedHashMap<UUID, ReceivableState>();
        for (var id : ids) {
            var rows = jdbcTemplate.queryForList("""
                SELECT id::text AS id,
                       bill_no AS "billNo",
                       source_bill_no AS "sourceBillNo",
                       customer_id::text AS "customerId",
                       currency,
                       amount,
                       received_amount AS "receivedAmount",
                       return_offset_amount AS "returnOffsetAmount",
                       status
                FROM ar_receivable
                WHERE id = ?::uuid
                FOR UPDATE
                """, id);
            if (rows.isEmpty()) {
                throw conflict("来源应收不存在");
            }
            result.put(id, receivable(rows.getFirst()));
        }
        return result;
    }

    private void validateReceivable(
        ReturnHeader header,
        String sourceOutNo,
        ReceivableState receivable
    ) {
        if (receivable == null
            || !sourceOutNo.equals(receivable.sourceBillNo())
            || !header.customerId().equals(receivable.customerId())
            || !header.currency().equals(receivable.currency())
            || receivable.amount().compareTo(BigDecimal.ZERO) <= 0) {
            throw conflict("来源应收与销售退货客户、币种或来源不一致");
        }
        if (receivable.receivedAmount().compareTo(BigDecimal.ZERO) < 0
            || receivable.returnOffsetAmount().compareTo(BigDecimal.ZERO) < 0
            || receivable.effectiveSettledAmount().compareTo(receivable.amount()) > 0) {
            throw conflict("来源应收收款或退货冲销金额异常");
        }
        var expectedStatus = settlementStatus(receivable.amount(), receivable.effectiveSettledAmount());
        if (!expectedStatus.equals(receivable.status())) {
            throw conflict("来源应收状态与实时核销金额不一致");
        }
    }

    private List<ReturnAllocation> loadAllocations(UUID returnId) {
        return jdbcTemplate.queryForList("""
            SELECT id::text AS id,
                   receivable_id::text AS "receivableId",
                   source_out_no AS "sourceOutNo",
                   receivable_bill_no AS "receivableBillNo",
                   currency,
                   source_amount AS "sourceAmount",
                   return_offset_before AS "returnOffsetBefore",
                   return_amount AS "returnAmount",
                   offset_amount AS "offsetAmount",
                   pending_refund_amount AS "pendingRefundAmount",
                   refunded_amount AS "refundedAmount"
            FROM sales_return_finance_allocation
            WHERE sales_return_id = ?::uuid
            ORDER BY receivable_id
            FOR UPDATE
            """, returnId).stream().map(row -> new ReturnAllocation(
                uuid(row.get("id")),
                uuid(row.get("receivableId")),
                String.valueOf(row.get("sourceOutNo")),
                String.valueOf(row.get("receivableBillNo")),
                String.valueOf(row.get("currency")),
                decimal(row.get("sourceAmount")),
                decimal(row.get("returnOffsetBefore")),
                decimal(row.get("returnAmount")),
                decimal(row.get("offsetAmount")),
                decimal(row.get("pendingRefundAmount")),
                decimal(row.get("refundedAmount"))
            )).toList();
    }

    private void assertNoLaterAuditedAllocations(
        UUID returnId,
        List<ReturnAllocation> allocations
    ) {
        for (var allocation : allocations) {
            var hasLaterAllocation = jdbcTemplate.queryForObject("""
                SELECT EXISTS (
                    SELECT 1
                    FROM sales_return_finance_allocation later
                    JOIN sales_return later_return ON later_return.id = later.sales_return_id
                    JOIN sales_return_finance_allocation current
                      ON current.id = ?::uuid
                     AND current.receivable_id = later.receivable_id
                    WHERE later.receivable_id = ?::uuid
                      AND later.sales_return_id <> ?::uuid
                      AND later_return.status = 'AUDITED'
                      AND (later.created_at, later.id) > (current.created_at, current.id)
                )
                """, Boolean.class, allocation.id(), allocation.receivableId(), returnId);
            if (Boolean.TRUE.equals(hasLaterAllocation)) {
                throw conflict("来源应收存在后续已审核销售退货，请先反审核后续销售退货");
            }
        }
    }

    private ReceivableState receivable(Map<String, Object> row) {
        return new ReceivableState(
            uuid(row.get("id")),
            String.valueOf(row.get("billNo")),
            String.valueOf(row.get("sourceBillNo")),
            uuid(row.get("customerId")),
            String.valueOf(row.get("currency")),
            decimal(row.get("amount")),
            decimal(row.get("receivedAmount")),
            decimal(row.get("returnOffsetAmount")),
            String.valueOf(row.get("status"))
        );
    }

    private String settlementStatus(BigDecimal amount, BigDecimal effectiveSettled) {
        if (effectiveSettled.compareTo(BigDecimal.ZERO) == 0) {
            return "OPEN";
        }
        if (effectiveSettled.compareTo(amount) == 0) {
            return "SETTLED";
        }
        return "PART_SETTLED";
    }

    private UUID uuid(Object value) {
        try {
            return UUID.fromString(String.valueOf(value));
        } catch (IllegalArgumentException exception) {
            throw conflict("销售退货财务事实标识格式不正确");
        }
    }

    private BigDecimal decimal(Object value) {
        if (value instanceof BigDecimal decimal) {
            return decimal;
        }
        return new BigDecimal(String.valueOf(value));
    }

    private BigDecimal zero() {
        return BigDecimal.ZERO.setScale(2);
    }

    private ResponseStatusException conflict(String reason) {
        return new ResponseStatusException(HttpStatus.CONFLICT, reason);
    }

    public record FinanceResult(BigDecimal offsetAmount, BigDecimal pendingRefundAmount) {
    }

    private record ReturnHeader(
        UUID id,
        String billNo,
        UUID customerId,
        String currency,
        BigDecimal totalAmount,
        String status
    ) {
    }

    private record SourceReturnAmount(String sourceOutNo, BigDecimal returnAmount) {
    }

    private record PendingAllocation(SourceReturnAmount source, UUID receivableId) {
    }

    private record ReturnAllocation(
        UUID id,
        UUID receivableId,
        String sourceOutNo,
        String receivableBillNo,
        String currency,
        BigDecimal sourceAmount,
        BigDecimal returnOffsetBefore,
        BigDecimal returnAmount,
        BigDecimal offsetAmount,
        BigDecimal pendingRefundAmount,
        BigDecimal refundedAmount
    ) {
    }

    private record ReceivableState(
        UUID id,
        String billNo,
        String sourceBillNo,
        UUID customerId,
        String currency,
        BigDecimal amount,
        BigDecimal receivedAmount,
        BigDecimal returnOffsetAmount,
        String status
    ) {
        private BigDecimal effectiveSettledAmount() {
            return receivedAmount.add(returnOffsetAmount);
        }

        private BigDecimal unsettledAmount() {
            return amount.subtract(effectiveSettledAmount());
        }
    }
}
