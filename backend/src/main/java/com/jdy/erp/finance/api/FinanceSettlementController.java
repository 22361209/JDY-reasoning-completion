package com.jdy.erp.finance.api;

import java.math.BigDecimal;
import java.time.LocalDate;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.UUID;

import com.jdy.erp.shared.application.NumberingService;
import com.jdy.erp.shared.application.OperationLogCommand;
import com.jdy.erp.shared.application.OperationLogFailureService;
import com.jdy.erp.shared.application.OperationLogService;
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
    private final NumberingService numberingService;
    private final OperationLogService operationLogService;
    private final OperationLogFailureService operationLogFailureService;

    public FinanceSettlementController(
        JdbcTemplate jdbcTemplate,
        NumberingService numberingService,
        OperationLogService operationLogService,
        OperationLogFailureService operationLogFailureService
    ) {
        this.jdbcTemplate = jdbcTemplate;
        this.numberingService = numberingService;
        this.operationLogService = operationLogService;
        this.operationLogFailureService = operationLogFailureService;
    }

    @PostMapping("/receivables/{billNo}/receipt")
    @RequirePermission("finance.settle")
    @ResponseStatus(HttpStatus.CREATED)
    @Transactional
    public Map<String, Object> receive(@PathVariable String billNo, @RequestBody SettlementRequest request) {
        var receivableRows = jdbcTemplate.queryForList("""
            SELECT id::text AS id, amount, received_amount, status
            FROM ar_receivable
            WHERE bill_no = ?
            """, billNo);
        if (receivableRows.isEmpty()) {
            throw new ResponseStatusException(HttpStatus.NOT_FOUND, "应收单不存在");
        }
        var receivable = receivableRows.get(0);
        BigDecimal amount;
        try {
            rejectManualBillNo(request.billNo());
            amount = positive(request.amount(), "收款金额");
        } catch (ResponseStatusException exception) {
            logSettlementFailure("RECEIVE", "ar_receivable", billNo, receivable, "received_amount", exception.getReason());
            throw exception;
        }
        var receiptBillNo = numberingService.nextBillNo("arReceipt");
        jdbcTemplate.update("""
            INSERT INTO ar_receipt (bill_no, receivable_id, receipt_date, amount)
            VALUES (?, ?::uuid, ?, ?)
            """,
            receiptBillNo,
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
            var reason = "收款金额不能超过应收金额";
            logSettlementFailure("RECEIVE", "ar_receivable", billNo, receivable, "received_amount", reason);
            throw new ResponseStatusException(HttpStatus.CONFLICT, reason);
        }
        operationLogService.logCurrent(OperationLogCommand.success(
            "FINANCE",
            "RECEIVE",
            "ar_receivable",
            UUID.fromString(String.valueOf(receivable.get("id"))),
            billNo,
            OperationLogCommand.ActorMode.CURRENT_USER,
            null,
            OperationLogCommand.state(
                OperationLogCommand.StateField.STATUS, receivable.get("status"),
                OperationLogCommand.StateField.SETTLED_AMOUNT, receivable.get("received_amount"),
                OperationLogCommand.StateField.AMOUNT, receivable.get("amount")
            ),
            OperationLogCommand.state(
                OperationLogCommand.StateField.STATUS, rows.getFirst().get("status"),
                OperationLogCommand.StateField.SETTLED_AMOUNT, rows.getFirst().get("receivedAmount"),
                OperationLogCommand.StateField.AMOUNT, rows.getFirst().get("amount")
            ),
            null
        ));
        var result = new LinkedHashMap<String, Object>(rows.get(0));
        result.put("receiptBillNo", receiptBillNo);
        return result;
    }

    @PostMapping("/payables/{billNo}/payment")
    @RequirePermission("finance.settle")
    @ResponseStatus(HttpStatus.CREATED)
    @Transactional
    public Map<String, Object> pay(@PathVariable String billNo, @RequestBody SettlementRequest request) {
        var payableRows = jdbcTemplate.queryForList("""
            SELECT id::text AS id, amount, paid_amount, status
            FROM ap_payable
            WHERE bill_no = ?
            """, billNo);
        if (payableRows.isEmpty()) {
            throw new ResponseStatusException(HttpStatus.NOT_FOUND, "应付单不存在");
        }
        var payable = payableRows.get(0);
        BigDecimal amount;
        try {
            rejectManualBillNo(request.billNo());
            amount = positive(request.amount(), "付款金额");
        } catch (ResponseStatusException exception) {
            logSettlementFailure("PAY", "ap_payable", billNo, payable, "paid_amount", exception.getReason());
            throw exception;
        }
        var paymentBillNo = numberingService.nextBillNo("apPayment");
        jdbcTemplate.update("""
            INSERT INTO ap_payment (bill_no, payable_id, payment_date, amount)
            VALUES (?, ?::uuid, ?, ?)
            """,
            paymentBillNo,
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
            var reason = "付款金额不能超过应付金额";
            logSettlementFailure("PAY", "ap_payable", billNo, payable, "paid_amount", reason);
            throw new ResponseStatusException(HttpStatus.CONFLICT, reason);
        }
        operationLogService.logCurrent(OperationLogCommand.success(
            "FINANCE",
            "PAY",
            "ap_payable",
            UUID.fromString(String.valueOf(payable.get("id"))),
            billNo,
            OperationLogCommand.ActorMode.CURRENT_USER,
            null,
            OperationLogCommand.state(
                OperationLogCommand.StateField.STATUS, payable.get("status"),
                OperationLogCommand.StateField.SETTLED_AMOUNT, payable.get("paid_amount"),
                OperationLogCommand.StateField.AMOUNT, payable.get("amount")
            ),
            OperationLogCommand.state(
                OperationLogCommand.StateField.STATUS, rows.getFirst().get("status"),
                OperationLogCommand.StateField.SETTLED_AMOUNT, rows.getFirst().get("paidAmount"),
                OperationLogCommand.StateField.AMOUNT, rows.getFirst().get("amount")
            ),
            null
        ));
        var result = new LinkedHashMap<String, Object>(rows.get(0));
        result.put("paymentBillNo", paymentBillNo);
        return result;
    }

    private void rejectManualBillNo(String billNo) {
        if (billNo != null && !billNo.isBlank()) {
            throw new ResponseStatusException(HttpStatus.CONFLICT, "单据编号只能由系统自动生成，不能手工指定");
        }
    }

    private void logSettlementFailure(
        String action,
        String targetType,
        String billNo,
        Map<String, Object> settlement,
        String settledAmountColumn,
        String reason
    ) {
        operationLogFailureService.logCurrentOnce(OperationLogCommand.failure(
            "FINANCE",
            action,
            targetType,
            UUID.fromString(String.valueOf(settlement.get("id"))),
            billNo,
            OperationLogCommand.ActorMode.CURRENT_USER,
            null,
            OperationLogCommand.state(
                OperationLogCommand.StateField.STATUS, settlement.get("status"),
                OperationLogCommand.StateField.SETTLED_AMOUNT, settlement.get(settledAmountColumn),
                OperationLogCommand.StateField.AMOUNT, settlement.get("amount")
            ),
            Map.of(),
            reason == null || reason.isBlank() ? "结算操作失败" : reason
        ));
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

    public record SettlementRequest(String billNo, String date, BigDecimal amount) {
    }
}
