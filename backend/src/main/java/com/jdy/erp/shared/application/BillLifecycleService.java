package com.jdy.erp.shared.application;

import java.math.BigDecimal;
import java.util.HashMap;
import java.util.EnumMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;

import com.jdy.erp.shared.application.ConversionService.SourceExecutionSpec;
import com.jdy.erp.shared.domain.BillStatus;
import com.jdy.erp.system.security.CurrentSessionService;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.server.ResponseStatusException;

@Service
public class BillLifecycleService {
    private static final Set<String> BILL_TABLES = Set.of(
        "sales_order",
        "sales_quote",
        "delivery_notice",
        "sales_out",
        "sales_return",
        "purchase_order",
        "purchase_in",
        "purchase_return",
        "ar_receipt",
        "ap_payment",
        "production_task",
        "production_material_issue",
        "production_completion",
        "other_stock_in",
        "other_stock_out",
        "stock_transfer",
        "stock_count",
        "stock_count_gain",
        "stock_count_loss"
    );
    private static final Set<String> RED_REVERSE_SOURCE_TABLES = Set.of(
        "sales_out",
        "purchase_in",
        "production_material_issue",
        "production_completion"
    );

    private final JdbcTemplate jdbcTemplate;
    private final OperationLogService operationLogService;
    private final OperationLogFailureService operationLogFailureService;
    private final CurrentSessionService currentSessionService;

    public BillLifecycleService(
        JdbcTemplate jdbcTemplate,
        OperationLogService operationLogService,
        OperationLogFailureService operationLogFailureService,
        CurrentSessionService currentSessionService
    ) {
        this.jdbcTemplate = jdbcTemplate;
        this.operationLogService = operationLogService;
        this.operationLogFailureService = operationLogFailureService;
        this.currentSessionService = currentSessionService;
    }

    public Map<String, Object> transition(String table, String billNo, BillStatus from, BillStatus to) {
        return transition(table, billNo, from, to, null, table, to.name(), table, null);
    }

    public void guardPositiveLineQuantities(BillLifecycleTarget target, String billNo, String message) {
        guardTarget(target);
        var count = jdbcTemplate.queryForObject("""
            SELECT COUNT(*)
            FROM %s line
            JOIN %s bill ON bill.id = line.%s
            WHERE bill.bill_no = ?
              AND line.qty <= 0
            """.formatted(target.lineTable(), target.headerTable(), target.lineOwnerColumn()), Integer.class, billNo);
        if (count != null && count > 0) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, message);
        }
    }


    public Map<String, Object> transitionAny(
        String table,
        String billNo,
        BillStatus to,
        String returning,
        String module,
        String action,
        String targetType,
        String notFoundMessage
    ) {
        guardTable(table);
        var before = lifecycleState(table, billNo);
        var returningClause = returning == null || returning.isBlank()
            ? "id::text AS id, bill_no AS \"billNo\", status"
            : returning;
        var rows = jdbcTemplate.queryForList("""
            UPDATE %s
            SET status = ?, updated_at = now(), version = version + 1
            WHERE bill_no = ?
            RETURNING %s
            """.formatted(table, returningClause), to.name(), billNo);
        if (rows.isEmpty()) {
            logLifecycleFailure(module, action, targetType, billNo, before, notFoundMessage);
            throw new ResponseStatusException(HttpStatus.NOT_FOUND, notFoundMessage);
        }
        logLifecycleSuccess(module, action, targetType, billNo, rowState(before), rows.get(0));
        return rows.get(0);
    }
    public Map<String, Object> transition(
        String table,
        String billNo,
        BillStatus from,
        BillStatus to,
        String returning,
        String module,
        String action,
        String targetType,
        String conflictMessage
    ) {
        guardTable(table);
        var timestampAssignment = switch (to) {
            case REVERSED -> ", reversed_at = now()";
            case VOID -> ", voided_at = now()";
            default -> "";
        };
        var returningClause = returning == null || returning.isBlank()
            ? "id::text AS id, bill_no AS \"billNo\", status"
            : returning;
        var rows = jdbcTemplate.queryForList("""
            UPDATE %s
            SET status = ?, updated_at = now(), version = version + 1%s
            WHERE bill_no = ? AND status = ?
            RETURNING %s
            """.formatted(table, timestampAssignment, returningClause), to.name(), billNo, from.name());
        if (rows.isEmpty()) {
            var reason = conflictMessage == null ? "单据状态已变化，请刷新后重试" : conflictMessage;
            logLifecycleFailure(module, action, targetType, billNo, lifecycleState(table, billNo), reason);
            throw new ResponseStatusException(HttpStatus.CONFLICT, reason);
        }
        logLifecycleSuccess(
            module,
            action,
            targetType,
            billNo,
            OperationLogCommand.state(OperationLogCommand.StateField.STATUS, from.name()),
            rows.get(0)
        );
        return rows.get(0);
    }

    @Transactional
    public Map<String, Object> deleteDraft(BillLifecycleTarget target, String billNo, String conflictMessage) {
        guardTarget(target);
        var rows = jdbcTemplate.queryForList("""
            SELECT id::text AS id, bill_no AS "billNo"
            FROM %s
            WHERE bill_no = ? AND status = ?
            """.formatted(target.headerTable()), billNo, BillStatus.DRAFT.name());
        if (rows.isEmpty()) {
            var reason = conflictMessage == null ? "只有草稿单据可以删除" : conflictMessage;
            logLifecycleFailure(target.module(), "DELETE", target.targetType(), billNo, lifecycleState(target.headerTable(), billNo), reason);
            throw new ResponseStatusException(HttpStatus.CONFLICT, reason);
        }
        var row = rows.get(0);
        jdbcTemplate.update("""
            DELETE FROM %s
            WHERE %s = ?::uuid
            """.formatted(target.lineTable(), target.lineOwnerColumn()), row.get("id"));
        jdbcTemplate.update("""
            DELETE FROM %s
            WHERE id = ?::uuid
            """.formatted(target.headerTable()), row.get("id"));
        logLifecycleSuccess(
            target.module(),
            "DELETE",
            target.targetType(),
            billNo,
            OperationLogCommand.state(OperationLogCommand.StateField.STATUS, BillStatus.DRAFT.name()),
            OperationLogCommand.state(OperationLogCommand.StateField.STATUS, "DELETED"),
            String.valueOf(row.get("id"))
        );
        return row;
    }

    @Transactional
    public Map<String, Object> closeBill(BillLifecycleTarget target, String billNo, String reason) {
        guardTarget(target);
        BillLifecyclePolicy.requireCloseFreezeAllowed(target, "关闭");
        var requiredReason = requiredReason(reason, "关闭原因");
        var rows = isSalesOrderTarget(target)
            ? jdbcTemplate.queryForList("""
                UPDATE sales_order
                SET close_status = 'CLOSED',
                    close_mode = 'MANUAL',
                    close_reason = ?,
                    closed_by = ?::uuid,
                    closed_at = now(),
                    updated_at = now(),
                    version = version + 1
                WHERE bill_no = ?
                  AND status = 'AUDITED'
                  AND frozen_status = 'NORMAL'
                  AND close_status <> 'CLOSED'
                RETURNING id::text AS id, bill_no AS "billNo", status, close_status AS "closeStatus", close_mode AS "closeMode", frozen_status AS "frozenStatus"
                """, requiredReason, currentSessionService.currentUserId(), billNo)
            : jdbcTemplate.queryForList("""
                UPDATE %s
                SET close_status = 'CLOSED',
                    close_reason = ?,
                    closed_by = ?::uuid,
                    closed_at = now(),
                    updated_at = now(),
                    version = version + 1
                WHERE bill_no = ?
                  AND status = 'AUDITED'
                  AND frozen_status = 'NORMAL'
                  AND close_status <> 'CLOSED'
                RETURNING id::text AS id, bill_no AS "billNo", status, close_status AS "closeStatus", frozen_status AS "frozenStatus"
                """.formatted(target.headerTable()), requiredReason, currentSessionService.currentUserId(), billNo);
        if (rows.isEmpty()) {
            var failureReason = "只有已审核、未冻结且未关闭的单据可以关闭";
            logLifecycleFailure(target.module(), "CLOSE", target.targetType(), billNo, lifecycleState(target.headerTable(), billNo), failureReason);
            throw new ResponseStatusException(HttpStatus.CONFLICT, failureReason);
        }
        if (!isSalesOrderTarget(target)) {
            jdbcTemplate.update("""
                UPDATE %s
                SET line_close_status = 'CLOSED',
                    line_close_reason = COALESCE(line_close_reason, ?)
                WHERE %s = ?::uuid
                  AND line_close_status <> 'CLOSED'
                """.formatted(target.lineTable(), target.lineOwnerColumn()), requiredReason, rows.get(0).get("id"));
        }
        logLifecycleSuccess(
            target.module(),
            "CLOSE",
            target.targetType(),
            billNo,
            OperationLogCommand.state(
                OperationLogCommand.StateField.STATUS, BillStatus.AUDITED.name(),
                OperationLogCommand.StateField.CLOSE_STATUS, "OPEN",
                OperationLogCommand.StateField.FROZEN_STATUS, "NORMAL"
            ),
            rows.get(0)
        );
        return rows.get(0);
    }

    @Transactional
    public Map<String, Object> reopenBill(BillLifecycleTarget target, String billNo, String reason) {
        guardTarget(target);
        BillLifecyclePolicy.requireCloseFreezeAllowed(target, "反关闭");
        var rows = isSalesOrderTarget(target)
            ? jdbcTemplate.queryForList("""
                UPDATE sales_order
                SET close_status = 'OPEN',
                    close_mode = NULL,
                    close_reason = NULL,
                    closed_by = NULL,
                    closed_at = NULL,
                    updated_at = now(),
                    version = version + 1
                WHERE bill_no = ?
                  AND status = 'AUDITED'
                  AND close_status = 'CLOSED'
                  AND close_mode = 'MANUAL'
                RETURNING id::text AS id, bill_no AS "billNo", status, close_status AS "closeStatus", close_mode AS "closeMode", frozen_status AS "frozenStatus"
                """, billNo)
            : jdbcTemplate.queryForList("""
                UPDATE %s
                SET close_status = 'OPEN',
                    close_reason = ?,
                    closed_by = NULL,
                    closed_at = NULL,
                    updated_at = now(),
                    version = version + 1
                WHERE bill_no = ?
                  AND status = 'AUDITED'
                  AND close_status = 'CLOSED'
                RETURNING id::text AS id, bill_no AS "billNo", status, close_status AS "closeStatus", frozen_status AS "frozenStatus"
                """.formatted(target.headerTable()), optionalReason(reason), billNo);
        if (rows.isEmpty()) {
            var failureReason = isSalesOrderTarget(target) ? "只有手动关闭的销售订单可以反关闭" : "只有已审核且已关闭的单据可以反关闭";
            logLifecycleFailure(target.module(), "UNCLOSE", target.targetType(), billNo, lifecycleState(target.headerTable(), billNo), failureReason);
            throw new ResponseStatusException(HttpStatus.CONFLICT, failureReason);
        }
        if (!isSalesOrderTarget(target)) {
            jdbcTemplate.update("""
                UPDATE %s
                SET line_close_status = 'OPEN',
                    line_close_reason = ?
                WHERE %s = ?::uuid
                """.formatted(target.lineTable(), target.lineOwnerColumn()), optionalReason(reason), rows.get(0).get("id"));
        }
        logLifecycleSuccess(
            target.module(),
            "UNCLOSE",
            target.targetType(),
            billNo,
            OperationLogCommand.state(
                OperationLogCommand.StateField.STATUS, BillStatus.AUDITED.name(),
                OperationLogCommand.StateField.CLOSE_STATUS, "CLOSED"
            ),
            rows.get(0)
        );
        return rows.get(0);
    }

    @Transactional
    public Map<String, Object> freezeBill(BillLifecycleTarget target, String billNo, String reason) {
        guardTarget(target);
        BillLifecyclePolicy.requireCloseFreezeAllowed(target, "冻结");
        var rows = jdbcTemplate.queryForList("""
            UPDATE %s
            SET frozen_status = 'FROZEN',
                frozen_reason = ?,
                frozen_by = ?::uuid,
                frozen_at = now(),
                updated_at = now(),
                version = version + 1
            WHERE bill_no = ?
              AND status = 'AUDITED'
              AND close_status = 'OPEN'
              AND frozen_status <> 'FROZEN'
            RETURNING id::text AS id, bill_no AS "billNo", status, close_status AS "closeStatus", frozen_status AS "frozenStatus"
            """.formatted(target.headerTable()), requiredReason(reason, "冻结原因"), currentSessionService.currentUserId(), billNo);
        if (rows.isEmpty()) {
            var failureReason = "只有已审核、未关闭且未冻结的单据可以冻结";
            logLifecycleFailure(target.module(), "FREEZE", target.targetType(), billNo, lifecycleState(target.headerTable(), billNo), failureReason);
            throw new ResponseStatusException(HttpStatus.CONFLICT, failureReason);
        }
        jdbcTemplate.update("""
            UPDATE %s
            SET line_frozen_status = 'FROZEN',
                line_frozen_reason = COALESCE(line_frozen_reason, ?)
            WHERE %s = ?::uuid
              AND line_frozen_status <> 'FROZEN'
            """.formatted(target.lineTable(), target.lineOwnerColumn()), requiredReason(reason, "冻结原因"), rows.get(0).get("id"));
        logLifecycleSuccess(
            target.module(),
            "FREEZE",
            target.targetType(),
            billNo,
            OperationLogCommand.state(
                OperationLogCommand.StateField.STATUS, BillStatus.AUDITED.name(),
                OperationLogCommand.StateField.CLOSE_STATUS, "OPEN",
                OperationLogCommand.StateField.FROZEN_STATUS, "NORMAL"
            ),
            rows.get(0)
        );
        return rows.get(0);
    }

    @Transactional
    public Map<String, Object> unfreezeBill(BillLifecycleTarget target, String billNo, String reason) {
        guardTarget(target);
        BillLifecyclePolicy.requireCloseFreezeAllowed(target, "解冻");
        var rows = jdbcTemplate.queryForList("""
            UPDATE %s
            SET frozen_status = 'NORMAL',
                frozen_reason = ?,
                frozen_by = NULL,
                frozen_at = NULL,
                updated_at = now(),
                version = version + 1
            WHERE bill_no = ?
              AND status = 'AUDITED'
              AND frozen_status = 'FROZEN'
            RETURNING id::text AS id, bill_no AS "billNo", status, close_status AS "closeStatus", frozen_status AS "frozenStatus"
            """.formatted(target.headerTable()), optionalReason(reason), billNo);
        if (rows.isEmpty()) {
            var failureReason = "只有已审核且已冻结的单据可以解冻";
            logLifecycleFailure(target.module(), "UNFREEZE", target.targetType(), billNo, lifecycleState(target.headerTable(), billNo), failureReason);
            throw new ResponseStatusException(HttpStatus.CONFLICT, failureReason);
        }
        jdbcTemplate.update("""
            UPDATE %s
            SET line_frozen_status = 'NORMAL',
                line_frozen_reason = ?
            WHERE %s = ?::uuid
            """.formatted(target.lineTable(), target.lineOwnerColumn()), optionalReason(reason), rows.get(0).get("id"));
        logLifecycleSuccess(
            target.module(),
            "UNFREEZE",
            target.targetType(),
            billNo,
            OperationLogCommand.state(
                OperationLogCommand.StateField.STATUS, BillStatus.AUDITED.name(),
                OperationLogCommand.StateField.FROZEN_STATUS, "FROZEN"
            ),
            rows.get(0)
        );
        return rows.get(0);
    }

    @Transactional
    public Map<String, Object> setLineClosed(BillLifecycleTarget target, String billNo, int lineNo, boolean closed, String reason) {
        guardTarget(target);
        if (isSalesOrderTarget(target)) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "销售订单新业务不支持行关闭/反关闭，请使用整单关闭/反关闭。");
        }
        BillLifecyclePolicy.requireLineCloseFreezeAllowed(target, closed ? "关闭" : "反关闭");
        var header = header(target, billNo);
        requireAuditedExecutableHeader(header, closed ? "行关闭" : "行反关闭");
        var updated = jdbcTemplate.update("""
            UPDATE %s
            SET line_close_status = ?,
                line_close_reason = ?
            WHERE %s = ?::uuid
              AND line_no = ?
            """.formatted(target.lineTable(), target.lineOwnerColumn()),
            closed ? "CLOSED" : "OPEN",
            closed ? requiredReason(reason, "行关闭原因") : optionalReason(reason),
            header.get("id"),
            lineNo
        );
        if (updated == 0) {
            throw new ResponseStatusException(HttpStatus.NOT_FOUND, "单据行不存在");
        }
        syncHeaderCloseStatus(target, header, reason);
        var result = header(target, billNo);
        logLifecycleSuccess(
            target.module(),
            closed ? "LINE_CLOSE" : "LINE_UNCLOSE",
            target.targetType(),
            billNo,
            OperationLogCommand.state(
                OperationLogCommand.StateField.STATUS, header.get("status"),
                OperationLogCommand.StateField.LINE_NO, lineNo,
                OperationLogCommand.StateField.LINE_CLOSE_STATUS, closed ? "OPEN" : "CLOSED"
            ),
            OperationLogCommand.state(
                OperationLogCommand.StateField.STATUS, result.get("status"),
                OperationLogCommand.StateField.CLOSE_STATUS, result.get("closeStatus"),
                OperationLogCommand.StateField.LINE_NO, lineNo,
                OperationLogCommand.StateField.LINE_CLOSE_STATUS, closed ? "CLOSED" : "OPEN"
            ),
            String.valueOf(header.get("id"))
        );
        return result;
    }

    @Transactional
    public Map<String, Object> setLineFrozen(BillLifecycleTarget target, String billNo, int lineNo, boolean frozen, String reason) {
        guardTarget(target);
        BillLifecyclePolicy.requireLineCloseFreezeAllowed(target, frozen ? "冻结" : "解冻");
        var header = header(target, billNo);
        requireAuditedExecutableHeader(header, frozen ? "行冻结" : "行解冻");
        var updated = jdbcTemplate.update("""
            UPDATE %s
            SET line_frozen_status = ?,
                line_frozen_reason = ?
            WHERE %s = ?::uuid
              AND line_no = ?
            """.formatted(target.lineTable(), target.lineOwnerColumn()),
            frozen ? "FROZEN" : "NORMAL",
            frozen ? requiredReason(reason, "行冻结原因") : optionalReason(reason),
            header.get("id"),
            lineNo
        );
        if (updated == 0) {
            throw new ResponseStatusException(HttpStatus.NOT_FOUND, "单据行不存在");
        }
        var result = header(target, billNo);
        logLifecycleSuccess(
            target.module(),
            frozen ? "LINE_FREEZE" : "LINE_UNFREEZE",
            target.targetType(),
            billNo,
            OperationLogCommand.state(
                OperationLogCommand.StateField.STATUS, header.get("status"),
                OperationLogCommand.StateField.LINE_NO, lineNo,
                OperationLogCommand.StateField.LINE_FROZEN_STATUS, frozen ? "NORMAL" : "FROZEN"
            ),
            OperationLogCommand.state(
                OperationLogCommand.StateField.STATUS, result.get("status"),
                OperationLogCommand.StateField.FROZEN_STATUS, result.get("frozenStatus"),
                OperationLogCommand.StateField.LINE_NO, lineNo,
                OperationLogCommand.StateField.LINE_FROZEN_STATUS, frozen ? "FROZEN" : "NORMAL"
            ),
            String.valueOf(header.get("id"))
        );
        return result;
    }

    @Transactional
    public Map<String, Object> voidBill(BillLifecycleTarget target, String billNo, VoidRequest request) {
        BillLifecyclePolicy.requireVoidAllowed(target);
        guardTarget(target);
        var username = request == null ? "" : request.username() == null ? "" : request.username().trim();
        if (username.isBlank()) {
            username = currentSessionService.currentUsername();
        }
        if (!username.equals(currentSessionService.currentUsername()) && !"ADMIN".equals(currentSessionService.currentRoleCode())) {
            throw new ResponseStatusException(HttpStatus.FORBIDDEN, "只有管理员可以使用他人账号授权作废");
        }
        currentSessionService.verifyPassword(username, request == null ? null : request.password());
        var reason = requiredReason(request == null ? null : request.reason(), "作废原因");
        if (isSalesReturnTarget(target)) {
            lockSalesReturnHeader(billNo);
        }
        var beforeState = isSalesReturnTarget(target)
            ? salesReturnLifecycleLogState(billNo)
            : OperationLogCommand.state(OperationLogCommand.StateField.STATUS, BillStatus.DRAFT.name());
        var downstream = downstreamImpact(target, billNo);
        if (!downstream.isEmpty()) {
            var failureReason = "已有下游影响，禁止作废：" + downstream;
            logLifecycleFailure(target.module(), "VOID", target.targetType(), billNo, lifecycleState(target.headerTable(), billNo), failureReason);
            throw new ResponseStatusException(HttpStatus.CONFLICT, failureReason);
        }
        var rows = jdbcTemplate.queryForList("""
            UPDATE %s
            SET status = 'VOID',
                voided_at = now(),
                void_reason = ?,
                void_verified_username = ?,
                void_verified_at = now(),
                updated_at = now(),
                version = version + 1
            WHERE bill_no = ?
              AND status = 'DRAFT'
            RETURNING id::text AS id, bill_no AS "billNo", status, close_status AS "closeStatus", frozen_status AS "frozenStatus"
            """.formatted(target.headerTable()), reason, username, billNo);
        if (rows.isEmpty()) {
            var failureReason = "只有草稿且无下游影响的单据可以作废";
            logLifecycleFailure(target.module(), "VOID", target.targetType(), billNo, lifecycleState(target.headerTable(), billNo), failureReason);
            throw new ResponseStatusException(HttpStatus.CONFLICT, failureReason);
        }
        if (isSalesReturnTarget(target)) {
            logLifecycleSuccess(
                target.module(),
                "VOID",
                target.targetType(),
                billNo,
                beforeState,
                salesReturnLifecycleLogState(billNo),
                String.valueOf(rows.get(0).get("id"))
            );
        } else {
            logLifecycleSuccess(target.module(), "VOID", target.targetType(), billNo, beforeState, rows.get(0));
        }
        return rows.get(0);
    }

    public void guardExecutableSourceLine(SourceExecutionSpec spec, String sourceId, Object sourceLineNo) {
        var rows = jdbcTemplate.queryForList("""
            SELECT h.bill_no
            FROM %s h
            JOIN %s l ON l.%s = h.id
            WHERE h.id = ?::uuid
              AND l.%s = ?
              AND h.status = 'AUDITED'
              AND h.close_status = 'OPEN'
              AND h.frozen_status = 'NORMAL'
              AND l.line_close_status = 'OPEN'
              AND l.line_frozen_status = 'NORMAL'
            """.formatted(spec.headerTable(), spec.lineTable(), spec.lineOwnerColumn(), spec.lineNoColumn()), sourceId, sourceLineNo);
        if (rows.isEmpty()) {
            throw new ResponseStatusException(HttpStatus.CONFLICT, "源单或源单行已关闭/冻结，或源单未审核，不能继续下推或执行");
        }
    }

    public void guardSourceLineQuantities(
        SourceLineQuantityGuard guard,
        List<SourceLineQuantityDemand> demands,
        String currentBillNo
    ) {
        guardSourceLineQuantityGuard(guard);
        if (demands == null || demands.isEmpty()) {
            return;
        }
        var grouped = new HashMap<String, SourceLineQuantityDemand>();
        for (var demand : demands) {
            if (demand == null || demand.sourceBillNo() == null || demand.sourceBillNo().isBlank()
                || demand.sourceLineNo() == null || demand.qty() == null) {
                continue;
            }
            if (demand.qty().compareTo(BigDecimal.ZERO) <= 0) {
                throw new ResponseStatusException(HttpStatus.CONFLICT, "下推或执行数量必须大于 0");
            }
            var sourceBillNo = demand.sourceBillNo().trim();
            var key = sourceBillNo + "\u0000" + demand.sourceLineNo();
            var existing = grouped.get(key);
            grouped.put(
                key,
                existing == null
                    ? new SourceLineQuantityDemand(sourceBillNo, demand.sourceLineNo(), demand.qty())
                    : new SourceLineQuantityDemand(sourceBillNo, demand.sourceLineNo(), existing.qty().add(demand.qty()))
            );
        }
        for (var demand : grouped.values()) {
            var rows = jdbcTemplate.queryForList("""
                SELECT l.%s - COALESCE(used.used_qty, 0) AS remaining_qty
                FROM %s h
                JOIN %s l ON l.%s = h.id AND l.%s = ?
                LEFT JOIN (
                    SELECT dl.%s AS source_bill_no,
                           dl.%s AS source_line_no,
                           SUM(dl.%s) AS used_qty
                    FROM %s dl
                    JOIN %s dh ON dh.id = dl.%s
                    WHERE dh.status = 'AUDITED'
                      AND dh.bill_no <> ?
                    GROUP BY dl.%s, dl.%s
                ) used ON used.source_bill_no = h.bill_no AND used.source_line_no = l.%s
                WHERE h.bill_no = ?
                  AND h.status = 'AUDITED'
                  AND h.close_status = 'OPEN'
                  AND h.frozen_status = 'NORMAL'
                  AND l.line_close_status = 'OPEN'
                  AND l.line_frozen_status = 'NORMAL'
                """.formatted(
                    guard.sourceSpec().totalQtyColumn(),
                    guard.sourceSpec().headerTable(),
                    guard.sourceSpec().lineTable(),
                    guard.sourceSpec().lineOwnerColumn(),
                    guard.sourceSpec().lineNoColumn(),
                    guard.downstreamSourceBillNoColumn(),
                    guard.downstreamSourceLineNoColumn(),
                    guard.downstreamQtyColumn(),
                    guard.downstreamLineTable(),
                    guard.downstreamHeaderTable(),
                    guard.downstreamLineOwnerColumn(),
                    guard.downstreamSourceBillNoColumn(),
                    guard.downstreamSourceLineNoColumn(),
                    guard.sourceSpec().lineNoColumn()
                ),
                demand.sourceLineNo(),
                currentBillNo == null ? "" : currentBillNo,
                demand.sourceBillNo()
            );
            if (rows.isEmpty()) {
                throw new ResponseStatusException(HttpStatus.CONFLICT, guard.sourceNotExecutableMessage());
            }
            var remaining = (BigDecimal) rows.get(0).get("remaining_qty");
            if (remaining == null || remaining.compareTo(demand.qty()) < 0) {
                throw new ResponseStatusException(HttpStatus.CONFLICT, guard.quantityExceededMessage());
            }
        }
    }

    private void logLifecycleSuccess(
        String module,
        String action,
        String targetType,
        String billNo,
        Map<OperationLogCommand.StateField, Object> beforeState,
        Map<String, Object> afterRow
    ) {
        logLifecycleSuccess(
            module,
            action,
            targetType,
            billNo,
            beforeState,
            rowState(afterRow),
            afterRow.get("id") == null ? null : String.valueOf(afterRow.get("id"))
        );
    }

    private void logLifecycleSuccess(
        String module,
        String action,
        String targetType,
        String billNo,
        Map<OperationLogCommand.StateField, Object> beforeState,
        Map<OperationLogCommand.StateField, Object> afterState,
        String targetId
    ) {
        operationLogService.logCurrent(OperationLogCommand.success(
            module,
            action,
            targetType,
            uuidOrNull(targetId),
            billNo,
            OperationLogCommand.ActorMode.CURRENT_USER,
            null,
            beforeState,
            afterState,
            null
        ));
    }

    private void logLifecycleFailure(
        String module,
        String action,
        String targetType,
        String billNo,
        Map<String, Object> currentRow,
        String reason
    ) {
        if (currentRow == null || currentRow.isEmpty()) {
            return;
        }
        operationLogFailureService.logCurrentOnce(OperationLogCommand.failure(
            module,
            action,
            targetType,
            uuidOrNull(currentRow.get("id") == null ? null : String.valueOf(currentRow.get("id"))),
            billNo,
            OperationLogCommand.ActorMode.CURRENT_USER,
            null,
            rowState(currentRow),
            Map.of(),
            reason
        ));
    }

    private Map<String, Object> lifecycleState(String table, String billNo) {
        var closeModeExpression = "sales_order".equals(table) ? "close_mode" : "NULL::varchar";
        var rows = jdbcTemplate.queryForList("""
            SELECT id::text AS id,
                   bill_no AS "billNo",
                   status,
                   close_status AS "closeStatus",
                   %s AS "closeMode",
                   frozen_status AS "frozenStatus"
            FROM %s
            WHERE bill_no = ?
            """.formatted(closeModeExpression, table), billNo);
        return rows.isEmpty() ? Map.of() : rows.get(0);
    }

    private Map<OperationLogCommand.StateField, Object> rowState(Map<String, Object> row) {
        if (row == null || row.isEmpty()) {
            return Map.of();
        }
        var state = new EnumMap<OperationLogCommand.StateField, Object>(OperationLogCommand.StateField.class);
        putState(state, OperationLogCommand.StateField.STATUS, row.get("status"));
        putState(state, OperationLogCommand.StateField.AUDIT_STATUS, row.get("auditStatus"));
        putState(state, OperationLogCommand.StateField.CLOSE_STATUS, row.get("closeStatus"));
        putState(state, OperationLogCommand.StateField.CLOSE_MODE, row.get("closeMode"));
        putState(state, OperationLogCommand.StateField.FROZEN_STATUS, row.get("frozenStatus"));
        return java.util.Collections.unmodifiableMap(state);
    }

    private void putState(
        Map<OperationLogCommand.StateField, Object> state,
        OperationLogCommand.StateField field,
        Object value
    ) {
        if (value != null) {
            state.put(field, value);
        }
    }

    private UUID uuidOrNull(String value) {
        if (value == null || value.isBlank()) {
            return null;
        }
        try {
            return UUID.fromString(value);
        } catch (IllegalArgumentException ignored) {
            return null;
        }
    }

    private Map<String, Object> header(BillLifecycleTarget target, String billNo) {
        var rows = jdbcTemplate.queryForList("""
            SELECT id::text AS id, bill_no AS "billNo", status, close_status AS "closeStatus", frozen_status AS "frozenStatus"
            FROM %s
            WHERE bill_no = ?
              AND status <> 'VOID'
            """.formatted(target.headerTable()), billNo);
        if (rows.isEmpty()) {
            throw new ResponseStatusException(HttpStatus.NOT_FOUND, "单据不存在或已作废");
        }
        return new HashMap<>(rows.get(0));
    }

    private void syncHeaderCloseStatus(BillLifecycleTarget target, Map<String, Object> header, String reason) {
        var openLines = jdbcTemplate.queryForObject("""
            SELECT COUNT(*)
            FROM %s
            WHERE %s = ?::uuid
              AND line_close_status <> 'CLOSED'
            """.formatted(target.lineTable(), target.lineOwnerColumn()), Long.class, header.get("id"));
        if (openLines != null && openLines == 0) {
            if (isSalesOrderTarget(target)) {
                jdbcTemplate.update("""
                    UPDATE sales_order
                    SET close_status = 'CLOSED',
                        close_mode = NULL,
                        close_reason = ?,
                        closed_by = ?::uuid,
                        closed_at = now(),
                        updated_at = now(),
                        version = version + 1
                    WHERE id = ?::uuid
                    """, optionalReason(reason), currentSessionService.currentUserId(), header.get("id"));
            } else {
                jdbcTemplate.update("""
                    UPDATE %s
                    SET close_status = 'CLOSED',
                        close_reason = ?,
                        closed_by = ?::uuid,
                        closed_at = now(),
                        updated_at = now(),
                        version = version + 1
                    WHERE id = ?::uuid
                    """.formatted(target.headerTable()), optionalReason(reason), currentSessionService.currentUserId(), header.get("id"));
            }
        } else {
            if (isSalesOrderTarget(target)) {
                jdbcTemplate.update("""
                    UPDATE sales_order
                    SET close_status = 'OPEN',
                        close_mode = NULL,
                        updated_at = now(),
                        version = version + 1
                    WHERE id = ?::uuid
                      AND close_status = 'CLOSED'
                    """, header.get("id"));
            } else {
                jdbcTemplate.update("""
                    UPDATE %s
                    SET close_status = 'OPEN',
                        updated_at = now(),
                        version = version + 1
                    WHERE id = ?::uuid
                      AND close_status = 'CLOSED'
                    """.formatted(target.headerTable()), header.get("id"));
            }
        }
    }

    private void requireAuditedExecutableHeader(Map<String, Object> header, String actionLabel) {
        if (!"AUDITED".equals(String.valueOf(header.get("status")))) {
            throw new ResponseStatusException(HttpStatus.CONFLICT, "只有已审核单据可以" + actionLabel);
        }
        if (!"OPEN".equals(String.valueOf(header.get("closeStatus")))) {
            throw new ResponseStatusException(HttpStatus.CONFLICT, "单据已关闭，不能" + actionLabel);
        }
        if (!"NORMAL".equals(String.valueOf(header.get("frozenStatus")))) {
            throw new ResponseStatusException(HttpStatus.CONFLICT, "单据已冻结，不能" + actionLabel);
        }
    }

    private String downstreamImpact(BillLifecycleTarget target, String billNo) {
        var impacts = new java.util.ArrayList<String>();
        var idRows = jdbcTemplate.queryForList("SELECT id::text AS id, status FROM %s WHERE bill_no = ?".formatted(target.headerTable()), billNo);
        if (idRows.isEmpty()) {
            throw new ResponseStatusException(HttpStatus.NOT_FOUND, "单据不存在");
        }
        var id = String.valueOf(idRows.get(0).get("id"));
        if (hasInventoryTxn(billNo, id)) {
            impacts.add("已动库存");
        }
        if (hasFinancePosting(billNo)) {
            impacts.add("已生应收应付");
        }
        if (isSalesReturnTarget(target) && count("""
            SELECT COUNT(*)
            FROM sales_return_finance_allocation
            WHERE sales_return_id = ?::uuid
            """, id) > 0) {
            impacts.add("已生成退货财务分配");
        }
        if (RED_REVERSE_SOURCE_TABLES.contains(target.headerTable()) && count("""
            SELECT COUNT(*) FROM %s WHERE red_source_bill_id = ?::uuid AND status <> 'VOID'
            """.formatted(target.headerTable()), id) > 0) {
            impacts.add("已关联红字单");
        }
        if ("sales_quote".equals(target.headerTable()) && count("""
            SELECT COUNT(*) FROM sales_order_line l JOIN sales_order h ON h.id = l.order_id WHERE l.source_order_no = ? AND h.status <> 'VOID'
            """, billNo) > 0) {
            impacts.add("已下推");
        }
        if ("sales_order".equals(target.headerTable()) && count("""
            SELECT COUNT(*) FROM delivery_notice_line l JOIN delivery_notice h ON h.id = l.bill_id WHERE l.source_order_no = ? AND h.status <> 'VOID'
            """, billNo) > 0) {
            impacts.add("已下推");
        }
        if ("sales_order".equals(target.headerTable()) && count("""
            SELECT COUNT(*) FROM sales_out_line l JOIN sales_out h ON h.id = l.bill_id WHERE l.source_order_no = ? AND h.status <> 'VOID'
            """, billNo) > 0) {
            impacts.add("已下推");
        }
        if ("purchase_order".equals(target.headerTable()) && count("""
            SELECT COUNT(*) FROM purchase_in_line l JOIN purchase_in h ON h.id = l.bill_id WHERE l.source_order_no = ? AND h.status <> 'VOID'
            """, billNo) > 0) {
            impacts.add("已下推");
        }
        if ("delivery_notice".equals(target.headerTable()) && count("""
            SELECT COUNT(*) FROM sales_out_line l JOIN sales_out h ON h.id = l.bill_id WHERE l.source_delivery_notice_no = ? AND h.status <> 'VOID'
            """, billNo) > 0) {
            impacts.add("已下推");
        }
        if ("purchase_in".equals(target.headerTable()) && count("""
            SELECT COUNT(*) FROM purchase_return_line l JOIN purchase_return h ON h.id = l.bill_id WHERE l.source_in_no = ? AND h.status <> 'VOID'
            """, billNo) > 0) {
            impacts.add("已下推");
        }
        if ("production_task".equals(target.headerTable()) && count("""
            SELECT COUNT(*) FROM production_material_issue WHERE task_id = ?::uuid AND status <> 'VOID'
            """, id) > 0) {
            impacts.add("已下推");
        }
        if ("production_task".equals(target.headerTable()) && count("""
            SELECT COUNT(*) FROM production_completion WHERE task_id = ?::uuid AND status <> 'VOID'
            """, id) > 0) {
            impacts.add("已下推");
        }
        if ("production_completion".equals(target.headerTable()) && count("""
            SELECT COUNT(*)
            FROM outsourcing_work_order
            WHERE (source_completion_id = ?::uuid OR source_bill_no = ?)
              AND status <> 'VOID'
            """, id, billNo) > 0) {
            impacts.add("已下推");
        }
        if (count("SELECT COUNT(*) FROM stock_count_gain WHERE source_bill_id = ?::uuid AND status <> 'VOID'", id) > 0
            || count("SELECT COUNT(*) FROM stock_count_loss WHERE source_bill_id = ?::uuid AND status <> 'VOID'", id) > 0) {
            impacts.add("已被引用");
        }
        if (count("SELECT COUNT(*) FROM %s WHERE %s = ?::uuid AND (line_close_status = 'CLOSED' OR line_frozen_status = 'FROZEN')".formatted(target.lineTable(), target.lineOwnerColumn()), id) > 0) {
            impacts.add("已进执行流程");
        }
        return String.join("、", impacts);
    }

    private boolean hasInventoryTxn(String billNo, String id) {
        return count("SELECT COUNT(*) FROM inv_stock_txn WHERE source_bill_type LIKE ? OR source_bill_id = ?::uuid", "%" + billNo + "%", id) > 0;
    }

    private boolean hasFinancePosting(String billNo) {
        return count("SELECT COUNT(*) FROM ar_receivable WHERE source_bill_no = ?", billNo) > 0
            || count("SELECT COUNT(*) FROM ap_payable WHERE source_bill_no = ?", billNo) > 0;
    }

    private long count(String sql, Object... args) {
        var value = jdbcTemplate.queryForObject(sql, Long.class, args);
        return value == null ? 0 : value;
    }

    private boolean isSalesOrderTarget(BillLifecycleTarget target) {
        return "sales_order".equals(target.headerTable());
    }

    private boolean isSalesReturnTarget(BillLifecycleTarget target) {
        return "sales_return".equals(target.headerTable());
    }

    private void lockSalesReturnHeader(String billNo) {
        jdbcTemplate.queryForList("""
            SELECT id::text AS id
            FROM sales_return
            WHERE bill_no = ?
            FOR UPDATE
            """, billNo);
    }

    private Map<OperationLogCommand.StateField, Object> salesReturnLifecycleLogState(String billNo) {
        var rows = jdbcTemplate.queryForList("""
            SELECT header.status,
                   header.currency,
                   header.total_amount AS amount,
                   header.version,
                   COUNT(line.id)::int AS "sourceCount",
                   COALESCE(SUM(line.qty), 0) AS quantity,
                   COALESCE(finance.offset_amount, 0) AS "settledAmount",
                   COALESCE(finance.pending_refund_amount, 0) AS "outstandingAmount"
            FROM sales_return header
            LEFT JOIN sales_return_line line ON line.bill_id = header.id
            LEFT JOIN (
                SELECT sales_return_id,
                       SUM(offset_amount) AS offset_amount,
                       SUM(pending_refund_amount) AS pending_refund_amount
                FROM sales_return_finance_allocation
                GROUP BY sales_return_id
            ) finance ON finance.sales_return_id = header.id
            WHERE header.bill_no = ?
            GROUP BY header.id, finance.offset_amount, finance.pending_refund_amount
            """, billNo);
        if (rows.isEmpty()) {
            return Map.of();
        }
        var row = rows.getFirst();
        return OperationLogCommand.state(
            OperationLogCommand.StateField.STATUS, row.get("status"),
            OperationLogCommand.StateField.CURRENCY, row.get("currency"),
            OperationLogCommand.StateField.AMOUNT, row.get("amount"),
            OperationLogCommand.StateField.VERSION, row.get("version"),
            OperationLogCommand.StateField.SOURCE_COUNT, row.get("sourceCount"),
            OperationLogCommand.StateField.QUANTITY, row.get("quantity"),
            OperationLogCommand.StateField.SETTLED_AMOUNT, row.get("settledAmount"),
            OperationLogCommand.StateField.OUTSTANDING_AMOUNT, row.get("outstandingAmount")
        );
    }

    private String requiredReason(String reason, String label) {
        var value = reason == null ? "" : reason.trim();
        if (value.isBlank()) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, label + "不能为空");
        }
        return value;
    }

    private String optionalReason(String reason) {
        return reason == null || reason.isBlank() ? null : reason.trim();
    }

    private void guardTarget(BillLifecycleTarget target) {
        guardTable(target.headerTable());
        if (!BILL_TABLES.contains(target.headerTable()) || target.lineTable().isBlank() || target.lineOwnerColumn().isBlank()) {
            throw new IllegalArgumentException("Unsupported bill lifecycle target");
        }
    }

    private void guardTable(String table) {
        if (!BILL_TABLES.contains(table)) {
            throw new IllegalArgumentException("Unsupported bill table: " + table);
        }
    }

    private void guardSourceLineQuantityGuard(SourceLineQuantityGuard guard) {
        guardTable(guard.sourceSpec().headerTable());
        guardTable(guard.downstreamHeaderTable());
        for (var identifier : List.of(
            guard.sourceSpec().lineTable(),
            guard.sourceSpec().lineOwnerColumn(),
            guard.sourceSpec().lineNoColumn(),
            guard.sourceSpec().totalQtyColumn(),
            guard.downstreamLineTable(),
            guard.downstreamLineOwnerColumn(),
            guard.downstreamSourceBillNoColumn(),
            guard.downstreamSourceLineNoColumn(),
            guard.downstreamQtyColumn()
        )) {
            guardSqlIdentifier(identifier);
        }
    }

    private void guardSqlIdentifier(String identifier) {
        if (identifier == null || !identifier.matches("[A-Za-z_][A-Za-z0-9_]*")) {
            throw new IllegalArgumentException("Unsupported SQL identifier: " + identifier);
        }
    }

    public record BillLifecycleTarget(String headerTable, String lineTable, String lineOwnerColumn, String module, String targetType) {
    }

    public record VoidRequest(String reason, String username, String password) {
    }

    public record SourceLineQuantityGuard(
        SourceExecutionSpec sourceSpec,
        String downstreamHeaderTable,
        String downstreamLineTable,
        String downstreamLineOwnerColumn,
        String downstreamSourceBillNoColumn,
        String downstreamSourceLineNoColumn,
        String downstreamQtyColumn,
        String sourceNotExecutableMessage,
        String quantityExceededMessage
    ) {
        public SourceLineQuantityGuard(
            SourceExecutionSpec sourceSpec,
            String downstreamHeaderTable,
            String downstreamLineTable,
            String downstreamLineOwnerColumn,
            String downstreamSourceBillNoColumn,
            String downstreamSourceLineNoColumn,
            String downstreamQtyColumn
        ) {
            this(
                sourceSpec,
                downstreamHeaderTable,
                downstreamLineTable,
                downstreamLineOwnerColumn,
                downstreamSourceBillNoColumn,
                downstreamSourceLineNoColumn,
                downstreamQtyColumn,
                "源单或源单行已关闭/冻结，或源单未审核，不能继续下推或执行",
                sourceSpec.overQuantityMessage()
            );
        }
    }

    public record SourceLineQuantityDemand(String sourceBillNo, Object sourceLineNo, BigDecimal qty) {
    }
}
