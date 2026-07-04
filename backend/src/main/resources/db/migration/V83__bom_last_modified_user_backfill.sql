UPDATE prod_bom bom
SET updated_by = latest.operated_by
FROM (
    SELECT DISTINCT ON (target_id)
           target_id,
           operated_by
    FROM sys_operation_log
    WHERE target_type = 'prod_bom'
      AND operated_by IS NOT NULL
    ORDER BY target_id, operated_at DESC
) latest
WHERE bom.updated_by IS NULL
  AND bom.id = latest.target_id;
