package com.jdy.erp.sales.application;

import java.math.BigDecimal;
import java.math.BigInteger;
import java.math.RoundingMode;
import java.time.LocalDate;
import java.time.format.DateTimeParseException;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.EnumMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;

import com.fasterxml.jackson.databind.JsonNode;
import com.jdy.erp.finance.application.SalesReturnFinanceAppService;
import com.jdy.erp.finance.application.SalesReturnFinanceAppService.FinanceResult;
import com.jdy.erp.inventory.application.InventoryPostingCommand;
import com.jdy.erp.inventory.application.InventoryPostingCommand.PostingAction;
import com.jdy.erp.inventory.application.InventoryPostingService;
import com.jdy.erp.inventory.application.InventoryTraceLifecycleService;
import com.jdy.erp.shared.application.BillLifecycleService;
import com.jdy.erp.shared.application.BillLifecycleService.BillLifecycleTarget;
import com.jdy.erp.shared.application.BillLifecycleService.VoidRequest;
import com.jdy.erp.shared.application.NumberingService;
import com.jdy.erp.shared.application.OperationLogCommand;
import com.jdy.erp.shared.application.OperationLogService;
import com.jdy.erp.shared.application.TaxAmountCalculator;
import com.jdy.erp.system.security.CurrentSessionService;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.server.ResponseStatusException;

@Service
public class SalesReturnAppService {
    private static final Set<String> CURRENCIES = Set.of("CNY", "USD");
    private static final BillLifecycleTarget LIFECYCLE_TARGET = new BillLifecycleTarget(
        "sales_return",
        "sales_return_line",
        "bill_id",
        "SALES",
        "sales_return"
    );

    private final JdbcTemplate jdbcTemplate;
    private final NumberingService numberingService;
    private final TaxAmountCalculator taxAmountCalculator;
    private final InventoryPostingService inventoryPostingService;
    private final SalesReturnFinanceAppService financeAppService;
    private final BillLifecycleService lifecycleService;
    private final OperationLogService operationLogService;
    private final CurrentSessionService currentSessionService;
    private final InventoryTraceLifecycleService inventoryTraceLifecycleService;

    public SalesReturnAppService(
        JdbcTemplate jdbcTemplate,
        NumberingService numberingService,
        TaxAmountCalculator taxAmountCalculator,
        InventoryPostingService inventoryPostingService,
        SalesReturnFinanceAppService financeAppService,
        BillLifecycleService lifecycleService,
        OperationLogService operationLogService,
        CurrentSessionService currentSessionService,
        InventoryTraceLifecycleService inventoryTraceLifecycleService
    ) {
        this.jdbcTemplate = jdbcTemplate;
        this.numberingService = numberingService;
        this.taxAmountCalculator = taxAmountCalculator;
        this.inventoryPostingService = inventoryPostingService;
        this.financeAppService = financeAppService;
        this.lifecycleService = lifecycleService;
        this.operationLogService = operationLogService;
        this.currentSessionService = currentSessionService;
        this.inventoryTraceLifecycleService = inventoryTraceLifecycleService;
    }

    @Transactional(readOnly = true)
    public Map<String, Object> detail(String billNo) {
        var normalizedBillNo = requiredText(billNo, "单据编号", 80);
        var headers = jdbcTemplate.queryForList("""
            SELECT sr.id::text AS id,
                   sr.bill_no AS "billNo",
                   c.code AS "customerCode",
                   c.name AS customer,
                   to_char(sr.bill_date, 'YYYY-MM-DD') AS "billDate",
                   sr.status,
                   sr.total_amount AS "totalAmount",
                   sr.currency,
                   COALESCE(sr.owner_name, '') AS "ownerName",
                   COALESCE(sr.remark, '') AS remark,
                   sr.version::text AS version,
                   sr.close_status AS "closeStatus",
                   sr.frozen_status AS "frozenStatus",
                   COALESCE(finance.offset_amount, 0) AS "receivableOffsetAmount",
                   COALESCE(finance.pending_refund_amount, 0) AS "pendingRefundAmount"
            FROM sales_return sr
            JOIN md_customer c ON c.id = sr.customer_id
            LEFT JOIN (
                SELECT sales_return_id,
                       SUM(offset_amount) AS offset_amount,
                       SUM(pending_refund_amount) AS pending_refund_amount
                FROM sales_return_finance_allocation
                GROUP BY sales_return_id
            ) finance ON finance.sales_return_id = sr.id
            WHERE sr.bill_no = ?
            """, normalizedBillNo);
        if (headers.isEmpty()) {
            throw new ResponseStatusException(HttpStatus.NOT_FOUND, "销售退货单不存在");
        }
        var lines = jdbcTemplate.queryForList("""
            SELECT line.line_no AS "lineNo",
                   line.source_out_no AS "sourceOutNo",
                   line.source_line_no AS "sourceLineNo",
                   line.product_id::text AS "productId",
                   COALESCE(line.product_code_snapshot, product.code) AS "productCode",
                   COALESCE(line.product_name_snapshot, product.name) AS "productName",
                   COALESCE(line.product_spec_snapshot, product.spec, '') AS spec,
                   COALESCE(line.product_unit_snapshot, product.unit, '') AS unit,
                   trim(to_char(COALESCE(line.net_weight_snapshot, product.net_weight), 'FM9999999990.00')) AS "netWeight",
                   trim(to_char(COALESCE(line.gross_weight_snapshot, product.gross_weight), 'FM9999999990.00')) AS "grossWeight",
                   line.warehouse_id::text AS "warehouseId",
                   warehouse.code AS "warehouseCode",
                   warehouse.name AS warehouse,
                   line.qty,
                   source_line.qty AS "sourceQty",
                   COALESCE(returned.returned_qty, 0) AS "returnedQty",
                   GREATEST(0, source_line.qty - COALESCE(returned.returned_qty, 0)) AS "remainingQty",
                   line.unit_price AS "unitPrice",
                   round(line.unit_price * (1 + COALESCE(line.tax_rate, 0) / 100), 2) AS "taxInclusiveUnitPrice",
                   line.amount,
                   line.tax_rate AS "taxRate",
                   line.tax_amount AS "taxAmount",
                   line.price_tax_total AS "priceTaxTotal",
                   COALESCE(line.line_remark, '') AS "lineRemark"
            FROM sales_return_line line
            JOIN sales_return sr ON sr.id = line.bill_id
            JOIN sales_out_line source_line ON source_line.id = line.source_out_line_id
            JOIN md_product product ON product.id = line.product_id
            JOIN md_warehouse warehouse ON warehouse.id = line.warehouse_id
            LEFT JOIN (
                SELECT return_line.source_out_line_id,
                       SUM(return_line.qty) AS returned_qty
                FROM sales_return_line return_line
                JOIN sales_return return_bill ON return_bill.id = return_line.bill_id
                WHERE return_bill.status = 'AUDITED'
                GROUP BY return_line.source_out_line_id
            ) returned ON returned.source_out_line_id = line.source_out_line_id
            WHERE sr.bill_no = ?
            ORDER BY line.line_no
            """, normalizedBillNo);
        return Map.of("action", "DETAIL", "document", headers.getFirst(), "lines", lines);
    }

    @Transactional
    public Map<String, Object> saveDraft(SalesReturnDraftRequest request) {
        if (request == null) {
            throw badRequest("请求不能为空");
        }
        var normalized = normalizeDraft(request);
        if (hasText(request.billNo())) {
            return updateDraft(requiredText(request.billNo(), "单据编号", 80), request.version(), normalized);
        }
        if (request.version() != null && !request.version().isNull()) {
            throw badRequest("新建销售退货单不能提交 version");
        }
        return createDraft(normalized);
    }

    @Transactional
    public Map<String, Object> audit(String billNo) {
        var normalizedBillNo = requiredText(billNo, "单据编号", 80);
        var header = lockHeader(normalizedBillNo);
        if ("AUDITED".equals(header.get("status"))) {
            return detail(normalizedBillNo);
        }
        if (!"DRAFT".equals(header.get("status"))) {
            throw conflict("只有草稿销售退货单可以审核");
        }

        var lines = lockAndValidateStoredSources(header);
        for (var line : lines) {
            inventoryPostingService.post(InventoryPostingCommand.document(
                String.valueOf(line.get("productCode")),
                String.valueOf(line.get("warehouseCode")),
                decimal(line.get("qty")),
                "SALES_RETURN",
                "SALES_RETURN",
                header.get("id"),
                line.get("sourceBillLineId"),
                normalizedBillNo,
                header.get("billDate"),
                PostingAction.AUDIT
            ));
        }
        var finance = financeAppService.applyAudit(normalizedBillNo);
        var updated = jdbcTemplate.queryForList("""
            UPDATE sales_return
            SET status = 'AUDITED',
                version = version + 1,
                updated_at = now()
            WHERE id = ?::uuid
              AND status = 'DRAFT'
            RETURNING id::text AS id
            """, header.get("id"));
        if (updated.isEmpty()) {
            throw conflict("销售退货单状态已变化，请刷新后重试");
        }

        var result = detail(normalizedBillNo);
        logSuccess(
            "AUDIT",
            result,
            documentState(header, lines.size(), totalQuantity(lines), BigDecimal.ZERO, BigDecimal.ZERO),
            resultState(result, finance)
        );
        return result;
    }

    @Transactional
    public Map<String, Object> reverse(String billNo) {
        var normalizedBillNo = requiredText(billNo, "单据编号", 80);
        var header = lockHeader(normalizedBillNo);
        if (!"AUDITED".equals(header.get("status"))) {
            throw conflict("只有已审核销售退货单可以反审核");
        }

        var lines = lockAndValidateStoredSources(header);
        var finance = financeAppService.reverseAudit(normalizedBillNo);
        for (var line : lines) {
            inventoryPostingService.post(InventoryPostingCommand.document(
                String.valueOf(line.get("productCode")),
                String.valueOf(line.get("warehouseCode")),
                decimal(line.get("qty")).negate(),
                "SALES_RETURN_REVERSE",
                "SALES_RETURN",
                header.get("id"),
                line.get("sourceBillLineId"),
                normalizedBillNo,
                header.get("billDate"),
                PostingAction.REVERSE
            ));
        }
        var updated = jdbcTemplate.queryForList("""
            UPDATE sales_return
            SET status = 'DRAFT',
                reversed_at = now(),
                version = version + 1,
                updated_at = now()
            WHERE id = ?::uuid
              AND status = 'AUDITED'
            RETURNING id::text AS id
            """, header.get("id"));
        if (updated.isEmpty()) {
            throw conflict("销售退货单状态已变化，请刷新后重试");
        }

        var result = detail(normalizedBillNo);
        logSuccess("REVERSE", result, documentState(
            header,
            lines.size(),
            totalQuantity(lines),
            finance.offsetAmount(),
            finance.pendingRefundAmount()
        ), resultState(result, null));
        return result;
    }

    @Transactional
    public Map<String, Object> deleteDraft(String billNo) {
        var normalizedBillNo = requiredText(billNo, "单据编号", 80);
        var header = lockHeader(normalizedBillNo);
        if (!"DRAFT".equals(header.get("status"))) {
            throw conflict("只有草稿销售退货单可以删除");
        }
        inventoryTraceLifecycleService.assertNoPostingHistory(header.get("id"));
        assertNoFinanceAllocations(header.get("id"));
        var summary = lineSummary(header.get("id"));
        var before = documentState(
            header,
            summary.sourceCount(),
            summary.quantity(),
            BigDecimal.ZERO,
            BigDecimal.ZERO
        );
        var deleted = jdbcTemplate.update(
            "DELETE FROM sales_return WHERE id = ?::uuid AND status = 'DRAFT'",
            header.get("id")
        );
        if (deleted != 1) {
            throw conflict("销售退货单状态已变化，请刷新后重试");
        }
        var result = new LinkedHashMap<String, Object>();
        result.put("id", header.get("id"));
        result.put("billNo", normalizedBillNo);
        result.put("status", "DELETED");
        result.put("version", String.valueOf(header.get("version")));
        operationLogService.logCurrent(OperationLogCommand.success(
            "SALES",
            "DELETE",
            "sales_return",
            uuid(String.valueOf(header.get("id")), "销售退货单"),
            normalizedBillNo,
            OperationLogCommand.ActorMode.CURRENT_USER,
            null,
            before,
            OperationLogCommand.state(
                OperationLogCommand.StateField.STATUS, "DELETED",
                OperationLogCommand.StateField.VERSION, header.get("version")
            ),
            null
        ));
        return result;
    }

    @Transactional
    public Map<String, Object> voidBill(String billNo, VoidRequest request) {
        return lifecycleService.voidBill(LIFECYCLE_TARGET, requiredText(billNo, "单据编号", 80), request);
    }

    private Map<String, Object> createDraft(NormalizedDraft draft) {
        var sources = lockAndValidateRequestedSources(draft.lines(), "FOR SHARE OF source_header, source_line", null);
        var identity = sourceIdentity(sources);
        var billNo = numberingService.nextBillNo("salesReturn");
        var totalAmount = totalAmount(draft.lines(), sources);
        var header = jdbcTemplate.queryForMap("""
            INSERT INTO sales_return (
                bill_no, customer_id, bill_date, department, status, total_amount,
                currency, owner_name, remark, version
            )
            VALUES (?, ?::uuid, ?, NULL, 'DRAFT', ?, ?, ?, ?, 0)
            RETURNING id::text AS id, bill_no AS "billNo", status, total_amount AS "totalAmount", currency, version
            """,
            billNo,
            identity.customerId(),
            draft.billDate(),
            totalAmount,
            identity.currency(),
            currentSessionService.currentDisplayName(),
            draft.remark()
        );
        insertLines(header.get("id"), draft.lines(), sources);
        var result = detail(billNo);
        logSuccess("CREATE_DRAFT", result, Map.of(), resultState(result, null));
        return result;
    }

    private Map<String, Object> updateDraft(String billNo, JsonNode version, NormalizedDraft draft) {
        var expectedVersion = strictVersion(version);
        var header = lockHeader(billNo);
        if (!"DRAFT".equals(header.get("status"))) {
            throw conflict("只有草稿销售退货单可以修改");
        }
        if (number(header.get("version")).longValue() != expectedVersion) {
            throw conflict("销售退货单版本已变化，请刷新后重试");
        }
        assertNoFinanceAllocations(header.get("id"));
        var beforeSummary = lineSummary(header.get("id"));
        var before = documentState(
            header,
            beforeSummary.sourceCount(),
            beforeSummary.quantity(),
            BigDecimal.ZERO,
            BigDecimal.ZERO
        );

        var sources = lockAndValidateRequestedSources(
            draft.lines(),
            "FOR SHARE OF source_header, source_line",
            String.valueOf(header.get("id"))
        );
        var identity = sourceIdentity(sources);
        if (!String.valueOf(header.get("customerId")).equals(identity.customerId())
            || !String.valueOf(header.get("currency")).equals(identity.currency())) {
            throw conflict("草稿修改必须保持原客户和原币种");
        }
        var totalAmount = totalAmount(draft.lines(), sources);
        var updated = jdbcTemplate.queryForList("""
            UPDATE sales_return
            SET bill_date = ?,
                total_amount = ?,
                remark = ?,
                owner_name = ?,
                version = version + 1,
                updated_at = now()
            WHERE id = ?::uuid
              AND status = 'DRAFT'
              AND version = ?
            RETURNING id::text AS id
            """,
            draft.billDate(),
            totalAmount,
            draft.remark(),
            currentSessionService.currentDisplayName(),
            header.get("id"),
            expectedVersion
        );
        if (updated.isEmpty()) {
            throw conflict("销售退货单版本已变化，请刷新后重试");
        }
        inventoryTraceLifecycleService.prepareForLineReplacement("SALES_RETURN", header.get("id"));
        jdbcTemplate.update("DELETE FROM sales_return_line WHERE bill_id = ?::uuid", header.get("id"));
        insertLines(header.get("id"), draft.lines(), sources);
        var result = detail(billNo);
        logSuccess("UPDATE_DRAFT", result, before, resultState(result, null));
        return result;
    }

    private List<Map<String, Object>> lockAndValidateRequestedSources(
        List<NormalizedLine> requestedLines,
        String lockClause,
        String currentReturnId
    ) {
        var sorted = requestedLines.stream()
            .sorted(Comparator.comparing(NormalizedLine::sourceOutNo).thenComparing(NormalizedLine::sourceLineNo))
            .toList();
        var sources = new ArrayList<Map<String, Object>>();
        for (var requestLine : sorted) {
            var rows = jdbcTemplate.queryForList("""
                SELECT source_header.id::text AS "sourceBillId",
                       source_header.bill_no AS "sourceOutNo",
                       source_header.customer_id::text AS "customerId",
                       source_header.currency,
                       source_header.status AS "sourceStatus",
                       source_header.red_source_bill_id::text AS "redSourceBillId",
                       source_line.id::text AS "sourceOutLineId",
                       source_line.line_no AS "sourceLineNo",
                       source_line.product_id::text AS "productId",
                       COALESCE(source_line.product_code_snapshot, product.code) AS "productCode",
                       COALESCE(source_line.product_name_snapshot, product.name) AS "productName",
                       COALESCE(source_line.product_spec_snapshot, product.spec, '') AS spec,
                       COALESCE(source_line.product_unit_snapshot, product.unit, '') AS unit,
                       COALESCE(source_line.net_weight_snapshot, product.net_weight) AS "netWeight",
                       COALESCE(source_line.gross_weight_snapshot, product.gross_weight) AS "grossWeight",
                       source_line.warehouse_id::text AS "warehouseId",
                       warehouse.code AS "warehouseCode",
                       source_line.qty AS "sourceQty",
                       source_line.unit_price AS "unitPrice",
                       COALESCE(source_line.tax_rate, 0) AS "taxRate"
                FROM sales_out source_header
                JOIN sales_out_line source_line ON source_line.bill_id = source_header.id
                JOIN md_product product ON product.id = source_line.product_id
                JOIN md_warehouse warehouse ON warehouse.id = source_line.warehouse_id
                WHERE source_header.bill_no = ?
                  AND source_line.line_no = ?
                """ + lockClause, requestLine.sourceOutNo(), requestLine.sourceLineNo());
            if (rows.isEmpty()) {
                throw conflict("销售出库来源行不存在：" + requestLine.sourceOutNo() + "/" + requestLine.sourceLineNo());
            }
            var source = rows.getFirst();
            validateSourceExecutable(source);
            assertNoNonVoidRedBill(source.get("sourceBillId"));
            var remaining = decimal(source.get("sourceQty")).subtract(returnedQty(source.get("sourceOutLineId"), currentReturnId));
            if (requestLine.qty().compareTo(remaining) > 0) {
                throw conflict("销售退货数量超过来源剩余可退量：" + requestLine.sourceOutNo() + "/" + requestLine.sourceLineNo());
            }
            var copy = new LinkedHashMap<>(source);
            copy.put("requestedQty", requestLine.qty());
            sources.add(copy);
        }
        sourceIdentity(sources);
        return sources;
    }

    private List<Map<String, Object>> lockAndValidateStoredSources(Map<String, Object> header) {
        var rows = jdbcTemplate.queryForList("""
            SELECT return_line.id::text AS "sourceBillLineId",
                   return_line.line_no AS "lineNo",
                   return_line.source_out_line_id::text AS "storedSourceOutLineId",
                   return_line.source_out_no AS "storedSourceOutNo",
                   return_line.source_line_no AS "storedSourceLineNo",
                   return_line.product_id::text AS "storedProductId",
                   return_line.product_code_snapshot AS "storedProductCode",
                   return_line.product_name_snapshot AS "storedProductName",
                   COALESCE(return_line.product_spec_snapshot, '') AS "storedSpec",
                   COALESCE(return_line.product_unit_snapshot, '') AS "storedUnit",
                   return_line.net_weight_snapshot AS "storedNetWeight",
                   return_line.gross_weight_snapshot AS "storedGrossWeight",
                   return_line.warehouse_id::text AS "storedWarehouseId",
                   return_line.qty,
                   return_line.unit_price AS "storedUnitPrice",
                   return_line.amount AS "storedAmount",
                   return_line.tax_rate AS "storedTaxRate",
                   return_line.tax_amount AS "storedTaxAmount",
                   return_line.price_tax_total AS "storedPriceTaxTotal",
                   source_header.id::text AS "sourceBillId",
                   source_header.bill_no AS "sourceOutNo",
                   source_header.customer_id::text AS "customerId",
                   source_header.currency,
                   source_header.status AS "sourceStatus",
                   source_header.red_source_bill_id::text AS "redSourceBillId",
                   source_line.id::text AS "sourceOutLineId",
                   source_line.line_no AS "sourceLineNo",
                   source_line.product_id::text AS "productId",
                   COALESCE(source_line.product_code_snapshot, product.code) AS "productCode",
                   COALESCE(source_line.product_name_snapshot, product.name) AS "productName",
                   COALESCE(source_line.product_spec_snapshot, product.spec, '') AS spec,
                   COALESCE(source_line.product_unit_snapshot, product.unit, '') AS unit,
                   COALESCE(source_line.net_weight_snapshot, product.net_weight) AS "netWeight",
                   COALESCE(source_line.gross_weight_snapshot, product.gross_weight) AS "grossWeight",
                   source_line.warehouse_id::text AS "warehouseId",
                   warehouse.code AS "warehouseCode",
                   source_line.qty AS "sourceQty",
                   source_line.unit_price AS "unitPrice",
                   COALESCE(source_line.tax_rate, 0) AS "taxRate"
            FROM sales_return_line return_line
            JOIN sales_out_line source_line ON source_line.id = return_line.source_out_line_id
            JOIN sales_out source_header ON source_header.id = source_line.bill_id
            JOIN md_product product ON product.id = source_line.product_id
            JOIN md_warehouse warehouse ON warehouse.id = source_line.warehouse_id
            WHERE return_line.bill_id = ?::uuid
            ORDER BY source_header.bill_no, source_line.line_no
            FOR UPDATE OF source_header, source_line
            """, header.get("id"));
        if (rows.isEmpty()) {
            throw conflict("销售退货单至少需要一条来源分录");
        }
        var totalAmount = BigDecimal.ZERO;
        for (var row : rows) {
            validateSourceExecutable(row);
            assertNoNonVoidRedBill(row.get("sourceBillId"));
            assertStoredSourceFacts(row);
            var remaining = decimal(row.get("sourceQty")).subtract(returnedQty(row.get("sourceOutLineId"), String.valueOf(header.get("id"))));
            if (decimal(row.get("qty")).compareTo(remaining) > 0) {
                throw conflict("销售退货数量超过来源剩余可退量：" + row.get("sourceOutNo") + "/" + row.get("sourceLineNo"));
            }
            totalAmount = totalAmount.add(decimal(row.get("storedPriceTaxTotal")));
        }
        var identity = sourceIdentity(rows);
        if (!String.valueOf(header.get("customerId")).equals(identity.customerId())
            || !String.valueOf(header.get("currency")).equals(identity.currency())
            || decimal(header.get("totalAmount")).compareTo(totalAmount) != 0) {
            throw conflict("销售退货单头与来源事实不一致，不能继续生命周期操作");
        }
        return rows;
    }

    private void assertStoredSourceFacts(Map<String, Object> row) {
        var amounts = taxAmountCalculator.calculate(
            decimal(row.get("qty")),
            decimal(row.get("unitPrice")),
            decimal(row.get("taxRate"))
        );
        if (!same(row, "storedSourceOutLineId", "sourceOutLineId")
            || !same(row, "storedSourceOutNo", "sourceOutNo")
            || number(row.get("storedSourceLineNo")).intValue() != number(row.get("sourceLineNo")).intValue()
            || !same(row, "storedProductId", "productId")
            || !same(row, "storedProductCode", "productCode")
            || !same(row, "storedProductName", "productName")
            || !same(row, "storedSpec", "spec")
            || !same(row, "storedUnit", "unit")
            || !nullableDecimalEquals(row.get("storedNetWeight"), row.get("netWeight"))
            || !nullableDecimalEquals(row.get("storedGrossWeight"), row.get("grossWeight"))
            || !same(row, "storedWarehouseId", "warehouseId")
            || decimal(row.get("storedUnitPrice")).compareTo(decimal(row.get("unitPrice"))) != 0
            || decimal(row.get("storedTaxRate")).compareTo(decimal(row.get("taxRate"))) != 0
            || decimal(row.get("storedAmount")).compareTo(amounts.amount()) != 0
            || decimal(row.get("storedTaxAmount")).compareTo(amounts.taxAmount()) != 0
            || decimal(row.get("storedPriceTaxTotal")).compareTo(amounts.priceTaxTotal()) != 0) {
            throw conflict("销售退货来源事实已变化，不能继续生命周期操作");
        }
    }

    private void validateSourceExecutable(Map<String, Object> source) {
        if (!"AUDITED".equals(source.get("sourceStatus"))
            || source.get("redSourceBillId") != null
            || decimal(source.get("sourceQty")).compareTo(BigDecimal.ZERO) <= 0) {
            throw conflict("销售退货只能选择普通、正数且已审核的销售出库来源行");
        }
        if (!CURRENCIES.contains(String.valueOf(source.get("currency")))) {
            throw conflict("销售退货来源币种只支持 CNY 或 USD");
        }
    }

    private void assertNoNonVoidRedBill(Object sourceBillId) {
        if (count("SELECT COUNT(*) FROM sales_out WHERE red_source_bill_id = ?::uuid AND status <> 'VOID'", sourceBillId) > 0) {
            throw conflict("销售出库来源已存在非作废红字单，不能销售退货");
        }
    }

    private BigDecimal returnedQty(Object sourceOutLineId, String currentReturnId) {
        if (currentReturnId == null) {
            return decimal(jdbcTemplate.queryForObject("""
                SELECT COALESCE(SUM(return_line.qty), 0)
                FROM sales_return_line return_line
                JOIN sales_return return_bill ON return_bill.id = return_line.bill_id
                WHERE return_line.source_out_line_id = ?::uuid
                  AND return_bill.status = 'AUDITED'
                """, BigDecimal.class, sourceOutLineId));
        }
        return decimal(jdbcTemplate.queryForObject("""
            SELECT COALESCE(SUM(return_line.qty), 0)
            FROM sales_return_line return_line
            JOIN sales_return return_bill ON return_bill.id = return_line.bill_id
            WHERE return_line.source_out_line_id = ?::uuid
              AND return_bill.status = 'AUDITED'
              AND return_bill.id <> ?::uuid
            """, BigDecimal.class, sourceOutLineId, currentReturnId));
    }

    private SourceIdentity sourceIdentity(List<Map<String, Object>> sources) {
        if (sources.isEmpty()) {
            throw badRequest("销售退货单至少需要一条来源分录");
        }
        var customerId = String.valueOf(sources.getFirst().get("customerId"));
        var currency = String.valueOf(sources.getFirst().get("currency"));
        if (sources.stream().anyMatch(source -> !customerId.equals(String.valueOf(source.get("customerId"))))) {
            throw conflict("一张销售退货单不能混用不同客户的销售出库来源");
        }
        if (sources.stream().anyMatch(source -> !currency.equals(String.valueOf(source.get("currency"))))) {
            throw conflict("一张销售退货单不能混用不同币种的销售出库来源");
        }
        return new SourceIdentity(customerId, currency);
    }

    private BigDecimal totalAmount(List<NormalizedLine> lines, List<Map<String, Object>> sources) {
        var sourceByKey = sourceByKey(sources);
        return lines.stream()
            .map(line -> {
                var source = sourceByKey.get(line.key());
                return taxAmountCalculator.calculate(
                    line.qty(),
                    decimal(source.get("unitPrice")),
                    decimal(source.get("taxRate"))
                ).priceTaxTotal();
            })
            .reduce(BigDecimal.ZERO, BigDecimal::add);
    }

    private void insertLines(Object headerId, List<NormalizedLine> lines, List<Map<String, Object>> sources) {
        var sourceByKey = sourceByKey(sources);
        var lineNo = 1;
        for (var line : lines) {
            var source = sourceByKey.get(line.key());
            var amounts = taxAmountCalculator.calculate(
                line.qty(),
                decimal(source.get("unitPrice")),
                decimal(source.get("taxRate"))
            );
            jdbcTemplate.update("""
                INSERT INTO sales_return_line (
                    bill_id, line_no, source_out_line_id, source_out_no, source_line_no,
                    product_id, product_code_snapshot, product_name_snapshot, product_spec_snapshot,
                    product_unit_snapshot, net_weight_snapshot, gross_weight_snapshot, warehouse_id,
                    qty, unit_price, amount, tax_rate, tax_amount, price_tax_total, line_remark
                )
                VALUES (
                    ?::uuid, ?, ?::uuid, ?, ?, ?::uuid, ?, ?, ?, ?, ?, ?, ?::uuid,
                    ?, ?, ?, ?, ?, ?, ?
                )
                """,
                headerId,
                lineNo,
                source.get("sourceOutLineId"),
                source.get("sourceOutNo"),
                source.get("sourceLineNo"),
                source.get("productId"),
                source.get("productCode"),
                source.get("productName"),
                source.get("spec"),
                source.get("unit"),
                source.get("netWeight"),
                source.get("grossWeight"),
                source.get("warehouseId"),
                line.qty(),
                source.get("unitPrice"),
                amounts.amount(),
                amounts.taxRate(),
                amounts.taxAmount(),
                amounts.priceTaxTotal(),
                line.lineRemark()
            );
            lineNo += 1;
        }
    }

    private Map<String, Map<String, Object>> sourceByKey(List<Map<String, Object>> sources) {
        var result = new LinkedHashMap<String, Map<String, Object>>();
        for (var source : sources) {
            result.put(source.get("sourceOutNo") + "#" + source.get("sourceLineNo"), source);
        }
        return result;
    }

    private Map<String, Object> lockHeader(String billNo) {
        var rows = jdbcTemplate.queryForList("""
            SELECT id::text AS id,
                   bill_no AS "billNo",
                   customer_id::text AS "customerId",
                   bill_date AS "billDate",
                   status,
                   total_amount AS "totalAmount",
                   currency,
                   version
            FROM sales_return
            WHERE bill_no = ?
            FOR UPDATE
            """, billNo);
        if (rows.isEmpty()) {
            throw new ResponseStatusException(HttpStatus.NOT_FOUND, "销售退货单不存在");
        }
        return rows.getFirst();
    }

    private void assertNoFinanceAllocations(Object headerId) {
        if (count("SELECT COUNT(*) FROM sales_return_finance_allocation WHERE sales_return_id = ?::uuid", headerId) > 0) {
            throw conflict("草稿销售退货单存在异常财务事实，不能保存或删除");
        }
    }

    private NormalizedDraft normalizeDraft(SalesReturnDraftRequest request) {
        var billDate = date(request.billDate());
        var remark = optionalText(request.remark(), "备注", 2_000);
        if (request.lines() == null || request.lines().isEmpty()) {
            throw badRequest("销售退货单至少需要一条来源分录");
        }
        var normalizedLines = new ArrayList<NormalizedLine>();
        var keys = new java.util.HashSet<String>();
        for (var row : request.lines()) {
            if (row == null) {
                throw badRequest("销售退货分录不能为空");
            }
            var sourceOutNo = requiredText(row.sourceOutNo(), "来源销售出库单号", 80);
            if (row.sourceLineNo() == null || row.sourceLineNo() <= 0) {
                throw badRequest("来源销售出库行号必须大于 0");
            }
            var qty = quantity(row.qty());
            var lineRemark = optionalText(row.lineRemark(), "行备注", 2_000);
            var line = new NormalizedLine(sourceOutNo, row.sourceLineNo(), qty, lineRemark);
            if (!keys.add(line.key())) {
                throw badRequest("同一销售退货单不能重复选择来源行：" + sourceOutNo + "/" + row.sourceLineNo());
            }
            normalizedLines.add(line);
        }
        return new NormalizedDraft(billDate, remark, List.copyOf(normalizedLines));
    }

    private Map<OperationLogCommand.StateField, Object> documentState(
        Map<String, Object> header,
        int sourceCount,
        BigDecimal quantity,
        BigDecimal offsetAmount,
        BigDecimal pendingRefundAmount
    ) {
        return OperationLogCommand.state(
            OperationLogCommand.StateField.STATUS, header.get("status"),
            OperationLogCommand.StateField.CURRENCY, header.get("currency"),
            OperationLogCommand.StateField.AMOUNT, header.get("totalAmount"),
            OperationLogCommand.StateField.VERSION, header.get("version"),
            OperationLogCommand.StateField.SOURCE_COUNT, sourceCount,
            OperationLogCommand.StateField.QUANTITY, quantity,
            OperationLogCommand.StateField.SETTLED_AMOUNT, offsetAmount,
            OperationLogCommand.StateField.OUTSTANDING_AMOUNT, pendingRefundAmount
        );
    }

    private Map<OperationLogCommand.StateField, Object> resultState(Map<String, Object> result, FinanceResult finance) {
        var document = document(result);
        var resultLines = result.get("lines") instanceof List<?> values ? values : List.of();
        return OperationLogCommand.state(
            OperationLogCommand.StateField.STATUS, document.get("status"),
            OperationLogCommand.StateField.CURRENCY, document.get("currency"),
            OperationLogCommand.StateField.AMOUNT, document.get("totalAmount"),
            OperationLogCommand.StateField.VERSION, document.get("version"),
            OperationLogCommand.StateField.SOURCE_COUNT, resultLines.size(),
            OperationLogCommand.StateField.QUANTITY, totalQuantity(resultLines),
            OperationLogCommand.StateField.SETTLED_AMOUNT, finance == null ? document.get("receivableOffsetAmount") : finance.offsetAmount(),
            OperationLogCommand.StateField.OUTSTANDING_AMOUNT, finance == null ? document.get("pendingRefundAmount") : finance.pendingRefundAmount()
        );
    }

    private void logSuccess(
        String action,
        Map<String, Object> result,
        Map<OperationLogCommand.StateField, Object> before,
        Map<OperationLogCommand.StateField, Object> after
    ) {
        var document = document(result);
        operationLogService.logCurrent(OperationLogCommand.success(
            "SALES",
            action,
            "sales_return",
            uuid(String.valueOf(document.get("id")), "销售退货单"),
            String.valueOf(document.get("billNo")),
            OperationLogCommand.ActorMode.CURRENT_USER,
            null,
            before,
            after,
            null
        ));
    }

    private LineSummary lineSummary(Object headerId) {
        var row = jdbcTemplate.queryForMap("""
            SELECT COUNT(*)::int AS "sourceCount",
                   COALESCE(SUM(qty), 0) AS quantity
            FROM sales_return_line
            WHERE bill_id = ?::uuid
            """, headerId);
        return new LineSummary(
            number(row.get("sourceCount")).intValue(),
            decimal(row.get("quantity"))
        );
    }

    private BigDecimal totalQuantity(List<?> lines) {
        return lines.stream()
            .filter(Map.class::isInstance)
            .map(Map.class::cast)
            .map(line -> decimal(line.get("qty")))
            .reduce(BigDecimal.ZERO, BigDecimal::add);
    }

    @SuppressWarnings("unchecked")
    private Map<String, Object> document(Map<String, Object> result) {
        return (Map<String, Object>) result.get("document");
    }

    private long strictVersion(JsonNode version) {
        if (version != null && version.isTextual()) {
            var text = version.textValue();
            if (text != null && text.length() <= 19 && text.matches("0|[1-9][0-9]*")) {
                try {
                    var value = new BigInteger(text);
                    if (value.compareTo(BigInteger.valueOf(Long.MAX_VALUE)) <= 0) {
                        return value.longValueExact();
                    }
                } catch (NumberFormatException | ArithmeticException ignored) {
                    // The stable validation error below is the public contract.
                }
            }
        }
        throw badRequest("version 必须是规范非负 64 位十进制字符串");
    }

    private LocalDate date(String value) {
        try {
            return LocalDate.parse(requiredText(value, "业务日期", 20));
        } catch (DateTimeParseException exception) {
            throw badRequest("业务日期格式必须为 YYYY-MM-DD");
        }
    }

    private BigDecimal quantity(BigDecimal value) {
        if (value == null || value.compareTo(BigDecimal.ZERO) <= 0) {
            throw badRequest("销售退货数量必须大于 0");
        }
        try {
            var normalized = value.setScale(4, RoundingMode.UNNECESSARY);
            if (normalized.precision() - normalized.scale() > 14) {
                throw badRequest("销售退货数量超出允许范围");
            }
            return normalized;
        } catch (ArithmeticException exception) {
            throw badRequest("销售退货数量最多保留 4 位小数");
        }
    }

    private String requiredText(String value, String label, int maxLength) {
        var normalized = optionalText(value, label, maxLength);
        if (normalized == null) {
            throw badRequest(label + "不能为空");
        }
        return normalized;
    }

    private String optionalText(String value, String label, int maxLength) {
        if (value == null || value.isBlank()) {
            return null;
        }
        var normalized = value.trim();
        if (normalized.length() > maxLength) {
            throw badRequest(label + "长度不能超过 " + maxLength);
        }
        return normalized;
    }

    private boolean hasText(String value) {
        return value != null && !value.isBlank();
    }

    private boolean same(Map<String, Object> row, String left, String right) {
        return java.util.Objects.equals(string(row.get(left)), string(row.get(right)));
    }

    private String string(Object value) {
        return value == null ? null : String.valueOf(value);
    }

    private boolean nullableDecimalEquals(Object left, Object right) {
        if (left == null || right == null) {
            return left == null && right == null;
        }
        return decimal(left).compareTo(decimal(right)) == 0;
    }

    private BigDecimal decimal(Object value) {
        if (value == null) {
            return BigDecimal.ZERO;
        }
        if (value instanceof BigDecimal decimal) {
            return decimal;
        }
        return new BigDecimal(String.valueOf(value));
    }

    private Number number(Object value) {
        if (value instanceof Number number) {
            return number;
        }
        return Long.parseLong(String.valueOf(value));
    }

    private long count(String sql, Object... args) {
        var value = jdbcTemplate.queryForObject(sql, Long.class, args);
        return value == null ? 0 : value;
    }

    private UUID uuid(String value, String label) {
        try {
            return UUID.fromString(value);
        } catch (IllegalArgumentException exception) {
            throw new IllegalStateException(label + "主键非法", exception);
        }
    }

    private ResponseStatusException badRequest(String reason) {
        return new ResponseStatusException(HttpStatus.BAD_REQUEST, reason);
    }

    private ResponseStatusException conflict(String reason) {
        return new ResponseStatusException(HttpStatus.CONFLICT, reason);
    }

    public record SalesReturnDraftRequest(
        String billNo,
        JsonNode version,
        String billDate,
        String remark,
        List<SalesReturnLineRequest> lines
    ) {
    }

    public record SalesReturnLineRequest(
        String sourceOutNo,
        Integer sourceLineNo,
        BigDecimal qty,
        String lineRemark
    ) {
    }

    private record NormalizedDraft(LocalDate billDate, String remark, List<NormalizedLine> lines) {
    }

    private record NormalizedLine(String sourceOutNo, Integer sourceLineNo, BigDecimal qty, String lineRemark) {
        String key() {
            return sourceOutNo + "#" + sourceLineNo;
        }
    }

    private record SourceIdentity(String customerId, String currency) {
    }

    private record LineSummary(int sourceCount, BigDecimal quantity) {
    }
}
