-- A181 review hardening for V117.  Keep the applied V117 checksum stable and
-- close its fail-open/data-shape gaps in a new migration.

-- Refuse the whole backfill before changing any row when a current audited
-- purchase source still has an active reversal fact that has been settled.
-- The same guard covers live public, every active tenant, and every historical
-- backup schema.  Missing historical shapes are corruption, not a reason to
-- silently skip a registered schema.
DO $$
DECLARE
    target_schema TEXT;
    required_table TEXT;
    unsafe_count BIGINT;
    unsafe_bill_no TEXT;
BEGIN
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
            RAISE EXCEPTION 'V118 schema name is unsafe: schema=%', target_schema;
        END IF;

        FOREACH required_table IN ARRAY ARRAY['ap_payable', 'purchase_in', 'purchase_return']
        LOOP
            IF to_regclass(format('%I.%I', target_schema, required_table)) IS NULL THEN
                RAISE EXCEPTION 'V118 required table is missing: schema=% table=%',
                    target_schema, required_table;
            END IF;
        END LOOP;

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
                      WHERE source.bill_no = reversal.source_bill_no
                        AND source.status = 'AUDITED'
                        AND source.red_source_bill_id IS NOT NULL
                        AND reversal.bill_no LIKE 'YF-HC-CX-%%'
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
                'V118 refused settled active payable reversal: schema=% count=% sample_bill_no=%',
                target_schema, unsafe_count, unsafe_bill_no;
        END IF;
    END LOOP;
END $$;

-- Once every schema has passed the paid-amount preflight, retire all three
-- historical reversal shapes.  The status predicate makes repeat execution a
-- no-op, including for the normal and return rows already handled by V117.
DO $$
DECLARE
    target_schema TEXT;
BEGIN
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
                      WHERE source.bill_no = reversal.source_bill_no
                        AND source.status = 'AUDITED'
                        AND source.red_source_bill_id IS NOT NULL
                        AND reversal.bill_no LIKE 'YF-HC-CX-%%'
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

-- posting_version is supplied by the lifecycle writer.  A default would turn a
-- missing version into a duplicate semantic version, so public is the template:
-- no default, NOT NULL, and strictly positive.
ALTER TABLE public.cash_transfer_fact
    ALTER COLUMN posting_version DROP DEFAULT;

DO $$
DECLARE
    existing_definition TEXT;
BEGIN
    SELECT regexp_replace(pg_get_expr(constraint_row.conbin, constraint_row.conrelid), '\s+', '', 'g')
    INTO existing_definition
    FROM pg_constraint constraint_row
    WHERE constraint_row.conrelid = 'public.cash_transfer_fact'::regclass
      AND constraint_row.conname = 'ck_cash_transfer_fact_posting_version';

    IF existing_definition IS NULL THEN
        ALTER TABLE public.cash_transfer_fact
            ADD CONSTRAINT ck_cash_transfer_fact_posting_version
            CHECK (posting_version > 0);
    ELSIF existing_definition NOT IN ('posting_version>0', '(posting_version>0)') THEN
        RAISE EXCEPTION 'V118 posting-version check drifted: definition=%', existing_definition;
    END IF;
END $$;

-- One new managed CHECK changes the strict tenant topology from 90/87/199/118
-- to 90/87/199/119.  Accept only the exact before state or the exact idempotent
-- after state; any other function body is a fail-closed topology drift.
DO $$
DECLARE
    sync_definition TEXT;
    evolved_definition TEXT;
    old_condition TEXT := 'IF primary_count <> 90 OR unique_count <> 87 OR foreign_key_count <> 199 OR check_count <> 118 THEN';
    new_condition TEXT := 'IF primary_count <> 90 OR unique_count <> 87 OR foreign_key_count <> 199 OR check_count <> 119 THEN';
    old_message TEXT := 'tenant constraint count drifted: schema=% pk=% uk=% fk=% check=% expected=90/87/199/118';
    new_message TEXT := 'tenant constraint count drifted: schema=% pk=% uk=% fk=% check=% expected=90/87/199/119';
BEGIN
    SELECT pg_get_functiondef('public.jdy_sync_tenant_schema_v98(text,boolean)'::regprocedure)
    INTO sync_definition;

    IF sync_definition IS NULL THEN
        RAISE EXCEPTION 'V118 refused missing strict tenant sync function';
    END IF;

    IF position(old_condition IN sync_definition) > 0
       AND position(old_message IN sync_definition) > 0
       AND position(new_condition IN sync_definition) = 0
       AND position(new_message IN sync_definition) = 0 THEN
        IF length(sync_definition) - length(replace(sync_definition, old_condition, '')) <> length(old_condition)
           OR length(sync_definition) - length(replace(sync_definition, old_message, '')) <> length(old_message) THEN
            RAISE EXCEPTION 'V118 refused repeated pre-change tenant topology literals';
        END IF;
        evolved_definition := replace(sync_definition, old_condition, new_condition);
        evolved_definition := replace(evolved_definition, old_message, new_message);
        IF position(old_condition IN evolved_definition) <> 0
           OR position(old_message IN evolved_definition) <> 0
           OR position(new_condition IN evolved_definition) = 0
           OR position(new_message IN evolved_definition) = 0 THEN
            RAISE EXCEPTION 'V118 failed to evolve tenant sync topology exactly once';
        END IF;
        EXECUTE evolved_definition;
    ELSIF position(old_condition IN sync_definition) = 0
       AND position(old_message IN sync_definition) = 0
       AND position(new_condition IN sync_definition) > 0
       AND position(new_message IN sync_definition) > 0 THEN
        NULL;
    ELSE
        RAISE EXCEPTION 'V118 refused unexpected tenant sync function topology';
    END IF;
END $$;

-- LIKE-created tenant tables can carry V109's original three-column UNIQUE
-- under a generated name.  V117 dropped only the public constraint name, so
-- remove the active-tenant legacy key by its exact ordered columns before
-- strict sync.
DO $$
DECLARE
    tenant_schema TEXT;
    legacy_constraint RECORD;
BEGIN
    FOR tenant_schema IN
        SELECT DISTINCT btrim(schema_name)
        FROM public.sys_account_set
        WHERE enabled IS TRUE
          AND initialized IS TRUE
          AND nullif(btrim(schema_name), '') IS NOT NULL
          AND lower(btrim(schema_name)) <> 'public'
        ORDER BY 1
    LOOP
        IF tenant_schema !~ '^[a-z][a-z0-9_]{0,62}$' THEN
            RAISE EXCEPTION 'V118 active tenant schema name is unsafe: schema=%', tenant_schema;
        END IF;
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

-- The strict synchronizer copies the removed default and new CHECK to every
-- active tenant, then verifies the full managed constraint totals itself.
DO $$
DECLARE
    tenant_schema TEXT;
BEGIN
    FOR tenant_schema IN
        SELECT DISTINCT btrim(schema_name)
        FROM public.sys_account_set
        WHERE enabled IS TRUE
          AND initialized IS TRUE
          AND nullif(btrim(schema_name), '') IS NOT NULL
          AND lower(btrim(schema_name)) <> 'public'
        ORDER BY 1
    LOOP
        IF tenant_schema !~ '^[a-z][a-z0-9_]{0,62}$' THEN
            RAISE EXCEPTION 'V118 active tenant schema name is unsafe: schema=%', tenant_schema;
        END IF;
        PERFORM public.jdy_sync_tenant_schema(tenant_schema, FALSE);
    END LOOP;
END $$;

-- Backups retain the data column and its V117 backfill but remain data-only:
-- no default, lifecycle CHECK, or live unique fact key is introduced.
DO $$
DECLARE
    backup_schema TEXT;
    backup_constraint_count INTEGER;
BEGIN
    FOR backup_schema IN
        SELECT DISTINCT btrim(backup_schema_name)
        FROM public.sys_account_set_backup
        WHERE nullif(btrim(backup_schema_name), '') IS NOT NULL
        ORDER BY 1
    LOOP
        IF backup_schema !~ '^[a-z][a-z0-9_]{0,62}$' THEN
            RAISE EXCEPTION 'V118 backup schema name is unsafe: schema=%', backup_schema;
        END IF;
        IF to_regclass(format('%I.cash_transfer_fact', backup_schema)) IS NULL THEN
            RAISE EXCEPTION 'V118 required backup table is missing: schema=% table=cash_transfer_fact',
                backup_schema;
        END IF;
        EXECUTE format(
            'ALTER TABLE %I.cash_transfer_fact ALTER COLUMN posting_version DROP DEFAULT',
            backup_schema
        );
        SELECT count(*)::INTEGER
        INTO backup_constraint_count
        FROM pg_constraint constraint_row
        WHERE constraint_row.conrelid = to_regclass(format('%I.cash_transfer_fact', backup_schema));
        IF backup_constraint_count <> 0 THEN
            RAISE EXCEPTION 'V118 backup cash-transfer fact must remain data-only: schema=% constraints=%',
                backup_schema, backup_constraint_count;
        END IF;
    END LOOP;
END $$;
