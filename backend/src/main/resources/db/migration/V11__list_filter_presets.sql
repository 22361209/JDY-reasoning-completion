CREATE TABLE IF NOT EXISTS sys_list_filter_preset (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    list_key VARCHAR(120) NOT NULL,
    name VARCHAR(120) NOT NULL,
    query JSONB NOT NULL DEFAULT '{}'::jsonb,
    column_filters JSONB NOT NULL DEFAULT '{}'::jsonb,
    shared BOOLEAN NOT NULL DEFAULT TRUE,
    created_by UUID REFERENCES sys_user(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT uq_sys_list_filter_preset_key_name UNIQUE (list_key, name)
);

CREATE INDEX IF NOT EXISTS idx_sys_list_filter_preset_key_updated
    ON sys_list_filter_preset (list_key, updated_at DESC);
