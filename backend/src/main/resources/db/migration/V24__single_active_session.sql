ALTER TABLE sys_user
    ADD COLUMN IF NOT EXISTS active_session_token TEXT,
    ADD COLUMN IF NOT EXISTS active_session_started_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS last_session_replaced_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_sys_user_active_session_token
    ON sys_user (active_session_token);
