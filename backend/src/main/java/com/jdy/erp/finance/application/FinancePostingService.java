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
        var row = jdbcTemplate.queryForMap("""
            INSERT INTO ar_receivable (bill_no, source_bill_no, customer_id, bill_date, amount, status)
            VALUES (?, ?, ?::uuid, ?, ?, 'OPEN')
            ON CONFLICT (bill_no) DO UPDATE
            SET source_bill_no = EXCLUDED.source_bill_no,
                customer_id = EXCLUDED.customer_id,
                bill_date = EXCLUDED.bill_date,
                amount = EXCLUDED.amount,
                status = EXCLUDED.status,
                updated_at = now()
            RETURNING id::text AS id, bill_no AS "billNo", amount, status
            """,
            billNo,
            context.sourceBillNo(),
            context.partyId(),
            context.billDate(),
            amount
        );
        operationLogService.logCurrent(OperationLogCommand.success(
            "FINANCE",
            "CREATE_AR",
            "ar_receivable",
            UUID.fromString(String.valueOf(row.get("id"))),
            String.valueOf(row.get("billNo")),
            Map.of(),
            OperationLogCommand.state(
                OperationLogCommand.StateField.STATUS, row.get("status"),
                OperationLogCommand.StateField.AMOUNT, row.get("amount")
            )
        ));
    }

    private void postPayable(PostingContext context, String billNo, BigDecimal amount) {
        var row = jdbcTemplate.queryForMap("""
            INSERT INTO ap_payable (bill_no, source_bill_no, supplier_id, bill_date, amount, status)
            VALUES (?, ?, ?::uuid, ?, ?, 'OPEN')
            ON CONFLICT (bill_no) DO UPDATE
            SET source_bill_no = EXCLUDED.source_bill_no,
                supplier_id = EXCLUDED.supplier_id,
                bill_date = EXCLUDED.bill_date,
                amount = EXCLUDED.amount,
                status = EXCLUDED.status,
                updated_at = now()
            RETURNING id::text AS id, bill_no AS "billNo", amount, status
            """,
            billNo,
            context.sourceBillNo(),
            context.partyId(),
            context.billDate(),
            amount
        );
        operationLogService.logCurrent(OperationLogCommand.success(
            "FINANCE",
            "CREATE_AP",
            "ap_payable",
            UUID.fromString(String.valueOf(row.get("id"))),
            String.valueOf(row.get("billNo")),
            Map.of(),
            OperationLogCommand.state(
                OperationLogCommand.StateField.STATUS, row.get("status"),
                OperationLogCommand.StateField.AMOUNT, row.get("amount")
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
    }

    private String shortHash(String value) {
        return Integer.toUnsignedString(value.hashCode(), 36).toUpperCase();
    }
}
