DO $$
DECLARE
    tenant_schema TEXT;
    fallback_warehouse_id UUID;
    ref RECORD;
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
                ('CK-001', '冲压材料仓', '原料仓', '本地管理员', NULL, NULL, FALSE, '默认仓库', TRUE, 'AUDITED'),
                ('CK-002', '冲压片件仓', '半成品仓', '本地管理员', NULL, NULL, FALSE, '默认仓库', TRUE, 'AUDITED'),
                ('CK-003', '焊接片件仓', '半成品仓', '本地管理员', NULL, NULL, FALSE, '默认仓库', TRUE, 'AUDITED'),
                ('CK-004', '焊接配件仓', '半成品仓', '本地管理员', NULL, NULL, FALSE, '默认仓库', TRUE, 'AUDITED'),
                ('CK-005', '安装成品仓', '成品仓', '本地管理员', NULL, NULL, FALSE, '默认仓库', TRUE, 'AUDITED'),
                ('CK-006', '安装配件仓', '半成品仓', '本地管理员', NULL, NULL, FALSE, '默认仓库', TRUE, 'AUDITED'),
                ('CK-007', '包装辅料仓', '普通仓', '本地管理员', NULL, NULL, FALSE, '默认仓库', TRUE, 'AUDITED')
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
            SELECT id
            FROM %1$I.md_warehouse
            WHERE code = 'CK-001'
        $sql$, tenant_schema)
        INTO fallback_warehouse_id;

        EXECUTE format($sql$
            UPDATE %1$I.md_product product
            SET default_warehouse_id = warehouse.id,
                default_warehouse_code = warehouse.code,
                updated_at = now(),
                version = product.version + 1
            FROM %1$I.md_warehouse warehouse
            WHERE product.default_warehouse_id = warehouse.id
              AND warehouse.code IN ('CK-001', 'CK-002', 'CK-003', 'CK-004', 'CK-005', 'CK-006', 'CK-007')
              AND product.default_warehouse_code IS DISTINCT FROM warehouse.code
        $sql$, tenant_schema);

        EXECUTE format($sql$
            UPDATE %1$I.md_product product
            SET default_warehouse_id = NULL,
                default_warehouse_code = '',
                updated_at = now(),
                version = product.version + 1
            WHERE product.default_warehouse_id IS NOT NULL
              AND NOT EXISTS (
                  SELECT 1
                  FROM %1$I.md_warehouse warehouse
                  WHERE warehouse.id = product.default_warehouse_id
                    AND warehouse.code IN ('CK-001', 'CK-002', 'CK-003', 'CK-004', 'CK-005', 'CK-006', 'CK-007')
              )
        $sql$, tenant_schema);

        EXECUTE format($sql$
            DELETE FROM %1$I.inv_stock_balance balance
            WHERE NOT EXISTS (
                SELECT 1
                FROM %1$I.md_warehouse warehouse
                WHERE warehouse.id = balance.warehouse_id
                  AND warehouse.code IN ('CK-001', 'CK-002', 'CK-003', 'CK-004', 'CK-005', 'CK-006', 'CK-007')
            )
        $sql$, tenant_schema);

        IF to_regclass(format('%I.inv_stock_opening', tenant_schema)) IS NOT NULL THEN
            EXECUTE format($sql$
                DELETE FROM %1$I.inv_stock_opening opening
                WHERE NOT EXISTS (
                    SELECT 1
                    FROM %1$I.md_warehouse warehouse
                    WHERE warehouse.id = opening.warehouse_id
                      AND warehouse.code IN ('CK-001', 'CK-002', 'CK-003', 'CK-004', 'CK-005', 'CK-006', 'CK-007')
                )
            $sql$, tenant_schema);
        END IF;

        IF to_regclass(format('%I.inv_safety_stock_setting', tenant_schema)) IS NOT NULL THEN
            EXECUTE format($sql$
                DELETE FROM %1$I.inv_safety_stock_setting setting
                WHERE NOT EXISTS (
                    SELECT 1
                    FROM %1$I.md_warehouse warehouse
                    WHERE warehouse.id = setting.warehouse_id
                      AND warehouse.code IN ('CK-001', 'CK-002', 'CK-003', 'CK-004', 'CK-005', 'CK-006', 'CK-007')
                )
            $sql$, tenant_schema);
        END IF;

        FOR ref IN
            SELECT
                quote_ident(child_ns.nspname) || '.' || quote_ident(child.relname) AS child_table,
                quote_ident(child_col.attname) AS child_column
            FROM pg_constraint constraint_row
            JOIN pg_class parent ON parent.oid = constraint_row.confrelid
            JOIN pg_namespace parent_ns ON parent_ns.oid = parent.relnamespace
            JOIN pg_class child ON child.oid = constraint_row.conrelid
            JOIN pg_namespace child_ns ON child_ns.oid = child.relnamespace
            JOIN unnest(constraint_row.conkey) WITH ORDINALITY AS child_key(attnum, ord) ON TRUE
            JOIN pg_attribute child_col ON child_col.attrelid = child.oid AND child_col.attnum = child_key.attnum
            WHERE constraint_row.contype = 'f'
              AND parent.relname = 'md_warehouse'
              AND parent_ns.nspname = tenant_schema
              AND child_ns.nspname = tenant_schema
        LOOP
            EXECUTE format($sql$
                UPDATE %s child
                SET %s = $1
                WHERE %s IN (
                    SELECT id
                    FROM %I.md_warehouse
                    WHERE code NOT IN ('CK-001', 'CK-002', 'CK-003', 'CK-004', 'CK-005', 'CK-006', 'CK-007')
                )
            $sql$, ref.child_table, ref.child_column, ref.child_column, tenant_schema)
            USING fallback_warehouse_id;
        END LOOP;

        EXECUTE format($sql$
            DELETE FROM %1$I.md_warehouse
            WHERE code NOT IN ('CK-001', 'CK-002', 'CK-003', 'CK-004', 'CK-005', 'CK-006', 'CK-007')
        $sql$, tenant_schema);
    END LOOP;
END $$;
