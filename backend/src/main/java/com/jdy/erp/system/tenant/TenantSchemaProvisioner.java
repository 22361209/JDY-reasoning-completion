package com.jdy.erp.system.tenant;

import java.util.List;

import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;

@Service
public class TenantSchemaProvisioner {
    private static final int EXPECTED_MANAGED_TABLE_COUNT = 89;
    private final JdbcTemplate platformJdbcTemplate;

    public TenantSchemaProvisioner(@Qualifier("platformJdbcTemplate") JdbcTemplate platformJdbcTemplate) {
        this.platformJdbcTemplate = platformJdbcTemplate;
    }

    public void provisionSchema(String schemaName) {
        synchronizeSchema(schemaName, false);
    }

    public void provisionNewSchema(String schemaName) {
        synchronizeSchema(schemaName, true);
    }

    private void synchronizeSchema(String schemaName, boolean createMissing) {
        if (isPlatformSchema(schemaName)) {
            return;
        }
        var schema = normalizeSchemaName(schemaName);
        var managedTableCount = platformJdbcTemplate.queryForObject(
            "SELECT public.jdy_sync_tenant_schema(?, ?)",
            Integer.class,
            schema,
            createMissing
        );
        if (managedTableCount == null || managedTableCount != EXPECTED_MANAGED_TABLE_COUNT) {
            throw new IllegalStateException(
                "tenant schema 同步未返回完整的 " + EXPECTED_MANAGED_TABLE_COUNT + " 张受管表：schema=" + schema + ", count=" + managedTableCount
            );
        }
        seedTenantDefaults(schema);
    }

    public List<String> tenantTableNames() {
        return platformJdbcTemplate.queryForList("""
            SELECT table_name
            FROM public.sys_tenant_managed_table
            ORDER BY restore_order
            """, String.class);
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
            INSERT INTO %s.md_warehouse (code, name, warehouse_type, manager, allow_negative_stock, remark, enabled, audit_status)
            VALUES
                ('CK-001', '冲压区材料仓', '原料仓', '本地管理员', FALSE, '默认仓库', TRUE, 'AUDITED'),
                ('CK-002', '冲压区片件仓', '半成品仓', '本地管理员', FALSE, '默认仓库', TRUE, 'AUDITED'),
                ('CK-003', '焊接区片件仓', '半成品仓', '本地管理员', FALSE, '默认仓库', TRUE, 'AUDITED'),
                ('CK-004', '焊接区配件仓', '半成品仓', '本地管理员', FALSE, '默认仓库', TRUE, 'AUDITED'),
                ('CK-005', '安装区成品仓', '成品仓', '本地管理员', FALSE, '默认仓库', TRUE, 'AUDITED'),
                ('CK-006', '安装区配件仓', '半成品仓', '本地管理员', FALSE, '默认仓库', TRUE, 'AUDITED'),
                ('CK-007', '安装区辅材仓', '普通仓', '本地管理员', FALSE, '默认仓库', TRUE, 'AUDITED'),
                ('CK-008', '安装区毛坯仓', '原料仓', '本地管理员', FALSE, '默认仓库', TRUE, 'AUDITED')
            ON CONFLICT (code) DO UPDATE
            SET name = EXCLUDED.name,
                warehouse_type = EXCLUDED.warehouse_type,
                manager = EXCLUDED.manager,
                allow_negative_stock = EXCLUDED.allow_negative_stock,
                remark = EXCLUDED.remark,
                enabled = TRUE,
                audit_status = 'AUDITED'
            """.formatted(quoteIdentifier(schema)));
        platformJdbcTemplate.update("""
            INSERT INTO %s.md_production_department (code, name, manager, remark, enabled, audit_status)
            VALUES
                ('CY', '冲压车间', '', '账套初始化默认车间', TRUE, 'AUDITED'),
                ('HJ', '焊接车间', '', '账套初始化默认车间', TRUE, 'AUDITED'),
                ('JG', '金工车间', '', '账套初始化默认车间', TRUE, 'AUDITED'),
                ('AZ', '安装车间', '', '账套初始化默认车间', TRUE, 'AUDITED'),
                ('BZ', '包装车间', '', '账套初始化默认车间', TRUE, 'AUDITED')
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
