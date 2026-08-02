-- A170: make production-plan generation options explicit, preserve the
-- production-task BOM tree, and introduce editable purchase requisitions plus
-- an independent supplier-grouped purchase-plan document.

ALTER TABLE production_plan_line
    ADD COLUMN expand_multilevel_tasks BOOLEAN NOT NULL DEFAULT FALSE,
    ADD COLUMN generate_purchase_requisition BOOLEAN NOT NULL DEFAULT TRUE;

ALTER TABLE production_task
    ADD COLUMN source_kind VARCHAR(40),
    ADD COLUMN parent_task_id UUID REFERENCES production_task(id),
    ADD COLUMN root_task_id UUID REFERENCES production_task(id) ON DELETE SET NULL,
    ADD COLUMN source_bom_line_id UUID REFERENCES prod_bom_line(id),
    ADD COLUMN source_level INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN bom_path VARCHAR(1000);

UPDATE production_task
SET source_kind = CASE WHEN plan_id IS NULL THEN 'MANUAL' ELSE 'PLAN_ROOT' END,
    root_task_id = id,
    bom_path = CASE WHEN plan_line_id IS NULL THEN NULL ELSE 'ROOT' END
WHERE source_kind IS NULL
   OR root_task_id IS NULL;

ALTER TABLE production_task
    ALTER COLUMN source_kind SET DEFAULT 'MANUAL',
    ALTER COLUMN source_kind SET NOT NULL,
    ADD CONSTRAINT ck_production_task_source_level CHECK (source_level >= 0),
    ADD CONSTRAINT ck_production_task_source_shape CHECK (
        (source_kind = 'BOM_CHILD' AND parent_task_id IS NOT NULL AND source_bom_line_id IS NOT NULL AND source_level > 0)
        OR ((source_kind = 'MANUAL' OR source_kind = 'PLAN_ROOT') AND parent_task_id IS NULL AND source_level = 0)
    );

ALTER TABLE production_task_material_snapshot
    ADD COLUMN issue_warehouse_id UUID REFERENCES md_warehouse(id),
    ADD COLUMN issue_warehouse_code_snapshot VARCHAR(80),
    ADD COLUMN issue_method_snapshot VARCHAR(40);

UPDATE production_task_material_snapshot snapshot
SET issue_warehouse_id = COALESCE(
        (SELECT line.issue_warehouse_id FROM prod_bom_line line WHERE line.id = snapshot.source_bom_line_id),
        (SELECT product.default_warehouse_id FROM md_product product WHERE product.id = snapshot.product_id)
    ),
    issue_warehouse_code_snapshot = COALESCE(
        (SELECT line.issue_warehouse_code FROM prod_bom_line line WHERE line.id = snapshot.source_bom_line_id),
        (SELECT warehouse.code
         FROM md_warehouse warehouse
         WHERE warehouse.id = COALESCE(
             (SELECT line.issue_warehouse_id FROM prod_bom_line line WHERE line.id = snapshot.source_bom_line_id),
             (SELECT product.default_warehouse_id FROM md_product product WHERE product.id = snapshot.product_id)
         ))
    ),
    issue_method_snapshot = COALESCE(
        (SELECT line.issue_method FROM prod_bom_line line WHERE line.id = snapshot.source_bom_line_id),
        '按单领料'
    );

ALTER TABLE purchase_requisition
    ALTER COLUMN supplier_id DROP NOT NULL,
    ALTER COLUMN status SET DEFAULT 'DRAFT';

-- V110 did not constrain requisition line numbers or quantities.  Refuse
-- ambiguous historical rows with an actionable schema/count before adding the
-- strict A170 checks; backup schemas remain data-only and are not constrained.
DO $$
DECLARE
    target_schema TEXT;
    invalid_count BIGINT;
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
            RAISE EXCEPTION 'V111 requisition validation schema name is unsafe: schema=%', target_schema;
        END IF;
        IF to_regclass(format('%I.purchase_requisition_line', target_schema)) IS NULL THEN
            CONTINUE;
        END IF;
        EXECUTE format(
            'SELECT count(*) FROM %I.purchase_requisition_line WHERE line_no <= 0 OR qty <= 0',
            target_schema
        ) INTO invalid_count;
        IF invalid_count <> 0 THEN
            RAISE EXCEPTION 'V111 invalid purchase requisition lines require repair: schema=% invalid_rows=%',
                target_schema, invalid_count;
        END IF;
    END LOOP;
END $$;

ALTER TABLE purchase_requisition_line
    ADD COLUMN supplier_id UUID REFERENCES md_supplier(id),
    ADD COLUMN supplier_code_snapshot VARCHAR(80),
    ADD COLUMN supplier_name_snapshot VARCHAR(200),
    ADD COLUMN planned_qty NUMERIC(18, 4) NOT NULL DEFAULT 0,
    ADD COLUMN source_task_id UUID REFERENCES production_task(id) ON DELETE SET NULL,
    ADD COLUMN source_level INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN source_bom_code_snapshot VARCHAR(80),
    ADD COLUMN source_bom_version_no INTEGER,
    ADD COLUMN source_bom_line_no INTEGER,
    ADD COLUMN source_bom_path VARCHAR(1000),
    ADD COLUMN updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    ADD CONSTRAINT ck_purchase_requisition_line_no CHECK (line_no > 0),
    ADD CONSTRAINT ck_purchase_requisition_line_qty CHECK (qty > 0),
    ADD CONSTRAINT ck_purchase_requisition_line_planned_qty CHECK (planned_qty >= 0 AND planned_qty <= qty),
    ADD CONSTRAINT ck_purchase_requisition_line_source_level CHECK (source_level >= 0);

UPDATE purchase_requisition_line line
SET supplier_id = requisition.supplier_id,
    supplier_code_snapshot = requisition.supplier_code_snapshot,
    supplier_name_snapshot = requisition.supplier_name_snapshot,
    updated_at = now()
FROM purchase_requisition requisition
WHERE requisition.id = line.requisition_id
  AND line.supplier_id IS NULL;

CREATE TABLE purchase_plan (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    bill_no VARCHAR(80) NOT NULL UNIQUE,
    source_requisition_id UUID NOT NULL REFERENCES purchase_requisition(id),
    source_requisition_no VARCHAR(80) NOT NULL,
    supplier_id UUID NOT NULL REFERENCES md_supplier(id),
    supplier_code_snapshot VARCHAR(80) NOT NULL,
    supplier_name_snapshot VARCHAR(200) NOT NULL,
    bill_date DATE NOT NULL DEFAULT CURRENT_DATE,
    department VARCHAR(120),
    status VARCHAR(40) NOT NULL DEFAULT 'DRAFT',
    owner_name VARCHAR(120),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    version BIGINT NOT NULL DEFAULT 0,
    CONSTRAINT ck_purchase_plan_status CHECK (status IN ('DRAFT', 'AUDITED'))
);

CREATE TABLE purchase_plan_line (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    plan_id UUID NOT NULL REFERENCES purchase_plan(id) ON DELETE CASCADE,
    line_no INTEGER NOT NULL,
    source_requisition_line_id UUID NOT NULL UNIQUE REFERENCES purchase_requisition_line(id),
    source_requisition_no VARCHAR(80) NOT NULL,
    source_requisition_line_no INTEGER NOT NULL,
    product_id UUID NOT NULL REFERENCES md_product(id),
    product_code_snapshot VARCHAR(80) NOT NULL,
    product_name_snapshot VARCHAR(200) NOT NULL,
    product_spec_snapshot VARCHAR(200),
    product_unit_snapshot VARCHAR(40),
    net_weight_snapshot NUMERIC(18, 2),
    gross_weight_snapshot NUMERIC(18, 2),
    warehouse_id UUID REFERENCES md_warehouse(id),
    qty NUMERIC(18, 4) NOT NULL,
    plan_delivery_date DATE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT uq_purchase_plan_line_no UNIQUE (plan_id, line_no),
    CONSTRAINT ck_purchase_plan_line_no CHECK (line_no > 0),
    CONSTRAINT ck_purchase_plan_line_qty CHECK (qty > 0)
);

CREATE INDEX idx_production_task_parent ON production_task (parent_task_id);
CREATE INDEX idx_production_task_root ON production_task (root_task_id, source_level);
CREATE INDEX idx_production_task_plan_source ON production_task (plan_line_id, source_kind);
CREATE INDEX idx_production_task_source_bom_line ON production_task (source_bom_line_id);
CREATE UNIQUE INDEX uq_production_task_parent_bom_line
    ON production_task (parent_task_id, source_bom_line_id)
    WHERE parent_task_id IS NOT NULL AND status <> 'VOID';
CREATE INDEX idx_purchase_requisition_line_supplier ON purchase_requisition_line (supplier_id);
CREATE INDEX idx_purchase_requisition_line_source_task ON purchase_requisition_line (source_task_id);
CREATE INDEX idx_purchase_plan_source ON purchase_plan (source_requisition_id, bill_date DESC);
CREATE INDEX idx_purchase_plan_supplier ON purchase_plan (supplier_id, bill_date DESC);
CREATE INDEX idx_purchase_plan_status ON purchase_plan (status, updated_at DESC);
CREATE INDEX idx_purchase_plan_line_product ON purchase_plan_line (product_id, plan_id, line_no);

INSERT INTO sys_tenant_managed_table (table_name, restore_order)
VALUES
    ('purchase_plan', 565),
    ('purchase_plan_line', 566);

-- Two managed tables add two PKs and three UKs.  Twelve FKs, nine CHECKs and
-- the altered columns must be mirrored into each tenant schema.
DO $$
DECLARE
    sync_definition TEXT;
    evolved_definition TEXT;
BEGIN
    SELECT pg_get_functiondef('public.jdy_sync_tenant_schema_v98(text,boolean)'::regprocedure)
    INTO sync_definition;

    IF sync_definition IS NULL
       OR position('IF managed_count <> 87 THEN' IN sync_definition) = 0
       OR length(sync_definition) - length(replace(sync_definition, 'IF managed_count <> 87 THEN', '')) <> length('IF managed_count <> 87 THEN')
       OR position('tenant managed table catalog drifted: expected=87 actual=%' IN sync_definition) = 0
       OR length(sync_definition) - length(replace(sync_definition, 'tenant managed table catalog drifted: expected=87 actual=%', '')) <> length('tenant managed table catalog drifted: expected=87 actual=%')
       OR position('IF primary_count <> 87 OR unique_count <> 82 OR foreign_key_count <> 187 OR check_count <> 108 THEN' IN sync_definition) = 0
       OR length(sync_definition) - length(replace(sync_definition, 'IF primary_count <> 87 OR unique_count <> 82 OR foreign_key_count <> 187 OR check_count <> 108 THEN', '')) <> length('IF primary_count <> 87 OR unique_count <> 82 OR foreign_key_count <> 187 OR check_count <> 108 THEN')
       OR position('tenant constraint count drifted: schema=% pk=% uk=% fk=% check=% expected=87/82/187/108' IN sync_definition) = 0
       OR length(sync_definition) - length(replace(sync_definition, 'tenant constraint count drifted: schema=% pk=% uk=% fk=% check=% expected=87/82/187/108', '')) <> length('tenant constraint count drifted: schema=% pk=% uk=% fk=% check=% expected=87/82/187/108')
       OR position('RETURN managed_count;' IN sync_definition) = 0
       OR length(sync_definition) - length(replace(sync_definition, 'RETURN managed_count;', '')) <> length('RETURN managed_count;')
       OR length(sync_definition) - length(replace(
           sync_definition,
           $create$'CREATE TABLE %I.%I (LIKE public.%I INCLUDING ALL)'$create$,
           ''
       )) <> length($create$'CREATE TABLE %I.%I (LIKE public.%I INCLUDING ALL)'$create$) THEN
        RAISE EXCEPTION 'V111 refused unexpected tenant sync function topology';
    END IF;

    evolved_definition := replace(sync_definition, 'IF managed_count <> 87 THEN', 'IF managed_count <> 89 THEN');
    evolved_definition := replace(evolved_definition, 'tenant managed table catalog drifted: expected=87 actual=%', 'tenant managed table catalog drifted: expected=89 actual=%');
    evolved_definition := replace(
        evolved_definition,
        'IF primary_count <> 87 OR unique_count <> 82 OR foreign_key_count <> 187 OR check_count <> 108 THEN',
        'IF primary_count <> 89 OR unique_count <> 85 OR foreign_key_count <> 199 OR check_count <> 117 THEN'
    );
    evolved_definition := replace(
        evolved_definition,
        'tenant constraint count drifted: schema=% pk=% uk=% fk=% check=% expected=87/82/187/108',
        'tenant constraint count drifted: schema=% pk=% uk=% fk=% check=% expected=89/85/199/117'
    );
    evolved_definition := replace(
        evolved_definition,
        $create$'CREATE TABLE %I.%I (LIKE public.%I INCLUDING ALL)'$create$,
        $create$CASE
                    WHEN managed.table_name IN ('purchase_plan', 'purchase_plan_line')
                        THEN 'CREATE TABLE %I.%I (LIKE public.%I INCLUDING ALL EXCLUDING INDEXES)'
                    ELSE 'CREATE TABLE %I.%I (LIKE public.%I INCLUDING ALL)'
                END$create$
    );
    evolved_definition := replace(
        evolved_definition,
        'RETURN managed_count;',
        $indexes$
        EXECUTE format('CREATE INDEX IF NOT EXISTS idx_production_task_parent ON %I.production_task (parent_task_id)', tenant_schema);
        EXECUTE format('CREATE INDEX IF NOT EXISTS idx_production_task_root ON %I.production_task (root_task_id, source_level)', tenant_schema);
        EXECUTE format('CREATE INDEX IF NOT EXISTS idx_production_task_plan_source ON %I.production_task (plan_line_id, source_kind)', tenant_schema);
        EXECUTE format('CREATE INDEX IF NOT EXISTS idx_production_task_source_bom_line ON %I.production_task (source_bom_line_id)', tenant_schema);
        EXECUTE format('CREATE UNIQUE INDEX IF NOT EXISTS uq_production_task_parent_bom_line ON %I.production_task (parent_task_id, source_bom_line_id) WHERE parent_task_id IS NOT NULL AND status <> ''VOID''', tenant_schema);
        EXECUTE format('CREATE INDEX IF NOT EXISTS idx_purchase_requisition_line_supplier ON %I.purchase_requisition_line (supplier_id)', tenant_schema);
        EXECUTE format('CREATE INDEX IF NOT EXISTS idx_purchase_requisition_line_source_task ON %I.purchase_requisition_line (source_task_id)', tenant_schema);
        EXECUTE format('CREATE INDEX IF NOT EXISTS idx_purchase_plan_source ON %I.purchase_plan (source_requisition_id, bill_date DESC)', tenant_schema);
        EXECUTE format('CREATE INDEX IF NOT EXISTS idx_purchase_plan_supplier ON %I.purchase_plan (supplier_id, bill_date DESC)', tenant_schema);
        EXECUTE format('CREATE INDEX IF NOT EXISTS idx_purchase_plan_status ON %I.purchase_plan (status, updated_at DESC)', tenant_schema);
        EXECUTE format('CREATE INDEX IF NOT EXISTS idx_purchase_plan_line_product ON %I.purchase_plan_line (product_id, plan_id, line_no)', tenant_schema);
        RETURN managed_count;
$indexes$
    );

    IF evolved_definition = sync_definition
       OR position('expected=87/82/187/108' IN evolved_definition) <> 0
       OR position('expected=89/85/199/117' IN evolved_definition) = 0
       OR position('purchase_plan'', ''purchase_plan_line' IN evolved_definition) = 0
       OR position('INCLUDING ALL EXCLUDING INDEXES' IN evolved_definition) = 0
       OR position('idx_purchase_plan_line_product' IN evolved_definition) = 0 THEN
        RAISE EXCEPTION 'V111 failed to evolve tenant sync function exactly once';
    END IF;
    EXECUTE evolved_definition;
END $$;

-- Historical backups are data-only, but their table/column shape must remain
-- restorable after A170.
DO $$
DECLARE
    target_schema TEXT;
BEGIN
    FOR target_schema IN
        SELECT DISTINCT btrim(backup_schema_name)
        FROM public.sys_account_set_backup
        WHERE nullif(btrim(backup_schema_name), '') IS NOT NULL
        ORDER BY 1
    LOOP
        IF target_schema !~ '^[a-z][a-z0-9_]{0,62}$' THEN
            RAISE EXCEPTION 'V111 backup schema name is unsafe: schema=%', target_schema;
        END IF;
        IF to_regclass(format('%I.purchase_plan', target_schema)) IS NULL THEN
            EXECUTE format('CREATE TABLE %I.purchase_plan AS TABLE public.purchase_plan WITH NO DATA', target_schema);
        END IF;
        IF to_regclass(format('%I.purchase_plan_line', target_schema)) IS NULL THEN
            EXECUTE format('CREATE TABLE %I.purchase_plan_line AS TABLE public.purchase_plan_line WITH NO DATA', target_schema);
        END IF;
        IF to_regclass(format('%I.production_plan_line', target_schema)) IS NOT NULL THEN
            EXECUTE format('ALTER TABLE %I.production_plan_line ADD COLUMN IF NOT EXISTS expand_multilevel_tasks BOOLEAN NOT NULL DEFAULT FALSE', target_schema);
            EXECUTE format('ALTER TABLE %I.production_plan_line ADD COLUMN IF NOT EXISTS generate_purchase_requisition BOOLEAN NOT NULL DEFAULT TRUE', target_schema);
        END IF;
        IF to_regclass(format('%I.production_task', target_schema)) IS NOT NULL THEN
            EXECUTE format('ALTER TABLE %I.production_task ADD COLUMN IF NOT EXISTS source_kind VARCHAR(40)', target_schema);
            EXECUTE format('ALTER TABLE %I.production_task ADD COLUMN IF NOT EXISTS parent_task_id UUID', target_schema);
            EXECUTE format('ALTER TABLE %I.production_task ADD COLUMN IF NOT EXISTS root_task_id UUID', target_schema);
            EXECUTE format('ALTER TABLE %I.production_task ADD COLUMN IF NOT EXISTS source_bom_line_id UUID', target_schema);
            EXECUTE format('ALTER TABLE %I.production_task ADD COLUMN IF NOT EXISTS source_level INTEGER NOT NULL DEFAULT 0', target_schema);
            EXECUTE format('ALTER TABLE %I.production_task ADD COLUMN IF NOT EXISTS bom_path VARCHAR(1000)', target_schema);
            EXECUTE format('UPDATE %1$I.production_task SET source_kind = CASE WHEN plan_id IS NULL THEN ''MANUAL'' ELSE ''PLAN_ROOT'' END, root_task_id = id, bom_path = CASE WHEN plan_line_id IS NULL THEN NULL ELSE ''ROOT'' END WHERE source_kind IS NULL OR root_task_id IS NULL', target_schema);
            EXECUTE format('ALTER TABLE %I.production_task ALTER COLUMN source_kind SET DEFAULT ''MANUAL''', target_schema);
            EXECUTE format('ALTER TABLE %I.production_task ALTER COLUMN source_kind SET NOT NULL', target_schema);
        END IF;
        IF to_regclass(format('%I.production_task_material_snapshot', target_schema)) IS NOT NULL THEN
            EXECUTE format('ALTER TABLE %I.production_task_material_snapshot ADD COLUMN IF NOT EXISTS issue_warehouse_id UUID', target_schema);
            EXECUTE format('ALTER TABLE %I.production_task_material_snapshot ADD COLUMN IF NOT EXISTS issue_warehouse_code_snapshot VARCHAR(80)', target_schema);
            EXECUTE format('ALTER TABLE %I.production_task_material_snapshot ADD COLUMN IF NOT EXISTS issue_method_snapshot VARCHAR(40)', target_schema);
            EXECUTE format($sql$
                UPDATE %1$I.production_task_material_snapshot snapshot
                SET issue_warehouse_id = COALESCE(
                        (SELECT line.issue_warehouse_id FROM %1$I.prod_bom_line line WHERE line.id = snapshot.source_bom_line_id),
                        (SELECT product.default_warehouse_id FROM %1$I.md_product product WHERE product.id = snapshot.product_id)
                    ),
                    issue_warehouse_code_snapshot = COALESCE(
                        (SELECT line.issue_warehouse_code FROM %1$I.prod_bom_line line WHERE line.id = snapshot.source_bom_line_id),
                        (SELECT warehouse.code
                         FROM %1$I.md_warehouse warehouse
                         WHERE warehouse.id = COALESCE(
                             (SELECT line.issue_warehouse_id FROM %1$I.prod_bom_line line WHERE line.id = snapshot.source_bom_line_id),
                             (SELECT product.default_warehouse_id FROM %1$I.md_product product WHERE product.id = snapshot.product_id)
                         ))
                    ),
                    issue_method_snapshot = COALESCE(
                        (SELECT line.issue_method FROM %1$I.prod_bom_line line WHERE line.id = snapshot.source_bom_line_id),
                        '按单领料'
                    )
            $sql$, target_schema);
        END IF;
        IF to_regclass(format('%I.purchase_requisition', target_schema)) IS NOT NULL THEN
            EXECUTE format('ALTER TABLE %I.purchase_requisition ALTER COLUMN supplier_id DROP NOT NULL', target_schema);
            EXECUTE format('ALTER TABLE %I.purchase_requisition ALTER COLUMN status SET DEFAULT ''DRAFT''', target_schema);
        END IF;
        IF to_regclass(format('%I.purchase_requisition_line', target_schema)) IS NOT NULL THEN
            EXECUTE format('ALTER TABLE %I.purchase_requisition_line ADD COLUMN IF NOT EXISTS supplier_id UUID', target_schema);
            EXECUTE format('ALTER TABLE %I.purchase_requisition_line ADD COLUMN IF NOT EXISTS supplier_code_snapshot VARCHAR(80)', target_schema);
            EXECUTE format('ALTER TABLE %I.purchase_requisition_line ADD COLUMN IF NOT EXISTS supplier_name_snapshot VARCHAR(200)', target_schema);
            EXECUTE format('ALTER TABLE %I.purchase_requisition_line ADD COLUMN IF NOT EXISTS planned_qty NUMERIC(18, 4) NOT NULL DEFAULT 0', target_schema);
            EXECUTE format('ALTER TABLE %I.purchase_requisition_line ADD COLUMN IF NOT EXISTS source_task_id UUID', target_schema);
            EXECUTE format('ALTER TABLE %I.purchase_requisition_line ADD COLUMN IF NOT EXISTS source_level INTEGER NOT NULL DEFAULT 0', target_schema);
            EXECUTE format('ALTER TABLE %I.purchase_requisition_line ADD COLUMN IF NOT EXISTS source_bom_code_snapshot VARCHAR(80)', target_schema);
            EXECUTE format('ALTER TABLE %I.purchase_requisition_line ADD COLUMN IF NOT EXISTS source_bom_version_no INTEGER', target_schema);
            EXECUTE format('ALTER TABLE %I.purchase_requisition_line ADD COLUMN IF NOT EXISTS source_bom_line_no INTEGER', target_schema);
            EXECUTE format('ALTER TABLE %I.purchase_requisition_line ADD COLUMN IF NOT EXISTS source_bom_path VARCHAR(1000)', target_schema);
            EXECUTE format('ALTER TABLE %I.purchase_requisition_line ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now()', target_schema);
            EXECUTE format($sql$
                UPDATE %1$I.purchase_requisition_line line
                SET supplier_id = requisition.supplier_id,
                    supplier_code_snapshot = requisition.supplier_code_snapshot,
                    supplier_name_snapshot = requisition.supplier_name_snapshot
                FROM %1$I.purchase_requisition requisition
                WHERE requisition.id = line.requisition_id
                  AND line.supplier_id IS NULL
            $sql$, target_schema);
        END IF;
    END LOOP;
END $$;

-- Existing live tenants receive both new tables before the strict sync runs;
-- the sync function then mirrors all A170 columns and constraints exactly.
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
            RAISE EXCEPTION 'V111 tenant schema name is unsafe: schema=%', target_schema;
        END IF;
        IF to_regclass(format('%I.purchase_plan', target_schema)) IS NULL THEN
            EXECUTE format('CREATE TABLE %I.purchase_plan (LIKE public.purchase_plan INCLUDING ALL EXCLUDING INDEXES)', target_schema);
        END IF;
        IF to_regclass(format('%I.purchase_plan_line', target_schema)) IS NULL THEN
            EXECUTE format('CREATE TABLE %I.purchase_plan_line (LIKE public.purchase_plan_line INCLUDING ALL EXCLUDING INDEXES)', target_schema);
        END IF;

        PERFORM public.jdy_sync_tenant_schema(target_schema, FALSE);

        EXECUTE format($sql$
            UPDATE %1$I.production_task
            SET source_kind = CASE WHEN plan_id IS NULL THEN 'MANUAL' ELSE 'PLAN_ROOT' END,
                root_task_id = id,
                bom_path = CASE WHEN plan_line_id IS NULL THEN NULL ELSE 'ROOT' END
            WHERE root_task_id IS NULL
               OR source_kind IS NULL
        $sql$, target_schema);

        EXECUTE format($sql$
            UPDATE %1$I.production_task_material_snapshot snapshot
            SET issue_warehouse_id = COALESCE(
                    (SELECT line.issue_warehouse_id FROM %1$I.prod_bom_line line WHERE line.id = snapshot.source_bom_line_id),
                    (SELECT product.default_warehouse_id FROM %1$I.md_product product WHERE product.id = snapshot.product_id)
                ),
                issue_warehouse_code_snapshot = COALESCE(
                    (SELECT line.issue_warehouse_code FROM %1$I.prod_bom_line line WHERE line.id = snapshot.source_bom_line_id),
                    (SELECT warehouse.code
                     FROM %1$I.md_warehouse warehouse
                     WHERE warehouse.id = COALESCE(
                         (SELECT line.issue_warehouse_id FROM %1$I.prod_bom_line line WHERE line.id = snapshot.source_bom_line_id),
                         (SELECT product.default_warehouse_id FROM %1$I.md_product product WHERE product.id = snapshot.product_id)
                     ))
                ),
                issue_method_snapshot = COALESCE(
                    (SELECT line.issue_method FROM %1$I.prod_bom_line line WHERE line.id = snapshot.source_bom_line_id),
                    '按单领料'
                )
        $sql$, target_schema);

        EXECUTE format($sql$
            UPDATE %1$I.purchase_requisition_line line
            SET supplier_id = requisition.supplier_id,
                supplier_code_snapshot = requisition.supplier_code_snapshot,
                supplier_name_snapshot = requisition.supplier_name_snapshot,
                updated_at = now()
            FROM %1$I.purchase_requisition requisition
            WHERE requisition.id = line.requisition_id
              AND line.supplier_id IS NULL
        $sql$, target_schema);
    END LOOP;
END $$;

DO $$
DECLARE
    managed_count INTEGER;
    primary_count INTEGER;
    unique_count INTEGER;
    foreign_key_count INTEGER;
    check_count INTEGER;
BEGIN
    SELECT count(*)::INTEGER INTO managed_count FROM public.sys_tenant_managed_table;
    SELECT count(*) FILTER (WHERE c.contype = 'p')::INTEGER,
           count(*) FILTER (WHERE c.contype = 'u')::INTEGER,
           count(*) FILTER (WHERE c.contype = 'f')::INTEGER,
           count(*) FILTER (WHERE c.contype = 'c')::INTEGER
    INTO primary_count, unique_count, foreign_key_count, check_count
    FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace AND n.nspname = 'public'
    JOIN public.sys_tenant_managed_table m ON m.table_name = t.relname;

    IF managed_count <> 89
       OR primary_count <> 89
       OR unique_count <> 85
       OR foreign_key_count <> 203
       OR check_count <> 117 THEN
        RAISE EXCEPTION 'V111 managed topology drifted: expected=89/89/85/203/117';
    END IF;
END $$;
