ALTER TABLE sys_notification_outbox
    ADD COLUMN IF NOT EXISTS provider_receipt_status VARCHAR(40),
    ADD COLUMN IF NOT EXISTS provider_receipt_at TIMESTAMPTZ;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'ck_sys_notification_outbox_receipt_status'
    ) THEN
        ALTER TABLE sys_notification_outbox
            ADD CONSTRAINT ck_sys_notification_outbox_receipt_status
                CHECK (provider_receipt_status IS NULL OR provider_receipt_status IN ('DELIVERED', 'FAILED', 'BOUNCED', 'UNKNOWN'));
    END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_sys_notification_outbox_receipt_status_time
    ON sys_notification_outbox (provider_receipt_status, provider_receipt_at DESC);
