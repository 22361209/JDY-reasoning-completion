-- A186 persists the header remark already exposed by the shared document UI
-- for product completions, stock transfers, and stock counts. Historical NULL
-- values remain NULL: a remark lost before this migration cannot be recreated.

-- Every live schema must expose the three canonical document tables before any
-- DDL is applied. Disabled and uninitialized account sets are still registered
-- live state and must evolve together with public.
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
        ORDER BY 1
    LOOP
        IF target_schema !~ '^[a-z][a-z0-9_]{0,62}$' THEN
            RAISE EXCEPTION 'V121 schema name is unsafe: schema=%', target_schema;
        END IF;

        FOREACH required_table IN ARRAY ARRAY['production_completion', 'stock_transfer', 'stock_count']
        LOOP
            IF to_regclass(format('%I.%I', target_schema, required_table)) IS NULL THEN
                RAISE EXCEPTION 'V121 required live table is missing: schema=% table=%',
                    target_schema, required_table;
            END IF;
        END LOOP;
    END LOOP;
END $$;

ALTER TABLE public.production_completion ADD COLUMN IF NOT EXISTS remark TEXT;
ALTER TABLE public.stock_transfer ADD COLUMN IF NOT EXISTS remark TEXT;
ALTER TABLE public.stock_count ADD COLUMN IF NOT EXISTS remark TEXT;

-- The strict synchronizer copies the new public columns into every registered
-- tenant and verifies the complete managed topology before returning.
DO $$
DECLARE
    target_schema TEXT;
BEGIN
    FOR target_schema IN
        SELECT DISTINCT btrim(schema_name)
        FROM public.sys_account_set
        WHERE nullif(btrim(schema_name), '') IS NOT NULL
          AND lower(btrim(schema_name)) <> 'public'
        ORDER BY 1
    LOOP
        IF target_schema !~ '^[a-z][a-z0-9_]{0,62}$' THEN
            RAISE EXCEPTION 'V121 schema name is unsafe: schema=%', target_schema;
        END IF;
        PERFORM public.jdy_sync_tenant_schema(target_schema, FALSE);
    END LOOP;
END $$;

-- ADD COLUMN IF NOT EXISTS must not silently accept an incompatible column
-- left by a partial/manual rollout. Verify the exact nullable TEXT/no-default
-- contract in public and every registered live tenant after synchronization.
DO $$
DECLARE
    target_schema TEXT;
    required_table TEXT;
    matching_columns INTEGER;
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
        FOREACH required_table IN ARRAY ARRAY['production_completion', 'stock_transfer', 'stock_count']
        LOOP
            SELECT count(*)
            INTO matching_columns
            FROM information_schema.columns
            WHERE table_schema = target_schema
              AND table_name = required_table
              AND column_name = 'remark'
              AND data_type = 'text'
              AND is_nullable = 'YES'
              AND column_default IS NULL
              AND is_generated = 'NEVER'
              AND is_identity = 'NO';
            IF matching_columns <> 1 THEN
                RAISE EXCEPTION 'V121 live remark column contract mismatch: schema=% table=%',
                    target_schema, required_table;
            END IF;
        END LOOP;
    END LOOP;
END $$;

-- Historical backup schemas are data-only and may contain only a subset of
-- business tables. Evolve each table that exists without creating new tables
-- or constraints, preserving the established backup topology contract.
DO $$
DECLARE
    target_schema TEXT;
    target_table TEXT;
    matching_columns INTEGER;
BEGIN
    FOR target_schema IN
        SELECT DISTINCT btrim(backup_schema_name)
        FROM public.sys_account_set_backup
        WHERE nullif(btrim(backup_schema_name), '') IS NOT NULL
        ORDER BY 1
    LOOP
        IF target_schema !~ '^[a-z][a-z0-9_]{0,62}$' THEN
            RAISE EXCEPTION 'V121 backup schema name is unsafe: schema=%', target_schema;
        END IF;
        FOREACH target_table IN ARRAY ARRAY['production_completion', 'stock_transfer', 'stock_count']
        LOOP
            IF to_regclass(format('%I.%I', target_schema, target_table)) IS NOT NULL THEN
                EXECUTE format(
                    'ALTER TABLE %I.%I ADD COLUMN IF NOT EXISTS remark TEXT',
                    target_schema,
                    target_table
                );
                SELECT count(*)
                INTO matching_columns
                FROM information_schema.columns
                WHERE table_schema = target_schema
                  AND table_name = target_table
                  AND column_name = 'remark'
                  AND data_type = 'text'
                  AND is_nullable = 'YES'
                  AND column_default IS NULL
                  AND is_generated = 'NEVER'
                  AND is_identity = 'NO';
                IF matching_columns <> 1 THEN
                    RAISE EXCEPTION 'V121 backup remark column contract mismatch: schema=% table=%',
                        target_schema, target_table;
                END IF;
            END IF;
        END LOOP;
    END LOOP;
END $$;
