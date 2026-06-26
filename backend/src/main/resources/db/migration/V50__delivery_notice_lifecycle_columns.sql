ALTER TABLE delivery_notice
    ADD COLUMN IF NOT EXISTS close_reason TEXT,
    ADD COLUMN IF NOT EXISTS closed_by UUID,
    ADD COLUMN IF NOT EXISTS closed_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS frozen_reason TEXT,
    ADD COLUMN IF NOT EXISTS frozen_by UUID,
    ADD COLUMN IF NOT EXISTS frozen_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS void_reason TEXT,
    ADD COLUMN IF NOT EXISTS void_verified_username VARCHAR(80),
    ADD COLUMN IF NOT EXISTS void_verified_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS voided_at TIMESTAMPTZ;

ALTER TABLE delivery_notice_line
    ADD COLUMN IF NOT EXISTS line_close_reason TEXT,
    ADD COLUMN IF NOT EXISTS line_frozen_reason TEXT;
