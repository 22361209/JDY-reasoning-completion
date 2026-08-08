-- A176 follow-up: a purchase plan fixes the commercial terms used when it is
-- subsequently converted into a purchase order. Existing plans receive the
-- current master-data values once, so later master-data changes cannot change
-- an already-created plan's down-push result.
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
            RAISE EXCEPTION 'V116 schema name is unsafe: schema=%', target_schema;
        END IF;
        IF to_regclass(format('%I.purchase_plan_line', target_schema)) IS NULL
           OR to_regclass(format('%I.md_product', target_schema)) IS NULL THEN
            CONTINUE;
        END IF;

        EXECUTE format('ALTER TABLE %I.purchase_plan_line ADD COLUMN IF NOT EXISTS unit_price_snapshot NUMERIC(18, 4)', target_schema);
        EXECUTE format('ALTER TABLE %I.purchase_plan_line ADD COLUMN IF NOT EXISTS tax_rate_snapshot NUMERIC(8, 4)', target_schema);
        EXECUTE format(
            'UPDATE %1$I.purchase_plan_line plan_line
             SET unit_price_snapshot = COALESCE(plan_line.unit_price_snapshot, product.purchase_price, 0),
                 tax_rate_snapshot = COALESCE(plan_line.tax_rate_snapshot, product.tax_rate, 13)
             FROM %1$I.md_product product
             WHERE product.id = plan_line.product_id
               AND (plan_line.unit_price_snapshot IS NULL OR plan_line.tax_rate_snapshot IS NULL)',
            target_schema
        );
        EXECUTE format('ALTER TABLE %I.purchase_plan_line ALTER COLUMN unit_price_snapshot SET DEFAULT 0', target_schema);
        EXECUTE format('ALTER TABLE %I.purchase_plan_line ALTER COLUMN unit_price_snapshot SET NOT NULL', target_schema);
        EXECUTE format('ALTER TABLE %I.purchase_plan_line ALTER COLUMN tax_rate_snapshot SET DEFAULT 13', target_schema);
        EXECUTE format('ALTER TABLE %I.purchase_plan_line ALTER COLUMN tax_rate_snapshot SET NOT NULL', target_schema);
    END LOOP;
END $$;
