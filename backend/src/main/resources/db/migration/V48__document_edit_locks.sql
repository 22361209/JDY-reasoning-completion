CREATE TABLE IF NOT EXISTS doc_edit_lock (
    document_type VARCHAR(80) NOT NULL,
    bill_no VARCHAR(80) NOT NULL,
    holder_user_id UUID NOT NULL REFERENCES sys_user(id),
    holder_username VARCHAR(80) NOT NULL,
    holder_display_name VARCHAR(120) NOT NULL,
    acquired_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at TIMESTAMPTZ NOT NULL,
    PRIMARY KEY (document_type, bill_no)
);

CREATE INDEX IF NOT EXISTS idx_doc_edit_lock_expires_at
    ON doc_edit_lock (expires_at);

INSERT INTO sys_permission_catalog (permission_code, module_name, permission_name, sort_no, enabled)
VALUES ('document.lock.override', '系统设置', '单据编辑锁强制解锁', 135, TRUE)
ON CONFLICT (permission_code) DO UPDATE
SET module_name = EXCLUDED.module_name,
    permission_name = EXCLUDED.permission_name,
    sort_no = EXCLUDED.sort_no,
    enabled = EXCLUDED.enabled;

INSERT INTO sys_permission (role_id, permission_code, enabled)
SELECT r.id, 'document.lock.override', TRUE
FROM sys_role r
WHERE r.code = 'ADMIN'
ON CONFLICT (role_id, permission_code) DO UPDATE
SET enabled = EXCLUDED.enabled;
