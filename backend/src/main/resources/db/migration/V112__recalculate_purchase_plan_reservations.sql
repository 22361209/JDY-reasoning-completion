-- A171: only audited purchase plans occupy purchase-requisition quantities.
-- Normalize live schemas created while A170 still reserved draft plans.
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
        ORDER BY 1
    LOOP
        IF target_schema !~ '^[a-z][a-z0-9_]{0,62}$' THEN
            RAISE EXCEPTION 'V112 tenant schema name is unsafe: schema=%', target_schema;
        END IF;
        IF to_regclass(format('%I.purchase_requisition_line', target_schema)) IS NULL
           OR to_regclass(format('%I.purchase_plan', target_schema)) IS NULL
           OR to_regclass(format('%I.purchase_plan_line', target_schema)) IS NULL THEN
            CONTINUE;
        END IF;

        EXECUTE format($sql$
            UPDATE %1$I.purchase_requisition_line source_line
            SET planned_qty = COALESCE((
                    SELECT SUM(plan_line.qty)
                    FROM %1$I.purchase_plan_line plan_line
                    JOIN %1$I.purchase_plan plan ON plan.id = plan_line.plan_id
                    WHERE plan.status = 'AUDITED'
                      AND plan_line.source_requisition_line_id = source_line.id
                ), 0),
                updated_at = now()
            WHERE source_line.planned_qty IS DISTINCT FROM COALESCE((
                    SELECT SUM(plan_line.qty)
                    FROM %1$I.purchase_plan_line plan_line
                    JOIN %1$I.purchase_plan plan ON plan.id = plan_line.plan_id
                    WHERE plan.status = 'AUDITED'
                      AND plan_line.source_requisition_line_id = source_line.id
                ), 0)
        $sql$, target_schema);
    END LOOP;
END $$;
