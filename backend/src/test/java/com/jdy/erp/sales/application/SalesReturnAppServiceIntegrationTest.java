package com.jdy.erp.sales.application;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.doNothing;
import static org.mockito.Mockito.when;

import java.math.BigDecimal;
import java.time.LocalDate;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;

import com.fasterxml.jackson.databind.node.LongNode;
import com.fasterxml.jackson.databind.node.TextNode;
import com.jdy.erp.reports.api.DocumentOutputController;
import com.jdy.erp.sales.application.SalesReturnAppService.SalesReturnDraftRequest;
import com.jdy.erp.sales.application.SalesReturnAppService.SalesReturnLineRequest;
import com.jdy.erp.shared.application.PostingPipeline;
import com.jdy.erp.system.application.list.ListQueryRequest;
import com.jdy.erp.system.application.list.ListQueryService;
import com.jdy.erp.system.application.list.ListSeedRowsProvider;
import com.jdy.erp.system.security.CurrentSessionService;
import com.jdy.erp.system.tenant.TenantContext;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.mock.web.MockHttpServletRequest;
import org.springframework.test.context.bean.override.mockito.MockitoBean;
import org.springframework.transaction.annotation.Propagation;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.context.request.RequestContextHolder;
import org.springframework.web.context.request.ServletRequestAttributes;
import org.springframework.web.server.ResponseStatusException;

@SpringBootTest
@Transactional
class SalesReturnAppServiceIntegrationTest {
    @Autowired
    private JdbcTemplate jdbcTemplate;

    @Autowired
    private SalesReturnAppService salesReturnAppService;

    @Autowired
    private SalesOutAppService salesOutAppService;

    @Autowired
    private ListQueryService listQueryService;

    @Autowired
    private ListSeedRowsProvider listSeedRowsProvider;

    @Autowired
    private DocumentOutputController documentOutputController;

    @MockitoBean
    private CurrentSessionService currentSessionService;

    @MockitoBean
    private PostingPipeline postingPipeline;

    private Map<String, Object> accountSet;
    private String adminDisplayName;
    private String customerId;
    private String secondCustomerId;
    private String productId;
    private String productCode;
    private String warehouseId;
    private String warehouseCode;

    @BeforeEach
    void bindTenantAndActor() {
        var admin = jdbcTemplate.queryForMap(
            "SELECT id::text AS id, display_name AS \"displayName\" FROM sys_user WHERE username = 'admin'"
        );
        var adminId = String.valueOf(admin.get("id"));
        adminDisplayName = String.valueOf(admin.get("displayName"));
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
        when(currentSessionService.currentUserId()).thenReturn(adminId);
        when(currentSessionService.currentUsername()).thenReturn("admin");
        when(currentSessionService.currentDisplayName()).thenReturn("A142 管理员");
        when(currentSessionService.currentRoleCode()).thenReturn("ADMIN");
        when(currentSessionService.currentAccountSetId()).thenReturn(String.valueOf(accountSet.get("id")));
        doNothing().when(currentSessionService).verifyPassword(any(), any());

        var request = new MockHttpServletRequest();
        request.getSession(true).setAttribute(CurrentSessionService.SESSION_USERNAME, "admin");
        RequestContextHolder.setRequestAttributes(new ServletRequestAttributes(request));
        TenantContext.setTenant(accountSet);

        var customers = jdbcTemplate.queryForList("""
            SELECT id::text AS id
            FROM md_customer
            WHERE enabled = TRUE
              AND audit_status = 'AUDITED'
            ORDER BY code
            LIMIT 2
            """);
        assertThat(customers).hasSizeGreaterThanOrEqualTo(2);
        customerId = String.valueOf(customers.get(0).get("id"));
        secondCustomerId = String.valueOf(customers.get(1).get("id"));
        var product = jdbcTemplate.queryForMap("""
            SELECT id::text AS id, code
            FROM md_product
            WHERE enabled = TRUE
              AND audit_status = 'AUDITED'
            ORDER BY code
            LIMIT 1
            """);
        productId = String.valueOf(product.get("id"));
        productCode = String.valueOf(product.get("code"));
        var warehouse = jdbcTemplate.queryForMap("""
            SELECT id::text AS id, code
            FROM md_warehouse
            WHERE enabled = TRUE
              AND audit_status = 'AUDITED'
            ORDER BY code
            LIMIT 1
            """);
        warehouseId = String.valueOf(warehouse.get("id"));
        warehouseCode = String.valueOf(warehouse.get("code"));
    }

    @AfterEach
    void clearTenantAndActor() {
        TenantContext.clear();
        RequestContextHolder.resetRequestAttributes();
    }

    @Test
    void cnyDraftCasAuditReplayReverseAndDeleteKeepInventoryAndFinanceExact() {
        var source = insertSource("CNY", customerId, "10.0000", "10.00", "13.0000", "113.00", "30.00");
        var inventoryBefore = inventoryQuantity();
        assertThat(queryList("sales-out-return-source-selector", source.billNo(), "detail"))
            .singleElement()
            .satisfies(line -> {
                assertThat(line).containsEntry("billNo", source.billNo()).containsEntry("lineNo", 1);
                assertThat((BigDecimal) line.get("remainingQty")).isEqualByComparingTo("10.0000");
            });
        assertThat(queryList("ar-receivable-settlement-source-selector", source.billNo(), "detail"))
            .singleElement()
            .satisfies(row -> assertThat(row)
                .containsEntry("receivedAmount", "30.00")
                .containsEntry("returnOffsetAmount", "0.00")
                .containsEntry("settledAmount", "30.00")
                .containsEntry("unsettledAmount", "83.00"));
        var created = salesReturnAppService.saveDraft(request(
            null,
            null,
            source.billNo(),
            new BigDecimal("9.0000"),
            "初始草稿"
        ));
        var createdDocument = document(created);
        assertThat(createdDocument)
            .containsEntry("status", "DRAFT")
            .containsEntry("currency", "CNY")
            .containsEntry("version", "0")
            .containsEntry("totalAmount", new BigDecimal("101.70"));
        assertThat(lines(created)).singleElement().satisfies(line -> {
            assertThat(line).containsEntry("sourceOutNo", source.billNo());
            assertThat(line.get("sourceQty")).isEqualTo(new BigDecimal("10.0000"));
            assertThat(line.get("returnedQty")).isEqualTo(new BigDecimal("0"));
            assertThat(line.get("remainingQty")).isEqualTo(new BigDecimal("10.0000"));
            assertThat(line).containsEntry("productCode", productCode).containsEntry("warehouseCode", warehouseCode);
        });
        assertThat(inventoryQuantity()).isEqualByComparingTo(inventoryBefore);
        assertThat(allocationCount(String.valueOf(createdDocument.get("billNo")))).isZero();
        assertThat(returnOffset(source.receivableId())).isEqualByComparingTo("0.00");

        var billNo = String.valueOf(createdDocument.get("billNo"));
        var updated = salesReturnAppService.saveDraft(request(
            billNo,
            TextNode.valueOf("0"),
            source.billNo(),
            new BigDecimal("8.0000"),
            "CAS 修改"
        ));
        assertThat(document(updated)).containsEntry("version", "1").containsEntry("remark", "CAS 修改");
        assertThatThrownBy(() -> salesReturnAppService.saveDraft(request(
            billNo,
            TextNode.valueOf("0"),
            source.billNo(),
            BigDecimal.ONE,
            "旧版本"
        ))).isInstanceOf(ResponseStatusException.class).hasMessageContaining("版本已变化");
        assertThatThrownBy(() -> salesReturnAppService.saveDraft(request(
            billNo,
            LongNode.valueOf(1),
            source.billNo(),
            BigDecimal.ONE,
            "非字符串版本"
        ))).isInstanceOf(ResponseStatusException.class).hasMessageContaining("规范非负");

        var audited = salesReturnAppService.audit(billNo);
        assertThat(document(audited))
            .containsEntry("status", "AUDITED")
            .containsEntry("version", "2")
            .containsEntry("receivableOffsetAmount", new BigDecimal("83.00"))
            .containsEntry("pendingRefundAmount", new BigDecimal("7.40"));
        assertThat(lines(audited)).singleElement().satisfies(line -> {
            assertThat(line.get("returnedQty")).isEqualTo(new BigDecimal("8.0000"));
            assertThat(line.get("remainingQty")).isEqualTo(new BigDecimal("2.0000"));
        });
        assertThat(queryList("sales-out-return-source-selector", source.billNo(), "detail"))
            .singleElement()
            .satisfies(line -> {
                assertThat((BigDecimal) line.get("returnedQty")).isEqualByComparingTo("8.0000");
                assertThat((BigDecimal) line.get("remainingQty")).isEqualByComparingTo("2.0000");
            });
        assertThat(queryList("sales-return-form-list", billNo, "header"))
            .singleElement()
            .satisfies(row -> assertThat(row).containsEntry("billNo", billNo).containsEntry("currency", "CNY"));
        assertThat(queryList("sales-return-form-list", source.billNo(), "detail"))
            .singleElement()
            .satisfies(row -> assertThat(row)
                .containsEntry("billNo", billNo)
                .containsEntry("sourceBillNo", source.billNo())
                .containsEntry("taxInclusiveUnitPrice", "11.30"));
        assertThat(queryList("ar-receivable-settlement-source-selector", source.billNo(), "detail")).isEmpty();
        assertThat(inventoryQuantity()).isEqualByComparingTo(inventoryBefore.add(new BigDecimal("8.0000")));
        assertThat(returnOffset(source.receivableId())).isEqualByComparingTo("83.00");
        assertThat(receivableStatus(source.receivableId())).isEqualTo("SETTLED");
        assertThat(allocationCount(billNo)).isEqualTo(1);
        var auditLogCount = actionLogCount("AUDIT", billNo);
        assertThat(actionLog("AUDIT", billNo))
            .containsEntry("actorUsername", "admin")
            .containsEntry("actorDisplayName", adminDisplayName)
            .containsEntry("accountSetCode", String.valueOf(accountSet.get("code")))
            .containsEntry("status", "AUDITED")
            .containsEntry("currency", "CNY")
            .containsEntry("sourceCount", 1)
            .containsEntry("quantity", new BigDecimal("8.0000"))
            .containsEntry("amount", new BigDecimal("90.40"))
            .containsEntry("settledAmount", new BigDecimal("83.00"))
            .containsEntry("outstandingAmount", new BigDecimal("7.40"));

        assertThat(document(salesReturnAppService.audit(billNo))).containsEntry("version", "2");
        assertThat(inventoryQuantity()).isEqualByComparingTo(inventoryBefore.add(new BigDecimal("8.0000")));
        assertThat(returnOffset(source.receivableId())).isEqualByComparingTo("83.00");
        assertThat(actionLogCount("AUDIT", billNo)).isEqualTo(auditLogCount);

        var reversed = salesReturnAppService.reverse(billNo);
        assertThat(document(reversed))
            .containsEntry("status", "DRAFT")
            .containsEntry("version", "3")
            .containsEntry("receivableOffsetAmount", new BigDecimal("0"))
            .containsEntry("pendingRefundAmount", new BigDecimal("0"));
        assertThat(inventoryQuantity()).isEqualByComparingTo(inventoryBefore);
        assertThat(returnOffset(source.receivableId())).isEqualByComparingTo("0.00");
        assertThat(receivableStatus(source.receivableId())).isEqualTo("PART_SETTLED");
        assertThat(allocationCount(billNo)).isZero();
        assertThat(actionLog("REVERSE", billNo))
            .containsEntry("status", "DRAFT")
            .containsEntry("quantity", new BigDecimal("8.0000"))
            .containsEntry("settledAmount", BigDecimal.ZERO)
            .containsEntry("outstandingAmount", BigDecimal.ZERO);
        assertThat(queryList("ar-receivable-settlement-source-selector", source.billNo(), "detail"))
            .singleElement()
            .satisfies(row -> assertThat(row)
                .containsEntry("receivedAmount", "30.00")
                .containsEntry("returnOffsetAmount", "0.00")
                .containsEntry("unsettledAmount", "83.00"));

        assertThat(salesReturnAppService.deleteDraft(billNo))
            .containsEntry("billNo", billNo)
            .containsEntry("status", "DELETED");
        assertThat(jdbcTemplate.queryForObject(
            "SELECT COUNT(*)::int FROM sales_return WHERE bill_no = ?",
            Integer.class,
            billNo
        )).isZero();
        assertThat(actionLogCount("DELETE", billNo)).isEqualTo(1);
    }

    @Test
    void usdSourceStaysInOriginalCurrencyAndFullyPaidArBecomesPendingRefund() {
        var source = insertSource("USD", customerId, "5.0000", "20.00", "10.0000", "110.00", "110.00");
        var inventoryBefore = inventoryQuantity();
        var draft = salesReturnAppService.saveDraft(request(
            null,
            null,
            source.billNo(),
            new BigDecimal("2.0000"),
            "USD 退货"
        ));
        var billNo = String.valueOf(document(draft).get("billNo"));
        assertThat(document(draft))
            .containsEntry("currency", "USD")
            .containsEntry("totalAmount", new BigDecimal("44.00"));

        var audited = salesReturnAppService.audit(billNo);
        assertThat(document(audited))
            .containsEntry("currency", "USD")
            .containsEntry("receivableOffsetAmount", new BigDecimal("0.00"))
            .containsEntry("pendingRefundAmount", new BigDecimal("44.00"));
        assertThat(returnOffset(source.receivableId())).isEqualByComparingTo("0.00");
        assertThat(inventoryQuantity()).isEqualByComparingTo(inventoryBefore.add(new BigDecimal("2.0000")));

        var reversed = salesReturnAppService.reverse(billNo);
        assertThat(document(reversed)).containsEntry("currency", "USD").containsEntry("status", "DRAFT");
        assertThat(inventoryQuantity()).isEqualByComparingTo(inventoryBefore);
    }

    @Test
    void documentOutputPreservesFractionalReturnQuantity() {
        var source = insertSource("CNY", customerId, "1.0000", "10.00", "13.5000", "11.35", "0.00");
        var draft = salesReturnAppService.saveDraft(request(
            null,
            null,
            source.billNo(),
            new BigDecimal("0.5000"),
            "分数数量输出"
        ));
        var billNo = String.valueOf(document(draft).get("billNo"));

        assertThat(queryList("sales-return-form-list", billNo, "header"))
            .singleElement()
            .satisfies(row -> assertThat(row).containsEntry("qty", "0.5"));
        assertThat(queryList("sales-return-form-list", billNo, "detail"))
            .singleElement()
            .satisfies(row -> assertThat(row)
                .containsEntry("qty", "0.5")
                .containsEntry("taxRate", "13.5"));
        assertThat(documentOutputController.exportCsv("sales-return", billNo).getBody())
            .contains("\"0.5\"")
            .doesNotContain("\"1\",\"10.00\"");
    }

    @Test
    @Transactional(propagation = Propagation.NOT_SUPPORTED)
    void zeroAmountDraftIsAllowedButAuditRollsBackEverySideEffect() {
        var source = insertSource("CNY", customerId, "1.0000", "0.00", "13.0000", "0.00", "0.00");
        var inventoryBefore = inventoryQuantity();
        String billNo = null;
        try {
            var draft = salesReturnAppService.saveDraft(request(
                null,
                null,
                source.billNo(),
                BigDecimal.ONE,
                "零金额草稿"
            ));
            billNo = String.valueOf(document(draft).get("billNo"));

            assertThat(document(draft)).containsEntry("status", "DRAFT");
            assertThat((BigDecimal) document(draft).get("totalAmount")).isEqualByComparingTo(BigDecimal.ZERO);
            var savedBillNo = billNo;
            assertThatThrownBy(() -> salesReturnAppService.audit(savedBillNo))
                .isInstanceOf(ResponseStatusException.class)
                .hasMessageContaining("审核金额必须大于 0");
            assertThat(document(salesReturnAppService.detail(billNo))).containsEntry("status", "DRAFT");
            assertThat(inventoryQuantity()).isEqualByComparingTo(inventoryBefore);
            assertThat(allocationCount(billNo)).isZero();
            assertThat(actionLogCount("AUDIT", billNo)).isZero();
        } finally {
            if (billNo != null) {
                var status = String.valueOf(document(salesReturnAppService.detail(billNo)).get("status"));
                if ("AUDITED".equals(status)) {
                    salesReturnAppService.reverse(billNo);
                }
                if (!"VOID".equals(status)) {
                    salesReturnAppService.deleteDraft(billNo);
                }
                jdbcTemplate.update("DELETE FROM sys_operation_log WHERE target_no = ?", billNo);
            }
            jdbcTemplate.update("DELETE FROM ar_receivable WHERE id = ?::uuid", source.receivableId());
            jdbcTemplate.update("DELETE FROM sales_out WHERE id = ?::uuid", source.salesOutId());
        }
    }

    @Test
    void draftVoidHasNoInventoryOrFinanceEffectAndLogsTheFullBusinessSummary() {
        var source = insertSource("USD", customerId, "5.0000", "20.00", "10.0000", "110.00", "0.00");
        var inventoryBefore = inventoryQuantity();
        var draft = salesReturnAppService.saveDraft(request(
            null,
            null,
            source.billNo(),
            new BigDecimal("2.0000"),
            "USD void"
        ));
        var billNo = String.valueOf(document(draft).get("billNo"));

        assertThat(salesReturnAppService.voidBill(
            billNo,
            new com.jdy.erp.shared.application.BillLifecycleService.VoidRequest("录入错误", "admin", "test-password")
        )).containsEntry("status", "VOID");

        assertThat(inventoryQuantity()).isEqualByComparingTo(inventoryBefore);
        assertThat(returnOffset(source.receivableId())).isEqualByComparingTo("0.00");
        assertThat(allocationCount(billNo)).isZero();
        assertThat(actionLog("VOID", billNo))
            .containsEntry("actorUsername", "admin")
            .containsEntry("actorDisplayName", adminDisplayName)
            .containsEntry("accountSetCode", String.valueOf(accountSet.get("code")))
            .containsEntry("status", "VOID")
            .containsEntry("currency", "USD")
            .containsEntry("sourceCount", 1)
            .containsEntry("quantity", new BigDecimal("2.0000"))
            .containsEntry("amount", new BigDecimal("44.00"))
            .containsEntry("settledAmount", new BigDecimal("0"))
            .containsEntry("outstandingAmount", new BigDecimal("0"));
    }

    @Test
    void auditRejectsOverReturnAndSaveRejectsMixedCustomerCurrencyAndRedSources() {
        var source = insertSource("CNY", customerId, "10.0000", "10.00", "13.0000", "113.00", "0.00");
        var first = salesReturnAppService.saveDraft(request(null, null, source.billNo(), new BigDecimal("6.0000"), "first"));
        var second = salesReturnAppService.saveDraft(request(null, null, source.billNo(), new BigDecimal("6.0000"), "second"));
        salesReturnAppService.audit(String.valueOf(document(first).get("billNo")));
        assertThatThrownBy(() -> salesReturnAppService.audit(String.valueOf(document(second).get("billNo"))))
            .isInstanceOf(ResponseStatusException.class)
            .hasMessageContaining("超过来源剩余可退量");
        assertThat(document(salesReturnAppService.detail(String.valueOf(document(second).get("billNo")))))
            .containsEntry("status", "DRAFT");

        var otherCustomer = insertSource("CNY", secondCustomerId, "2.0000", "10.00", "13.0000", "22.60", "0.00");
        assertThatThrownBy(() -> salesReturnAppService.saveDraft(multiSourceRequest(source.billNo(), otherCustomer.billNo())))
            .isInstanceOf(ResponseStatusException.class)
            .hasMessageContaining("不同客户");

        var otherCurrency = insertSource("USD", customerId, "2.0000", "10.00", "13.0000", "22.60", "0.00");
        assertThatThrownBy(() -> salesReturnAppService.saveDraft(multiSourceRequest(source.billNo(), otherCurrency.billNo())))
            .isInstanceOf(ResponseStatusException.class)
            .hasMessageContaining("不同币种");

        jdbcTemplate.update("""
            INSERT INTO sales_out (
                bill_no, red_source_bill_id, customer_id, bill_date, status,
                total_amount, currency, owner_name
            )
            VALUES (?, ?::uuid, ?::uuid, CURRENT_DATE, 'DRAFT', 0, 'CNY', 'A142')
            """, unique("XSCK-A142-RED"), source.salesOutId(), customerId);
        assertThatThrownBy(() -> salesReturnAppService.saveDraft(request(
            null,
            null,
            source.billNo(),
            BigDecimal.ONE,
            "red blocked"
        ))).isInstanceOf(ResponseStatusException.class).hasMessageContaining("红字单");
    }

    @Test
    void anyNonVoidSalesReturnBlocksSourceReverseAndRedCreationAfterSourceLock() {
        var source = insertSource("CNY", customerId, "3.0000", "10.00", "13.0000", "33.90", "0.00");
        salesReturnAppService.saveDraft(request(null, null, source.billNo(), BigDecimal.ONE, "mutex"));

        assertThatThrownBy(() -> salesOutAppService.reverse(source.billNo()))
            .isInstanceOf(ResponseStatusException.class)
            .hasMessageContaining("销售退货单");
        assertThatThrownBy(() -> salesOutAppService.redReverse(
            source.billNo(),
            new SalesOutAppService.RedReverseRequest(null, LocalDate.now().toString(), "A142")
        )).isInstanceOf(ResponseStatusException.class).hasMessageContaining("销售退货单");
        assertThat(jdbcTemplate.queryForObject(
            "SELECT status FROM sales_out WHERE id = ?::uuid",
            String.class,
            source.salesOutId()
        )).isEqualTo("AUDITED");
        assertThat(jdbcTemplate.queryForObject(
            "SELECT COUNT(*)::int FROM sales_out WHERE red_source_bill_id = ?::uuid",
            Integer.class,
            source.salesOutId()
        )).isZero();
    }

    @Test
    void nonVoidRedDraftBlocksSourceReverseWithTheReverseSpecificReason() {
        var source = insertSource("CNY", customerId, "3.0000", "10.00", "13.0000", "33.90", "0.00");
        var redBillNo = unique("XSCK-A142-RED");
        jdbcTemplate.update("""
            INSERT INTO sales_out (
                bill_no, red_source_bill_id, customer_id, bill_date, status,
                total_amount, currency, owner_name
            )
            VALUES (?, ?::uuid, ?::uuid, CURRENT_DATE, 'DRAFT', 0, 'CNY', 'A142')
            """, redBillNo, source.salesOutId(), customerId);

        assertThatThrownBy(() -> salesOutAppService.reverse(source.billNo()))
            .isInstanceOf(ResponseStatusException.class)
            .hasMessageContaining("销售出库单已存在非作废红字单，不能反审核");
        assertThat(jdbcTemplate.queryForObject(
            "SELECT status FROM sales_out WHERE id = ?::uuid",
            String.class,
            source.salesOutId()
        )).isEqualTo("AUDITED");
        assertThat(jdbcTemplate.queryForObject(
            "SELECT status FROM sales_out WHERE bill_no = ?",
            String.class,
            redBillNo
        )).isEqualTo("DRAFT");
    }

    @Test
    @Transactional(propagation = Propagation.NOT_SUPPORTED)
    void competingAuditsSerializeOnSourceAndOnlyOneConsumesReturnableQuantity() throws Exception {
        var source = insertSource("CNY", customerId, "10.0000", "10.00", "13.0000", "113.00", "0.00");
        var inventoryBefore = inventoryQuantity();
        var first = salesReturnAppService.saveDraft(request(
            null, null, source.billNo(), new BigDecimal("6.0000"), "concurrent first"
        ));
        var second = salesReturnAppService.saveDraft(request(
            null, null, source.billNo(), new BigDecimal("6.0000"), "concurrent second"
        ));
        var firstNo = String.valueOf(document(first).get("billNo"));
        var secondNo = String.valueOf(document(second).get("billNo"));
        var executor = Executors.newFixedThreadPool(2);
        try {
            var ready = new CountDownLatch(2);
            var start = new CountDownLatch(1);
            var firstFuture = executor.submit(() -> concurrentAudit(firstNo, ready, start));
            var secondFuture = executor.submit(() -> concurrentAudit(secondNo, ready, start));
            assertThat(ready.await(10, TimeUnit.SECONDS)).isTrue();
            start.countDown();

            assertThat(List.of(
                firstFuture.get(15, TimeUnit.SECONDS),
                secondFuture.get(15, TimeUnit.SECONDS)
            )).containsExactlyInAnyOrder("AUDITED", "CONFLICT");
            var statuses = jdbcTemplate.queryForList("""
                SELECT bill_no AS "billNo", status
                FROM sales_return
                WHERE bill_no IN (?, ?)
                ORDER BY bill_no
                """, firstNo, secondNo);
            assertThat(statuses).extracting(row -> row.get("status"))
                .containsExactlyInAnyOrder("AUDITED", "DRAFT");
            assertThat(inventoryQuantity()).isEqualByComparingTo(inventoryBefore.add(new BigDecimal("6.0000")));
            assertThat(returnOffset(source.receivableId())).isEqualByComparingTo("67.80");
            assertThat(jdbcTemplate.queryForObject("""
                SELECT COUNT(*)::int
                FROM sales_return_finance_allocation allocation
                JOIN sales_return header ON header.id = allocation.sales_return_id
                WHERE header.bill_no IN (?, ?)
                """, Integer.class, firstNo, secondNo)).isEqualTo(1);

            var auditedNo = statuses.stream()
                .filter(row -> "AUDITED".equals(row.get("status")))
                .map(row -> String.valueOf(row.get("billNo")))
                .findFirst()
                .orElseThrow();
            salesReturnAppService.reverse(auditedNo);
            salesReturnAppService.deleteDraft(firstNo);
            salesReturnAppService.deleteDraft(secondNo);
            assertThat(inventoryQuantity()).isEqualByComparingTo(inventoryBefore);
        } finally {
            executor.shutdownNow();
            jdbcTemplate.update("DELETE FROM sys_operation_log WHERE target_no IN (?, ?)", firstNo, secondNo);
            jdbcTemplate.update("DELETE FROM sales_return WHERE bill_no IN (?, ?)", firstNo, secondNo);
            jdbcTemplate.update("DELETE FROM ar_receivable WHERE id = ?::uuid", source.receivableId());
            jdbcTemplate.update("DELETE FROM sales_out WHERE id = ?::uuid", source.salesOutId());
            jdbcTemplate.update(
                "DELETE FROM inv_stock_txn WHERE source_bill_type LIKE ? OR source_bill_type LIKE ?",
                "%" + firstNo + "%",
                "%" + secondNo + "%"
            );
        }
    }

    private String concurrentAudit(String billNo, CountDownLatch ready, CountDownLatch start) {
        try {
            var request = new MockHttpServletRequest();
            request.getSession(true).setAttribute(CurrentSessionService.SESSION_USERNAME, "admin");
            RequestContextHolder.setRequestAttributes(new ServletRequestAttributes(request));
            TenantContext.setTenant(accountSet);
            ready.countDown();
            if (!start.await(10, TimeUnit.SECONDS)) {
                return "TIMEOUT";
            }
            return String.valueOf(document(salesReturnAppService.audit(billNo)).get("status"));
        } catch (ResponseStatusException exception) {
            return exception.getStatusCode().value() == 409 ? "CONFLICT" : "HTTP_" + exception.getStatusCode().value();
        } catch (InterruptedException exception) {
            Thread.currentThread().interrupt();
            return "INTERRUPTED";
        } finally {
            TenantContext.clear();
            RequestContextHolder.resetRequestAttributes();
        }
    }

    private SourceFixture insertSource(
        String currency,
        String sourceCustomerId,
        String qty,
        String unitPrice,
        String taxRate,
        String receivableAmount,
        String receivedAmount
    ) {
        var billNo = unique("XSCK-A142");
        var salesOutId = jdbcTemplate.queryForObject("""
            INSERT INTO sales_out (
                bill_no, customer_id, bill_date, status, total_amount,
                currency, owner_name, remark
            )
            VALUES (?, ?::uuid, DATE '2026-07-14', 'AUDITED', ?, ?, 'A142', 'A142 fixture')
            RETURNING id::text
            """, String.class, billNo, sourceCustomerId, new BigDecimal(receivableAmount), currency);
        jdbcTemplate.update("""
            INSERT INTO sales_out_line (
                bill_id, line_no, product_id, product_code_snapshot,
                product_name_snapshot, product_spec_snapshot, product_unit_snapshot,
                warehouse_id, qty, unit_price, amount, tax_rate, tax_amount,
                price_tax_total, line_remark
            )
            SELECT ?::uuid, 1, product.id, product.code, product.name,
                   COALESCE(product.spec, ''), product.unit, ?::uuid, ?, ?,
                   round(? * ?, 2), ?, round(round(? * ?, 2) * ? / 100, 2),
                   ?, 'A142 source line'
            FROM md_product product
            WHERE product.id = ?::uuid
            """,
            salesOutId,
            warehouseId,
            new BigDecimal(qty),
            new BigDecimal(unitPrice),
            new BigDecimal(qty),
            new BigDecimal(unitPrice),
            new BigDecimal(taxRate),
            new BigDecimal(qty),
            new BigDecimal(unitPrice),
            new BigDecimal(taxRate),
            new BigDecimal(receivableAmount),
            productId
        );
        var receivableId = jdbcTemplate.queryForObject("""
            INSERT INTO ar_receivable (
                bill_no, source_bill_no, customer_id, bill_date, currency,
                amount, received_amount, return_offset_amount, status
            )
            VALUES (?, ?, ?::uuid, DATE '2026-07-14', ?, ?, ?, 0, ?)
            RETURNING id::text
            """,
            String.class,
            unique("YS-A142"),
            billNo,
            sourceCustomerId,
            currency,
            new BigDecimal(receivableAmount),
            new BigDecimal(receivedAmount),
            settlementStatus(new BigDecimal(receivableAmount), new BigDecimal(receivedAmount))
        );
        return new SourceFixture(salesOutId, billNo, receivableId);
    }

    private String settlementStatus(BigDecimal amount, BigDecimal settled) {
        if (settled.compareTo(BigDecimal.ZERO) == 0) {
            return "OPEN";
        }
        return settled.compareTo(amount) == 0 ? "SETTLED" : "PART_SETTLED";
    }

    private SalesReturnDraftRequest request(
        String billNo,
        com.fasterxml.jackson.databind.JsonNode version,
        String sourceOutNo,
        BigDecimal qty,
        String remark
    ) {
        return new SalesReturnDraftRequest(
            billNo,
            version,
            "2026-07-14",
            remark,
            List.of(new SalesReturnLineRequest(sourceOutNo, 1, qty, "A142 line"))
        );
    }

    private SalesReturnDraftRequest multiSourceRequest(String first, String second) {
        return new SalesReturnDraftRequest(
            null,
            null,
            "2026-07-14",
            "multi source",
            List.of(
                new SalesReturnLineRequest(first, 1, BigDecimal.ONE, null),
                new SalesReturnLineRequest(second, 1, BigDecimal.ONE, null)
            )
        );
    }

    @SuppressWarnings("unchecked")
    private Map<String, Object> document(Map<String, Object> result) {
        return (Map<String, Object>) result.get("document");
    }

    @SuppressWarnings("unchecked")
    private List<Map<String, Object>> lines(Map<String, Object> result) {
        return (List<Map<String, Object>>) result.get("lines");
    }

    private BigDecimal inventoryQuantity() {
        var value = jdbcTemplate.queryForObject("""
            SELECT COALESCE(SUM(balance.qty_on_hand), 0)
            FROM inv_stock_balance balance
            WHERE balance.product_id = ?::uuid
              AND balance.warehouse_id = ?::uuid
            """, BigDecimal.class, productId, warehouseId);
        return value == null ? BigDecimal.ZERO : value;
    }

    private BigDecimal returnOffset(String receivableId) {
        return jdbcTemplate.queryForObject(
            "SELECT return_offset_amount FROM ar_receivable WHERE id = ?::uuid",
            BigDecimal.class,
            receivableId
        );
    }

    private String receivableStatus(String receivableId) {
        return jdbcTemplate.queryForObject(
            "SELECT status FROM ar_receivable WHERE id = ?::uuid",
            String.class,
            receivableId
        );
    }

    private int allocationCount(String billNo) {
        var value = jdbcTemplate.queryForObject("""
            SELECT COUNT(*)::int
            FROM sales_return_finance_allocation allocation
            JOIN sales_return header ON header.id = allocation.sales_return_id
            WHERE header.bill_no = ?
            """, Integer.class, billNo);
        return value == null ? 0 : value;
    }

    private int actionLogCount(String action, String billNo) {
        var value = jdbcTemplate.queryForObject("""
            SELECT COUNT(*)::int
            FROM sys_operation_log
            WHERE action_code = ?
              AND target_no = ?
            """, Integer.class, action, billNo);
        return value == null ? 0 : value;
    }

    private Map<String, Object> actionLog(String action, String billNo) {
        return jdbcTemplate.queryForMap("""
            SELECT actor_username AS "actorUsername",
                   actor_display_name AS "actorDisplayName",
                   account_set_code AS "accountSetCode",
                   after_state ->> 'status' AS status,
                   after_state ->> 'currency' AS currency,
                   (after_state ->> 'sourceCount')::int AS "sourceCount",
                   (after_state ->> 'quantity')::numeric AS quantity,
                   (after_state ->> 'amount')::numeric AS amount,
                   (after_state ->> 'settledAmount')::numeric AS "settledAmount",
                   (after_state ->> 'outstandingAmount')::numeric AS "outstandingAmount"
            FROM sys_operation_log
            WHERE action_code = ?
              AND target_no = ?
              AND success = TRUE
            ORDER BY operated_at DESC
            LIMIT 1
            """, action, billNo);
    }

    @SuppressWarnings("unchecked")
    private List<Map<String, Object>> queryList(String listKey, String keyword, String view) {
        var result = listQueryService.query(new ListQueryRequest(
            listKey,
            keyword,
            "",
            1,
            200,
            view,
            "",
            "asc",
            "",
            "",
            "",
            "",
            "",
            "",
            "current",
            "",
            "",
            false
        ), listSeedRowsProvider);
        return (List<Map<String, Object>>) (List<?>) result.rows();
    }

    private String unique(String prefix) {
        return prefix + "-" + Long.toUnsignedString(System.nanoTime(), 36).toUpperCase();
    }

    private record SourceFixture(String salesOutId, String billNo, String receivableId) {
    }
}
