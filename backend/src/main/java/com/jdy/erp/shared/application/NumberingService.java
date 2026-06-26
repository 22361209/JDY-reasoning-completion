package com.jdy.erp.shared.application;

import java.util.Map;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;
import org.springframework.web.server.ResponseStatusException;

@Service
public class NumberingService {
    private static final int SEQUENCE_LENGTH = 6;
    private static final Map<String, NumberingRule> RULES = Map.ofEntries(
        Map.entry("salesOrder", new NumberingRule("XSDD", "sales_order")),
        Map.entry("deliveryNotice", new NumberingRule("FHTZD", "delivery_notice")),
        Map.entry("salesOut", new NumberingRule("XSCKD", "sales_out")),
        Map.entry("purchaseOrder", new NumberingRule("CGDD", "purchase_order")),
        Map.entry("purchaseIn", new NumberingRule("CGRK", "purchase_in")),
        Map.entry("materialIssue", new NumberingRule("SOUT", "production_material_issue")),
        Map.entry("productIn", new NumberingRule("SCRK", "production_completion")),
        Map.entry("otherStockIn", new NumberingRule("QTRK", "other_stock_in")),
        Map.entry("otherStockOut", new NumberingRule("QTCK", "other_stock_out")),
        Map.entry("stockTransfer", new NumberingRule("ZJDB", "stock_transfer")),
        Map.entry("stockCount", new NumberingRule("PD", "stock_count")),
        Map.entry("stockCountGain", new NumberingRule("PY", "stock_count_gain")),
        Map.entry("stockCountLoss", new NumberingRule("PK", "stock_count_loss")),
        Map.entry("productionTask", new NumberingRule("SCRW", "production_task"))
    );

    private final JdbcTemplate jdbcTemplate;
    private final ValidationService validationService;

    public NumberingService(JdbcTemplate jdbcTemplate, ValidationService validationService) {
        this.jdbcTemplate = jdbcTemplate;
        this.validationService = validationService;
    }

    public synchronized String nextBillNo(String documentType) {
        var rule = ruleFor(documentType);
        var maxSeq = jdbcTemplate.queryForObject("""
            SELECT COALESCE(MAX(CAST(SUBSTRING(bill_no FROM ?) AS INTEGER)), 0)
            FROM %s
            WHERE bill_no ~ ?
            """.formatted(rule.tableName()),
            Integer.class,
            "^" + rule.prefix() + "([0-9]{" + SEQUENCE_LENGTH + "})$",
            "^" + rule.prefix() + "[0-9]{" + SEQUENCE_LENGTH + "}$"
        );
        return rule.prefix() + String.format("%0" + SEQUENCE_LENGTH + "d", (maxSeq == null ? 0 : maxSeq) + 1);
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
            return requested;
        }
        return "DRAFT".equals(statuses.get(0)) ? requested : nextBillNo(documentType);
    }

    private NumberingRule ruleFor(String documentType) {
        var rule = RULES.get(documentType);
        if (rule == null) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "不支持的单据类型");
        }
        return rule;
    }

    private record NumberingRule(String prefix, String tableName) {
    }
}
