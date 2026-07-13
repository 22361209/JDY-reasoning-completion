CREATE TABLE sys_session_account_scope (
    session_token UUID PRIMARY KEY,
    user_id UUID NOT NULL,
    account_set_id UUID NOT NULL,
    scope_token UUID NOT NULL,
    version BIGINT NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT fk_sys_session_account_scope_user
        FOREIGN KEY (user_id) REFERENCES sys_user(id) ON DELETE CASCADE,
    CONSTRAINT fk_sys_session_account_scope_account_set
        FOREIGN KEY (account_set_id) REFERENCES sys_account_set(id) ON DELETE CASCADE,
    CONSTRAINT uq_sys_session_account_scope_token UNIQUE (scope_token),
    CONSTRAINT ck_sys_session_account_scope_version CHECK (version >= 0)
);

CREATE INDEX idx_sys_session_account_scope_user
    ON sys_session_account_scope (user_id);

CREATE INDEX idx_sys_session_account_scope_account_set
    ON sys_session_account_scope (account_set_id);
