CREATE TABLE IF NOT EXISTS sys_permission_catalog (
    permission_code VARCHAR(160) PRIMARY KEY,
    module_name VARCHAR(80) NOT NULL,
    permission_name VARCHAR(160) NOT NULL,
    sort_no INTEGER NOT NULL DEFAULT 0,
    enabled BOOLEAN NOT NULL DEFAULT TRUE
);

INSERT INTO sys_permission_catalog (permission_code, module_name, permission_name, sort_no, enabled)
VALUES
    ('sales.order.audit', '销售管理', '销售订单审核', 10, TRUE),
    ('sales.out.audit', '销售管理', '销售出库审核', 20, TRUE),
    ('purchase.order.audit', '采购管理', '采购订单审核', 30, TRUE),
    ('purchase.in.audit', '采购管理', '采购入库审核', 40, TRUE),
    ('inventory.stock.view', '库存管理', '库存查询', 50, TRUE),
    ('finance.settle', '应收应付', '收付款核销', 60, TRUE),
    ('finance.report.view', '应收应付', '往来报表查看', 70, TRUE),
    ('production.task.audit', '生产管理', '生产任务审核', 80, TRUE),
    ('production.document.audit', '生产管理', '生产领料/入库审核', 90, TRUE),
    ('master.data.manage', '基础资料', '基础资料维护', 100, TRUE),
    ('system.audit_log.view', '系统设置', '操作日志查看', 110, TRUE),
    ('system.print_template.manage', '系统设置', '打印模板维护', 120, TRUE),
    ('system.role_permission.manage', '系统设置', '角色权限维护', 130, TRUE)
ON CONFLICT (permission_code) DO UPDATE
SET module_name = EXCLUDED.module_name,
    permission_name = EXCLUDED.permission_name,
    sort_no = EXCLUDED.sort_no,
    enabled = EXCLUDED.enabled;

INSERT INTO sys_permission (role_id, permission_code, enabled)
SELECT r.id, c.permission_code, TRUE
FROM sys_role r
CROSS JOIN sys_permission_catalog c
WHERE r.code = 'ADMIN'
  AND c.enabled = TRUE
ON CONFLICT (role_id, permission_code) DO UPDATE
SET enabled = EXCLUDED.enabled;

INSERT INTO sys_permission (role_id, permission_code, enabled)
SELECT r.id, p.permission_code, TRUE
FROM sys_role r
CROSS JOIN (
    VALUES
        ('inventory.stock.view'),
        ('sales.out.audit'),
        ('purchase.in.audit'),
        ('production.document.audit')
) AS p(permission_code)
WHERE r.code = 'WAREHOUSE'
ON CONFLICT (role_id, permission_code) DO UPDATE
SET enabled = EXCLUDED.enabled;

INSERT INTO sys_permission (role_id, permission_code, enabled)
SELECT r.id, p.permission_code, TRUE
FROM sys_role r
CROSS JOIN (
    VALUES
        ('finance.settle'),
        ('finance.report.view'),
        ('system.audit_log.view')
) AS p(permission_code)
WHERE r.code = 'FINANCE'
ON CONFLICT (role_id, permission_code) DO UPDATE
SET enabled = EXCLUDED.enabled;

CREATE INDEX IF NOT EXISTS idx_sys_permission_catalog_module_sort
    ON sys_permission_catalog (module_name, sort_no);
