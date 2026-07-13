package com.jdy.erp.finance.application;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verifyNoInteractions;
import static org.mockito.Mockito.when;

import java.math.BigDecimal;
import java.time.LocalDate;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;
import java.util.concurrent.atomic.AtomicReference;

import com.fasterxml.jackson.databind.node.DecimalNode;
import com.fasterxml.jackson.databind.node.LongNode;
import com.fasterxml.jackson.databind.node.TextNode;
import com.jdy.erp.finance.application.FinanceSettlementAppService.AllocationRequest;
import com.jdy.erp.finance.application.FinanceSettlementAppService.FundLineRequest;
import com.jdy.erp.finance.application.FinanceSettlementAppService.SettlementDraftRequest;
import com.jdy.erp.finance.application.FinanceSettlementAppService.SettlementKind;
import com.jdy.erp.purchase.application.PurchaseInAppService;
import com.jdy.erp.purchase.application.PurchaseReturnAppService;
import com.jdy.erp.purchase.application.PurchaseReturnAppService.PurchaseReturnDraftRequest;
import com.jdy.erp.purchase.application.PurchaseReturnAppService.PurchaseReturnLineRequest;
import com.jdy.erp.shared.api.BillLifecycleController;
import com.jdy.erp.shared.api.BillLifecycleController.ReasonRequest;
import com.jdy.erp.shared.application.BillLifecycleService;
import com.jdy.erp.shared.application.BillLifecycleService.VoidRequest;
import com.jdy.erp.shared.application.OperationLogFailureService;
import com.jdy.erp.shared.application.OperationLogService;
import com.jdy.erp.shared.application.FinancePosting;
import com.jdy.erp.shared.application.PostingContext;
import com.jdy.erp.shared.application.PostingPipeline;
import com.jdy.erp.system.security.CurrentSessionService;
import com.jdy.erp.system.tenant.TenantContext;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.mock.web.MockHttpServletRequest;
import org.springframework.test.context.bean.override.mockito.MockitoBean;
import org.springframework.transaction.annotation.Propagation;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;
import org.springframework.web.context.request.RequestContextHolder;
import org.springframework.web.context.request.ServletRequestAttributes;
import org.springframework.web.server.ResponseStatusException;

@SpringBootTest
@Transactional
class FinanceSettlementAppServiceIntegrationTest {
    @Autowired
    private JdbcTemplate jdbcTemplate;

    @Autowired
    private FinanceSettlementAppService settlementService;

    @Autowired
    private FinancePostingService financePostingService;

    @Autowired
    private PurchaseInAppService purchaseInService;

    @Autowired
    private PurchaseReturnAppService purchaseReturnService;

    @Autowired
    @Qualifier("transactionManager")
    private PlatformTransactionManager transactionManager;

    @MockitoBean
    private CurrentSessionService currentSessionService;

    @MockitoBean
    private PostingPipeline postingPipeline;

    private Map<String, Object> tenantAccountSet;

    @BeforeEach
    void bindTenantAndActor() {
        var adminId = jdbcTemplate.queryForObject(
            "SELECT id::text FROM sys_user WHERE username = 'admin'",
            String.class
        );
        var accountSet = jdbcTemplate.queryForMap("""
            SELECT id::text AS id,
                   code,
                   name,
                   COALESCE(database_name, '') AS "databaseName",
                   COALESCE(schema_name, '') AS "schemaName",
                   COALESCE(redis_key_prefix, '') AS "redisKeyPrefix",
                   COALESCE(attachment_prefix, '') AS "attachmentPrefix"
            FROM sys_account_set
            WHERE code = 'BLD-TEST'
            """);
        tenantAccountSet = accountSet;
        when(currentSessionService.currentUserId()).thenReturn(adminId);
        when(currentSessionService.currentUsername()).thenReturn("admin");
        when(currentSessionService.currentRoleCode()).thenReturn("ADMIN");
        when(currentSessionService.currentAccountSetId()).thenReturn(String.valueOf(accountSet.get("id")));

        var request = new MockHttpServletRequest();
        request.getSession(true).setAttribute(CurrentSessionService.SESSION_USERNAME, "admin");
        RequestContextHolder.setRequestAttributes(new ServletRequestAttributes(request));
        TenantContext.setTenant(accountSet);
    }

    @AfterEach
    void clearTenantAndActor() {
        TenantContext.clear();
        RequestContextHolder.resetRequestAttributes();
    }

    @Test
    void zeroDraftHasNoArImpactAndVersionMustBeAnIntegralCasToken() {
        var customerId = insertParty("md_customer", "KH-A141-Z-");
        var before = jdbcTemplate.queryForObject("SELECT COUNT(*)::int FROM ar_receipt", Integer.class);
        var created = settlementService.createDraft(
            SettlementKind.RECEIPT,
            request(null, customerId, "CNY", BigDecimal.ZERO, List.of(), List.of(), null)
        );

        assertThat(created)
            .containsEntry("status", "DRAFT")
            .containsEntry("amount", "0.00");
        assertThat(created.get("version")).isEqualTo("0");
        assertThat(jdbcTemplate.queryForObject("SELECT COUNT(*)::int FROM ar_receipt", Integer.class))
            .isEqualTo(before + 1);
        assertThatThrownBy(() -> settlementService.audit(
            SettlementKind.RECEIPT,
            String.valueOf(created.get("billNo"))
        )).isInstanceOf(ResponseStatusException.class)
            .hasMessageContaining("审核金额必须大于 0");
        assertThat(jdbcTemplate.queryForObject(
            "SELECT status FROM ar_receipt WHERE bill_no = ?",
            String.class,
            created.get("billNo")
        )).isEqualTo("DRAFT");

        assertThatThrownBy(() -> settlementService.updateDraft(
            SettlementKind.RECEIPT,
            String.valueOf(created.get("billNo")),
            request(
                DecimalNode.valueOf(new BigDecimal("0.0")),
                customerId,
                "CNY",
                BigDecimal.ZERO,
                List.of(),
                List.of(),
                "fractional version"
            )
        )).isInstanceOf(ResponseStatusException.class)
            .hasMessageContaining("64 位整数");
        assertThat(jdbcTemplate.queryForObject(
            "SELECT version FROM ar_receipt WHERE bill_no = ?",
            Long.class,
            created.get("billNo")
        )).isZero();

        var updated = settlementService.updateDraft(
            SettlementKind.RECEIPT,
            String.valueOf(created.get("billNo")),
            request(TextNode.valueOf("0"), customerId, "CNY", BigDecimal.ZERO, List.of(), List.of(), "zero draft")
        );
        assertThat(updated).containsEntry("version", "1").containsEntry("remark", "zero draft");
        assertThatThrownBy(() -> settlementService.updateDraft(
            SettlementKind.RECEIPT,
            String.valueOf(created.get("billNo")),
            request(LongNode.valueOf(0), customerId, "CNY", BigDecimal.ZERO, List.of(), List.of(), "stale")
        )).isInstanceOf(ResponseStatusException.class)
            .hasMessageContaining("版本已变化");

        for (var invalid : List.of("01", "+1", "1.0", "1e3", "9223372036854775808", "92233720368547758080")) {
            assertThatThrownBy(() -> settlementService.updateDraft(
                SettlementKind.RECEIPT,
                String.valueOf(created.get("billNo")),
                request(TextNode.valueOf(invalid), customerId, "CNY", BigDecimal.ZERO, List.of(), List.of(), invalid)
            )).as(invalid)
                .isInstanceOf(ResponseStatusException.class)
                .hasMessageContaining("规范十进制字符串");
        }

        jdbcTemplate.update(
            "UPDATE ar_receipt SET version = 9007199254740993 WHERE bill_no = ?",
            created.get("billNo")
        );
        assertThat(settlementService.detail(SettlementKind.RECEIPT, String.valueOf(created.get("billNo"))))
            .containsEntry("version", "9007199254740993");
        assertThat(settlementService.updateDraft(
            SettlementKind.RECEIPT,
            String.valueOf(created.get("billNo")),
            request(TextNode.valueOf("9007199254740993"), customerId, "CNY", BigDecimal.ZERO, List.of(), List.of(), "wide version")
        )).containsEntry("version", "9007199254740994");
    }

    @Test
    void settlementDetailKeepsNumeric18Scale2AmountsAsExactDecimalStrings() {
        var suffix = suffix();
        var customerId = insertParty("md_customer", "KH-A141-M-" + suffix);
        var accountId = insertAccount("ZH-A141-M-" + suffix, "BANK", "USD");
        var maxAmount = "9999999999999999.99";
        var sourceId = insertSource(
            "ar_receivable", "customer_id", "received_amount",
            "YS-A141-M-" + suffix, customerId, "USD", maxAmount, "0.00", "OPEN"
        );

        var detail = settlementService.createDraft(
            SettlementKind.RECEIPT,
            request(
                null,
                customerId,
                "USD",
                new BigDecimal(maxAmount),
                List.of(fund(accountId, "BANK_TRANSFER", maxAmount, null)),
                List.of(allocation(sourceId, maxAmount)),
                "exact decimal"
            )
        );

        assertThat(detail).containsEntry("amount", maxAmount).containsEntry("version", "0");
        assertThat(detail.get("fundLines")).asList().singleElement().asInstanceOf(org.assertj.core.api.InstanceOfAssertFactories.MAP)
            .containsEntry("amount", maxAmount)
            .containsEntry("fee", "0.00");
        assertThat(detail.get("allocations")).asList().singleElement().asInstanceOf(org.assertj.core.api.InstanceOfAssertFactories.MAP)
            .containsEntry("sourceAmount", maxAmount)
            .containsEntry("settledBefore", "0.00")
            .containsEntry("unsettledBefore", maxAmount)
            .containsEntry("currentSettledAmount", "0.00")
            .containsEntry("currentUnsettledAmount", maxAmount)
            .containsEntry("settlementAmount", maxAmount);
    }

    @Test
    void receiptAuditsMultipleSourcesAndAccountsIdempotentlyThenReversesExactly() {
        var suffix = suffix();
        var customerId = insertParty("md_customer", "KH-A141-R-" + suffix);
        var cashId = insertAccount("ZH-A141-C-" + suffix, "CASH", "CNY");
        var bankId = insertAccount("ZH-A141-B-" + suffix, "BANK", "CNY");
        var sourceOne = insertSource(
            "ar_receivable", "customer_id", "received_amount",
            "YS-A141-1-" + suffix, customerId, "CNY", "100.00", "20.00", "PART_SETTLED"
        );
        var sourceTwo = insertSource(
            "ar_receivable", "customer_id", "received_amount",
            "YS-A141-2-" + suffix, customerId, "CNY", "80.00", "0.00", "OPEN"
        );
        var secretTransaction = "TXN-SECRET-A141-" + suffix;
        var created = settlementService.createDraft(
            SettlementKind.RECEIPT,
            request(
                null,
                customerId,
                "CNY",
                new BigDecimal("100.00"),
                List.of(
                    fund(cashId, "CASH", "40.00", null),
                    fund(bankId, "BANK_TRANSFER", "60.00", secretTransaction)
                ),
                List.of(allocation(sourceOne, "30.00"), allocation(sourceTwo, "70.00")),
                "two sources and accounts"
            )
        );
        var billNo = String.valueOf(created.get("billNo"));
        assertThat(settled("ar_receivable", "received_amount", sourceOne)).isEqualByComparingTo("20.00");
        assertThat(settled("ar_receivable", "received_amount", sourceTwo)).isEqualByComparingTo("0.00");

        var audited = settlementService.audit(SettlementKind.RECEIPT, billNo);
        assertThat(audited).containsEntry("status", "AUDITED").containsEntry("version", "1");
        assertThat(audited.get("fundLines")).asList().hasSize(2);
        assertThat(audited.get("allocations")).asList().hasSize(2);
        assertThat(settled("ar_receivable", "received_amount", sourceOne)).isEqualByComparingTo("50.00");
        assertThat(settled("ar_receivable", "received_amount", sourceTwo)).isEqualByComparingTo("70.00");
        var auditLogs = actionLogCount("AUDIT_RECEIPT", billNo);

        var replay = settlementService.audit(SettlementKind.RECEIPT, billNo);
        assertThat(replay).containsEntry("status", "AUDITED").containsEntry("version", "1");
        assertThat(actionLogCount("AUDIT_RECEIPT", billNo)).isEqualTo(auditLogs);
        assertThat(settled("ar_receivable", "received_amount", sourceOne)).isEqualByComparingTo("50.00");

        var reversed = settlementService.reverse(SettlementKind.RECEIPT, billNo);
        assertThat(reversed).containsEntry("status", "DRAFT").containsEntry("version", "2");
        assertThat(settled("ar_receivable", "received_amount", sourceOne)).isEqualByComparingTo("20.00");
        assertThat(settled("ar_receivable", "received_amount", sourceTwo)).isEqualByComparingTo("0.00");
        assertThat(status("ar_receivable", sourceOne)).isEqualTo("PART_SETTLED");
        assertThat(status("ar_receivable", sourceTwo)).isEqualTo("OPEN");

        var logState = jdbcTemplate.queryForObject("""
            SELECT string_agg(COALESCE(before_state::text, '') || COALESCE(after_state::text, ''), '')
            FROM sys_operation_log
            WHERE target_no = ?
            """, String.class, billNo);
        assertThat(logState).contains("sourceCount").contains("accountCount").contains("CNY");
        assertThat(logState).doesNotContain(secretTransaction).doesNotContain("000000");
    }

    @Test
    void usdPaymentKeepsOriginalCurrencyAndCompetingDraftCannotOverpay() {
        var suffix = suffix();
        var supplierId = insertParty("md_supplier", "GYS-A141-" + suffix);
        var usdAccount = insertAccount("ZH-A141-U-" + suffix, "DEPOSIT", "USD");
        var source = insertSource(
            "ap_payable", "supplier_id", "paid_amount",
            "YF-A141-U-" + suffix, supplierId, "USD", "100.00", "0.00", "OPEN"
        );
        var first = settlementService.createDraft(
            SettlementKind.PAYMENT,
            request(
                null,
                supplierId,
                "USD",
                new BigDecimal("60.00"),
                List.of(fund(usdAccount, "BANK_TRANSFER", "60.00", null)),
                List.of(allocation(source, "60.00")),
                null
            )
        );
        var second = settlementService.createDraft(
            SettlementKind.PAYMENT,
            request(
                null,
                supplierId,
                "USD",
                new BigDecimal("60.00"),
                List.of(fund(usdAccount, "OTHER", "60.00", null)),
                List.of(allocation(source, "60.00")),
                null
            )
        );

        var firstAudited = settlementService.audit(SettlementKind.PAYMENT, String.valueOf(first.get("billNo")));
        assertThat(firstAudited).containsEntry("currency", "USD").containsEntry("status", "AUDITED");
        assertThat(settled("ap_payable", "paid_amount", source)).isEqualByComparingTo("60.00");
        assertThatThrownBy(() -> settlementService.audit(
            SettlementKind.PAYMENT,
            String.valueOf(second.get("billNo"))
        )).isInstanceOf(ResponseStatusException.class)
            .hasMessageContaining("超过实时未核销余额");
        assertThat(settled("ap_payable", "paid_amount", source)).isEqualByComparingTo("60.00");
        assertThat(jdbcTemplate.queryForObject(
            "SELECT status FROM ap_payment WHERE bill_no = ?",
            String.class,
            second.get("billNo")
        )).isEqualTo("DRAFT");
        assertThat(actionLogCount("AUDIT_PAYMENT", String.valueOf(first.get("billNo")))).isEqualTo(1);
        assertThat(actionLogCount("AUDIT_PAYMENT", String.valueOf(second.get("billNo")))).isZero();

        var reversed = settlementService.reverse(SettlementKind.PAYMENT, String.valueOf(first.get("billNo")));
        assertThat(reversed).containsEntry("currency", "USD").containsEntry("status", "DRAFT");
        assertThat(settled("ap_payable", "paid_amount", source)).isEqualByComparingTo("0.00");
    }

    @Test
    void legacyAuditedReceiptCanReverseButNeedsARealAccountBeforeReaudit() {
        var suffix = suffix();
        var customerId = insertParty("md_customer", "KH-A141-L-" + suffix);
        var accountId = insertAccount("ZH-A141-L-" + suffix, "BANK", "CNY");
        var sourceId = insertSource(
            "ar_receivable", "customer_id", "received_amount",
            "YS-A141-L-" + suffix, customerId, "CNY", "100.00", "40.00", "PART_SETTLED"
        );
        var billNo = "SKD-A141-L-" + suffix;
        var receiptId = jdbcTemplate.queryForObject("""
            INSERT INTO ar_receipt (
                bill_no, legacy_receivable_id, party_id, bill_date, currency,
                amount, status, version, legacy_imported, audited_at
            )
            VALUES (?, ?::uuid, ?::uuid, DATE '2026-07-14', 'CNY', 40.00, 'AUDITED', 0, TRUE, now())
            RETURNING id::text
            """, String.class, billNo, sourceId, customerId);
        jdbcTemplate.update("""
            INSERT INTO ar_receipt_allocation (
                receipt_id, line_no, receivable_id, source_amount,
                settled_before, unsettled_before, settlement_amount
            )
            VALUES (?::uuid, 1, ?::uuid, 100.00, 0.00, 100.00, 40.00)
            """, receiptId, sourceId);

        var reversed = settlementService.reverse(SettlementKind.RECEIPT, billNo);
        assertThat(reversed)
            .containsEntry("status", "DRAFT")
            .containsEntry("legacy", true)
            .containsEntry("version", "1");
        assertThat(settled("ar_receivable", "received_amount", sourceId)).isEqualByComparingTo("0.00");
        assertThatThrownBy(() -> settlementService.audit(SettlementKind.RECEIPT, billNo))
            .isInstanceOf(ResponseStatusException.class)
            .hasMessageContaining("必须填写资金行");
        assertThatThrownBy(() -> settlementService.deleteDraft(SettlementKind.RECEIPT, billNo))
            .isInstanceOf(ResponseStatusException.class)
            .hasMessageContaining("不允许物理删除");

        var updated = settlementService.updateDraft(
            SettlementKind.RECEIPT,
            billNo,
            request(
                LongNode.valueOf(1),
                customerId,
                "CNY",
                new BigDecimal("40.00"),
                List.of(fund(accountId, "BANK_TRANSFER", "40.00", null)),
                List.of(allocation(sourceId, "40.00")),
                "legacy with real account"
            )
        );
        assertThat(updated).containsEntry("legacy", true).containsEntry("version", "2");
        var reaudited = settlementService.audit(SettlementKind.RECEIPT, billNo);
        assertThat(reaudited).containsEntry("status", "AUDITED").containsEntry("version", "3");
        assertThat(settled("ar_receivable", "received_amount", sourceId)).isEqualByComparingTo("40.00");
        assertThat(jdbcTemplate.queryForObject("""
            SELECT COUNT(*)::int
            FROM ar_receipt_allocation
            WHERE receipt_id = ?::uuid
              AND receivable_id = ?::uuid
              AND settlement_amount = 40.00
            """, Integer.class, receiptId, sourceId)).isEqualTo(1);
    }

    @Test
    @Transactional(propagation = Propagation.NOT_SUPPORTED)
    void concurrentAuditsSerializeOnTheSourceAndOnlyOneConsumesTheRemainingAmount() throws Exception {
        var suffix = suffix();
        var customerCode = "KH-A141-CX-" + suffix;
        var accountCode = "ZH-A141-CX-" + suffix;
        var sourceNo = "YS-A141-CX-" + suffix;
        String firstBillNo = null;
        String secondBillNo = null;
        var executor = Executors.newFixedThreadPool(2);
        try {
            var customerId = insertPartyExact("md_customer", customerCode);
            var accountId = insertAccount(accountCode, "CASH", "CNY");
            var sourceId = insertSource(
                "ar_receivable", "customer_id", "received_amount",
                sourceNo, customerId, "CNY", "100.00", "0.00", "OPEN"
            );
            var first = settlementService.createDraft(
                SettlementKind.RECEIPT,
                request(
                    null,
                    customerId,
                    "CNY",
                    new BigDecimal("80.00"),
                    List.of(fund(accountId, "CASH", "80.00", null)),
                    List.of(allocation(sourceId, "80.00")),
                    null
                )
            );
            var second = settlementService.createDraft(
                SettlementKind.RECEIPT,
                request(
                    null,
                    customerId,
                    "CNY",
                    new BigDecimal("80.00"),
                    List.of(fund(accountId, "CASH", "80.00", null)),
                    List.of(allocation(sourceId, "80.00")),
                    null
                )
            );
            firstBillNo = String.valueOf(first.get("billNo"));
            secondBillNo = String.valueOf(second.get("billNo"));
            var firstNo = firstBillNo;
            var secondNo = secondBillNo;
            var ready = new CountDownLatch(2);
            var start = new CountDownLatch(1);
            var firstFuture = executor.submit(() -> concurrentAudit(firstNo, ready, start));
            var secondFuture = executor.submit(() -> concurrentAudit(secondNo, ready, start));
            assertThat(ready.await(10, TimeUnit.SECONDS)).isTrue();
            start.countDown();

            assertThat(List.of(firstFuture.get(15, TimeUnit.SECONDS), secondFuture.get(15, TimeUnit.SECONDS)))
                .containsExactlyInAnyOrder("AUDITED", "CONFLICT");
            assertThat(settled("ar_receivable", "received_amount", sourceId)).isEqualByComparingTo("80.00");
            assertThat(jdbcTemplate.queryForList("""
                SELECT status
                FROM ar_receipt
                WHERE bill_no IN (?, ?)
                ORDER BY status
                """, String.class, firstBillNo, secondBillNo))
                .containsExactly("AUDITED", "DRAFT");
            assertThat(jdbcTemplate.queryForObject("""
                SELECT COUNT(*)::int
                FROM sys_operation_log
                WHERE action_code = 'AUDIT_RECEIPT'
                  AND target_no IN (?, ?)
                """, Integer.class, firstBillNo, secondBillNo)).isEqualTo(1);
        } finally {
            executor.shutdownNow();
            cleanupConcurrentFixture(firstBillNo, secondBillNo, sourceNo, accountCode, customerCode);
        }
    }

    @Test
    @Transactional(propagation = Propagation.NOT_SUPPORTED)
    void purchaseReturnDraftAndSourceReverseSerializeOnThePurchaseInHeader() throws Exception {
        var suffix = suffix();
        var purchaseInNo = "CGRK-A141-LOCK-" + suffix;
        var purchaseReturnNo = "CGTH-A141-LOCK-" + suffix;
        var executor = Executors.newSingleThreadExecutor();
        var reverseFuture = new AtomicReference<Future<String>>();
        try {
            preparePurchaseReturnConcurrencyFixture(purchaseInNo, purchaseReturnNo);
            var transaction = new TransactionTemplate(transactionManager);
            transaction.executeWithoutResult(status -> {
                purchaseReturnService.saveDraft(new PurchaseReturnDraftRequest(
                    purchaseReturnNo,
                    "GYS-001",
                    "2026-07-14",
                    "A141采购部",
                    "A141管理员",
                    "A141 source reverse concurrency",
                    List.of(new PurchaseReturnLineRequest(
                        null,
                        "CP-001",
                        "CK-001",
                        purchaseInNo,
                        1,
                        BigDecimal.ONE,
                        new BigDecimal("10.00"),
                        new BigDecimal("13.00"),
                        "A141 concurrent return"
                    ))
                ));
                var started = new CountDownLatch(1);
                reverseFuture.set(executor.submit(() -> reversePurchaseInConcurrently(purchaseInNo, started)));
                try {
                    assertThat(started.await(5, TimeUnit.SECONDS)).isTrue();
                    assertThatThrownBy(() -> reverseFuture.get().get(500, TimeUnit.MILLISECONDS))
                        .isInstanceOf(TimeoutException.class);
                } catch (InterruptedException interrupted) {
                    Thread.currentThread().interrupt();
                    throw new AssertionError(interrupted);
                }
            });

            assertThat(reverseFuture.get().get(10, TimeUnit.SECONDS)).isEqualTo("CONFLICT");
            assertThat(jdbcTemplate.queryForObject(
                "SELECT status FROM purchase_in WHERE bill_no = ?",
                String.class,
                purchaseInNo
            )).isEqualTo("AUDITED");
            assertThat(jdbcTemplate.queryForObject("""
                SELECT COUNT(*)::int
                FROM purchase_return_line line
                JOIN purchase_return header ON header.id = line.bill_id
                WHERE header.bill_no = ?
                  AND header.status = 'DRAFT'
                  AND line.source_in_no = ?
                """, Integer.class, purchaseReturnNo, purchaseInNo)).isEqualTo(1);
        } finally {
            executor.shutdownNow();
            cleanupPurchaseReturnConcurrencyFixture(purchaseInNo, purchaseReturnNo);
        }
    }

    @Test
    void genericLifecycleRejectsReceiptAndPaymentBeforeAnyBusinessSql() {
        var lifecycleJdbc = mock(JdbcTemplate.class);
        var lifecycle = new BillLifecycleService(
            lifecycleJdbc,
            mock(OperationLogService.class),
            mock(OperationLogFailureService.class),
            mock(CurrentSessionService.class)
        );
        var controller = new BillLifecycleController(lifecycle);

        assertThatThrownBy(() -> controller.close(
            "receipt",
            "SKD-A141-GENERIC",
            new ReasonRequest("must use finance lifecycle")
        )).isInstanceOf(ResponseStatusException.class)
            .hasMessageContaining("不支持关闭");
        assertThatThrownBy(() -> controller.voidBill(
            "payment",
            "FKD-A141-GENERIC",
            new VoidRequest("must use finance lifecycle", "admin", "admin123")
        )).isInstanceOf(ResponseStatusException.class)
            .hasMessageContaining("不支持作废");
        verifyNoInteractions(lifecycleJdbc);
    }

    @Test
    void repeatedFinancePostingPreservesSettlementStateAndRejectsSettledFactMutation() {
        var customerId = insertParty("md_customer", "KH-A141-REPOST-");
        var supplierId = insertParty("md_supplier", "GYS-A141-REPOST-");
        var salesOutNo = "XSCK-A141-REPOST-" + suffix();
        var purchaseInNo = "CGRK-A141-REPOST-" + suffix();
        var receivableNo = "YS-" + salesOutNo;
        var payableNo = "YF-" + purchaseInNo;
        var receivableContext = financeContext("SALES_OUT", salesOutNo, customerId, "100.00", "USD");
        var payableContext = financeContext("PURCHASE_IN", purchaseInNo, supplierId, "80.00", "USD");

        financePostingService.post(receivableContext);
        financePostingService.post(payableContext);
        jdbcTemplate.update(
            "UPDATE ar_receivable SET received_amount = 40.00, status = 'OPEN' WHERE bill_no = ?",
            receivableNo
        );
        jdbcTemplate.update(
            "UPDATE ap_payable SET paid_amount = 30.00, status = 'OPEN' WHERE bill_no = ?",
            payableNo
        );

        financePostingService.post(receivableContext);
        financePostingService.post(payableContext);
        assertThat(financeFact("ar_receivable", "received_amount", receivableNo))
            .containsEntry("amount", new BigDecimal("100.00"))
            .containsEntry("settledAmount", new BigDecimal("40.00"))
            .containsEntry("currency", "USD")
            .containsEntry("status", "PART_SETTLED");
        assertThat(financeFact("ap_payable", "paid_amount", payableNo))
            .containsEntry("amount", new BigDecimal("80.00"))
            .containsEntry("settledAmount", new BigDecimal("30.00"))
            .containsEntry("currency", "USD")
            .containsEntry("status", "PART_SETTLED");

        jdbcTemplate.update(
            "UPDATE ar_receivable SET received_amount = amount, status = 'OPEN' WHERE bill_no = ?",
            receivableNo
        );
        financePostingService.post(receivableContext);
        assertThat(financeFact("ar_receivable", "received_amount", receivableNo))
            .containsEntry("settledAmount", new BigDecimal("100.00"))
            .containsEntry("status", "SETTLED");

        assertThatThrownBy(() -> financePostingService.post(
            financeContext("SALES_OUT", salesOutNo, customerId, "90.00", "USD")
        )).isInstanceOf(ResponseStatusException.class)
            .hasMessageContaining("已发生核销");
        assertThatThrownBy(() -> financePostingService.post(
            financeContext("PURCHASE_IN", purchaseInNo, supplierId, "70.00", "CNY")
        )).isInstanceOf(ResponseStatusException.class)
            .hasMessageContaining("已发生核销");
        assertThat(financeFact("ar_receivable", "received_amount", receivableNo))
            .containsEntry("amount", new BigDecimal("100.00"))
            .containsEntry("settledAmount", new BigDecimal("100.00"))
            .containsEntry("currency", "USD")
            .containsEntry("status", "SETTLED");
        assertThat(financeFact("ap_payable", "paid_amount", payableNo))
            .containsEntry("amount", new BigDecimal("80.00"))
            .containsEntry("settledAmount", new BigDecimal("30.00"))
            .containsEntry("currency", "USD")
            .containsEntry("status", "PART_SETTLED");
    }

    private SettlementDraftRequest request(
        com.fasterxml.jackson.databind.JsonNode version,
        String partyId,
        String currency,
        BigDecimal amount,
        List<FundLineRequest> funds,
        List<AllocationRequest> allocations,
        String remark
    ) {
        return new SettlementDraftRequest(
            null,
            version,
            partyId,
            "2026-07-14",
            currency,
            amount,
            remark,
            funds,
            allocations
        );
    }

    private FundLineRequest fund(String accountId, String method, String amount, String transactionNo) {
        return new FundLineRequest(
            null,
            accountId,
            method,
            new BigDecimal(amount),
            BigDecimal.ZERO,
            transactionNo,
            null
        );
    }

    private AllocationRequest allocation(String sourceId, String amount) {
        return new AllocationRequest(null, sourceId, new BigDecimal(amount), null);
    }

    private PostingContext financeContext(
        String txnType,
        String sourceBillNo,
        String partyId,
        String amount,
        String currency
    ) {
        return new PostingContext(
            FinancePosting.CHANNEL,
            null,
            null,
            null,
            txnType,
            txnType + ":" + sourceBillNo,
            sourceBillNo,
            partyId,
            LocalDate.of(2026, 7, 14),
            new BigDecimal(amount),
            currency
        );
    }

    private String concurrentAudit(String billNo, CountDownLatch ready, CountDownLatch start) throws Exception {
        var request = new MockHttpServletRequest();
        request.getSession(true).setAttribute(CurrentSessionService.SESSION_USERNAME, "admin");
        RequestContextHolder.setRequestAttributes(new ServletRequestAttributes(request));
        TenantContext.setTenant(tenantAccountSet);
        try {
            ready.countDown();
            if (!start.await(10, TimeUnit.SECONDS)) {
                throw new IllegalStateException("concurrent audit start timed out");
            }
            settlementService.audit(SettlementKind.RECEIPT, billNo);
            return "AUDITED";
        } catch (ResponseStatusException exception) {
            if (exception.getStatusCode().value() == 409) {
                return "CONFLICT";
            }
            throw exception;
        } finally {
            TenantContext.clear();
            RequestContextHolder.resetRequestAttributes();
        }
    }

    private String reversePurchaseInConcurrently(String billNo, CountDownLatch started) {
        var request = new MockHttpServletRequest();
        request.getSession(true).setAttribute(CurrentSessionService.SESSION_USERNAME, "admin");
        RequestContextHolder.setRequestAttributes(new ServletRequestAttributes(request));
        TenantContext.setTenant(tenantAccountSet);
        try {
            started.countDown();
            purchaseInService.reverse(billNo);
            return "REVERSED";
        } catch (ResponseStatusException exception) {
            if (exception.getStatusCode().value() == 409) {
                return "CONFLICT";
            }
            throw exception;
        } finally {
            TenantContext.clear();
            RequestContextHolder.resetRequestAttributes();
        }
    }

    private void preparePurchaseReturnConcurrencyFixture(String purchaseInNo, String purchaseReturnNo) {
        var supplierId = jdbcTemplate.queryForObject(
            "SELECT id::text FROM md_supplier WHERE code = 'GYS-001'",
            String.class
        );
        var product = jdbcTemplate.queryForMap("""
            SELECT id::text AS id, code, name, COALESCE(spec, '') AS spec
            FROM md_product
            WHERE code = 'CP-001'
            """);
        var warehouseId = jdbcTemplate.queryForObject(
            "SELECT id::text FROM md_warehouse WHERE code = 'CK-001'",
            String.class
        );
        var purchaseInId = jdbcTemplate.queryForObject("""
            INSERT INTO purchase_in (
                bill_no, supplier_id, bill_date, department, status,
                total_amount, currency, owner_name
            )
            VALUES (?, ?::uuid, DATE '2026-07-14', 'A141采购部', 'AUDITED', 11.30, 'CNY', 'A141管理员')
            RETURNING id::text
            """, String.class, purchaseInNo, supplierId);
        jdbcTemplate.update("""
            INSERT INTO purchase_in_line (
                bill_id, line_no, product_id, product_code_snapshot,
                product_name_snapshot, product_spec_snapshot, warehouse_id,
                qty, unit_price, amount, tax_rate, tax_amount, price_tax_total, line_remark
            )
            VALUES (?::uuid, 1, ?::uuid, ?, ?, ?, ?::uuid, 1, 10.00, 10.00, 13.00, 1.30, 11.30, 'A141 concurrency source')
            """,
            purchaseInId,
            product.get("id"),
            product.get("code"),
            product.get("name"),
            product.get("spec"),
            warehouseId
        );
        jdbcTemplate.update("""
            INSERT INTO purchase_return (
                bill_no, supplier_id, bill_date, department, status,
                total_amount, owner_name, remark
            )
            VALUES (?, ?::uuid, DATE '2026-07-14', 'A141采购部', 'DRAFT', 0, 'A141管理员', 'A141 concurrency holder')
            """, purchaseReturnNo, supplierId);
    }

    private void cleanupPurchaseReturnConcurrencyFixture(String purchaseInNo, String purchaseReturnNo) {
        jdbcTemplate.update("DELETE FROM sys_operation_log WHERE target_no IN (?, ?)", purchaseInNo, purchaseReturnNo);
        jdbcTemplate.update("DELETE FROM purchase_return_line WHERE bill_id IN (SELECT id FROM purchase_return WHERE bill_no = ?)", purchaseReturnNo);
        jdbcTemplate.update("DELETE FROM purchase_return WHERE bill_no = ?", purchaseReturnNo);
        jdbcTemplate.update("DELETE FROM ap_payable WHERE source_bill_no = ?", purchaseInNo);
        jdbcTemplate.update("DELETE FROM purchase_in_line WHERE bill_id IN (SELECT id FROM purchase_in WHERE bill_no = ?)", purchaseInNo);
        jdbcTemplate.update("DELETE FROM purchase_in WHERE bill_no = ?", purchaseInNo);
    }

    private void cleanupConcurrentFixture(
        String firstBillNo,
        String secondBillNo,
        String sourceNo,
        String accountCode,
        String customerCode
    ) {
        if (firstBillNo != null && secondBillNo != null) {
            jdbcTemplate.update("DELETE FROM sys_operation_log WHERE target_no IN (?, ?)", firstBillNo, secondBillNo);
            jdbcTemplate.update("DELETE FROM ar_receipt WHERE bill_no IN (?, ?)", firstBillNo, secondBillNo);
        }
        jdbcTemplate.update("DELETE FROM ar_receivable WHERE bill_no = ?", sourceNo);
        jdbcTemplate.update("DELETE FROM md_financial_account WHERE code = ?", accountCode);
        jdbcTemplate.update("DELETE FROM md_customer WHERE code = ?", customerCode);
    }

    private String insertParty(String table, String codePrefix) {
        var code = codePrefix + suffix();
        return insertPartyExact(table, code);
    }

    private String insertPartyExact(String table, String code) {
        return jdbcTemplate.queryForObject(
            "INSERT INTO " + table + " (code, name, enabled) VALUES (?, ?, TRUE) RETURNING id::text",
            String.class,
            code,
            code
        );
    }

    private String insertAccount(String code, String type, String currency) {
        var bank = "CASH".equals(type) ? null : "A141 测试银行";
        var accountNo = "CASH".equals(type) ? null : "000000" + suffix();
        var holder = "CASH".equals(type) ? null : "A141 测试户名";
        return jdbcTemplate.queryForObject("""
            INSERT INTO md_financial_account (
                code, name, account_type, bank_name, account_no, account_holder,
                currency, enabled, audit_status
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, TRUE, 'AUDITED')
            RETURNING id::text
            """, String.class, code, code, type, bank, accountNo, holder, currency);
    }

    private String insertSource(
        String table,
        String partyColumn,
        String settledColumn,
        String billNo,
        String partyId,
        String currency,
        String amount,
        String settled,
        String status
    ) {
        return jdbcTemplate.queryForObject("""
            INSERT INTO %s (
                bill_no, %s, bill_date, currency, amount, %s, status
            )
            VALUES (?, ?::uuid, DATE '2026-07-14', ?, ?, ?, ?)
            RETURNING id::text
            """.formatted(table, partyColumn, settledColumn),
            String.class,
            billNo,
            partyId,
            currency,
            new BigDecimal(amount),
            new BigDecimal(settled),
            status
        );
    }

    private BigDecimal settled(String table, String settledColumn, String id) {
        return jdbcTemplate.queryForObject(
            "SELECT " + settledColumn + " FROM " + table + " WHERE id = ?::uuid",
            BigDecimal.class,
            id
        );
    }

    private Map<String, Object> financeFact(String table, String settledColumn, String billNo) {
        return jdbcTemplate.queryForMap("""
            SELECT amount,
                   %s AS "settledAmount",
                   currency,
                   status
            FROM %s
            WHERE bill_no = ?
            """.formatted(settledColumn, table), billNo);
    }

    private String status(String table, String id) {
        return jdbcTemplate.queryForObject(
            "SELECT status FROM " + table + " WHERE id = ?::uuid",
            String.class,
            id
        );
    }

    private int actionLogCount(String action, String billNo) {
        var count = jdbcTemplate.queryForObject("""
            SELECT COUNT(*)::int
            FROM sys_operation_log
            WHERE action_code = ?
              AND target_no = ?
            """, Integer.class, action, billNo);
        return count == null ? 0 : count;
    }

    private String suffix() {
        return Long.toUnsignedString(System.nanoTime(), 36).toUpperCase();
    }
}
