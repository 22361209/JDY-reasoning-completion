ALTER TABLE sys_notification_outbox
    ADD COLUMN IF NOT EXISTS retry_count INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS last_attempt_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_sys_notification_outbox_retry_time
    ON sys_notification_outbox (status, last_attempt_at DESC);
