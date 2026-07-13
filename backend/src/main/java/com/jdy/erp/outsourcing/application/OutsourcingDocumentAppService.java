package com.jdy.erp.outsourcing.application;

import java.math.BigDecimal;
import java.time.LocalDate;
import java.util.List;
import java.util.Map;
import java.util.UUID;

import com.jdy.erp.shared.application.InventoryPostingHook;
import com.jdy.erp.shared.application.LookupService;
import com.jdy.erp.shared.application.NumberingService;
import com.jdy.erp.shared.application.OperationLogCommand;
import com.jdy.erp.shared.application.OperationLogService;
import com.jdy.erp.shared.application.PostingContext;
import com.jdy.erp.shared.application.PostingPipeline;
import com.jdy.erp.shared.application.ValidationService;
import com.jdy.erp.shared.domain.BillStatus;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.server.ResponseStatusException;

@Service
public class OutsourcingDocumentAppService {
    private final JdbcTemplate jdbcTemplate;
    private final LookupService lookupService;
    private final ValidationService validationService;
    private final NumberingService numberingService;
    private final PostingPipeline postingPipeline;
    private final OperationLogService operationLogService;

    public OutsourcingDocumentAppService(
        JdbcTemplate jdbcTemplate,
        LookupService lookupService,
        ValidationService validationService,
        NumberingService numberingService,
        PostingPipeline postingPipeline,
        OperationLogService operationLogService
    ) {
        this.jdbcTemplate = jdbcTemplate;
        this.lookupService = lookupService;
        this.validationService = validationService;
        this.numberingService = numberingService;
        this.postingPipeline = postingPipeline;
        this.operationLogService = operationLogService;
    }

    @Transactional
    public Map<String, Object> saveWorkOrder(WorkOrderRequest request) {
        var billNo = numberingService.assignBillNo("outsourcingWorkOrder", request.billNo());
        var supplier = supplier(request.supplierCode());
        var bom = currentBomForProduct(request.productCode());
        var qty = positive(request.qty(), "委外数量");
        var planDeliveryDate = parseOptionalDate(request.planDeliveryDate());
        var sourceCompletion = sourceCompletion(request.sourceCompletionId(), request.sourceBillNo());
        var headerRows = jdbcTemplate.queryForList("""
            INSERT INTO outsourcing_work_order (
                bill_no, source_completion_id, source_bill_no,
                supplier_id, supplier_code_snapshot, supplier_name_snapshot, bill_date, status, remark
            )
            VALUES (?, ?::uuid, ?, ?::uuid, ?, ?, CURRENT_DATE, ?, ?)
            ON CONFLICT (bill_no) DO UPDATE
            SET source_completion_id = EXCLUDED.source_completion_id,
                source_bill_no = EXCLUDED.source_bill_no,
                supplier_id = EXCLUDED.supplier_id,
                supplier_code_snapshot = EXCLUDED.supplier_code_snapshot,
                supplier_name_snapshot = EXCLUDED.supplier_name_snapshot,
                remark = EXCLUDED.remark,
                updated_at = now(),
                version = outsourcing_work_order.version + 1
            WHERE outsourcing_work_order.status = 'DRAFT'
            RETURNING id::text AS id, bill_no AS "billNo", status
            """,
            billNo,
            sourceCompletion == null ? null : sourceCompletion.id(),
            sourceCompletion == null ? null : sourceCompletion.billNo(),
            supplier.id(),
            supplier.code(),
            supplier.name(),
            BillStatus.DRAFT.name(),
            validationService.optionalText(request.remark())
        );
        if (headerRows.isEmpty()) {
            throw new ResponseStatusException(HttpStatus.CONFLICT, "只有草稿委外加工单可以覆盖保存");
        }
        var header = headerRows.get(0);
        var workOrderId = String.valueOf(header.get("id"));
        jdbcTemplate.update("DELETE FROM outsourcing_work_order_component WHERE work_order_id = ?::uuid", workOrderId);
        jdbcTemplate.update("DELETE FROM outsourcing_work_order_line WHERE work_order_id = ?::uuid", workOrderId);
        insertWorkOrderLine(workOrderId, bom, qty, planDeliveryDate);
        insertWorkOrderComponents(workOrderId, bom, qty);
        operationLogService.logCurrent(OperationLogCommand.success(
            "OUTSOURCING", "SAVE_WORK_ORDER_DRAFT", "outsourcing_work_order",
            UUID.fromString(workOrderId), billNo, Map.of(),
            OperationLogCommand.state(OperationLogCommand.StateField.STATUS, String.valueOf(header.get("status")))
        ));
        return detailForWorkOrder(workOrderId);
    }

    @Transactional
    public Map<String, Object> auditWorkOrder(String billNo) {
        return transition("outsourcing_work_order", billNo, BillStatus.DRAFT.name(), BillStatus.AUDITED.name(), "AUDIT_WORK_ORDER");
    }

    @Transactional(readOnly = true)
    public Map<String, Object> workOrderDetail(String billNo) {
        var row = single("""
            SELECT id::text AS id
            FROM outsourcing_work_order
            WHERE bill_no = ?
            """, billNo, "委外加工单不存在");
        return detailForWorkOrder(String.valueOf(row.get("id")));
    }

    @Transactional(readOnly = true)
    public Map<String, Object> issueDetail(String billNo) {
        return detailForLineDocument(
            "outsourcing_material_issue",
            "outsourcing_material_issue_line",
            "issue_id",
            "source_work_order_no",
            billNo,
            "委外发料单不存在"
        );
    }

    @Transactional(readOnly = true)
    public Map<String, Object> receiptDetail(String billNo) {
        return detailForLineDocument(
            "outsourcing_receipt",
            "outsourcing_receipt_line",
            "receipt_id",
            "source_work_order_no",
            billNo,
            "委外产品入库单不存在"
        );
    }

    @Transactional(readOnly = true)
    public Map<String, Object> returnDetail(String billNo) {
        return detailForLineDocument(
            "outsourcing_return",
            "outsourcing_return_line",
            "return_id",
            "source_receipt_no",
            billNo,
            "委外产品退货单不存在"
        );
    }

    @Transactional(readOnly = true)
    public Map<String, Object> scrapDetail(String billNo) {
        return detailForLineDocument(
            "outsourcing_scrap",
            "outsourcing_scrap_line",
            "scrap_id",
            "source_receipt_no",
            billNo,
            "委外产品报废单不存在"
        );
    }

    @Transactional
    public Map<String, Object> reverseWorkOrder(String billNo) {
        var workOrder = single("""
            SELECT id::text AS id
            FROM outsourcing_work_order
            WHERE bill_no = ? AND status = 'AUDITED'
            """, billNo, "委外加工单不存在或不能反审核");
        if (activeCount("""
            SELECT COUNT(*)
            FROM outsourcing_material_issue
            WHERE source_work_order_id = ?::uuid
              AND status NOT IN ('VOID', 'REVERSED')
            """, workOrder.get("id")) > 0) {
            throw new ResponseStatusException(HttpStatus.CONFLICT, "委外加工单已有未反审核委外发料单，不能反审核");
        }
        if (activeCount("""
            SELECT COUNT(*)
            FROM outsourcing_receipt
            WHERE source_work_order_id = ?::uuid
              AND status NOT IN ('VOID', 'REVERSED')
            """, workOrder.get("id")) > 0) {
            throw new ResponseStatusException(HttpStatus.CONFLICT, "委外加工单已有未反审核委外产品入库单，不能反审核");
        }
        return transition("outsourcing_work_order", billNo, BillStatus.AUDITED.name(), BillStatus.DRAFT.name(), "REVERSE_WORK_ORDER");
    }

    @Transactional
    public Map<String, Object> pushIssue(String workOrderBillNo) {
        var workOrder = auditedWorkOrder(workOrderBillNo);
        var existing = jdbcTemplate.queryForList("""
            SELECT id::text AS id, bill_no AS "billNo", status
            FROM outsourcing_material_issue
            WHERE source_work_order_id = ?::uuid AND status <> 'VOID'
            ORDER BY created_at DESC
            LIMIT 1
            """, workOrder.get("id"));
        if (!existing.isEmpty()) {
            return existing.get(0);
        }
        var billNo = numberingService.nextBillNo("outsourcingIssue");
        var issue = jdbcTemplate.queryForMap("""
            INSERT INTO outsourcing_material_issue (
                bill_no, source_work_order_id, source_work_order_no,
                supplier_id, supplier_code_snapshot, supplier_name_snapshot, status
            )
            VALUES (?, ?::uuid, ?, ?::uuid, ?, ?, ?)
            RETURNING id::text AS id, bill_no AS "billNo", status
            """,
            billNo,
            workOrder.get("id"),
            workOrder.get("billNo"),
            workOrder.get("supplierId"),
            workOrder.get("supplierCode"),
            workOrder.get("supplierName"),
            BillStatus.DRAFT.name()
        );
        jdbcTemplate.update("""
            INSERT INTO outsourcing_material_issue_line (
                issue_id, line_no, source_component_id, product_id,
                product_code_snapshot, product_name_snapshot, product_spec_snapshot, product_unit_snapshot,
                net_weight_snapshot, gross_weight_snapshot, warehouse_id, warehouse_code_snapshot, qty
            )
            SELECT ?::uuid, line_no, id, product_id,
                   product_code_snapshot, product_name_snapshot, product_spec_snapshot, product_unit_snapshot,
                   net_weight_snapshot, gross_weight_snapshot, warehouse_id, warehouse_code_snapshot,
                   required_qty - issued_qty
            FROM outsourcing_work_order_component
            WHERE work_order_id = ?::uuid
              AND required_qty > issued_qty
            ORDER BY line_no
            """, issue.get("id"), workOrder.get("id"));
        operationLogService.logCurrent(OperationLogCommand.success(
            "OUTSOURCING", "PUSH_ISSUE", "outsourcing_material_issue",
            UUID.fromString(String.valueOf(issue.get("id"))), String.valueOf(issue.get("billNo")), Map.of(),
            OperationLogCommand.state(OperationLogCommand.StateField.STATUS, String.valueOf(issue.get("status")))
        ));
        return issue;
    }

    @Transactional
    public Map<String, Object> auditIssue(String billNo) {
        var issue = transition("outsourcing_material_issue", billNo, BillStatus.DRAFT.name(), BillStatus.AUDITED.name(), "AUDIT_ISSUE");
        var lines = jdbcTemplate.queryForList("""
            SELECT id::text AS id,
                   source_component_id::text AS "sourceComponentId",
                   product_code_snapshot AS "productCode",
                   warehouse_code_snapshot AS "warehouseCode",
                   qty
            FROM outsourcing_material_issue_line
            WHERE issue_id = ?::uuid
            ORDER BY line_no
            """, issue.get("id"));
        for (var line : lines) {
            postInventory(String.valueOf(line.get("productCode")), String.valueOf(line.get("warehouseCode")), ((BigDecimal) line.get("qty")).negate(), "OUTSOURCING_ISSUE", billNo);
            jdbcTemplate.update("""
                UPDATE outsourcing_work_order_component
                SET issued_qty = issued_qty + ?
                WHERE id = ?::uuid
                """, line.get("qty"), line.get("sourceComponentId"));
        }
        return issue;
    }

    @Transactional
    public Map<String, Object> reverseIssue(String billNo) {
        var source = single("""
            SELECT id::text AS id, source_work_order_id::text AS "workOrderId"
            FROM outsourcing_material_issue
            WHERE bill_no = ? AND status = 'AUDITED'
            """, billNo, "委外发料单不存在或不能反审核");
        if (activeCount("""
            SELECT COUNT(*)
            FROM outsourcing_receipt
            WHERE source_work_order_id = ?::uuid
              AND status NOT IN ('VOID', 'REVERSED')
            """, source.get("workOrderId")) > 0) {
            throw new ResponseStatusException(HttpStatus.CONFLICT, "委外加工单已有未反审核委外产品入库单，不能反审核发料");
        }
        var issue = transition("outsourcing_material_issue", billNo, BillStatus.AUDITED.name(), BillStatus.DRAFT.name(), "REVERSE_ISSUE");
        var lines = jdbcTemplate.queryForList("""
            SELECT source_component_id::text AS "sourceComponentId",
                   product_code_snapshot AS "productCode",
                   warehouse_code_snapshot AS "warehouseCode",
                   qty
            FROM outsourcing_material_issue_line
            WHERE issue_id = ?::uuid
            ORDER BY line_no
            """, issue.get("id"));
        for (var line : lines) {
            postInventory(String.valueOf(line.get("productCode")), String.valueOf(line.get("warehouseCode")), (BigDecimal) line.get("qty"), "OUTSOURCING_ISSUE_REVERSE", billNo);
            jdbcTemplate.update("""
                UPDATE outsourcing_work_order_component
                SET issued_qty = GREATEST(0, issued_qty - ?)
                WHERE id = ?::uuid
                """, line.get("qty"), line.get("sourceComponentId"));
        }
        return issue;
    }

    @Transactional
    public Map<String, Object> pushReceipt(String workOrderBillNo, QtyRequest request) {
        var workOrder = auditedWorkOrder(workOrderBillNo);
        var existing = jdbcTemplate.queryForList("""
            SELECT id::text AS id, bill_no AS "billNo", status
            FROM outsourcing_receipt
            WHERE source_work_order_id = ?::uuid AND status <> 'VOID'
            ORDER BY created_at DESC
            LIMIT 1
            """, workOrder.get("id"));
        if (!existing.isEmpty()) {
            return existing.get(0);
        }
        var billNo = numberingService.nextBillNo("outsourcingReceipt");
        var receipt = jdbcTemplate.queryForMap("""
            INSERT INTO outsourcing_receipt (
                bill_no, source_work_order_id, source_work_order_no,
                supplier_id, supplier_code_snapshot, supplier_name_snapshot, status
            )
            VALUES (?, ?::uuid, ?, ?::uuid, ?, ?, ?)
            RETURNING id::text AS id, bill_no AS "billNo", status
            """,
            billNo,
            workOrder.get("id"),
            workOrder.get("billNo"),
            workOrder.get("supplierId"),
            workOrder.get("supplierCode"),
            workOrder.get("supplierName"),
            BillStatus.DRAFT.name()
        );
        var line = workOrderLine(String.valueOf(workOrder.get("id")));
        var remaining = ((BigDecimal) line.get("qty")).subtract((BigDecimal) line.get("receivedQty"));
        var receiptQty = request == null || request.qty() == null ? remaining : positive(request.qty(), "入库数量");
        if (receiptQty.compareTo(remaining) > 0) {
            throw new ResponseStatusException(HttpStatus.CONFLICT, "入库数量不能超过委外加工单未入库数量");
        }
        insertReceiptLikeLine("outsourcing_receipt_line", "receipt_id", String.valueOf(receipt.get("id")), line, receiptQty);
        operationLogService.logCurrent(OperationLogCommand.success(
            "OUTSOURCING", "PUSH_RECEIPT", "outsourcing_receipt",
            UUID.fromString(String.valueOf(receipt.get("id"))), String.valueOf(receipt.get("billNo")), Map.of(),
            OperationLogCommand.state(OperationLogCommand.StateField.STATUS, String.valueOf(receipt.get("status")))
        ));
        return receipt;
    }

    @Transactional
    public Map<String, Object> auditReceipt(String billNo) {
        var receipt = transition("outsourcing_receipt", billNo, BillStatus.DRAFT.name(), BillStatus.AUDITED.name(), "AUDIT_RECEIPT");
        var lines = jdbcTemplate.queryForList("""
            SELECT source_work_order_line_id::text AS "sourceLineId",
                   product_code_snapshot AS "productCode",
                   warehouse_code_snapshot AS "warehouseCode",
                   qty
            FROM outsourcing_receipt_line
            WHERE receipt_id = ?::uuid
            ORDER BY line_no
            """, receipt.get("id"));
        for (var line : lines) {
            postInventory(String.valueOf(line.get("productCode")), String.valueOf(line.get("warehouseCode")), (BigDecimal) line.get("qty"), "OUTSOURCING_RECEIPT", billNo);
            jdbcTemplate.update("""
                UPDATE outsourcing_work_order_line
                SET received_qty = received_qty + ?
                WHERE id = ?::uuid
                """, line.get("qty"), line.get("sourceLineId"));
        }
        return receipt;
    }

    @Transactional
    public Map<String, Object> reverseReceipt(String billNo) {
        var receiptSource = single("""
            SELECT id::text AS id
            FROM outsourcing_receipt
            WHERE bill_no = ? AND status = 'AUDITED'
            """, billNo, "委外产品入库单不存在或不能反审核");
        if (activeCount("""
            SELECT COUNT(*)
            FROM outsourcing_return
            WHERE source_receipt_id = ?::uuid
              AND status NOT IN ('VOID', 'REVERSED')
            """, receiptSource.get("id")) > 0) {
            throw new ResponseStatusException(HttpStatus.CONFLICT, "委外产品入库单已有未反审核退货单，不能反审核");
        }
        if (activeCount("""
            SELECT COUNT(*)
            FROM outsourcing_scrap
            WHERE source_receipt_id = ?::uuid
              AND status NOT IN ('VOID', 'REVERSED')
            """, receiptSource.get("id")) > 0) {
            throw new ResponseStatusException(HttpStatus.CONFLICT, "委外产品入库单已有未反审核报废单，不能反审核");
        }
        var receipt = transition("outsourcing_receipt", billNo, BillStatus.AUDITED.name(), BillStatus.DRAFT.name(), "REVERSE_RECEIPT");
        var lines = jdbcTemplate.queryForList("""
            SELECT source_work_order_line_id::text AS "sourceLineId",
                   product_code_snapshot AS "productCode",
                   warehouse_code_snapshot AS "warehouseCode",
                   qty
            FROM outsourcing_receipt_line
            WHERE receipt_id = ?::uuid
            ORDER BY line_no
            """, receipt.get("id"));
        for (var line : lines) {
            postInventory(String.valueOf(line.get("productCode")), String.valueOf(line.get("warehouseCode")), ((BigDecimal) line.get("qty")).negate(), "OUTSOURCING_RECEIPT_REVERSE", billNo);
            jdbcTemplate.update("""
                UPDATE outsourcing_work_order_line
                SET received_qty = GREATEST(0, received_qty - ?)
                WHERE id = ?::uuid
                """, line.get("qty"), line.get("sourceLineId"));
        }
        return receipt;
    }

    @Transactional
    public Map<String, Object> pushReturn(String receiptBillNo, QtyRequest request) {
        return pushReceiptAdjustment("return", receiptBillNo, request);
    }

    @Transactional
    public Map<String, Object> pushScrap(String receiptBillNo, QtyRequest request) {
        return pushReceiptAdjustment("scrap", receiptBillNo, request);
    }

    @Transactional
    public Map<String, Object> auditReturn(String billNo) {
        return auditReceiptAdjustment("return", billNo);
    }

    @Transactional
    public Map<String, Object> auditScrap(String billNo) {
        return auditReceiptAdjustment("scrap", billNo);
    }

    @Transactional
    public Map<String, Object> reverseReturn(String billNo) {
        return reverseReceiptAdjustment("return", billNo);
    }

    @Transactional
    public Map<String, Object> reverseScrap(String billNo) {
        return reverseReceiptAdjustment("scrap", billNo);
    }

    @Transactional(readOnly = true)
    public List<Map<String, Object>> workOrderSources(String target) {
        if ("receipt".equals(target)) {
            return jdbcTemplate.queryForList("""
                SELECT h.bill_no AS "billNo",
                       h.supplier_code_snapshot AS "supplierCode",
                       h.supplier_name_snapshot AS "supplierName",
                       l.line_no AS "sourceLineNo",
                       l.product_code_snapshot AS "productCode",
                       l.product_name_snapshot AS "productName",
                       l.product_spec_snapshot AS spec,
                       COALESCE(l.product_unit_snapshot, '') AS unit,
                       l.warehouse_code_snapshot AS "warehouseCode",
                       trim(to_char(l.qty - l.received_qty, 'FM9999999990.####')) AS "remainingQty"
                FROM outsourcing_work_order h
                JOIN outsourcing_work_order_line l ON l.work_order_id = h.id
                WHERE h.status = 'AUDITED'
                  AND l.qty > l.received_qty
                ORDER BY h.updated_at DESC
                LIMIT 50
                """);
        }
        return jdbcTemplate.queryForList("""
            SELECT h.bill_no AS "billNo",
                   h.supplier_code_snapshot AS "supplierCode",
                   h.supplier_name_snapshot AS "supplierName",
                   MIN(c.line_no) AS "sourceLineNo",
                   l.product_code_snapshot AS "productCode",
                   l.product_name_snapshot AS "productName",
                   COALESCE(l.product_unit_snapshot, '') AS unit,
                   trim(to_char(SUM(c.required_qty - c.issued_qty), 'FM9999999990.####')) AS "remainingQty"
            FROM outsourcing_work_order h
            JOIN outsourcing_work_order_line l ON l.work_order_id = h.id
            JOIN outsourcing_work_order_component c ON c.work_order_id = h.id
            WHERE h.status = 'AUDITED'
              AND c.required_qty > c.issued_qty
            GROUP BY h.bill_no, h.supplier_code_snapshot, h.supplier_name_snapshot,
                     l.product_code_snapshot, l.product_name_snapshot, l.product_unit_snapshot, h.updated_at
            ORDER BY h.updated_at DESC
            LIMIT 50
            """);
    }

    @Transactional(readOnly = true)
    public List<Map<String, Object>> receiptSources(String target) {
        return jdbcTemplate.queryForList("""
            SELECT h.bill_no AS "billNo",
                   h.source_work_order_no AS "sourceBillNo",
                   h.supplier_code_snapshot AS "supplierCode",
                   h.supplier_name_snapshot AS "supplierName",
                   l.line_no AS "sourceLineNo",
                   l.product_code_snapshot AS "productCode",
                   l.product_name_snapshot AS "productName",
                   l.product_spec_snapshot AS spec,
                   COALESCE(l.product_unit_snapshot, '') AS unit,
                   l.warehouse_code_snapshot AS "warehouseCode",
                   trim(to_char(l.qty - l.returned_qty - l.scrapped_qty, 'FM9999999990.####')) AS "remainingQty",
                   ? AS target
            FROM outsourcing_receipt h
            JOIN outsourcing_receipt_line l ON l.receipt_id = h.id
            WHERE h.status = 'AUDITED'
              AND l.qty > l.returned_qty + l.scrapped_qty
            ORDER BY h.updated_at DESC
            LIMIT 50
            """, validationService.optionalText(target));
    }

    private Map<String, Object> pushReceiptAdjustment(String kind, String receiptBillNo, QtyRequest request) {
        var receipt = auditedReceipt(receiptBillNo);
        var table = "return".equals(kind) ? "outsourcing_return" : "outsourcing_scrap";
        var lineTable = "return".equals(kind) ? "outsourcing_return_line" : "outsourcing_scrap_line";
        var sequenceType = "return".equals(kind) ? "outsourcingReturn" : "outsourcingScrap";
        var existing = jdbcTemplate.queryForList("""
            SELECT id::text AS id, bill_no AS "billNo", status
            FROM %s
            WHERE source_receipt_id = ?::uuid AND status <> 'VOID'
            ORDER BY created_at DESC
            LIMIT 1
            """.formatted(table), receipt.get("id"));
        if (!existing.isEmpty()) {
            return existing.get(0);
        }
        var billNo = numberingService.nextBillNo(sequenceType);
        var adjustment = jdbcTemplate.queryForMap("""
            INSERT INTO %s (
                bill_no, source_receipt_id, source_receipt_no,
                supplier_id, supplier_code_snapshot, supplier_name_snapshot, status
            )
            VALUES (?, ?::uuid, ?, ?::uuid, ?, ?, ?)
            RETURNING id::text AS id, bill_no AS "billNo", status
            """.formatted(table),
            billNo,
            receipt.get("id"),
            receipt.get("billNo"),
            receipt.get("supplierId"),
            receipt.get("supplierCode"),
            receipt.get("supplierName"),
            BillStatus.DRAFT.name()
        );
        var line = receiptLine(String.valueOf(receipt.get("id")));
        var remaining = ((BigDecimal) line.get("qty"))
            .subtract((BigDecimal) line.get("returnedQty"))
            .subtract((BigDecimal) line.get("scrappedQty"));
        var qty = request == null || request.qty() == null ? remaining : positive(request.qty(), "处理数量");
        if (qty.compareTo(remaining) > 0) {
            throw new ResponseStatusException(HttpStatus.CONFLICT, "处理数量不能超过委外入库单剩余数量");
        }
        jdbcTemplate.update("""
            INSERT INTO %s (
                %s_id, line_no, source_receipt_line_id, product_id,
                product_code_snapshot, product_name_snapshot, product_spec_snapshot, product_unit_snapshot,
                net_weight_snapshot, gross_weight_snapshot, warehouse_id, warehouse_code_snapshot, qty
            )
            VALUES (?::uuid, 1, ?::uuid, ?::uuid, ?, ?, ?, ?, ?, ?, ?::uuid, ?, ?)
            """.formatted(lineTable, kind),
            adjustment.get("id"),
            line.get("id"),
            line.get("productId"),
            line.get("productCode"),
            line.get("productName"),
            line.get("spec"),
            line.get("unit"),
            line.get("netWeight"),
            line.get("grossWeight"),
            line.get("warehouseId"),
            line.get("warehouseCode"),
            qty
        );
        operationLogService.logCurrent(OperationLogCommand.success(
            "OUTSOURCING", "PUSH_" + kind.toUpperCase(), table,
            UUID.fromString(String.valueOf(adjustment.get("id"))), String.valueOf(adjustment.get("billNo")), Map.of(),
            OperationLogCommand.state(OperationLogCommand.StateField.STATUS, String.valueOf(adjustment.get("status")))
        ));
        return adjustment;
    }

    private Map<String, Object> auditReceiptAdjustment(String kind, String billNo) {
        var table = "return".equals(kind) ? "outsourcing_return" : "outsourcing_scrap";
        var lineTable = "return".equals(kind) ? "outsourcing_return_line" : "outsourcing_scrap_line";
        var action = "return".equals(kind) ? "AUDIT_RETURN" : "AUDIT_SCRAP";
        var adjustment = transition(table, billNo, BillStatus.DRAFT.name(), BillStatus.AUDITED.name(), action);
        var lines = jdbcTemplate.queryForList("""
            SELECT source_receipt_line_id::text AS "sourceReceiptLineId",
                   product_code_snapshot AS "productCode",
                   warehouse_code_snapshot AS "warehouseCode",
                   qty
            FROM %s
            WHERE %s_id = ?::uuid
            ORDER BY line_no
            """.formatted(lineTable, kind), adjustment.get("id"));
        for (var line : lines) {
            postInventory(String.valueOf(line.get("productCode")), String.valueOf(line.get("warehouseCode")), ((BigDecimal) line.get("qty")).negate(), "OUTSOURCING_" + kind.toUpperCase(), billNo);
            jdbcTemplate.update("""
                UPDATE outsourcing_receipt_line
                SET %s_qty = %s_qty + ?
                WHERE id = ?::uuid
                """.formatted("return".equals(kind) ? "returned" : "scrapped", "return".equals(kind) ? "returned" : "scrapped"),
                line.get("qty"),
                line.get("sourceReceiptLineId")
            );
        }
        return adjustment;
    }

    private Map<String, Object> reverseReceiptAdjustment(String kind, String billNo) {
        var table = "return".equals(kind) ? "outsourcing_return" : "outsourcing_scrap";
        var lineTable = "return".equals(kind) ? "outsourcing_return_line" : "outsourcing_scrap_line";
        var fkColumn = "return".equals(kind) ? "return_id" : "scrap_id";
        var sourceColumn = "return".equals(kind) ? "returned" : "scrapped";
        var action = "return".equals(kind) ? "REVERSE_RETURN" : "REVERSE_SCRAP";
        var adjustment = transition(table, billNo, BillStatus.AUDITED.name(), BillStatus.DRAFT.name(), action);
        var lines = jdbcTemplate.queryForList("""
            SELECT source_receipt_line_id::text AS "sourceReceiptLineId",
                   product_code_snapshot AS "productCode",
                   warehouse_code_snapshot AS "warehouseCode",
                   qty
            FROM %s
            WHERE %s = ?::uuid
            ORDER BY line_no
            """.formatted(lineTable, fkColumn), adjustment.get("id"));
        for (var line : lines) {
            postInventory(String.valueOf(line.get("productCode")), String.valueOf(line.get("warehouseCode")), (BigDecimal) line.get("qty"), "OUTSOURCING_" + kind.toUpperCase() + "_REVERSE", billNo);
            jdbcTemplate.update("""
                UPDATE outsourcing_receipt_line
                SET %s_qty = GREATEST(0, %s_qty - ?)
                WHERE id = ?::uuid
                """.formatted(sourceColumn, sourceColumn),
                line.get("qty"),
                line.get("sourceReceiptLineId")
            );
        }
        return adjustment;
    }

    private Map<String, Object> transition(String table, String billNo, String from, String to, String action) {
        var rows = jdbcTemplate.queryForList("""
            UPDATE %s
            SET status = ?, updated_at = now(), version = version + 1
            WHERE bill_no = ? AND status = ?
            RETURNING id::text AS id, bill_no AS "billNo", status
            """.formatted(table), to, billNo, from);
        if (rows.isEmpty()) {
            throw new ResponseStatusException(HttpStatus.CONFLICT, "单据不存在或状态不允许当前操作");
        }
        operationLogService.logCurrent(OperationLogCommand.success(
            "OUTSOURCING", action, table,
            UUID.fromString(String.valueOf(rows.get(0).get("id"))), String.valueOf(rows.get(0).get("billNo")),
            OperationLogCommand.state(OperationLogCommand.StateField.STATUS, from),
            OperationLogCommand.state(OperationLogCommand.StateField.STATUS, String.valueOf(rows.get(0).get("status")))
        ));
        return rows.get(0);
    }

    private void insertWorkOrderLine(String workOrderId, Map<String, Object> bom, BigDecimal qty, LocalDate planDeliveryDate) {
        var warehouseId = validationService.optionalText(String.valueOf(bom.get("defaultWarehouseId")));
        var warehouseCode = validationService.optionalText(String.valueOf(bom.get("defaultWarehouseCode")));
        if (warehouseId == null || "null".equals(warehouseId) || warehouseCode == null || "null".equals(warehouseCode)) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "母件缺少默认仓库，无法生成委外入库仓库");
        }
        jdbcTemplate.update("""
            INSERT INTO outsourcing_work_order_line (
                work_order_id, line_no, product_id, product_code_snapshot, product_name_snapshot,
                product_spec_snapshot, product_unit_snapshot, net_weight_snapshot, gross_weight_snapshot,
                bom_id, bom_code_snapshot, bom_version_no, warehouse_id, warehouse_code_snapshot, qty, plan_delivery_date
            )
            VALUES (?::uuid, 1, ?::uuid, ?, ?, ?, ?, ?, ?, ?::uuid, ?, ?, ?::uuid, ?, ?, ?)
            """,
            workOrderId,
            bom.get("productId"),
            bom.get("productCode"),
            bom.get("productName"),
            bom.get("spec"),
            bom.get("unit"),
            bom.get("netWeight"),
            bom.get("grossWeight"),
            bom.get("id"),
            bom.get("bomCode"),
            bom.get("bomVersionNo"),
            warehouseId,
            warehouseCode,
            qty,
            planDeliveryDate
        );
    }

    private void insertWorkOrderComponents(String workOrderId, Map<String, Object> bom, BigDecimal qty) {
        var components = jdbcTemplate.queryForList("""
            SELECT line.id::text AS "bomLineId",
                   line.line_no AS "lineNo",
                   material.id::text AS "productId",
                   material.code AS "productCode",
                   material.name AS "productName",
                   COALESCE(material.spec, '') AS spec,
                   COALESCE(material.unit, '') AS unit,
                   material.net_weight AS "netWeight",
                   material.gross_weight AS "grossWeight",
                   COALESCE(line.issue_warehouse_id::text, material.default_warehouse_id::text) AS "warehouseId",
                   COALESCE(line.issue_warehouse_code, material.default_warehouse_code) AS "warehouseCode",
                   COALESCE(line.unit_qty, line.qty) AS "unitQty",
                   (COALESCE(line.unit_qty, line.qty) * ?)
                       + COALESCE(line.fixed_loss_qty, 0)
                       + ((COALESCE(line.unit_qty, line.qty) * ?) * COALESCE(line.loss_rate, 0) / 100) AS "requiredQty"
            FROM prod_bom_line line
            JOIN md_product material ON material.id = line.material_id
            WHERE line.bom_id = ?::uuid
              AND material.enabled = TRUE
              AND material.audit_status = 'AUDITED'
            ORDER BY line.line_no
            """, qty, qty, bom.get("id"));
        if (components.isEmpty()) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "BOM 子件为空，无法生成委外发料需求");
        }
        if (components.stream().anyMatch(row -> row.get("warehouseId") == null || row.get("warehouseCode") == null)) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "BOM 子件缺少默认发料仓库");
        }
        for (var component : components) {
            jdbcTemplate.update("""
                INSERT INTO outsourcing_work_order_component (
                    work_order_id, line_no, source_bom_line_id, product_id,
                    product_code_snapshot, product_name_snapshot, product_spec_snapshot, product_unit_snapshot,
                    net_weight_snapshot, gross_weight_snapshot, warehouse_id, warehouse_code_snapshot, unit_qty, required_qty
                )
                VALUES (?::uuid, ?, ?::uuid, ?::uuid, ?, ?, ?, ?, ?, ?, ?::uuid, ?, ?, ?)
                """,
                workOrderId,
                component.get("lineNo"),
                component.get("bomLineId"),
                component.get("productId"),
                component.get("productCode"),
                component.get("productName"),
                component.get("spec"),
                component.get("unit"),
                component.get("netWeight"),
                component.get("grossWeight"),
                component.get("warehouseId"),
                component.get("warehouseCode"),
                component.get("unitQty"),
                component.get("requiredQty")
            );
        }
    }

    private Map<String, Object> detailForWorkOrder(String workOrderId) {
        var row = jdbcTemplate.queryForMap("""
            SELECT h.id::text AS id, h.bill_no AS "billNo", h.status,
                   COALESCE(h.source_bill_no, '') AS "sourceBillNo",
                   COALESCE(h.source_completion_id::text, '') AS "sourceCompletionId",
                   h.supplier_code_snapshot AS "supplierCode",
                   h.supplier_name_snapshot AS "supplierName",
                   to_char(h.bill_date, 'YYYY-MM-DD') AS "billDate",
                   COALESCE(h.remark, '') AS remark
            FROM outsourcing_work_order h
            WHERE h.id = ?::uuid
            """, workOrderId);
        row.put("lines", jdbcTemplate.queryForList("""
            SELECT line_no AS "lineNo",
                   product_code_snapshot AS "productCode",
                   product_name_snapshot AS "productName",
                   product_spec_snapshot AS spec,
                   product_unit_snapshot AS unit,
                   warehouse_code_snapshot AS "warehouseCode",
                   bom_code_snapshot AS "bomCode",
                   bom_version_no AS "bomVersion",
                   trim(to_char(qty, 'FM9999999990.####')) AS qty,
                   trim(to_char(issued_qty, 'FM9999999990.####')) AS "issuedQty",
                   trim(to_char(received_qty, 'FM9999999990.####')) AS "receivedQty",
                   COALESCE(to_char(plan_delivery_date, 'YYYY-MM-DD'), '') AS "planDeliveryDate"
            FROM outsourcing_work_order_line
            WHERE work_order_id = ?::uuid
            ORDER BY line_no
            """, workOrderId));
        row.put("components", jdbcTemplate.queryForList("""
            SELECT line_no AS "lineNo",
                   product_code_snapshot AS "productCode",
                   product_name_snapshot AS "productName",
                   product_spec_snapshot AS spec,
                   product_unit_snapshot AS unit,
                   warehouse_code_snapshot AS "warehouseCode",
                   trim(to_char(unit_qty, 'FM9999999990.######')) AS "unitQty",
                   trim(to_char(required_qty, 'FM9999999990.####')) AS qty,
                   trim(to_char(issued_qty, 'FM9999999990.####')) AS "issuedQty"
            FROM outsourcing_work_order_component
            WHERE work_order_id = ?::uuid
            ORDER BY line_no
            """, workOrderId));
        return row;
    }

    private SourceCompletion sourceCompletion(String sourceCompletionId, String sourceBillNo) {
        var idText = validationService.optionalText(sourceCompletionId);
        var billNoText = validationService.optionalText(sourceBillNo);
        if (idText == null && billNoText == null) {
            return null;
        }
        var rows = idText != null
            ? jdbcTemplate.queryForList("""
                SELECT id::text AS id, bill_no AS "billNo"
                FROM production_completion
                WHERE id = ?::uuid
                  AND status = 'AUDITED'
                """, idText)
            : jdbcTemplate.queryForList("""
                SELECT id::text AS id, bill_no AS "billNo"
                FROM production_completion
                WHERE bill_no = ?
                  AND status = 'AUDITED'
                """, billNoText);
        if (rows.isEmpty()) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "来源产品入库单不存在或不可下推委外加工");
        }
        var row = rows.get(0);
        return new SourceCompletion(String.valueOf(row.get("id")), String.valueOf(row.get("billNo")));
    }

    private Map<String, Object> detailForLineDocument(
        String table,
        String lineTable,
        String fkColumn,
        String sourceBillColumn,
        String billNo,
        String missingMessage
    ) {
        var row = single("""
            SELECT id::text AS id,
                   bill_no AS "billNo",
                   %s AS "sourceBillNo",
                   supplier_code_snapshot AS "supplierCode",
                   supplier_name_snapshot AS "supplierName",
                   to_char(bill_date, 'YYYY-MM-DD') AS "billDate",
                   status
            FROM %s
            WHERE bill_no = ?
            """.formatted(sourceBillColumn, table), billNo, missingMessage);
        row.put("lines", jdbcTemplate.queryForList("""
            SELECT line_no AS "lineNo",
                   product_code_snapshot AS "productCode",
                   product_name_snapshot AS "productName",
                   product_spec_snapshot AS spec,
                   product_unit_snapshot AS unit,
                   warehouse_code_snapshot AS "warehouseCode",
                   trim(to_char(qty, 'FM9999999990.####')) AS qty
            FROM %s
            WHERE %s = ?::uuid
            ORDER BY line_no
            """.formatted(lineTable, fkColumn), row.get("id")));
        return row;
    }

    private Map<String, Object> auditedWorkOrder(String billNo) {
        return single("""
            SELECT id::text AS id, bill_no AS "billNo",
                   supplier_id::text AS "supplierId",
                   supplier_code_snapshot AS "supplierCode",
                   supplier_name_snapshot AS "supplierName"
            FROM outsourcing_work_order
            WHERE bill_no = ? AND status = 'AUDITED'
            """, billNo, "委外加工单不存在或未审核");
    }

    private Map<String, Object> auditedReceipt(String billNo) {
        return single("""
            SELECT id::text AS id, bill_no AS "billNo",
                   supplier_id::text AS "supplierId",
                   supplier_code_snapshot AS "supplierCode",
                   supplier_name_snapshot AS "supplierName"
            FROM outsourcing_receipt
            WHERE bill_no = ? AND status = 'AUDITED'
            """, billNo, "委外产品入库单不存在或未审核");
    }

    private Map<String, Object> workOrderLine(String workOrderId) {
        return single("""
            SELECT id::text AS id,
                   product_id::text AS "productId",
                   product_code_snapshot AS "productCode",
                   product_name_snapshot AS "productName",
                   product_spec_snapshot AS spec,
                   product_unit_snapshot AS unit,
                   net_weight_snapshot AS "netWeight",
                   gross_weight_snapshot AS "grossWeight",
                   warehouse_id::text AS "warehouseId",
                   warehouse_code_snapshot AS "warehouseCode",
                   qty,
                   received_qty AS "receivedQty"
            FROM outsourcing_work_order_line
            WHERE work_order_id = ?::uuid
            ORDER BY line_no
            LIMIT 1
            """, workOrderId, "委外加工单分录不存在");
    }

    private Map<String, Object> receiptLine(String receiptId) {
        return single("""
            SELECT id::text AS id,
                   product_id::text AS "productId",
                   product_code_snapshot AS "productCode",
                   product_name_snapshot AS "productName",
                   product_spec_snapshot AS spec,
                   product_unit_snapshot AS unit,
                   net_weight_snapshot AS "netWeight",
                   gross_weight_snapshot AS "grossWeight",
                   warehouse_id::text AS "warehouseId",
                   warehouse_code_snapshot AS "warehouseCode",
                   qty,
                   returned_qty AS "returnedQty",
                   scrapped_qty AS "scrappedQty"
            FROM outsourcing_receipt_line
            WHERE receipt_id = ?::uuid
            ORDER BY line_no
            LIMIT 1
            """, receiptId, "委外产品入库单分录不存在");
    }

    private void insertReceiptLikeLine(String table, String fkColumn, String headerId, Map<String, Object> line, BigDecimal qty) {
        jdbcTemplate.update("""
            INSERT INTO %s (
                %s, line_no, source_work_order_line_id, product_id,
                product_code_snapshot, product_name_snapshot, product_spec_snapshot, product_unit_snapshot,
                net_weight_snapshot, gross_weight_snapshot, warehouse_id, warehouse_code_snapshot, qty
            )
            VALUES (?::uuid, 1, ?::uuid, ?::uuid, ?, ?, ?, ?, ?, ?, ?::uuid, ?, ?)
            """.formatted(table, fkColumn),
            headerId,
            line.get("id"),
            line.get("productId"),
            line.get("productCode"),
            line.get("productName"),
            line.get("spec"),
            line.get("unit"),
            line.get("netWeight"),
            line.get("grossWeight"),
            line.get("warehouseId"),
            line.get("warehouseCode"),
            qty
        );
    }

    private Map<String, Object> currentBomForProduct(String productCode) {
        var rows = jdbcTemplate.queryForList("""
            SELECT b.id::text AS id,
                   b.code AS "bomCode",
                   b.version_no AS "bomVersionNo",
                   p.id::text AS "productId",
                   p.code AS "productCode",
                   p.name AS "productName",
                   COALESCE(p.spec, '') AS spec,
                   COALESCE(p.unit, '') AS unit,
                   p.net_weight AS "netWeight",
                   p.gross_weight AS "grossWeight",
                   p.default_warehouse_id::text AS "defaultWarehouseId",
                   p.default_warehouse_code AS "defaultWarehouseCode"
            FROM prod_bom b
            JOIN md_product p ON p.id = b.product_id
            WHERE p.code = ?
              AND p.enabled = TRUE
              AND p.audit_status = 'AUDITED'
              AND b.enabled = TRUE
              AND b.is_current = TRUE
              AND b.audit_status = 'AUDITED'
            """, validationService.required(productCode, "母件物料编码"));
        if (rows.isEmpty()) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "母件没有当前可用 BOM");
        }
        return rows.get(0);
    }

    private Supplier supplier(String supplierCode) {
        var supplierId = lookupService.lookupEnabledId("md_supplier", supplierCode, "供应商");
        var row = jdbcTemplate.queryForMap("SELECT code, name FROM md_supplier WHERE id = ?::uuid", supplierId);
        return new Supplier(supplierId, String.valueOf(row.get("code")), String.valueOf(row.get("name")));
    }

    private Map<String, Object> single(String sql, Object arg, String message) {
        var rows = jdbcTemplate.queryForList(sql, arg);
        if (rows.isEmpty()) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, message);
        }
        return rows.get(0);
    }

    private long activeCount(String sql, Object... args) {
        var count = jdbcTemplate.queryForObject(sql, Long.class, args);
        return count == null ? 0 : count;
    }

    private LocalDate parseOptionalDate(String value) {
        var text = validationService.optionalText(value);
        return text == null ? null : LocalDate.parse(text);
    }

    private BigDecimal positive(BigDecimal value, String label) {
        if (value == null || value.compareTo(BigDecimal.ZERO) <= 0) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, label + "必须大于 0");
        }
        return value;
    }

    private void postInventory(String productCode, String warehouseCode, BigDecimal qty, String txnType, String billNo) {
        postingPipeline.post(new PostingContext(InventoryPostingHook.CHANNEL, productCode, warehouseCode, qty, txnType, txnType + ":" + billNo));
    }

    private record Supplier(String id, String code, String name) {
    }

    private record SourceCompletion(String id, String billNo) {
    }

    public record WorkOrderRequest(
        String billNo,
        String supplierCode,
        String productCode,
        BigDecimal qty,
        String planDeliveryDate,
        String remark,
        String sourceBillNo,
        String sourceCompletionId
    ) {
    }

    public record QtyRequest(BigDecimal qty) {
    }
}
