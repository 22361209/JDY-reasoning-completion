DO $$
DECLARE
    tenant_schema TEXT;
BEGIN
    FOR tenant_schema IN
        SELECT DISTINCT COALESCE(NULLIF(schema_name, ''), 'public')
        FROM sys_account_set
    LOOP
        IF to_regclass(format('%I.md_production_department', tenant_schema)) IS NULL THEN
            CONTINUE;
        END IF;

        EXECUTE format($sql$
            INSERT INTO %1$I.md_production_department (code, name, manager, remark, enabled, audit_status)
            VALUES
                ('CY', '冲压车间', '本地管理员', '冲压件生产与完工交接', TRUE, 'AUDITED'),
                ('HJ', '焊接车间', '本地管理员', '焊接件生产与完工交接', TRUE, 'AUDITED'),
                ('JG', '金工车间', '本地管理员', '金加工生产与完工交接', TRUE, 'AUDITED'),
                ('AZ', '安装车间', '本地管理员', '安装生产与完工交接', TRUE, 'AUDITED'),
                ('BZ', '包装车间', '本地管理员', '包装生产与完工交接', TRUE, 'AUDITED')
            ON CONFLICT (code) DO UPDATE
            SET name = EXCLUDED.name,
                manager = EXCLUDED.manager,
                remark = EXCLUDED.remark,
                enabled = TRUE,
                audit_status = 'AUDITED',
                updated_at = now()
        $sql$, tenant_schema);

        EXECUTE format($sql$
            UPDATE %1$I.md_product product
            SET default_workshop = department.name,
                default_workshop_id = department.id,
                updated_at = now(),
                version = product.version + 1
            FROM %1$I.md_production_department department
            WHERE product.default_workshop_id IS NULL
              AND department.code IN ('AZ', 'BZ', 'CY', 'HJ', 'JG')
              AND product.default_workshop IN (department.code, department.name)
        $sql$, tenant_schema);

        EXECUTE format($sql$
            UPDATE %1$I.md_product product
            SET default_workshop = '',
                default_workshop_id = NULL,
                updated_at = now(),
                version = product.version + 1
            FROM %1$I.md_production_department department
            WHERE product.default_workshop_id = department.id
              AND department.code NOT IN ('AZ', 'BZ', 'CY', 'HJ', 'JG')
        $sql$, tenant_schema);

        EXECUTE format($sql$
            UPDATE %1$I.md_product
            SET default_workshop = '',
                default_workshop_id = NULL,
                updated_at = now(),
                version = version + 1
            WHERE default_workshop_id IS NULL
              AND trim(COALESCE(default_workshop, '')) <> ''
              AND default_workshop NOT IN ('AZ', 'BZ', 'CY', 'HJ', 'JG', '安装车间', '包装车间', '冲压车间', '焊接车间', '金工车间')
        $sql$, tenant_schema);

        EXECUTE format($sql$
            DELETE FROM %1$I.md_production_department
            WHERE code NOT IN ('AZ', 'BZ', 'CY', 'HJ', 'JG')
        $sql$, tenant_schema);
    END LOOP;
END $$;
