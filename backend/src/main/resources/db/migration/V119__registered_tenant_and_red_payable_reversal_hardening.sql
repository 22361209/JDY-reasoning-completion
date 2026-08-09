-- A181 forward compensation for the already-applied V118 migration.  Keep this
-- migration compensation-only so Flyway commits the repair before any later
-- fail-closed validation or topology work runs in V120.

-- Flyway records installed_on in the project JVM timezone (Asia/Shanghai),
-- while ap_payable.updated_at is TIMESTAMPTZ.  Isolated V118 evidence confirms
-- that rows changed by V118 fall inside [installed_on, installed_on +
-- execution_time] after applying that named timezone.  Compensate only
-- ambiguous red reversals in that exact window; pre-existing REVERSED history
-- outside the window remains untouched.  paid_amount=0 implies the only valid
-- pre-V118 active settlement state was OPEN.  Keep updated_at as V118 evidence.
DO $$
DECLARE
    target_schema TEXT;
    required_table TEXT;
    history_count INTEGER;
    v118_window_start TIMESTAMPTZ;
    v118_window_end TIMESTAMPTZ;
BEGIN
    SELECT count(*)::INTEGER
    INTO history_count
    FROM public.flyway_schema_history
    WHERE version = '118'
      AND success IS TRUE;
    IF history_count <> 1 THEN
        RAISE EXCEPTION 'V119 requires exactly one successful V118 history row: count=%', history_count;
    END IF;

    SELECT installed_on AT TIME ZONE 'Asia/Shanghai',
           (installed_on + execution_time * interval '1 millisecond') AT TIME ZONE 'Asia/Shanghai'
    INTO v118_window_start, v118_window_end
    FROM public.flyway_schema_history
    WHERE version = '118'
      AND success IS TRUE
      AND execution_time > 0;
    IF v118_window_start IS NULL
       OR v118_window_end IS NULL
       OR v118_window_end <= v118_window_start THEN
        RAISE EXCEPTION 'V119 cannot establish a reliable positive V118 execution window';
    END IF;

    -- Preflight V118's complete target set before any compensation is written.
    FOR target_schema IN
        SELECT 'public'
        UNION
        SELECT DISTINCT btrim(schema_name)
        FROM public.sys_account_set
        WHERE enabled IS TRUE
          AND initialized IS TRUE
          AND nullif(btrim(schema_name), '') IS NOT NULL
          AND lower(btrim(schema_name)) <> 'public'
        UNION
        SELECT DISTINCT btrim(backup_schema_name)
        FROM public.sys_account_set_backup
        WHERE nullif(btrim(backup_schema_name), '') IS NOT NULL
        ORDER BY 1
    LOOP
        IF target_schema !~ '^[a-z][a-z0-9_]{0,62}$' THEN
            RAISE EXCEPTION 'V119 V118-target schema name is unsafe: schema=%', target_schema;
        END IF;

        FOREACH required_table IN ARRAY ARRAY['ap_payable', 'purchase_in', 'purchase_return']
        LOOP
            IF to_regclass(format('%I.%I', target_schema, required_table)) IS NULL THEN
                RAISE EXCEPTION 'V119 V118-target table is missing: schema=% table=%',
                    target_schema, required_table;
            END IF;
        END LOOP;
    END LOOP;
END $$;

-- Match V118's target set exactly: public, tenants that are currently both
-- enabled and initialized, and every registered historical backup.  This is
-- the final phase of V119 and contains no fail-closed work after the updates.
DO $$
DECLARE
    target_schema TEXT;
    v118_window_start TIMESTAMPTZ;
    v118_window_end TIMESTAMPTZ;
BEGIN
    SELECT installed_on AT TIME ZONE 'Asia/Shanghai',
           (installed_on + execution_time * interval '1 millisecond') AT TIME ZONE 'Asia/Shanghai'
    INTO v118_window_start, v118_window_end
    FROM public.flyway_schema_history
    WHERE version = '118'
      AND success IS TRUE
      AND execution_time > 0;

    FOR target_schema IN
        SELECT 'public'
        UNION
        SELECT DISTINCT btrim(schema_name)
        FROM public.sys_account_set
        WHERE enabled IS TRUE
          AND initialized IS TRUE
          AND nullif(btrim(schema_name), '') IS NOT NULL
          AND lower(btrim(schema_name)) <> 'public'
        UNION
        SELECT DISTINCT btrim(backup_schema_name)
        FROM public.sys_account_set_backup
        WHERE nullif(btrim(backup_schema_name), '') IS NOT NULL
        ORDER BY 1
    LOOP
        EXECUTE format($sql$
            WITH red_source AS (
                SELECT source.bill_no
                FROM %1$I.purchase_in source
                WHERE source.status = 'AUDITED'
                  AND source.red_source_bill_id IS NOT NULL
            ), ambiguous_source AS (
                SELECT source.bill_no
                FROM red_source source
                WHERE EXISTS (
                    SELECT 1
                    FROM %1$I.ap_payable reversal
                    WHERE reversal.source_bill_no = source.bill_no
                      AND starts_with(reversal.bill_no, 'YF-HC-CX-')
                )
                  AND (
                      (
                          SELECT count(*)
                          FROM %1$I.ap_payable main
                          WHERE main.source_bill_no = source.bill_no
                            AND starts_with(main.bill_no, 'YF-HC-')
                            AND NOT starts_with(main.bill_no, 'YF-HC-CX-')
                      ) <> 1
                      OR (
                          SELECT count(*)
                          FROM %1$I.ap_payable reversal
                          WHERE reversal.source_bill_no = source.bill_no
                            AND starts_with(reversal.bill_no, 'YF-HC-CX-')
                      ) <> 1
                      OR NOT EXISTS (
                          SELECT 1
                          FROM %1$I.ap_payable main
                          JOIN %1$I.ap_payable reversal
                            ON reversal.source_bill_no = main.source_bill_no
                           AND reversal.bill_no = 'YF-HC-CX-' || substr(main.bill_no, 7)
                          WHERE main.source_bill_no = source.bill_no
                            AND starts_with(main.bill_no, 'YF-HC-')
                            AND NOT starts_with(main.bill_no, 'YF-HC-CX-')
                      )
                  )
            )
            UPDATE %1$I.ap_payable reversal
            SET status = 'OPEN'
            FROM ambiguous_source source
            WHERE reversal.source_bill_no = source.bill_no
              AND starts_with(reversal.bill_no, 'YF-HC-CX-')
              AND reversal.status = 'REVERSED'
              AND reversal.paid_amount = 0
              AND reversal.updated_at >= %2$L::timestamptz
              AND reversal.updated_at <= %3$L::timestamptz
        $sql$, target_schema, v118_window_start, v118_window_end);
    END LOOP;
END $$;
