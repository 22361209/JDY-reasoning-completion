package com.jdy.erp.shared.application;

import java.util.Map;
import java.util.Set;

import com.jdy.erp.shared.domain.BillStatus;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;
import org.springframework.web.server.ResponseStatusException;

@Service
public class BillLifecycleService {
    private static final Set<String> BILL_TABLES = Set.of(
        "sales_order",
        "sales_out",
        "purchase_order",
        "purchase_in",
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

    public BillLifecycleService(JdbcTemplate jdbcTemplate, OperationLogService operationLogService) {
        this.jdbcTemplate = jdbcTemplate;
        this.operationLogService = operationLogService;
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

    private void guardTable(String table) {
        if (!BILL_TABLES.contains(table)) {
            throw new IllegalArgumentException("Unsupported bill table: " + table);
        }
    }
}
