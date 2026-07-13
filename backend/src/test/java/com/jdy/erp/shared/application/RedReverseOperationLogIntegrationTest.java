package com.jdy.erp.shared.application;

import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.ArgumentMatchers.argThat;
import static org.mockito.ArgumentMatchers.contains;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.inOrder;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.verifyNoMoreInteractions;
import static org.mockito.Mockito.when;

import java.math.BigDecimal;
import java.time.LocalDate;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

import com.jdy.erp.inventory.application.InventoryPostingService;
import com.jdy.erp.purchase.application.PurchaseInAppService;
import com.jdy.erp.sales.application.SalesOutAppService;
import com.jdy.erp.shared.application.ConversionService.SourceExecutionSpec;
import com.jdy.erp.shared.domain.BillStatus;
import com.jdy.erp.system.security.CurrentSessionService;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.InOrder;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.web.server.ResponseStatusException;

@ExtendWith(MockitoExtension.class)
class RedReverseOperationLogIntegrationTest {
    private static final String RED_BILL_NO = "RED000001";
    private static final String SOURCE_BILL_NO = "SOURCE000001";
    private static final String RED_BILL_ID = "00000000-0000-0000-0000-000000000101";
    private static final String SOURCE_BILL_ID = "00000000-0000-0000-0000-000000000102";
    private static final String PARTY_ID = "00000000-0000-0000-0000-000000000103";
    private static final String PRODUCT_ID = "00000000-0000-0000-0000-000000000104";
    private static final String WAREHOUSE_ID = "00000000-0000-0000-0000-000000000105";

    @Mock
    private JdbcTemplate jdbcTemplate;
    @Mock
    private LookupService lookupService;
    @Mock
    private ValidationService validationService;
    @Mock
    private BillLifecycleService lifecycleService;
    @Mock
    private PostingPipeline postingPipeline;
    @Mock
    private ConversionService conversionService;
    @Mock
    private OperationLogService operationLogService;
    @Mock
    private NumberingService numberingService;
    @Mock
    private CurrentSessionService currentSessionService;
    @Mock
    private TaxAmountCalculator taxAmountCalculator;
    @Mock
    private InventoryPostingService inventoryPostingService;
    @Mock
    private ProductSnapshotService productSnapshotService;
    @Mock
    private RedReverseGuardService redReverseGuardService;

    private SalesOutAppService salesOutAppService;
    private PurchaseInAppService purchaseInAppService;

    @BeforeEach
    void setUp() {
        salesOutAppService = new SalesOutAppService(
            jdbcTemplate,
            lookupService,
            validationService,
            lifecycleService,
            postingPipeline,
            conversionService,
            operationLogService,
            numberingService,
            currentSessionService,
            taxAmountCalculator,
            inventoryPostingService,
            productSnapshotService,
            redReverseGuardService
        );
        purchaseInAppService = new PurchaseInAppService(
            jdbcTemplate,
            lookupService,
            validationService,
            lifecycleService,
            postingPipeline,
            conversionService,
            operationLogService,
            numberingService,
            taxAmountCalculator,
            productSnapshotService,
            redReverseGuardService
        );
    }

    @Test
    void salesRedDraftWritesOnlyCreateDraftEvent() {
        stubSalesRedDraft();

        salesOutAppService.redReverse(
            SOURCE_BILL_NO,
            new SalesOutAppService.RedReverseRequest(null, "2026-07-12", "tester")
        );

        verify(operationLogService).logCurrent(argThat(command ->
            matches(command, "SALES", "CREATE_RED_DRAFT", "sales_out", "DRAFT")
        ));
        verifyNoMoreInteractions(operationLogService);
    }

    @Test
    void purchaseRedDraftWritesOnlyCreateDraftEvent() {
        stubPurchaseRedDraft();

        purchaseInAppService.redReverse(
            SOURCE_BILL_NO,
            new PurchaseInAppService.RedReverseRequest(null, "2026-07-12", "tester")
        );

        verify(operationLogService).logCurrent(argThat(command ->
            matches(command, "PURCHASE", "CREATE_RED_DRAFT", "purchase_in", "DRAFT")
        ));
        verifyNoMoreInteractions(operationLogService);
    }

    @Test
    void salesRedAuditLogsDomainEventAfterAllReverseFacts() {
        stubSalesRedAudit(true);

        salesOutAppService.audit(RED_BILL_NO);

        InOrder order = inOrder(inventoryPostingService, conversionService, postingPipeline, operationLogService);
        order.verify(inventoryPostingService).reverseShipReserved(
            "CP-001",
            "CK-001",
            new BigDecimal("2"),
            "SALES_OUT_RED",
            "SALES_OUT_RED:" + RED_BILL_NO
        );
        order.verify(conversionService).decreaseExecutedQuantity(
            any(SourceExecutionSpec.class),
            eq(SOURCE_BILL_ID),
            eq(1),
            eq(new BigDecimal("2"))
        );
        order.verify(conversionService).refreshSourceStatus(any(SourceExecutionSpec.class), eq(SOURCE_BILL_ID));
        order.verify(postingPipeline).post(argThat(context ->
            FinancePosting.CHANNEL.equals(context.channel()) && "SALES_OUT_RED".equals(context.txnType())
        ));
        order.verify(operationLogService).logCurrent(argThat(command ->
            matches(command, "SALES", "RED_REVERSE", "sales_out", "AUDITED")
        ));
    }

    @Test
    void purchaseRedAuditLogsDomainEventAfterAllReverseFacts() {
        stubPurchaseRedAudit(true);

        purchaseInAppService.audit(RED_BILL_NO);

        InOrder order = inOrder(postingPipeline, conversionService, operationLogService);
        order.verify(postingPipeline).post(argThat(context ->
            InventoryPostingHook.CHANNEL.equals(context.channel()) && "PURCHASE_IN_RED".equals(context.txnType())
        ));
        order.verify(conversionService).decreaseExecutedQuantity(
            any(SourceExecutionSpec.class),
            eq(SOURCE_BILL_ID),
            eq(1),
            eq(new BigDecimal("2"))
        );
        order.verify(conversionService).refreshSourceStatus(any(SourceExecutionSpec.class), eq(SOURCE_BILL_ID));
        order.verify(postingPipeline).post(argThat(context ->
            FinancePosting.CHANNEL.equals(context.channel()) && "PURCHASE_IN_RED".equals(context.txnType())
        ));
        order.verify(operationLogService).logCurrent(argThat(command ->
            matches(command, "PURCHASE", "RED_REVERSE", "purchase_in", "AUDITED")
        ));
    }

    @Test
    void ordinarySalesAuditKeepsGenericAuditWithoutRedDomainEvent() {
        when(lifecycleService.transition(
            eq("sales_out"),
            eq(RED_BILL_NO),
            eq(BillStatus.DRAFT),
            eq(BillStatus.AUDITED),
            anyString(),
            eq("SALES"),
            eq("AUDIT"),
            eq("sales_out"),
            anyString()
        )).thenReturn(ordinarySalesAuditRow());
        when(jdbcTemplate.queryForList(contains("w.code AS \"warehouseCode\""), any(Object[].class)))
            .thenReturn(List.of());

        salesOutAppService.audit(RED_BILL_NO);

        verify(lifecycleService).transition(
            eq("sales_out"),
            eq(RED_BILL_NO),
            eq(BillStatus.DRAFT),
            eq(BillStatus.AUDITED),
            anyString(),
            eq("SALES"),
            eq("AUDIT"),
            eq("sales_out"),
            anyString()
        );
        verify(operationLogService, never()).logCurrent(argThat(command -> command != null && "RED_REVERSE".equals(command.action())));
    }

    @Test
    void ordinaryPurchaseAuditKeepsGenericAuditWithoutRedDomainEvent() {
        when(lifecycleService.transition(
            eq("purchase_in"),
            eq(RED_BILL_NO),
            eq(BillStatus.DRAFT),
            eq(BillStatus.AUDITED),
            anyString(),
            eq("PURCHASE"),
            eq("AUDIT"),
            eq("purchase_in"),
            anyString()
        )).thenReturn(ordinaryPurchaseAuditRow());
        when(jdbcTemplate.queryForList(contains("w.code AS \"warehouseCode\""), any(Object[].class)))
            .thenReturn(List.of());

        purchaseInAppService.audit(RED_BILL_NO);

        verify(lifecycleService).transition(
            eq("purchase_in"),
            eq(RED_BILL_NO),
            eq(BillStatus.DRAFT),
            eq(BillStatus.AUDITED),
            anyString(),
            eq("PURCHASE"),
            eq("AUDIT"),
            eq("purchase_in"),
            anyString()
        );
        verify(operationLogService, never()).logCurrent(argThat(command -> command != null && "RED_REVERSE".equals(command.action())));
    }

    @Test
    void failedSalesRedAuditDoesNotWriteDomainEvent() {
        stubSalesRedAudit(false);

        assertThatThrownBy(() -> salesOutAppService.audit(RED_BILL_NO))
            .isInstanceOf(ResponseStatusException.class)
            .hasMessageContaining("来源销售出库单未审核");
        verify(operationLogService, never()).logCurrent(argThat(command -> command != null && "RED_REVERSE".equals(command.action())));
    }

    @Test
    void failedPurchaseRedAuditDoesNotWriteDomainEvent() {
        stubPurchaseRedAudit(false);

        assertThatThrownBy(() -> purchaseInAppService.audit(RED_BILL_NO))
            .isInstanceOf(ResponseStatusException.class)
            .hasMessageContaining("来源采购入库单未审核");
        verify(operationLogService, never()).logCurrent(argThat(command -> command != null && "RED_REVERSE".equals(command.action())));
    }

    @Test
    void repeatedSalesRedAuditDoesNotWriteDomainEvent() {
        when(lifecycleService.transition(
            eq("sales_out"),
            eq(RED_BILL_NO),
            eq(BillStatus.DRAFT),
            eq(BillStatus.AUDITED),
            anyString(),
            eq("SALES"),
            eq("AUDIT"),
            eq("sales_out"),
            anyString()
        )).thenThrow(new ResponseStatusException(HttpStatus.CONFLICT, "销售出库单不存在或已审核"));

        assertThatThrownBy(() -> salesOutAppService.audit(RED_BILL_NO))
            .isInstanceOf(ResponseStatusException.class)
            .hasMessageContaining("已审核");
        verify(operationLogService, never()).logCurrent(argThat(command -> command != null && "RED_REVERSE".equals(command.action())));
    }

    @Test
    void repeatedPurchaseRedAuditDoesNotWriteDomainEvent() {
        when(lifecycleService.transition(
            eq("purchase_in"),
            eq(RED_BILL_NO),
            eq(BillStatus.DRAFT),
            eq(BillStatus.AUDITED),
            anyString(),
            eq("PURCHASE"),
            eq("AUDIT"),
            eq("purchase_in"),
            anyString()
        )).thenThrow(new ResponseStatusException(HttpStatus.CONFLICT, "采购入库单不存在或已审核"));

        assertThatThrownBy(() -> purchaseInAppService.audit(RED_BILL_NO))
            .isInstanceOf(ResponseStatusException.class)
            .hasMessageContaining("已审核");
        verify(operationLogService, never()).logCurrent(argThat(command -> command != null && "RED_REVERSE".equals(command.action())));
    }

    private boolean matches(
        OperationLogCommand command,
        String module,
        String action,
        String targetType,
        String afterStatus
    ) {
        return command != null
            && module.equals(command.module())
            && action.equals(command.action())
            && targetType.equals(command.targetType())
            && RED_BILL_ID.equals(String.valueOf(command.targetId()))
            && RED_BILL_NO.equals(command.targetNo())
            && command.outcome() == OperationLogCommand.Outcome.SUCCESS
            && command.actorMode() == OperationLogCommand.ActorMode.CURRENT_USER
            && afterStatus.equals(command.afterState().get(OperationLogCommand.StateField.STATUS));
    }

    private void stubSalesRedDraft() {
        when(jdbcTemplate.queryForList(contains("FROM sales_out"), any(Object[].class)))
            .thenReturn(List.of(salesSourceRow()));
        when(numberingService.nextBillNo("salesOut")).thenReturn(RED_BILL_NO);
        when(validationService.required("2026-07-12", "红冲日期")).thenReturn("2026-07-12");
        when(jdbcTemplate.queryForMap(contains("INSERT INTO sales_out"), any(Object[].class)))
            .thenReturn(redBillDraft());
        when(jdbcTemplate.queryForList(contains("FROM sales_out_line l"), any(Object[].class)))
            .thenReturn(List.of(salesSourceLine()));
    }

    private void stubPurchaseRedDraft() {
        when(jdbcTemplate.queryForList(contains("FROM purchase_in"), any(Object[].class)))
            .thenReturn(List.of(purchaseSourceRow()));
        when(numberingService.nextBillNo("purchaseIn")).thenReturn(RED_BILL_NO);
        when(validationService.required("2026-07-12", "红冲日期")).thenReturn("2026-07-12");
        when(jdbcTemplate.queryForMap(contains("INSERT INTO purchase_in"), any(Object[].class)))
            .thenReturn(redBillDraft());
        when(jdbcTemplate.queryForList(contains("FROM purchase_in_line l"), any(Object[].class)))
            .thenReturn(List.of(purchaseSourceLine()));
    }

    private void stubSalesRedAudit(boolean sourceAudited) {
        when(lifecycleService.transition(
            eq("sales_out"),
            eq(RED_BILL_NO),
            eq(BillStatus.DRAFT),
            eq(BillStatus.AUDITED),
            anyString(),
            eq("SALES"),
            eq("AUDIT"),
            eq("sales_out"),
            anyString()
        )).thenReturn(salesRedAuditRow());
        when(jdbcTemplate.queryForObject(contains("FROM sales_out"), eq(Integer.class), eq(SOURCE_BILL_ID)))
            .thenReturn(sourceAudited ? 1 : 0);
        if (!sourceAudited) {
            return;
        }
        when(jdbcTemplate.queryForMap(contains("SELECT COUNT(*) FROM sales_out_line"), any(Object[].class)))
            .thenReturn(Map.of("sourceCount", 1L, "redCount", 1L));
        when(jdbcTemplate.queryForList(contains("JOIN sales_out source"), any(Object[].class)))
            .thenReturn(List.of());
        when(jdbcTemplate.queryForList(contains("LEFT JOIN sales_out_line source_line"), any(Object[].class)))
            .thenReturn(List.of());
        when(jdbcTemplate.queryForList(contains("w.code AS \"warehouseCode\""), any(Object[].class)))
            .thenReturn(List.of(postingLine()));
        when(jdbcTemplate.queryForList(contains("FROM sales_order WHERE bill_no"), any(Object[].class)))
            .thenReturn(List.of(Map.of("id", SOURCE_BILL_ID)));
    }

    private void stubPurchaseRedAudit(boolean sourceAudited) {
        when(lifecycleService.transition(
            eq("purchase_in"),
            eq(RED_BILL_NO),
            eq(BillStatus.DRAFT),
            eq(BillStatus.AUDITED),
            anyString(),
            eq("PURCHASE"),
            eq("AUDIT"),
            eq("purchase_in"),
            anyString()
        )).thenReturn(purchaseRedAuditRow());
        when(jdbcTemplate.queryForObject(contains("FROM purchase_in"), eq(Integer.class), eq(SOURCE_BILL_ID)))
            .thenReturn(sourceAudited ? 1 : 0);
        if (!sourceAudited) {
            return;
        }
        when(jdbcTemplate.queryForMap(contains("SELECT COUNT(*) FROM purchase_in_line"), any(Object[].class)))
            .thenReturn(Map.of("sourceCount", 1L, "redCount", 1L));
        when(jdbcTemplate.queryForList(contains("JOIN purchase_in source"), any(Object[].class)))
            .thenReturn(List.of());
        when(jdbcTemplate.queryForList(contains("LEFT JOIN purchase_in_line source_line"), any(Object[].class)))
            .thenReturn(List.of());
        when(jdbcTemplate.queryForList(contains("w.code AS \"warehouseCode\""), any(Object[].class)))
            .thenReturn(List.of(postingLine()));
        when(jdbcTemplate.queryForList(contains("FROM purchase_order WHERE bill_no"), any(Object[].class)))
            .thenReturn(List.of(Map.of("id", SOURCE_BILL_ID)));
    }

    private Map<String, Object> redBillDraft() {
        return Map.of(
            "id", RED_BILL_ID,
            "billNo", RED_BILL_NO,
            "status", "DRAFT",
            "totalAmount", new BigDecimal("-22.60")
        );
    }

    private Map<String, Object> salesRedAuditRow() {
        return Map.of(
            "id", RED_BILL_ID,
            "billNo", RED_BILL_NO,
            "redSourceBillId", SOURCE_BILL_ID,
            "customerId", PARTY_ID,
            "billDate", LocalDate.of(2026, 7, 12),
            "totalAmount", new BigDecimal("-22.60"),
            "status", "AUDITED"
        );
    }

    private Map<String, Object> purchaseRedAuditRow() {
        return Map.of(
            "id", RED_BILL_ID,
            "billNo", RED_BILL_NO,
            "redSourceBillId", SOURCE_BILL_ID,
            "supplierId", PARTY_ID,
            "billDate", LocalDate.of(2026, 7, 12),
            "totalAmount", new BigDecimal("-22.60"),
            "status", "AUDITED"
        );
    }

    private Map<String, Object> ordinarySalesAuditRow() {
        return Map.of(
            "id", RED_BILL_ID,
            "billNo", RED_BILL_NO,
            "customerId", PARTY_ID,
            "billDate", LocalDate.of(2026, 7, 12),
            "totalAmount", new BigDecimal("22.60"),
            "status", "AUDITED"
        );
    }

    private Map<String, Object> ordinaryPurchaseAuditRow() {
        return Map.of(
            "id", RED_BILL_ID,
            "billNo", RED_BILL_NO,
            "supplierId", PARTY_ID,
            "billDate", LocalDate.of(2026, 7, 12),
            "totalAmount", new BigDecimal("22.60"),
            "status", "AUDITED"
        );
    }

    private Map<String, Object> salesSourceRow() {
        var row = new HashMap<String, Object>();
        row.put("id", SOURCE_BILL_ID);
        row.put("sourceOrderId", null);
        row.put("customerId", PARTY_ID);
        row.put("department", "销售部");
        row.put("total_amount", new BigDecimal("22.60"));
        row.put("currency", "CNY");
        row.put("ownerName", "tester");
        row.put("status", "AUDITED");
        return row;
    }

    private Map<String, Object> purchaseSourceRow() {
        var row = new HashMap<String, Object>();
        row.put("id", SOURCE_BILL_ID);
        row.put("sourceOrderId", null);
        row.put("supplierId", PARTY_ID);
        row.put("department", "采购部");
        row.put("total_amount", new BigDecimal("22.60"));
        row.put("ownerName", "tester");
        return row;
    }

    private Map<String, Object> salesSourceLine() {
        var line = baseSourceLine();
        line.put("sourceDeliveryNoticeNo", "FHTZD000001");
        line.put("sourceDeliveryLineNo", 1);
        line.put("customerMaterialCode", "");
        line.put("customerOrderNo", "");
        line.put("planDeliveryDate", LocalDate.of(2026, 7, 12));
        return line;
    }

    private Map<String, Object> purchaseSourceLine() {
        return baseSourceLine();
    }

    private Map<String, Object> baseSourceLine() {
        var line = new HashMap<String, Object>();
        line.put("lineNo", 1);
        line.put("sourceOrderNo", null);
        line.put("sourceLineNo", null);
        line.put("productId", PRODUCT_ID);
        line.put("productCode", "CP-001");
        line.put("productName", "测试商品");
        line.put("spec", "");
        line.put("warehouseId", WAREHOUSE_ID);
        line.put("warehouseCode", "CK-001");
        line.put("qty", new BigDecimal("2"));
        line.put("unitPrice", new BigDecimal("10"));
        line.put("amount", new BigDecimal("20"));
        line.put("taxRate", new BigDecimal("13"));
        line.put("taxAmount", new BigDecimal("2.60"));
        line.put("priceTaxTotal", new BigDecimal("22.60"));
        line.put("lineRemark", "");
        return line;
    }

    private Map<String, Object> postingLine() {
        return Map.of(
            "lineNo", 1,
            "sourceOrderNo", SOURCE_BILL_NO,
            "sourceLineNo", 1,
            "productCode", "CP-001",
            "warehouseCode", "CK-001",
            "qty", new BigDecimal("-2")
        );
    }
}
