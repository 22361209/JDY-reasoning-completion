package com.jdy.erp.finance.application;

import java.math.BigDecimal;
import java.time.LocalDate;
import java.util.List;
import java.util.Map;
import java.util.UUID;

import com.jdy.erp.shared.application.BillLifecycleService;
import com.jdy.erp.shared.application.NumberingService;
import com.jdy.erp.shared.application.ValidationService;
import com.jdy.erp.shared.domain.BillStatus;
import org.springframework.dao.DataIntegrityViolationException;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.server.ResponseStatusException;

@Service
public class CashTransferAppService {
    private static final String TABLE = "cash_transfer";

    private final JdbcTemplate jdbcTemplate;
    private final NumberingService numberingService;
    private final ValidationService validationService;
    private final BillLifecycleService lifecycleService;

    public CashTransferAppService(
        JdbcTemplate jdbcTemplate,
        NumberingService numberingService,
        ValidationService validationService,
        BillLifecycleService lifecycleService
    ) {
        this.jdbcTemplate = jdbcTemplate;
        this.numberingService = numberingService;
        this.validationService = validationService;
        this.lifecycleService = lifecycleService;
    }

    @Transactional(readOnly = true)
    public Map<String, Object> detail(String billNo) {
        var rows = jdbcTemplate.queryForList("""
            SELECT t.id::text AS id,
                   t.bill_no AS "billNo",
                   to_char(t.bill_date, 'YYYY-MM-DD') AS "billDate",
                   t.source_account_id::text AS "sourceAccountId",
                   source.code AS "sourceAccountCode",
                   source.name AS "sourceAccountName",
                   t.target_account_id::text AS "targetAccountId",
                   target.code AS "targetAccountCode",
                   target.name AS "targetAccountName",
                   t.currency,
                   t.amount,
                   COALESCE(t.remark, '') AS remark,
                   t.status,
                   t.version
            FROM cash_transfer t
            JOIN md_financial_account source ON source.id = t.source_account_id
            JOIN md_financial_account target ON target.id = t.target_account_id
            WHERE t.bill_no = ?
            """, billNo);
        if (rows.isEmpty()) {
            throw new ResponseStatusException(HttpStatus.NOT_FOUND, "资金转账单不存在");
        }
        return Map.of("action", "DETAIL", "document", rows.getFirst());
    }

    @Transactional
    public Map<String, Object> saveDraft(CashTransferDraftRequest request) {
        var billNo = numberingService.assignBillNo("cashTransfer", request.billNo());
        var billDate = LocalDate.parse(validationService.required(request.billDate(), "业务日期"));
        var source = account(request.sourceAccountId(), "转出账户", false);
        var target = account(request.targetAccountId(), "转入账户", false);
        var currency = requireSameCurrency(source, target);
        var amount = nonNegative(request.amount());
        var rows = jdbcTemplate.queryForList("""
            INSERT INTO cash_transfer (
                bill_no, bill_date, source_account_id, target_account_id, currency, amount, remark, status
            ) VALUES (?, ?, ?::uuid, ?::uuid, ?, ?, ?, 'DRAFT')
            ON CONFLICT (bill_no) DO UPDATE
            SET bill_date = EXCLUDED.bill_date,
                source_account_id = EXCLUDED.source_account_id,
                target_account_id = EXCLUDED.target_account_id,
                currency = EXCLUDED.currency,
                amount = EXCLUDED.amount,
                remark = EXCLUDED.remark,
                updated_at = now(),
                version = cash_transfer.version + 1
            WHERE cash_transfer.status = 'DRAFT'
            RETURNING id::text AS id, bill_no AS "billNo", status, version
            """, billNo, billDate, source.id(), target.id(), currency, amount, validationService.optionalText(request.remark()));
        if (rows.isEmpty()) {
            throw conflict("只有草稿资金转账单可以覆盖保存");
        }
        return rows.getFirst();
    }

    @Transactional
    public Map<String, Object> audit(String billNo) {
        var transfer = lockedTransfer(billNo, BillStatus.DRAFT, "资金转账单不存在或已审核");
        var source = account(String.valueOf(transfer.get("sourceAccountId")), "转出账户", true);
        var target = account(String.valueOf(transfer.get("targetAccountId")), "转入账户", true);
        var currency = requireSameCurrency(source, target);
        if (!currency.equals(String.valueOf(transfer.get("currency")))) {
            throw conflict("资金转账单币种与账户币种不一致");
        }
        var amount = positive(decimal(transfer.get("amount")), "转账金额");
        var result = lifecycleService.transition(
            TABLE, billNo, BillStatus.DRAFT, BillStatus.AUDITED,
            "id::text AS id, bill_no AS \"billNo\", status, version",
            "FINANCE", "AUDIT", "cash_transfer", "资金转账单不存在或已审核"
        );
        writeFacts(
            String.valueOf(transfer.get("id")), source.id(), target.id(), currency, amount,
            "AUDIT", postingVersion(result), false
        );
        return result;
    }

    @Transactional
    public Map<String, Object> reverse(String billNo) {
        var transfer = lockedTransfer(billNo, BillStatus.AUDITED, "资金转账单不存在或不能反审核");
        var source = account(String.valueOf(transfer.get("sourceAccountId")), "转出账户", false);
        var target = account(String.valueOf(transfer.get("targetAccountId")), "转入账户", false);
        var currency = requireSameCurrency(source, target);
        var amount = positive(decimal(transfer.get("amount")), "转账金额");
        var result = lifecycleService.transition(
            TABLE, billNo, BillStatus.AUDITED, BillStatus.DRAFT,
            "id::text AS id, bill_no AS \"billNo\", status, version",
            "FINANCE", "REVERSE", "cash_transfer", "资金转账单不存在或不能反审核"
        );
        writeFacts(
            String.valueOf(transfer.get("id")), source.id(), target.id(), currency, amount,
            "REVERSE", postingVersion(result), true
        );
        return result;
    }

    private Map<String, Object> lockedTransfer(String billNo, BillStatus status, String message) {
        var rows = jdbcTemplate.queryForList("""
            SELECT id::text AS id,
                   source_account_id::text AS "sourceAccountId",
                   target_account_id::text AS "targetAccountId",
                   currency,
                   amount
            FROM cash_transfer
            WHERE bill_no = ? AND status = ?
            FOR UPDATE
            """, billNo, status.name());
        if (rows.isEmpty()) throw conflict(message);
        return rows.getFirst();
    }

    private Account account(String rawId, String label, boolean requireEnabledAudited) {
        UUID id;
        try {
            id = UUID.fromString(validationService.required(rawId, label));
        } catch (IllegalArgumentException exception) {
            throw badRequest(label + "不是有效账户");
        }
        var rows = jdbcTemplate.queryForList("""
            SELECT id::text AS id, currency, enabled, audit_status AS "auditStatus"
            FROM md_financial_account
            WHERE id = ?::uuid
            FOR UPDATE
            """, id.toString());
        if (rows.isEmpty()) throw conflict(label + "不存在");
        var row = rows.getFirst();
        if (requireEnabledAudited && (!(Boolean) row.get("enabled") || !"AUDITED".equals(row.get("auditStatus")))) {
            throw conflict("只能选择已审核且已启用的资金账户");
        }
        return new Account(String.valueOf(row.get("id")), String.valueOf(row.get("currency")));
    }

    private String requireSameCurrency(Account source, Account target) {
        if (source.id().equals(target.id())) throw badRequest("转出账户和转入账户不能相同");
        if (!source.currency().equals(target.currency())) throw conflict("资金转账只允许同币种账户");
        if (!List.of("CNY", "USD").contains(source.currency())) throw conflict("资金账户币种只允许 CNY 或 USD");
        return source.currency();
    }

    private void writeFacts(
        String transferId,
        String sourceAccountId,
        String targetAccountId,
        String currency,
        BigDecimal amount,
        String action,
        long postingVersion,
        boolean reverse
    ) {
        var sourceDelta = reverse ? amount : amount.negate();
        var targetDelta = sourceDelta.negate();
        try {
            jdbcTemplate.update("""
                INSERT INTO cash_transfer_fact (
                    cash_transfer_id, account_id, currency, amount_delta, posting_action, posting_version
                )
                VALUES (?::uuid, ?::uuid, ?, ?, ?, ?), (?::uuid, ?::uuid, ?, ?, ?, ?)
                """,
                transferId, sourceAccountId, currency, sourceDelta, action, postingVersion,
                transferId, targetAccountId, currency, targetDelta, action, postingVersion);
        } catch (DataIntegrityViolationException exception) {
            throw conflict("资金转账事实已发生变化，请刷新单据后重试");
        }
    }

    private long postingVersion(Map<String, Object> transition) {
        var value = transition.get("version");
        if (!(value instanceof Number number) || number.longValue() <= 0) {
            throw new ResponseStatusException(HttpStatus.INTERNAL_SERVER_ERROR, "资金转账生命周期版本无效");
        }
        return number.longValue();
    }

    private BigDecimal nonNegative(BigDecimal value) {
        var result = value == null ? BigDecimal.ZERO : value;
        if (result.compareTo(BigDecimal.ZERO) < 0) throw badRequest("转账金额不能小于 0");
        return result;
    }

    private BigDecimal positive(BigDecimal value, String label) {
        if (value == null || value.compareTo(BigDecimal.ZERO) <= 0) throw badRequest(label + "必须大于 0");
        return value;
    }

    private BigDecimal decimal(Object value) {
        return value instanceof BigDecimal decimal ? decimal : new BigDecimal(String.valueOf(value));
    }

    private ResponseStatusException badRequest(String message) {
        return new ResponseStatusException(HttpStatus.BAD_REQUEST, message);
    }

    private ResponseStatusException conflict(String message) {
        return new ResponseStatusException(HttpStatus.CONFLICT, message);
    }

    private record Account(String id, String currency) { }

    public record CashTransferDraftRequest(
        String billNo,
        String billDate,
        String sourceAccountId,
        String targetAccountId,
        BigDecimal amount,
        String remark
    ) { }
}
