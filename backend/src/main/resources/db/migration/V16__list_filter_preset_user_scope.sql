ALTER TABLE sys_list_filter_preset
    ADD COLUMN IF NOT EXISTS user_name VARCHAR(120);

DROP INDEX IF EXISTS uq_sys_list_filter_preset_default_role;
DROP INDEX IF EXISTS uq_sys_list_filter_preset_scope_name;

ALTER TABLE sys_list_filter_preset
    DROP CONSTRAINT IF EXISTS uq_sys_list_filter_preset_key_name;

CREATE UNIQUE INDEX IF NOT EXISTS uq_sys_list_filter_preset_scope_name
    ON sys_list_filter_preset (list_key, name, COALESCE(role_code, '*'), COALESCE(user_name, '*'));

CREATE UNIQUE INDEX IF NOT EXISTS uq_sys_list_filter_preset_default_scope
    ON sys_list_filter_preset (list_key, COALESCE(role_code, '*'), COALESCE(user_name, '*'))
    WHERE is_default;

CREATE INDEX IF NOT EXISTS idx_sys_list_filter_preset_scope
    ON sys_list_filter_preset (list_key, role_code, user_name, updated_at DESC);
