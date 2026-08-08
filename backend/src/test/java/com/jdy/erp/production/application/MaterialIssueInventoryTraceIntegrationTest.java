package com.jdy.erp.production.application;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.Mockito.when;
import static com.jdy.erp.testsupport.InventoryTraceAssertions.assertExactLifecycle;
import static com.jdy.erp.testsupport.InventoryTraceAssertions.fact;
import static com.jdy.erp.testsupport.InventoryTraceAssertions.reversal;

import java.math.BigDecimal;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.Executors;

import com.jdy.erp.system.security.CurrentSessionService;
import com.jdy.erp.system.tenant.TenantContext;
import com.jdy.erp.testsupport.InventoryTraceAssertions.SourceDocument;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.mock.web.MockHttpServletRequest;
import org.springframework.test.context.bean.override.mockito.MockitoBean;
import org.springframework.web.context.request.RequestContextHolder;
import org.springframework.web.context.request.ServletRequestAttributes;
import org.springframework.web.server.ResponseStatusException;

@SpringBootTest
class MaterialIssueInventoryTraceIntegrationTest {
    @Autowired
    private JdbcTemplate jdbcTemplate;

    @Autowired
    private MaterialIssueAppService materialIssueAppService;

    @MockitoBean
    private CurrentSessionService currentSessionService;

    private Map<String, Object> accountSet;
    private String accountSetId;
    private String productId;
    private String productCode;
    private String warehouseId;
    private String warehouseCode;
    private String firstIssueId;
    private String firstIssueLineId;
    private String firstIssueNo;
    private String secondIssueId;
    private String secondIssueNo;

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
        when(currentSessionService.currentAccountSetId()).thenReturn(accountSetId);
        bindTenant();
        createFixture();
    }

    @AfterEach
    void tearDown() {
        try {
            cleanFixtureInForeignKeyOrder();
            assertFixtureResidueIsZero();
        } finally {
            TenantContext.clear();
            RequestContextHolder.resetRequestAttributes();
        }
    }

    @Test
    void concurrentAuditKeepsLoserDraftAndWritesExactReversibleFactsOnce() throws Exception {
        var start = new CountDownLatch(1);
        var executor = Executors.newFixedThreadPool(2);
        try {
            var first = executor.submit(() -> auditAfter(start, firstIssueNo));
            var second = executor.submit(() -> auditAfter(start, secondIssueNo));
            start.countDown();
            var outcomes = List.of(first.get(), second.get());

            assertThat(outcomes.stream().filter(Map.class::isInstance)).hasSize(1);
            assertThat(outcomes.stream().filter(ResponseStatusException.class::isInstance)).singleElement()
                .satisfies(error -> assertThat(((ResponseStatusException) error).getStatusCode()).isEqualTo(HttpStatus.CONFLICT));
        } finally {
            executor.shutdownNow();
        }

        var statuses = jdbcTemplate.queryForList("""
            SELECT id::text AS id, bill_no AS "billNo", status
            FROM production_material_issue
            WHERE id IN (?::uuid, ?::uuid)
            ORDER BY bill_no
            """, firstIssueId, secondIssueId);
        assertThat(statuses).extracting(row -> row.get("status")).containsExactlyInAnyOrder("AUDITED", "DRAFT");

        var winner = statuses.stream().filter(row -> "AUDITED".equals(row.get("status"))).findFirst().orElseThrow();
        var loser = statuses.stream().filter(row -> "DRAFT".equals(row.get("status"))).findFirst().orElseThrow();
        var winnerId = String.valueOf(winner.get("id"));
        var winnerNo = String.valueOf(winner.get("billNo"));
        var winnerLineId = jdbcTemplate.queryForObject(
            "SELECT id::text FROM production_material_issue_line WHERE issue_id = ?::uuid",
            String.class,
            winnerId
        );

        var auditFact = jdbcTemplate.queryForMap("""
            SELECT id::text AS id,
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
              AND txn_type = 'PRODUCTION_ISSUE'
            """, winnerId);
        assertThat(auditFact)
            .containsEntry("sourceBillId", winnerId)
            .containsEntry("sourceBillLineId", winnerLineId)
            .containsEntry("sourceBillNo", winnerNo)
            .containsEntry("postingAction", "AUDIT")
            .containsEntry("traceQuality", "EXACT")
            .containsEntry("reversalOfTxnId", null);
        assertThat((BigDecimal) auditFact.get("qtyDelta")).isEqualByComparingTo("-4");
        assertThat((BigDecimal) auditFact.get("qtyOnHandAfter")).isEqualByComparingTo("6");
        assertThat(auditFact.get("sourceBillDate")).isEqualTo("2026-07-14");
        @SuppressWarnings("unchecked")
        var winnerDocument = (Map<String, Object>) materialIssueAppService.detail(winnerNo).get("document");
        assertThat(winnerDocument.get("billDate")).isEqualTo("2026-07-14");
        assertBalanceAndLedger("6");

        assertThat(successLogCount(winnerId, "AUDIT_ISSUE")).isEqualTo(1);
        assertThat(successLogCount(String.valueOf(loser.get("id")), "AUDIT_ISSUE")).isZero();
        assertThat(txnCount(String.valueOf(loser.get("id")))).isZero();

        // A repeated request while still AUDITED is rejected before inventory,
        // so neither balance nor trace facts change.
        var repeated = captureAudit(winnerNo);
        assertThat(repeated).isInstanceOf(ResponseStatusException.class);
        assertThat(txnCount(winnerId)).isEqualTo(1);
        assertBalanceAndLedger("6");

        var firstAuditTxnId = String.valueOf(auditFact.get("id"));
        materialIssueAppService.reverse(winnerNo);
        var reverseFact = jdbcTemplate.queryForMap("""
            SELECT posting_action AS "postingAction",
                   reversal_of_txn_id::text AS "reversalOfTxnId",
                   qty_delta AS "qtyDelta",
                   qty_on_hand_after AS "qtyOnHandAfter"
            FROM inv_stock_txn
            WHERE source_bill_id = ?::uuid
              AND txn_type = 'PRODUCTION_ISSUE_REVERSE'
            ORDER BY occurred_at DESC
            LIMIT 1
            """, winnerId);
        assertThat(reverseFact)
            .containsEntry("postingAction", "REVERSE")
            .containsEntry("reversalOfTxnId", firstAuditTxnId);
        assertThat((BigDecimal) reverseFact.get("qtyDelta")).isEqualByComparingTo("4");
        assertThat((BigDecimal) reverseFact.get("qtyOnHandAfter")).isEqualByComparingTo("10");
        assertBalanceAndLedger("10");

        // Re-audit after a completed reverse is a new immutable cycle, not a
        // duplicate of the reversed fact.
        materialIssueAppService.audit(winnerNo);
        assertThat(jdbcTemplate.queryForObject("""
            SELECT count(*)::int
            FROM inv_stock_txn
            WHERE source_bill_id = ?::uuid
              AND txn_type = 'PRODUCTION_ISSUE'
            """, Integer.class, winnerId)).isEqualTo(2);
        assertExactLifecycle(
            jdbcTemplate,
            new SourceDocument(
                "production_material_issue",
                "production_material_issue_line",
                "issue_id",
                "created_at",
                winnerNo
            ),
            "PRODUCTION_MATERIAL_ISSUE", productCode, warehouseCode,
            fact("PRODUCTION_ISSUE", "AUDIT", "-4", "6"),
            reversal("PRODUCTION_ISSUE_REVERSE", "REVERSE", "4", "10", 0),
            fact("PRODUCTION_ISSUE", "AUDIT", "-4", "6")
        );
        assertBalanceAndLedger("6");
    }

    @Test
    void taskPushDownKeepsEachMaterialSnapshotWarehouseWhenNoGlobalOverrideIsProvided() {
        var runId = "A176" + UUID.randomUUID().toString().substring(0, 8).toUpperCase();
        var secondProductCode = "CP-" + runId + "-B";
        var secondWarehouseCode = "CK-" + runId + "-B";
        String issueBillNo = null;
        String secondProductId = null;
        String secondWarehouseId = null;
        try {
            var taskId = jdbcTemplate.queryForObject("""
                SELECT id::text
                FROM production_task
                WHERE product_id = ?::uuid
                """, String.class, productId);
            var taskBillNo = jdbcTemplate.queryForObject("""
                SELECT bill_no
                FROM production_task
                WHERE id = ?::uuid
                """, String.class, taskId);
            jdbcTemplate.update("""
                UPDATE production_task_material_snapshot
                SET issue_warehouse_id = ?::uuid
                WHERE task_id = ?::uuid
                  AND line_no = 1
                """, warehouseId, taskId);
            secondProductId = jdbcTemplate.queryForObject("""
                INSERT INTO md_product (
                    code, name, spec, unit, product_category_id, unit_id, enabled, audit_status
                )
                SELECT ?, ?, '', unit.code, category.id, unit.id, TRUE, 'AUDITED'
                FROM md_product_category category
                CROSS JOIN md_unit unit
                WHERE category.code = 'YCL' AND unit.code = 'PCS'
                RETURNING id::text
                """, String.class, secondProductCode, runId + " 第二物料");
            secondWarehouseId = jdbcTemplate.queryForObject("""
                INSERT INTO md_warehouse (code, name, warehouse_type, enabled, audit_status)
                VALUES (?, ?, '原料仓', TRUE, 'AUDITED')
                RETURNING id::text
                """, String.class, secondWarehouseCode, runId + " 第二仓库");
            jdbcTemplate.update("""
                INSERT INTO production_task_material_snapshot (
                    task_id, line_no, product_id, unit_qty, required_qty, issued_qty, issue_warehouse_id
                )
                VALUES (?::uuid, 2, ?::uuid, 1, 3, 0, ?::uuid)
                """, taskId, secondProductId, secondWarehouseId);

            var issue = materialIssueAppService.issue(
                taskBillNo,
                new MaterialIssueAppService.IssueRequest(null, null)
            );
            issueBillNo = String.valueOf(issue.get("billNo"));

            var issueWarehouses = jdbcTemplate.queryForList("""
                SELECT l.line_no AS "lineNo", w.code AS "warehouseCode"
                FROM production_material_issue_line l
                JOIN production_material_issue i ON i.id = l.issue_id
                JOIN md_warehouse w ON w.id = l.warehouse_id
                WHERE i.bill_no = ?
                ORDER BY l.line_no
                """, issueBillNo);
            assertThat(issueWarehouses).extracting(row -> row.get("warehouseCode"))
                .containsExactly(warehouseCode, secondWarehouseCode);
        } finally {
            if (issueBillNo != null) {
                jdbcTemplate.update("DELETE FROM sys_operation_log WHERE target_no = ?", issueBillNo);
                jdbcTemplate.update("DELETE FROM production_material_issue WHERE bill_no = ?", issueBillNo);
            }
            jdbcTemplate.update("""
                DELETE FROM production_task_material_snapshot
                WHERE task_id IN (SELECT id FROM production_task WHERE product_id = ?::uuid)
                  AND line_no = 2
                """, productId);
            if (secondProductId != null) {
                jdbcTemplate.update("DELETE FROM inv_stock_balance WHERE product_id = ?::uuid", secondProductId);
                jdbcTemplate.update("DELETE FROM md_product WHERE id = ?::uuid", secondProductId);
            }
            if (secondWarehouseId != null) {
                jdbcTemplate.update("DELETE FROM md_warehouse WHERE id = ?::uuid", secondWarehouseId);
            }
        }
    }

    private Object auditAfter(CountDownLatch start, String billNo) {
        bindTenant();
        try {
            start.await();
            return materialIssueAppService.audit(billNo);
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

    private Object captureAudit(String billNo) {
        try {
            return materialIssueAppService.audit(billNo);
        } catch (ResponseStatusException exception) {
            return exception;
        }
    }

    private void bindTenant() {
        TenantContext.setTenant(accountSet);
        var request = new MockHttpServletRequest();
        request.getSession(true).setAttribute(CurrentSessionService.SESSION_USERNAME, "admin");
        RequestContextHolder.setRequestAttributes(new ServletRequestAttributes(request));
    }

    private void createFixture() {
        var runId = "A147" + UUID.randomUUID().toString().substring(0, 8).toUpperCase();
        productCode = "CP-" + runId;
        warehouseCode = "CK-" + runId;
        productId = jdbcTemplate.queryForObject("""
            INSERT INTO md_product (
                code, name, spec, unit, product_category_id, unit_id, enabled, audit_status
            )
            SELECT ?, ?, '', unit.code, category.id, unit.id, TRUE, 'AUDITED'
            FROM md_product_category category
            CROSS JOIN md_unit unit
            WHERE category.code = 'YCL' AND unit.code = 'PCS'
            RETURNING id::text
            """, String.class, productCode, runId + " 并发物料");
        warehouseId = jdbcTemplate.queryForObject("""
            INSERT INTO md_warehouse (code, name, warehouse_type, enabled, audit_status)
            VALUES (?, ?, '原料仓', TRUE, 'AUDITED')
            RETURNING id::text
            """, String.class, warehouseCode, runId + " 并发仓库");
        var bomId = jdbcTemplate.queryForObject("""
            INSERT INTO prod_bom (code, product_id, qty, enabled, is_current, audit_status)
            VALUES (?, ?::uuid, 1, FALSE, FALSE, 'AUDITED')
            RETURNING id::text
            """, String.class, "BOM-" + runId, productId);
        var planId = jdbcTemplate.queryForObject("""
            INSERT INTO production_plan (bill_no, bom_id, product_id, warehouse_id, planned_qty, status)
            VALUES (?, ?::uuid, ?::uuid, ?::uuid, 5, 'AUDITED')
            RETURNING id::text
            """, String.class, "SCJH-" + runId, bomId, productId, warehouseId);
        var taskId = jdbcTemplate.queryForObject("""
            INSERT INTO production_task (
                bill_no, bom_id, product_id, warehouse_id, qty, issued_qty,
                completed_qty, status, plan_id
            )
            VALUES (?, ?::uuid, ?::uuid, ?::uuid, 5, 0, 0, 'AUDITED', ?::uuid)
            RETURNING id::text
            """, String.class, "SCRW-" + runId, bomId, productId, warehouseId, planId);
        jdbcTemplate.update("""
            INSERT INTO production_task_material_snapshot (
                task_id, line_no, product_id, unit_qty, required_qty, issued_qty
            )
            VALUES (?::uuid, 1, ?::uuid, 1, 5, 0)
            """, taskId, productId);

        firstIssueNo = "SCLL-" + runId + "-1";
        secondIssueNo = "SCLL-" + runId + "-2";
        firstIssueId = insertIssue(taskId, firstIssueNo);
        secondIssueId = insertIssue(taskId, secondIssueNo);
        firstIssueLineId = insertIssueLine(firstIssueId, productCode, warehouseCode);
        insertIssueLine(secondIssueId, productCode, warehouseCode);

        jdbcTemplate.update("""
            INSERT INTO inv_stock_balance (
                account_set_id, product_id, warehouse_id,
                qty_on_hand, qty_available, qty_reserved
            )
            VALUES (?::uuid, ?::uuid, ?::uuid, 10, 10, 0)
            """, accountSetId, productId, warehouseId);
        var openingId = UUID.randomUUID();
        jdbcTemplate.update("""
            INSERT INTO inv_stock_txn (
                account_set_id, txn_type, product_id, warehouse_id, qty_delta,
                source_bill_type, source_bill_id, source_bill_line_id,
                source_bill_no, source_bill_date, posting_action,
                qty_on_hand_after, trace_quality, amount
            )
            VALUES (
                ?::uuid, 'OPENING_STOCK', ?::uuid, ?::uuid, 10,
                'OPENING_STOCK', ?::uuid, ?::uuid,
                ?, CURRENT_DATE, 'AUDIT', 10, 'CONTROLLED', 0
            )
            """, accountSetId, productId, warehouseId, openingId, openingId, "OPENING-" + runId);
    }

    private String insertIssue(String taskId, String billNo) {
        return jdbcTemplate.queryForObject("""
            INSERT INTO production_material_issue (bill_no, task_id, status, created_at)
            VALUES (?, ?::uuid, 'DRAFT', TIMESTAMPTZ '2026-07-13 16:30:00+00')
            RETURNING id::text
            """, String.class, billNo, taskId);
    }

    private String insertIssueLine(String issueId, String productCode, String warehouseCode) {
        return jdbcTemplate.queryForObject("""
            INSERT INTO production_material_issue_line (
                issue_id, line_no, product_id, product_code_snapshot,
                product_name_snapshot, product_spec_snapshot, warehouse_id,
                qty, unit_price, amount
            )
            VALUES (?::uuid, 1, ?::uuid, ?, ?, '', ?::uuid, 4, 1, 4)
            RETURNING id::text
            """, String.class, issueId, productId, productCode, productCode, warehouseId);
    }

    private int successLogCount(String targetId, String action) {
        return jdbcTemplate.queryForObject("""
            SELECT count(*)::int
            FROM sys_operation_log
            WHERE target_id = ?::uuid
              AND action_code = ?
              AND success = TRUE
            """, Integer.class, targetId, action);
    }

    private int txnCount(String sourceBillId) {
        return jdbcTemplate.queryForObject(
            "SELECT count(*)::int FROM inv_stock_txn WHERE source_bill_id = ?::uuid",
            Integer.class,
            sourceBillId
        );
    }

    private void cleanFixtureInForeignKeyOrder() {
        if (productId == null) {
            return;
        }
        if (firstIssueNo != null && secondIssueNo != null) {
            jdbcTemplate.update(
                "DELETE FROM sys_operation_log WHERE target_no IN (?, ?)",
                firstIssueNo,
                secondIssueNo
            );
        }
        jdbcTemplate.update("DELETE FROM inv_stock_txn WHERE product_id = ?::uuid", productId);
        jdbcTemplate.update("DELETE FROM inv_stock_balance WHERE product_id = ?::uuid", productId);
        if (firstIssueId != null && secondIssueId != null) {
            jdbcTemplate.update(
                "DELETE FROM production_material_issue WHERE id IN (?::uuid, ?::uuid)",
                firstIssueId,
                secondIssueId
            );
        }
        jdbcTemplate.update("""
            DELETE FROM production_task_material_snapshot
            WHERE product_id = ?::uuid
            """, productId);
        jdbcTemplate.update("DELETE FROM production_task WHERE product_id = ?::uuid", productId);
        jdbcTemplate.update("DELETE FROM production_plan WHERE product_id = ?::uuid", productId);
        jdbcTemplate.update("DELETE FROM prod_bom WHERE product_id = ?::uuid", productId);
        jdbcTemplate.update("DELETE FROM md_product WHERE id = ?::uuid", productId);
        if (warehouseId != null) {
            jdbcTemplate.update("DELETE FROM md_warehouse WHERE id = ?::uuid", warehouseId);
        }
    }

    private void assertFixtureResidueIsZero() {
        if (productId == null) {
            return;
        }
        var residue = jdbcTemplate.queryForObject("""
            SELECT
                (SELECT count(*) FROM inv_stock_txn WHERE product_id = ?::uuid)
              + (SELECT count(*) FROM inv_stock_balance WHERE product_id = ?::uuid)
              + (SELECT count(*) FROM production_material_issue WHERE id IN (?::uuid, ?::uuid))
              + (SELECT count(*) FROM production_material_issue_line WHERE issue_id IN (?::uuid, ?::uuid))
              + (SELECT count(*) FROM production_task_material_snapshot WHERE product_id = ?::uuid)
              + (SELECT count(*) FROM production_task WHERE product_id = ?::uuid)
              + (SELECT count(*) FROM production_plan WHERE product_id = ?::uuid)
              + (SELECT count(*) FROM prod_bom WHERE product_id = ?::uuid)
              + (SELECT count(*) FROM md_product WHERE id = ?::uuid)
              + (SELECT count(*) FROM md_warehouse WHERE id = ?::uuid)
              + (SELECT count(*) FROM sys_operation_log WHERE target_no IN (?, ?))
            """, Long.class,
            productId,
            productId,
            firstIssueId, secondIssueId,
            firstIssueId, secondIssueId,
            productId,
            productId,
            productId,
            productId,
            productId,
            warehouseId,
            firstIssueNo, secondIssueNo
        );
        assertThat(residue).isZero();
    }

    private void assertBalanceAndLedger(String expected) {
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
        assertThat((BigDecimal) row.get("balance")).isEqualByComparingTo(expected);
        assertThat((BigDecimal) row.get("ledger")).isEqualByComparingTo(expected);
        assertThat((BigDecimal) row.get("latestAfter")).isEqualByComparingTo(expected);
    }
}
