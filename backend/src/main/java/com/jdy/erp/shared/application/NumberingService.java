package com.jdy.erp.shared.application;

import java.math.BigInteger;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.UUID;

import com.fasterxml.jackson.databind.JsonNode;
import com.jdy.erp.system.tenant.TenantDataScopeService;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.server.ResponseStatusException;

@Service
public class NumberingService {
    private static final int DEFAULT_SEQUENCE_WIDTH = 6;
    private static final List<NumberingRule> RULE_REGISTRY = List.of(
        new NumberingRule("salesOrder", "XSDD", "sales_order", "销售订单"),
        new NumberingRule("salesQuote", "XSBJ", "sales_quote", "销售报价单"),
        new NumberingRule("deliveryNotice", "FHTZD", "delivery_notice", "发货通知单"),
        new NumberingRule("salesOut", "XSCKD", "sales_out", "销售出库单"),
        new NumberingRule("salesReturn", "XSTH", "sales_return", "销售退货单"),
        new NumberingRule("arReceipt", "SKD", "ar_receipt", "收款单"),
        new NumberingRule("purchaseOrder", "CGDD", "purchase_order", "采购订单"),
        new NumberingRule("purchaseRequisition", "CGSQ", "purchase_requisition", "采购申请单"),
        new NumberingRule("purchasePlan", "CGJH", "purchase_plan", "采购计划单"),
        new NumberingRule("purchaseIn", "CGRK", "purchase_in", "采购入库单"),
        new NumberingRule("apPayment", "FKD", "ap_payment", "付款单"),
        new NumberingRule("cashTransfer", "ZJZZ", "cash_transfer", "资金转账单"),
        new NumberingRule("purchaseReturn", "CGTH", "purchase_return", "采购退货单"),
        new NumberingRule("materialIssue", "SOUT", "production_material_issue", "生产领料单"),
        new NumberingRule("materialScrap", "CLBF", "production_material_scrap", "材料报废单"),
        new NumberingRule("productIn", "SCRK", "production_completion", "产品入库单"),
        new NumberingRule("otherStockIn", "QTRK", "other_stock_in", "其他入库单"),
        new NumberingRule("otherStockOut", "QTCK", "other_stock_out", "其他出库单"),
        new NumberingRule("stockTransfer", "ZJDB", "stock_transfer", "调拨单"),
        new NumberingRule("stockCount", "PD", "stock_count", "盘点单"),
        new NumberingRule("stockCountGain", "PY", "stock_count_gain", "盘盈单"),
        new NumberingRule("stockCountLoss", "PK", "stock_count_loss", "盘亏单"),
        new NumberingRule("productionPlan", "SCJH", "production_plan", "生产计划"),
        new NumberingRule("productionTask", "SCRW", "production_task", "生产任务单"),
        new NumberingRule("outsourcingWorkOrder", "WWJG", "outsourcing_work_order", "委外加工单"),
        new NumberingRule("outsourcingIssue", "WWFL", "outsourcing_material_issue", "委外发料单"),
        new NumberingRule("outsourcingReceipt", "WWRK", "outsourcing_receipt", "委外产品入库单"),
        new NumberingRule("outsourcingReturn", "WWTH", "outsourcing_return", "委外产品退货单"),
        new NumberingRule("outsourcingScrap", "WWBF", "outsourcing_scrap", "委外产品报废单")
    );
    private static final Map<String, NumberingRule> RULES_BY_TYPE = registryByType();

    private final JdbcTemplate jdbcTemplate;
    private final ValidationService validationService;
    private final TenantDataScopeService tenantDataScopeService;
    private final OperationLogService operationLogService;

    public NumberingService(
        JdbcTemplate jdbcTemplate,
        ValidationService validationService,
        TenantDataScopeService tenantDataScopeService,
        OperationLogService operationLogService
    ) {
        this.jdbcTemplate = jdbcTemplate;
        this.validationService = validationService;
        this.tenantDataScopeService = tenantDataScopeService;
        this.operationLogService = operationLogService;
    }

    @Transactional
    public String nextBillNo(String documentType) {
        var rule = ruleFor(documentType);
        var accountSetId = numberingScopeId();
        ensureRuleRow(accountSetId, rule);
        var persisted = lockedRule(accountSetId, documentType);
        if (!persisted.enabled()) {
            throw conflict("当前单据编号规则已禁用，不能生成新编号");
        }
        var documentHighWater = currentMaxSequence(rule, persisted.prefix(), persisted.width());
        var safeHighWater = Math.max(persisted.lastNumber(), documentHighWater);
        var maximum = maximumForWidth(persisted.width());
        if (safeHighWater >= maximum) {
            throw conflict("当前单据编号已达到 " + persisted.width() + " 位流水上限，请先调整规则");
        }
        var next = safeHighWater + 1;
        jdbcTemplate.update("""
            UPDATE document_number_sequence
            SET last_number = ?,
                version = version + 1,
                updated_at = now()
            WHERE id = ?::uuid
            """, next, persisted.id().toString());
        return persisted.prefix() + String.format(Locale.ROOT, "%0" + persisted.width() + "d", next);
    }

    @Transactional(readOnly = true)
    public List<Map<String, Object>> listRules() {
        var accountSetId = numberingScopeId();
        var persisted = new LinkedHashMap<String, RuleRow>();
        jdbcTemplate.query("""
            SELECT id::text,
                   document_type,
                   prefix,
                   last_number,
                   width,
                   enabled,
                   version,
                   to_char(updated_at, 'YYYY-MM-DD HH24:MI') AS updated_at
            FROM document_number_sequence
            WHERE account_set_id = ?::uuid
            """, resultSet -> {
                var type = resultSet.getString("document_type");
                if (RULES_BY_TYPE.containsKey(type)) {
                    persisted.put(type, ruleRow(resultSet));
                }
            }, accountSetId);

        return RULE_REGISTRY.stream().map(rule -> {
            var row = persisted.get(rule.documentType());
            if (row != null) {
                return ruleResponse(rule, row);
            }
            var defaultHighWater = currentMaxSequence(rule, rule.prefix(), DEFAULT_SEQUENCE_WIDTH);
            return ruleResponse(rule, new RuleRow(
                null,
                rule.documentType(),
                rule.prefix(),
                defaultHighWater,
                DEFAULT_SEQUENCE_WIDTH,
                true,
                0,
                ""
            ));
        }).toList();
    }

    @Transactional
    public Map<String, Object> saveRule(
        String documentType,
        String prefix,
        Integer width,
        JsonNode lastNumber,
        Boolean enabled,
        JsonNode version
    ) {
        return saveRuleInternal(
            documentType,
            prefix,
            requiredWidth(width),
            strictNonNegativeLong(lastNumber, "当前流水"),
            requiredEnabled(enabled),
            strictNonNegativeLong(version, "version")
        );
    }

    @Transactional
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
            throw conflict("单据编号只能由系统自动生成，不能手工指定");
        }
        if (!"DRAFT".equals(statuses.getFirst())) {
            throw conflict("只有草稿单据可以保存覆盖，已审核或已进入生命周期的单据不能通过保存修改");
        }
        return requested;
    }

    private Map<String, Object> saveRuleInternal(
        String documentType,
        String prefix,
        int width,
        long lastNumber,
        boolean enabled,
        long expectedVersion
    ) {
        var rule = ruleFor(documentType);
        var normalizedPrefix = validationService.required(prefix, "编号前缀");
        if (!normalizedPrefix.matches("[A-Za-z0-9_-]{1,24}")) {
            throw badRequest("编号前缀只能使用 1-24 位字母、数字、下划线或短横线");
        }
        var maximum = maximumForWidth(width);
        if (lastNumber > maximum) {
            throw badRequest("当前流水不能超过 " + width + " 位流水上限 " + maximum);
        }

        var accountSetId = numberingScopeId();
        ensureRuleRow(accountSetId, rule);
        var before = lockedRule(accountSetId, documentType);
        if (before.version() != expectedVersion) {
            throw conflict("编号规则已被其他操作修改，请保留当前输入并重新核对后保存");
        }

        var currentDocumentHighWater = currentMaxSequence(rule, before.prefix(), before.width());
        var requestedDocumentHighWater = currentMaxSequence(rule, normalizedPrefix, width);
        var safeMinimum = Math.max(before.lastNumber(), Math.max(currentDocumentHighWater, requestedDocumentHighWater));
        if (lastNumber < safeMinimum) {
            throw conflict("当前流水不能回退，至少应为 " + safeMinimum);
        }

        var rows = jdbcTemplate.query("""
            UPDATE document_number_sequence
            SET prefix = ?,
                last_number = ?,
                width = ?,
                description = ?,
                enabled = ?,
                version = version + 1,
                updated_at = now()
            WHERE id = ?::uuid
            RETURNING id::text,
                      document_type,
                      prefix,
                      last_number,
                      width,
                      enabled,
                      version,
                      to_char(updated_at, 'YYYY-MM-DD HH24:MI') AS updated_at
            """, (resultSet, rowNumber) -> ruleRow(resultSet),
            normalizedPrefix,
            lastNumber,
            width,
            rule.label(),
            enabled,
            before.id().toString());
        if (rows.size() != 1) {
            throw new IllegalStateException("编号规则更新未返回唯一结果");
        }
        var after = rows.getFirst();
        operationLogService.logCurrent(OperationLogCommand.success(
            "SYSTEM",
            "UPDATE_NUMBERING_RULE",
            "NUMBERING_RULE",
            after.id(),
            documentType,
            OperationLogCommand.ActorMode.CURRENT_USER,
            null,
            logState(before),
            logState(after),
            null
        ));
        return Map.of("ok", true, "rule", ruleResponse(rule, after));
    }

    private Map<OperationLogCommand.StateField, Object> logState(RuleRow row) {
        return OperationLogCommand.state(
            OperationLogCommand.StateField.PREFIX, row.prefix(),
            OperationLogCommand.StateField.WIDTH, row.width(),
            OperationLogCommand.StateField.LAST_NUMBER, row.lastNumber(),
            OperationLogCommand.StateField.ENABLED, row.enabled(),
            OperationLogCommand.StateField.VERSION, row.version()
        );
    }

    private void ensureRuleRow(String accountSetId, NumberingRule rule) {
        var currentMax = currentMaxSequence(rule, rule.prefix(), DEFAULT_SEQUENCE_WIDTH);
        jdbcTemplate.update("""
            INSERT INTO document_number_sequence (
                account_set_id, document_type, prefix, last_number, width, description, enabled, version
            )
            VALUES (?::uuid, ?, ?, ?, ?, ?, TRUE, 0)
            ON CONFLICT (account_set_id, document_type) DO NOTHING
            """, accountSetId, rule.documentType(), rule.prefix(), currentMax, DEFAULT_SEQUENCE_WIDTH, rule.label());
    }

    private RuleRow lockedRule(String accountSetId, String documentType) {
        var rows = jdbcTemplate.query("""
            SELECT id::text,
                   document_type,
                   prefix,
                   last_number,
                   width,
                   enabled,
                   version,
                   to_char(updated_at, 'YYYY-MM-DD HH24:MI') AS updated_at
            FROM document_number_sequence
            WHERE account_set_id = ?::uuid
              AND document_type = ?
            FOR UPDATE
            """, (resultSet, rowNumber) -> ruleRow(resultSet), accountSetId, documentType);
        if (rows.size() != 1) {
            throw new IllegalStateException("编号规则行不存在或不唯一：" + documentType);
        }
        return rows.getFirst();
    }

    private RuleRow ruleRow(java.sql.ResultSet resultSet) throws java.sql.SQLException {
        var id = resultSet.getString("id");
        return new RuleRow(
            id == null ? null : UUID.fromString(id),
            resultSet.getString("document_type"),
            resultSet.getString("prefix"),
            resultSet.getLong("last_number"),
            resultSet.getInt("width"),
            resultSet.getBoolean("enabled"),
            resultSet.getLong("version"),
            resultSet.getString("updated_at") == null ? "" : resultSet.getString("updated_at")
        );
    }

    private Map<String, Object> ruleResponse(NumberingRule rule, RuleRow row) {
        var response = new LinkedHashMap<String, Object>();
        response.put("documentType", rule.documentType());
        response.put("label", rule.label());
        response.put("typeCode", rule.documentType());
        response.put("prefix", row.prefix());
        response.put("lastNumber", row.lastNumber());
        response.put("width", row.width());
        response.put("enabled", row.enabled());
        response.put("version", Long.toString(row.version()));
        response.put("updatedAt", row.updatedAt());
        return Collections.unmodifiableMap(response);
    }

    private NumberingRule ruleFor(String documentType) {
        var rule = RULES_BY_TYPE.get(documentType);
        if (rule == null) {
            throw badRequest("不支持的单据类型");
        }
        return rule;
    }

    private long currentMaxSequence(NumberingRule rule, String prefix, int width) {
        var tableExists = Boolean.TRUE.equals(jdbcTemplate.queryForObject(
            "SELECT to_regclass(?) IS NOT NULL",
            Boolean.class,
            rule.tableName()
        ));
        if (!tableExists) {
            return 0;
        }
        var pattern = "^" + prefix + "[0-9]{" + width + "}$";
        var lowerBound = prefix + "0".repeat(width);
        var upperBound = prefix + "9".repeat(width);
        // Every registered table is migration-guarded to have a single-column
        // unique btree bill_no index. Fixed-width decimal suffixes therefore let
        // PostgreSQL seek to the highest matching key instead of scanning all
        // historical documents for every issuance.
        var rows = jdbcTemplate.queryForList("""
            SELECT bill_no
            FROM %s
            WHERE bill_no >= ?
              AND bill_no <= ?
              AND bill_no ~ ?
            ORDER BY bill_no DESC
            LIMIT 1
            """.formatted(rule.tableName()), String.class, lowerBound, upperBound, pattern);
        if (rows.isEmpty()) {
            return 0;
        }
        return Long.parseLong(rows.getFirst().substring(prefix.length()));
    }

    private int requiredWidth(Integer width) {
        if (width == null || width < 3 || width > 12) {
            throw badRequest("流水位数需在 3-12 位之间");
        }
        return width;
    }

    private boolean requiredEnabled(Boolean enabled) {
        if (enabled == null) {
            throw badRequest("启用状态不能为空");
        }
        return enabled;
    }

    private long strictNonNegativeLong(JsonNode value, String label) {
        if (value != null && value.isIntegralNumber() && value.canConvertToLong()) {
            var parsed = value.longValue();
            if (parsed >= 0) {
                return parsed;
            }
        }
        if (value != null && value.isTextual()) {
            var text = value.textValue();
            if (text != null && text.length() <= 19 && text.matches("0|[1-9][0-9]*")) {
                try {
                    var parsed = new BigInteger(text);
                    if (parsed.compareTo(BigInteger.valueOf(Long.MAX_VALUE)) <= 0) {
                        return parsed.longValueExact();
                    }
                } catch (NumberFormatException | ArithmeticException ignored) {
                    // Fall through to the stable public validation message.
                }
            }
        }
        throw badRequest(label + " 必须是非负 64 位整数或规范十进制字符串");
    }

    private long maximumForWidth(int width) {
        long value = 1;
        for (int index = 0; index < width; index += 1) {
            value *= 10;
        }
        return value - 1;
    }

    private String numberingScopeId() {
        return tenantDataScopeService.currentScopeId("numbering");
    }

    private static Map<String, NumberingRule> registryByType() {
        var registry = new LinkedHashMap<String, NumberingRule>();
        RULE_REGISTRY.forEach(rule -> {
            if (registry.put(rule.documentType(), rule) != null) {
                throw new IllegalStateException("编号规则注册表存在重复类型：" + rule.documentType());
            }
        });
        if (registry.size() != 29) {
            throw new IllegalStateException("编号规则注册表必须精确包含 29 个正式单据类型");
        }
        return Collections.unmodifiableMap(registry);
    }

    private ResponseStatusException badRequest(String message) {
        return new ResponseStatusException(HttpStatus.BAD_REQUEST, message);
    }

    private ResponseStatusException conflict(String message) {
        return new ResponseStatusException(HttpStatus.CONFLICT, message);
    }

    private record NumberingRule(String documentType, String prefix, String tableName, String label) {
    }

    private record RuleRow(
        UUID id,
        String documentType,
        String prefix,
        long lastNumber,
        int width,
        boolean enabled,
        long version,
        String updatedAt
    ) {
    }
}
