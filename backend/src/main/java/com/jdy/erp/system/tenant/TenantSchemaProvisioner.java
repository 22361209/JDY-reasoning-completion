package com.jdy.erp.system.tenant;

import java.util.List;

import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;

@Service
public class TenantSchemaProvisioner {
    private static final List<String> TENANT_TABLES = List.of(
        "document_number_sequence",
        "doc_edit_lock",
        "sys_list_filter_preset",
        "sys_operation_log",
        "sys_outbox_event",
        "sys_notification_outbox",
        "sys_print_template",
        "md_product",
        "md_customer",
        "md_supplier",
        "md_warehouse",
        "md_product_category",
        "md_unit",
        "md_product_partner_code",
        "md_production_department",
        "inv_stock_balance",
        "inv_stock_txn",
        "inv_stock_opening",
        "inv_safety_stock_setting",
        "other_stock_in",
        "other_stock_in_line",
        "other_stock_out",
        "other_stock_out_line",
        "stock_count",
        "stock_count_line",
        "stock_count_gain",
        "stock_count_gain_line",
        "stock_count_loss",
        "stock_count_loss_line",
        "stock_transfer",
        "stock_transfer_line",
        "sales_quote",
        "sales_quote_line",
        "sales_order",
        "sales_order_line",
        "delivery_notice",
        "delivery_notice_line",
        "sales_out",
        "sales_out_line",
        "purchase_requisition",
        "purchase_requisition_line",
        "purchase_order",
        "purchase_order_line",
        "purchase_in",
        "purchase_in_line",
        "purchase_return",
        "purchase_return_line",
        "prod_bom",
        "prod_bom_line",
        "production_plan",
        "production_task",
        "production_task_material_snapshot",
        "production_material_issue",
        "production_material_issue_line",
        "production_completion",
        "production_completion_line",
        "outsourcing_work_order",
        "outsourcing_work_order_line",
        "outsourcing_work_order_component",
        "outsourcing_material_issue",
        "outsourcing_material_issue_line",
        "outsourcing_receipt",
        "outsourcing_receipt_line",
        "outsourcing_return",
        "outsourcing_return_line",
        "outsourcing_scrap",
        "outsourcing_scrap_line",
        "outsourcing_surface_process",
        "ar_receivable",
        "ar_receipt",
        "ap_payable",
        "ap_payment"
    );

    private final JdbcTemplate platformJdbcTemplate;

    public TenantSchemaProvisioner(@Qualifier("platformJdbcTemplate") JdbcTemplate platformJdbcTemplate) {
        this.platformJdbcTemplate = platformJdbcTemplate;
    }

    public void provisionSchema(String schemaName) {
        if (isPlatformSchema(schemaName)) {
            return;
        }
        var schema = normalizeSchemaName(schemaName);
        platformJdbcTemplate.execute("CREATE SCHEMA IF NOT EXISTS " + quoteIdentifier(schema));
        for (var table : TENANT_TABLES) {
            if (sourceTableExists(table)) {
                platformJdbcTemplate.execute("""
                    CREATE TABLE IF NOT EXISTS %s.%s
                    (LIKE public.%s INCLUDING ALL)
                    """.formatted(quoteIdentifier(schema), quoteIdentifier(table), quoteIdentifier(table)));
            }
        }
        seedTenantDefaults(schema);
    }

    public List<String> tenantTableNames() {
        return List.copyOf(TENANT_TABLES);
    }

    public String defaultSchemaName(String accountSetCode) {
        var normalized = accountSetCode == null ? "" : accountSetCode.trim().toLowerCase();
        normalized = normalized.replaceAll("[^a-z0-9]+", "_").replaceAll("^_+|_+$", "");
        if (normalized.isBlank()) {
            normalized = "tenant";
        }
        return "tenant_" + normalized;
    }

    public String normalizeSchemaName(String schemaName) {
        var normalized = schemaName == null ? "" : schemaName.trim().toLowerCase();
        if (!normalized.matches("[a-z][a-z0-9_]{0,62}")) {
            throw new IllegalArgumentException("账套 schema 名称只能使用小写字母、数字和下划线，并且必须以字母开头");
        }
        return normalized;
    }

    public boolean isPlatformSchema(String schemaName) {
        return schemaName == null || schemaName.isBlank() || "public".equalsIgnoreCase(schemaName.trim());
    }

    private boolean sourceTableExists(String tableName) {
        return Boolean.TRUE.equals(platformJdbcTemplate.queryForObject(
            "SELECT to_regclass(?) IS NOT NULL",
            Boolean.class,
            "public." + tableName
        ));
    }

    private void seedTenantDefaults(String schema) {
        platformJdbcTemplate.update("""
            INSERT INTO %s.md_product_category (code, name, sort_no, enabled, audit_status)
            VALUES
                ('RAW', '原材料', 10, TRUE, 'AUDITED'),
                ('SEMI', '半成品', 20, TRUE, 'AUDITED'),
                ('FINISHED', '成品', 30, TRUE, 'AUDITED'),
                ('PACK', '包装辅料', 40, TRUE, 'AUDITED')
            ON CONFLICT (code) DO UPDATE
            SET name = EXCLUDED.name,
                sort_no = EXCLUDED.sort_no,
                enabled = TRUE,
                audit_status = 'AUDITED'
            """.formatted(quoteIdentifier(schema)));
        platformJdbcTemplate.update("""
            INSERT INTO %s.md_unit (code, name, decimal_places, sort_no, enabled, audit_status)
            VALUES
                ('PCS', 'PCS', 0, 10, TRUE, 'AUDITED'),
                ('KGS', 'KGS', 3, 20, TRUE, 'AUDITED'),
                ('个', '个', 0, 30, TRUE, 'AUDITED'),
                ('条', '条', 2, 40, TRUE, 'AUDITED'),
                ('箱', '箱', 0, 50, TRUE, 'AUDITED')
            ON CONFLICT (code) DO UPDATE
            SET name = EXCLUDED.name,
                decimal_places = EXCLUDED.decimal_places,
                sort_no = EXCLUDED.sort_no,
                enabled = TRUE,
                audit_status = 'AUDITED'
            """.formatted(quoteIdentifier(schema)));
        platformJdbcTemplate.update("""
            INSERT INTO %s.md_warehouse (code, name, allow_negative_stock, enabled, audit_status)
            VALUES ('CK-001', '默认仓库', FALSE, TRUE, 'AUDITED')
            ON CONFLICT (code) DO UPDATE
            SET name = EXCLUDED.name,
                allow_negative_stock = EXCLUDED.allow_negative_stock,
                enabled = TRUE,
                audit_status = 'AUDITED'
            """.formatted(quoteIdentifier(schema)));
        platformJdbcTemplate.update("""
            INSERT INTO %s.md_production_department (code, name, manager, remark, enabled, audit_status)
            VALUES ('SC-001', '默认生产车间', '', '账套初始化默认车间', TRUE, 'AUDITED')
            ON CONFLICT (code) DO UPDATE
            SET name = EXCLUDED.name,
                enabled = TRUE,
                audit_status = 'AUDITED'
            """.formatted(quoteIdentifier(schema)));
    }

    private String quoteIdentifier(String identifier) {
        return "\"" + identifier.replace("\"", "\"\"") + "\"";
    }
}
