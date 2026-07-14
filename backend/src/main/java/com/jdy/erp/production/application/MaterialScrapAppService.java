package com.jdy.erp.production.application;

import java.math.BigDecimal;
import java.time.LocalDate;
import java.time.ZoneId;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.UUID;

import com.jdy.erp.inventory.application.InventoryPostingCommand;
import com.jdy.erp.inventory.application.InventoryPostingCommand.PostingAction;
import com.jdy.erp.inventory.application.InventoryTraceLifecycleService;
import com.jdy.erp.shared.application.BillLifecycleService;
import com.jdy.erp.shared.application.BillLifecycleService.SourceLineIdQuantityDemand;
import com.jdy.erp.shared.application.BillLifecycleService.SourceLineIdQuantityGuard;
import com.jdy.erp.shared.application.LookupService;
import com.jdy.erp.shared.application.NumberingService;
import com.jdy.erp.shared.application.OperationLogCommand;
import com.jdy.erp.shared.application.OperationLogService;
import com.jdy.erp.shared.application.PostingContext;
import com.jdy.erp.shared.application.PostingPipeline;
import com.jdy.erp.shared.application.ValidationService;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.server.ResponseStatusException;

@Service
public class MaterialScrapAppService {
    private static final String BILL_TABLE = "production_material_scrap";
    private static final String SOURCE_BILL_TYPE = "PRODUCTION_MATERIAL_SCRAP";
    private static final String BUSINESS_TYPE = "PRODUCTION_SCRAP";
    private static final ZoneId BUSINESS_ZONE = ZoneId.of("Asia/Shanghai");
    private static final SourceLineIdQuantityGuard SOURCE_QUANTITY_GUARD = new SourceLineIdQuantityGuard(
        "production_material_issue",
        "production_material_issue_line",
        "issue_id",
        "id",
        "qty",
        BILL_TABLE,
        "production_material_scrap_line",
        "scrap_id",
        "source_issue_line_id",
        "scrap_qty",
        "来源生产领料单不存在、未审核、已关闭/冻结或来源行已变化，不能报废",
        "报废数量不能超过来源领料行剩余可报废数量"
    );

    private final JdbcTemplate jdbcTemplate;
    private final ValidationService validationService;
    private final LookupService lookupService;
    private final NumberingService numberingService;
    private final BillLifecycleService lifecycleService;
    private final PostingPipeline postingPipeline;
    private final OperationLogService operationLogService;
    private final InventoryTraceLifecycleService inventoryTraceLifecycleService;

    public MaterialScrapAppService(
        JdbcTemplate jdbcTemplate,
        ValidationService validationService,
        LookupService lookupService,
        NumberingService numberingService,
        BillLifecycleService lifecycleService,
        PostingPipeline postingPipeline,
        OperationLogService operationLogService,
        InventoryTraceLifecycleService inventoryTraceLifecycleService
    ) {
        this.jdbcTemplate = jdbcTemplate;
        this.validationService = validationService;
        this.lookupService = lookupService;
        this.numberingService = numberingService;
        this.lifecycleService = lifecycleService;
        this.postingPipeline = postingPipeline;
        this.operationLogService = operationLogService;
        this.inventoryTraceLifecycleService = inventoryTraceLifecycleService;
    }

    public Map<String, Object> detail(String billNo) {
        var header = requireScrapHeader(validationService.required(billNo, "材料报废单号"), false);
        return Map.of(
            "action", "DETAIL",
            "document", header,
            "lines", scrapLines(String.valueOf(header.get("id")), false)
        );
    }

    public Map<String, Object> previewFromIssue(String issueBillNo) {
        var source = requireEligibleSource(sourceHeaderByBillNo(issueBillNo, false));
        var workshop = requireWorkshopForNew(source);
        var lines = sourceLines(String.valueOf(source.get("id")));
        if (lines.isEmpty()) {
            throw conflict("来源生产领料单没有可报废行");
        }
        var previewLines = new ArrayList<Map<String, Object>>();
        for (var line : lines) {
            var availableScrapQty = remainingScrapQty(
                String.valueOf(line.get("id")),
                (BigDecimal) line.get("issueQty")
            );
            if (availableScrapQty.compareTo(BigDecimal.ZERO) <= 0) {
                continue;
            }
            var preview = new LinkedHashMap<String, Object>(line);
            preview.put("availableScrapQty", availableScrapQty);
            preview.put("scrapQty", BigDecimal.ZERO);
            preview.put("scrapReason", "");
            preview.put("reissueQty", BigDecimal.ZERO);
            preview.put("isStockIn", false);
            preview.put("targetWarehouseCode", "");
            preview.put("stockInStatus", "NOT_REQUIRED");
            previewLines.add(preview);
        }
        if (previewLines.isEmpty()) {
            throw conflict("来源生产领料单已无可报废数量");
        }
        var document = new LinkedHashMap<String, Object>();
        document.put("sourceIssueNo", source.get("billNo"));
        document.put("billDate", LocalDate.now(BUSINESS_ZONE).toString());
        document.put("businessType", BUSINESS_TYPE);
        document.putAll(workshop);
        document.put("status", "PREVIEW");
        return Map.of("action", "PREVIEW", "document", document, "lines", previewLines);
    }

    @Transactional
    public Map<String, Object> pushFromIssue(String issueBillNo, ScrapDraftRequest request) {
        var normalizedIssueNo = validationService.required(issueBillNo, "来源生产领料单号");
        if (request != null && request.sourceIssueNo() != null
            && !normalizedIssueNo.equals(request.sourceIssueNo().trim())) {
            throw badRequest("路径来源生产领料单与请求体不一致");
        }
        var effective = request == null
            ? new ScrapDraftRequest(null, normalizedIssueNo, null, BUSINESS_TYPE, null)
            : new ScrapDraftRequest(
                request.billNo(), normalizedIssueNo, request.billDate(), request.businessType(), request.lines()
            );
        return saveDraft(effective);
    }

    @Transactional
    public Map<String, Object> saveDraft(ScrapDraftRequest request) {
        if (request == null) {
            throw badRequest("材料报废草稿不能为空");
        }
        var businessType = normalizeBusinessType(request.businessType());
        var sourceIssueNo = validationService.required(request.sourceIssueNo(), "来源生产领料单号");
        var requestedBillNo = validationService.optionalText(request.billNo());
        var existing = requestedBillNo == null ? null : optionalScrapHeader(requestedBillNo);
        if (existing != null && !"DRAFT".equals(existing.get("status"))) {
            throw conflict("只有草稿材料报废单可以覆盖保存");
        }

        var sourcePreview = sourceHeaderByBillNo(sourceIssueNo, false);
        if (existing != null && !String.valueOf(existing.get("sourceIssueId")).equals(String.valueOf(sourcePreview.get("id")))) {
            throw conflict("已有材料报废草稿不能更换来源生产领料单");
        }
        var sourceRows = sourceLines(String.valueOf(sourcePreview.get("id")));
        var normalizedLines = normalizeRequestedLines(sourceRows, request.lines());
        var demands = normalizedLines.stream()
            .map(line -> new SourceLineIdQuantityDemand(line.sourceLineId(), line.scrapQty()))
            .toList();
        var currentId = existing == null ? null : String.valueOf(existing.get("id"));
        var remainingByLine = lifecycleService.guardSourceLineIdQuantities(
            SOURCE_QUANTITY_GUARD,
            String.valueOf(sourcePreview.get("id")),
            demands,
            currentId
        );
        if (existing == null && remainingByLine.values().stream().noneMatch(qty -> qty.compareTo(BigDecimal.ZERO) > 0)) {
            throw conflict("来源生产领料单已无可报废数量");
        }
        var lockedSource = requireEligibleSource(sourceHeaderById(String.valueOf(sourcePreview.get("id")), false));

        final String scrapId;
        final String scrapBillNo;
        final Map<String, Object> workshop;
        if (existing == null) {
            workshop = requireWorkshopForNew(lockedSource);
            scrapBillNo = numberingService.assignBillNo("materialScrap", requestedBillNo);
            var inserted = jdbcTemplate.queryForMap("""
                INSERT INTO production_material_scrap (
                    bill_no, bill_date, business_type, source_issue_id,
                    workshop_id, workshop_code_snapshot, workshop_name_snapshot,
                    status, close_status, frozen_status
                )
                VALUES (?, ?, ?, ?::uuid, ?::uuid, ?, ?, 'DRAFT', 'OPEN', 'NORMAL')
                RETURNING id::text AS id
                """,
                scrapBillNo,
                request.billDate() == null ? LocalDate.now(BUSINESS_ZONE) : request.billDate(),
                businessType,
                lockedSource.get("id"),
                workshop.get("workshopId"),
                workshop.get("workshopCode"),
                workshop.get("workshopName")
            );
            scrapId = String.valueOf(inserted.get("id"));
        } else {
            assertExistingWorkshopIdentity(existing, lockedSource);
            var locked = jdbcTemplate.queryForList("""
                SELECT id::text AS id
                FROM production_material_scrap
                WHERE id = ?::uuid
                  AND status = 'DRAFT'
                  AND version = ?
                FOR UPDATE
                """, existing.get("id"), existing.get("version"));
            if (locked.isEmpty()) {
                throw conflict("材料报废草稿已被其他操作修改，请刷新后重试");
            }
            scrapId = String.valueOf(existing.get("id"));
            scrapBillNo = String.valueOf(existing.get("billNo"));
            workshop = Map.of(
                "workshopId", existing.get("workshopId"),
                "workshopCode", existing.get("workshopCode"),
                "workshopName", existing.get("workshopName")
            );
            inventoryTraceLifecycleService.prepareForLineReplacement(SOURCE_BILL_TYPE, scrapId);
            jdbcTemplate.update("DELETE FROM production_material_scrap_line WHERE scrap_id = ?::uuid", scrapId);
            jdbcTemplate.update("""
                UPDATE production_material_scrap
                SET bill_date = ?,
                    business_type = ?,
                    updated_at = now(),
                    version = version + 1
                WHERE id = ?::uuid
                """,
                request.billDate() == null ? existing.get("billDate") : request.billDate(),
                businessType,
                scrapId
            );
        }

        insertScrapLines(scrapId, normalizedLines, remainingByLine);
        var saved = requireScrapHeader(scrapBillNo, false);
        operationLogService.logCurrent(OperationLogCommand.success(
            "PRODUCTION", "SAVE_MATERIAL_SCRAP_DRAFT", BILL_TABLE,
            UUID.fromString(scrapId), scrapBillNo,
            Map.of(),
            OperationLogCommand.state(
                OperationLogCommand.StateField.STATUS, saved.get("status"),
                OperationLogCommand.StateField.VERSION, saved.get("version"),
                OperationLogCommand.StateField.SOURCE_COUNT, normalizedLines.size()
            )
        ));
        return saved;
    }

    @Transactional
    public Map<String, Object> deleteDraft(String billNo) {
        var preliminary = requireScrapHeader(validationService.required(billNo, "材料报废单号"), false);
        var lines = scrapLines(String.valueOf(preliminary.get("id")), false);
        lockSourceBeforeScrap(preliminary, lines, true);
        var locked = lockScrapHeader(preliminary, "DRAFT");
        inventoryTraceLifecycleService.assertNoPostingHistory(locked.get("id"));
        var deleted = jdbcTemplate.update(
            "DELETE FROM production_material_scrap WHERE id = ?::uuid AND status = 'DRAFT'",
            locked.get("id")
        );
        if (deleted != 1) {
            throw conflict("只有草稿且无库存历史的材料报废单可以删除");
        }
        operationLogService.logCurrent(OperationLogCommand.success(
            "PRODUCTION", "DELETE_MATERIAL_SCRAP_DRAFT", BILL_TABLE,
            UUID.fromString(String.valueOf(locked.get("id"))), String.valueOf(locked.get("billNo")),
            OperationLogCommand.state(OperationLogCommand.StateField.STATUS, "DRAFT"),
            OperationLogCommand.state(OperationLogCommand.StateField.STATUS, "DELETED")
        ));
        return Map.of("billNo", locked.get("billNo"), "status", "DELETED");
    }

    @Transactional
    public Map<String, Object> audit(String billNo) {
        var preliminary = requireScrapHeader(validationService.required(billNo, "材料报废单号"), false);
        var lines = scrapLines(String.valueOf(preliminary.get("id")), false);
        validateAuditLines(lines);
        lockSourceBeforeScrap(preliminary, lines, false);
        var locked = lockScrapHeader(preliminary, "DRAFT");
        var updated = jdbcTemplate.queryForMap("""
            UPDATE production_material_scrap
            SET status = 'AUDITED',
                audited_at = clock_timestamp(),
                reversed_at = NULL,
                updated_at = now(),
                version = version + 1
            WHERE id = ?::uuid
              AND status = 'DRAFT'
            RETURNING id::text AS id, bill_no AS "billNo", status, version
            """, locked.get("id"));
        operationLogService.logCurrent(OperationLogCommand.success(
            "PRODUCTION", "AUDIT_MATERIAL_SCRAP", BILL_TABLE,
            UUID.fromString(String.valueOf(updated.get("id"))), String.valueOf(updated.get("billNo")),
            OperationLogCommand.state(OperationLogCommand.StateField.STATUS, "DRAFT"),
            OperationLogCommand.state(
                OperationLogCommand.StateField.STATUS, "AUDITED",
                OperationLogCommand.StateField.QUANTITY, totalScrapQty(lines)
            )
        ));
        return updated;
    }

    @Transactional
    public Map<String, Object> reverse(String billNo) {
        var preliminary = requireScrapHeader(validationService.required(billNo, "材料报废单号"), false);
        var lines = scrapLines(String.valueOf(preliminary.get("id")), false);
        lockSourceBeforeScrap(preliminary, lines, true);
        var locked = lockScrapHeader(preliminary, "AUDITED");
        var lockedLines = scrapLines(String.valueOf(locked.get("id")), true);
        if (lockedLines.stream().anyMatch(line -> "STOCKED_IN".equals(line.get("stockInStatus")))) {
            throw conflict("材料报废单仍有未撤销的报废入库，必须先撤销报废入库");
        }
        var updated = jdbcTemplate.queryForMap("""
            UPDATE production_material_scrap
            SET status = 'DRAFT',
                reversed_at = clock_timestamp(),
                updated_at = now(),
                version = version + 1
            WHERE id = ?::uuid
              AND status = 'AUDITED'
            RETURNING id::text AS id, bill_no AS "billNo", status, version
            """, locked.get("id"));
        operationLogService.logCurrent(OperationLogCommand.success(
            "PRODUCTION", "REVERSE_MATERIAL_SCRAP", BILL_TABLE,
            UUID.fromString(String.valueOf(updated.get("id"))), String.valueOf(updated.get("billNo")),
            OperationLogCommand.state(OperationLogCommand.StateField.STATUS, "AUDITED"),
            OperationLogCommand.state(OperationLogCommand.StateField.STATUS, "DRAFT")
        ));
        return updated;
    }

    @Transactional
    public Map<String, Object> stockIn(String billNo) {
        return changeStockIn(billNo, false);
    }

    @Transactional
    public Map<String, Object> reverseStockIn(String billNo) {
        return changeStockIn(billNo, true);
    }

    private Map<String, Object> changeStockIn(String billNo, boolean reverse) {
        var header = requireScrapHeader(validationService.required(billNo, "材料报废单号"), true);
        if (!"AUDITED".equals(header.get("status"))) {
            throw conflict("只有已审核材料报废单可以执行报废入库或撤销");
        }
        var lines = scrapLines(String.valueOf(header.get("id")), true).stream()
            .filter(line -> Boolean.TRUE.equals(line.get("isStockIn")))
            .sorted(Comparator
                .comparing((Map<String, Object> line) -> String.valueOf(line.get("productId")))
                .thenComparing(line -> String.valueOf(line.get("targetWarehouseId")))
                .thenComparing(line -> String.valueOf(line.get("id"))))
            .toList();
        if (lines.isEmpty()) {
            throw conflict("材料报废单没有需要入库的分录");
        }
        var expected = reverse ? "STOCKED_IN" : null;
        var idempotent = reverse ? "REVERSED" : "STOCKED_IN";
        if (lines.stream().allMatch(line -> idempotent.equals(line.get("stockInStatus")))) {
            return stockActionResult(header, idempotent, true);
        }
        if (reverse) {
            if (lines.stream().anyMatch(line -> !expected.equals(line.get("stockInStatus")))) {
                throw conflict("报废入库状态不一致，不能部分撤销");
            }
        } else if (lines.stream().anyMatch(line -> !List.of("PENDING", "REVERSED").contains(String.valueOf(line.get("stockInStatus"))))) {
            throw conflict("报废入库状态不一致，不能部分入库");
        }

        for (var line : lines) {
            var qty = (BigDecimal) line.get("scrapQty");
            postingPipeline.post(PostingContext.inventory(InventoryPostingCommand.document(
                String.valueOf(line.get("productCode")),
                String.valueOf(line.get("targetWarehouseCode")),
                reverse ? qty.negate() : qty,
                reverse ? "PRODUCTION_MATERIAL_SCRAP_STOCK_IN_REVERSE" : "PRODUCTION_MATERIAL_SCRAP_STOCK_IN",
                SOURCE_BILL_TYPE,
                header.get("id"),
                line.get("id"),
                String.valueOf(header.get("billNo")),
                header.get("billDate"),
                reverse ? PostingAction.REVERSE : PostingAction.AUDIT
            )));
        }
        var nextStatus = reverse ? "REVERSED" : "STOCKED_IN";
        jdbcTemplate.update("""
            UPDATE production_material_scrap_line
            SET stock_in_status = ?, updated_at = now()
            WHERE scrap_id = ?::uuid
              AND is_stock_in = TRUE
            """, nextStatus, header.get("id"));
        operationLogService.logCurrent(OperationLogCommand.success(
            "PRODUCTION",
            reverse ? "REVERSE_MATERIAL_SCRAP_STOCK_IN" : "MATERIAL_SCRAP_STOCK_IN",
            BILL_TABLE,
            UUID.fromString(String.valueOf(header.get("id"))),
            String.valueOf(header.get("billNo")),
            OperationLogCommand.state(
                OperationLogCommand.StateField.STATUS, header.get("status"),
                OperationLogCommand.StateField.STOCK_IN_STATUS, header.get("stockInStatus"),
                OperationLogCommand.StateField.SOURCE_COUNT, lines.size()
            ),
            OperationLogCommand.state(
                OperationLogCommand.StateField.STATUS, header.get("status"),
                OperationLogCommand.StateField.STOCK_IN_STATUS, nextStatus,
                OperationLogCommand.StateField.QUANTITY, totalScrapQty(lines)
            )
        ));
        return stockActionResult(header, nextStatus, false);
    }

    private void lockSourceBeforeScrap(Map<String, Object> header, List<Map<String, Object>> lines, boolean zeroDemand) {
        var demands = lines.stream().map(line -> new SourceLineIdQuantityDemand(
            String.valueOf(line.get("sourceIssueLineId")),
            zeroDemand ? BigDecimal.ZERO : (BigDecimal) line.get("scrapQty")
        )).toList();
        lifecycleService.guardSourceLineIdQuantities(
            SOURCE_QUANTITY_GUARD,
            String.valueOf(header.get("sourceIssueId")),
            demands,
            String.valueOf(header.get("id"))
        );
        var source = requireEligibleSource(sourceHeaderById(String.valueOf(header.get("sourceIssueId")), false));
        assertExistingWorkshopIdentity(header, source);
    }

    private Map<String, Object> lockScrapHeader(Map<String, Object> preliminary, String status) {
        var rows = jdbcTemplate.queryForList("""
            SELECT id::text AS id,
                   bill_no AS "billNo",
                   source_issue_id::text AS "sourceIssueId",
                   workshop_id::text AS "workshopId",
                   workshop_code_snapshot AS "workshopCode",
                   workshop_name_snapshot AS "workshopName",
                   status,
                   version
            FROM production_material_scrap
            WHERE id = ?::uuid
              AND status = ?
              AND version = ?
            FOR UPDATE
            """, preliminary.get("id"), status, preliminary.get("version"));
        if (rows.isEmpty()) {
            throw conflict("材料报废单状态或版本已变化，请刷新后重试");
        }
        return rows.getFirst();
    }

    private void validateAuditLines(List<Map<String, Object>> lines) {
        if (lines.isEmpty()) {
            throw badRequest("材料报废单至少需要一条分录");
        }
        for (var line : lines) {
            var qty = (BigDecimal) line.get("scrapQty");
            if (qty == null || qty.compareTo(BigDecimal.ZERO) <= 0) {
                throw badRequest("审核时每行报废数量必须大于 0");
            }
            if (validationService.optionalText((String) line.get("scrapReason")) == null) {
                throw badRequest("审核时每行报废原因不能为空");
            }
            if (Boolean.TRUE.equals(line.get("isStockIn")) && line.get("targetWarehouseId") == null) {
                throw badRequest("需要报废入库的分录必须选择目标报废仓");
            }
        }
    }

    private List<NormalizedScrapLine> normalizeRequestedLines(
        List<Map<String, Object>> sourceLines,
        List<ScrapLineRequest> requestedLines
    ) {
        if (sourceLines.isEmpty()) {
            throw conflict("来源生产领料单没有可报废行");
        }
        var sourceById = new HashMap<String, Map<String, Object>>();
        sourceLines.forEach(line -> sourceById.put(String.valueOf(line.get("id")), line));
        var effectiveRequests = requestedLines;
        if (effectiveRequests == null || effectiveRequests.isEmpty()) {
            effectiveRequests = sourceLines.stream()
                .map(line -> new ScrapLineRequest(
                    String.valueOf(line.get("id")), BigDecimal.ZERO, null, BigDecimal.ZERO, false, null
                ))
                .toList();
        }
        var seen = new LinkedHashSet<String>();
        var normalized = new ArrayList<NormalizedScrapLine>();
        for (var request : effectiveRequests) {
            if (request == null) {
                throw badRequest("材料报废分录不能为空");
            }
            var sourceLineId = requireUuid(request.sourceIssueLineId(), "来源生产领料行 ID");
            if (!seen.add(sourceLineId)) {
                throw badRequest("来源生产领料行不能重复");
            }
            var source = sourceById.get(sourceLineId);
            if (source == null) {
                throw conflict("来源生产领料行不存在或不属于当前来源单");
            }
            var scrapQty = validationService.nonNegative(request.scrapQty(), "报废数量");
            var reissueQty = request.reissueQty() == null ? BigDecimal.ZERO
                : validationService.nonNegative(request.reissueQty(), "报废重发数量");
            if (reissueQty.compareTo(scrapQty) > 0) {
                throw badRequest("报废重发数量不能超过报废数量");
            }
            var scrapReason = validationService.optionalText(request.scrapReason());
            var stockIn = Boolean.TRUE.equals(request.isStockIn());
            String targetWarehouseId = null;
            String targetWarehouseCode = null;
            if (stockIn) {
                targetWarehouseCode = validationService.required(request.targetWarehouseCode(), "目标报废仓");
                targetWarehouseId = lookupService.lookupEnabledId("md_warehouse", targetWarehouseCode, "目标报废仓");
            }
            normalized.add(new NormalizedScrapLine(
                sourceLineId, source, scrapQty, scrapReason, reissueQty, stockIn,
                targetWarehouseId, targetWarehouseCode
            ));
        }
        normalized.sort(Comparator.comparingInt(line -> Number.class.cast(line.source().get("sourceLineNo")).intValue()));
        return normalized;
    }

    private void insertScrapLines(
        String scrapId,
        List<NormalizedScrapLine> lines,
        Map<String, BigDecimal> remainingByLine
    ) {
        var lineNo = 1;
        for (var line : lines) {
            var source = line.source();
            jdbcTemplate.update("""
                INSERT INTO production_material_scrap_line (
                    scrap_id, line_no, source_issue_line_id,
                    product_id, product_code_snapshot, product_name_snapshot,
                    product_spec_snapshot, product_unit_snapshot,
                    source_warehouse_id, source_warehouse_code_snapshot,
                    issue_qty_snapshot, available_scrap_qty_snapshot,
                    scrap_qty, scrap_reason, reissue_qty,
                    is_stock_in, target_warehouse_id, target_warehouse_code_snapshot,
                    stock_in_status
                )
                VALUES (
                    ?::uuid, ?, ?::uuid,
                    ?::uuid, ?, ?, ?, ?,
                    ?::uuid, ?, ?, ?,
                    ?, ?, ?, ?, ?::uuid, ?, ?
                )
                """,
                scrapId, lineNo++, line.sourceLineId(),
                source.get("productId"), source.get("productCode"), source.get("productName"),
                source.get("spec"), source.get("unit"),
                source.get("sourceWarehouseId"), source.get("sourceWarehouseCode"),
                source.get("issueQty"), remainingByLine.get(line.sourceLineId()),
                line.scrapQty(), line.scrapReason(), line.reissueQty(),
                line.isStockIn(), line.targetWarehouseId(), line.targetWarehouseCode(),
                line.isStockIn() ? "PENDING" : "NOT_REQUIRED"
            );
        }
    }

    private Map<String, Object> sourceHeaderByBillNo(String billNo, boolean lock) {
        var rows = jdbcTemplate.queryForList(sourceHeaderSql("i.bill_no = ?", lock),
            validationService.required(billNo, "来源生产领料单号"));
        if (rows.isEmpty()) {
            throw conflict("来源生产领料单不存在或不能报废");
        }
        return rows.getFirst();
    }

    private Map<String, Object> sourceHeaderById(String id, boolean lock) {
        var rows = jdbcTemplate.queryForList(sourceHeaderSql("i.id = ?::uuid", lock), requireUuid(id, "来源生产领料单 ID"));
        if (rows.isEmpty()) {
            throw conflict("来源生产领料单不存在或不能报废");
        }
        return rows.getFirst();
    }

    private String sourceHeaderSql(String predicate, boolean lock) {
        return """
            SELECT i.id::text AS id,
                   i.bill_no AS "billNo",
                   i.status,
                   i.close_status AS "closeStatus",
                   i.frozen_status AS "frozenStatus",
                   i.red_source_bill_id::text AS "redSourceBillId",
                   t.department_code AS "departmentCode",
                   EXISTS (
                       SELECT 1
                       FROM production_material_issue red
                       WHERE red.red_source_bill_id = i.id
                         AND red.status <> 'VOID'
                   ) AS "hasNonVoidRedChild"
            FROM production_material_issue i
            JOIN production_task t ON t.id = i.task_id
            WHERE %s
            %s
            """.formatted(predicate, lock ? "FOR UPDATE OF i" : "");
    }

    private Map<String, Object> requireEligibleSource(Map<String, Object> source) {
        if (!"AUDITED".equals(source.get("status"))
            || !"OPEN".equals(source.get("closeStatus"))
            || !"NORMAL".equals(source.get("frozenStatus"))
            || source.get("redSourceBillId") != null
            || Boolean.TRUE.equals(source.get("hasNonVoidRedChild"))) {
            throw conflict("来源生产领料单未审核、已关闭/冻结、属于红字单或已有非作废红字子单，不能报废");
        }
        if (validationService.optionalText((String) source.get("departmentCode")) == null) {
            throw conflict("来源生产任务未配置可识别的生产车间");
        }
        return source;
    }

    private Map<String, Object> requireWorkshopForNew(Map<String, Object> source) {
        var rows = jdbcTemplate.queryForList("""
            SELECT id::text AS "workshopId",
                   code AS "workshopCode",
                   name AS "workshopName"
            FROM md_production_department
            WHERE code = ?
              AND enabled = TRUE
              AND audit_status = 'AUDITED'
            """, source.get("departmentCode"));
        if (rows.size() != 1) {
            throw conflict("来源生产任务的生产车间不存在、未审核或已停用");
        }
        return rows.getFirst();
    }

    private void assertExistingWorkshopIdentity(Map<String, Object> header, Map<String, Object> source) {
        if (!String.valueOf(header.get("workshopCode")).equals(String.valueOf(source.get("departmentCode")))) {
            throw conflict("来源生产任务车间身份与材料报废草稿快照不一致");
        }
    }

    private List<Map<String, Object>> sourceLines(String sourceIssueId) {
        return jdbcTemplate.queryForList("""
            SELECT l.id::text AS id,
                   l.line_no AS "sourceLineNo",
                   l.product_id::text AS "productId",
                   COALESCE(l.product_code_snapshot, p.code) AS "productCode",
                   COALESCE(l.product_name_snapshot, p.name) AS "productName",
                   COALESCE(l.product_spec_snapshot, p.spec, '') AS spec,
                   COALESCE(l.product_unit_snapshot, p.unit, '') AS unit,
                   l.warehouse_id::text AS "sourceWarehouseId",
                   w.code AS "sourceWarehouseCode",
                   l.qty AS "issueQty"
            FROM production_material_issue_line l
            JOIN md_product p ON p.id = l.product_id
            JOIN md_warehouse w ON w.id = l.warehouse_id
            WHERE l.issue_id = ?::uuid
            ORDER BY l.line_no, l.id
            """, sourceIssueId);
    }

    private BigDecimal remainingScrapQty(String sourceLineId, BigDecimal issueQty) {
        var used = jdbcTemplate.queryForObject("""
            SELECT COALESCE(SUM(line.scrap_qty), 0)
            FROM production_material_scrap_line line
            JOIN production_material_scrap header ON header.id = line.scrap_id
            WHERE line.source_issue_line_id = ?::uuid
              AND header.status = 'AUDITED'
            """, BigDecimal.class, sourceLineId);
        return issueQty.subtract(used == null ? BigDecimal.ZERO : used);
    }

    private Map<String, Object> requireScrapHeader(String billNo, boolean lock) {
        var header = optionalScrapHeader(billNo, lock);
        if (header == null) {
            throw new ResponseStatusException(HttpStatus.NOT_FOUND, "材料报废单不存在");
        }
        return header;
    }

    private Map<String, Object> optionalScrapHeader(String billNo) {
        return optionalScrapHeader(billNo, false);
    }

    private Map<String, Object> optionalScrapHeader(String billNo, boolean lock) {
        if (lock) {
            var locked = jdbcTemplate.queryForList("""
                SELECT id::text AS id
                FROM production_material_scrap
                WHERE bill_no = ?
                FOR UPDATE
                """, billNo);
            if (locked.isEmpty()) {
                return null;
            }
        }
        var rows = jdbcTemplate.queryForList("""
            SELECT s.id::text AS id,
                   s.bill_no AS "billNo",
                   s.bill_date AS "billDate",
                   s.business_type AS "businessType",
                   s.source_issue_id::text AS "sourceIssueId",
                   issue.bill_no AS "sourceIssueNo",
                   s.workshop_id::text AS "workshopId",
                   s.workshop_code_snapshot AS "workshopCode",
                   s.workshop_name_snapshot AS "workshopName",
                   s.status,
                   s.close_status AS "closeStatus",
                   s.frozen_status AS "frozenStatus",
                   s.version,
                   CASE
                       WHEN COUNT(line.id) FILTER (WHERE line.is_stock_in) = 0 THEN 'NOT_REQUIRED'
                       WHEN COUNT(line.id) FILTER (WHERE line.is_stock_in AND line.stock_in_status = 'STOCKED_IN') > 0 THEN 'STOCKED_IN'
                       WHEN COUNT(line.id) FILTER (WHERE line.is_stock_in AND line.stock_in_status = 'REVERSED') = COUNT(line.id) FILTER (WHERE line.is_stock_in) THEN 'REVERSED'
                       ELSE 'PENDING'
                   END AS "stockInStatus"
            FROM production_material_scrap s
            JOIN production_material_issue issue ON issue.id = s.source_issue_id
            LEFT JOIN production_material_scrap_line line ON line.scrap_id = s.id
            WHERE s.bill_no = ?
            GROUP BY s.id, issue.bill_no
            """, billNo);
        return rows.isEmpty() ? null : rows.getFirst();
    }

    private List<Map<String, Object>> scrapLines(String scrapId, boolean lock) {
        return jdbcTemplate.queryForList("""
            SELECT line.id::text AS id,
                   line.line_no AS "lineNo",
                   line.source_issue_line_id::text AS "sourceIssueLineId",
                   line.product_id::text AS "productId",
                   line.product_code_snapshot AS "productCode",
                   line.product_name_snapshot AS "productName",
                   line.product_spec_snapshot AS spec,
                   line.product_unit_snapshot AS unit,
                   line.source_warehouse_id::text AS "sourceWarehouseId",
                   line.source_warehouse_code_snapshot AS "sourceWarehouseCode",
                   line.issue_qty_snapshot AS "issueQty",
                   line.available_scrap_qty_snapshot AS "availableScrapQty",
                   line.scrap_qty AS "scrapQty",
                   line.scrap_reason AS "scrapReason",
                   line.reissue_qty AS "reissueQty",
                   line.is_stock_in AS "isStockIn",
                   line.target_warehouse_id::text AS "targetWarehouseId",
                   line.target_warehouse_code_snapshot AS "targetWarehouseCode",
                   line.stock_in_status AS "stockInStatus"
            FROM production_material_scrap_line line
            WHERE line.scrap_id = ?::uuid
            ORDER BY line.line_no, line.id
            %s
            """.formatted(lock ? "FOR UPDATE" : ""), scrapId);
    }

    private Map<String, Object> stockActionResult(Map<String, Object> header, String stockStatus, boolean idempotent) {
        var result = new LinkedHashMap<String, Object>();
        result.put("id", header.get("id"));
        result.put("billNo", header.get("billNo"));
        result.put("status", header.get("status"));
        result.put("stockInStatus", stockStatus);
        result.put("idempotent", idempotent);
        return result;
    }

    private BigDecimal totalScrapQty(List<Map<String, Object>> lines) {
        return lines.stream()
            .map(line -> (BigDecimal) line.get("scrapQty"))
            .reduce(BigDecimal.ZERO, BigDecimal::add);
    }

    private String normalizeBusinessType(String value) {
        var normalized = validationService.optionalText(value);
        if (normalized == null) {
            return BUSINESS_TYPE;
        }
        if (!BUSINESS_TYPE.equals(normalized)) {
            throw badRequest("首版材料报废业务类型只允许 PRODUCTION_SCRAP");
        }
        return normalized;
    }

    private String requireUuid(String value, String label) {
        try {
            return UUID.fromString(value == null ? "" : value.trim()).toString();
        } catch (IllegalArgumentException exception) {
            throw badRequest(label + "格式不正确");
        }
    }

    private ResponseStatusException badRequest(String message) {
        return new ResponseStatusException(HttpStatus.BAD_REQUEST, message);
    }

    private ResponseStatusException conflict(String message) {
        return new ResponseStatusException(HttpStatus.CONFLICT, message);
    }

    public record ScrapDraftRequest(
        String billNo,
        String sourceIssueNo,
        LocalDate billDate,
        String businessType,
        List<ScrapLineRequest> lines
    ) {
    }

    public record ScrapLineRequest(
        String sourceIssueLineId,
        BigDecimal scrapQty,
        String scrapReason,
        BigDecimal reissueQty,
        Boolean isStockIn,
        String targetWarehouseCode
    ) {
    }

    private record NormalizedScrapLine(
        String sourceLineId,
        Map<String, Object> source,
        BigDecimal scrapQty,
        String scrapReason,
        BigDecimal reissueQty,
        boolean isStockIn,
        String targetWarehouseId,
        String targetWarehouseCode
    ) {
    }
}
