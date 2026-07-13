package com.jdy.erp.finance.application;

import java.math.BigDecimal;
import java.math.BigInteger;
import java.math.RoundingMode;
import java.time.LocalDate;
import java.time.format.DateTimeParseException;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.EnumMap;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.UUID;

import com.fasterxml.jackson.databind.JsonNode;
import com.jdy.erp.shared.application.NumberingService;
import com.jdy.erp.shared.application.OperationLogCommand;
import com.jdy.erp.shared.application.OperationLogService;
import com.jdy.erp.system.security.CurrentSessionService;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.server.ResponseStatusException;

/**
 * Owns the formal receipt/payment lifecycle. Drafts only persist document data;
 * AR/AP facts change exclusively inside audit and reverse transactions.
 */
@Service
public class FinanceSettlementAppService {
    private static final BigDecimal MAX_MONEY = new BigDecimal("9999999999999999.99");
    private static final Set<String> CURRENCIES = Set.of("CNY", "USD");
    private static final Set<String> PAYMENT_METHODS = Set.of("CASH", "BANK_TRANSFER", "OTHER");

    private final JdbcTemplate jdbcTemplate;
    private final NumberingService numberingService;
    private final OperationLogService operationLogService;
    private final CurrentSessionService currentSessionService;

    public FinanceSettlementAppService(
        JdbcTemplate jdbcTemplate,
        NumberingService numberingService,
        OperationLogService operationLogService,
        CurrentSessionService currentSessionService
    ) {
        this.jdbcTemplate = jdbcTemplate;
        this.numberingService = numberingService;
        this.operationLogService = operationLogService;
        this.currentSessionService = currentSessionService;
    }

    @Transactional
    public Map<String, Object> createDraft(SettlementKind kind, SettlementDraftRequest request) {
        requireKind(kind);
        requireRequest(request);
        if (hasText(request.billNo())) {
            throw conflict("单据编号只能由系统自动生成，不能手工指定");
        }
        var draft = normalizeDraft(kind, request);
        var billNo = numberingService.nextBillNo(kind.numberingType);
        var header = jdbcTemplate.queryForMap("""
            INSERT INTO %s (
                bill_no, party_id, bill_date, currency, amount, status, version,
                remark, legacy_imported, created_at, updated_at
            )
            VALUES (?, ?::uuid, ?, ?, ?, 'DRAFT', 0, ?, FALSE, now(), now())
            RETURNING id::text AS id, bill_no AS "billNo", status, version
            """.formatted(kind.headerTable),
            billNo,
            draft.partyId(),
            draft.billDate(),
            draft.currency(),
            draft.amount(),
            draft.remark()
        );
        insertFundLines(kind, String.valueOf(header.get("id")), draft.fundLines());
        insertAllocations(kind, String.valueOf(header.get("id")), draft.allocations());

        var result = detail(kind, billNo);
        logSuccess(kind, kind.createAction, result, Map.of(), state(result));
        return result;
    }

    @Transactional
    public Map<String, Object> updateDraft(
        SettlementKind kind,
        String billNo,
        SettlementDraftRequest request
    ) {
        requireKind(kind);
        requireRequest(request);
        var normalizedBillNo = requiredText(billNo, "单据编号", 80);
        if (hasText(request.billNo()) && !normalizedBillNo.equals(request.billNo().trim())) {
            throw conflict("请求体单据编号与路径不一致");
        }
        var expectedVersion = strictVersion(request.version());
        var before = header(kind, normalizedBillNo, false);
        if (!"DRAFT".equals(before.get("status"))) {
            throw conflict("只有草稿收付款单可以修改");
        }
        var draft = normalizeDraft(kind, request);
        var legacy = Boolean.TRUE.equals(before.get("legacy"));
        if (legacy) {
            requireLegacyDraftInvariant(kind, before, draft);
        }
        var beforeState = documentState(kind, before);
        var updated = jdbcTemplate.queryForList("""
            UPDATE %s
            SET party_id = ?::uuid,
                bill_date = ?,
                currency = ?,
                amount = ?,
                remark = ?,
                version = version + 1,
                updated_at = now()
            WHERE id = ?::uuid
              AND status = 'DRAFT'
              AND version = ?
            RETURNING id::text AS id
            """.formatted(kind.headerTable),
            draft.partyId(),
            draft.billDate(),
            draft.currency(),
            draft.amount(),
            draft.remark(),
            before.get("id"),
            expectedVersion
        );
        if (updated.isEmpty()) {
            throw conflict("单据版本已变化，请刷新后重试");
        }
        var headerId = String.valueOf(before.get("id"));
        jdbcTemplate.update(
            "DELETE FROM " + kind.fundTable + " WHERE " + kind.ownerColumn + " = ?::uuid",
            headerId
        );
        insertFundLines(kind, headerId, draft.fundLines());
        if (!legacy) {
            jdbcTemplate.update(
                "DELETE FROM " + kind.allocationTable + " WHERE " + kind.ownerColumn + " = ?::uuid",
                headerId
            );
            insertAllocations(kind, headerId, draft.allocations());
        }

        var result = detail(kind, normalizedBillNo);
        logSuccess(kind, kind.updateAction, result, beforeState, state(result));
        return result;
    }

    @Transactional(readOnly = true)
    public Map<String, Object> detail(SettlementKind kind, String billNo) {
        requireKind(kind);
        var normalizedBillNo = requiredText(billNo, "单据编号", 80);
        var rows = jdbcTemplate.queryForList("""
            SELECT h.id::text AS id,
                   h.bill_no AS "billNo",
                   h.party_id::text AS "partyId",
                   party.code AS "partyCode",
                   party.name AS "partyName",
                   to_char(h.bill_date, 'YYYY-MM-DD') AS "billDate",
                   h.currency,
                   h.amount::text AS amount,
                   h.status,
                   h.version::text AS version,
                   COALESCE(h.remark, '') AS remark,
                   h.legacy_imported AS legacy,
                   h.legacy_imported AS "legacyImported",
                   to_char(h.created_at, 'YYYY-MM-DD HH24:MI:SS') AS "createdAt",
                   to_char(h.updated_at, 'YYYY-MM-DD HH24:MI:SS') AS "updatedAt",
                   to_char(h.audited_at, 'YYYY-MM-DD HH24:MI:SS') AS "auditedAt"
            FROM %s h
            JOIN %s party ON party.id = h.party_id
            WHERE h.bill_no = ?
            """.formatted(kind.headerTable, kind.partyTable), normalizedBillNo);
        if (rows.isEmpty()) {
            throw new ResponseStatusException(HttpStatus.NOT_FOUND, kind.label + "不存在");
        }
        var result = new LinkedHashMap<String, Object>(rows.getFirst());
        result.put("kind", kind.apiName);
        result.put("fundLines", fundLineDetail(kind, String.valueOf(result.get("id"))));
        result.put("allocations", allocationDetail(kind, String.valueOf(result.get("id"))));
        return result;
    }

    @Transactional
    public Map<String, Object> audit(SettlementKind kind, String billNo) {
        requireKind(kind);
        var normalizedBillNo = requiredText(billNo, "单据编号", 80);
        var lockedHeader = header(kind, normalizedBillNo, true);
        if ("AUDITED".equals(lockedHeader.get("status"))) {
            return detail(kind, normalizedBillNo);
        }
        if (!"DRAFT".equals(lockedHeader.get("status"))) {
            throw conflict("只有草稿收付款单可以审核");
        }

        var headerId = String.valueOf(lockedHeader.get("id"));
        var funds = storedFundLines(kind, headerId);
        var allocations = storedAllocations(kind, headerId);
        validateAuditShape(kind, lockedHeader, funds, allocations);

        var sources = lockSources(kind, allocations);
        var accounts = lockAccounts(funds);
        validateAccounts(kind, lockedHeader, funds, accounts);
        validateSources(kind, lockedHeader, allocations, sources, true);

        for (var allocation : allocations) {
            var source = sources.get(allocation.sourceId());
            jdbcTemplate.update("""
                UPDATE %s
                SET source_amount = ?,
                    settled_before = ?,
                    unsettled_before = ?
                WHERE %s = ?::uuid
                  AND %s = ?::uuid
                """.formatted(kind.allocationTable, kind.ownerColumn, kind.sourceIdColumn),
                source.amount(),
                source.settledAmount(),
                source.unsettledAmount(),
                headerId,
                allocation.sourceId()
            );
            var changed = jdbcTemplate.update("""
                UPDATE %s
                SET %s = %s + ?,
                    status = CASE
                        WHEN %s + ? = amount THEN 'SETTLED'
                        WHEN %s + ? = 0 THEN 'OPEN'
                        ELSE 'PART_SETTLED'
                    END,
                    updated_at = now()
                WHERE id = ?::uuid
                  AND amount > 0
                  AND %s >= 0
                  AND %s + ? <= amount
                """.formatted(
                    kind.sourceTable,
                    kind.settledColumn,
                    kind.settledColumn,
                    kind.settledColumn,
                    kind.settledColumn,
                    kind.settledColumn,
                    kind.settledColumn
                ),
                allocation.settlementAmount(),
                allocation.settlementAmount(),
                allocation.settlementAmount(),
                allocation.sourceId(),
                allocation.settlementAmount()
            );
            if (changed != 1) {
                throw conflict(kind.sourceLabel + "可核销余额已变化，请刷新后重试");
            }
        }

        var updated = jdbcTemplate.queryForList("""
            UPDATE %s
            SET status = 'AUDITED',
                version = version + 1,
                audited_at = now(),
                audited_by = ?::uuid,
                updated_at = now()
            WHERE id = ?::uuid
              AND status = 'DRAFT'
            RETURNING id::text AS id
            """.formatted(kind.headerTable), currentSessionService.currentUserId(), headerId);
        if (updated.isEmpty()) {
            throw conflict("单据状态已变化，请刷新后重试");
        }
        var result = detail(kind, normalizedBillNo);
        logSuccess(kind, kind.auditAction, result, documentState(kind, lockedHeader), state(result));
        return result;
    }

    @Transactional
    public Map<String, Object> reverse(SettlementKind kind, String billNo) {
        requireKind(kind);
        var normalizedBillNo = requiredText(billNo, "单据编号", 80);
        var lockedHeader = header(kind, normalizedBillNo, true);
        if (!"AUDITED".equals(lockedHeader.get("status"))) {
            throw conflict("只有已审核收付款单可以反审核");
        }
        var headerId = String.valueOf(lockedHeader.get("id"));
        var allocations = storedAllocations(kind, headerId);
        if (allocations.isEmpty()) {
            throw conflict(kind.label + "缺少可释放的核销明细");
        }
        var sources = lockSources(kind, allocations);
        validateSources(kind, lockedHeader, allocations, sources, false);

        for (var allocation : allocations) {
            var source = sources.get(allocation.sourceId());
            if (source.amount().compareTo(allocation.sourceAmount()) != 0) {
                throw conflict(kind.sourceLabel + "原币金额已变化，无法安全反审核");
            }
            if (source.settledAmount().compareTo(allocation.settlementAmount()) < 0) {
                throw conflict(kind.sourceLabel + "已核销金额不足，无法安全释放");
            }
            var changed = jdbcTemplate.update("""
                UPDATE %s
                SET %s = %s - ?,
                    status = CASE
                        WHEN %s - ? = 0 THEN 'OPEN'
                        WHEN %s - ? = amount THEN 'SETTLED'
                        ELSE 'PART_SETTLED'
                    END,
                    updated_at = now()
                WHERE id = ?::uuid
                  AND %s >= ?
                """.formatted(
                    kind.sourceTable,
                    kind.settledColumn,
                    kind.settledColumn,
                    kind.settledColumn,
                    kind.settledColumn,
                    kind.settledColumn
                ),
                allocation.settlementAmount(),
                allocation.settlementAmount(),
                allocation.settlementAmount(),
                allocation.sourceId(),
                allocation.settlementAmount()
            );
            if (changed != 1) {
                throw conflict(kind.sourceLabel + "已核销金额已变化，无法安全释放");
            }
        }

        var updated = jdbcTemplate.queryForList("""
            UPDATE %s
            SET status = 'DRAFT',
                version = version + 1,
                audited_at = NULL,
                audited_by = NULL,
                updated_at = now()
            WHERE id = ?::uuid
              AND status = 'AUDITED'
            RETURNING id::text AS id
            """.formatted(kind.headerTable), headerId);
        if (updated.isEmpty()) {
            throw conflict("单据状态已变化，请刷新后重试");
        }
        var result = detail(kind, normalizedBillNo);
        logSuccess(kind, kind.reverseAction, result, documentState(kind, lockedHeader), state(result));
        return result;
    }

    @Transactional
    public Map<String, Object> deleteDraft(SettlementKind kind, String billNo) {
        requireKind(kind);
        var normalizedBillNo = requiredText(billNo, "单据编号", 80);
        var lockedHeader = header(kind, normalizedBillNo, true);
        if (!"DRAFT".equals(lockedHeader.get("status"))) {
            throw conflict("只有草稿收付款单可以删除");
        }
        if (Boolean.TRUE.equals(lockedHeader.get("legacy"))) {
            throw conflict("历史直接结算记录不允许物理删除");
        }
        var beforeState = documentState(kind, lockedHeader);
        var deleted = jdbcTemplate.update(
            "DELETE FROM " + kind.headerTable + " WHERE id = ?::uuid AND status = 'DRAFT'",
            lockedHeader.get("id")
        );
        if (deleted != 1) {
            throw conflict("单据状态已变化，请刷新后重试");
        }
        var result = new LinkedHashMap<String, Object>();
        result.put("id", lockedHeader.get("id"));
        result.put("billNo", normalizedBillNo);
        result.put("kind", kind.apiName);
        result.put("status", "DELETED");
        result.put("version", String.valueOf(lockedHeader.get("version")));
        logSuccess(kind, kind.deleteAction, result, beforeState, OperationLogCommand.state(
            OperationLogCommand.StateField.STATUS, "DELETED",
            OperationLogCommand.StateField.VERSION, lockedHeader.get("version")
        ));
        return result;
    }

    private NormalizedDraft normalizeDraft(SettlementKind kind, SettlementDraftRequest request) {
        var partyId = uuid(requiredText(request.partyId(), kind.partyLabel, 80), kind.partyLabel);
        requireParty(kind, partyId);
        var billDate = date(request.billDate());
        var currency = oneOf(request.currency(), "币种", CURRENCIES);
        var amount = money(request.amount(), "单据金额", true);
        var remark = optionalText(request.remark(), "备注", 2_000);

        var funds = new ArrayList<NormalizedFundLine>();
        var fundRequests = request.fundLines() == null ? List.<FundLineRequest>of() : request.fundLines();
        for (var row : fundRequests) {
            if (row == null || blankFundLine(row)) {
                continue;
            }
            var accountId = uuid(requiredText(row.accountId(), "资金账户", 80), "资金账户");
            var method = oneOf(row.paymentMethod(), "结算方式", PAYMENT_METHODS);
            var lineAmount = money(row.amount(), "资金行金额", true);
            var fee = money(row.fee(), "手续费", true);
            if (fee.compareTo(BigDecimal.ZERO) != 0) {
                throw badRequest("A141 手续费只允许为 0");
            }
            var account = loadAccount(accountId, false);
            validateAccount(currency, account, method);
            funds.add(new NormalizedFundLine(
                funds.size() + 1,
                accountId,
                method,
                lineAmount,
                fee,
                optionalText(row.transactionNo(), "交易号", 120),
                optionalText(row.remark(), "资金行备注", 1_000)
            ));
        }

        var allocations = new ArrayList<NormalizedAllocation>();
        var sourceIds = new HashSet<UUID>();
        var allocationRequests = request.allocations() == null
            ? List.<AllocationRequest>of()
            : request.allocations();
        for (var row : allocationRequests) {
            if (row == null || blankAllocation(row)) {
                continue;
            }
            var sourceId = uuid(requiredText(row.sourceId(), kind.sourceLabel, 80), kind.sourceLabel);
            if (!sourceIds.add(sourceId)) {
                throw badRequest("同一" + kind.sourceLabel + "在一张单据中只能选择一次");
            }
            var settlementAmount = money(row.settlementAmount(), "本次核销金额", true);
            var source = loadSource(kind, sourceId, false);
            validateSource(kind, partyId, currency, source, settlementAmount, true);
            allocations.add(new NormalizedAllocation(
                allocations.size() + 1,
                sourceId,
                source.amount(),
                source.settledAmount(),
                source.unsettledAmount(),
                settlementAmount,
                optionalText(row.remark(), "核销行备注", 1_000)
            ));
        }

        var fundTotal = funds.stream()
            .map(NormalizedFundLine::amount)
            .reduce(BigDecimal.ZERO.setScale(2), BigDecimal::add);
        var allocationTotal = allocations.stream()
            .map(NormalizedAllocation::settlementAmount)
            .reduce(BigDecimal.ZERO.setScale(2), BigDecimal::add);
        if (amount.compareTo(fundTotal) != 0 || amount.compareTo(allocationTotal) != 0) {
            throw badRequest("单据金额、资金行合计和核销行合计必须相等");
        }
        return new NormalizedDraft(partyId, billDate, currency, amount, remark, funds, allocations);
    }

    private void requireLegacyDraftInvariant(
        SettlementKind kind,
        Map<String, Object> before,
        NormalizedDraft draft
    ) {
        if (!String.valueOf(before.get("partyId")).equals(draft.partyId().toString())
            || !String.valueOf(before.get("currency")).equals(draft.currency())
            || decimal(before.get("amount")).compareTo(draft.amount()) != 0) {
            throw conflict("历史直接结算记录反审核后不允许修改往来单位、币种或核销金额");
        }
        var stored = storedAllocations(kind, String.valueOf(before.get("id")));
        if (stored.size() != draft.allocations().size()) {
            throw conflict("历史直接结算记录反审核后不允许修改核销来源");
        }
        for (var index = 0; index < stored.size(); index++) {
            var oldLine = stored.get(index);
            var newLine = draft.allocations().get(index);
            if (!oldLine.sourceId().equals(newLine.sourceId())
                || oldLine.settlementAmount().compareTo(newLine.settlementAmount()) != 0) {
                throw conflict("历史直接结算记录反审核后不允许修改核销来源或金额");
            }
        }
    }

    private void validateAuditShape(
        SettlementKind kind,
        Map<String, Object> header,
        List<StoredFundLine> funds,
        List<StoredAllocation> allocations
    ) {
        var amount = decimal(header.get("amount"));
        if (amount.compareTo(BigDecimal.ZERO) <= 0) {
            throw badRequest(kind.label + "审核金额必须大于 0");
        }
        if (funds.isEmpty() || allocations.isEmpty()) {
            throw badRequest(kind.label + "审核前必须填写资金行和核销来源行");
        }
        if (funds.stream().anyMatch(row -> row.amount().compareTo(BigDecimal.ZERO) <= 0)) {
            throw badRequest("审核时每条资金行金额必须大于 0");
        }
        if (allocations.stream().anyMatch(row -> row.settlementAmount().compareTo(BigDecimal.ZERO) <= 0)) {
            throw badRequest("审核时每条核销行金额必须大于 0");
        }
        var fundTotal = funds.stream().map(StoredFundLine::amount).reduce(BigDecimal.ZERO, BigDecimal::add);
        var allocationTotal = allocations.stream()
            .map(StoredAllocation::settlementAmount)
            .reduce(BigDecimal.ZERO, BigDecimal::add);
        if (amount.compareTo(fundTotal) != 0 || amount.compareTo(allocationTotal) != 0) {
            throw conflict("单据金额、资金行合计和核销行合计不一致");
        }
    }

    private Map<UUID, SourceState> lockSources(
        SettlementKind kind,
        List<StoredAllocation> allocations
    ) {
        var ids = allocations.stream()
            .map(StoredAllocation::sourceId)
            .distinct()
            .sorted(Comparator.comparing(UUID::toString))
            .toList();
        var sources = new LinkedHashMap<UUID, SourceState>();
        for (var id : ids) {
            sources.put(id, loadSource(kind, id, true));
        }
        return sources;
    }

    private Map<UUID, AccountState> lockAccounts(List<StoredFundLine> funds) {
        var ids = funds.stream()
            .map(StoredFundLine::accountId)
            .distinct()
            .sorted(Comparator.comparing(UUID::toString))
            .toList();
        var accounts = new LinkedHashMap<UUID, AccountState>();
        for (var id : ids) {
            accounts.put(id, loadAccount(id, true));
        }
        return accounts;
    }

    private void validateAccounts(
        SettlementKind kind,
        Map<String, Object> header,
        List<StoredFundLine> funds,
        Map<UUID, AccountState> accounts
    ) {
        var currency = String.valueOf(header.get("currency"));
        for (var fund : funds) {
            var account = accounts.get(fund.accountId());
            if (account == null) {
                throw conflict("资金账户不存在");
            }
            validateAccount(currency, account, fund.paymentMethod());
            if (fund.fee().compareTo(BigDecimal.ZERO) != 0) {
                throw conflict("A141 手续费只允许为 0");
            }
        }
    }

    private void validateSources(
        SettlementKind kind,
        Map<String, Object> header,
        List<StoredAllocation> allocations,
        Map<UUID, SourceState> sources,
        boolean requireAvailable
    ) {
        var partyId = uuid(String.valueOf(header.get("partyId")), kind.partyLabel);
        var currency = String.valueOf(header.get("currency"));
        for (var allocation : allocations) {
            var source = sources.get(allocation.sourceId());
            if (source == null) {
                throw conflict(kind.sourceLabel + "不存在");
            }
            validateSource(
                kind,
                partyId,
                currency,
                source,
                allocation.settlementAmount(),
                requireAvailable
            );
        }
    }

    private void validateSource(
        SettlementKind kind,
        UUID partyId,
        String currency,
        SourceState source,
        BigDecimal settlementAmount,
        boolean requireAvailable
    ) {
        if (!partyId.equals(source.partyId())) {
            throw conflict("同一" + kind.label + "不能混用不同" + kind.partyLabel);
        }
        if (!currency.equals(source.currency())) {
            throw conflict(kind.sourceLabel + "与" + kind.label + "币种必须一致");
        }
        if (source.amount().compareTo(BigDecimal.ZERO) <= 0) {
            throw conflict(kind.sourceLabel + "金额必须大于 0");
        }
        if (source.settledAmount().compareTo(BigDecimal.ZERO) < 0
            || source.settledAmount().compareTo(source.amount()) > 0) {
            throw conflict(kind.sourceLabel + "已核销金额异常");
        }
        var expectedStatus = settlementStatus(source.amount(), source.settledAmount());
        if (!expectedStatus.equals(source.status())) {
            throw conflict(kind.sourceLabel + "状态与已核销金额不一致");
        }
        if (requireAvailable && source.unsettledAmount().compareTo(BigDecimal.ZERO) <= 0) {
            throw conflict(kind.sourceLabel + "已无可核销余额");
        }
        if (requireAvailable && settlementAmount.compareTo(source.unsettledAmount()) > 0) {
            throw conflict(kind.sourceLabel + "本次核销金额超过实时未核销余额");
        }
    }

    private void validateAccount(String currency, AccountState account, String paymentMethod) {
        if (!account.enabled() || !"AUDITED".equals(account.auditStatus())) {
            throw conflict("只能选择已审核且已启用的资金账户");
        }
        if (!currency.equals(account.currency())) {
            throw conflict("资金账户与收付款单币种必须一致");
        }
        if ("CASH".equals(account.accountType()) && !"CASH".equals(paymentMethod)) {
            throw conflict("现金账户只允许使用现金结算方式");
        }
        if (!"CASH".equals(account.accountType()) && "CASH".equals(paymentMethod)) {
            throw conflict("银行或存款账户不允许使用现金结算方式");
        }
    }

    private SourceState loadSource(SettlementKind kind, UUID sourceId, boolean lock) {
        var rows = jdbcTemplate.queryForList("""
            SELECT id::text AS id,
                   bill_no AS "billNo",
                   %s::text AS "partyId",
                   to_char(bill_date, 'YYYY-MM-DD') AS "billDate",
                   currency,
                   amount,
                   %s AS "settledAmount",
                   status
            FROM %s
            WHERE id = ?::uuid
            %s
            """.formatted(
                kind.sourcePartyColumn,
                kind.settledColumn,
                kind.sourceTable,
                lock ? "FOR UPDATE" : ""
            ), sourceId);
        if (rows.isEmpty()) {
            throw conflict(kind.sourceLabel + "不存在");
        }
        var row = rows.getFirst();
        var amount = decimal(row.get("amount"));
        var settled = decimal(row.get("settledAmount"));
        return new SourceState(
            sourceId,
            String.valueOf(row.get("billNo")),
            uuid(String.valueOf(row.get("partyId")), kind.partyLabel),
            String.valueOf(row.get("billDate")),
            String.valueOf(row.get("currency")),
            amount,
            settled,
            amount.subtract(settled),
            String.valueOf(row.get("status"))
        );
    }

    private AccountState loadAccount(UUID accountId, boolean lock) {
        var rows = jdbcTemplate.queryForList("""
            SELECT id::text AS id,
                   code,
                   name,
                   account_type AS "accountType",
                   currency,
                   audit_status AS "auditStatus",
                   enabled
            FROM md_financial_account
            WHERE id = ?::uuid
            %s
            """.formatted(lock ? "FOR SHARE" : ""), accountId);
        if (rows.isEmpty()) {
            throw conflict("资金账户不存在");
        }
        var row = rows.getFirst();
        return new AccountState(
            accountId,
            String.valueOf(row.get("code")),
            String.valueOf(row.get("name")),
            String.valueOf(row.get("accountType")),
            String.valueOf(row.get("currency")),
            String.valueOf(row.get("auditStatus")),
            Boolean.TRUE.equals(row.get("enabled"))
        );
    }

    private void requireParty(SettlementKind kind, UUID partyId) {
        var count = jdbcTemplate.queryForObject(
            "SELECT COUNT(*)::int FROM " + kind.partyTable + " WHERE id = ?::uuid",
            Integer.class,
            partyId
        );
        if (count == null || count != 1) {
            throw conflict(kind.partyLabel + "不存在");
        }
    }

    private Map<String, Object> header(SettlementKind kind, String billNo, boolean lock) {
        var rows = jdbcTemplate.queryForList("""
            SELECT id::text AS id,
                   bill_no AS "billNo",
                   party_id::text AS "partyId",
                   to_char(bill_date, 'YYYY-MM-DD') AS "billDate",
                   currency,
                   amount,
                   status,
                   version,
                   COALESCE(remark, '') AS remark,
                   legacy_imported AS legacy
            FROM %s
            WHERE bill_no = ?
            %s
            """.formatted(kind.headerTable, lock ? "FOR UPDATE" : ""), billNo);
        if (rows.isEmpty()) {
            throw new ResponseStatusException(HttpStatus.NOT_FOUND, kind.label + "不存在");
        }
        return rows.getFirst();
    }

    private List<StoredFundLine> storedFundLines(SettlementKind kind, String headerId) {
        return jdbcTemplate.queryForList("""
            SELECT line_no AS "lineNo",
                   account_id::text AS "accountId",
                   payment_method AS "paymentMethod",
                   amount,
                   fee
            FROM %s
            WHERE %s = ?::uuid
            ORDER BY line_no
            """.formatted(kind.fundTable, kind.ownerColumn), headerId).stream().map(row -> new StoredFundLine(
                Number.class.cast(row.get("lineNo")).intValue(),
                uuid(String.valueOf(row.get("accountId")), "资金账户"),
                String.valueOf(row.get("paymentMethod")),
                decimal(row.get("amount")),
                decimal(row.get("fee"))
            )).toList();
    }

    private List<StoredAllocation> storedAllocations(SettlementKind kind, String headerId) {
        return jdbcTemplate.queryForList("""
            SELECT line_no AS "lineNo",
                   %s::text AS "sourceId",
                   source_amount AS "sourceAmount",
                   settled_before AS "settledBefore",
                   unsettled_before AS "unsettledBefore",
                   settlement_amount AS "settlementAmount"
            FROM %s
            WHERE %s = ?::uuid
            ORDER BY line_no
            """.formatted(kind.sourceIdColumn, kind.allocationTable, kind.ownerColumn), headerId).stream()
            .map(row -> new StoredAllocation(
                Number.class.cast(row.get("lineNo")).intValue(),
                uuid(String.valueOf(row.get("sourceId")), kind.sourceLabel),
                decimal(row.get("sourceAmount")),
                decimal(row.get("settledBefore")),
                decimal(row.get("unsettledBefore")),
                decimal(row.get("settlementAmount"))
            )).toList();
    }

    private List<Map<String, Object>> fundLineDetail(SettlementKind kind, String headerId) {
        return jdbcTemplate.queryForList("""
            SELECT line.id::text AS id,
                   line.line_no AS "lineNo",
                   line.account_id::text AS "accountId",
                   account.code AS "accountCode",
                   account.name AS "accountName",
                   account.account_type AS "accountType",
                   account.currency AS "accountCurrency",
                   line.payment_method AS "paymentMethod",
                   line.amount::text AS amount,
                   line.fee::text AS fee,
                   COALESCE(line.transaction_no, '') AS "transactionNo",
                   COALESCE(line.remark, '') AS remark
            FROM %s line
            JOIN md_financial_account account ON account.id = line.account_id
            WHERE line.%s = ?::uuid
            ORDER BY line.line_no
            """.formatted(kind.fundTable, kind.ownerColumn), headerId);
    }

    private List<Map<String, Object>> allocationDetail(SettlementKind kind, String headerId) {
        return jdbcTemplate.queryForList("""
            SELECT line.id::text AS id,
                   line.line_no AS "lineNo",
                   line.%s::text AS "sourceId",
                   source.bill_no AS "sourceBillNo",
                   to_char(source.bill_date, 'YYYY-MM-DD') AS "sourceDate",
                   line.source_amount::text AS "sourceAmount",
                   line.settled_before::text AS "settledBefore",
                   line.unsettled_before::text AS "unsettledBefore",
                   source.%s::text AS "currentSettledAmount",
                   (source.amount - source.%s)::text AS "currentUnsettledAmount",
                   line.settlement_amount::text AS "settlementAmount",
                   COALESCE(line.remark, '') AS remark
            FROM %s line
            JOIN %s source ON source.id = line.%s
            WHERE line.%s = ?::uuid
            ORDER BY line.line_no
            """.formatted(
                kind.sourceIdColumn,
                kind.settledColumn,
                kind.settledColumn,
                kind.allocationTable,
                kind.sourceTable,
                kind.sourceIdColumn,
                kind.ownerColumn
            ), headerId);
    }

    private void insertFundLines(
        SettlementKind kind,
        String headerId,
        List<NormalizedFundLine> funds
    ) {
        for (var line : funds) {
            jdbcTemplate.update("""
                INSERT INTO %s (
                    %s, line_no, account_id, payment_method, amount, fee,
                    transaction_no, remark
                )
                VALUES (?::uuid, ?, ?::uuid, ?, ?, ?, ?, ?)
                """.formatted(kind.fundTable, kind.ownerColumn),
                headerId,
                line.lineNo(),
                line.accountId(),
                line.paymentMethod(),
                line.amount(),
                line.fee(),
                line.transactionNo(),
                line.remark()
            );
        }
    }

    private void insertAllocations(
        SettlementKind kind,
        String headerId,
        List<NormalizedAllocation> allocations
    ) {
        for (var line : allocations) {
            jdbcTemplate.update("""
                INSERT INTO %s (
                    %s, line_no, %s, source_amount, settled_before,
                    unsettled_before, settlement_amount, remark
                )
                VALUES (?::uuid, ?, ?::uuid, ?, ?, ?, ?, ?)
                """.formatted(kind.allocationTable, kind.ownerColumn, kind.sourceIdColumn),
                headerId,
                line.lineNo(),
                line.sourceId(),
                line.sourceAmount(),
                line.settledBefore(),
                line.unsettledBefore(),
                line.settlementAmount(),
                line.remark()
            );
        }
    }

    private Map<OperationLogCommand.StateField, Object> documentState(
        SettlementKind kind,
        Map<String, Object> header
    ) {
        var state = new EnumMap<OperationLogCommand.StateField, Object>(OperationLogCommand.StateField.class);
        state.put(OperationLogCommand.StateField.STATUS, header.get("status"));
        state.put(OperationLogCommand.StateField.CURRENCY, header.get("currency"));
        state.put(OperationLogCommand.StateField.AMOUNT, header.get("amount"));
        state.put(OperationLogCommand.StateField.VERSION, header.get("version"));
        var headerId = String.valueOf(header.get("id"));
        state.put(OperationLogCommand.StateField.ACCOUNT_COUNT, rowCount(kind.fundTable, kind.ownerColumn, headerId));
        state.put(OperationLogCommand.StateField.SOURCE_COUNT, rowCount(kind.allocationTable, kind.ownerColumn, headerId));
        return state;
    }

    private Map<OperationLogCommand.StateField, Object> state(Map<String, Object> document) {
        var funds = document.get("fundLines") instanceof List<?> rows ? rows.size() : 0;
        var allocations = document.get("allocations") instanceof List<?> rows ? rows.size() : 0;
        return OperationLogCommand.state(
            OperationLogCommand.StateField.STATUS, document.get("status"),
            OperationLogCommand.StateField.CURRENCY, document.get("currency"),
            OperationLogCommand.StateField.AMOUNT, document.get("amount"),
            OperationLogCommand.StateField.VERSION, document.get("version"),
            OperationLogCommand.StateField.ACCOUNT_COUNT, funds,
            OperationLogCommand.StateField.SOURCE_COUNT, allocations
        );
    }

    private int rowCount(String table, String ownerColumn, String headerId) {
        var count = jdbcTemplate.queryForObject(
            "SELECT COUNT(*)::int FROM " + table + " WHERE " + ownerColumn + " = ?::uuid",
            Integer.class,
            headerId
        );
        return count == null ? 0 : count;
    }

    private void logSuccess(
        SettlementKind kind,
        String action,
        Map<String, Object> document,
        Map<OperationLogCommand.StateField, Object> before,
        Map<OperationLogCommand.StateField, Object> after
    ) {
        operationLogService.logCurrent(OperationLogCommand.success(
            "FINANCE",
            action,
            kind.targetType,
            uuid(String.valueOf(document.get("id")), kind.label),
            String.valueOf(document.get("billNo")),
            OperationLogCommand.ActorMode.CURRENT_USER,
            null,
            before,
            after,
            null
        ));
    }

    private long strictVersion(JsonNode version) {
        if (version != null && version.isIntegralNumber() && version.canConvertToLong()) {
            var value = version.longValue();
            if (value >= 0) {
                return value;
            }
        }
        if (version != null && version.isTextual()) {
            var text = version.textValue();
            if (text != null && text.length() <= 19 && text.matches("0|[1-9][0-9]*")) {
                try {
                    var value = new BigInteger(text);
                    if (value.compareTo(BigInteger.valueOf(Long.MAX_VALUE)) <= 0) {
                        return value.longValueExact();
                    }
                } catch (NumberFormatException | ArithmeticException ignored) {
                    // The common validation error below is the public contract.
                }
            }
        }
        throw badRequest("version 必须是非负 64 位整数或规范十进制字符串");
    }

    private BigDecimal money(BigDecimal value, String label, boolean defaultZero) {
        if (value == null) {
            if (defaultZero) {
                return BigDecimal.ZERO.setScale(2);
            }
            throw badRequest(label + "不能为空");
        }
        final BigDecimal normalized;
        try {
            normalized = value.setScale(2, RoundingMode.UNNECESSARY);
        } catch (ArithmeticException exception) {
            throw badRequest(label + "最多保留 2 位小数");
        }
        if (normalized.compareTo(BigDecimal.ZERO) < 0) {
            throw badRequest(label + "不能为负数");
        }
        if (normalized.abs().compareTo(MAX_MONEY) > 0) {
            throw badRequest(label + "超出可保存范围");
        }
        return normalized;
    }

    private BigDecimal decimal(Object value) {
        if (value instanceof BigDecimal decimal) {
            return decimal;
        }
        if (value instanceof Number number) {
            return new BigDecimal(number.toString());
        }
        return new BigDecimal(String.valueOf(value));
    }

    private LocalDate date(String value) {
        var normalized = requiredText(value, "业务日期", 20);
        try {
            return LocalDate.parse(normalized);
        } catch (DateTimeParseException exception) {
            throw badRequest("业务日期必须为 YYYY-MM-DD");
        }
    }

    private UUID uuid(String value, String label) {
        try {
            return UUID.fromString(value);
        } catch (IllegalArgumentException exception) {
            throw badRequest(label + "格式不正确");
        }
    }

    private String oneOf(String value, String label, Set<String> allowed) {
        var normalized = requiredText(value, label, 40).toUpperCase(Locale.ROOT);
        if (!allowed.contains(normalized)) {
            throw badRequest(label + "只允许 " + String.join("/", allowed));
        }
        return normalized;
    }

    private String requiredText(String value, String label, int maxLength) {
        if (!hasText(value)) {
            throw badRequest(label + "不能为空");
        }
        var normalized = value.trim();
        if (normalized.length() > maxLength) {
            throw badRequest(label + "不能超过 " + maxLength + " 个字符");
        }
        return normalized;
    }

    private String optionalText(String value, String label, int maxLength) {
        if (!hasText(value)) {
            return null;
        }
        return requiredText(value, label, maxLength);
    }

    private boolean blankFundLine(FundLineRequest row) {
        return !hasText(row.accountId())
            && !hasText(row.paymentMethod())
            && zeroOrNull(row.amount())
            && zeroOrNull(row.fee())
            && !hasText(row.transactionNo())
            && !hasText(row.remark());
    }

    private boolean blankAllocation(AllocationRequest row) {
        return !hasText(row.sourceId())
            && zeroOrNull(row.settlementAmount())
            && !hasText(row.remark());
    }

    private boolean zeroOrNull(BigDecimal value) {
        return value == null || value.compareTo(BigDecimal.ZERO) == 0;
    }

    private boolean hasText(String value) {
        return value != null && !value.isBlank();
    }

    private String settlementStatus(BigDecimal amount, BigDecimal settled) {
        if (settled.compareTo(BigDecimal.ZERO) == 0) {
            return "OPEN";
        }
        if (settled.compareTo(amount) == 0) {
            return "SETTLED";
        }
        return "PART_SETTLED";
    }

    private void requireKind(SettlementKind kind) {
        if (kind == null) {
            throw new IllegalArgumentException("收付款类型不能为空");
        }
    }

    private void requireRequest(SettlementDraftRequest request) {
        if (request == null) {
            throw badRequest("请求体不能为空");
        }
    }

    private ResponseStatusException badRequest(String reason) {
        return new ResponseStatusException(HttpStatus.BAD_REQUEST, reason);
    }

    private ResponseStatusException conflict(String reason) {
        return new ResponseStatusException(HttpStatus.CONFLICT, reason);
    }

    public enum SettlementKind {
        RECEIPT(
            "receipt", "ar_receipt", "ar_receipt_fund_line", "ar_receipt_allocation", "receipt_id",
            "ar_receivable", "receivable_id", "customer_id", "received_amount", "md_customer",
            "arReceipt", "收款单", "客户", "应收单",
            "CREATE_RECEIPT_DRAFT", "UPDATE_RECEIPT_DRAFT", "AUDIT_RECEIPT", "REVERSE_RECEIPT",
            "DELETE_RECEIPT_DRAFT"
        ),
        PAYMENT(
            "payment", "ap_payment", "ap_payment_fund_line", "ap_payment_allocation", "payment_id",
            "ap_payable", "payable_id", "supplier_id", "paid_amount", "md_supplier",
            "apPayment", "付款单", "供应商", "应付单",
            "CREATE_PAYMENT_DRAFT", "UPDATE_PAYMENT_DRAFT", "AUDIT_PAYMENT", "REVERSE_PAYMENT",
            "DELETE_PAYMENT_DRAFT"
        );

        private final String apiName;
        private final String headerTable;
        private final String fundTable;
        private final String allocationTable;
        private final String ownerColumn;
        private final String sourceTable;
        private final String sourceIdColumn;
        private final String sourcePartyColumn;
        private final String settledColumn;
        private final String partyTable;
        private final String numberingType;
        private final String label;
        private final String partyLabel;
        private final String sourceLabel;
        private final String createAction;
        private final String updateAction;
        private final String auditAction;
        private final String reverseAction;
        private final String deleteAction;
        private final String targetType;

        SettlementKind(
            String apiName,
            String headerTable,
            String fundTable,
            String allocationTable,
            String ownerColumn,
            String sourceTable,
            String sourceIdColumn,
            String sourcePartyColumn,
            String settledColumn,
            String partyTable,
            String numberingType,
            String label,
            String partyLabel,
            String sourceLabel,
            String createAction,
            String updateAction,
            String auditAction,
            String reverseAction,
            String deleteAction
        ) {
            this.apiName = apiName;
            this.headerTable = headerTable;
            this.fundTable = fundTable;
            this.allocationTable = allocationTable;
            this.ownerColumn = ownerColumn;
            this.sourceTable = sourceTable;
            this.sourceIdColumn = sourceIdColumn;
            this.sourcePartyColumn = sourcePartyColumn;
            this.settledColumn = settledColumn;
            this.partyTable = partyTable;
            this.numberingType = numberingType;
            this.label = label;
            this.partyLabel = partyLabel;
            this.sourceLabel = sourceLabel;
            this.createAction = createAction;
            this.updateAction = updateAction;
            this.auditAction = auditAction;
            this.reverseAction = reverseAction;
            this.deleteAction = deleteAction;
            this.targetType = headerTable;
        }
    }

    public record SettlementDraftRequest(
        String billNo,
        JsonNode version,
        String partyId,
        String billDate,
        String currency,
        BigDecimal amount,
        String remark,
        List<FundLineRequest> fundLines,
        List<AllocationRequest> allocations
    ) {
    }

    public record FundLineRequest(
        Integer lineNo,
        String accountId,
        String paymentMethod,
        BigDecimal amount,
        BigDecimal fee,
        String transactionNo,
        String remark
    ) {
    }

    public record AllocationRequest(
        Integer lineNo,
        String sourceId,
        BigDecimal settlementAmount,
        String remark
    ) {
    }

    private record NormalizedDraft(
        UUID partyId,
        LocalDate billDate,
        String currency,
        BigDecimal amount,
        String remark,
        List<NormalizedFundLine> fundLines,
        List<NormalizedAllocation> allocations
    ) {
    }

    private record NormalizedFundLine(
        int lineNo,
        UUID accountId,
        String paymentMethod,
        BigDecimal amount,
        BigDecimal fee,
        String transactionNo,
        String remark
    ) {
    }

    private record NormalizedAllocation(
        int lineNo,
        UUID sourceId,
        BigDecimal sourceAmount,
        BigDecimal settledBefore,
        BigDecimal unsettledBefore,
        BigDecimal settlementAmount,
        String remark
    ) {
    }

    private record StoredFundLine(
        int lineNo,
        UUID accountId,
        String paymentMethod,
        BigDecimal amount,
        BigDecimal fee
    ) {
    }

    private record StoredAllocation(
        int lineNo,
        UUID sourceId,
        BigDecimal sourceAmount,
        BigDecimal settledBefore,
        BigDecimal unsettledBefore,
        BigDecimal settlementAmount
    ) {
    }

    private record SourceState(
        UUID id,
        String billNo,
        UUID partyId,
        String billDate,
        String currency,
        BigDecimal amount,
        BigDecimal settledAmount,
        BigDecimal unsettledAmount,
        String status
    ) {
    }

    private record AccountState(
        UUID id,
        String code,
        String name,
        String accountType,
        String currency,
        String auditStatus,
        boolean enabled
    ) {
    }
}
