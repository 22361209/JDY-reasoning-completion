package com.jdy.erp.shared.application;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static com.jdy.erp.testsupport.InventoryTraceAssertions.assertExactLifecycle;
import static com.jdy.erp.testsupport.InventoryTraceAssertions.fact;
import static com.jdy.erp.testsupport.InventoryTraceAssertions.reversal;
import static org.mockito.ArgumentMatchers.argThat;
import static org.mockito.Mockito.doAnswer;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import java.math.BigDecimal;
import java.util.HashMap;
import java.util.Map;
import java.util.UUID;

import com.jdy.erp.finance.application.FinancePostingService;
import com.jdy.erp.purchase.application.PurchaseInAppService;
import com.jdy.erp.sales.application.SalesOutAppService;
import com.jdy.erp.system.security.CurrentSessionService;
import com.jdy.erp.system.tenant.TenantContext;
import com.jdy.erp.testsupport.InventoryTraceAssertions.SourceDocument;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.mock.web.MockHttpServletRequest;
import org.springframework.test.context.bean.override.mockito.MockitoBean;
import org.springframework.test.context.bean.override.mockito.MockitoSpyBean;
import org.springframework.web.context.request.RequestContextHolder;
import org.springframework.web.context.request.ServletRequestAttributes;
import org.springframework.web.server.ResponseStatusException;

// Deliberately not @Transactional: every assertion observes a completed service transaction.
@SpringBootTest
class RedReverseTransactionIntegrationTest {
    private static final String BILL_DATE = "2026-07-12";

    @Autowired
    private JdbcTemplate jdbcTemplate;

    @Autowired
    private SalesOutAppService salesOutAppService;

    @Autowired
    private PurchaseInAppService purchaseInAppService;

    @MockitoBean
    private CurrentSessionService currentSessionService;

    @MockitoBean
    private NumberingService numberingService;

    @MockitoSpyBean
    private FinancePostingService financePostingService;

    private String runId;
    private String accountSetId;
    private String productCode;
    private String productId;
    private String warehouseCode;
    private String warehouseId;
    private String salesOrderNo;
    private String salesSourceBillNo;
    private String salesRedBillNo;
    private String purchaseOrderNo;
    private String purchaseSourceBillNo;
    private String purchaseRedBillNo;

    @BeforeEach
    void setUpIndependentDataScope() {
        runId = "A133" + UUID.randomUUID().toString().substring(0, 8).toUpperCase();
        productCode = "CP-" + runId;
        warehouseCode = "CK-" + runId;
        salesOrderNo = "XSDD-" + runId;
        salesSourceBillNo = "XSCK-" + runId;
        salesRedBillNo = "XSCK-HC-" + runId;
        purchaseOrderNo = "CGDD-" + runId;
        purchaseSourceBillNo = "CGRK-" + runId;
        purchaseRedBillNo = "CGRK-HC-" + runId;

        accountSetId = jdbcTemplate.queryForObject(
            "SELECT id::text FROM sys_account_set WHERE code = 'BLD-TEST'",
            String.class
        );
        when(currentSessionService.currentAccountSetId()).thenReturn(accountSetId);
        when(numberingService.nextBillNo("salesOut")).thenReturn(salesRedBillNo);
        when(numberingService.nextBillNo("purchaseIn")).thenReturn(purchaseRedBillNo);
        var request = new MockHttpServletRequest();
        request.getSession(true).setAttribute(CurrentSessionService.SESSION_USERNAME, "admin");
        RequestContextHolder.setRequestAttributes(new ServletRequestAttributes(request));
        TenantContext.setTenant(jdbcTemplate.queryForMap("""
            SELECT id::text AS id, code, name, COALESCE(schema_name, '') AS "schemaName"
            FROM sys_account_set
            WHERE code = 'BLD-TEST'
            """));

        insertProduct();
        insertWarehouse();
        productId = idByCode("md_product", productCode);
        warehouseId = idByCode("md_warehouse", warehouseCode);
    }

    @AfterEach
    void cleanIndependentData() {
        try {
            jdbcTemplate.update("""
                DELETE FROM sys_operation_log
                WHERE target_id IN (
                    SELECT id FROM sales_out WHERE bill_no IN (?, ?)
                    UNION
                    SELECT id FROM purchase_in WHERE bill_no IN (?, ?)
                    UNION
                    SELECT id FROM ar_receivable WHERE source_bill_no = ?
                    UNION
                    SELECT id FROM ap_payable WHERE source_bill_no = ?
                )
                """,
                salesSourceBillNo,
                salesRedBillNo,
                purchaseSourceBillNo,
                purchaseRedBillNo,
                salesRedBillNo,
                purchaseRedBillNo
            );
            jdbcTemplate.update("DELETE FROM ar_receivable WHERE source_bill_no = ?", salesRedBillNo);
            jdbcTemplate.update("DELETE FROM ap_payable WHERE source_bill_no = ?", purchaseRedBillNo);
            if (productId != null) {
                jdbcTemplate.update("DELETE FROM inv_stock_txn WHERE product_id = ?::uuid", productId);
            }
            jdbcTemplate.update("DELETE FROM sales_out WHERE bill_no = ?", salesRedBillNo);
            jdbcTemplate.update("DELETE FROM sales_out WHERE bill_no = ?", salesSourceBillNo);
            jdbcTemplate.update("DELETE FROM purchase_in WHERE bill_no = ?", purchaseRedBillNo);
            jdbcTemplate.update("DELETE FROM purchase_in WHERE bill_no = ?", purchaseSourceBillNo);
            jdbcTemplate.update("DELETE FROM sales_order WHERE bill_no = ?", salesOrderNo);
            jdbcTemplate.update("DELETE FROM purchase_order WHERE bill_no = ?", purchaseOrderNo);
            if (productId != null) {
                jdbcTemplate.update("DELETE FROM inv_stock_balance WHERE product_id = ?::uuid", productId);
            }
            jdbcTemplate.update("DELETE FROM md_product WHERE code = ?", productCode);
            jdbcTemplate.update("DELETE FROM md_warehouse WHERE code = ?", warehouseCode);
        } finally {
            TenantContext.clear();
            RequestContextHolder.resetRequestAttributes();
        }
    }

    @Test
    void salesRedAuditCommitsThreeDomainEventsExactlyOnceAndRepeatFailureIsAudited() {
        prepareSalesFacts();
        var redBillId = createSalesRedDraft();

        salesOutAppService.audit(salesRedBillNo);

        assertThat(statusOf("sales_out", salesRedBillNo)).isEqualTo("AUDITED");
        assertThat(operationCounts(redBillId)).containsExactlyInAnyOrderEntriesOf(Map.of(
            "CREATE_RED_DRAFT", 1L,
            "AUDIT", 1L,
            "RED_REVERSE", 1L
        ));
        assertThat(operationCount(redBillId, "AUDIT", true)).isEqualTo(1);
        assertThat(operationCount(redBillId, "AUDIT", false)).isZero();
        assertStock("10", "2", "8");
        assertThat(salesShippedQty()).isEqualByComparingTo("0");
        assertThat(salesOutStatus()).isEqualTo("NOT_OUT");
        assertThat(inventoryTxnCount("SALES_OUT_RED", "SALES_OUT", salesRedBillNo, "RED_AUDIT")).isEqualTo(1);
        assertThat(financeCount("ar_receivable", salesRedBillNo)).isEqualTo(1);
        assertThat(financeAmount("ar_receivable", salesRedBillNo)).isEqualByComparingTo("-22.60");
        assertExactLifecycle(
            jdbcTemplate,
            sourceDocument("sales_out", "sales_out_line", salesRedBillNo),
            "SALES_OUT", productCode, warehouseCode,
            fact("SALES_OUT_RED", "RED_AUDIT", "2", "10")
        );

        assertThatThrownBy(() -> salesOutAppService.audit(salesRedBillNo))
            .isInstanceOf(ResponseStatusException.class)
            .hasMessageContaining("已审核");

        assertThat(operationCounts(redBillId)).containsExactlyInAnyOrderEntriesOf(Map.of(
            "CREATE_RED_DRAFT", 1L,
            "AUDIT", 2L,
            "RED_REVERSE", 1L
        ));
        assertThat(operationCount(redBillId, "AUDIT", true)).isEqualTo(1);
        assertThat(operationCount(redBillId, "AUDIT", false)).isEqualTo(1);
        assertThat(inventoryTxnCount("SALES_OUT_RED", "SALES_OUT", salesRedBillNo, "RED_AUDIT")).isEqualTo(1);
        assertThat(financeCount("ar_receivable", salesRedBillNo)).isEqualTo(1);

        salesOutAppService.reverse(salesRedBillNo);
        assertExactLifecycle(
            jdbcTemplate,
            sourceDocument("sales_out", "sales_out_line", salesRedBillNo),
            "SALES_OUT", productCode, warehouseCode,
            fact("SALES_OUT_RED", "RED_AUDIT", "2", "10"),
            reversal("SALES_OUT_RED_REVERSE", "RED_REVERSE", "-2", "8", 0)
        );
        salesOutAppService.audit(salesRedBillNo);
        assertExactLifecycle(
            jdbcTemplate,
            sourceDocument("sales_out", "sales_out_line", salesRedBillNo),
            "SALES_OUT", productCode, warehouseCode,
            fact("SALES_OUT_RED", "RED_AUDIT", "2", "10"),
            reversal("SALES_OUT_RED_REVERSE", "RED_REVERSE", "-2", "8", 0),
            fact("SALES_OUT_RED", "RED_AUDIT", "2", "10")
        );
    }

    @Test
    void purchaseRedAuditCommitsThreeDomainEventsExactlyOnceAndRepeatFailureIsAudited() {
        preparePurchaseFacts();
        var redBillId = createPurchaseRedDraft();

        purchaseInAppService.audit(purchaseRedBillNo);

        assertThat(statusOf("purchase_in", purchaseRedBillNo)).isEqualTo("AUDITED");
        assertThat(operationCounts(redBillId)).containsExactlyInAnyOrderEntriesOf(Map.of(
            "CREATE_RED_DRAFT", 1L,
            "AUDIT", 1L,
            "RED_REVERSE", 1L
        ));
        assertThat(operationCount(redBillId, "AUDIT", true)).isEqualTo(1);
        assertThat(operationCount(redBillId, "AUDIT", false)).isZero();
        assertStock("10", "0", "10");
        assertThat(purchaseReceivedQty()).isEqualByComparingTo("0");
        assertThat(purchaseInStatus()).isEqualTo("NOT_IN");
        assertThat(inventoryTxnCount("PURCHASE_IN_RED", "PURCHASE_IN", purchaseRedBillNo, "RED_AUDIT")).isEqualTo(1);
        assertThat(financeCount("ap_payable", purchaseRedBillNo)).isEqualTo(1);
        assertThat(financeAmount("ap_payable", purchaseRedBillNo)).isEqualByComparingTo("-22.60");
        assertExactLifecycle(
            jdbcTemplate,
            sourceDocument("purchase_in", "purchase_in_line", purchaseRedBillNo),
            "PURCHASE_IN", productCode, warehouseCode,
            fact("PURCHASE_IN_RED", "RED_AUDIT", "-2", "10")
        );

        assertThatThrownBy(() -> purchaseInAppService.audit(purchaseRedBillNo))
            .isInstanceOf(ResponseStatusException.class)
            .hasMessageContaining("已审核");

        assertThat(operationCounts(redBillId)).containsExactlyInAnyOrderEntriesOf(Map.of(
            "CREATE_RED_DRAFT", 1L,
            "AUDIT", 2L,
            "RED_REVERSE", 1L
        ));
        assertThat(operationCount(redBillId, "AUDIT", true)).isEqualTo(1);
        assertThat(operationCount(redBillId, "AUDIT", false)).isEqualTo(1);
        assertThat(inventoryTxnCount("PURCHASE_IN_RED", "PURCHASE_IN", purchaseRedBillNo, "RED_AUDIT")).isEqualTo(1);
        assertThat(financeCount("ap_payable", purchaseRedBillNo)).isEqualTo(1);

        purchaseInAppService.reverse(purchaseRedBillNo);
        var reversalBillNo = purchaseRedReversalBillNo();
        assertPayableFact(reversalBillNo, "22.60", "0", "OPEN");
        assertExactLifecycle(
            jdbcTemplate,
            sourceDocument("purchase_in", "purchase_in_line", purchaseRedBillNo),
            "PURCHASE_IN", productCode, warehouseCode,
            fact("PURCHASE_IN_RED", "RED_AUDIT", "-2", "10"),
            reversal("PURCHASE_IN_RED_REVERSE", "RED_REVERSE", "2", "12", 0)
        );
        purchaseInAppService.audit(purchaseRedBillNo);
        assertPayableFact(reversalBillNo, "22.60", "0", "REVERSED");
        assertThat(financeCount("ap_payable", purchaseRedBillNo)).isEqualTo(2);
        assertExactLifecycle(
            jdbcTemplate,
            sourceDocument("purchase_in", "purchase_in_line", purchaseRedBillNo),
            "PURCHASE_IN", productCode, warehouseCode,
            fact("PURCHASE_IN_RED", "RED_AUDIT", "-2", "10"),
            reversal("PURCHASE_IN_RED_REVERSE", "RED_REVERSE", "2", "12", 0),
            fact("PURCHASE_IN_RED", "RED_AUDIT", "-2", "10")
        );
    }

    @Test
    void purchaseRedReauditRollsBackWhenTheReversalFactHasBeenSettled() {
        preparePurchaseFacts();
        createPurchaseRedDraft();
        purchaseInAppService.audit(purchaseRedBillNo);
        purchaseInAppService.reverse(purchaseRedBillNo);

        var reversalBillNo = purchaseRedReversalBillNo();
        jdbcTemplate.update(
            "UPDATE ap_payable SET paid_amount = 1, status = 'PART_SETTLED' WHERE bill_no = ?",
            reversalBillNo
        );

        assertThatThrownBy(() -> purchaseInAppService.audit(purchaseRedBillNo))
            .isInstanceOfSatisfying(ResponseStatusException.class, exception -> {
                assertThat(exception.getStatusCode().value()).isEqualTo(409);
                assertThat(exception.getReason()).contains("应付反审核事实已发生核销");
        });

        assertThat(statusOf("purchase_in", purchaseRedBillNo)).isEqualTo("DRAFT");
        assertPayableFact(reversalBillNo, "22.60", "1", "PART_SETTLED");
        assertStock("12", "0", "12");
        assertExactLifecycle(
            jdbcTemplate,
            sourceDocument("purchase_in", "purchase_in_line", purchaseRedBillNo),
            "PURCHASE_IN", productCode, warehouseCode,
            fact("PURCHASE_IN_RED", "RED_AUDIT", "-2", "10"),
            reversal("PURCHASE_IN_RED_REVERSE", "RED_REVERSE", "2", "12", 0)
        );
    }

    @Test
    void salesRedAuditRollsBackAuditInventorySourceStatusFinanceAndDomainEventOnLateFailure() {
        prepareSalesFacts();
        var redBillId = createSalesRedDraft();
        doAnswer(invocation -> {
            invocation.callRealMethod();
            throw new IllegalStateException("A133 forced sales post-finance failure");
        })
            .when(financePostingService)
            .post(argThat(context -> "SALES_OUT_RED".equals(context.txnType())));

        assertThatThrownBy(() -> salesOutAppService.audit(salesRedBillNo))
            .isInstanceOf(IllegalStateException.class)
            .hasMessageContaining("forced sales post-finance failure");

        verify(financePostingService).post(argThat(context -> "SALES_OUT_RED".equals(context.txnType())));
        assertThat(statusOf("sales_out", salesRedBillNo)).isEqualTo("DRAFT");
        assertThat(operationCounts(redBillId)).containsExactlyInAnyOrderEntriesOf(Map.of("CREATE_RED_DRAFT", 1L));
        assertStock("8", "0", "8");
        assertThat(salesShippedQty()).isEqualByComparingTo("2");
        assertThat(salesOutStatus()).isEqualTo("PART_OUT");
        assertThat(inventoryTxnCount("SALES_OUT_RED", "SALES_OUT", salesRedBillNo, "RED_AUDIT")).isZero();
        assertThat(financeCount("ar_receivable", salesRedBillNo)).isZero();
    }

    @Test
    void purchaseRedAuditRollsBackAuditInventorySourceStatusFinanceAndDomainEventOnLateFailure() {
        preparePurchaseFacts();
        var redBillId = createPurchaseRedDraft();
        doAnswer(invocation -> {
            invocation.callRealMethod();
            throw new IllegalStateException("A133 forced purchase post-finance failure");
        })
            .when(financePostingService)
            .post(argThat(context -> "PURCHASE_IN_RED".equals(context.txnType())));

        assertThatThrownBy(() -> purchaseInAppService.audit(purchaseRedBillNo))
            .isInstanceOf(IllegalStateException.class)
            .hasMessageContaining("forced purchase post-finance failure");

        verify(financePostingService).post(argThat(context -> "PURCHASE_IN_RED".equals(context.txnType())));
        assertThat(statusOf("purchase_in", purchaseRedBillNo)).isEqualTo("DRAFT");
        assertThat(operationCounts(redBillId)).containsExactlyInAnyOrderEntriesOf(Map.of("CREATE_RED_DRAFT", 1L));
        assertStock("12", "0", "12");
        assertThat(purchaseReceivedQty()).isEqualByComparingTo("2");
        assertThat(purchaseInStatus()).isEqualTo("PART_IN");
        assertThat(inventoryTxnCount("PURCHASE_IN_RED", "PURCHASE_IN", purchaseRedBillNo, "RED_AUDIT")).isZero();
        assertThat(financeCount("ap_payable", purchaseRedBillNo)).isZero();
    }

    private String createSalesRedDraft() {
        var redBill = salesOutAppService.redReverse(
            salesSourceBillNo,
            new SalesOutAppService.RedReverseRequest(null, BILL_DATE, "A133")
        );
        var redBillId = String.valueOf(redBill.get("id"));
        assertThat(redBill.get("billNo")).isEqualTo(salesRedBillNo);
        assertThat(statusOf("sales_out", salesRedBillNo)).isEqualTo("DRAFT");
        assertThat(operationCounts(redBillId)).containsExactlyInAnyOrderEntriesOf(Map.of("CREATE_RED_DRAFT", 1L));
        return redBillId;
    }

    private String createPurchaseRedDraft() {
        var redBill = purchaseInAppService.redReverse(
            purchaseSourceBillNo,
            new PurchaseInAppService.RedReverseRequest(null, BILL_DATE, "A133")
        );
        var redBillId = String.valueOf(redBill.get("id"));
        assertThat(redBill.get("billNo")).isEqualTo(purchaseRedBillNo);
        assertThat(statusOf("purchase_in", purchaseRedBillNo)).isEqualTo("DRAFT");
        assertThat(operationCounts(redBillId)).containsExactlyInAnyOrderEntriesOf(Map.of("CREATE_RED_DRAFT", 1L));
        return redBillId;
    }

    private String purchaseRedReversalBillNo() {
        return jdbcTemplate.queryForObject("""
            SELECT bill_no
            FROM ap_payable
            WHERE source_bill_no = ?
              AND bill_no LIKE 'YF-HC-CX-%'
            """, String.class, purchaseRedBillNo);
    }

    private void assertPayableFact(String billNo, String amount, String paidAmount, String status) {
        var fact = jdbcTemplate.queryForMap("""
            SELECT amount,
                   paid_amount AS "paidAmount",
                   status
            FROM ap_payable
            WHERE bill_no = ?
            """, billNo);
        assertThat((BigDecimal) fact.get("amount")).isEqualByComparingTo(amount);
        assertThat((BigDecimal) fact.get("paidAmount")).isEqualByComparingTo(paidAmount);
        assertThat(fact.get("status")).isEqualTo(status);
    }

    private void prepareSalesFacts() {
        var salesOrderId = jdbcTemplate.queryForObject("""
            INSERT INTO sales_order (bill_no, customer_id, bill_date, department, status, out_status, total_amount, owner_name)
            VALUES (?, ?::uuid, DATE '2026-07-12', 'A133', 'AUDITED', 'PART_OUT', 113, 'A133')
            RETURNING id::text
            """, String.class, salesOrderNo, idByCode("md_customer", "KH-001"));
        jdbcTemplate.update("""
            INSERT INTO sales_order_line (
                order_id, line_no, product_id, warehouse_id, qty, shipped_qty,
                unit_price, amount, tax_rate, tax_amount, price_tax_total
            )
            VALUES (?::uuid, 1, ?::uuid, ?::uuid, 10, 2, 10, 100, 13, 13, 113)
            """, salesOrderId, productId, warehouseId);

        var salesOutId = jdbcTemplate.queryForObject("""
            INSERT INTO sales_out (
                bill_no, source_order_id, customer_id, bill_date, department, status, total_amount, owner_name
            )
            VALUES (?, ?::uuid, ?::uuid, DATE '2026-07-12', 'A133', 'AUDITED', 22.60, 'A133')
            RETURNING id::text
            """, String.class, salesSourceBillNo, salesOrderId, idByCode("md_customer", "KH-001"));
        jdbcTemplate.update("""
            INSERT INTO sales_out_line (
                bill_id, line_no, source_order_no, source_line_no,
                product_id, product_code_snapshot, product_name_snapshot, product_spec_snapshot,
                warehouse_id, qty, unit_price, amount, tax_rate, tax_amount, price_tax_total, line_remark
            )
            VALUES (
                ?::uuid, 1, ?, 1,
                ?::uuid, ?, ?, 'A133',
                ?::uuid, 2, 10, 20, 13, 2.60, 22.60, ''
            )
            """, salesOutId, salesOrderNo, productId, productCode, productCode, warehouseId);
        resetStock("8", "0");
    }

    private void preparePurchaseFacts() {
        var purchaseOrderId = jdbcTemplate.queryForObject("""
            INSERT INTO purchase_order (bill_no, supplier_id, bill_date, department, status, in_status, total_amount, owner_name)
            VALUES (?, ?::uuid, DATE '2026-07-12', 'A133', 'AUDITED', 'PART_IN', 113, 'A133')
            RETURNING id::text
            """, String.class, purchaseOrderNo, idByCode("md_supplier", "GYS-001"));
        jdbcTemplate.update("""
            INSERT INTO purchase_order_line (
                order_id, line_no, product_id, warehouse_id, qty, received_qty,
                unit_price, amount, tax_rate, tax_amount, price_tax_total
            )
            VALUES (?::uuid, 1, ?::uuid, ?::uuid, 10, 2, 10, 100, 13, 13, 113)
            """, purchaseOrderId, productId, warehouseId);

        var purchaseInId = jdbcTemplate.queryForObject("""
            INSERT INTO purchase_in (
                bill_no, source_order_id, supplier_id, bill_date, department, status, total_amount, owner_name
            )
            VALUES (?, ?::uuid, ?::uuid, DATE '2026-07-12', 'A133', 'AUDITED', 22.60, 'A133')
            RETURNING id::text
            """, String.class, purchaseSourceBillNo, purchaseOrderId, idByCode("md_supplier", "GYS-001"));
        jdbcTemplate.update("""
            INSERT INTO purchase_in_line (
                bill_id, line_no, source_order_no, source_line_no,
                product_id, product_code_snapshot, product_name_snapshot, product_spec_snapshot,
                warehouse_id, qty, unit_price, amount, tax_rate, tax_amount, price_tax_total, line_remark
            )
            VALUES (
                ?::uuid, 1, ?, 1,
                ?::uuid, ?, ?, 'A133',
                ?::uuid, 2, 10, 20, 13, 2.60, 22.60, ''
            )
            """, purchaseInId, purchaseOrderNo, productId, productCode, productCode, warehouseId);
        resetStock("12", "0");
    }

    private void insertProduct() {
        jdbcTemplate.update("""
            INSERT INTO md_product (code, name, spec, category, product_category_id, unit, unit_id, enabled, audit_status)
            SELECT ?, ?, 'A133', category.name, category.id, unit_ref.code, unit_ref.id, TRUE, 'AUDITED'
            FROM md_product_category category
            CROSS JOIN md_unit unit_ref
            WHERE category.name = '成品总成'
              AND category.enabled = TRUE
              AND category.audit_status = 'AUDITED'
              AND unit_ref.code = '只'
              AND unit_ref.enabled = TRUE
              AND unit_ref.audit_status = 'AUDITED'
            LIMIT 1
            """, productCode, productCode);
    }

    private void insertWarehouse() {
        jdbcTemplate.update("""
            INSERT INTO md_warehouse (code, name, allow_negative_stock, enabled, audit_status)
            VALUES (?, ?, FALSE, TRUE, 'AUDITED')
            """, warehouseCode, warehouseCode);
    }

    private void resetStock(String onHand, String reserved) {
        jdbcTemplate.update("""
            INSERT INTO inv_stock_balance (
                account_set_id, product_id, warehouse_id, qty_on_hand, qty_available, qty_reserved
            )
            VALUES (?::uuid, ?::uuid, ?::uuid, ?::numeric, (?::numeric - ?::numeric), ?::numeric)
            """, accountSetId, productId, warehouseId, onHand, onHand, reserved, reserved);
    }

    private void assertStock(String onHand, String reserved, String available) {
        var stock = jdbcTemplate.queryForMap("""
            SELECT qty_on_hand AS "onHand", qty_reserved AS reserved, qty_available AS available
            FROM inv_stock_balance
            WHERE account_set_id = ?::uuid AND product_id = ?::uuid AND warehouse_id = ?::uuid
            """, accountSetId, productId, warehouseId);
        assertThat((BigDecimal) stock.get("onHand")).isEqualByComparingTo(onHand);
        assertThat((BigDecimal) stock.get("reserved")).isEqualByComparingTo(reserved);
        assertThat((BigDecimal) stock.get("available")).isEqualByComparingTo(available);
    }

    private Map<String, Long> operationCounts(String targetId) {
        return jdbcTemplate.query("""
            SELECT action_code, COUNT(*) AS action_count
            FROM sys_operation_log
            WHERE target_id = ?::uuid
            GROUP BY action_code
            """, resultSet -> {
                var counts = new HashMap<String, Long>();
                while (resultSet.next()) {
                    counts.put(resultSet.getString("action_code"), resultSet.getLong("action_count"));
                }
                return counts;
            }, targetId);
    }

    private int operationCount(String targetId, String actionCode, boolean success) {
        return jdbcTemplate.queryForObject("""
            SELECT COUNT(*)::int
            FROM sys_operation_log
            WHERE target_id = ?::uuid
              AND action_code = ?
              AND success = ?
            """, Integer.class, targetId, actionCode, success);
    }

    private int inventoryTxnCount(String txnType, String sourceBillType, String sourceBillNo, String postingAction) {
        return jdbcTemplate.queryForObject("""
            SELECT COUNT(*)::int
            FROM inv_stock_txn
            WHERE product_id = ?::uuid
              AND txn_type = ?
              AND source_bill_type = ?
              AND source_bill_no = ?
              AND posting_action = ?
              AND trace_quality = 'EXACT'
            """, Integer.class, productId, txnType, sourceBillType, sourceBillNo, postingAction);
    }

    private SourceDocument sourceDocument(String headerTable, String lineTable, String billNo) {
        return new SourceDocument(headerTable, lineTable, "bill_id", "bill_date", billNo);
    }

    private int financeCount(String table, String sourceBillNo) {
        return jdbcTemplate.queryForObject(
            "SELECT COUNT(*)::int FROM " + table + " WHERE source_bill_no = ?",
            Integer.class,
            sourceBillNo
        );
    }

    private BigDecimal financeAmount(String table, String sourceBillNo) {
        return jdbcTemplate.queryForObject(
            "SELECT amount FROM " + table + " WHERE source_bill_no = ?",
            BigDecimal.class,
            sourceBillNo
        );
    }

    private BigDecimal salesShippedQty() {
        return jdbcTemplate.queryForObject("""
            SELECT line.shipped_qty
            FROM sales_order_line line
            JOIN sales_order bill ON bill.id = line.order_id
            WHERE bill.bill_no = ? AND line.line_no = 1
            """, BigDecimal.class, salesOrderNo);
    }

    private BigDecimal purchaseReceivedQty() {
        return jdbcTemplate.queryForObject("""
            SELECT line.received_qty
            FROM purchase_order_line line
            JOIN purchase_order bill ON bill.id = line.order_id
            WHERE bill.bill_no = ? AND line.line_no = 1
            """, BigDecimal.class, purchaseOrderNo);
    }

    private String salesOutStatus() {
        return jdbcTemplate.queryForObject(
            "SELECT out_status FROM sales_order WHERE bill_no = ?",
            String.class,
            salesOrderNo
        );
    }

    private String purchaseInStatus() {
        return jdbcTemplate.queryForObject(
            "SELECT in_status FROM purchase_order WHERE bill_no = ?",
            String.class,
            purchaseOrderNo
        );
    }

    private String statusOf(String table, String billNo) {
        return jdbcTemplate.queryForObject(
            "SELECT status FROM " + table + " WHERE bill_no = ?",
            String.class,
            billNo
        );
    }

    private String idByCode(String table, String code) {
        return jdbcTemplate.queryForObject(
            "SELECT id::text FROM " + table + " WHERE code = ?",
            String.class,
            code
        );
    }
}
