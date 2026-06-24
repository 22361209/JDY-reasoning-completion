ALTER TABLE sys_list_filter_preset
    ADD COLUMN IF NOT EXISTS is_default BOOLEAN NOT NULL DEFAULT FALSE,
    ADD COLUMN IF NOT EXISTS read_only BOOLEAN NOT NULL DEFAULT FALSE;

CREATE UNIQUE INDEX IF NOT EXISTS uq_sys_list_filter_preset_default
    ON sys_list_filter_preset (list_key)
    WHERE is_default;

INSERT INTO sys_list_filter_preset (
    list_key,
    name,
    query,
    column_filters,
    shared,
    is_default,
    read_only,
    updated_at
)
VALUES (
    'operation-log-list',
    '系统默认-红冲审计',
    '{"keyword":"","status":"SUCCESS","module":"SALES","action":"RED_REVERSE","operator":"","targetType":"sales_out","dateFrom":"","dateTo":""}'::jsonb,
    '{}'::jsonb,
    TRUE,
    TRUE,
    TRUE,
    now()
)
ON CONFLICT (list_key, name) DO UPDATE
SET query = EXCLUDED.query,
    column_filters = EXCLUDED.column_filters,
    shared = EXCLUDED.shared,
    is_default = EXCLUDED.is_default,
    read_only = EXCLUDED.read_only,
    updated_at = now();
