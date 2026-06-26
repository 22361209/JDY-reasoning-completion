INSERT INTO sys_permission (role_id, permission_code, enabled)
SELECT r.id, 'inventory.stock_alert.manage', TRUE
FROM sys_role r
WHERE r.code IN ('ADMIN', 'WAREHOUSE')
ON CONFLICT (role_id, permission_code) DO UPDATE
SET enabled = EXCLUDED.enabled;
