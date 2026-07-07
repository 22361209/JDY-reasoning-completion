DO $$
DECLARE
    tenant_schema TEXT;
BEGIN
    FOR tenant_schema IN
        SELECT DISTINCT COALESCE(NULLIF(schema_name, ''), 'public')
        FROM sys_account_set
    LOOP
        IF to_regclass(format('%I.md_warehouse', tenant_schema)) IS NULL THEN
            CONTINUE;
        END IF;

        EXECUTE format($sql$
            INSERT INTO %1$I.md_warehouse (code, name, warehouse_type, manager, phone, address, allow_negative_stock, remark, enabled, audit_status)
            VALUES
                ('CK-001', '冲压区材料仓', '原料仓', '本地管理员', NULL, NULL, FALSE, '默认仓库', TRUE, 'AUDITED'),
                ('CK-002', '冲压区片件仓', '半成品仓', '本地管理员', NULL, NULL, FALSE, '默认仓库', TRUE, 'AUDITED'),
                ('CK-003', '焊接区片件仓', '半成品仓', '本地管理员', NULL, NULL, FALSE, '默认仓库', TRUE, 'AUDITED'),
                ('CK-004', '焊接区配件仓', '半成品仓', '本地管理员', NULL, NULL, FALSE, '默认仓库', TRUE, 'AUDITED'),
                ('CK-005', '安装区成品仓', '成品仓', '本地管理员', NULL, NULL, FALSE, '默认仓库', TRUE, 'AUDITED'),
                ('CK-006', '安装区配件仓', '半成品仓', '本地管理员', NULL, NULL, FALSE, '默认仓库', TRUE, 'AUDITED'),
                ('CK-007', '安装区辅材仓', '普通仓', '本地管理员', NULL, NULL, FALSE, '默认仓库', TRUE, 'AUDITED'),
                ('CK-008', '安装区毛坯仓', '原料仓', '本地管理员', NULL, NULL, FALSE, '默认仓库', TRUE, 'AUDITED')
            ON CONFLICT (code) DO UPDATE
            SET name = EXCLUDED.name,
                warehouse_type = EXCLUDED.warehouse_type,
                manager = EXCLUDED.manager,
                phone = EXCLUDED.phone,
                address = EXCLUDED.address,
                allow_negative_stock = EXCLUDED.allow_negative_stock,
                remark = EXCLUDED.remark,
                enabled = TRUE,
                audit_status = 'AUDITED',
                updated_at = now()
        $sql$, tenant_schema);

        EXECUTE format($sql$
            DELETE FROM %1$I.md_warehouse
            WHERE code NOT IN ('CK-001', 'CK-002', 'CK-003', 'CK-004', 'CK-005', 'CK-006', 'CK-007', 'CK-008')
        $sql$, tenant_schema);
    END LOOP;
END $$;
