UPDATE production_task
SET status = 'AUDITED',
    updated_at = now()
WHERE status IN ('ISSUED', 'COMPLETED');
