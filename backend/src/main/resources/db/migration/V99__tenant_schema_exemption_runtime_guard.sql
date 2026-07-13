-- V98 was still local and unpublished when independent review found that PostgreSQL
-- constraint names are table-local. Keep a runtime guard around the versioned sync
-- function so an identically named FK on a fifth managed table can never inherit one
-- of the four A119 tenant-scope exemptions, including on a database that already ran
-- an earlier local V98 function body before the final V98 checksum was repaired.

ALTER FUNCTION public.jdy_sync_tenant_schema(TEXT, BOOLEAN)
    RENAME TO jdy_sync_tenant_schema_v98;

CREATE FUNCTION public.jdy_sync_tenant_schema(
    requested_schema TEXT,
    create_missing BOOLEAN DEFAULT FALSE
)
RETURNS INTEGER
LANGUAGE plpgsql
AS $$
DECLARE
    reserved_name_count INTEGER;
    exact_exemption_count INTEGER;
BEGIN
    WITH expected(child_table, constraint_name) AS (
        VALUES
            ('document_number_sequence', 'document_number_sequence_account_set_id_fkey'),
            ('inv_stock_balance', 'inv_stock_balance_account_set_id_fkey'),
            ('inv_stock_opening', 'inv_stock_opening_account_set_id_fkey'),
            ('inv_stock_txn', 'inv_stock_txn_account_set_id_fkey')
    ),
    reserved AS (
        SELECT constraint_row.oid,
               constraint_row.conname,
               constraint_row.conrelid,
               constraint_row.confrelid,
               constraint_row.conkey,
               constraint_row.confkey,
               child_table.relname AS child_table,
               parent_table.relname AS parent_table,
               parent_namespace.nspname AS parent_schema
        FROM pg_constraint constraint_row
        JOIN pg_class child_table ON child_table.oid = constraint_row.conrelid
        JOIN pg_namespace child_namespace
          ON child_namespace.oid = child_table.relnamespace
         AND child_namespace.nspname = 'public'
        JOIN public.sys_tenant_managed_table managed
          ON managed.table_name = child_table.relname
        JOIN pg_class parent_table ON parent_table.oid = constraint_row.confrelid
        JOIN pg_namespace parent_namespace ON parent_namespace.oid = parent_table.relnamespace
        WHERE constraint_row.contype = 'f'
          AND constraint_row.conname IN (SELECT constraint_name FROM expected)
    ),
    exact AS (
        SELECT reserved.oid
        FROM reserved
        JOIN expected
          ON expected.child_table = reserved.child_table
         AND expected.constraint_name = reserved.conname
        JOIN pg_attribute child_column
          ON child_column.attrelid = reserved.conrelid
         AND child_column.attnum = reserved.conkey[1]
         AND child_column.attname = 'account_set_id'
        JOIN pg_attribute parent_column
          ON parent_column.attrelid = reserved.confrelid
         AND parent_column.attnum = reserved.confkey[1]
         AND parent_column.attname = 'id'
        WHERE reserved.parent_schema = 'public'
          AND reserved.parent_table = 'sys_account_set'
          AND cardinality(reserved.conkey) = 1
          AND cardinality(reserved.confkey) = 1
    )
    SELECT (SELECT count(*)::INTEGER FROM reserved),
           (SELECT count(*)::INTEGER FROM exact)
    INTO reserved_name_count, exact_exemption_count;

    IF reserved_name_count <> 4 OR exact_exemption_count <> 4 THEN
        RAISE EXCEPTION
            'tenant scope FK exemption runtime drifted: reserved_names=% exact=% expected=4/4',
            reserved_name_count,
            exact_exemption_count;
    END IF;

    RETURN public.jdy_sync_tenant_schema_v98(requested_schema, create_missing);
END $$;

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
