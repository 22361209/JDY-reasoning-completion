package com.jdy.erp.production.application;

import java.math.BigDecimal;
import java.util.List;
import java.util.Map;

import com.jdy.erp.shared.application.LookupService;
import com.jdy.erp.shared.application.NumberingService;
import com.jdy.erp.shared.application.OperationLogService;
import com.jdy.erp.shared.application.ValidationService;
import com.jdy.erp.shared.domain.BillStatus;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.server.ResponseStatusException;

@Service
public class ProductionTaskAppService {
    private final JdbcTemplate jdbcTemplate;
    private final LookupService lookupService;
    private final ValidationService validationService;
    private final OperationLogService operationLogService;
    private final NumberingService numberingService;

    public ProductionTaskAppService(JdbcTemplate jdbcTemplate, LookupService lookupService, ValidationService validationService, OperationLogService operationLogService, NumberingService numberingService) {
        this.jdbcTemplate = jdbcTemplate;
        this.lookupService = lookupService;
        this.validationService = validationService;
        this.operationLogService = operationLogService;
        this.numberingService = numberingService;
    }

    @Transactional
    public Map<String, Object> saveBom(BomRequest request) {
        var productId = lookupService.lookupEnabledId("md_product", request.productCode(), "成品");
        var rows = jdbcTemplate.queryForList("""
            INSERT INTO prod_bom (code, product_id, qty, enabled)
            VALUES (?, ?::uuid, ?, TRUE)
            ON CONFLICT (code) DO UPDATE
            SET product_id = EXCLUDED.product_id,
                qty = EXCLUDED.qty,
                enabled = TRUE
            RETURNING id::text AS id, code, qty
            """, validationService.required(request.code(), "BOM 编码"), productId, positive(request.qty(), "BOM 数量"));
        var bomId = String.valueOf(rows.get(0).get("id"));
        jdbcTemplate.update("DELETE FROM prod_bom_line WHERE bom_id = ?::uuid", bomId);
        var lineNo = 1;
        for (var line : request.lines()) {
            jdbcTemplate.update("""
                INSERT INTO prod_bom_line (bom_id, line_no, material_id, qty)
                VALUES (?::uuid, ?, ?::uuid, ?)
                """,
                bomId,
                lineNo,
                lookupService.lookupEnabledId("md_product", line.materialCode(), "物料"),
                positive(line.qty(), "物料用量")
            );
            lineNo += 1;
        }
        operationLogService.log("PRODUCTION", "SAVE_BOM", "prod_bom", bomId, true, null);
        return rows.get(0);
    }

    @Transactional
    public Map<String, Object> createTask(TaskRequest request) {
        var billNo = numberingService.assignBillNo("productionTask", request.billNo());
        var bomRows = jdbcTemplate.queryForList("""
            SELECT b.id::text AS id, b.product_id::text AS product_id
            FROM prod_bom b
            WHERE b.code = ? AND b.enabled = TRUE
            """, validationService.required(request.bomCode(), "BOM 编码"));
        if (bomRows.isEmpty()) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "BOM 不存在或未启用");
        }
        var warehouseId = lookupService.lookupEnabledId("md_warehouse", request.warehouseCode(), "完工仓库");
        var bom = bomRows.get(0);
        var rows = jdbcTemplate.queryForList("""
            INSERT INTO production_task (bill_no, bom_id, product_id, warehouse_id, qty, status)
            VALUES (?, ?::uuid, ?::uuid, ?::uuid, ?, ?)
            ON CONFLICT (bill_no) DO UPDATE
            SET bom_id = EXCLUDED.bom_id,
                product_id = EXCLUDED.product_id,
                warehouse_id = EXCLUDED.warehouse_id,
                qty = EXCLUDED.qty,
                status = EXCLUDED.status,
                updated_at = now()
            RETURNING id::text AS id, bill_no AS "billNo", qty, status
            """,
            billNo,
            bom.get("id"),
            bom.get("product_id"),
            warehouseId,
            positive(request.qty(), "生产数量"),
            BillStatus.AUDITED.name()
        );
        operationLogService.log("PRODUCTION", "CREATE_TASK", "production_task", String.valueOf(rows.get(0).get("id")), true, null);
        return rows.get(0);
    }

    private BigDecimal positive(BigDecimal value, String label) {
        if (value == null || value.compareTo(BigDecimal.ZERO) <= 0) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, label + "必须大于 0");
        }
        return value;
    }

    public record BomRequest(String code, String productCode, BigDecimal qty, List<BomLineRequest> lines) {
        public BomRequest {
            if (lines == null || lines.isEmpty()) {
                throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "BOM 至少需要一条物料");
            }
        }
    }

    public record BomLineRequest(String materialCode, BigDecimal qty) {
    }

    public record TaskRequest(String billNo, String bomCode, String warehouseCode, BigDecimal qty) {
    }
}
