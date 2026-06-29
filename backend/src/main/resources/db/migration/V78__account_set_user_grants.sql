CREATE TABLE IF NOT EXISTS sys_user_account_set (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES sys_user(id) ON DELETE CASCADE,
    account_set_id UUID NOT NULL REFERENCES sys_account_set(id) ON DELETE CASCADE,
    role_code VARCHAR(80) NOT NULL DEFAULT 'MEMBER',
    is_default BOOLEAN NOT NULL DEFAULT FALSE,
    enabled BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    version BIGINT NOT NULL DEFAULT 0,
    CONSTRAINT uq_sys_user_account_set UNIQUE (user_id, account_set_id)
);

CREATE INDEX IF NOT EXISTS idx_sys_user_account_set_user_enabled
    ON sys_user_account_set (user_id, enabled);

CREATE INDEX IF NOT EXISTS idx_sys_user_account_set_account_enabled
    ON sys_user_account_set (account_set_id, enabled);

INSERT INTO sys_user_account_set (user_id, account_set_id, role_code, is_default, enabled)
SELECT u.id,
       u.default_account_set_id,
       CASE WHEN bool_or(r.code = 'ADMIN') THEN 'ADMIN' ELSE 'MEMBER' END,
       TRUE,
       TRUE
FROM sys_user u
LEFT JOIN sys_user_role ur ON ur.user_id = u.id
LEFT JOIN sys_role r ON r.id = ur.role_id AND r.enabled = TRUE
WHERE u.default_account_set_id IS NOT NULL
  AND u.enabled = TRUE
GROUP BY u.id, u.default_account_set_id
ON CONFLICT (user_id, account_set_id) DO UPDATE
SET role_code = EXCLUDED.role_code,
    is_default = TRUE,
    enabled = TRUE,
    updated_at = now(),
    version = sys_user_account_set.version + 1;

CREATE UNIQUE INDEX IF NOT EXISTS uq_sys_user_account_set_default
    ON sys_user_account_set (user_id)
    WHERE is_default = TRUE AND enabled = TRUE;

INSERT INTO sys_user_account_set (user_id, account_set_id, role_code, is_default, enabled)
SELECT u.id,
       a.id,
       'ADMIN',
       a.id = u.default_account_set_id,
       TRUE
FROM sys_user u
JOIN sys_user_role ur ON ur.user_id = u.id
JOIN sys_role r ON r.id = ur.role_id AND r.code = 'ADMIN' AND r.enabled = TRUE
CROSS JOIN sys_account_set a
WHERE u.enabled = TRUE
  AND a.enabled = TRUE
ON CONFLICT (user_id, account_set_id) DO UPDATE
SET role_code = 'ADMIN',
    is_default = EXCLUDED.is_default OR sys_user_account_set.is_default,
    enabled = TRUE,
    updated_at = now(),
    version = sys_user_account_set.version + 1;
