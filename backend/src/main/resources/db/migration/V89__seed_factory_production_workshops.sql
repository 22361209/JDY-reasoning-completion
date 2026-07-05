INSERT INTO md_production_department (code, name, manager, remark, enabled, audit_status)
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
    enabled = EXCLUDED.enabled,
    audit_status = EXCLUDED.audit_status,
    updated_at = now();
