-- A143 stores only bounded, normalized preview facts.  The original workbook
-- never enters PostgreSQL, and successful/expired jobs cannot retain a
-- confirmable payload.
CREATE TABLE md_import_batch (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    account_set_id UUID NOT NULL,
    account_set_code VARCHAR(80) NOT NULL,
    created_by UUID NOT NULL,
    created_by_username VARCHAR(80) NOT NULL,
    import_type VARCHAR(40) NOT NULL,
    template_version INTEGER NOT NULL DEFAULT 1,
    original_file_name VARCHAR(255) NOT NULL,
    file_sha256 VARCHAR(64) NOT NULL,
    file_size_bytes BIGINT NOT NULL,
    status VARCHAR(20) NOT NULL,
    total_rows INTEGER NOT NULL DEFAULT 0,
    valid_rows INTEGER NOT NULL DEFAULT 0,
    error_rows INTEGER NOT NULL DEFAULT 0,
    committed_rows INTEGER NOT NULL DEFAULT 0,
    rows_payload JSONB NOT NULL DEFAULT '[]'::jsonb,
    failure_reason TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at TIMESTAMPTZ NOT NULL,
    committed_at TIMESTAMPTZ,
    payload_cleared_at TIMESTAMPTZ,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    version BIGINT NOT NULL DEFAULT 0,
    CONSTRAINT ck_md_import_batch_account_snapshot
        CHECK (
            NULLIF(BTRIM(account_set_code), '') IS NOT NULL
            AND NULLIF(BTRIM(created_by_username), '') IS NOT NULL
        ),
    CONSTRAINT ck_md_import_batch_type
        CHECK (import_type IN (
            'product',
            'productCategory',
            'unit',
            'customer',
            'supplier',
            'warehouse',
            'employee',
            'financialAccount'
        )),
    CONSTRAINT ck_md_import_batch_template_version
        CHECK (template_version = 1),
    CONSTRAINT ck_md_import_batch_file_name
        CHECK (
            NULLIF(BTRIM(original_file_name), '') IS NOT NULL
            AND LOWER(original_file_name) LIKE '%.xlsx'
        ),
    CONSTRAINT ck_md_import_batch_file_integrity
        CHECK (
            file_sha256 ~ '^[0-9a-f]{64}$'
            AND file_size_bytes > 0
            AND file_size_bytes <= 10485760
        ),
    CONSTRAINT ck_md_import_batch_status
        CHECK (status IN ('VALIDATED', 'INVALID', 'COMMITTED', 'STALE', 'FAILED', 'EXPIRED')),
    CONSTRAINT ck_md_import_batch_counts
        CHECK (
            total_rows BETWEEN 0 AND 5000
            AND valid_rows BETWEEN 0 AND total_rows
            AND error_rows BETWEEN 0 AND total_rows
            AND committed_rows BETWEEN 0 AND total_rows
            AND valid_rows + error_rows <= total_rows
        ),
    CONSTRAINT ck_md_import_batch_rows_payload
        CHECK (
            jsonb_typeof(rows_payload) = 'array'
            AND jsonb_array_length(rows_payload) <= 5000
        ),
    CONSTRAINT ck_md_import_batch_state
        CHECK (
            (
                status = 'VALIDATED'
                AND total_rows > 0
                AND valid_rows = total_rows
                AND error_rows = 0
                AND committed_rows = 0
                AND committed_at IS NULL
                AND jsonb_array_length(rows_payload) > 0
            )
            OR (
                status IN ('INVALID', 'STALE', 'FAILED')
                AND committed_rows = 0
                AND committed_at IS NULL
            )
            OR (
                status = 'COMMITTED'
                AND total_rows > 0
                AND valid_rows = total_rows
                AND error_rows = 0
                AND committed_rows = total_rows
                AND committed_at IS NOT NULL
                AND rows_payload = '[]'::jsonb
                AND payload_cleared_at IS NOT NULL
            )
            OR (
                status = 'EXPIRED'
                AND committed_rows = 0
                AND committed_at IS NULL
                AND rows_payload = '[]'::jsonb
                AND payload_cleared_at IS NOT NULL
            )
        ),
    CONSTRAINT ck_md_import_batch_timestamps
        CHECK (
            expires_at > created_at
            AND updated_at >= created_at
            AND (committed_at IS NULL OR committed_at >= created_at)
            AND (payload_cleared_at IS NULL OR payload_cleared_at >= created_at)
        ),
    CONSTRAINT ck_md_import_batch_failure_reason
        CHECK (
            (
                failure_reason IS NULL
                OR (
                    NULLIF(BTRIM(failure_reason), '') IS NOT NULL
                    AND CHAR_LENGTH(failure_reason) <= 1000
                )
            )
            AND (
                status <> 'FAILED'
                OR NULLIF(BTRIM(failure_reason), '') IS NOT NULL
            )
        ),
    CONSTRAINT ck_md_import_batch_version CHECK (version >= 0)
);

CREATE INDEX idx_md_import_batch_owner_created
    ON md_import_batch (account_set_id, created_by, created_at DESC);
CREATE INDEX idx_md_import_batch_status_expiry
    ON md_import_batch (status, expires_at);

INSERT INTO sys_tenant_managed_table (table_name, restore_order)
VALUES ('md_import_batch', 75);

-- Preserve V99's runtime exemption wrapper and evolve only the exact V103
-- fail-closed topology totals.  The batch adds one PK and twelve CHECKs, but
-- deliberately adds no account-set FK or uniqueness exemption.
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
       OR position('IF managed_count <> 81 THEN' IN sync_definition) = 0
       OR position('tenant managed table catalog drifted: expected=81 actual=%' IN sync_definition) = 0
       OR position(
           'IF primary_count <> 81 OR unique_count <> 76 OR foreign_key_count <> 170 OR check_count <> 64 THEN'
           IN sync_definition
       ) = 0
       OR position(
           'tenant constraint count drifted: schema=% pk=% uk=% fk=% check=% expected=81/76/170/64'
           IN sync_definition
       ) = 0 THEN
        RAISE EXCEPTION 'V104 refused unexpected tenant sync function topology';
    END IF;

    evolved_definition := replace(
        sync_definition,
        'IF managed_count <> 81 THEN',
        'IF managed_count <> 82 THEN'
    );
    evolved_definition := replace(
        evolved_definition,
        'tenant managed table catalog drifted: expected=81 actual=%',
        'tenant managed table catalog drifted: expected=82 actual=%'
    );
    evolved_definition := replace(
        evolved_definition,
        'IF primary_count <> 81 OR unique_count <> 76 OR foreign_key_count <> 170 OR check_count <> 64 THEN',
        'IF primary_count <> 82 OR unique_count <> 76 OR foreign_key_count <> 170 OR check_count <> 76 THEN'
    );
    evolved_definition := replace(
        evolved_definition,
        'tenant constraint count drifted: schema=% pk=% uk=% fk=% check=% expected=81/76/170/64',
        'tenant constraint count drifted: schema=% pk=% uk=% fk=% check=% expected=82/76/170/76'
    );

    IF evolved_definition = sync_definition
       OR position('managed_count <> 81' IN evolved_definition) <> 0
       OR position('expected=81/76/170/64' IN evolved_definition) <> 0
       OR position('managed_count <> 82' IN evolved_definition) = 0
       OR position('expected=82/76/170/76' IN evolved_definition) = 0 THEN
        RAISE EXCEPTION 'V104 failed to evolve tenant sync function totals exactly once';
    END IF;

    EXECUTE evolved_definition;
END $$;

-- Historical backup schemas remain data-only snapshots.  They need an empty
-- shell so the strict restore planner can cover all managed tables after V104.
DO $$
DECLARE
    backup_schema TEXT;
BEGIN
    FOR backup_schema IN
        SELECT DISTINCT BTRIM(backup_schema_name)
        FROM public.sys_account_set_backup
        WHERE NULLIF(BTRIM(backup_schema_name), '') IS NOT NULL
        ORDER BY 1
    LOOP
        IF NOT EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = backup_schema) THEN
            CONTINUE;
        END IF;
        IF backup_schema !~ '^[a-z][a-z0-9_]{0,62}$' THEN
            RAISE EXCEPTION 'V104 backup schema name is unsafe: schema=%', backup_schema;
        END IF;
        IF to_regclass(format('%I.md_import_batch', backup_schema)) IS NULL THEN
            EXECUTE format(
                'CREATE TABLE %I.md_import_batch AS TABLE public.md_import_batch WITH NO DATA',
                backup_schema
            );
        END IF;
    END LOOP;
END $$;

-- Existing tenants receive the table shell before strict create_missing=FALSE
-- synchronization proves column, index and constraint parity.
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
            RAISE EXCEPTION 'V104 tenant schema name is unsafe: schema=%', tenant_schema;
        END IF;
        IF to_regclass(format('%I.md_import_batch', tenant_schema)) IS NULL THEN
            EXECUTE format(
                'CREATE TABLE %I.md_import_batch (LIKE public.md_import_batch INCLUDING ALL)',
                tenant_schema
            );
        END IF;
        PERFORM public.jdy_sync_tenant_schema(tenant_schema, FALSE);
    END LOOP;
END $$;

-- Public keeps the four deliberate platform-account-set FK exemptions, hence
-- its FK total remains four above every tenant.  Fail closed on exact V104 DDL.
DO $$
DECLARE
    managed_count INTEGER;
    primary_count INTEGER;
    unique_count INTEGER;
    foreign_key_count INTEGER;
    check_count INTEGER;
    import_account_set_fk_count INTEGER;
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

    SELECT count(*)::INTEGER
    INTO import_account_set_fk_count
    FROM pg_constraint constraint_row
    JOIN pg_class child_table ON child_table.oid = constraint_row.conrelid
    JOIN pg_namespace child_schema ON child_schema.oid = child_table.relnamespace
    WHERE constraint_row.contype = 'f'
      AND child_schema.nspname = 'public'
      AND child_table.relname = 'md_import_batch';

    IF managed_count <> 82
       OR primary_count <> 82
       OR unique_count <> 76
       OR foreign_key_count <> 174
       OR check_count <> 76
       OR import_account_set_fk_count <> 0 THEN
        RAISE EXCEPTION
            'V104 managed topology drifted: tables=% pk=% uk=% fk=% check=% import_account_set_fk=% expected=82/82/76/174/76/0',
            managed_count, primary_count, unique_count, foreign_key_count, check_count,
            import_account_set_fk_count;
    END IF;
END $$;
