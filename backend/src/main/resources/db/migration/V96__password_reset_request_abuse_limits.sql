ALTER TABLE sys_password_reset_request
    DROP CONSTRAINT ck_sys_password_reset_request_status;

ALTER TABLE sys_password_reset_request
    ADD CONSTRAINT ck_sys_password_reset_request_status
        CHECK (status IN ('PENDING', 'DONE', 'REJECTED', 'EXPIRED'));

UPDATE sys_password_reset_request
SET status = 'EXPIRED',
    handled_at = COALESCE(handled_at, now()),
    handle_note = CASE
        WHEN COALESCE(handle_note, '') = '' THEN '系统关闭未匹配账号的历史申请'
        ELSE handle_note
    END,
    version = version + 1
WHERE status = 'PENDING'
  AND requested_user_id IS NULL;

WITH ranked_pending AS (
    SELECT id,
           row_number() OVER (
               PARTITION BY requested_user_id
               ORDER BY requested_at ASC, id ASC
           ) AS row_no
    FROM sys_password_reset_request
    WHERE status = 'PENDING'
      AND requested_user_id IS NOT NULL
)
UPDATE sys_password_reset_request request_row
SET status = 'EXPIRED',
    handled_at = COALESCE(request_row.handled_at, now()),
    handle_note = CASE
        WHEN COALESCE(request_row.handle_note, '') = '' THEN '系统合并重复待处理申请'
        ELSE request_row.handle_note
    END,
    version = request_row.version + 1
FROM ranked_pending ranked
WHERE request_row.id = ranked.id
  AND ranked.row_no > 1;

ALTER TABLE sys_password_reset_request
    ADD CONSTRAINT ck_sys_password_reset_request_pending_user
        CHECK (status <> 'PENDING' OR requested_user_id IS NOT NULL);

CREATE UNIQUE INDEX uq_sys_password_reset_request_pending_user
    ON sys_password_reset_request (requested_user_id)
    WHERE status = 'PENDING';

CREATE INDEX idx_sys_password_reset_request_terminal_retention
    ON sys_password_reset_request ((COALESCE(handled_at, requested_at)))
    WHERE status IN ('DONE', 'REJECTED', 'EXPIRED');
