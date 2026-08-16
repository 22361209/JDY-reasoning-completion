package com.jdy.erp.inventory.application;

import java.math.BigDecimal;
import java.util.Map;
import java.util.UUID;

import com.jdy.erp.inventory.application.InventoryPostingCommand.PostingAction;
import com.jdy.erp.shared.application.LookupService;
import com.jdy.erp.system.tenant.TenantDataScopeService;
import org.springframework.dao.EmptyResultDataAccessException;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.server.ResponseStatusException;

@Service
public class InventoryPostingService {
    private final JdbcTemplate jdbcTemplate;
    private final LookupService lookupService;
    private final TenantDataScopeService tenantDataScopeService;

    public InventoryPostingService(
        JdbcTemplate jdbcTemplate,
        LookupService lookupService,
        TenantDataScopeService tenantDataScopeService
    ) {
        this.jdbcTemplate = jdbcTemplate;
        this.lookupService = lookupService;
        this.tenantDataScopeService = tenantDataScopeService;
    }

    @Transactional
    public Map<String, Object> post(InventoryPostingCommand command) {
        validate(command);
        if (command.quantity().compareTo(BigDecimal.ZERO) == 0) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "数量不能为 0");
        }
        if (command.postingAction() == PostingAction.RESERVE || command.postingAction() == PostingAction.RELEASE) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "库存收发动作不能使用预留/释放标记");
        }

        var source = resolveSource(command);
        ensureBalance(source.accountSetId(), source.productId(), source.warehouseId());
        Map<String, Object> updated;
        try {
            updated = jdbcTemplate.queryForMap("""
                UPDATE inv_stock_balance
                SET qty_on_hand = qty_on_hand + ?,
                    qty_available = qty_available + ?,
                    updated_at = now(),
                    version = version + 1
                WHERE product_id = ?::uuid
                  AND warehouse_id = ?::uuid
                  AND account_set_id = ?::uuid
                  AND qty_on_hand + ? >= 0
                  AND qty_available + ? >= 0
                RETURNING id::text AS id,
                          qty_on_hand AS "qtyOnHandAfter",
                          trim(to_char(qty_on_hand, 'FM9999999990.####')) AS "onHand",
                          trim(to_char(qty_available, 'FM9999999990.####')) AS available
                """,
                command.quantity(), command.quantity(), source.productId(), source.warehouseId(),
                source.accountSetId(), command.quantity(), command.quantity()
            );
        } catch (EmptyResultDataAccessException exception) {
            throw new ResponseStatusException(HttpStatus.CONFLICT, "库存不足，不能调整为负数");
        }
        insertTxn(command, source, command.quantity(), quantityAfter(updated));
        return updated;
    }

    @Transactional
    public Map<String, Object> reserve(InventoryPostingCommand command) {
        validatePositive(command, PostingAction.RESERVE, "预留数量必须大于 0");
        return changeReservation(command, command.quantity());
    }

    @Transactional
    public Map<String, Object> releaseReservation(InventoryPostingCommand command) {
        validatePositive(command, PostingAction.RELEASE, "释放预留数量必须大于 0");
        return changeReservation(command, command.quantity().negate());
    }

    @Transactional
    public Map<String, Object> shipReserved(InventoryPostingCommand command) {
        validatePositive(command, null, "出库数量必须大于 0");
        if (command.postingAction() != PostingAction.AUDIT && command.postingAction() != PostingAction.RED_REVERSE) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "预留出库动作必须为 AUDIT 或 RED_REVERSE");
        }
        var source = resolveSource(command);
        ensureBalance(source.accountSetId(), source.productId(), source.warehouseId());
        Map<String, Object> updated;
        try {
            updated = jdbcTemplate.queryForMap("""
                UPDATE inv_stock_balance
                SET qty_on_hand = qty_on_hand - ?,
                    qty_reserved = qty_reserved - ?,
                    qty_available = qty_on_hand - qty_reserved,
                    updated_at = now(),
                    version = version + 1
                WHERE product_id = ?::uuid
                  AND warehouse_id = ?::uuid
                  AND account_set_id = ?::uuid
                  AND qty_on_hand >= ?
                  AND qty_reserved >= ?
                  AND qty_on_hand - qty_reserved >= 0
                RETURNING id::text AS id,
                          qty_on_hand AS "qtyOnHandAfter",
                          trim(to_char(qty_on_hand, 'FM9999999990.####')) AS "onHand",
                          trim(to_char(qty_reserved, 'FM9999999990.####')) AS reserved,
                          trim(to_char(qty_available, 'FM9999999990.####')) AS available
                """,
                command.quantity(), command.quantity(), source.productId(), source.warehouseId(),
                source.accountSetId(), command.quantity(), command.quantity()
            );
        } catch (EmptyResultDataAccessException exception) {
            throw new ResponseStatusException(HttpStatus.CONFLICT, "预留库存不足，不能销售出库");
        }
        insertTxn(command, source, command.quantity().negate(), quantityAfter(updated));
        return updated;
    }

    @Transactional
    public Map<String, Object> reverseShipReserved(InventoryPostingCommand command) {
        validatePositive(command, null, "回滚出库数量必须大于 0");
        if (command.postingAction() != PostingAction.REVERSE && command.postingAction() != PostingAction.RED_AUDIT) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "预留出库回滚动作必须为 REVERSE 或 RED_AUDIT");
        }
        var source = resolveSource(command);
        ensureBalance(source.accountSetId(), source.productId(), source.warehouseId());
        Map<String, Object> updated;
        try {
            updated = jdbcTemplate.queryForMap("""
                UPDATE inv_stock_balance
                SET qty_on_hand = qty_on_hand + ?,
                    qty_reserved = qty_reserved + ?,
                    qty_available = qty_on_hand - qty_reserved,
                    updated_at = now(),
                    version = version + 1
                WHERE product_id = ?::uuid
                  AND warehouse_id = ?::uuid
                  AND account_set_id = ?::uuid
                  AND qty_on_hand - qty_reserved >= 0
                RETURNING id::text AS id,
                          qty_on_hand AS "qtyOnHandAfter",
                          trim(to_char(qty_on_hand, 'FM9999999990.####')) AS "onHand",
                          trim(to_char(qty_reserved, 'FM9999999990.####')) AS reserved,
                          trim(to_char(qty_available, 'FM9999999990.####')) AS available
                """,
                command.quantity(), command.quantity(), source.productId(), source.warehouseId(), source.accountSetId()
            );
        } catch (EmptyResultDataAccessException exception) {
            throw new ResponseStatusException(HttpStatus.CONFLICT, "库存回滚失败，三量约束不满足");
        }
        insertTxn(command, source, command.quantity(), quantityAfter(updated));
        return updated;
    }

    private Map<String, Object> changeReservation(InventoryPostingCommand command, BigDecimal reservedDelta) {
        var source = resolveSource(command);
        ensureBalance(source.accountSetId(), source.productId(), source.warehouseId());
        Map<String, Object> updated;
        try {
            updated = jdbcTemplate.queryForMap("""
                UPDATE inv_stock_balance
                SET qty_reserved = qty_reserved + ?,
                    qty_available = qty_on_hand - (qty_reserved + ?),
                    updated_at = now(),
                    version = version + 1
                WHERE product_id = ?::uuid
                  AND warehouse_id = ?::uuid
                  AND account_set_id = ?::uuid
                  AND qty_reserved + ? >= 0
                  AND qty_on_hand - (qty_reserved + ?) >= 0
                RETURNING id::text AS id,
                          qty_on_hand AS "qtyOnHandAfter",
                          trim(to_char(qty_on_hand, 'FM9999999990.####')) AS "onHand",
                          trim(to_char(qty_reserved, 'FM9999999990.####')) AS reserved,
                          trim(to_char(qty_available, 'FM9999999990.####')) AS available
                """,
                reservedDelta, reservedDelta, source.productId(), source.warehouseId(), source.accountSetId(),
                reservedDelta, reservedDelta
            );
        } catch (EmptyResultDataAccessException exception) {
            throw new ResponseStatusException(HttpStatus.CONFLICT, "可用库存不足，不能预留或释放");
        }
        // Reservation facts intentionally have zero movement and are excluded
        // from inventory receipt/issue reports.
        insertTxn(command, source, BigDecimal.ZERO, quantityAfter(updated));
        return updated;
    }

    private PostingSource resolveSource(InventoryPostingCommand command) {
        var productId = lookupService.lookupEnabledIdForReference("md_product", command.productCode(), "商品");
        var warehouseId = lookupService.lookupEnabledId("md_warehouse", command.warehouseCode(), "仓库");
        var source = new PostingSource(inventoryScopeId(), productId, warehouseId);
        lockPostingFact(command, source);
        assertNoActiveForwardFact(command, source);
        return source;
    }

    private void ensureBalance(String accountSetId, String productId, String warehouseId) {
        jdbcTemplate.update("""
            INSERT INTO inv_stock_balance (account_set_id, product_id, warehouse_id, qty_on_hand, qty_available, qty_reserved)
            VALUES (?::uuid, ?::uuid, ?::uuid, 0, 0, 0)
            ON CONFLICT (account_set_id, product_id, warehouse_id) DO NOTHING
            """, accountSetId, productId, warehouseId);
    }

    private void insertTxn(
        InventoryPostingCommand command,
        PostingSource source,
        BigDecimal qtyDelta,
        BigDecimal qtyOnHandAfter
    ) {
        var reversalOf = resolveReversal(command, source, qtyDelta);
        jdbcTemplate.queryForObject("""
                INSERT INTO inv_stock_txn (
                    account_set_id,
                    txn_type,
                    product_id,
                    warehouse_id,
                    qty_delta,
                    source_bill_type,
                    source_bill_id,
                    source_bill_line_id,
                    source_bill_no,
                    source_bill_date,
                    posting_action,
                    qty_on_hand_after,
                    trace_quality,
                    reversal_of_txn_id,
                    amount,
                    occurred_at
                )
                VALUES (
                    ?::uuid, ?, ?::uuid, ?::uuid, ?, ?, ?::uuid, ?::uuid,
                    ?, ?, ?, ?, ?, ?::uuid, 0, clock_timestamp()
                )
                RETURNING id::text
                """,
                String.class,
                source.accountSetId(),
                command.txnType().trim(),
                source.productId(),
                source.warehouseId(),
                qtyDelta,
                command.sourceBillType().trim(),
                command.sourceBillId(),
                command.sourceBillLineId(),
                command.sourceBillNo().trim(),
                command.sourceBillDate(),
                command.postingAction().name(),
                qtyOnHandAfter,
                command.traceQuality().name(),
                reversalOf
            );
    }

    private UUID resolveReversal(
        InventoryPostingCommand command,
        PostingSource source,
        BigDecimal reverseQtyDelta
    ) {
        var originalAction = switch (command.postingAction()) {
            case REVERSE -> PostingAction.AUDIT;
            case RED_REVERSE -> PostingAction.RED_AUDIT;
            case RELEASE -> PostingAction.RESERVE;
            default -> null;
        };
        if (originalAction == null || command.traceQuality() != InventoryPostingCommand.TraceQuality.EXACT) {
            return null;
        }
        var originalTxnType = command.txnType().endsWith("_REVERSE")
            ? command.txnType().substring(0, command.txnType().length() - "_REVERSE".length())
            : command.txnType();
        var historicalBillSuffix = ":" + command.sourceBillNo().trim();
        var historicalForwardDocumentPrefix = originalAction == PostingAction.RED_AUDIT
            ? command.sourceBillType().trim() + "_RED"
            : command.sourceBillType().trim();
        var historicalReverseDocumentPrefix = command.postingAction() == PostingAction.RED_REVERSE
            ? command.sourceBillType().trim() + "_RED_REVERSE"
            : command.sourceBillType().trim() + "_REVERSE";
        var historicalForwardTxnSourceType = originalTxnType + historicalBillSuffix;
        var historicalForwardDocumentSourceType = historicalForwardDocumentPrefix + historicalBillSuffix;
        var historicalReverseTxnSourceType = command.txnType() + historicalBillSuffix;
        var historicalReverseDocumentSourceType = historicalReverseDocumentPrefix + historicalBillSuffix;
        var exactRows = jdbcTemplate.queryForList("""
            SELECT id::text AS id
            FROM inv_stock_txn
            WHERE account_set_id = ?::uuid
              AND source_bill_type = ?
              AND source_bill_id = ?::uuid
              AND source_bill_line_id = ?::uuid
              AND product_id = ?::uuid
              AND warehouse_id = ?::uuid
              AND posting_action = ?
              AND txn_type = ?
              AND trace_quality = 'EXACT'
              AND NOT EXISTS (
                  SELECT 1
                  FROM inv_stock_txn reversal
                  WHERE reversal.account_set_id = inv_stock_txn.account_set_id
                    AND reversal.reversal_of_txn_id = inv_stock_txn.id
              )
            ORDER BY occurred_at DESC, id DESC
            LIMIT 1
            FOR UPDATE
            """,
            source.accountSetId(), command.sourceBillType(), command.sourceBillId(), command.sourceBillLineId(),
            source.productId(), source.warehouseId(), originalAction.name(), originalTxnType
        );
        if (!exactRows.isEmpty()) {
            return UUID.fromString(String.valueOf(exactRows.getFirst().get("id")));
        }

        // V106/V107 deliberately retained only header identity for locatable
        // pre-upgrade facts. Never guess a line: a migrated forward fact is a
        // valid fallback only when all persisted business dimensions match and
        // exactly one still-unreversed candidate remains.
        var historicalRows = jdbcTemplate.queryForList("""
            SELECT original.id::text AS id
            FROM inv_stock_txn original
            WHERE original.account_set_id = ?::uuid
              AND original.source_bill_id = ?::uuid
              AND original.source_bill_line_id IS NULL
              AND original.source_bill_type IN (?, ?)
              AND original.source_bill_no = ?
              AND original.source_bill_date = ?
              AND original.product_id = ?::uuid
              AND original.warehouse_id = ?::uuid
              AND original.posting_action = ?
              AND original.txn_type = ?
              AND original.qty_delta = ?
              AND original.trace_quality = 'HEADER_ONLY'
              AND original.reversal_of_txn_id IS NULL
              AND NOT EXISTS (
                  SELECT 1
                  FROM inv_stock_txn reversal
                  WHERE reversal.account_set_id = original.account_set_id
                    AND reversal.reversal_of_txn_id = original.id
              )
              AND NOT EXISTS (
                  SELECT 1
                  FROM inv_stock_txn historical_reversal
                  WHERE historical_reversal.account_set_id = original.account_set_id
                    AND historical_reversal.source_bill_id = original.source_bill_id
                    AND historical_reversal.source_bill_line_id IS NULL
                    AND historical_reversal.source_bill_type IN (?, ?)
                    AND historical_reversal.source_bill_no = original.source_bill_no
                    AND historical_reversal.source_bill_date = original.source_bill_date
                    AND historical_reversal.product_id = original.product_id
                    AND historical_reversal.warehouse_id = original.warehouse_id
                    AND historical_reversal.posting_action = ?
                    AND historical_reversal.txn_type = ?
                    AND historical_reversal.qty_delta = ?
                    AND historical_reversal.trace_quality = 'HEADER_ONLY'
                    AND historical_reversal.occurred_at >= original.occurred_at
              )
            ORDER BY original.occurred_at DESC, original.id DESC
            LIMIT 2
            FOR UPDATE OF original
            """,
            source.accountSetId(), command.sourceBillId(),
            historicalForwardTxnSourceType, historicalForwardDocumentSourceType,
            command.sourceBillNo().trim(), command.sourceBillDate(), source.productId(), source.warehouseId(),
            originalAction.name(), originalTxnType, reverseQtyDelta.negate(),
            historicalReverseTxnSourceType, historicalReverseDocumentSourceType,
            command.postingAction().name(), command.txnType(), reverseQtyDelta
        );
        if (historicalRows.isEmpty()) {
            throw new ResponseStatusException(HttpStatus.CONFLICT, "未找到可关联的原库存流水，不能执行反向动作");
        }
        if (historicalRows.size() != 1) {
            throw new ResponseStatusException(HttpStatus.CONFLICT, "迁移历史库存流水存在歧义，不能猜测来源行");
        }
        return UUID.fromString(String.valueOf(historicalRows.getFirst().get("id")));
    }

    private void lockPostingFact(InventoryPostingCommand command, PostingSource source) {
        if (command.traceQuality() != InventoryPostingCommand.TraceQuality.EXACT) {
            return;
        }
        var key = String.join(
            ":",
            source.accountSetId(),
            command.sourceBillType(),
            command.sourceBillId().toString(),
            command.sourceBillLineId().toString(),
            originalTxnType(command.txnType())
        );
        jdbcTemplate.queryForList("SELECT pg_advisory_xact_lock(hashtextextended(?, 0))", key);
    }

    private void assertNoActiveForwardFact(InventoryPostingCommand command, PostingSource source) {
        if (command.traceQuality() != InventoryPostingCommand.TraceQuality.EXACT
            || command.postingAction() == PostingAction.REVERSE
            || command.postingAction() == PostingAction.RED_REVERSE
            || command.postingAction() == PostingAction.RELEASE) {
            return;
        }
        var count = jdbcTemplate.queryForObject("""
            SELECT count(*)
            FROM inv_stock_txn original
            WHERE original.account_set_id = ?::uuid
              AND original.source_bill_type = ?
              AND original.source_bill_id = ?::uuid
              AND original.source_bill_line_id = ?::uuid
              AND original.product_id = ?::uuid
              AND original.warehouse_id = ?::uuid
              AND original.posting_action = ?
              AND original.txn_type = ?
              AND original.trace_quality = 'EXACT'
              AND NOT EXISTS (
                  SELECT 1
                  FROM inv_stock_txn reversal
                  WHERE reversal.account_set_id = original.account_set_id
                    AND reversal.reversal_of_txn_id = original.id
              )
            """,
            Long.class,
            source.accountSetId(), command.sourceBillType(), command.sourceBillId(), command.sourceBillLineId(),
            source.productId(), source.warehouseId(), command.postingAction().name(), command.txnType()
        );
        if (count != null && count > 0) {
            throw new ResponseStatusException(HttpStatus.CONFLICT, "该单据行已经完成相同库存动作，禁止重复过账");
        }
    }

    private String originalTxnType(String txnType) {
        return txnType.endsWith("_REVERSE")
            ? txnType.substring(0, txnType.length() - "_REVERSE".length())
            : txnType;
    }

    private void validatePositive(
        InventoryPostingCommand command,
        PostingAction requiredAction,
        String errorMessage
    ) {
        validate(command);
        if (command.quantity().compareTo(BigDecimal.ZERO) <= 0) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, errorMessage);
        }
        if (requiredAction != null && command.postingAction() != requiredAction) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "库存动作与过账命令不匹配");
        }
    }

    private void validate(InventoryPostingCommand command) {
        if (command == null) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "库存过账命令不能为空");
        }
        requireText(command.productCode(), "商品编码");
        requireText(command.warehouseCode(), "仓库编码");
        requireText(command.txnType(), "库存事务类型");
        requireText(command.sourceBillType(), "来源单据类型");
        requireText(command.sourceBillNo(), "来源单据编号");
        requireValue(command.sourceBillId(), "来源单据 id");
        requireValue(command.sourceBillLineId(), "来源单据行 id");
        requireValue(command.sourceBillDate(), "来源业务日期");
        requireValue(command.postingAction(), "过账动作");
        requireValue(command.traceQuality(), "追溯质量");
        requireValue(command.quantity(), "数量");
    }

    private void requireText(String value, String label) {
        if (value == null || value.isBlank()) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, label + "不能为空");
        }
    }

    private void requireValue(Object value, String label) {
        if (value == null) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, label + "不能为空");
        }
    }

    private BigDecimal quantityAfter(Map<String, Object> updated) {
        return (BigDecimal) updated.get("qtyOnHandAfter");
    }

    private String inventoryScopeId() {
        return tenantDataScopeService.currentScopeId("inventory");
    }

    private record PostingSource(String accountSetId, String productId, String warehouseId) {
    }
}
