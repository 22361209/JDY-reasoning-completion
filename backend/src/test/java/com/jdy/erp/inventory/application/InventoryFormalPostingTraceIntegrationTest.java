package com.jdy.erp.inventory.application;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.Mockito.when;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import java.math.BigDecimal;
import java.sql.Connection;
import java.time.LocalDate;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.function.Supplier;

import javax.sql.DataSource;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.jdy.erp.inventory.application.InventoryPostingCommand.PostingAction;
import com.jdy.erp.sales.application.DeliveryNoticeAppService;
import com.jdy.erp.system.security.CurrentSessionService;
import com.jdy.erp.system.tenant.TenantContext;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.mock.web.MockHttpServletRequest;
import org.springframework.mock.web.MockHttpSession;
import org.springframework.test.context.bean.override.mockito.MockitoBean;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;
import org.springframework.web.context.request.RequestContextHolder;
import org.springframework.web.context.request.ServletRequestAttributes;
import org.springframework.web.server.ResponseStatusException;

@SpringBootTest
@AutoConfigureMockMvc
class InventoryFormalPostingTraceIntegrationTest {
    private static final LocalDate BUSINESS_DATE = LocalDate.of(2026, 7, 14);

    @Autowired
    private JdbcTemplate jdbcTemplate;

    @Autowired
    private OtherStockInAppService otherStockInAppService;

    @Autowired
    private OtherStockOutAppService otherStockOutAppService;

    @Autowired
    private StockCountGainAppService stockCountGainAppService;

    @Autowired
    private StockCountLossAppService stockCountLossAppService;

    @Autowired
    private StockTransferAppService stockTransferAppService;

    @Autowired
    private OpeningStockService openingStockService;

    @Autowired
    private InventoryPostingService inventoryPostingService;

    @Autowired
    private DeliveryNoticeAppService deliveryNoticeAppService;

    @Autowired
    private DataSource dataSource;

    @Autowired
    private PlatformTransactionManager transactionManager;

    @Autowired
    private MockMvc mockMvc;

    @Autowired
    private ObjectMapper objectMapper;

    @MockitoBean
    private CurrentSessionService currentSessionService;

    private Map<String, Object> accountSet;
    private String accountSetId;
    private String productId;
    private String productCode;
    private String sourceWarehouseId;
    private String sourceWarehouseCode;
    private String targetWarehouseId;
    private String targetWarehouseCode;
    private String customerId;
    private String customerCode;
    private String runPrefix;

    @BeforeEach
    void setUp() {
        accountSet = jdbcTemplate.queryForMap("""
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
        accountSetId = String.valueOf(accountSet.get("id"));
        when(currentSessionService.isAuthenticated()).thenReturn(true);
        when(currentSessionService.currentAccountSet()).thenReturn(accountSet);
        when(currentSessionService.currentAccountSetId()).thenReturn(accountSetId);
        when(currentSessionService.currentRoleCode()).thenReturn("ADMIN");
        when(currentSessionService.currentUserId()).thenReturn(jdbcTemplate.queryForObject(
            "SELECT id::text FROM public.sys_user WHERE username = 'admin'",
            String.class
        ));
        when(currentSessionService.currentDisplayName()).thenReturn("A147 验收员");
        bindTenant();
        createFixture();
    }

    @AfterEach
    void tearDown() {
        try {
            cleanFixture();
        } finally {
            TenantContext.clear();
            RequestContextHolder.resetRequestAttributes();
        }
    }

    @Test
    void formalInventoryDocumentsPersistExactSourceFieldsAndReversalLinks() {
        var otherIn = insertWarehouseDocument("other_stock_in", "other_stock_in_line", "QTRK-IN", new BigDecimal("10"));
        otherStockInAppService.audit(otherIn.billNo());
        otherStockInAppService.reverse(otherIn.billNo());
        assertReversibleTrace(otherIn, "OTHER_STOCK_IN", "OTHER_STOCK_IN_REVERSE", sourceWarehouseId, "10", "-10");

        var otherOut = insertWarehouseDocument("other_stock_out", "other_stock_out_line", "QTRK-OUT", new BigDecimal("5"));
        otherStockOutAppService.audit(otherOut.billNo());
        otherStockOutAppService.reverse(otherOut.billNo());
        assertReversibleTrace(otherOut, "OTHER_STOCK_OUT", "OTHER_STOCK_OUT_REVERSE", sourceWarehouseId, "-5", "5");

        var countGain = insertWarehouseDocument("stock_count_gain", "stock_count_gain_line", "QTRK-GAIN", new BigDecimal("3"));
        stockCountGainAppService.audit(countGain.billNo());
        stockCountGainAppService.reverse(countGain.billNo());
        assertReversibleTrace(countGain, "STOCK_COUNT_GAIN", "STOCK_COUNT_GAIN_REVERSE", sourceWarehouseId, "3", "-3");

        var countLoss = insertWarehouseDocument("stock_count_loss", "stock_count_loss_line", "QTRK-LOSS", new BigDecimal("2"));
        stockCountLossAppService.audit(countLoss.billNo());
        stockCountLossAppService.reverse(countLoss.billNo());
        assertReversibleTrace(countLoss, "STOCK_COUNT_LOSS", "STOCK_COUNT_LOSS_REVERSE", sourceWarehouseId, "-2", "2");

        var transfer = insertTransferDocument(new BigDecimal("4"));
        stockTransferAppService.audit(transfer.billNo());
        stockTransferAppService.reverse(transfer.billNo());
        assertReversibleTrace(transfer, "STOCK_TRANSFER_OUT", "STOCK_TRANSFER_OUT_REVERSE", sourceWarehouseId, "-4", "4");
        assertReversibleTrace(transfer, "STOCK_TRANSFER_IN", "STOCK_TRANSFER_IN_REVERSE", targetWarehouseId, "4", "-4");

        assertBalanceAndLedger(sourceWarehouseId, "100");
        assertBalanceAndLedger(targetWarehouseId, "0");
    }

    @Test
    void concurrentAbsoluteOpeningSavesSerializeBalanceAndLedger() throws Exception {
        var start = new CountDownLatch(1);
        var executor = Executors.newFixedThreadPool(2);
        try {
            var first = executor.submit(() -> saveOpeningAfter(start, "120"));
            var second = executor.submit(() -> saveOpeningAfter(start, "140"));
            start.countDown();
            assertThat(first.get(10, TimeUnit.SECONDS)).isInstanceOf(Map.class);
            assertThat(second.get(10, TimeUnit.SECONDS)).isInstanceOf(Map.class);
        } finally {
            executor.shutdownNow();
        }

        var balance = jdbcTemplate.queryForObject("""
            SELECT qty_on_hand
            FROM inv_stock_balance
            WHERE account_set_id = ?::uuid
              AND product_id = ?::uuid
              AND warehouse_id = ?::uuid
            """, BigDecimal.class, accountSetId, productId, sourceWarehouseId);
        assertThat(balance).isIn(new BigDecimal("120.0000"), new BigDecimal("140.0000"));

        var facts = jdbcTemplate.queryForList("""
            SELECT qty_delta AS "qtyDelta",
                   qty_on_hand_after AS "qtyOnHandAfter"
            FROM inv_stock_txn
            WHERE account_set_id = ?::uuid
              AND product_id = ?::uuid
              AND warehouse_id = ?::uuid
            ORDER BY occurred_at, id
            """, accountSetId, productId, sourceWarehouseId);
        assertThat(facts).hasSize(3);
        var cumulative = BigDecimal.ZERO;
        for (var fact : facts) {
            cumulative = cumulative.add((BigDecimal) fact.get("qtyDelta"));
            assertThat((BigDecimal) fact.get("qtyOnHandAfter")).isEqualByComparingTo(cumulative);
        }
        assertThat(cumulative).isEqualByComparingTo(balance);
        assertBalanceAndLedger(sourceWarehouseId, balance.toPlainString());
    }

    @Test
    void postingFactClockFollowsBalanceSerializationNotTransactionStart() throws Exception {
        var firstSourceId = UUID.randomUUID();
        var secondSourceId = UUID.randomUUID();
        var first = InventoryPostingCommand.document(
            productCode, sourceWarehouseCode, new BigDecimal("7"),
            "A147_CLOCK", "A147_CLOCK", firstSourceId, UUID.randomUUID(),
            runPrefix + "-CLOCK-A", BUSINESS_DATE, PostingAction.AUDIT
        );
        var second = InventoryPostingCommand.document(
            productCode, sourceWarehouseCode, new BigDecimal("11"),
            "A147_CLOCK", "A147_CLOCK", secondSourceId, UUID.randomUUID(),
            runPrefix + "-CLOCK-B", BUSINESS_DATE, PostingAction.AUDIT
        );
        var secondLockKey = String.join(
            ":", accountSetId, second.sourceBillType(), second.sourceBillId().toString(),
            second.sourceBillLineId().toString(), second.txnType()
        );

        var executor = Executors.newSingleThreadExecutor();
        try (Connection blocker = dataSource.getConnection()) {
            blocker.setAutoCommit(false);
            try (var statement = blocker.prepareStatement(
                "SELECT pg_advisory_xact_lock(hashtextextended(?, 0))"
            )) {
                statement.setString(1, secondLockKey);
                statement.execute();
            }
            var blockedSecond = executor.submit(() -> postWithTenant(second));
            awaitAdvisoryWaiter();

            inventoryPostingService.post(first);
            blocker.commit();
            assertThat(blockedSecond.get(10, TimeUnit.SECONDS)).isInstanceOf(Map.class);
        } finally {
            executor.shutdownNow();
        }

        var facts = jdbcTemplate.queryForList("""
            SELECT source_bill_id::text AS "sourceBillId",
                   qty_delta AS "qtyDelta",
                   qty_on_hand_after AS "qtyOnHandAfter"
            FROM inv_stock_txn
            WHERE source_bill_type = 'A147_CLOCK'
              AND source_bill_id IN (?::uuid, ?::uuid)
            ORDER BY occurred_at, id
            """, firstSourceId, secondSourceId);
        assertThat(facts).extracting(row -> row.get("sourceBillId"))
            .containsExactly(firstSourceId.toString(), secondSourceId.toString());
        assertThat((BigDecimal) facts.get(0).get("qtyOnHandAfter")).isEqualByComparingTo("107");
        assertThat((BigDecimal) facts.get(1).get("qtyOnHandAfter")).isEqualByComparingTo("118");
        assertBalanceAndLedger(sourceWarehouseId, "118");
    }

    @Test
    void openingPreservesReservationsUsesShanghaiFactDateAndRejectsBelowReserved() {
        jdbcTemplate.update("""
            UPDATE inv_stock_balance
            SET qty_reserved = 30, qty_available = 70
            WHERE account_set_id = ?::uuid
              AND product_id = ?::uuid
              AND warehouse_id = ?::uuid
            """, accountSetId, productId, sourceWarehouseId);

        new TransactionTemplate(transactionManager).executeWithoutResult(status -> {
            jdbcTemplate.execute("SET LOCAL TIME ZONE 'America/Los_Angeles'");
            openingStockService.saveRows(List.of(openingLine("120")));
        });
        assertThat(stockTriple()).containsEntry("onHand", new BigDecimal("120.0000"))
            .containsEntry("reserved", new BigDecimal("30.0000"))
            .containsEntry("available", new BigDecimal("90.0000"));
        assertThat(jdbcTemplate.queryForObject("""
            SELECT source_bill_date = (occurred_at AT TIME ZONE 'Asia/Shanghai')::date
            FROM inv_stock_txn
            WHERE product_id = ?::uuid
              AND warehouse_id = ?::uuid
              AND txn_type = 'OPENING_STOCK'
            ORDER BY occurred_at DESC, id DESC
            LIMIT 1
            """, Boolean.class, productId, sourceWarehouseId)).isTrue();

        inventoryPostingService.shipReserved(InventoryPostingCommand.test(
            productCode,
            sourceWarehouseCode,
            new BigDecimal("5"),
            "A147_RESERVED_SHIP",
            "A147_TEST",
            UUID.randomUUID(),
            UUID.randomUUID(),
            runPrefix + "-RESERVED-SHIP",
            BUSINESS_DATE,
            PostingAction.AUDIT
        ));
        assertThat(stockTriple()).containsEntry("onHand", new BigDecimal("115.0000"))
            .containsEntry("reserved", new BigDecimal("25.0000"))
            .containsEntry("available", new BigDecimal("90.0000"));

        var before = stockAndOpeningSnapshot();
        assertThatThrownBy(() -> openingStockService.saveRows(List.of(openingLine("24"))))
            .isInstanceOf(ResponseStatusException.class)
            .satisfies(error -> assertThat(((ResponseStatusException) error).getStatusCode()).isEqualTo(HttpStatus.CONFLICT))
            .hasMessageContaining("期初数量不能小于已预留数量");
        assertThat(stockAndOpeningSnapshot()).isEqualTo(before);
    }

    @Test
    void reversedDraftLineReplacementDowngradesOldFactsWithoutRetargeting() throws Exception {
        var firstRequest = otherStockInRequest(null, "10");
        var saved = otherStockInAppService.saveDraft(firstRequest);
        var billId = String.valueOf(saved.get("id"));
        var billNo = String.valueOf(saved.get("billNo"));
        var oldLineId = lineId("other_stock_in_line", billId);
        otherStockInAppService.audit(billNo);

        var auditedSnapshot = inventoryDocumentSnapshot("other_stock_in", "other_stock_in_line", billId);
        var failureLogBaseline = endpointFailureLogIds("POST /api/other-stock-ins/draft");
        try {
            var session = new MockHttpSession();
            session.setAttribute(CurrentSessionService.SESSION_USERNAME, "admin");
            mockMvc.perform(post("/api/other-stock-ins/draft")
                    .session(session)
                    .contentType(MediaType.APPLICATION_JSON)
                    .content(objectMapper.writeValueAsBytes(otherStockInRequest(billNo, "12"))))
                .andExpect(status().isConflict());

            bindTenant();
            assertThat(inventoryDocumentSnapshot("other_stock_in", "other_stock_in_line", billId))
                .as("HTTP 409 must preserve header, lines, balance, ledger and successful business logs")
                .isEqualTo(auditedSnapshot);
            var failureLogs = newEndpointFailureLogs("POST /api/other-stock-ins/draft", failureLogBaseline);
            assertThat(failureLogs).singleElement().satisfies(log -> assertThat(log)
                .containsEntry("module", "SECURITY")
                .containsEntry("action", "WRITE_FAILED")
                .containsEntry("targetType", "http_endpoint")
                .containsEntry("targetNo", "POST /api/other-stock-ins/draft")
                .containsEntry("success", false));
            assertThat(failureLogs.getFirst().get("targetId")).isNull();
            assertThat(failureLogs.getFirst().get("beforeState")).isNull();
            assertThat(failureLogs.getFirst().get("afterState")).isNull();
            assertThat(String.valueOf(failureLogs.getFirst().get("reason")))
                .contains("只有草稿")
                .doesNotContain(billNo);
        } finally {
            bindTenant();
            deleteEndpointFailureLogs("POST /api/other-stock-ins/draft", failureLogBaseline);
        }

        otherStockInAppService.reverse(billNo);
        var immutableBeforeReplacement = oldFactBusinessFields(billId);
        assertThat(immutableBeforeReplacement).hasSize(2);
        otherStockInAppService.saveDraft(otherStockInRequest(billNo, "12"));
        var newLineId = lineId("other_stock_in_line", billId);
        assertThat(newLineId).isNotEqualTo(oldLineId);
        assertThat(oldFactBusinessFields(billId)).isEqualTo(immutableBeforeReplacement);
        assertThat(jdbcTemplate.queryForList("""
            SELECT source_bill_line_id::text AS "sourceBillLineId",
                   trace_quality AS "traceQuality"
            FROM inv_stock_txn
            WHERE source_bill_id = ?::uuid
            ORDER BY occurred_at, id
            """, billId))
            .allSatisfy(row -> assertThat(row)
                .containsEntry("sourceBillLineId", null)
                .containsEntry("traceQuality", "HEADER_ONLY"));

        otherStockInAppService.audit(billNo);
        var currentFacts = jdbcTemplate.queryForList("""
            SELECT source_bill_line_id::text AS "sourceBillLineId",
                   trace_quality AS "traceQuality",
                   qty_delta AS "qtyDelta"
            FROM inv_stock_txn
            WHERE source_bill_id = ?::uuid
            ORDER BY occurred_at, id
            """, billId);
        assertThat(currentFacts).hasSize(3);
        assertThat(currentFacts.subList(0, 2)).allSatisfy(row -> assertThat(row)
            .containsEntry("sourceBillLineId", null)
            .containsEntry("traceQuality", "HEADER_ONLY"));
        assertThat(currentFacts.get(2))
            .containsEntry("sourceBillLineId", newLineId)
            .containsEntry("traceQuality", "EXACT");
        assertThat((BigDecimal) currentFacts.get(2).get("qtyDelta")).isEqualByComparingTo("12");
        assertBalanceAndLedger(sourceWarehouseId, "112");
    }

    @Test
    void auditedDeliverySaveIsZeroMutationAndPostingHistoryBlocksPhysicalDelete() {
        var request = deliveryRequest(null, "8");
        var saved = deliveryNoticeAppService.saveDraft(request);
        var billId = String.valueOf(saved.get("id"));
        var billNo = String.valueOf(saved.get("billNo"));
        deliveryNoticeAppService.audit(billNo);

        var audited = deliverySnapshot(billId);
        assertThatThrownBy(() -> deliveryNoticeAppService.saveDraft(deliveryRequest(billNo, "9")))
            .isInstanceOf(ResponseStatusException.class)
            .satisfies(error -> assertThat(((ResponseStatusException) error).getStatusCode()).isEqualTo(HttpStatus.CONFLICT));
        assertThat(deliverySnapshot(billId)).isEqualTo(audited);

        deliveryNoticeAppService.reverse(billNo);
        assertThatThrownBy(() -> deliveryNoticeAppService.delete(billNo))
            .isInstanceOf(ResponseStatusException.class)
            .satisfies(error -> assertThat(((ResponseStatusException) error).getStatusCode()).isEqualTo(HttpStatus.CONFLICT))
            .hasMessageContaining("已有库存过账历史");
        assertThat(jdbcTemplate.queryForObject(
            "SELECT status FROM delivery_notice WHERE id = ?::uuid",
            String.class,
            billId
        )).isEqualTo("DRAFT");
        assertThat(jdbcTemplate.queryForObject(
            "SELECT count(*)::int FROM inv_stock_txn WHERE source_bill_id = ?::uuid",
            Integer.class,
            billId
        )).isEqualTo(2);
    }

    @Test
    void deliveryDeleteVersusAuditNeverLeavesOrphanInventoryHistory() throws Exception {
        var saved = deliveryNoticeAppService.saveDraft(deliveryRequest(null, "6"));
        var billId = String.valueOf(saved.get("id"));
        var billNo = String.valueOf(saved.get("billNo"));
        var start = new CountDownLatch(1);
        var executor = Executors.newFixedThreadPool(2);
        try {
            var audit = executor.submit(() -> deliveryActionAfter(start, () -> deliveryNoticeAppService.audit(billNo)));
            var delete = executor.submit(() -> deliveryActionAfter(start, () -> deliveryNoticeAppService.delete(billNo)));
            start.countDown();
            var outcomes = List.of(audit.get(10, TimeUnit.SECONDS), delete.get(10, TimeUnit.SECONDS));
            assertThat(outcomes.stream().filter(Map.class::isInstance)).hasSize(1);
            assertThat(outcomes.stream().filter(ResponseStatusException.class::isInstance)).singleElement()
                .satisfies(error -> assertThat(((ResponseStatusException) error).getStatusCode()).isEqualTo(HttpStatus.CONFLICT));
        } finally {
            executor.shutdownNow();
        }

        var headerRows = jdbcTemplate.queryForList(
            "SELECT status FROM delivery_notice WHERE id = ?::uuid",
            billId
        );
        var factCount = jdbcTemplate.queryForObject(
            "SELECT count(*)::int FROM inv_stock_txn WHERE source_bill_id = ?::uuid",
            Integer.class,
            billId
        );
        assertThat(
            (headerRows.isEmpty() && factCount == 0)
                || (headerRows.size() == 1 && "AUDITED".equals(headerRows.getFirst().get("status")) && factCount == 1)
        ).isTrue();
        assertThat(jdbcTemplate.queryForObject("""
            SELECT count(*)::int
            FROM inv_stock_txn txn
            LEFT JOIN delivery_notice header ON header.id = txn.source_bill_id
            WHERE txn.source_bill_id = ?::uuid
              AND header.id IS NULL
            """, Integer.class, billId)).isZero();
    }

    private void bindTenant() {
        TenantContext.setTenant(accountSet);
        var request = new MockHttpServletRequest();
        request.getSession(true).setAttribute(CurrentSessionService.SESSION_USERNAME, "admin");
        RequestContextHolder.setRequestAttributes(new ServletRequestAttributes(request));
    }

    private Object saveOpeningAfter(CountDownLatch start, String quantity) {
        bindTenant();
        try {
            start.await();
            return openingStockService.saveRows(List.of(openingLine(quantity)));
        } catch (InterruptedException exception) {
            Thread.currentThread().interrupt();
            return exception;
        } finally {
            TenantContext.clear();
            RequestContextHolder.resetRequestAttributes();
        }
    }

    private Object postWithTenant(InventoryPostingCommand command) {
        bindTenant();
        try {
            return inventoryPostingService.post(command);
        } finally {
            TenantContext.clear();
            RequestContextHolder.resetRequestAttributes();
        }
    }

    private void awaitAdvisoryWaiter() throws InterruptedException {
        for (var attempt = 0; attempt < 200; attempt += 1) {
            var waiters = jdbcTemplate.queryForObject("""
                SELECT count(*)::int
                FROM pg_locks
                WHERE locktype = 'advisory'
                  AND NOT granted
                """, Integer.class);
            if (waiters != null && waiters > 0) {
                return;
            }
            Thread.sleep(25);
        }
        throw new AssertionError("库存过账线程未进入 advisory lock 等待状态");
    }

    private OpeningStockService.OpeningStockLineRequest openingLine(String quantity) {
        return new OpeningStockService.OpeningStockLineRequest(
            productCode,
            sourceWarehouseCode,
            new BigDecimal(quantity),
            BigDecimal.ONE,
            null
        );
    }

    private Map<String, Object> stockTriple() {
        return jdbcTemplate.queryForMap("""
            SELECT qty_on_hand AS "onHand",
                   qty_reserved AS reserved,
                   qty_available AS available
            FROM inv_stock_balance
            WHERE account_set_id = ?::uuid
              AND product_id = ?::uuid
              AND warehouse_id = ?::uuid
            """, accountSetId, productId, sourceWarehouseId);
    }

    private String stockAndOpeningSnapshot() {
        return jdbcTemplate.queryForObject("""
            SELECT concat_ws('|',
                balance.qty_on_hand::text,
                balance.qty_reserved::text,
                balance.qty_available::text,
                balance.amount::text,
                opening.qty::text,
                opening.unit_cost::text,
                opening.amount::text,
                (SELECT count(*)::text FROM inv_stock_txn txn
                 WHERE txn.product_id = balance.product_id
                   AND txn.warehouse_id = balance.warehouse_id)
            )
            FROM inv_stock_balance balance
            JOIN inv_stock_opening opening
              ON opening.account_set_id = balance.account_set_id
             AND opening.product_id = balance.product_id
             AND opening.warehouse_id = balance.warehouse_id
            WHERE balance.account_set_id = ?::uuid
              AND balance.product_id = ?::uuid
              AND balance.warehouse_id = ?::uuid
            """, String.class, accountSetId, productId, sourceWarehouseId);
    }

    private OtherStockInAppService.OtherStockInDraftRequest otherStockInRequest(String billNo, String quantity) {
        return new OtherStockInAppService.OtherStockInDraftRequest(
            billNo,
            null,
            BUSINESS_DATE.toString(),
            "A147",
            "A147 验收员",
            List.of(new OtherStockInAppService.OtherStockInLineRequest(
                productId,
                productCode,
                sourceWarehouseCode,
                null,
                new BigDecimal(quantity),
                BigDecimal.ONE,
                null
            ))
        );
    }

    private DeliveryNoticeAppService.DeliveryNoticeDraftRequest deliveryRequest(String billNo, String quantity) {
        return new DeliveryNoticeAppService.DeliveryNoticeDraftRequest(
            billNo,
            null,
            customerCode,
            BUSINESS_DATE.toString(),
            "A147",
            "A147 验收员",
            null,
            "CNY",
            List.of(new DeliveryNoticeAppService.DeliveryNoticeLineRequest(
                productId,
                productCode,
                sourceWarehouseCode,
                null,
                1,
                new BigDecimal(quantity),
                BigDecimal.ONE,
                BigDecimal.ZERO,
                null,
                null,
                null,
                null
            ))
        );
    }

    private Object deliveryActionAfter(
        CountDownLatch start,
        Supplier<Map<String, Object>> action
    ) {
        bindTenant();
        try {
            start.await();
            return action.get();
        } catch (ResponseStatusException exception) {
            return exception;
        } catch (InterruptedException exception) {
            Thread.currentThread().interrupt();
            return exception;
        } finally {
            TenantContext.clear();
            RequestContextHolder.resetRequestAttributes();
        }
    }

    private String lineId(String lineTable, String billId) {
        return jdbcTemplate.queryForObject(
            "SELECT id::text FROM %s WHERE bill_id = ?::uuid".formatted(lineTable),
            String.class,
            billId
        );
    }

    private List<Map<String, Object>> oldFactBusinessFields(String billId) {
        return jdbcTemplate.queryForList("""
            SELECT id::text AS id,
                   account_set_id::text AS "accountSetId",
                   txn_type AS "txnType",
                   product_id::text AS "productId",
                   warehouse_id::text AS "warehouseId",
                   qty_delta AS "qtyDelta",
                   source_bill_type AS "sourceBillType",
                   source_bill_id::text AS "sourceBillId",
                   source_bill_no AS "sourceBillNo",
                   source_bill_date AS "sourceBillDate",
                   posting_action AS "postingAction",
                   qty_on_hand_after AS "qtyOnHandAfter",
                   reversal_of_txn_id::text AS "reversalOfTxnId",
                   unit_cost AS "unitCost",
                   amount,
                   occurred_at AS "occurredAt"
            FROM inv_stock_txn
            WHERE source_bill_id = ?::uuid
            ORDER BY occurred_at, id
            """, billId);
    }

    private Map<String, Object> inventoryDocumentSnapshot(String headerTable, String lineTable, String billId) {
        return Map.of(
            "header", jdbcTemplate.queryForList(
                "SELECT id::text, bill_no, bill_date, status, total_amount, version, updated_at FROM %s WHERE id = ?::uuid".formatted(headerTable),
                billId
            ),
            "lines", jdbcTemplate.queryForList(
                "SELECT * FROM %s WHERE bill_id = ?::uuid ORDER BY line_no".formatted(lineTable),
                billId
            ),
            "facts", jdbcTemplate.queryForList(
                "SELECT * FROM inv_stock_txn WHERE source_bill_id = ?::uuid ORDER BY occurred_at, id",
                billId
            ),
            "stock", stockTriple(),
            "successLogs", jdbcTemplate.queryForList("""
                SELECT id::text AS id,
                       module_code AS module,
                       action_code AS action,
                       target_type AS "targetType",
                       target_id::text AS "targetId",
                       target_no AS "targetNo",
                       before_state::text AS "beforeState",
                       after_state::text AS "afterState"
                FROM sys_operation_log
                WHERE target_id = ?::uuid
                  AND success = TRUE
                ORDER BY operated_at, id
                """, billId)
        );
    }

    private List<String> endpointFailureLogIds(String endpoint) {
        return jdbcTemplate.queryForList("""
            SELECT id::text
            FROM sys_operation_log
            WHERE target_type = 'http_endpoint'
              AND target_no = ?
            ORDER BY operated_at, id
            """, String.class, endpoint);
    }

    private List<Map<String, Object>> newEndpointFailureLogs(String endpoint, List<String> baselineIds) {
        return jdbcTemplate.queryForList("""
            SELECT id::text AS id,
                   module_code AS module,
                   action_code AS action,
                   target_type AS "targetType",
                   target_id::text AS "targetId",
                   target_no AS "targetNo",
                   before_state::text AS "beforeState",
                   after_state::text AS "afterState",
                   failure_reason AS reason,
                   success
            FROM sys_operation_log
            WHERE target_type = 'http_endpoint'
              AND target_no = ?
            ORDER BY operated_at, id
            """, endpoint).stream()
            .filter(row -> !baselineIds.contains(String.valueOf(row.get("id"))))
            .toList();
    }

    private void deleteEndpointFailureLogs(String endpoint, List<String> baselineIds) {
        newEndpointFailureLogs(endpoint, baselineIds).forEach(row -> jdbcTemplate.update(
            "DELETE FROM sys_operation_log WHERE id = ?::uuid",
            row.get("id")
        ));
    }

    private Map<String, Object> deliverySnapshot(String billId) {
        return Map.of(
            "header", jdbcTemplate.queryForList(
                "SELECT id::text, bill_no, bill_date, status, total_amount, version, updated_at FROM delivery_notice WHERE id = ?::uuid",
                billId
            ),
            "lines", jdbcTemplate.queryForList(
                "SELECT * FROM delivery_notice_line WHERE bill_id = ?::uuid ORDER BY line_no",
                billId
            ),
            "facts", jdbcTemplate.queryForList(
                "SELECT * FROM inv_stock_txn WHERE source_bill_id = ?::uuid ORDER BY occurred_at, id",
                billId
            ),
            "stock", stockTriple()
        );
    }

    private void createFixture() {
        runPrefix = "A147TRC-" + UUID.randomUUID().toString().substring(0, 8).toUpperCase();
        productCode = "CP-" + runPrefix;
        sourceWarehouseCode = "CK-S-" + runPrefix;
        targetWarehouseCode = "CK-T-" + runPrefix;
        productId = jdbcTemplate.queryForObject("""
            INSERT INTO md_product (
                code, name, spec, unit, product_category_id, unit_id, enabled, audit_status
            )
            SELECT ?, ?, '', unit.code, category.id, unit.id, TRUE, 'AUDITED'
            FROM md_product_category category
            CROSS JOIN md_unit unit
            WHERE category.code = 'YCL' AND unit.code = 'PCS'
            RETURNING id::text
            """, String.class, productCode, runPrefix + " 追溯物料");
        sourceWarehouseId = insertWarehouse(sourceWarehouseCode, runPrefix + " 源仓");
        targetWarehouseId = insertWarehouse(targetWarehouseCode, runPrefix + " 目标仓");
        customerCode = "KH-" + runPrefix;
        customerId = jdbcTemplate.queryForObject(
            "INSERT INTO md_customer (code, name, enabled, audit_status) VALUES (?, ?, TRUE, 'AUDITED') RETURNING id::text",
            String.class,
            customerCode,
            runPrefix + " 客户"
        );

        jdbcTemplate.update("""
            INSERT INTO inv_stock_balance (
                account_set_id, product_id, warehouse_id,
                qty_on_hand, qty_available, qty_reserved
            )
            VALUES (?::uuid, ?::uuid, ?::uuid, 100, 100, 0),
                   (?::uuid, ?::uuid, ?::uuid, 0, 0, 0)
            """, accountSetId, productId, sourceWarehouseId, accountSetId, productId, targetWarehouseId);
        var openingId = UUID.randomUUID();
        jdbcTemplate.update("""
            INSERT INTO inv_stock_txn (
                account_set_id, txn_type, product_id, warehouse_id, qty_delta,
                source_bill_type, source_bill_id, source_bill_line_id,
                source_bill_no, source_bill_date, posting_action,
                qty_on_hand_after, trace_quality, amount
            )
            VALUES (
                ?::uuid, 'OPENING_STOCK', ?::uuid, ?::uuid, 100,
                'OPENING_STOCK', ?::uuid, ?::uuid,
                ?, ?, 'AUDIT', 100, 'CONTROLLED', 0
            )
            """, accountSetId, productId, sourceWarehouseId, openingId, openingId, "OPENING-" + runPrefix, BUSINESS_DATE);
    }

    private String insertWarehouse(String code, String name) {
        return jdbcTemplate.queryForObject("""
            INSERT INTO md_warehouse (code, name, warehouse_type, enabled, audit_status)
            VALUES (?, ?, '原料仓', TRUE, 'AUDITED')
            RETURNING id::text
            """, String.class, code, name);
    }

    private DocumentFixture insertWarehouseDocument(
        String headerTable,
        String lineTable,
        String billKind,
        BigDecimal quantity
    ) {
        var billNo = runPrefix + "-" + billKind;
        var billId = jdbcTemplate.queryForObject("""
            INSERT INTO %s (bill_no, bill_date, status)
            VALUES (?, ?, 'DRAFT')
            RETURNING id::text
            """.formatted(headerTable), String.class, billNo, BUSINESS_DATE);
        var lineId = jdbcTemplate.queryForObject("""
            INSERT INTO %s (
                bill_id, line_no, product_id, warehouse_id,
                qty, unit_price, amount
            )
            VALUES (?::uuid, 1, ?::uuid, ?::uuid, ?, 1, ?)
            RETURNING id::text
            """.formatted(lineTable), String.class, billId, productId, sourceWarehouseId, quantity, quantity);
        return new DocumentFixture(billId, lineId, billNo, sourceBillType(billKind));
    }

    private DocumentFixture insertTransferDocument(BigDecimal quantity) {
        var billNo = runPrefix + "-QTRK-TRANSFER";
        var billId = jdbcTemplate.queryForObject("""
            INSERT INTO stock_transfer (bill_no, bill_date, status)
            VALUES (?, ?, 'DRAFT')
            RETURNING id::text
            """, String.class, billNo, BUSINESS_DATE);
        var lineId = jdbcTemplate.queryForObject("""
            INSERT INTO stock_transfer_line (
                bill_id, line_no, product_id, source_warehouse_id,
                target_warehouse_id, qty, unit_price, amount
            )
            VALUES (?::uuid, 1, ?::uuid, ?::uuid, ?::uuid, ?, 1, ?)
            RETURNING id::text
            """, String.class, billId, productId, sourceWarehouseId, targetWarehouseId, quantity, quantity);
        return new DocumentFixture(billId, lineId, billNo, "STOCK_TRANSFER");
    }

    private String sourceBillType(String billKind) {
        return switch (billKind) {
            case "QTRK-IN" -> "OTHER_STOCK_IN";
            case "QTRK-OUT" -> "OTHER_STOCK_OUT";
            case "QTRK-GAIN" -> "STOCK_COUNT_GAIN";
            case "QTRK-LOSS" -> "STOCK_COUNT_LOSS";
            default -> throw new IllegalArgumentException("未知库存单据测试类型: " + billKind);
        };
    }

    private void assertReversibleTrace(
        DocumentFixture document,
        String forwardTxnType,
        String reverseTxnType,
        String warehouseId,
        String forwardQty,
        String reverseQty
    ) {
        var forward = fact(document, forwardTxnType, warehouseId);
        assertExactSource(forward, document, "AUDIT", forwardQty);
        assertThat(forward.get("reversalOfTxnId")).isNull();

        var reverse = fact(document, reverseTxnType, warehouseId);
        assertExactSource(reverse, document, "REVERSE", reverseQty);
        assertThat(reverse.get("reversalOfTxnId")).isEqualTo(forward.get("id"));
    }

    private Map<String, Object> fact(DocumentFixture document, String txnType, String warehouseId) {
        var rows = jdbcTemplate.queryForList("""
            SELECT id::text AS id,
                   source_bill_type AS "sourceBillType",
                   source_bill_id::text AS "sourceBillId",
                   source_bill_line_id::text AS "sourceBillLineId",
                   source_bill_no AS "sourceBillNo",
                   to_char(source_bill_date, 'YYYY-MM-DD') AS "sourceBillDate",
                   posting_action AS "postingAction",
                   trace_quality AS "traceQuality",
                   qty_delta AS "qtyDelta",
                   qty_on_hand_after AS "qtyOnHandAfter",
                   reversal_of_txn_id::text AS "reversalOfTxnId"
            FROM inv_stock_txn
            WHERE source_bill_id = ?::uuid
              AND source_bill_line_id = ?::uuid
              AND txn_type = ?
              AND warehouse_id = ?::uuid
            """, document.billId(), document.lineId(), txnType, warehouseId);
        assertThat(rows).as("%s 应仅生成一条事实", txnType).hasSize(1);
        return rows.getFirst();
    }

    private void assertExactSource(
        Map<String, Object> fact,
        DocumentFixture document,
        String action,
        String expectedQuantity
    ) {
        assertThat(fact)
            .containsEntry("sourceBillType", document.sourceBillType())
            .containsEntry("sourceBillId", document.billId())
            .containsEntry("sourceBillLineId", document.lineId())
            .containsEntry("sourceBillNo", document.billNo())
            .containsEntry("sourceBillDate", BUSINESS_DATE.toString())
            .containsEntry("postingAction", action)
            .containsEntry("traceQuality", "EXACT");
        assertThat((BigDecimal) fact.get("qtyDelta")).isEqualByComparingTo(expectedQuantity);
        assertThat(fact.get("qtyOnHandAfter")).isNotNull();
    }

    private void assertBalanceAndLedger(String warehouseId, String expectedQuantity) {
        var row = jdbcTemplate.queryForMap("""
            SELECT balance.qty_on_hand AS balance,
                   COALESCE(SUM(txn.qty_delta), 0) AS ledger,
                   (
                       SELECT latest.qty_on_hand_after
                       FROM inv_stock_txn latest
                       WHERE latest.account_set_id = balance.account_set_id
                         AND latest.product_id = balance.product_id
                         AND latest.warehouse_id = balance.warehouse_id
                       ORDER BY latest.occurred_at DESC, latest.id DESC
                       LIMIT 1
                   ) AS "latestAfter"
            FROM inv_stock_balance balance
            LEFT JOIN inv_stock_txn txn
              ON txn.account_set_id = balance.account_set_id
             AND txn.product_id = balance.product_id
             AND txn.warehouse_id = balance.warehouse_id
            WHERE balance.account_set_id = ?::uuid
              AND balance.product_id = ?::uuid
              AND balance.warehouse_id = ?::uuid
            GROUP BY balance.account_set_id, balance.product_id, balance.warehouse_id, balance.qty_on_hand
            """, accountSetId, productId, warehouseId);
        assertThat((BigDecimal) row.get("balance")).isEqualByComparingTo(expectedQuantity);
        assertThat((BigDecimal) row.get("ledger")).isEqualByComparingTo(expectedQuantity);
        assertThat((BigDecimal) row.get("latestAfter")).isEqualByComparingTo(expectedQuantity);
    }

    private void cleanFixture() {
        if (productId == null) {
            return;
        }
        jdbcTemplate.update("DELETE FROM inv_stock_txn WHERE product_id = ?::uuid", productId);
        jdbcTemplate.update("DELETE FROM inv_stock_opening WHERE product_id = ?::uuid", productId);
        jdbcTemplate.update("DELETE FROM inv_stock_balance WHERE product_id = ?::uuid", productId);
        jdbcTemplate.update("""
            DELETE FROM sys_operation_log
            WHERE target_id IN (
                SELECT bill_id FROM other_stock_in_line WHERE product_id = ?::uuid
                UNION
                SELECT bill_id FROM delivery_notice_line WHERE product_id = ?::uuid
            )
            """, productId, productId);
        jdbcTemplate.update("""
            DELETE FROM other_stock_in
            WHERE id IN (SELECT bill_id FROM other_stock_in_line WHERE product_id = ?::uuid)
            """, productId);
        jdbcTemplate.update("""
            DELETE FROM delivery_notice
            WHERE id IN (SELECT bill_id FROM delivery_notice_line WHERE product_id = ?::uuid)
            """, productId);
        if (runPrefix != null) {
            jdbcTemplate.update("DELETE FROM sys_operation_log WHERE target_no LIKE ?", runPrefix + "%");
            jdbcTemplate.update("DELETE FROM other_stock_in WHERE bill_no LIKE ?", runPrefix + "%");
            jdbcTemplate.update("DELETE FROM other_stock_out WHERE bill_no LIKE ?", runPrefix + "%");
            jdbcTemplate.update("DELETE FROM stock_count_gain WHERE bill_no LIKE ?", runPrefix + "%");
            jdbcTemplate.update("DELETE FROM stock_count_loss WHERE bill_no LIKE ?", runPrefix + "%");
            jdbcTemplate.update("DELETE FROM stock_transfer WHERE bill_no LIKE ?", runPrefix + "%");
            jdbcTemplate.update("DELETE FROM delivery_notice WHERE bill_no LIKE ?", runPrefix + "%");
        }
        jdbcTemplate.update("DELETE FROM md_product WHERE id = ?::uuid", productId);
        if (customerId != null) {
            jdbcTemplate.update("DELETE FROM md_customer WHERE id = ?::uuid", customerId);
        }
        if (sourceWarehouseId != null) {
            jdbcTemplate.update("DELETE FROM md_warehouse WHERE id = ?::uuid", sourceWarehouseId);
        }
        if (targetWarehouseId != null) {
            jdbcTemplate.update("DELETE FROM md_warehouse WHERE id = ?::uuid", targetWarehouseId);
        }
    }

    private record DocumentFixture(String billId, String lineId, String billNo, String sourceBillType) {
    }
}
