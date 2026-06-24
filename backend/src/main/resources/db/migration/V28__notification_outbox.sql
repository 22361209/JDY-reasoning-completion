CREATE TABLE IF NOT EXISTS sys_notification_outbox (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    channel VARCHAR(40) NOT NULL,
    template_code VARCHAR(120) NOT NULL,
    recipient_user_id UUID REFERENCES sys_user(id),
    recipient_username VARCHAR(80) NOT NULL,
    recipient_contact VARCHAR(240),
    title VARCHAR(160) NOT NULL,
    body TEXT NOT NULL,
    source_type VARCHAR(120),
    source_id UUID,
    status VARCHAR(40) NOT NULL DEFAULT 'SENT',
    provider VARCHAR(80) NOT NULL DEFAULT 'LOCAL',
    provider_message_id VARCHAR(160),
    failure_reason TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    sent_at TIMESTAMPTZ,
    CONSTRAINT ck_sys_notification_outbox_channel CHECK (channel IN ('IN_APP', 'EMAIL', 'SMS')),
    CONSTRAINT ck_sys_notification_outbox_status CHECK (status IN ('PENDING', 'SENT', 'FAILED'))
);

CREATE INDEX IF NOT EXISTS idx_sys_notification_outbox_recipient_time
    ON sys_notification_outbox (recipient_username, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_sys_notification_outbox_source
    ON sys_notification_outbox (source_type, source_id);

CREATE INDEX IF NOT EXISTS idx_sys_notification_outbox_status_time
    ON sys_notification_outbox (status, created_at DESC);
