CREATE TABLE IF NOT EXISTS sys_password_reset_request (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    username VARCHAR(80) NOT NULL,
    contact_note VARCHAR(240),
    status VARCHAR(30) NOT NULL DEFAULT 'PENDING',
    requested_user_id UUID REFERENCES sys_user(id),
    requested_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    handled_at TIMESTAMPTZ,
    handled_by UUID REFERENCES sys_user(id),
    handle_note VARCHAR(240),
    version BIGINT NOT NULL DEFAULT 0,
    CONSTRAINT ck_sys_password_reset_request_status CHECK (status IN ('PENDING', 'DONE', 'REJECTED'))
);

CREATE INDEX IF NOT EXISTS idx_sys_password_reset_request_status_time
    ON sys_password_reset_request (status, requested_at DESC);

CREATE INDEX IF NOT EXISTS idx_sys_password_reset_request_username
    ON sys_password_reset_request (username, requested_at DESC);
