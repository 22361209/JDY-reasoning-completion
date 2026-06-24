UPDATE sys_list_filter_preset
SET query = '{"keyword":"","status":"成功","module":"SALES","action":"RED_REVERSE","operator":"","targetType":"sales_out","dateFrom":"","dateTo":""}'::jsonb,
    updated_at = now()
WHERE list_key = 'operation-log-list'
  AND name = '系统默认-红冲审计';
