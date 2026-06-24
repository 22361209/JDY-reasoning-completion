INSERT INTO sys_user (username, display_name, enabled)
VALUES ('admin', '本地管理员', TRUE)
ON CONFLICT (username) DO UPDATE
SET display_name = EXCLUDED.display_name,
    enabled = EXCLUDED.enabled,
    updated_at = now();

INSERT INTO sys_user_role (user_id, role_id)
SELECT u.id, r.id
FROM sys_user u, sys_role r
WHERE u.username = 'admin' AND r.code = 'ADMIN'
ON CONFLICT DO NOTHING;

INSERT INTO sys_permission (role_id, permission_code, enabled)
SELECT r.id, permission_code, TRUE
FROM sys_role r
CROSS JOIN (
    VALUES
        ('sales.order.audit'),
        ('sales.out.audit'),
        ('purchase.order.audit'),
        ('purchase.in.audit'),
        ('finance.settle'),
        ('production.task.audit'),
        ('system.audit_log.view')
) AS p(permission_code)
WHERE r.code = 'ADMIN'
ON CONFLICT (role_id, permission_code) DO UPDATE
SET enabled = EXCLUDED.enabled;

CREATE INDEX IF NOT EXISTS idx_ar_receivable_status_date
    ON ar_receivable (status, bill_date DESC);

CREATE INDEX IF NOT EXISTS idx_ap_payable_status_date
    ON ap_payable (status, bill_date DESC);

CREATE INDEX IF NOT EXISTS idx_production_task_status_created
    ON production_task (status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_sys_operation_log_operated_at
    ON sys_operation_log (operated_at DESC);
