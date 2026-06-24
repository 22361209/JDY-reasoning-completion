CREATE TABLE IF NOT EXISTS sys_setting (
    setting_key VARCHAR(160) PRIMARY KEY,
    setting_value TEXT NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_by UUID REFERENCES sys_user(id),
    version BIGINT NOT NULL DEFAULT 0
);

ALTER TABLE sys_user
    ADD COLUMN IF NOT EXISTS session_generation INTEGER NOT NULL DEFAULT 0;

INSERT INTO sys_setting (setting_key, setting_value)
VALUES ('security.repeated_login_policy', 'SINGLE_ACTIVE')
ON CONFLICT (setting_key) DO NOTHING;

INSERT INTO sys_permission_catalog (permission_code, module_name, permission_name, sort_no, enabled)
VALUES ('system.security.manage', '系统设置', '安全设置维护', 140, TRUE)
ON CONFLICT (permission_code) DO UPDATE
SET module_name = EXCLUDED.module_name,
    permission_name = EXCLUDED.permission_name,
    sort_no = EXCLUDED.sort_no,
    enabled = EXCLUDED.enabled;

INSERT INTO sys_permission (role_id, permission_code, enabled)
SELECT r.id, 'system.security.manage', TRUE
FROM sys_role r
WHERE r.code = 'ADMIN'
ON CONFLICT (role_id, permission_code) DO UPDATE
SET enabled = EXCLUDED.enabled;
