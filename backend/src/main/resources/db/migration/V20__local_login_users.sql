INSERT INTO sys_user (username, display_name, password_hash, enabled)
VALUES
    ('admin', '本地管理员', '{noop}admin123', TRUE),
    ('warehouse', '仓库操作员', '{noop}warehouse123', TRUE),
    ('finance', '财务操作员', '{noop}finance123', TRUE)
ON CONFLICT (username) DO UPDATE
SET display_name = EXCLUDED.display_name,
    password_hash = EXCLUDED.password_hash,
    enabled = EXCLUDED.enabled,
    updated_at = now();

INSERT INTO sys_user_role (user_id, role_id)
SELECT u.id, r.id
FROM sys_user u
JOIN sys_role r ON r.code = CASE u.username
    WHEN 'admin' THEN 'ADMIN'
    WHEN 'warehouse' THEN 'WAREHOUSE'
    WHEN 'finance' THEN 'FINANCE'
END
WHERE u.username IN ('admin', 'warehouse', 'finance')
ON CONFLICT DO NOTHING;
