ALTER TABLE sys_print_template
    ADD COLUMN IF NOT EXISTS role_code VARCHAR(80);

DROP INDEX IF EXISTS uq_sys_print_template_default;

CREATE UNIQUE INDEX IF NOT EXISTS uq_sys_print_template_default_role
    ON sys_print_template (document_type, COALESCE(role_code, '*'))
    WHERE is_default AND enabled;

CREATE INDEX IF NOT EXISTS idx_sys_print_template_role_scope
    ON sys_print_template (document_type, role_code, is_default DESC, updated_at DESC);
