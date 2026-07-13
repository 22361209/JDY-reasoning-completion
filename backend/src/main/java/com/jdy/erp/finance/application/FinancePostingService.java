package com.jdy.erp.finance.application;

import java.math.BigDecimal;
import java.util.Map;
import java.util.UUID;

import com.jdy.erp.shared.application.FinancePosting;
import com.jdy.erp.shared.application.OperationLogCommand;
import com.jdy.erp.shared.application.OperationLogService;
import com.jdy.erp.shared.application.PostingContext;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Component;
import org.springframework.web.server.ResponseStatusException;

@Component
public class FinancePostingService implements FinancePosting {
    private final JdbcTemplate jdbcTemplate;
    private final OperationLogService operationLogService;

    public FinancePostingService(JdbcTemplate jdbcTemplate, OperationLogService operationLogService) {
        this.jdbcTemplate = jdbcTemplate;
        this.operationLogService = operationLogService;
    }

    @Override
    public boolean supports(String channel) {
        return FinancePosting.CHANNEL.equals(channel);
    }

    @Override
    public void post(PostingContext context) {
        validate(context);
        switch (context.txnType()) {
            case "SALES_OUT" -> postReceivable(context, "YS-" + context.sourceBillNo(), context.amount());
	            case "SALES_OUT_REVERSE" -> postReceivable(context, "YS-CX-" + context.sourceBillNo(), context.amount().negate());
	            case "SALES_OUT_RED" -> postReceivable(context, "YS-HC-" + shortHash(context.sourceBillNo()), context.amount());
	            case "SALES_OUT_RED_REVERSE" -> postReceivable(context, "YS-HC-CX-" + shortHash(context.sourceBillNo()), context.amount().negate());
	            case "PURCHASE_IN" -> postPayable(context, "YF-" + context.sourceBillNo(), context.amount());
	            case "PURCHASE_IN_REVERSE" -> postPayable(context, "YF-CX-" + context.sourceBillNo(), context.amount().negate());
	            case "PURCHASE_IN_RED" -> postPayable(context, "YF-HC-" + shortHash(context.sourceBillNo()), context.amount());
	            case "PURCHASE_IN_RED_REVERSE" -> postPayable(context, "YF-HC-CX-" + shortHash(context.sourceBillNo()), context.amount().negate());
            case "PURCHASE_RETURN" -> postPayable(context, "YF-TH-" + context.sourceBillNo(), context.amount());
            case "PURCHASE_RETURN_REVERSE" -> postPayable(context, "YF-TH-CX-" + context.sourceBillNo(), context.amount());
            default -> throw new ResponseStatusException(HttpStatus.INTERNAL_SERVER_ERROR, "不支持的财务过账类型");
        }
    }

    private void postReceivable(PostingContext context, String billNo, BigDecimal amount) {
        var rows = jdbcTemplate.queryForList("""
            INSERT INTO ar_receivable (bill_no, source_bill_no, customer_id, bill_date, amount, currency, status)
            VALUES (?, ?, ?::uuid, ?, ?, ?, 'OPEN')
            ON CONFLICT (bill_no) DO UPDATE
            SET source_bill_no = EXCLUDED.source_bill_no,
                customer_id = EXCLUDED.customer_id,
                bill_date = EXCLUDED.bill_date,
                amount = EXCLUDED.amount,
                currency = EXCLUDED.currency,
                status = CASE
                    WHEN ar_receivable.received_amount + ar_receivable.return_offset_amount = 0 THEN 'OPEN'
                    WHEN ar_receivable.received_amount + ar_receivable.return_offset_amount = EXCLUDED.amount THEN 'SETTLED'
                    ELSE 'PART_SETTLED'
                END,
                updated_at = now()
            WHERE (
                    ar_receivable.received_amount = 0
                AND ar_receivable.return_offset_amount = 0
               )
               OR (
                    ar_receivable.received_amount + ar_receivable.return_offset_amount > 0
                AND ar_receivable.received_amount + ar_receivable.return_offset_amount <= EXCLUDED.amount
                AND ar_receivable.amount = EXCLUDED.amount
                AND ar_receivable.customer_id = EXCLUDED.customer_id
                AND ar_receivable.currency = EXCLUDED.currency
               )
            RETURNING id::text AS id, bill_no AS "billNo", amount, currency, status
            """,
            billNo,
            context.sourceBillNo(),
            context.partyId(),
            context.billDate(),
            amount,
            context.currency()
        );
        if (rows.isEmpty()) {
            throw new ResponseStatusException(
                HttpStatus.CONFLICT,
                "应收单已发生核销，来源重过账不能改写金额、客户或币种"
            );
        }
        var row = rows.getFirst();
        operationLogService.logCurrent(OperationLogCommand.success(
            "FINANCE",
            "CREATE_AR",
            "ar_receivable",
            UUID.fromString(String.valueOf(row.get("id"))),
            String.valueOf(row.get("billNo")),
            Map.of(),
            OperationLogCommand.state(
                OperationLogCommand.StateField.STATUS, row.get("status"),
                OperationLogCommand.StateField.AMOUNT, row.get("amount"),
                OperationLogCommand.StateField.CURRENCY, row.get("currency")
            )
        ));
    }

    private void postPayable(PostingContext context, String billNo, BigDecimal amount) {
        var rows = jdbcTemplate.queryForList("""
            INSERT INTO ap_payable (bill_no, source_bill_no, supplier_id, bill_date, amount, currency, status)
            VALUES (?, ?, ?::uuid, ?, ?, ?, 'OPEN')
            ON CONFLICT (bill_no) DO UPDATE
            SET source_bill_no = EXCLUDED.source_bill_no,
                supplier_id = EXCLUDED.supplier_id,
                bill_date = EXCLUDED.bill_date,
                amount = EXCLUDED.amount,
                currency = EXCLUDED.currency,
                status = CASE
                    WHEN ap_payable.paid_amount = 0 THEN 'OPEN'
                    WHEN ap_payable.paid_amount = EXCLUDED.amount THEN 'SETTLED'
                    ELSE 'PART_SETTLED'
                END,
                updated_at = now()
            WHERE ap_payable.paid_amount = 0
               OR (
                    ap_payable.paid_amount > 0
                AND ap_payable.paid_amount <= EXCLUDED.amount
                AND ap_payable.amount = EXCLUDED.amount
                AND ap_payable.supplier_id = EXCLUDED.supplier_id
                AND ap_payable.currency = EXCLUDED.currency
               )
            RETURNING id::text AS id, bill_no AS "billNo", amount, currency, status
            """,
            billNo,
            context.sourceBillNo(),
            context.partyId(),
            context.billDate(),
            amount,
            context.currency()
        );
        if (rows.isEmpty()) {
            throw new ResponseStatusException(
                HttpStatus.CONFLICT,
                "应付单已发生核销，来源重过账不能改写金额、供应商或币种"
            );
        }
        var row = rows.getFirst();
        operationLogService.logCurrent(OperationLogCommand.success(
            "FINANCE",
            "CREATE_AP",
            "ap_payable",
            UUID.fromString(String.valueOf(row.get("id"))),
            String.valueOf(row.get("billNo")),
            Map.of(),
            OperationLogCommand.state(
                OperationLogCommand.StateField.STATUS, row.get("status"),
                OperationLogCommand.StateField.AMOUNT, row.get("amount"),
                OperationLogCommand.StateField.CURRENCY, row.get("currency")
            )
        ));
    }

    private void validate(PostingContext context) {
        if (context.sourceBillNo() == null || context.sourceBillNo().isBlank()) {
            throw new ResponseStatusException(HttpStatus.INTERNAL_SERVER_ERROR, "财务过账缺少来源单号");
        }
        if (context.partyId() == null || context.partyId().isBlank()) {
            throw new ResponseStatusException(HttpStatus.INTERNAL_SERVER_ERROR, "财务过账缺少往来方");
        }
        if (context.billDate() == null) {
            throw new ResponseStatusException(HttpStatus.INTERNAL_SERVER_ERROR, "财务过账缺少业务日期");
        }
        if (context.amount() == null || context.amount().compareTo(BigDecimal.ZERO) == 0) {
            throw new ResponseStatusException(HttpStatus.INTERNAL_SERVER_ERROR, "财务过账金额不能为 0");
        }
        if (!"CNY".equals(context.currency()) && !"USD".equals(context.currency())) {
            throw new ResponseStatusException(HttpStatus.INTERNAL_SERVER_ERROR, "财务过账币种只支持 CNY 或 USD");
        }
    }

    private String shortHash(String value) {
        return Integer.toUnsignedString(value.hashCode(), 36).toUpperCase();
    }
}
