package com.jdy.erp.finance.api;

import java.math.BigDecimal;
import java.time.LocalDate;
import java.util.Map;

import com.jdy.erp.system.security.RequirePermission;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.ResponseStatus;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.server.ResponseStatusException;

@RestController
@RequestMapping("/api/finance")
public class FinanceSettlementController {
    private final JdbcTemplate jdbcTemplate;

    public FinanceSettlementController(JdbcTemplate jdbcTemplate) {
        this.jdbcTemplate = jdbcTemplate;
    }

    @PostMapping("/receivables/from-sales-order/{billNo}")
    @RequirePermission("finance.settle")
    @ResponseStatus(HttpStatus.CREATED)
    @Transactional
    public Map<String, Object> createReceivable(@PathVariable String billNo) {
        var orderRows = jdbcTemplate.queryForList("""
            SELECT id::text AS id, bill_no, customer_id::text AS customer_id, bill_date, total_amount
            FROM sales_order
            WHERE bill_no = ? AND status = 'AUDITED'
            """, billNo);
        if (orderRows.isEmpty()) {
            throw new ResponseStatusException(HttpStatus.CONFLICT, "只有已审核销售订单可以生成应收");
        }
        var order = orderRows.get(0);
        var rows = jdbcTemplate.queryForList("""
            INSERT INTO ar_receivable (bill_no, source_bill_no, customer_id, bill_date, amount, status)
            VALUES (?, ?, ?::uuid, ?::date, ?, 'OPEN')
            ON CONFLICT (bill_no) DO UPDATE
            SET source_bill_no = EXCLUDED.source_bill_no,
                customer_id = EXCLUDED.customer_id,
                bill_date = EXCLUDED.bill_date,
                amount = EXCLUDED.amount,
                updated_at = now()
            RETURNING id::text AS id, bill_no AS "billNo", amount, received_amount AS "receivedAmount", status
            """,
            "YS-" + billNo,
            billNo,
            order.get("customer_id"),
            order.get("bill_date"),
            order.get("total_amount")
        );
        log("FINANCE", "CREATE_AR", "ar_receivable", String.valueOf(rows.get(0).get("id")), true, null);
        return rows.get(0);
    }

    @PostMapping("/receivables/{billNo}/receipt")
    @RequirePermission("finance.settle")
    @ResponseStatus(HttpStatus.CREATED)
    @Transactional
    public Map<String, Object> receive(@PathVariable String billNo, @RequestBody SettlementRequest request) {
        var receivableRows = jdbcTemplate.queryForList("""
            SELECT id::text AS id, amount, received_amount
            FROM ar_receivable
            WHERE bill_no = ?
            """, billNo);
        if (receivableRows.isEmpty()) {
            throw new ResponseStatusException(HttpStatus.NOT_FOUND, "应收单不存在");
        }
        var amount = positive(request.amount(), "收款金额");
        var receivable = receivableRows.get(0);
        jdbcTemplate.update("""
            INSERT INTO ar_receipt (bill_no, receivable_id, receipt_date, amount)
            VALUES (?, ?::uuid, ?, ?)
            """,
            required(request.billNo(), "收款单号"),
            receivable.get("id"),
            LocalDate.parse(required(request.date(), "收款日期")),
            amount
        );
        var rows = jdbcTemplate.queryForList("""
            UPDATE ar_receivable
            SET received_amount = received_amount + ?,
                status = CASE
                    WHEN received_amount + ? >= amount THEN 'SETTLED'
                    ELSE 'PART_SETTLED'
                END,
                updated_at = now()
            WHERE bill_no = ?
              AND received_amount + ? <= amount
            RETURNING id::text AS id, bill_no AS "billNo", amount, received_amount AS "receivedAmount", status
            """, amount, amount, billNo, amount);
        if (rows.isEmpty()) {
            throw new ResponseStatusException(HttpStatus.CONFLICT, "收款金额不能超过应收金额");
        }
        log("FINANCE", "RECEIVE", "ar_receivable", String.valueOf(receivable.get("id")), true, null);
        return rows.get(0);
    }

    @PostMapping("/payables/from-purchase-order/{billNo}")
    @RequirePermission("finance.settle")
    @ResponseStatus(HttpStatus.CREATED)
    @Transactional
    public Map<String, Object> createPayable(@PathVariable String billNo) {
        var orderRows = jdbcTemplate.queryForList("""
            SELECT id::text AS id, bill_no, supplier_id::text AS supplier_id, bill_date, total_amount
            FROM purchase_order
            WHERE bill_no = ? AND status = 'AUDITED'
            """, billNo);
        if (orderRows.isEmpty()) {
            throw new ResponseStatusException(HttpStatus.CONFLICT, "只有已审核采购订单可以生成应付");
        }
        var order = orderRows.get(0);
        var rows = jdbcTemplate.queryForList("""
            INSERT INTO ap_payable (bill_no, source_bill_no, supplier_id, bill_date, amount, status)
            VALUES (?, ?, ?::uuid, ?::date, ?, 'OPEN')
            ON CONFLICT (bill_no) DO UPDATE
            SET source_bill_no = EXCLUDED.source_bill_no,
                supplier_id = EXCLUDED.supplier_id,
                bill_date = EXCLUDED.bill_date,
                amount = EXCLUDED.amount,
                updated_at = now()
            RETURNING id::text AS id, bill_no AS "billNo", amount, paid_amount AS "paidAmount", status
            """,
            "YF-" + billNo,
            billNo,
            order.get("supplier_id"),
            order.get("bill_date"),
            order.get("total_amount")
        );
        log("FINANCE", "CREATE_AP", "ap_payable", String.valueOf(rows.get(0).get("id")), true, null);
        return rows.get(0);
    }

    @PostMapping("/payables/{billNo}/payment")
    @RequirePermission("finance.settle")
    @ResponseStatus(HttpStatus.CREATED)
    @Transactional
    public Map<String, Object> pay(@PathVariable String billNo, @RequestBody SettlementRequest request) {
        var payableRows = jdbcTemplate.queryForList("""
            SELECT id::text AS id, amount, paid_amount
            FROM ap_payable
            WHERE bill_no = ?
            """, billNo);
        if (payableRows.isEmpty()) {
            throw new ResponseStatusException(HttpStatus.NOT_FOUND, "应付单不存在");
        }
        var amount = positive(request.amount(), "付款金额");
        var payable = payableRows.get(0);
        jdbcTemplate.update("""
            INSERT INTO ap_payment (bill_no, payable_id, payment_date, amount)
            VALUES (?, ?::uuid, ?, ?)
            """,
            required(request.billNo(), "付款单号"),
            payable.get("id"),
            LocalDate.parse(required(request.date(), "付款日期")),
            amount
        );
        var rows = jdbcTemplate.queryForList("""
            UPDATE ap_payable
            SET paid_amount = paid_amount + ?,
                status = CASE
                    WHEN paid_amount + ? >= amount THEN 'SETTLED'
                    ELSE 'PART_SETTLED'
                END,
                updated_at = now()
            WHERE bill_no = ?
              AND paid_amount + ? <= amount
            RETURNING id::text AS id, bill_no AS "billNo", amount, paid_amount AS "paidAmount", status
            """, amount, amount, billNo, amount);
        if (rows.isEmpty()) {
            throw new ResponseStatusException(HttpStatus.CONFLICT, "付款金额不能超过应付金额");
        }
        log("FINANCE", "PAY", "ap_payable", String.valueOf(payable.get("id")), true, null);
        return rows.get(0);
    }

    private BigDecimal positive(BigDecimal value, String label) {
        if (value == null || value.compareTo(BigDecimal.ZERO) <= 0) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, label + "必须大于 0");
        }
        return value;
    }

    private String required(String value, String label) {
        if (value == null || value.isBlank()) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, label + "不能为空");
        }
        return value.trim();
    }

    private void log(String module, String action, String targetType, String targetId, boolean success, String reason) {
        jdbcTemplate.update("""
            INSERT INTO sys_operation_log (module_code, action_code, target_type, target_id, success, failure_reason)
            VALUES (?, ?, ?, ?::uuid, ?, ?)
            """, module, action, targetType, targetId, success, reason);
    }

    public record SettlementRequest(String billNo, String date, BigDecimal amount) {
    }
}
