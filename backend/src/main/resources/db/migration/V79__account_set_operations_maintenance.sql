ALTER TABLE sys_account_set
    ADD COLUMN IF NOT EXISTS disabled_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS disabled_reason TEXT NOT NULL DEFAULT '';

ALTER TABLE sys_operation_log
    ADD COLUMN IF NOT EXISTS account_set_id UUID,
    ADD COLUMN IF NOT EXISTS account_set_code VARCHAR(80) NOT NULL DEFAULT '',
    ADD COLUMN IF NOT EXISTS account_set_name VARCHAR(200) NOT NULL DEFAULT '';

CREATE INDEX IF NOT EXISTS idx_sys_operation_log_account_time
    ON sys_operation_log (account_set_code, operated_at DESC);

DO $$
DECLARE
    tenant_schema TEXT;
BEGIN
    FOR tenant_schema IN
        SELECT nspname
        FROM pg_namespace
        WHERE nspname LIKE 'tenant\_%' ESCAPE '\'
    LOOP
        IF to_regclass(format('%I.sys_operation_log', tenant_schema)) IS NOT NULL THEN
            EXECUTE format('ALTER TABLE %I.sys_operation_log ADD COLUMN IF NOT EXISTS account_set_id UUID', tenant_schema);
            EXECUTE format('ALTER TABLE %I.sys_operation_log ADD COLUMN IF NOT EXISTS account_set_code VARCHAR(80) NOT NULL DEFAULT ''''', tenant_schema);
            EXECUTE format('ALTER TABLE %I.sys_operation_log ADD COLUMN IF NOT EXISTS account_set_name VARCHAR(200) NOT NULL DEFAULT ''''', tenant_schema);
            EXECUTE format('CREATE INDEX IF NOT EXISTS idx_sys_operation_log_account_time ON %I.sys_operation_log (account_set_code, operated_at DESC)', tenant_schema);
        END IF;
    END LOOP;
END $$;

CREATE TABLE IF NOT EXISTS sys_account_set_backup (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    account_set_id UUID NOT NULL REFERENCES sys_account_set(id) ON DELETE CASCADE,
    account_set_code VARCHAR(80) NOT NULL,
    account_set_name VARCHAR(200) NOT NULL,
    backup_name VARCHAR(160) NOT NULL,
    backup_schema_name VARCHAR(80) NOT NULL,
    attachment_prefix TEXT NOT NULL DEFAULT '',
    table_count INTEGER NOT NULL DEFAULT 0,
    row_count BIGINT NOT NULL DEFAULT 0,
    restored_at TIMESTAMPTZ,
    restored_by UUID REFERENCES sys_user(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_by UUID REFERENCES sys_user(id),
    UNIQUE (account_set_id, backup_name),
    UNIQUE (backup_schema_name)
);

CREATE INDEX IF NOT EXISTS idx_sys_account_set_backup_account_created
    ON sys_account_set_backup (account_set_id, created_at DESC);
