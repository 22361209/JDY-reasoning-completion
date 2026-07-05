ALTER TABLE production_task
    ADD COLUMN IF NOT EXISTS close_status VARCHAR(40) NOT NULL DEFAULT 'OPEN',
    ADD COLUMN IF NOT EXISTS close_reason TEXT,
    ADD COLUMN IF NOT EXISTS closed_by UUID,
    ADD COLUMN IF NOT EXISTS closed_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS frozen_status VARCHAR(40) NOT NULL DEFAULT 'NORMAL',
    ADD COLUMN IF NOT EXISTS frozen_reason TEXT,
    ADD COLUMN IF NOT EXISTS frozen_by UUID,
    ADD COLUMN IF NOT EXISTS frozen_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS voided_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS void_reason TEXT,
    ADD COLUMN IF NOT EXISTS void_verified_username VARCHAR(80),
    ADD COLUMN IF NOT EXISTS void_verified_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS version BIGINT NOT NULL DEFAULT 0;

ALTER TABLE production_task_material_snapshot
    ADD COLUMN IF NOT EXISTS line_close_status VARCHAR(40) NOT NULL DEFAULT 'OPEN',
    ADD COLUMN IF NOT EXISTS line_close_reason TEXT,
    ADD COLUMN IF NOT EXISTS line_frozen_status VARCHAR(40) NOT NULL DEFAULT 'NORMAL',
    ADD COLUMN IF NOT EXISTS line_frozen_reason TEXT;

CREATE INDEX IF NOT EXISTS idx_production_task_lifecycle
    ON production_task (status, close_status, frozen_status);

CREATE INDEX IF NOT EXISTS idx_production_task_material_snapshot_lifecycle
    ON production_task_material_snapshot (task_id, line_close_status, line_frozen_status);
