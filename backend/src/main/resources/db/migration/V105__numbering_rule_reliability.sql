-- F093 / A146: numbering rules share one database row lock for issuance and
-- maintenance, use 64-bit counters, and fail closed on invalid legacy values.

-- The retired outsourcing-surface shell was never a formal document type.
-- Remove it from public, every live tenant, and every extant historical backup
-- so a restore cannot make the stale rule visible again.
DO $$
DECLARE
    target_schema TEXT;
BEGIN
    FOR target_schema IN
        SELECT DISTINCT schema_name
        FROM (
            SELECT 'public'::TEXT AS schema_name
            UNION ALL
            SELECT BTRIM(schema_name)
            FROM public.sys_account_set
            WHERE NULLIF(BTRIM(schema_name), '') IS NOT NULL
            UNION ALL
            SELECT BTRIM(backup_schema_name)
            FROM public.sys_account_set_backup
            WHERE NULLIF(BTRIM(backup_schema_name), '') IS NOT NULL
        ) registered
        ORDER BY 1
    LOOP
        IF target_schema !~ '^[a-z][a-z0-9_]{0,62}$' THEN
            RAISE EXCEPTION 'V105 numbering schema name is unsafe: schema=%', target_schema;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = target_schema) THEN
            CONTINUE;
        END IF;
        IF to_regclass(format('%I.document_number_sequence', target_schema)) IS NULL THEN
            RAISE EXCEPTION 'V105 numbering table is missing: schema=% table=document_number_sequence', target_schema;
        END IF;
        EXECUTE format(
            'DELETE FROM %I.document_number_sequence WHERE document_type = %L',
            target_schema,
            'outsourcingSurface'
        );
    END LOOP;
END $$;

-- Validate every extant copy before changing its type or installing CHECKs.
-- The whole Flyway migration is transactional, so any named object below rolls
-- back together with the retired-row cleanup.
DO $$
DECLARE
    target_schema TEXT;
    invalid_types TEXT;
BEGIN
    FOR target_schema IN
        SELECT DISTINCT schema_name
        FROM (
            SELECT 'public'::TEXT AS schema_name
            UNION ALL
            SELECT BTRIM(schema_name)
            FROM public.sys_account_set
            WHERE NULLIF(BTRIM(schema_name), '') IS NOT NULL
            UNION ALL
            SELECT BTRIM(backup_schema_name)
            FROM public.sys_account_set_backup
            WHERE NULLIF(BTRIM(backup_schema_name), '') IS NOT NULL
        ) registered
        WHERE EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = registered.schema_name)
        ORDER BY 1
    LOOP
        EXECUTE format($sql$
            SELECT string_agg(document_type, ', ' ORDER BY document_type)
            FROM %I.document_number_sequence
            WHERE prefix !~ '^[A-Za-z0-9_-]{1,24}$'
               OR width < 3
               OR width > 12
               OR last_number < 0
               OR last_number::NUMERIC > power(10::NUMERIC, width) - 1
        $sql$, target_schema)
        INTO invalid_types;
        IF invalid_types IS NOT NULL THEN
            RAISE EXCEPTION
                'V105 invalid numbering rows require manual repair: schema=% document_types=%',
                target_schema,
                invalid_types;
        END IF;

        EXECUTE format(
            'ALTER TABLE %I.document_number_sequence ALTER COLUMN last_number TYPE BIGINT USING last_number::BIGINT',
            target_schema
        );
        EXECUTE format(
            'ALTER TABLE %I.document_number_sequence ADD COLUMN version BIGINT NOT NULL DEFAULT 0',
            target_schema
        );
    END LOOP;
END $$;

-- Live public/tenant tables enforce the same named CHECK contract. Historical
-- backup schemas stay data-only snapshots: they receive the compatible column
-- shape above, but no live-table constraints.
DO $$
DECLARE
    target_schema TEXT;
BEGIN
    FOR target_schema IN
        SELECT DISTINCT schema_name
        FROM (
            SELECT 'public'::TEXT AS schema_name
            UNION ALL
            SELECT BTRIM(schema_name)
            FROM public.sys_account_set
            WHERE NULLIF(BTRIM(schema_name), '') IS NOT NULL
        ) registered
        ORDER BY 1
    LOOP
        EXECUTE format($sql$
            ALTER TABLE %I.document_number_sequence
                ADD CONSTRAINT ck_document_number_sequence_prefix
                    CHECK (prefix ~ '^[A-Za-z0-9_-]{1,24}$'),
                ADD CONSTRAINT ck_document_number_sequence_width
                    CHECK (width BETWEEN 3 AND 12),
                ADD CONSTRAINT ck_document_number_sequence_last_number
                    CHECK (
                        last_number >= 0
                        AND last_number::NUMERIC <= power(10::NUMERIC, width) - 1
                    ),
                ADD CONSTRAINT ck_document_number_sequence_version
                    CHECK (version >= 0)
        $sql$, target_schema);
    END LOOP;
END $$;

-- Runtime high-water lookup uses an inclusive bill_no range followed by
-- ORDER BY bill_no DESC LIMIT 1. Fail closed unless every formal document table
-- has the single-column unique btree needed for an indexed reverse seek and for
-- the final duplicate guard.
DO $$
DECLARE
    target_schema TEXT;
    document_table TEXT;
    bill_no_attnum SMALLINT;
    supporting_index_exists BOOLEAN;
BEGIN
    FOR target_schema IN
        SELECT DISTINCT schema_name
        FROM (
            SELECT 'public'::TEXT AS schema_name
            UNION ALL
            SELECT BTRIM(schema_name)
            FROM public.sys_account_set
            WHERE NULLIF(BTRIM(schema_name), '') IS NOT NULL
        ) registered
        ORDER BY 1
    LOOP
        FOREACH document_table IN ARRAY ARRAY[
            'sales_order', 'sales_quote', 'delivery_notice', 'sales_out', 'sales_return',
            'ar_receipt', 'purchase_order', 'purchase_requisition', 'purchase_in',
            'ap_payment', 'purchase_return', 'production_material_issue',
            'production_completion', 'other_stock_in', 'other_stock_out', 'stock_transfer',
            'stock_count', 'stock_count_gain', 'stock_count_loss', 'production_plan',
            'production_task', 'outsourcing_work_order', 'outsourcing_material_issue',
            'outsourcing_receipt', 'outsourcing_return', 'outsourcing_scrap'
        ]
        LOOP
            IF to_regclass(format('%I.%I', target_schema, document_table)) IS NULL THEN
                RAISE EXCEPTION
                    'V105 formal numbering table is missing: schema=% table=%',
                    target_schema,
                    document_table;
            END IF;

            SELECT attribute.attnum
            INTO bill_no_attnum
            FROM pg_attribute attribute
            WHERE attribute.attrelid = to_regclass(format('%I.%I', target_schema, document_table))
              AND attribute.attname = 'bill_no'
              AND NOT attribute.attisdropped;

            SELECT EXISTS (
                SELECT 1
                FROM pg_index index_row
                JOIN pg_class index_class ON index_class.oid = index_row.indexrelid
                JOIN pg_am access_method ON access_method.oid = index_class.relam
                WHERE index_row.indrelid = to_regclass(format('%I.%I', target_schema, document_table))
                  AND index_row.indisvalid
                  AND index_row.indisready
                  AND index_row.indisunique
                  AND index_row.indpred IS NULL
                  AND index_row.indexprs IS NULL
                  AND index_row.indnkeyatts = 1
                  AND index_row.indkey[0] = bill_no_attnum
                  AND access_method.amname = 'btree'
            )
            INTO supporting_index_exists;

            IF bill_no_attnum IS NULL OR NOT supporting_index_exists THEN
                RAISE EXCEPTION
                    'V105 formal numbering index is missing: schema=% table=% column=bill_no expected=single-column unique btree',
                    target_schema,
                    document_table;
            END IF;
        END LOOP;
    END LOOP;
END $$;

-- V105 adds four CHECKs to one existing managed table. Evolve only the exact
-- V104 topology literals and refuse an unexpected local function body.
DO $$
DECLARE
    sync_definition TEXT;
    evolved_definition TEXT;
BEGIN
    SELECT pg_get_functiondef(
        'public.jdy_sync_tenant_schema_v98(text,boolean)'::regprocedure
    )
    INTO sync_definition;

    IF sync_definition IS NULL
       OR position(
           'IF primary_count <> 82 OR unique_count <> 76 OR foreign_key_count <> 170 OR check_count <> 76 THEN'
           IN sync_definition
       ) = 0
       OR position(
           'tenant constraint count drifted: schema=% pk=% uk=% fk=% check=% expected=82/76/170/76'
           IN sync_definition
       ) = 0 THEN
        RAISE EXCEPTION 'V105 refused unexpected tenant sync function topology';
    END IF;

    evolved_definition := replace(
        sync_definition,
        'IF primary_count <> 82 OR unique_count <> 76 OR foreign_key_count <> 170 OR check_count <> 76 THEN',
        'IF primary_count <> 82 OR unique_count <> 76 OR foreign_key_count <> 170 OR check_count <> 80 THEN'
    );
    evolved_definition := replace(
        evolved_definition,
        'tenant constraint count drifted: schema=% pk=% uk=% fk=% check=% expected=82/76/170/76',
        'tenant constraint count drifted: schema=% pk=% uk=% fk=% check=% expected=82/76/170/80'
    );

    IF evolved_definition = sync_definition
       OR position('check_count <> 76' IN evolved_definition) <> 0
       OR position('expected=82/76/170/76' IN evolved_definition) <> 0
       OR position('check_count <> 80' IN evolved_definition) = 0
       OR position('expected=82/76/170/80' IN evolved_definition) = 0 THEN
        RAISE EXCEPTION 'V105 failed to evolve tenant sync CHECK totals exactly once';
    END IF;

    EXECUTE evolved_definition;
END $$;

-- Prove each live tenant still matches the public managed-table contract after
-- its column/type upgrade. Backup schemas remain data-only restore snapshots.
DO $$
DECLARE
    tenant_schema TEXT;
BEGIN
    FOR tenant_schema IN
        SELECT DISTINCT BTRIM(schema_name)
        FROM public.sys_account_set
        WHERE NULLIF(BTRIM(schema_name), '') IS NOT NULL
          AND LOWER(BTRIM(schema_name)) <> 'public'
        ORDER BY 1
    LOOP
        IF tenant_schema !~ '^[a-z][a-z0-9_]{0,62}$' THEN
            RAISE EXCEPTION 'V105 tenant schema name is unsafe: schema=%', tenant_schema;
        END IF;
        PERFORM public.jdy_sync_tenant_schema(tenant_schema, FALSE);
    END LOOP;
END $$;

DO $$
DECLARE
    managed_count INTEGER;
    primary_count INTEGER;
    unique_count INTEGER;
    foreign_key_count INTEGER;
    check_count INTEGER;
    legacy_count BIGINT;
BEGIN
    SELECT count(*)::INTEGER
    INTO managed_count
    FROM public.sys_tenant_managed_table;

    SELECT count(*) FILTER (WHERE constraint_row.contype = 'p')::INTEGER,
           count(*) FILTER (WHERE constraint_row.contype = 'u')::INTEGER,
           count(*) FILTER (WHERE constraint_row.contype = 'f')::INTEGER,
           count(*) FILTER (WHERE constraint_row.contype = 'c')::INTEGER
    INTO primary_count, unique_count, foreign_key_count, check_count
    FROM pg_constraint constraint_row
    JOIN pg_class table_row ON table_row.oid = constraint_row.conrelid
    JOIN pg_namespace schema_row
      ON schema_row.oid = table_row.relnamespace
     AND schema_row.nspname = 'public'
    JOIN public.sys_tenant_managed_table managed
      ON managed.table_name = table_row.relname;

    SELECT count(*)::BIGINT
    INTO legacy_count
    FROM public.document_number_sequence
    WHERE document_type = 'outsourcingSurface';

    IF managed_count <> 82
       OR primary_count <> 82
       OR unique_count <> 76
       OR foreign_key_count <> 174
       OR check_count <> 80
       OR legacy_count <> 0 THEN
        RAISE EXCEPTION
            'V105 managed topology drifted: tables=% pk=% uk=% fk=% check=% legacy=% expected=82/82/76/174/80/0',
            managed_count,
            primary_count,
            unique_count,
            foreign_key_count,
            check_count,
            legacy_count;
    END IF;
END $$;
