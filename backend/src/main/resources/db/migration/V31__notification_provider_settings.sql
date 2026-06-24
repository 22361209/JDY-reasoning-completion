INSERT INTO sys_setting (setting_key, setting_value)
VALUES
    ('notification.provider.code', 'LOCAL'),
    ('notification.provider.sender_name', '本地通知'),
    ('notification.provider.endpoint_url', ''),
    ('notification.provider.webhook_secret', ''),
    ('notification.provider.dry_run', 'true')
ON CONFLICT (setting_key) DO NOTHING;

INSERT INTO sys_permission_catalog (permission_code, module_name, permission_name, sort_no, enabled)
VALUES ('system.notification_provider.manage', '系统设置', '通知供应商维护', 145, TRUE)
ON CONFLICT (permission_code) DO UPDATE
SET module_name = EXCLUDED.module_name,
    permission_name = EXCLUDED.permission_name,
    sort_no = EXCLUDED.sort_no,
    enabled = EXCLUDED.enabled;

INSERT INTO sys_permission (role_id, permission_code, enabled)
SELECT r.id, 'system.notification_provider.manage', TRUE
FROM sys_role r
WHERE r.code = 'ADMIN'
ON CONFLICT (role_id, permission_code) DO UPDATE
SET enabled = EXCLUDED.enabled;
