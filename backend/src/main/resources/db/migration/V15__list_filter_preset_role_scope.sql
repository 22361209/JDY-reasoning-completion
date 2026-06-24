ALTER TABLE sys_list_filter_preset
    ADD COLUMN IF NOT EXISTS role_code VARCHAR(80);

DROP INDEX IF EXISTS uq_sys_list_filter_preset_default;

CREATE UNIQUE INDEX IF NOT EXISTS uq_sys_list_filter_preset_default_role
    ON sys_list_filter_preset (list_key, COALESCE(role_code, '*'))
    WHERE is_default;

UPDATE sys_list_filter_preset
SET role_code = 'ADMIN',
    updated_at = now()
WHERE list_key = 'operation-log-list'
  AND name = '系统默认-红冲审计'
  AND role_code IS NULL;
