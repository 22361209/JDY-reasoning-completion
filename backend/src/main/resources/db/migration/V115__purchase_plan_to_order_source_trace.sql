-- A176: an audited purchase plan is the authoritative source for the order
-- that fulfils its reserved purchase-requisition quantity.
DO $$
DECLARE
    target_schema TEXT;
BEGIN
    FOR target_schema IN
        SELECT 'public'
        UNION
        SELECT DISTINCT btrim(schema_name)
        FROM public.sys_account_set
        WHERE nullif(btrim(schema_name), '') IS NOT NULL
          AND lower(btrim(schema_name)) <> 'public'
        UNION
        SELECT DISTINCT btrim(backup_schema_name)
        FROM public.sys_account_set_backup
        WHERE nullif(btrim(backup_schema_name), '') IS NOT NULL
        ORDER BY 1
    LOOP
        IF target_schema !~ '^[a-z][a-z0-9_]{0,62}$' THEN
            RAISE EXCEPTION 'V114 schema name is unsafe: schema=%', target_schema;
        END IF;
        IF to_regclass(format('%I.purchase_order_line', target_schema)) IS NULL
           OR to_regclass(format('%I.purchase_plan_line', target_schema)) IS NULL THEN
            CONTINUE;
        END IF;

        EXECUTE format('ALTER TABLE %I.purchase_plan_line ADD COLUMN IF NOT EXISTS ordered_qty NUMERIC(18, 4) NOT NULL DEFAULT 0', target_schema);
        EXECUTE format('ALTER TABLE %I.purchase_order_line ADD COLUMN IF NOT EXISTS source_purchase_plan_id UUID', target_schema);
        EXECUTE format('ALTER TABLE %I.purchase_order_line ADD COLUMN IF NOT EXISTS source_purchase_plan_line_id UUID', target_schema);
        EXECUTE format('ALTER TABLE %I.purchase_order_line ADD COLUMN IF NOT EXISTS source_purchase_plan_no VARCHAR(80)', target_schema);
        EXECUTE format('ALTER TABLE %I.purchase_order_line ADD COLUMN IF NOT EXISTS source_purchase_plan_line_no INTEGER', target_schema);
        EXECUTE format('CREATE INDEX IF NOT EXISTS idx_purchase_order_line_source_plan ON %I.purchase_order_line (source_purchase_plan_no, source_purchase_plan_line_no)', target_schema);
    END LOOP;
END $$;
