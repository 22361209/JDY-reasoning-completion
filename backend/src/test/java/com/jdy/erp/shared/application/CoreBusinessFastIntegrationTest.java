package com.jdy.erp.shared.application;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.doNothing;
import static org.mockito.Mockito.when;

import java.math.BigDecimal;
import java.time.LocalDate;
import java.util.List;
import java.util.Map;

import com.jdy.erp.inventory.application.InventoryPostingService;
import com.jdy.erp.sales.application.DeliveryNoticeAppService;
import com.jdy.erp.sales.application.SalesOrderAppService;
import com.jdy.erp.shared.application.BillLifecycleService.BillLifecycleTarget;
import com.jdy.erp.shared.application.BillLifecycleService.VoidRequest;
import com.jdy.erp.shared.application.ConversionService.SourceExecutionSpec;
import com.jdy.erp.shared.domain.BillStatus;
import com.jdy.erp.system.security.CurrentSessionService;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.context.bean.override.mockito.MockitoBean;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.server.ResponseStatusException;

@SpringBootTest
@Transactional
class CoreBusinessFastIntegrationTest {
    private static final BillLifecycleTarget SALES_ORDER_TARGET =
        new BillLifecycleTarget("sales_order", "sales_order_line", "order_id", "SALES", "sales_order");

    @Autowired
    private JdbcTemplate jdbcTemplate;

    @Autowired
    private BillLifecycleService lifecycleService;

    @Autowired
    private InventoryPostingService inventoryPostingService;

    @Autowired
    private PostingPipeline postingPipeline;

    @Autowired
    private SalesOrderAppService salesOrderAppService;

    @Autowired
    private DeliveryNoticeAppService deliveryNoticeAppService;

    @MockitoBean
    private CurrentSessionService currentSessionService;

    @BeforeEach
    void mockCurrentSession() {
        var adminId = jdbcTemplate.queryForObject("SELECT id::text FROM sys_user WHERE username = 'admin'", String.class);
        when(currentSessionService.currentUserId()).thenReturn(adminId);
        when(currentSessionService.currentUsername()).thenReturn("admin");
        when(currentSessionService.currentRoleCode()).thenReturn("ADMIN");
        doNothing().when(currentSessionService).verifyPassword(any(), any());
    }

    @Test
    void billLifecycleAuditsAndReversesBackToDraft() {
        var billNo = billNo("XSDD-A111-LC");
        insertSalesOrder(billNo, "DRAFT");

        var audited = lifecycleService.transition("sales_order", billNo, BillStatus.DRAFT, BillStatus.AUDITED);
        var reversed = lifecycleService.transition("sales_order", billNo, BillStatus.AUDITED, BillStatus.DRAFT);

        assertThat(audited.get("status")).isEqualTo("AUDITED");
        assertThat(reversed.get("status")).isEqualTo("DRAFT");
        assertThat(statusOf("sales_order", billNo)).isEqualTo("DRAFT");
    }

    @Test
    void billLifecycleClosesFreezesAndBlocksExecutableSourceLines() {
        var closedBillNo = billNo("XSDD-A111-CLOSE");
        var frozenBillNo = billNo("XSDD-A111-FREEZE");
        insertSalesOrder(closedBillNo, "AUDITED");
        insertSalesOrder(frozenBillNo, "AUDITED");

        var closed = lifecycleService.closeBill(SALES_ORDER_TARGET, closedBillNo, "A111 close");
        var frozen = lifecycleService.freezeBill(SALES_ORDER_TARGET, frozenBillNo, "A111 freeze");

        assertThat(closed.get("closeStatus")).isEqualTo("CLOSED");
        assertThat(frozen.get("frozenStatus")).isEqualTo("FROZEN");
        assertThatThrownBy(() -> lifecycleService.guardExecutableSourceLine(sourceSpec(), idOf("sales_order", closedBillNo), 1))
            .isInstanceOf(ResponseStatusException.class)
            .hasMessageContaining("源单或源单行已关闭/冻结");
        assertThatThrownBy(() -> lifecycleService.guardExecutableSourceLine(sourceSpec(), idOf("sales_order", frozenBillNo), 1))
            .isInstanceOf(ResponseStatusException.class)
            .hasMessageContaining("源单或源单行已关闭/冻结");
    }

    @Test
    void billLifecycleVoidBlocksWhenDownstreamExists() {
        var billNo = billNo("XSDD-A111-VOID");
        insertSalesOrder(billNo, "DRAFT");
        insertDeliveryNoticeFromOrder(billNo);

        assertThatThrownBy(() -> lifecycleService.voidBill(SALES_ORDER_TARGET, billNo, new VoidRequest("A111 void", "admin", "admin123")))
            .isInstanceOf(ResponseStatusException.class)
            .hasMessageContaining("已有下游影响");
        assertThat(statusOf("sales_order", billNo)).isEqualTo("DRAFT");
    }

    @Test
    void postingPipelineCoversInventoryAndFinancePosting() {
        var sourceBillNo = billNo("XSCK-A111-POST");
        resetStock("CP-001", "CK-001", "10", "0");

        postingPipeline.post(new PostingContext("INVENTORY", "CP-001", "CK-001", new BigDecimal("5"), "A111_IN", "A111_POST"));
        postingPipeline.post(new PostingContext(
            "FINANCE",
            null,
            null,
            null,
            "SALES_OUT",
            "sales_out",
            sourceBillNo,
            customerId("KH-001"),
            LocalDate.of(2026, 6, 26),
            new BigDecimal("123.45")
        ));

        assertStock("CP-001", "CK-001", "15.0000", "0.0000", "15.0000");
        assertThat(jdbcTemplate.queryForObject("SELECT amount FROM ar_receivable WHERE source_bill_no = ?", BigDecimal.class, sourceBillNo))
            .isEqualByComparingTo("123.45");
    }

    @Test
    void reservationKeepsAvailableEqualOnHandMinusReservedAndNonNegative() {
        resetStock("CP-001", "CK-001", "20", "0");

        inventoryPostingService.reserve("CP-001", "CK-001", new BigDecimal("7"), "A111_RESERVE", "A111");
        assertStock("CP-001", "CK-001", "20.0000", "7.0000", "13.0000");

        inventoryPostingService.shipReserved("CP-001", "CK-001", new BigDecimal("5"), "A111_SHIP", "A111");
        assertStock("CP-001", "CK-001", "15.0000", "2.0000", "13.0000");

        inventoryPostingService.reverseShipReserved("CP-001", "CK-001", new BigDecimal("5"), "A111_SHIP_REVERSE", "A111");
        assertStock("CP-001", "CK-001", "20.0000", "7.0000", "13.0000");

        inventoryPostingService.releaseReservation("CP-001", "CK-001", new BigDecimal("7"), "A111_RELEASE", "A111");
        assertStock("CP-001", "CK-001", "20.0000", "0.0000", "20.0000");

        assertThatThrownBy(() -> inventoryPostingService.reserve("CP-001", "CK-001", new BigDecimal("21"), "A111_OVER_RESERVE", "A111"))
            .isInstanceOf(ResponseStatusException.class)
            .hasMessageContaining("可用库存不足");
    }

    @Test
    void purchaseInTransitAggregatesAuditedUnreceivedPurchaseOrderRemainders() {
        var productCode = billNo("CP-A109-IT");
        var warehouseCode = billNo("CK-A109-IT");
        var salesBillNo = billNo("XSDD-A109-IT");
        var deliveryBillNo = billNo("FHTZD-A109-IT");
        insertProduct(productCode);
        insertWarehouse(warehouseCode);
        insertSalesOrder(salesBillNo, "AUDITED", productCode, warehouseCode);
        insertDeliveryNotice(deliveryBillNo, "AUDITED", productCode, warehouseCode);

        assertTransit(firstLine(salesOrderAppService.detail(salesBillNo)), "0");
        assertTransit(firstLine(deliveryNoticeAppService.stockSnapshot(deliveryBillNo)), "0");

        insertPurchaseOrderLine("CGDD-A109-IT-1", "AUDITED", productCode, warehouseCode, "10", "3");
        assertTransit(firstLine(salesOrderAppService.detail(salesBillNo)), "7");

        insertPurchaseOrderLine("CGDD-A109-IT-2", "AUDITED", productCode, warehouseCode, "5", "0");
        insertPurchaseOrderLine("CGDD-A109-IT-DRAFT", "DRAFT", productCode, warehouseCode, "20", "0");
        insertPurchaseOrderLine("CGDD-A109-IT-FULL", "AUDITED", productCode, warehouseCode, "8", "8");
        insertPurchaseOrderLine("CGDD-A109-IT-OVER", "AUDITED", productCode, warehouseCode, "2", "3");

        assertTransit(firstLine(salesOrderAppService.detail(salesBillNo)), "12");
        assertTransit(lineByBillNo(salesOrderAppService.selectableLines("KH-001"), salesBillNo), "12");
        assertTransit(firstLine(deliveryNoticeAppService.detail(deliveryBillNo)), "12");
        assertTransit(lineByBillNo(deliveryNoticeAppService.selectableLines("KH-001"), deliveryBillNo), "12");
        assertTransit(firstLine(deliveryNoticeAppService.stockSnapshot(deliveryBillNo)), "12");
    }

    private void insertSalesOrder(String billNo, String status) {
        insertSalesOrder(billNo, status, "CP-001", "CK-001");
    }

    private void insertSalesOrder(String billNo, String status, String productCode, String warehouseCode) {
        var orderId = jdbcTemplate.queryForObject("""
            INSERT INTO sales_order (bill_no, customer_id, bill_date, department, status, total_amount, owner_name)
            VALUES (?, ?::uuid, DATE '2026-06-26', 'A111', ?, 100, 'A111')
            RETURNING id::text
            """, String.class, billNo, customerId("KH-001"), status);
        jdbcTemplate.update("""
            INSERT INTO sales_order_line (order_id, line_no, product_id, warehouse_id, qty, unit_price, amount)
            VALUES (?::uuid, 1, ?::uuid, ?::uuid, 1, 100, 100)
            """, orderId, productId(productCode), warehouseId(warehouseCode));
    }

    private void insertDeliveryNoticeFromOrder(String sourceOrderNo) {
        var noticeId = jdbcTemplate.queryForObject("""
            INSERT INTO delivery_notice (bill_no, customer_id, bill_date, status, total_amount, owner_name)
            VALUES (?, ?::uuid, DATE '2026-06-26', 'DRAFT', 100, 'A111')
            RETURNING id::text
            """, String.class, billNo("FHTZD-A111-VOID"), customerId("KH-001"));
        jdbcTemplate.update("""
            INSERT INTO delivery_notice_line (bill_id, line_no, source_order_no, source_line_no, product_id, warehouse_id, qty, unit_price, amount, tax_amount, price_tax_total)
            VALUES (?::uuid, 1, ?, 1, ?::uuid, ?::uuid, 1, 100, 100, 13, 113)
            """, noticeId, sourceOrderNo, productId("CP-001"), warehouseId("CK-001"));
    }

    private void insertDeliveryNotice(String billNo, String status, String productCode, String warehouseCode) {
        var noticeId = jdbcTemplate.queryForObject("""
            INSERT INTO delivery_notice (bill_no, customer_id, bill_date, status, total_amount, owner_name)
            VALUES (?, ?::uuid, DATE '2026-06-26', ?, 100, 'A109')
            RETURNING id::text
            """, String.class, billNo, customerId("KH-001"), status);
        jdbcTemplate.update("""
            INSERT INTO delivery_notice_line (bill_id, line_no, product_id, warehouse_id, qty, unit_price, amount, tax_amount, price_tax_total)
            VALUES (?::uuid, 1, ?::uuid, ?::uuid, 1, 100, 100, 13, 113)
            """, noticeId, productId(productCode), warehouseId(warehouseCode));
    }

    private void insertPurchaseOrderLine(String billNoPrefix, String status, String productCode, String warehouseCode, String qty, String receivedQty) {
        var orderId = jdbcTemplate.queryForObject("""
            INSERT INTO purchase_order (bill_no, supplier_id, bill_date, department, status, total_amount, owner_name)
            VALUES (?, ?::uuid, DATE '2026-06-26', 'A109', ?, 100, 'A109')
            RETURNING id::text
            """, String.class, billNo(billNoPrefix), supplierId("GYS-001"), status);
        jdbcTemplate.update("""
            INSERT INTO purchase_order_line (order_id, line_no, product_id, warehouse_id, qty, received_qty, unit_price, amount)
            VALUES (?::uuid, 1, ?::uuid, ?::uuid, ?::numeric, ?::numeric, 10, 100)
            """, orderId, productId(productCode), warehouseId(warehouseCode), qty, receivedQty);
    }

    private void insertProduct(String code) {
        jdbcTemplate.update("""
            INSERT INTO md_product (code, name, spec, category, unit, enabled)
            VALUES (?, ?, 'A109', '成品总成', '只', TRUE)
            """, code, code);
    }

    private void insertWarehouse(String code) {
        jdbcTemplate.update("""
            INSERT INTO md_warehouse (code, name, allow_negative_stock, enabled)
            VALUES (?, ?, FALSE, TRUE)
            """, code, code);
    }

    private void resetStock(String productCode, String warehouseCode, String onHand, String reserved) {
        jdbcTemplate.update("""
            INSERT INTO inv_stock_balance (product_id, warehouse_id, qty_on_hand, qty_available, qty_reserved)
            VALUES (?::uuid, ?::uuid, ?::numeric, (?::numeric - ?::numeric), ?::numeric)
            ON CONFLICT (product_id, warehouse_id) DO UPDATE
            SET qty_on_hand = EXCLUDED.qty_on_hand,
                qty_available = EXCLUDED.qty_available,
                qty_reserved = EXCLUDED.qty_reserved,
                updated_at = now()
            """, productId(productCode), warehouseId(warehouseCode), onHand, onHand, reserved, reserved);
    }

    private void assertStock(String productCode, String warehouseCode, String onHand, String reserved, String available) {
        var row = jdbcTemplate.queryForMap("""
            SELECT b.qty_on_hand AS "onHand", b.qty_reserved AS reserved, b.qty_available AS available
            FROM inv_stock_balance b
            WHERE b.product_id = ?::uuid AND b.warehouse_id = ?::uuid
            """, productId(productCode), warehouseId(warehouseCode));
        assertThat((BigDecimal) row.get("onHand")).isEqualByComparingTo(onHand);
        assertThat((BigDecimal) row.get("reserved")).isEqualByComparingTo(reserved);
        assertThat((BigDecimal) row.get("available")).isEqualByComparingTo(available);
        assertThat((BigDecimal) row.get("available"))
            .isEqualByComparingTo(((BigDecimal) row.get("onHand")).subtract((BigDecimal) row.get("reserved")));
    }

    private SourceExecutionSpec sourceSpec() {
        return new SourceExecutionSpec("sales_order", "sales_order_line", "order_id", "line_no", "out_qty", "qty", "out_status", "over");
    }

    private String statusOf(String table, String billNo) {
        return jdbcTemplate.queryForObject("SELECT status FROM " + table + " WHERE bill_no = ?", String.class, billNo);
    }

    private String idOf(String table, String billNo) {
        return jdbcTemplate.queryForObject("SELECT id::text FROM " + table + " WHERE bill_no = ?", String.class, billNo);
    }

    private String customerId(String code) {
        return idByCode("md_customer", code);
    }

    private String productId(String code) {
        return idByCode("md_product", code);
    }

    private String supplierId(String code) {
        return idByCode("md_supplier", code);
    }

    private String warehouseId(String code) {
        return idByCode("md_warehouse", code);
    }

    private String idByCode(String table, String code) {
        return jdbcTemplate.queryForObject("SELECT id::text FROM " + table + " WHERE code = ?", String.class, code);
    }

    private String billNo(String prefix) {
        return prefix + "-" + System.nanoTime();
    }

    @SuppressWarnings("unchecked")
    private Map<String, Object> firstLine(Map<String, Object> payload) {
        return ((List<Map<String, Object>>) payload.get("lines")).get(0);
    }

    @SuppressWarnings("unchecked")
    private Map<String, Object> lineByBillNo(Map<String, Object> payload, String billNo) {
        return ((List<Map<String, Object>>) payload.get("lines")).stream()
            .filter(line -> billNo.equals(line.get("billNo")))
            .findFirst()
            .orElseThrow();
    }

    private void assertTransit(Map<String, Object> line, String expected) {
        assertThat((BigDecimal) line.get("stockInTransit")).isEqualByComparingTo(expected);
    }
}
