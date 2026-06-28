package com.jdy.erp.shared.application;

import java.util.HashMap;
import java.util.Map;
import java.util.Set;

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
        "purchase_order",
        "purchase_in",
        "purchase_return",
        "production_material_issue",
        "production_completion",
        "other_stock_in",
        "other_stock_out",
        "stock_transfer",
        "stock_count",
        "stock_count_gain",
        "stock_count_loss"
    );

    private final JdbcTemplate jdbcTemplate;
    private final OperationLogService operationLogService;
    private final CurrentSessionService currentSessionService;

    public BillLifecycleService(
        JdbcTemplate jdbcTemplate,
        OperationLogService operationLogService,
        CurrentSessionService currentSessionService
    ) {
        this.jdbcTemplate = jdbcTemplate;
        this.operationLogService = operationLogService;
        this.currentSessionService = currentSessionService;
    }

    public Map<String, Object> transition(String table, String billNo, BillStatus from, BillStatus to) {
        return transition(table, billNo, from, to, null, table, to.name(), table, null);
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
            throw new ResponseStatusException(HttpStatus.NOT_FOUND, notFoundMessage);
        }
        operationLogService.log(module, action, targetType, String.valueOf(rows.get(0).get("id")), true, null);
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
            throw new ResponseStatusException(HttpStatus.CONFLICT, conflictMessage == null ? "单据状态已变化，请刷新后重试" : conflictMessage);
        }
        operationLogService.log(module, action, targetType, String.valueOf(rows.get(0).get("id")), true, null);
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
            throw new ResponseStatusException(HttpStatus.CONFLICT, conflictMessage == null ? "只有草稿单据可以删除" : conflictMessage);
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
        operationLogService.log(target.module(), "DELETE", target.targetType(), String.valueOf(row.get("id")), true, null);
        return row;
    }

    @Transactional
    public Map<String, Object> closeBill(BillLifecycleTarget target, String billNo, String reason) {
        guardTarget(target);
        var rows = jdbcTemplate.queryForList("""
            UPDATE %s
            SET close_status = 'CLOSED',
                close_reason = ?,
                closed_by = ?::uuid,
                closed_at = now(),
                updated_at = now(),
                version = version + 1
            WHERE bill_no = ?
              AND status <> 'VOID'
              AND close_status <> 'CLOSED'
            RETURNING id::text AS id, bill_no AS "billNo", status, close_status AS "closeStatus", frozen_status AS "frozenStatus"
            """.formatted(target.headerTable()), requiredReason(reason, "关闭原因"), currentSessionService.currentUserId(), billNo);
        if (rows.isEmpty()) {
            throw new ResponseStatusException(HttpStatus.CONFLICT, "单据不存在、已作废或已关闭");
        }
        jdbcTemplate.update("""
            UPDATE %s
            SET line_close_status = 'CLOSED',
                line_close_reason = COALESCE(line_close_reason, ?)
            WHERE %s = ?::uuid
              AND line_close_status <> 'CLOSED'
            """.formatted(target.lineTable(), target.lineOwnerColumn()), requiredReason(reason, "关闭原因"), rows.get(0).get("id"));
        operationLogService.log(target.module(), "CLOSE", target.targetType(), String.valueOf(rows.get(0).get("id")), true, null);
        return rows.get(0);
    }

    @Transactional
    public Map<String, Object> reopenBill(BillLifecycleTarget target, String billNo, String reason) {
        guardTarget(target);
        var rows = jdbcTemplate.queryForList("""
            UPDATE %s
            SET close_status = 'OPEN',
                close_reason = ?,
                closed_by = NULL,
                closed_at = NULL,
                updated_at = now(),
                version = version + 1
            WHERE bill_no = ?
              AND status <> 'VOID'
              AND close_status = 'CLOSED'
            RETURNING id::text AS id, bill_no AS "billNo", status, close_status AS "closeStatus", frozen_status AS "frozenStatus"
            """.formatted(target.headerTable()), optionalReason(reason), billNo);
        if (rows.isEmpty()) {
            throw new ResponseStatusException(HttpStatus.CONFLICT, "单据不存在、已作废或未关闭");
        }
        jdbcTemplate.update("""
            UPDATE %s
            SET line_close_status = 'OPEN',
                line_close_reason = ?
            WHERE %s = ?::uuid
            """.formatted(target.lineTable(), target.lineOwnerColumn()), optionalReason(reason), rows.get(0).get("id"));
        operationLogService.log(target.module(), "UNCLOSE", target.targetType(), String.valueOf(rows.get(0).get("id")), true, null);
        return rows.get(0);
    }

    @Transactional
    public Map<String, Object> freezeBill(BillLifecycleTarget target, String billNo, String reason) {
        guardTarget(target);
        var rows = jdbcTemplate.queryForList("""
            UPDATE %s
            SET frozen_status = 'FROZEN',
                frozen_reason = ?,
                frozen_by = ?::uuid,
                frozen_at = now(),
                updated_at = now(),
                version = version + 1
            WHERE bill_no = ?
              AND status <> 'VOID'
              AND frozen_status <> 'FROZEN'
            RETURNING id::text AS id, bill_no AS "billNo", status, close_status AS "closeStatus", frozen_status AS "frozenStatus"
            """.formatted(target.headerTable()), requiredReason(reason, "冻结原因"), currentSessionService.currentUserId(), billNo);
        if (rows.isEmpty()) {
            throw new ResponseStatusException(HttpStatus.CONFLICT, "单据不存在、已作废或已冻结");
        }
        jdbcTemplate.update("""
            UPDATE %s
            SET line_frozen_status = 'FROZEN',
                line_frozen_reason = COALESCE(line_frozen_reason, ?)
            WHERE %s = ?::uuid
              AND line_frozen_status <> 'FROZEN'
            """.formatted(target.lineTable(), target.lineOwnerColumn()), requiredReason(reason, "冻结原因"), rows.get(0).get("id"));
        operationLogService.log(target.module(), "FREEZE", target.targetType(), String.valueOf(rows.get(0).get("id")), true, null);
        return rows.get(0);
    }

    @Transactional
    public Map<String, Object> unfreezeBill(BillLifecycleTarget target, String billNo, String reason) {
        guardTarget(target);
        var rows = jdbcTemplate.queryForList("""
            UPDATE %s
            SET frozen_status = 'NORMAL',
                frozen_reason = ?,
                frozen_by = NULL,
                frozen_at = NULL,
                updated_at = now(),
                version = version + 1
            WHERE bill_no = ?
              AND status <> 'VOID'
              AND frozen_status = 'FROZEN'
            RETURNING id::text AS id, bill_no AS "billNo", status, close_status AS "closeStatus", frozen_status AS "frozenStatus"
            """.formatted(target.headerTable()), optionalReason(reason), billNo);
        if (rows.isEmpty()) {
            throw new ResponseStatusException(HttpStatus.CONFLICT, "单据不存在、已作废或未冻结");
        }
        jdbcTemplate.update("""
            UPDATE %s
            SET line_frozen_status = 'NORMAL',
                line_frozen_reason = ?
            WHERE %s = ?::uuid
            """.formatted(target.lineTable(), target.lineOwnerColumn()), optionalReason(reason), rows.get(0).get("id"));
        operationLogService.log(target.module(), "UNFREEZE", target.targetType(), String.valueOf(rows.get(0).get("id")), true, null);
        return rows.get(0);
    }

    @Transactional
    public Map<String, Object> setLineClosed(BillLifecycleTarget target, String billNo, int lineNo, boolean closed, String reason) {
        guardTarget(target);
        var header = header(target, billNo);
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
        operationLogService.log(target.module(), closed ? "LINE_CLOSE" : "LINE_UNCLOSE", target.targetType(), String.valueOf(header.get("id")), true, null);
        return header(target, billNo);
    }

    @Transactional
    public Map<String, Object> setLineFrozen(BillLifecycleTarget target, String billNo, int lineNo, boolean frozen, String reason) {
        guardTarget(target);
        var header = header(target, billNo);
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
        operationLogService.log(target.module(), frozen ? "LINE_FREEZE" : "LINE_UNFREEZE", target.targetType(), String.valueOf(header.get("id")), true, null);
        return header(target, billNo);
    }

    @Transactional
    public Map<String, Object> voidBill(BillLifecycleTarget target, String billNo, VoidRequest request) {
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
        var downstream = downstreamImpact(target, billNo);
        if (!downstream.isEmpty()) {
            throw new ResponseStatusException(HttpStatus.CONFLICT, "已有下游影响，禁止作废：" + downstream);
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
            throw new ResponseStatusException(HttpStatus.CONFLICT, "只有草稿且无下游影响的单据可以作废");
        }
        operationLogService.log(target.module(), "VOID", target.targetType(), String.valueOf(rows.get(0).get("id")), true, null);
        return rows.get(0);
    }

    public void guardExecutableSourceLine(SourceExecutionSpec spec, String sourceId, Object sourceLineNo) {
        var rows = jdbcTemplate.queryForList("""
            SELECT h.bill_no
            FROM %s h
            JOIN %s l ON l.%s = h.id
            WHERE h.id = ?::uuid
              AND l.%s = ?
              AND h.close_status = 'OPEN'
              AND h.frozen_status = 'NORMAL'
              AND l.line_close_status = 'OPEN'
              AND l.line_frozen_status = 'NORMAL'
            """.formatted(spec.headerTable(), spec.lineTable(), spec.lineOwnerColumn(), spec.lineNoColumn()), sourceId, sourceLineNo);
        if (rows.isEmpty()) {
            throw new ResponseStatusException(HttpStatus.CONFLICT, "源单或源单行已关闭/冻结，不能继续下推或执行");
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

    public record BillLifecycleTarget(String headerTable, String lineTable, String lineOwnerColumn, String module, String targetType) {
    }

    public record VoidRequest(String reason, String username, String password) {
    }
}
