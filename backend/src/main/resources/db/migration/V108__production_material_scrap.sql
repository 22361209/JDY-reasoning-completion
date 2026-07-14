-- F061 / A151: formal production-material scrap documents.  This migration
-- adds only new, bounded tables and indexes; it does not rewrite inventory or
-- production history, so lock duration is limited to catalog DDL.

CREATE TABLE production_material_scrap (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    bill_no VARCHAR(80) NOT NULL,
    bill_date DATE NOT NULL,
    business_type VARCHAR(40) NOT NULL DEFAULT 'PRODUCTION_SCRAP',
    source_issue_id UUID NOT NULL,
    workshop_id UUID NOT NULL,
    workshop_code_snapshot VARCHAR(80) NOT NULL,
    workshop_name_snapshot VARCHAR(160) NOT NULL,
    status VARCHAR(40) NOT NULL DEFAULT 'DRAFT',
    close_status VARCHAR(40) NOT NULL DEFAULT 'OPEN',
    frozen_status VARCHAR(40) NOT NULL DEFAULT 'NORMAL',
    audited_at TIMESTAMPTZ,
    reversed_at TIMESTAMPTZ,
    version BIGINT NOT NULL DEFAULT 0,
    voided_at TIMESTAMPTZ,
    void_reason TEXT,
    void_verified_username VARCHAR(80),
    void_verified_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT fk_production_material_scrap_source_issue
        FOREIGN KEY (source_issue_id) REFERENCES production_material_issue(id),
    CONSTRAINT fk_production_material_scrap_workshop
        FOREIGN KEY (workshop_id) REFERENCES md_production_department(id),
    CONSTRAINT uq_production_material_scrap_bill_no UNIQUE (bill_no),
    CONSTRAINT ck_production_material_scrap_business_type
        CHECK (business_type = 'PRODUCTION_SCRAP'),
    CONSTRAINT ck_production_material_scrap_status
        CHECK (status IN ('DRAFT', 'AUDITED', 'VOID')),
    CONSTRAINT ck_production_material_scrap_close_status
        CHECK (close_status IN ('OPEN', 'CLOSED')),
    CONSTRAINT ck_production_material_scrap_frozen_status
        CHECK (frozen_status IN ('NORMAL', 'FROZEN')),
    CONSTRAINT ck_production_material_scrap_version CHECK (version >= 0),
    CONSTRAINT ck_production_material_scrap_workshop_snapshot
        CHECK (
            NULLIF(BTRIM(workshop_code_snapshot), '') IS NOT NULL
            AND NULLIF(BTRIM(workshop_name_snapshot), '') IS NOT NULL
        ),
    CONSTRAINT ck_production_material_scrap_timestamps
        CHECK (
            updated_at >= created_at
            AND (audited_at IS NULL OR audited_at >= created_at)
            AND (reversed_at IS NULL OR reversed_at >= created_at)
            AND (voided_at IS NULL OR voided_at >= created_at)
            AND (void_verified_at IS NULL OR void_verified_at >= created_at)
        )
);

CREATE TABLE production_material_scrap_line (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    scrap_id UUID NOT NULL,
    line_no INTEGER NOT NULL,
    source_issue_line_id UUID NOT NULL,
    product_id UUID NOT NULL,
    product_code_snapshot VARCHAR(80) NOT NULL,
    product_name_snapshot VARCHAR(200) NOT NULL,
    product_spec_snapshot VARCHAR(200),
    product_unit_snapshot VARCHAR(40) NOT NULL,
    source_warehouse_id UUID NOT NULL,
    source_warehouse_code_snapshot VARCHAR(80) NOT NULL,
    issue_qty_snapshot NUMERIC(18, 4) NOT NULL,
    available_scrap_qty_snapshot NUMERIC(18, 4) NOT NULL,
    scrap_qty NUMERIC(18, 4) NOT NULL DEFAULT 0,
    scrap_reason TEXT,
    reissue_qty NUMERIC(18, 4) NOT NULL DEFAULT 0,
    is_stock_in BOOLEAN NOT NULL DEFAULT FALSE,
    target_warehouse_id UUID,
    target_warehouse_code_snapshot VARCHAR(80),
    stock_in_status VARCHAR(24) NOT NULL DEFAULT 'NOT_REQUIRED',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT fk_production_material_scrap_line_header
        FOREIGN KEY (scrap_id) REFERENCES production_material_scrap(id) ON DELETE CASCADE,
    CONSTRAINT fk_production_material_scrap_line_product
        FOREIGN KEY (product_id) REFERENCES md_product(id),
    CONSTRAINT fk_production_material_scrap_line_source_warehouse
        FOREIGN KEY (source_warehouse_id) REFERENCES md_warehouse(id),
    CONSTRAINT fk_production_material_scrap_line_target_warehouse
        FOREIGN KEY (target_warehouse_id) REFERENCES md_warehouse(id),
    CONSTRAINT uq_production_material_scrap_line_no UNIQUE (scrap_id, line_no),
    CONSTRAINT uq_production_material_scrap_line_source UNIQUE (scrap_id, source_issue_line_id),
    CONSTRAINT ck_production_material_scrap_line_no CHECK (line_no > 0),
    CONSTRAINT ck_production_material_scrap_line_product_snapshot
        CHECK (
            NULLIF(BTRIM(product_code_snapshot), '') IS NOT NULL
            AND NULLIF(BTRIM(product_name_snapshot), '') IS NOT NULL
            AND NULLIF(BTRIM(product_unit_snapshot), '') IS NOT NULL
        ),
    CONSTRAINT ck_production_material_scrap_line_source_warehouse_snapshot
        CHECK (NULLIF(BTRIM(source_warehouse_code_snapshot), '') IS NOT NULL),
    CONSTRAINT ck_production_material_scrap_line_issue_qty CHECK (issue_qty_snapshot > 0),
    CONSTRAINT ck_production_material_scrap_line_available_qty
        CHECK (
            available_scrap_qty_snapshot >= 0
            AND available_scrap_qty_snapshot <= issue_qty_snapshot
        ),
    CONSTRAINT ck_production_material_scrap_line_scrap_qty CHECK (scrap_qty >= 0),
    CONSTRAINT ck_production_material_scrap_line_reissue_qty
        CHECK (reissue_qty >= 0 AND reissue_qty <= scrap_qty),
    CONSTRAINT ck_production_material_scrap_line_reason
        CHECK (
            scrap_reason IS NULL
            OR (
                NULLIF(BTRIM(scrap_reason), '') IS NOT NULL
                AND CHAR_LENGTH(scrap_reason) <= 1000
            )
        ),
    CONSTRAINT ck_production_material_scrap_line_target_warehouse
        CHECK (
            NOT is_stock_in
            OR (
                target_warehouse_id IS NOT NULL
                AND NULLIF(BTRIM(target_warehouse_code_snapshot), '') IS NOT NULL
            )
        ),
    CONSTRAINT ck_production_material_scrap_line_stock_in_status
        CHECK (
            stock_in_status IN ('NOT_REQUIRED', 'PENDING', 'STOCKED_IN', 'REVERSED')
            AND (is_stock_in OR stock_in_status = 'NOT_REQUIRED')
        )
);

-- Quota checks and source-document guards use exact source ids; reporting uses
-- bounded date/status and product predicates.  These are new empty tables, so
-- index creation never performs an unbounded historical scan.
CREATE INDEX idx_production_material_scrap_source_status
    ON production_material_scrap (source_issue_id, status);
CREATE INDEX idx_production_material_scrap_status_date
    ON production_material_scrap (status, bill_date DESC, id DESC);
CREATE INDEX idx_production_material_scrap_workshop_date
    ON production_material_scrap (workshop_id, bill_date DESC, id DESC);
CREATE INDEX idx_production_material_scrap_line_source
    ON production_material_scrap_line (source_issue_line_id);
CREATE INDEX idx_production_material_scrap_line_product
    ON production_material_scrap_line (product_id, scrap_id);
CREATE INDEX idx_production_material_scrap_line_stock_in
    ON production_material_scrap_line (stock_in_status, target_warehouse_id)
    WHERE is_stock_in;

INSERT INTO sys_tenant_managed_table (table_name, restore_order)
VALUES
    ('production_material_scrap', 521),
    ('production_material_scrap_line', 522);

-- Preserve V99's runtime exemption wrapper and evolve only the exact V105
-- fail-closed topology.  Two tables add two PKs, three UNIQUE constraints,
-- six tenant-local FKs, and seventeen CHECK constraints.
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
       OR position('IF managed_count <> 82 THEN' IN sync_definition) = 0
       OR position('tenant managed table catalog drifted: expected=82 actual=%' IN sync_definition) = 0
       OR position(
           'IF primary_count <> 82 OR unique_count <> 76 OR foreign_key_count <> 170 OR check_count <> 80 THEN'
           IN sync_definition
       ) = 0
       OR position(
           'tenant constraint count drifted: schema=% pk=% uk=% fk=% check=% expected=82/76/170/80'
           IN sync_definition
       ) = 0
       OR position('RETURN managed_count;' IN sync_definition) = 0
       OR position('idx_production_material_scrap_source_status' IN sync_definition) <> 0 THEN
        RAISE EXCEPTION 'V108 refused unexpected tenant sync function topology';
    END IF;

    evolved_definition := replace(
        sync_definition,
        'IF managed_count <> 82 THEN',
        'IF managed_count <> 84 THEN'
    );
    evolved_definition := replace(
        evolved_definition,
        'tenant managed table catalog drifted: expected=82 actual=%',
        'tenant managed table catalog drifted: expected=84 actual=%'
    );
    evolved_definition := replace(
        evolved_definition,
        'IF primary_count <> 82 OR unique_count <> 76 OR foreign_key_count <> 170 OR check_count <> 80 THEN',
        'IF primary_count <> 84 OR unique_count <> 79 OR foreign_key_count <> 176 OR check_count <> 97 THEN'
    );
    evolved_definition := replace(
        evolved_definition,
        'tenant constraint count drifted: schema=% pk=% uk=% fk=% check=% expected=82/76/170/80',
        'tenant constraint count drifted: schema=% pk=% uk=% fk=% check=% expected=84/79/176/97'
    );
    evolved_definition := replace(
        evolved_definition,
        'RETURN managed_count;',
        $indexes$
        EXECUTE format(
            'CREATE INDEX IF NOT EXISTS idx_production_material_scrap_source_status ON %I.production_material_scrap (source_issue_id, status)',
            tenant_schema
        );
        EXECUTE format(
            'CREATE INDEX IF NOT EXISTS idx_production_material_scrap_status_date ON %I.production_material_scrap (status, bill_date DESC, id DESC)',
            tenant_schema
        );
        EXECUTE format(
            'CREATE INDEX IF NOT EXISTS idx_production_material_scrap_workshop_date ON %I.production_material_scrap (workshop_id, bill_date DESC, id DESC)',
            tenant_schema
        );
        EXECUTE format(
            'CREATE INDEX IF NOT EXISTS idx_production_material_scrap_line_source ON %I.production_material_scrap_line (source_issue_line_id)',
            tenant_schema
        );
        EXECUTE format(
            'CREATE INDEX IF NOT EXISTS idx_production_material_scrap_line_product ON %I.production_material_scrap_line (product_id, scrap_id)',
            tenant_schema
        );
        EXECUTE format(
            'CREATE INDEX IF NOT EXISTS idx_production_material_scrap_line_stock_in ON %I.production_material_scrap_line (stock_in_status, target_warehouse_id) WHERE is_stock_in',
            tenant_schema
        );
        RETURN managed_count;
$indexes$
    );

    IF evolved_definition = sync_definition
       OR position('managed_count <> 82' IN evolved_definition) <> 0
       OR position('expected=82/76/170/80' IN evolved_definition) <> 0
       OR position('managed_count <> 84' IN evolved_definition) = 0
       OR position('expected=84/79/176/97' IN evolved_definition) = 0
       OR position('idx_production_material_scrap_source_status' IN evolved_definition) = 0 THEN
        RAISE EXCEPTION 'V108 failed to evolve tenant sync function totals exactly once';
    END IF;

    EXECUTE evolved_definition;
END $$;

-- Historical backups are data-only snapshots.  New V108 facts did not exist
-- when they were captured, so add compatible empty shells without fabricating
-- business rows or constraints.
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
            RAISE EXCEPTION 'V108 backup schema name is unsafe: schema=%', backup_schema;
        END IF;
        IF to_regclass(format('%I.production_material_scrap', backup_schema)) IS NULL THEN
            EXECUTE format(
                'CREATE TABLE %I.production_material_scrap AS TABLE public.production_material_scrap WITH NO DATA',
                backup_schema
            );
        END IF;
        IF to_regclass(format('%I.production_material_scrap_line', backup_schema)) IS NULL THEN
            EXECUTE format(
                'CREATE TABLE %I.production_material_scrap_line AS TABLE public.production_material_scrap_line WITH NO DATA',
                backup_schema
            );
        END IF;
    END LOOP;
END $$;

-- Existing live tenants receive table shells before strict synchronization;
-- new tenants receive the same shape directly from the evolved catalog.
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
            RAISE EXCEPTION 'V108 tenant schema name is unsafe: schema=%', tenant_schema;
        END IF;
        IF to_regclass(format('%I.production_material_scrap', tenant_schema)) IS NULL THEN
            EXECUTE format(
                'CREATE TABLE %I.production_material_scrap (LIKE public.production_material_scrap INCLUDING ALL)',
                tenant_schema
            );
        END IF;
        IF to_regclass(format('%I.production_material_scrap_line', tenant_schema)) IS NULL THEN
            EXECUTE format(
                'CREATE TABLE %I.production_material_scrap_line (LIKE public.production_material_scrap_line INCLUDING ALL)',
                tenant_schema
            );
        END IF;
        PERFORM public.jdy_sync_tenant_schema(tenant_schema, FALSE);
    END LOOP;
END $$;

-- Public retains the four deliberate platform account-set FK exemptions, so
-- its managed FK total remains four above every tenant.
DO $$
DECLARE
    managed_count INTEGER;
    primary_count INTEGER;
    unique_count INTEGER;
    foreign_key_count INTEGER;
    check_count INTEGER;
    source_line_fk_count INTEGER;
    material_scrap_fk_count INTEGER;
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
    INTO source_line_fk_count
    FROM pg_constraint constraint_row
    JOIN pg_class child_table ON child_table.oid = constraint_row.conrelid
    JOIN pg_namespace child_schema ON child_schema.oid = child_table.relnamespace
    WHERE constraint_row.contype = 'f'
      AND child_schema.nspname = 'public'
      AND child_table.relname = 'production_material_scrap_line'
      AND pg_get_constraintdef(constraint_row.oid, TRUE) LIKE 'FOREIGN KEY (source_issue_line_id)%';

    SELECT count(*)::INTEGER
    INTO material_scrap_fk_count
    FROM pg_constraint constraint_row
    JOIN pg_class child_table ON child_table.oid = constraint_row.conrelid
    JOIN pg_namespace child_schema ON child_schema.oid = child_table.relnamespace
    WHERE constraint_row.contype = 'f'
      AND child_schema.nspname = 'public'
      AND child_table.relname IN ('production_material_scrap', 'production_material_scrap_line');

    IF managed_count <> 84
       OR primary_count <> 84
       OR unique_count <> 79
       OR foreign_key_count <> 180
       OR check_count <> 97
       OR source_line_fk_count <> 0
       OR material_scrap_fk_count <> 6 THEN
        RAISE EXCEPTION
            'V108 managed topology drifted: tables=% pk=% uk=% fk=% check=% source_line_fk=% scrap_fk=% expected=84/84/79/180/97/0/6',
            managed_count, primary_count, unique_count, foreign_key_count, check_count,
            source_line_fk_count, material_scrap_fk_count;
    END IF;
END $$;
