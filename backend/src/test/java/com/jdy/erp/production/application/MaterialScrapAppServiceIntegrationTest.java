package com.jdy.erp.production.application;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.argThat;
import static org.mockito.Mockito.doNothing;
import static org.mockito.Mockito.doThrow;
import static org.mockito.Mockito.when;

import java.math.BigDecimal;
import java.sql.Connection;
import java.time.LocalDate;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;
import java.util.concurrent.locks.LockSupport;
import java.util.function.Supplier;

import javax.sql.DataSource;

import com.jdy.erp.production.application.MaterialScrapAppService.ScrapDraftRequest;
import com.jdy.erp.production.application.MaterialScrapAppService.ScrapLineRequest;
import com.jdy.erp.shared.api.BillLifecycleController;
import com.jdy.erp.shared.api.BillLifecycleController.ReasonRequest;
import com.jdy.erp.shared.application.BillLifecycleService.VoidRequest;
import com.jdy.erp.shared.application.OperationLogService;
import com.jdy.erp.system.security.CurrentSessionService;
import com.jdy.erp.system.tenant.TenantContext;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.mock.web.MockHttpServletRequest;
import org.springframework.test.context.bean.override.mockito.MockitoBean;
import org.springframework.test.context.bean.override.mockito.MockitoSpyBean;
import org.springframework.web.context.request.RequestContextHolder;
import org.springframework.web.context.request.ServletRequestAttributes;
import org.springframework.web.server.ResponseStatusException;

@SpringBootTest
public class MaterialScrapAppServiceIntegrationTest {
    @Autowired
    private JdbcTemplate jdbcTemplate;

    @Autowired
    private DataSource dataSource;

    @Autowired
    private MaterialScrapAppService materialScrapAppService;

    @Autowired
    private MaterialIssueAppService materialIssueAppService;

    @Autowired
    private BillLifecycleController billLifecycleController;

    @MockitoBean
    private CurrentSessionService currentSessionService;

    @MockitoSpyBean
    private OperationLogService operationLogService;

    private Map<String, Object> accountSet;
    private Fixture fixture;

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
        when(currentSessionService.currentAccountSetId()).thenReturn(String.valueOf(accountSet.get("id")));
        when(currentSessionService.currentAccountSetCode()).thenReturn("BLD-TEST");
        when(currentSessionService.currentUsername()).thenReturn("admin");
        when(currentSessionService.currentDisplayName()).thenReturn("A151 管理员");
        when(currentSessionService.currentRoleCode()).thenReturn("ADMIN");
        doNothing().when(currentSessionService).verifyPassword(any(), any());
        bindTenant();
        fixture = new Fixture(jdbcTemplate, String.valueOf(accountSet.get("id")));
    }

    @AfterEach
    void tearDown() {
        try {
            if (fixture != null) {
                fixture.clean();
            }
        } finally {
            TenantContext.clear();
            RequestContextHolder.resetRequestAttributes();
        }
    }

    @Test
    void zeroDraftIsValidButAuditRevalidatesPositiveQuantityAndReason() {
        var preview = materialScrapAppService.previewFromIssue(fixture.sourceIssueNo);
        assertThat(document(preview))
            .containsEntry("sourceIssueNo", fixture.sourceIssueNo)
            .containsEntry("workshopCode", fixture.workshopCode);
        assertThat(lines(preview)).singleElement().satisfies(line -> {
            assertThat(line).containsEntry("id", fixture.sourceIssueLineId);
            assertDecimal(line.get("availableScrapQty"), "5");
        });

        var pushed = pushFromFixture();
        var billNo = String.valueOf(pushed.get("billNo"));
        assertThat(pushed).containsEntry("status", "DRAFT");
        var pushedDetail = materialScrapAppService.detail(billNo);
        assertThat(lines(pushedDetail)).singleElement().satisfies(line -> {
            assertDecimal(line.get("scrapQty"), "0");
            assertThat(String.valueOf(line.get("scrapReason") == null ? "" : line.get("scrapReason"))).isBlank();
        });
        assertThat(fixture.scrapTxnCount(String.valueOf(pushed.get("id")))).isZero();

        var savedZero = materialScrapAppService.saveDraft(request(
            billNo, BigDecimal.ZERO, null, BigDecimal.ZERO, null, null
        ));
        assertThat(savedZero).containsEntry("billNo", billNo).containsEntry("status", "DRAFT");
        var successBeforeInvalid = fixture.successLogCount(billNo);

        assertStatus(HttpStatus.BAD_REQUEST, () -> materialScrapAppService.saveDraft(request(
            billNo, new BigDecimal("-0.0001"), null, BigDecimal.ZERO, false, null
        )));
        assertStatus(HttpStatus.BAD_REQUEST, () -> materialScrapAppService.saveDraft(request(
            billNo, BigDecimal.ONE, "越界重发", new BigDecimal("1.0001"), false, null
        )));
        assertStatus(HttpStatus.BAD_REQUEST, () -> materialScrapAppService.saveDraft(request(
            billNo, BigDecimal.ONE, "缺少仓库", BigDecimal.ZERO, true, null
        )));
        assertStatus(HttpStatus.BAD_REQUEST, () -> materialScrapAppService.audit(billNo));
        assertThat(fixture.successLogCount(billNo)).isEqualTo(successBeforeInvalid);
        assertThat(fixture.scrapStatus(billNo)).isEqualTo("DRAFT");
        assertThat(fixture.scrapTxnCount(String.valueOf(pushed.get("id")))).isZero();

        materialScrapAppService.saveDraft(request(
            billNo, new BigDecimal("2"), "焊接损耗", new BigDecimal("0.5"), false, null
        ));
        var audited = materialScrapAppService.audit(billNo);
        assertThat(audited).containsEntry("status", "AUDITED");
        assertThat(fixture.scrapTxnCount(String.valueOf(pushed.get("id")))).isZero();
        assertDecimal(fixture.balance(fixture.sourceWarehouseId), "7");
        assertThat(jdbcTemplate.queryForObject("""
            SELECT count(*)::int
            FROM production_material_issue
            WHERE task_id = ?::uuid
            """, Integer.class, fixture.taskId)).isEqualTo(1);

        var reversed = materialScrapAppService.reverse(billNo);
        assertThat(reversed).containsEntry("status", "DRAFT");
        var deleted = materialScrapAppService.deleteDraft(billNo);
        assertThat(deleted).containsEntry("billNo", billNo).containsEntry("status", "DELETED");
        assertThat(jdbcTemplate.queryForObject(
            "SELECT count(*)::int FROM production_material_scrap WHERE bill_no = ?",
            Integer.class,
            billNo
        )).isZero();
    }

    @Test
    void fullyConsumedSourceIsRejectedByPreviewAndPushInsteadOfCreatingZeroDrafts() {
        fixture.insertScrap(
            "FULLY-CONSUMED",
            "AUDITED",
            LocalDate.of(2026, 7, 14),
            new BigDecimal("5")
        );

        assertStatus(HttpStatus.CONFLICT, () -> materialScrapAppService.previewFromIssue(fixture.sourceIssueNo));
        assertStatus(HttpStatus.CONFLICT, () -> materialScrapAppService.pushFromIssue(fixture.sourceIssueNo, null));
        assertThat(jdbcTemplate.queryForObject("""
            SELECT count(*)::int
            FROM production_material_scrap
            WHERE source_issue_id = ?::uuid
            """, Integer.class, fixture.sourceIssueId)).isEqualTo(1);
    }

    @Test
    void stockInIsASeparateWholeDocumentIdempotentLifecycle() {
        var pushed = pushFromFixture();
        var scrapId = String.valueOf(pushed.get("id"));
        var billNo = String.valueOf(pushed.get("billNo"));
        materialScrapAppService.saveDraft(request(
            billNo, new BigDecimal("2"), "可回收废料", BigDecimal.ZERO, true, fixture.targetWarehouseCode
        ));

        var audited = materialScrapAppService.audit(billNo);
        assertThat(audited).containsEntry("status", "AUDITED");
        assertThat(document(materialScrapAppService.detail(billNo)))
            .containsEntry("stockInStatus", "PENDING");
        assertThat(fixture.scrapTxnCount(scrapId)).isZero();
        assertDecimal(fixture.balance(fixture.targetWarehouseId), "0");

        var stocked = materialScrapAppService.stockIn(billNo);
        assertThat(stocked).containsEntry("status", "AUDITED").containsEntry("stockInStatus", "STOCKED_IN");
        assertThat(fixture.scrapTxnCount(scrapId)).isEqualTo(1);
        assertDecimal(fixture.balance(fixture.targetWarehouseId), "2");
        var stockLogCount = fixture.successLogCount(billNo);

        assertThat(materialScrapAppService.stockIn(billNo)).containsEntry("stockInStatus", "STOCKED_IN");
        assertThat(fixture.scrapTxnCount(scrapId)).isEqualTo(1);
        assertThat(fixture.successLogCount(billNo)).isEqualTo(stockLogCount);
        assertStatus(HttpStatus.CONFLICT, () -> materialScrapAppService.reverse(billNo));
        assertStatus(HttpStatus.CONFLICT, () -> billLifecycleController.voidBill(
            "materialScrap",
            billNo,
            new VoidRequest("admin", "test-password", "仍有 active 报废入库")
        ));

        var reversedStock = materialScrapAppService.reverseStockIn(billNo);
        assertThat(reversedStock).containsEntry("stockInStatus", "REVERSED");
        assertThat(fixture.scrapTxnCount(scrapId)).isEqualTo(2);
        assertDecimal(fixture.balance(fixture.targetWarehouseId), "0");
        var reverseStockLogCount = fixture.successLogCount(billNo);
        assertThat(materialScrapAppService.reverseStockIn(billNo)).containsEntry("stockInStatus", "REVERSED");
        assertThat(fixture.scrapTxnCount(scrapId)).isEqualTo(2);
        assertThat(fixture.successLogCount(billNo)).isEqualTo(reverseStockLogCount);

        assertThat(materialScrapAppService.reverse(billNo)).containsEntry("status", "DRAFT");
        assertThat(billLifecycleController.voidBill(
            "materialScrap",
            billNo,
            new VoidRequest("admin", "test-password", "完整撤销入库后作废")
        )).containsEntry("status", "VOID");
    }

    @Test
    void multiLineStockInRollsBackEveryLineWhenOneWarehouseBecomesInvalid() {
        var second = fixture.addSecondSourceLine();
        var pushed = pushFromFixture();
        var scrapId = String.valueOf(pushed.get("id"));
        var billNo = String.valueOf(pushed.get("billNo"));
        materialScrapAppService.saveDraft(new ScrapDraftRequest(
            billNo,
            fixture.sourceIssueNo,
            LocalDate.of(2026, 7, 14),
            "PRODUCTION_SCRAP",
            List.of(
                new ScrapLineRequest(
                    fixture.sourceIssueLineId,
                    BigDecimal.ONE,
                    "第一行整单入库",
                    BigDecimal.ZERO,
                    true,
                    fixture.targetWarehouseCode
                ),
                new ScrapLineRequest(
                    second.sourceIssueLineId(),
                    BigDecimal.ONE,
                    "第二行整单入库",
                    BigDecimal.ZERO,
                    true,
                    second.targetWarehouseCode()
                )
            )
        ));
        materialScrapAppService.audit(billNo);
        var laterWarehouseId = fixture.targetWarehouseId.compareTo(second.targetWarehouseId()) > 0
            ? fixture.targetWarehouseId
            : second.targetWarehouseId();
        jdbcTemplate.update(
            "UPDATE md_warehouse SET enabled = FALSE WHERE id = ?::uuid",
            laterWarehouseId
        );
        var successBefore = fixture.successLogCount(billNo);

        assertStatus(HttpStatus.BAD_REQUEST, () -> materialScrapAppService.stockIn(billNo));

        assertThat(fixture.scrapTxnCount(scrapId)).isZero();
        assertDecimal(fixture.balance(fixture.targetWarehouseId), "0");
        assertDecimal(fixture.balance(second.targetWarehouseId()), "0");
        assertThat(jdbcTemplate.queryForList("""
            SELECT stock_in_status
            FROM production_material_scrap_line
            WHERE scrap_id = ?::uuid
            ORDER BY line_no
            """, scrapId)).extracting(row -> row.get("stock_in_status"))
            .containsExactly("PENDING", "PENDING");
        assertThat(fixture.successLogCount(billNo)).isEqualTo(successBefore);

        jdbcTemplate.update(
            "UPDATE md_warehouse SET enabled = TRUE WHERE id = ?::uuid",
            laterWarehouseId
        );
        assertThat(materialScrapAppService.stockIn(billNo)).containsEntry("stockInStatus", "STOCKED_IN");
        assertThat(fixture.scrapTxnCount(scrapId)).isEqualTo(2);
        assertDecimal(fixture.balance(fixture.targetWarehouseId), "1");
        assertDecimal(fixture.balance(second.targetWarehouseId()), "1");
    }

    @Test
    void auditStatusAndSuccessLogRollBackTogetherWhenLogPersistenceFails() {
        var pushed = pushFromFixture();
        var billNo = String.valueOf(pushed.get("billNo"));
        materialScrapAppService.saveDraft(request(
            billNo, BigDecimal.ONE, "日志事务回滚", BigDecimal.ZERO, false, null
        ));
        var successBefore = fixture.successLogCount(billNo);
        doThrow(new IllegalStateException("A151 injected audit log failure"))
            .when(operationLogService)
            .logCurrent(argThat(command -> "AUDIT_MATERIAL_SCRAP".equals(command.action())));

        assertThatThrownBy(() -> materialScrapAppService.audit(billNo))
            .isInstanceOf(IllegalStateException.class)
            .hasMessageContaining("injected audit log failure");

        assertThat(fixture.scrapStatus(billNo)).isEqualTo("DRAFT");
        assertThat(fixture.successLogCount(billNo)).isEqualTo(successBefore);
        assertThat(fixture.scrapTxnCount(String.valueOf(pushed.get("id")))).isZero();
    }

    @Test
    void sharedLifecyclePolicyRejectsHeaderAndLineCloseFreezeActions() {
        var pushed = pushFromFixture();
        var billNo = String.valueOf(pushed.get("billNo"));

        assertStatus(HttpStatus.BAD_REQUEST, () -> billLifecycleController.close(
            "materialScrap", billNo, new ReasonRequest("材料报废单不支持关闭")
        ));
        assertStatus(HttpStatus.BAD_REQUEST, () -> billLifecycleController.freeze(
            "materialScrap", billNo, new ReasonRequest("材料报废单不支持冻结")
        ));
        assertStatus(HttpStatus.BAD_REQUEST, () -> billLifecycleController.closeLine(
            "materialScrap", billNo, 1, new ReasonRequest("材料报废单行不支持关闭")
        ));
        assertStatus(HttpStatus.BAD_REQUEST, () -> billLifecycleController.freezeLine(
            "materialScrap", billNo, 1, new ReasonRequest("材料报废单行不支持冻结")
        ));
    }

    @Test
    void concurrentStockInAndReverseUseFreshLockedLineStateAndOnlyOneCanWin() throws Exception {
        var pushed = pushFromFixture();
        var scrapId = String.valueOf(pushed.get("id"));
        var billNo = String.valueOf(pushed.get("billNo"));
        materialScrapAppService.saveDraft(request(
            billNo, new BigDecimal("2"), "并发入库反审核", BigDecimal.ZERO, true, fixture.targetWarehouseCode
        ));
        materialScrapAppService.audit(billNo);

        var ready = new CountDownLatch(2);
        var start = new CountDownLatch(1);
        var executor = Executors.newFixedThreadPool(2);
        List<Object> outcomes;
        try {
            try (var headerLock = holdRowLock("production_material_scrap", scrapId)) {
                var stockFuture = executor.submit(() -> actionAfter(
                    ready, start, () -> materialScrapAppService.stockIn(billNo)
                ));
                var reverseFuture = executor.submit(() -> actionAfter(
                    ready, start, () -> materialScrapAppService.reverse(billNo)
                ));
                assertWorkersReady(ready);
                start.countDown();
                awaitDatabaseLockWaiters("production_material_scrap", 2);
                assertBlockedOnHeldRow(stockFuture);
                assertBlockedOnHeldRow(reverseFuture);
                headerLock.release();
                outcomes = List.of(
                    stockFuture.get(10, TimeUnit.SECONDS),
                    reverseFuture.get(10, TimeUnit.SECONDS)
                );
            }
        } finally {
            start.countDown();
            executor.shutdownNow();
            assertThat(executor.awaitTermination(5, TimeUnit.SECONDS)).isTrue();
        }

        assertThat(outcomes.stream().filter(Map.class::isInstance)).hasSize(1);
        assertThat(outcomes.stream().filter(ResponseStatusException.class::isInstance)).singleElement()
            .satisfies(error -> assertThat(((ResponseStatusException) error).getStatusCode()).isEqualTo(HttpStatus.CONFLICT));
        var detail = document(materialScrapAppService.detail(billNo));
        var status = String.valueOf(detail.get("status"));
        var stockStatus = String.valueOf(detail.get("stockInStatus"));
        if ("AUDITED".equals(status)) {
            assertThat(stockStatus).isEqualTo("STOCKED_IN");
            assertThat(fixture.scrapTxnCount(scrapId)).isEqualTo(1);
            assertDecimal(fixture.balance(fixture.targetWarehouseId), "2");
            assertStatus(HttpStatus.CONFLICT, () -> materialScrapAppService.reverse(billNo));
            materialScrapAppService.reverseStockIn(billNo);
            materialScrapAppService.reverse(billNo);
        } else {
            assertThat(status).isEqualTo("DRAFT");
            assertThat(stockStatus).isEqualTo("PENDING");
            assertThat(fixture.scrapTxnCount(scrapId)).isZero();
            assertDecimal(fixture.balance(fixture.targetWarehouseId), "0");
        }
    }

    @Test
    void concurrentQuotaAllowsOneAuditAndLeavesTheLoserBusinessTransactionClean() throws Exception {
        var first = pushFromFixture();
        var second = pushFromFixture();
        var firstNo = String.valueOf(first.get("billNo"));
        var secondNo = String.valueOf(second.get("billNo"));
        materialScrapAppService.saveDraft(request(
            firstNo, new BigDecimal("4"), "并发一", BigDecimal.ZERO, false, null
        ));
        materialScrapAppService.saveDraft(request(
            secondNo, new BigDecimal("4"), "并发二", BigDecimal.ZERO, false, null
        ));

        var ready = new CountDownLatch(2);
        var start = new CountDownLatch(1);
        var executor = Executors.newFixedThreadPool(2);
        List<Object> outcomes;
        try {
            try (var sourceLineLock = holdRowLock("production_material_issue_line", fixture.sourceIssueLineId)) {
                var firstFuture = executor.submit(() -> auditAfter(ready, start, firstNo));
                var secondFuture = executor.submit(() -> auditAfter(ready, start, secondNo));
                assertWorkersReady(ready);
                start.countDown();
                awaitDatabaseLockWaiters("production_material_issue", 2);
                assertBlockedOnHeldRow(firstFuture);
                assertBlockedOnHeldRow(secondFuture);
                sourceLineLock.release();
                outcomes = List.of(
                    firstFuture.get(10, TimeUnit.SECONDS),
                    secondFuture.get(10, TimeUnit.SECONDS)
                );
            }
        } finally {
            start.countDown();
            executor.shutdownNow();
            assertThat(executor.awaitTermination(5, TimeUnit.SECONDS)).isTrue();
        }

        assertThat(outcomes.stream().filter(Map.class::isInstance)).hasSize(1);
        assertThat(outcomes.stream().filter(ResponseStatusException.class::isInstance)).singleElement()
            .satisfies(error -> assertThat(((ResponseStatusException) error).getStatusCode()).isEqualTo(HttpStatus.CONFLICT));
        var rows = jdbcTemplate.queryForList("""
            SELECT id::text AS id, bill_no AS "billNo", status
            FROM production_material_scrap
            WHERE bill_no IN (?, ?)
            ORDER BY bill_no
            """, firstNo, secondNo);
        assertThat(rows).extracting(row -> row.get("status")).containsExactlyInAnyOrder("AUDITED", "DRAFT");
        var loser = rows.stream().filter(row -> "DRAFT".equals(row.get("status"))).findFirst().orElseThrow();
        assertThat(fixture.scrapTxnCount(String.valueOf(loser.get("id")))).isZero();
        assertThat(jdbcTemplate.queryForObject("""
            SELECT count(*)::int
            FROM sys_operation_log
            WHERE target_no = ?
              AND action_code LIKE '%AUDIT%'
              AND success = TRUE
            """, Integer.class, loser.get("billNo"))).isZero();
    }

    @Test
    void sourceRedAndWorkshopPredicatesAreRecheckedAndVoidReleasesSourceGuard() {
        jdbcTemplate.update("UPDATE production_task SET department_code = NULL WHERE id = ?::uuid", fixture.taskId);
        assertStatus(HttpStatus.CONFLICT, () -> materialScrapAppService.previewFromIssue(fixture.sourceIssueNo));
        jdbcTemplate.update(
            "UPDATE production_task SET department_code = ? WHERE id = ?::uuid",
            fixture.workshopCode,
            fixture.taskId
        );

        var redBillNo = fixture.prefix + "-RED";
        var redId = jdbcTemplate.queryForObject("""
            INSERT INTO production_material_issue (bill_no, task_id, red_source_bill_id, status)
            VALUES (?, ?::uuid, ?::uuid, 'DRAFT')
            RETURNING id::text
            """, String.class, redBillNo, fixture.taskId, fixture.sourceIssueId);
        assertStatus(HttpStatus.CONFLICT, () -> materialScrapAppService.previewFromIssue(fixture.sourceIssueNo));
        jdbcTemplate.update("DELETE FROM production_material_issue WHERE id = ?::uuid", redId);

        var pushed = pushFromFixture();
        var billNo = String.valueOf(pushed.get("billNo"));
        var workshopSnapshot = String.valueOf(document(materialScrapAppService.detail(billNo)).get("workshopName"));
        jdbcTemplate.update("""
            UPDATE md_production_department
            SET name = ?, enabled = FALSE, audit_status = 'DRAFT'
            WHERE code = ?
            """, fixture.prefix + " 已改名车间", fixture.workshopCode);
        materialScrapAppService.saveDraft(request(
            billNo, BigDecimal.ONE, "历史车间快照", BigDecimal.ZERO, false, null
        ));
        materialScrapAppService.audit(billNo);
        assertThat(document(materialScrapAppService.detail(billNo)))
            .containsEntry("workshopName", workshopSnapshot)
            .doesNotContainEntry("workshopName", fixture.prefix + " 已改名车间");
        assertStatus(HttpStatus.CONFLICT, () -> materialIssueAppService.redReverse(
            fixture.sourceIssueNo,
            new MaterialIssueAppService.RedReverseRequest(null)
        ));

        materialScrapAppService.reverse(billNo);

        var voided = billLifecycleController.voidBill(
            "materialScrap",
            billNo,
            new VoidRequest("admin", "test-password", "测试作废释放来源")
        );
        assertThat(voided).containsEntry("status", "VOID");
        assertThat(materialIssueAppService.redReverse(
            fixture.sourceIssueNo,
            new MaterialIssueAppService.RedReverseRequest(null)
        )).containsEntry("status", "DRAFT");
    }

    private Object auditAfter(CountDownLatch ready, CountDownLatch start, String billNo) {
        return actionAfter(ready, start, () -> materialScrapAppService.audit(billNo));
    }

    private Object actionAfter(
        CountDownLatch ready,
        CountDownLatch start,
        Supplier<Map<String, Object>> action
    ) {
        bindTenant();
        try {
            ready.countDown();
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

    private void assertWorkersReady(CountDownLatch ready) throws InterruptedException {
        assertThat(ready.await(5, TimeUnit.SECONDS))
            .as("both workers must be ready before the shared row lock is released")
            .isTrue();
    }

    private void assertBlockedOnHeldRow(Future<Object> future) {
        assertThatThrownBy(() -> future.get(300, TimeUnit.MILLISECONDS))
            .as("the business action must wait for the deliberately held database row lock")
            .isInstanceOf(TimeoutException.class);
    }

    private void awaitDatabaseLockWaiters(String table, int expected) {
        var deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(5);
        do {
            var waiters = jdbcTemplate.queryForObject("""
                SELECT count(*)::int
                FROM pg_stat_activity
                WHERE datname = current_database()
                  AND state = 'active'
                  AND wait_event_type = 'Lock'
                  AND query ILIKE ?
                """, Integer.class, "%" + table + "%");
            if (waiters != null && waiters >= expected) {
                return;
            }
            LockSupport.parkNanos(TimeUnit.MILLISECONDS.toNanos(10));
        } while (System.nanoTime() < deadline);
        throw new AssertionError("Expected " + expected + " database lock waiters on " + table);
    }

    private HeldRowLock holdRowLock(String table, String id) throws Exception {
        var allowedTable = switch (table) {
            case "production_material_scrap", "production_material_issue_line" -> table;
            default -> throw new IllegalArgumentException("Unsupported test row lock table: " + table);
        };
        Connection connection = dataSource.getConnection();
        var acquired = false;
        try {
            connection.setAutoCommit(false);
            try (var statement = connection.prepareStatement(
                "SELECT id FROM " + allowedTable + " WHERE id = ?::uuid FOR UPDATE"
            )) {
                statement.setString(1, id);
                try (var result = statement.executeQuery()) {
                    if (!result.next()) {
                        throw new AssertionError("Missing row for deterministic concurrency lock: " + id);
                    }
                }
            }
            acquired = true;
            return new HeldRowLock(connection);
        } finally {
            if (!acquired) {
                connection.close();
            }
        }
    }

    private Map<String, Object> pushFromFixture() {
        return fixture.trackScrap(materialScrapAppService.pushFromIssue(fixture.sourceIssueNo, null));
    }

    private ScrapDraftRequest request(
        String billNo,
        BigDecimal scrapQty,
        String reason,
        BigDecimal reissueQty,
        Boolean stockIn,
        String targetWarehouseCode
    ) {
        return new ScrapDraftRequest(
            billNo,
            fixture.sourceIssueNo,
            LocalDate.of(2026, 7, 14),
            "PRODUCTION_SCRAP",
            List.of(new ScrapLineRequest(
                fixture.sourceIssueLineId,
                scrapQty,
                reason,
                reissueQty,
                stockIn,
                targetWarehouseCode
            ))
        );
    }

    private void bindTenant() {
        TenantContext.setTenant(accountSet);
        var request = new MockHttpServletRequest();
        request.getSession(true).setAttribute(CurrentSessionService.SESSION_USERNAME, "admin");
        RequestContextHolder.setRequestAttributes(new ServletRequestAttributes(request));
    }

    private void assertStatus(HttpStatus status, Runnable action) {
        assertThatThrownBy(action::run)
            .isInstanceOfSatisfying(ResponseStatusException.class, error ->
                assertThat(error.getStatusCode()).isEqualTo(status));
    }

    @SuppressWarnings("unchecked")
    private Map<String, Object> document(Map<String, Object> result) {
        return (Map<String, Object>) result.get("document");
    }

    @SuppressWarnings("unchecked")
    private List<Map<String, Object>> lines(Map<String, Object> result) {
        return (List<Map<String, Object>>) result.get("lines");
    }

    private void assertDecimal(Object value, String expected) {
        assertThat((BigDecimal) value).isEqualByComparingTo(expected);
    }

    private static final class HeldRowLock implements AutoCloseable {
        private Connection connection;

        private HeldRowLock(Connection connection) {
            this.connection = connection;
        }

        private void release() throws Exception {
            var held = connection;
            if (held == null) {
                return;
            }
            connection = null;
            try {
                held.rollback();
            } finally {
                held.close();
            }
        }

        @Override
        public void close() throws Exception {
            release();
        }
    }

    public static final class Fixture {
        private final JdbcTemplate jdbcTemplate;
        private final String accountSetId;
        private final String prefix;
        private final String productId;
        private final String sourceWarehouseId;
        private final String targetWarehouseId;
        private final String workshopId;
        private final String workshopCode;
        private final String bomId;
        private final String planId;
        private final String taskId;
        private final String sourceIssueId;
        private final String sourceIssueNo;
        private final String sourceIssueLineId;
        private final String targetWarehouseCode;
        private final List<String> extraWarehouseIds = new java.util.ArrayList<>();
        private final Map<String, String> trackedScraps = new LinkedHashMap<>();

        public Fixture(JdbcTemplate jdbcTemplate, String accountSetId) {
            this.jdbcTemplate = jdbcTemplate;
            this.accountSetId = accountSetId;
            prefix = "A151-APP-" + UUID.randomUUID().toString().substring(0, 8).toUpperCase();
            var productCode = prefix + "-MAT";
            var sourceWarehouseCode = prefix + "-SRC";
            targetWarehouseCode = prefix + "-SCRAP";
            workshopCode = prefix + "-WS";

            productId = jdbcTemplate.queryForObject("""
                INSERT INTO md_product (
                    code, name, spec, unit, product_category_id, unit_id, enabled, audit_status
                )
                SELECT ?, ?, '', unit.code, category.id, unit.id, TRUE, 'AUDITED'
                FROM md_product_category category
                CROSS JOIN md_unit unit
                WHERE category.code = 'YCL'
                  AND unit.code = 'PCS'
                RETURNING id::text
                """, String.class, productCode, prefix + " 测试物料");
            sourceWarehouseId = insertWarehouse(sourceWarehouseCode, prefix + " 来源仓");
            targetWarehouseId = insertWarehouse(targetWarehouseCode, prefix + " 报废仓");
            workshopId = jdbcTemplate.queryForObject("""
                INSERT INTO md_production_department (code, name, enabled, audit_status)
                VALUES (?, ?, TRUE, 'AUDITED')
                RETURNING id::text
                """, String.class, workshopCode, prefix + " 车间");
            bomId = jdbcTemplate.queryForObject("""
                INSERT INTO prod_bom (code, product_id, qty, enabled, is_current, audit_status)
                VALUES (?, ?::uuid, 1, FALSE, FALSE, 'AUDITED')
                RETURNING id::text
                """, String.class, prefix + "-BOM", productId);
            planId = jdbcTemplate.queryForObject("""
                INSERT INTO production_plan (
                    bill_no, bom_id, product_id, warehouse_id, planned_qty,
                    department_code, status
                )
                VALUES (?, ?::uuid, ?::uuid, ?::uuid, 5, ?, 'AUDITED')
                RETURNING id::text
                """, String.class, prefix + "-PLAN", bomId, productId, sourceWarehouseId, workshopCode);
            taskId = jdbcTemplate.queryForObject("""
                INSERT INTO production_task (
                    bill_no, bom_id, product_id, warehouse_id, qty, issued_qty,
                    completed_qty, status, plan_id, department_code
                )
                VALUES (?, ?::uuid, ?::uuid, ?::uuid, 5, 5, 0, 'AUDITED', ?::uuid, ?)
                RETURNING id::text
                """, String.class, prefix + "-TASK", bomId, productId, sourceWarehouseId, planId, workshopCode);
            jdbcTemplate.update("""
                INSERT INTO production_task_material_snapshot (
                    task_id, line_no, product_id, unit_qty, required_qty, issued_qty
                )
                VALUES (?::uuid, 1, ?::uuid, 1, 5, 5)
                """, taskId, productId);
            sourceIssueNo = prefix + "-ISSUE";
            sourceIssueId = jdbcTemplate.queryForObject("""
                INSERT INTO production_material_issue (
                    bill_no, task_id, status, close_status, frozen_status, created_at
                )
                VALUES (?, ?::uuid, 'AUDITED', 'OPEN', 'NORMAL', TIMESTAMPTZ '2026-07-13 16:30:00+00')
                RETURNING id::text
                """, String.class, sourceIssueNo, taskId);
            sourceIssueLineId = jdbcTemplate.queryForObject("""
                INSERT INTO production_material_issue_line (
                    issue_id, line_no, product_id, product_code_snapshot,
                    product_name_snapshot, product_spec_snapshot, warehouse_id,
                    qty, unit_price, amount
                )
                VALUES (?::uuid, 1, ?::uuid, ?, ?, '', ?::uuid, 5, 1, 5)
                RETURNING id::text
                """, String.class, sourceIssueId, productId, productCode, prefix + " 测试物料", sourceWarehouseId);
            jdbcTemplate.update("""
                INSERT INTO inv_stock_balance (
                    account_set_id, product_id, warehouse_id,
                    qty_on_hand, qty_available, qty_reserved
                )
                VALUES (?::uuid, ?::uuid, ?::uuid, 7, 7, 0)
                """, accountSetId, productId, sourceWarehouseId);
        }

        private String insertWarehouse(String code, String name) {
            return jdbcTemplate.queryForObject("""
                INSERT INTO md_warehouse (code, name, warehouse_type, enabled, audit_status)
                VALUES (?, ?, '原料仓', TRUE, 'AUDITED')
                RETURNING id::text
                """, String.class, code, name);
        }

        public ScrapRow insertScrap(String suffix, String status, LocalDate billDate, BigDecimal scrapQty) {
            var billNo = prefix + "-" + suffix;
            var scrapId = jdbcTemplate.queryForObject("""
                INSERT INTO production_material_scrap (
                    bill_no, bill_date, business_type, source_issue_id,
                    workshop_id, workshop_code_snapshot, workshop_name_snapshot,
                    status
                )
                VALUES (?, ?, 'PRODUCTION_SCRAP', ?::uuid, ?::uuid, ?, ?, ?)
                RETURNING id::text
                """, String.class,
                billNo, billDate, sourceIssueId, workshopId, workshopCode, prefix + " 车间", status);
            trackScrap(scrapId, billNo);
            jdbcTemplate.update("""
                INSERT INTO production_material_scrap_line (
                    scrap_id, line_no, source_issue_line_id, product_id,
                    product_code_snapshot, product_name_snapshot,
                    product_spec_snapshot, product_unit_snapshot,
                    source_warehouse_id, source_warehouse_code_snapshot,
                    issue_qty_snapshot, available_scrap_qty_snapshot,
                    scrap_qty, scrap_reason, reissue_qty, is_stock_in,
                    stock_in_status
                )
                VALUES (
                    ?::uuid, 1, ?::uuid, ?::uuid,
                    ?, ?, '', 'PCS',
                    ?::uuid, ?, 5, 5, ?, ?, 0, FALSE, 'NOT_REQUIRED'
                )
                """,
                scrapId,
                sourceIssueLineId,
                productId,
                prefix + "-MAT",
                prefix + " 测试物料",
                sourceWarehouseId,
                prefix + "-SRC",
                scrapQty,
                scrapQty.signum() == 0 ? null : suffix + " 原因"
            );
            return new ScrapRow(scrapId, billNo);
        }

        public Map<String, Object> trackScrap(Map<String, Object> scrap) {
            var scrapId = scrap.get("id");
            var billNo = scrap.get("billNo");
            if (scrapId == null || billNo == null) {
                throw new AssertionError("Created material scrap must expose exact id and billNo");
            }
            trackScrap(String.valueOf(scrapId), String.valueOf(billNo));
            return scrap;
        }

        private void trackScrap(String scrapId, String billNo) {
            if (scrapId == null || scrapId.isBlank() || billNo == null || billNo.isBlank()) {
                throw new AssertionError("Created material scrap must expose exact id and billNo");
            }
            trackedScraps.put(scrapId, billNo);
        }

        public AdditionalSourceLine addSecondSourceLine() {
            jdbcTemplate.update("""
                INSERT INTO production_task_material_snapshot (
                    task_id, line_no, product_id, unit_qty, required_qty, issued_qty
                )
                VALUES (?::uuid, 2, ?::uuid, 1, 5, 5)
                """, taskId, productId);
            var sourceLineId = jdbcTemplate.queryForObject("""
                INSERT INTO production_material_issue_line (
                    issue_id, line_no, product_id, product_code_snapshot,
                    product_name_snapshot, product_spec_snapshot, warehouse_id,
                    qty, unit_price, amount
                )
                VALUES (?::uuid, 2, ?::uuid, ?, ?, '', ?::uuid, 5, 1, 5)
                RETURNING id::text
                """, String.class,
                sourceIssueId, productId, prefix + "-MAT", prefix + " 测试物料", sourceWarehouseId);
            var targetCode = prefix + "-SCRAP-2";
            var targetId = insertWarehouse(targetCode, prefix + " 第二报废仓");
            extraWarehouseIds.add(targetId);
            return new AdditionalSourceLine(sourceLineId, targetId, targetCode);
        }

        public BigDecimal balance(String warehouseId) {
            return jdbcTemplate.queryForObject("""
                SELECT COALESCE((
                    SELECT qty_on_hand
                    FROM inv_stock_balance
                    WHERE account_set_id = ?::uuid
                      AND product_id = ?::uuid
                      AND warehouse_id = ?::uuid
                ), 0)
                """, BigDecimal.class, accountSetId, productId, warehouseId);
        }

        public int scrapTxnCount(String scrapId) {
            return jdbcTemplate.queryForObject(
                "SELECT count(*)::int FROM inv_stock_txn WHERE source_bill_id = ?::uuid",
                Integer.class,
                scrapId
            );
        }

        public int successLogCount(String billNo) {
            return jdbcTemplate.queryForObject("""
                SELECT count(*)::int
                FROM sys_operation_log
                WHERE target_no = ?
                  AND success = TRUE
                """, Integer.class, billNo);
        }

        public String scrapStatus(String billNo) {
            return jdbcTemplate.queryForObject(
                "SELECT status FROM production_material_scrap WHERE bill_no = ?",
                String.class,
                billNo
            );
        }

        public void clean() {
            deleteTrackedScrapLogs();
            jdbcTemplate.update("""
                DELETE FROM sys_operation_log
                WHERE target_id IN (
                    SELECT id FROM production_material_scrap WHERE source_issue_id = ?::uuid
                )
                   OR target_id IN (
                    SELECT id FROM production_material_issue WHERE task_id = ?::uuid
                )
                """, sourceIssueId, taskId);
            jdbcTemplate.update("DELETE FROM sys_operation_log WHERE target_no LIKE ?", prefix + "%");
            jdbcTemplate.update("DELETE FROM inv_stock_txn WHERE product_id = ?::uuid", productId);
            jdbcTemplate.update("DELETE FROM inv_stock_balance WHERE product_id = ?::uuid", productId);
            jdbcTemplate.update("DELETE FROM production_material_scrap WHERE source_issue_id = ?::uuid", sourceIssueId);
            jdbcTemplate.update("DELETE FROM production_material_issue WHERE task_id = ?::uuid", taskId);
            jdbcTemplate.update("DELETE FROM production_task_material_snapshot WHERE task_id = ?::uuid", taskId);
            jdbcTemplate.update("DELETE FROM production_task WHERE id = ?::uuid", taskId);
            jdbcTemplate.update("DELETE FROM production_plan WHERE id = ?::uuid", planId);
            jdbcTemplate.update("DELETE FROM prod_bom WHERE id = ?::uuid", bomId);
            jdbcTemplate.update("DELETE FROM md_product WHERE id = ?::uuid", productId);
            jdbcTemplate.update(
                "DELETE FROM md_warehouse WHERE id IN (?::uuid, ?::uuid)",
                sourceWarehouseId,
                targetWarehouseId
            );
            for (var warehouseId : extraWarehouseIds) {
                jdbcTemplate.update("DELETE FROM md_warehouse WHERE id = ?::uuid", warehouseId);
            }
            jdbcTemplate.update("DELETE FROM md_production_department WHERE id = ?::uuid", workshopId);
            deleteTrackedScrapLogs();
            assertTrackedScrapLogsDeleted();
        }

        private void deleteTrackedScrapLogs() {
            trackedScraps.forEach((scrapId, billNo) -> jdbcTemplate.update("""
                DELETE FROM sys_operation_log
                WHERE target_id = ?::uuid
                   OR target_no = ?
                """, scrapId, billNo));
        }

        private void assertTrackedScrapLogsDeleted() {
            trackedScraps.forEach((scrapId, billNo) -> assertThat(jdbcTemplate.queryForObject("""
                SELECT count(*)::int
                FROM sys_operation_log
                WHERE target_id = ?::uuid
                   OR target_no = ?
                """, Integer.class, scrapId, billNo)).isZero());
        }

        public String prefix() {
            return prefix;
        }

        public String sourceIssueId() {
            return sourceIssueId;
        }

        public String sourceIssueNo() {
            return sourceIssueNo;
        }

        public String sourceIssueLineId() {
            return sourceIssueLineId;
        }

        public String workshopCode() {
            return workshopCode;
        }

        public String productCode() {
            return prefix + "-MAT";
        }

        public String sourceWarehouseId() {
            return sourceWarehouseId;
        }

        public String targetWarehouseId() {
            return targetWarehouseId;
        }

        public String targetWarehouseCode() {
            return targetWarehouseCode;
        }

        public String taskId() {
            return taskId;
        }

        public record ScrapRow(String id, String billNo) {
        }

        public record AdditionalSourceLine(
            String sourceIssueLineId,
            String targetWarehouseId,
            String targetWarehouseCode
        ) {
        }
    }
}
