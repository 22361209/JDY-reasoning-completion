package com.jdy.erp.outsourcing.application;

import java.math.BigDecimal;
import java.util.Map;

import com.jdy.erp.shared.application.LookupService;
import com.jdy.erp.shared.application.NumberingService;
import com.jdy.erp.shared.application.OperationLogService;
import com.jdy.erp.shared.application.ProductSnapshotService;
import com.jdy.erp.shared.application.ValidationService;
import com.jdy.erp.shared.domain.BillStatus;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.server.ResponseStatusException;

@Service
public class OutsourcingSurfaceAppService {
    private final JdbcTemplate jdbcTemplate;
    private final NumberingService numberingService;
    private final LookupService lookupService;
    private final ProductSnapshotService productSnapshotService;
    private final ValidationService validationService;
    private final OperationLogService operationLogService;

    public OutsourcingSurfaceAppService(
        JdbcTemplate jdbcTemplate,
        NumberingService numberingService,
        LookupService lookupService,
        ProductSnapshotService productSnapshotService,
        ValidationService validationService,
        OperationLogService operationLogService
    ) {
        this.jdbcTemplate = jdbcTemplate;
        this.numberingService = numberingService;
        this.lookupService = lookupService;
        this.productSnapshotService = productSnapshotService;
        this.validationService = validationService;
        this.operationLogService = operationLogService;
    }

    @Transactional
    public Map<String, Object> saveDraft(SurfaceProcessRequest request) {
        var billNo = numberingService.assignBillNo("outsourcingSurface", request.billNo());
        var source = resolveSource(request);
        var supplier = resolveSupplier(request.processorSupplierCode());
        var rows = jdbcTemplate.queryForList("""
            INSERT INTO outsourcing_surface_process (
                bill_no, source_completion_id, source_bill_no,
                product_id, product_code_snapshot, product_name_snapshot, product_spec_snapshot,
                product_unit_snapshot, net_weight_snapshot, gross_weight_snapshot,
                qty, processor_supplier_id, processor_supplier_code_snapshot, processor_supplier_name_snapshot,
                surface_treatment, status, remark
            )
            VALUES (?, ?::uuid, ?, ?::uuid, ?, ?, ?, ?, ?, ?, ?, ?::uuid, ?, ?, ?, ?, ?)
            ON CONFLICT (bill_no) DO UPDATE
            SET source_completion_id = EXCLUDED.source_completion_id,
                source_bill_no = EXCLUDED.source_bill_no,
                product_id = EXCLUDED.product_id,
                product_code_snapshot = EXCLUDED.product_code_snapshot,
                product_name_snapshot = EXCLUDED.product_name_snapshot,
                product_spec_snapshot = EXCLUDED.product_spec_snapshot,
                product_unit_snapshot = EXCLUDED.product_unit_snapshot,
                net_weight_snapshot = EXCLUDED.net_weight_snapshot,
                gross_weight_snapshot = EXCLUDED.gross_weight_snapshot,
                qty = EXCLUDED.qty,
                processor_supplier_id = EXCLUDED.processor_supplier_id,
                processor_supplier_code_snapshot = EXCLUDED.processor_supplier_code_snapshot,
                processor_supplier_name_snapshot = EXCLUDED.processor_supplier_name_snapshot,
                surface_treatment = EXCLUDED.surface_treatment,
                status = EXCLUDED.status,
                remark = EXCLUDED.remark,
                updated_at = now(),
                version = outsourcing_surface_process.version + 1
            WHERE outsourcing_surface_process.status = 'DRAFT'
            RETURNING id::text AS id, bill_no AS "billNo", status
            """,
            billNo,
            source.sourceCompletionId(),
            source.sourceBillNo(),
            source.product().id(),
            source.product().code(),
            source.product().name(),
            source.product().spec(),
            source.product().unit(),
            source.product().netWeight(),
            source.product().grossWeight(),
            source.qty(),
            supplier.id(),
            supplier.code(),
            supplier.name(),
            validationService.optionalText(request.surfaceTreatment()),
            BillStatus.DRAFT.name(),
            validationService.optionalText(request.remark())
        );
        if (rows.isEmpty()) {
            throw new ResponseStatusException(HttpStatus.CONFLICT, "只有草稿委外表面处理单可以覆盖保存");
        }
        operationLogService.log("OUTSOURCING", "SAVE_SURFACE_DRAFT", "outsourcing_surface_process", String.valueOf(rows.get(0).get("id")), true, null);
        return rows.get(0);
    }

    @Transactional
    public Map<String, Object> audit(String billNo) {
        return transition(billNo, BillStatus.DRAFT.name(), BillStatus.AUDITED.name(), "AUDIT_SURFACE", "委外表面处理单不存在或不是草稿");
    }

    @Transactional
    public Map<String, Object> complete(String billNo) {
        return transition(billNo, BillStatus.AUDITED.name(), "COMPLETED", "COMPLETE_SURFACE", "只有已发出的委外表面处理单可以完成");
    }

    private Map<String, Object> transition(String billNo, String from, String to, String action, String error) {
        var rows = jdbcTemplate.queryForList("""
            UPDATE outsourcing_surface_process
            SET status = ?, updated_at = now(), version = version + 1
            WHERE bill_no = ? AND status = ?
            RETURNING id::text AS id, bill_no AS "billNo", status
            """, to, billNo, from);
        if (rows.isEmpty()) {
            throw new ResponseStatusException(HttpStatus.CONFLICT, error);
        }
        operationLogService.log("OUTSOURCING", action, "outsourcing_surface_process", String.valueOf(rows.get(0).get("id")), true, null);
        return rows.get(0);
    }

    private SurfaceSource resolveSource(SurfaceProcessRequest request) {
        var sourceBillNo = validationService.optionalText(request.sourceBillNo());
        if (sourceBillNo != null) {
            var rows = jdbcTemplate.queryForList("""
                SELECT c.id::text AS "sourceCompletionId",
                       c.bill_no AS "sourceBillNo",
                       l.product_id::text AS "productId",
                       COALESCE(l.product_code_snapshot, p.code) AS "productCode",
                       COALESCE(l.product_name_snapshot, p.name) AS "productName",
                       COALESCE(l.product_spec_snapshot, p.spec, '') AS spec,
                       COALESCE(l.product_unit_snapshot, p.unit, '') AS unit,
                       COALESCE(l.net_weight_snapshot, p.net_weight) AS "netWeight",
                       COALESCE(l.gross_weight_snapshot, p.gross_weight) AS "grossWeight",
                       l.qty
                FROM production_completion c
                JOIN production_completion_line l ON l.completion_id = c.id
                JOIN md_product p ON p.id = l.product_id
                WHERE c.bill_no = ? AND c.status = ?
                ORDER BY l.line_no
                LIMIT 1
                """, sourceBillNo, BillStatus.AUDITED.name());
            if (rows.isEmpty()) {
                throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "产品入库单不存在或未审核");
            }
            var row = rows.get(0);
            var product = new ProductSnapshotService.ProductSnapshot(
                String.valueOf(row.get("productId")),
                String.valueOf(row.get("productCode")),
                String.valueOf(row.get("productName")),
                String.valueOf(row.get("spec")),
                String.valueOf(row.get("unit")),
                row.get("netWeight") instanceof BigDecimal net ? net : null,
                row.get("grossWeight") instanceof BigDecimal gross ? gross : null
            );
            return new SurfaceSource(String.valueOf(row.get("sourceCompletionId")), sourceBillNo, product, positive(request.qty() == null ? (BigDecimal) row.get("qty") : request.qty(), "委外数量"));
        }
        var product = productSnapshotService.resolve(null, request.productCode(), "委外物料");
        return new SurfaceSource(null, null, product, positive(request.qty(), "委外数量"));
    }

    private SupplierSnapshot resolveSupplier(String supplierCode) {
        var code = validationService.optionalText(supplierCode);
        if (code == null) {
            return new SupplierSnapshot(null, null, null);
        }
        var supplierId = lookupService.lookupEnabledId("md_supplier", code, "委外供应商");
        var rows = jdbcTemplate.queryForList("SELECT code, name FROM md_supplier WHERE id = ?::uuid", supplierId);
        if (rows.isEmpty()) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "委外供应商不存在");
        }
        return new SupplierSnapshot(supplierId, String.valueOf(rows.get(0).get("code")), String.valueOf(rows.get(0).get("name")));
    }

    private BigDecimal positive(BigDecimal value, String label) {
        if (value == null || value.compareTo(BigDecimal.ZERO) <= 0) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, label + "必须大于 0");
        }
        return value;
    }

    private record SurfaceSource(String sourceCompletionId, String sourceBillNo, ProductSnapshotService.ProductSnapshot product, BigDecimal qty) {
    }

    private record SupplierSnapshot(String id, String code, String name) {
    }

    public record SurfaceProcessRequest(String billNo, String sourceBillNo, String productCode, BigDecimal qty, String processorSupplierCode, String surfaceTreatment, String remark) {
    }
}
