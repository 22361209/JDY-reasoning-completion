-- V119 commits narrowly attributed compensation before this migration.  V120
-- validates every registered schema before making any write, then performs the
-- precise reversal backfill and tenant-topology repair in one transaction.

-- Preflight 1: every public/tenant/backup target must be safe and have the data
-- tables used by the lifecycle checks below.  Tenant eligibility is deliberate:
-- disabled and uninitialized account sets are still registered state.
DO $$
DECLARE
    target_schema TEXT;
    required_table TEXT;
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
            RAISE EXCEPTION 'V120 schema name is unsafe: schema=%', target_schema;
        END IF;

        FOREACH required_table IN ARRAY ARRAY['ap_payable', 'purchase_in', 'purchase_return']
        LOOP
            IF to_regclass(format('%I.%I', target_schema, required_table)) IS NULL THEN
                RAISE EXCEPTION 'V120 required table is missing: schema=% table=%',
                    target_schema, required_table;
            END IF;
        END LOOP;
    END LOOP;

    FOR target_schema IN
        SELECT DISTINCT btrim(schema_name)
        FROM public.sys_account_set
        WHERE nullif(btrim(schema_name), '') IS NOT NULL
          AND lower(btrim(schema_name)) <> 'public'
        ORDER BY 1
    LOOP
        IF to_regclass(format('%I.cash_transfer_fact', target_schema)) IS NULL THEN
            RAISE EXCEPTION 'V120 required tenant table is missing: schema=% table=cash_transfer_fact',
                target_schema;
        END IF;
    END LOOP;
END $$;

-- Preflight 2: refuse every ambiguous red-AP shape before the precise backfill.
DO $$
DECLARE
    target_schema TEXT;
    invalid_count BIGINT;
    invalid_source_bill_no TEXT;
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
        EXECUTE format($sql$
            WITH red_source AS (
                SELECT source.bill_no
                FROM %1$I.purchase_in source
                WHERE source.status = 'AUDITED'
                  AND source.red_source_bill_id IS NOT NULL
            ), invalid_shape AS (
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
            SELECT count(*), min(bill_no)
            FROM invalid_shape
        $sql$, target_schema)
        INTO invalid_count, invalid_source_bill_no;

        IF invalid_count <> 0 THEN
            RAISE EXCEPTION
                'V120 refused ambiguous red payable reversal shape: schema=% count=% sample_source_bill_no=%',
                target_schema, invalid_count, invalid_source_bill_no;
        END IF;
    END LOOP;
END $$;

-- Preflight 3: refuse the whole migration when any precisely linked, active
-- reversal has a non-zero settlement.
DO $$
DECLARE
    target_schema TEXT;
    unsafe_count BIGINT;
    unsafe_bill_no TEXT;
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
        EXECUTE format($sql$
            SELECT count(*), min(reversal.bill_no)
            FROM %1$I.ap_payable reversal
            WHERE reversal.status <> 'REVERSED'
              AND reversal.paid_amount <> 0
              AND (
                  EXISTS (
                      SELECT 1
                      FROM %1$I.purchase_in source
                      WHERE source.bill_no = reversal.source_bill_no
                        AND source.status = 'AUDITED'
                        AND source.red_source_bill_id IS NULL
                        AND reversal.bill_no = 'YF-CX-' || source.bill_no
                  )
                  OR EXISTS (
                      SELECT 1
                      FROM %1$I.purchase_in source
                      JOIN %1$I.ap_payable main
                        ON main.source_bill_no = source.bill_no
                       AND starts_with(main.bill_no, 'YF-HC-')
                       AND NOT starts_with(main.bill_no, 'YF-HC-CX-')
                      WHERE source.bill_no = reversal.source_bill_no
                        AND source.status = 'AUDITED'
                        AND source.red_source_bill_id IS NOT NULL
                        AND reversal.bill_no = 'YF-HC-CX-' || substr(main.bill_no, 7)
                  )
                  OR EXISTS (
                      SELECT 1
                      FROM %1$I.purchase_return source
                      WHERE source.bill_no = reversal.source_bill_no
                        AND source.status = 'AUDITED'
                        AND reversal.bill_no = 'YF-TH-CX-' || source.bill_no
                  )
              )
        $sql$, target_schema)
        INTO unsafe_count, unsafe_bill_no;

        IF unsafe_count <> 0 THEN
            RAISE EXCEPTION
                'V120 refused settled active payable reversal: schema=% count=% sample_bill_no=%',
                target_schema, unsafe_count, unsafe_bill_no;
        END IF;
    END LOOP;
END $$;

-- Preflight 4: the strict synchronizer must still expose V118's exact managed
-- topology before V120 performs either data or DDL writes.
DO $$
DECLARE
    sync_definition TEXT;
    expected_condition TEXT := 'IF primary_count <> 90 OR unique_count <> 87 OR foreign_key_count <> 199 OR check_count <> 119 THEN';
    expected_message TEXT := 'tenant constraint count drifted: schema=% pk=% uk=% fk=% check=% expected=90/87/199/119';
BEGIN
    SELECT pg_get_functiondef('public.jdy_sync_tenant_schema_v98(text,boolean)'::regprocedure)
    INTO sync_definition;
    IF sync_definition IS NULL
       OR position(expected_condition IN sync_definition) = 0
       OR position(expected_message IN sync_definition) = 0
       OR length(sync_definition) - length(replace(sync_definition, expected_condition, '')) <> length(expected_condition)
       OR length(sync_definition) - length(replace(sync_definition, expected_message, '')) <> length(expected_message) THEN
        RAISE EXCEPTION 'V120 refused unexpected tenant sync function topology';
    END IF;
END $$;

-- Write 1: retire only unambiguous, precisely linked zero-settlement reversals.
-- The status predicate makes this safe to execute repeatedly.
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
        EXECUTE format($sql$
            UPDATE %1$I.ap_payable reversal
            SET status = 'REVERSED',
                updated_at = now()
            WHERE reversal.status <> 'REVERSED'
              AND reversal.paid_amount = 0
              AND (
                  EXISTS (
                      SELECT 1
                      FROM %1$I.purchase_in source
                      WHERE source.bill_no = reversal.source_bill_no
                        AND source.status = 'AUDITED'
                        AND source.red_source_bill_id IS NULL
                        AND reversal.bill_no = 'YF-CX-' || source.bill_no
                  )
                  OR EXISTS (
                      SELECT 1
                      FROM %1$I.purchase_in source
                      JOIN %1$I.ap_payable main
                        ON main.source_bill_no = source.bill_no
                       AND starts_with(main.bill_no, 'YF-HC-')
                       AND NOT starts_with(main.bill_no, 'YF-HC-CX-')
                      WHERE source.bill_no = reversal.source_bill_no
                        AND source.status = 'AUDITED'
                        AND source.red_source_bill_id IS NOT NULL
                        AND reversal.bill_no = 'YF-HC-CX-' || substr(main.bill_no, 7)
                  )
                  OR EXISTS (
                      SELECT 1
                      FROM %1$I.purchase_return source
                      WHERE source.bill_no = reversal.source_bill_no
                        AND source.status = 'AUDITED'
                        AND reversal.bill_no = 'YF-TH-CX-' || source.bill_no
                  )
              )
        $sql$, target_schema);
    END LOOP;
END $$;

-- Write 2: V117/V118 left LIKE-created, disabled/uninitialized tenants with
-- V109's generated three-column UNIQUE in addition to the lifecycle-versioned
-- key.  Remove only that exact legacy column shape from every tenant.
DO $$
DECLARE
    tenant_schema TEXT;
    legacy_constraint RECORD;
BEGIN
    FOR tenant_schema IN
        SELECT DISTINCT btrim(schema_name)
        FROM public.sys_account_set
        WHERE nullif(btrim(schema_name), '') IS NOT NULL
          AND lower(btrim(schema_name)) <> 'public'
        ORDER BY 1
    LOOP
        FOR legacy_constraint IN
            SELECT constraint_row.conname
            FROM pg_constraint constraint_row
            JOIN pg_class table_row ON table_row.oid = constraint_row.conrelid
            JOIN pg_namespace schema_row ON schema_row.oid = table_row.relnamespace
            WHERE schema_row.nspname = tenant_schema
              AND table_row.relname = 'cash_transfer_fact'
              AND constraint_row.contype = 'u'
              AND ARRAY(
                  SELECT attribute.attname::TEXT
                  FROM unnest(constraint_row.conkey) WITH ORDINALITY key_column(attnum, ordinality)
                  JOIN pg_attribute attribute
                    ON attribute.attrelid = constraint_row.conrelid
                   AND attribute.attnum = key_column.attnum
                  ORDER BY key_column.ordinality
              ) = ARRAY['cash_transfer_id', 'account_id', 'posting_action']::TEXT[]
        LOOP
            EXECUTE format(
                'ALTER TABLE %I.cash_transfer_fact DROP CONSTRAINT %I',
                tenant_schema,
                legacy_constraint.conname
            );
        END LOOP;
    END LOOP;
END $$;

-- Write 3: apply public's no-default/positive-CHECK lifecycle shape to every
-- registered tenant, including disabled and uninitialized ones.
DO $$
DECLARE
    tenant_schema TEXT;
BEGIN
    FOR tenant_schema IN
        SELECT DISTINCT btrim(schema_name)
        FROM public.sys_account_set
        WHERE nullif(btrim(schema_name), '') IS NOT NULL
          AND lower(btrim(schema_name)) <> 'public'
        ORDER BY 1
    LOOP
        PERFORM public.jdy_sync_tenant_schema(tenant_schema, FALSE);
    END LOOP;
END $$;
