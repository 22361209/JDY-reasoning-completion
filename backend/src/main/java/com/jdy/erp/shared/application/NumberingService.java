package com.jdy.erp.shared.application;

import java.util.Map;
import java.util.List;
import org.springframework.dao.EmptyResultDataAccessException;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;
import org.springframework.web.server.ResponseStatusException;

import com.jdy.erp.system.tenant.TenantDataScopeService;

@Service
public class NumberingService {
    private static final int SEQUENCE_LENGTH = 6;
    private static final Map<String, NumberingRule> RULES = Map.ofEntries(
        Map.entry("salesOrder", new NumberingRule("XSDD", "sales_order", "销售订单")),
        Map.entry("salesQuote", new NumberingRule("XSBJ", "sales_quote", "销售报价单")),
        Map.entry("deliveryNotice", new NumberingRule("FHTZD", "delivery_notice", "发货通知单")),
        Map.entry("salesOut", new NumberingRule("XSCKD", "sales_out", "销售出库单")),
        Map.entry("arReceipt", new NumberingRule("SKD", "ar_receipt", "收款单")),
        Map.entry("purchaseOrder", new NumberingRule("CGDD", "purchase_order", "采购订单")),
        Map.entry("purchaseRequisition", new NumberingRule("CGSQ", "purchase_requisition", "采购申请单")),
        Map.entry("purchaseIn", new NumberingRule("CGRK", "purchase_in", "采购入库单")),
        Map.entry("apPayment", new NumberingRule("FKD", "ap_payment", "付款单")),
        Map.entry("purchaseReturn", new NumberingRule("CGTH", "purchase_return", "采购退货单")),
        Map.entry("materialIssue", new NumberingRule("SOUT", "production_material_issue", "生产领料单")),
        Map.entry("productIn", new NumberingRule("SCRK", "production_completion", "产品入库单")),
        Map.entry("otherStockIn", new NumberingRule("QTRK", "other_stock_in", "其他入库单")),
        Map.entry("otherStockOut", new NumberingRule("QTCK", "other_stock_out", "其他出库单")),
        Map.entry("stockTransfer", new NumberingRule("ZJDB", "stock_transfer", "调拨单")),
        Map.entry("stockCount", new NumberingRule("PD", "stock_count", "盘点单")),
        Map.entry("stockCountGain", new NumberingRule("PY", "stock_count_gain", "盘盈单")),
        Map.entry("stockCountLoss", new NumberingRule("PK", "stock_count_loss", "盘亏单")),
        Map.entry("productionPlan", new NumberingRule("SCJH", "production_plan", "生产计划")),
        Map.entry("productionTask", new NumberingRule("SCRW", "production_task", "生产任务单")),
        Map.entry("outsourcingWorkOrder", new NumberingRule("WWJG", "outsourcing_work_order", "委外加工单")),
        Map.entry("outsourcingIssue", new NumberingRule("WWFL", "outsourcing_material_issue", "委外发料单")),
        Map.entry("outsourcingReceipt", new NumberingRule("WWRK", "outsourcing_receipt", "委外产品入库单")),
        Map.entry("outsourcingReturn", new NumberingRule("WWTH", "outsourcing_return", "委外产品退货单")),
        Map.entry("outsourcingScrap", new NumberingRule("WWBF", "outsourcing_scrap", "委外产品报废单"))
    );

    private final JdbcTemplate jdbcTemplate;
    private final ValidationService validationService;
    private final TenantDataScopeService tenantDataScopeService;

    public NumberingService(JdbcTemplate jdbcTemplate, ValidationService validationService, TenantDataScopeService tenantDataScopeService) {
        this.jdbcTemplate = jdbcTemplate;
        this.validationService = validationService;
        this.tenantDataScopeService = tenantDataScopeService;
    }

    public synchronized String nextBillNo(String documentType) {
        var rule = ruleFor(documentType);
        var accountSetId = numberingScopeId();
        var currentMax = currentMaxSequence(rule);
        jdbcTemplate.update("""
            INSERT INTO document_number_sequence (account_set_id, document_type, prefix, last_number, width, description)
            VALUES (?::uuid, ?, ?, ?, ?, ?)
            ON CONFLICT (account_set_id, document_type) DO NOTHING
            """, accountSetId, documentType, rule.prefix(), currentMax, SEQUENCE_LENGTH, rule.label());
        Map<String, Object> row;
        try {
            row = jdbcTemplate.queryForMap("""
                UPDATE document_number_sequence
                SET last_number = GREATEST(last_number, ?) + 1,
                    updated_at = now()
                WHERE account_set_id = ?::uuid
                  AND document_type = ?
                  AND enabled = TRUE
                RETURNING prefix, last_number AS "lastNumber", width
                """, currentMax, accountSetId, documentType);
        } catch (EmptyResultDataAccessException exception) {
            throw new ResponseStatusException(HttpStatus.CONFLICT, "当前单据编号规则已禁用，不能生成新编号");
        }
        var prefix = String.valueOf(row.get("prefix"));
        var width = Number.class.cast(row.get("width")).intValue();
        var nextSeq = Number.class.cast(row.get("lastNumber")).intValue();
        return prefix + String.format("%0" + width + "d", nextSeq);
    }

    public List<Map<String, Object>> listRules() {
        var accountSetId = numberingScopeId();
        ensureDefaultRules(accountSetId);
        return jdbcTemplate.queryForList("""
            SELECT document_type AS "documentType",
                   COALESCE(description, document_type) AS label,
                   document_type AS "typeCode",
                   prefix,
                   last_number AS "lastNumber",
                   width,
                   enabled,
                   to_char(updated_at, 'YYYY-MM-DD HH24:MI') AS "updatedAt"
            FROM document_number_sequence
            WHERE account_set_id = ?::uuid
            ORDER BY description, document_type
            """, accountSetId);
    }

    public Map<String, Object> saveRule(String documentType, String prefix, Integer width, Integer lastNumber, Boolean enabled) {
        var rule = ruleFor(documentType);
        var normalizedPrefix = validationService.required(prefix, "编号前缀");
        if (!normalizedPrefix.matches("[A-Za-z0-9_-]{1,24}")) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "编号前缀只能使用 1-24 位字母、数字、下划线或短横线");
        }
        var normalizedWidth = width == null ? SEQUENCE_LENGTH : width;
        if (normalizedWidth < 3 || normalizedWidth > 12) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "流水位数需在 3-12 位之间");
        }
        var normalizedLastNumber = lastNumber == null ? 0 : Math.max(0, lastNumber);
        var accountSetId = numberingScopeId();
        jdbcTemplate.update("""
            INSERT INTO document_number_sequence (account_set_id, document_type, prefix, last_number, width, description, enabled)
            VALUES (?::uuid, ?, ?, ?, ?, ?, ?)
            ON CONFLICT (account_set_id, document_type) DO UPDATE
            SET prefix = EXCLUDED.prefix,
                last_number = EXCLUDED.last_number,
                width = EXCLUDED.width,
                description = EXCLUDED.description,
                enabled = EXCLUDED.enabled,
                updated_at = now()
            """, accountSetId, documentType, normalizedPrefix, normalizedLastNumber, normalizedWidth, rule.label(), enabled == null || enabled);
        return Map.of("ok", true, "rule", ruleForDocumentType(documentType));
    }

    public String assignBillNo(String documentType, String requestedBillNo) {
        var requested = validationService.optionalText(requestedBillNo);
        if (requested == null) {
            return nextBillNo(documentType);
        }
        var rule = ruleFor(documentType);
        var statuses = jdbcTemplate.queryForList(
            "SELECT status FROM " + rule.tableName() + " WHERE bill_no = ?",
            String.class,
            requested
        );
        if (statuses.isEmpty()) {
            throw new ResponseStatusException(HttpStatus.CONFLICT, "单据编号只能由系统自动生成，不能手工指定");
        }
        if (!"DRAFT".equals(statuses.get(0))) {
            throw new ResponseStatusException(HttpStatus.CONFLICT, "只有草稿单据可以保存覆盖，已审核或已进入生命周期的单据不能通过保存修改");
        }
        return requested;
    }

    private NumberingRule ruleFor(String documentType) {
        var rule = RULES.get(documentType);
        if (rule == null) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "不支持的单据类型");
        }
        return rule;
    }

    private int currentMaxSequence(NumberingRule rule) {
        var tableExists = Boolean.TRUE.equals(jdbcTemplate.queryForObject(
            "SELECT to_regclass(?) IS NOT NULL",
            Boolean.class,
            rule.tableName()
        ));
        if (!tableExists) {
            return 0;
        }
        var maxSeq = jdbcTemplate.queryForObject("""
            SELECT COALESCE(MAX(CAST(SUBSTRING(bill_no FROM ?) AS INTEGER)), 0)
            FROM %s
            WHERE bill_no ~ ?
            """.formatted(rule.tableName()),
            Integer.class,
            "^" + rule.prefix() + "([0-9]{" + SEQUENCE_LENGTH + "})$",
            "^" + rule.prefix() + "[0-9]{" + SEQUENCE_LENGTH + "}$"
        );
        return maxSeq == null ? 0 : maxSeq;
    }

    private void ensureDefaultRules(String accountSetId) {
        RULES.forEach((documentType, rule) -> jdbcTemplate.update("""
            INSERT INTO document_number_sequence (account_set_id, document_type, prefix, last_number, width, description)
            VALUES (?::uuid, ?, ?, ?, ?, ?)
            ON CONFLICT (account_set_id, document_type) DO UPDATE
            SET description = EXCLUDED.description,
                width = COALESCE(document_number_sequence.width, EXCLUDED.width),
                updated_at = document_number_sequence.updated_at
            """, accountSetId, documentType, rule.prefix(), currentMaxSequence(rule), SEQUENCE_LENGTH, rule.label()));
    }

    private Map<String, Object> ruleForDocumentType(String documentType) {
        var rows = jdbcTemplate.queryForList("""
            SELECT document_type AS "documentType",
                   COALESCE(description, document_type) AS label,
                   document_type AS "typeCode",
                   prefix,
                   last_number AS "lastNumber",
                   width,
                   enabled,
                   to_char(updated_at, 'YYYY-MM-DD HH24:MI') AS "updatedAt"
            FROM document_number_sequence
            WHERE account_set_id = ?::uuid
              AND document_type = ?
            """, numberingScopeId(), documentType);
        if (rows.isEmpty()) {
            throw new ResponseStatusException(HttpStatus.NOT_FOUND, "编号规则不存在");
        }
        return rows.get(0);
    }

    private String numberingScopeId() {
        return tenantDataScopeService.currentScopeId("numbering");
    }

    private record NumberingRule(String prefix, String tableName, String label) {
    }
}
