-- A167: keep production_plan as the formal, uniquely numbered document header
-- and add tenant-managed lines for multiple finished-product models.  Existing
-- single-model plans are backfilled as line 1 without changing business facts.

CREATE TABLE production_plan_line (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    plan_id UUID NOT NULL REFERENCES production_plan(id) ON DELETE CASCADE,
    line_no INTEGER NOT NULL,
    bom_id UUID NOT NULL REFERENCES prod_bom(id),
    product_id UUID NOT NULL REFERENCES md_product(id),
    product_code_snapshot VARCHAR(80) NOT NULL,
    product_name_snapshot VARCHAR(200) NOT NULL,
    product_spec_snapshot VARCHAR(200),
    product_unit_snapshot VARCHAR(40),
    net_weight_snapshot NUMERIC(18, 2),
    gross_weight_snapshot NUMERIC(18, 2),
    warehouse_id UUID NOT NULL REFERENCES md_warehouse(id),
    department_code VARCHAR(80),
    bom_code_snapshot VARCHAR(80) NOT NULL,
    bom_version_no INTEGER NOT NULL,
    planned_qty NUMERIC(18, 4) NOT NULL,
    plan_delivery_date DATE,
    in_progress_qty NUMERIC(18, 4) NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT uq_production_plan_line_no UNIQUE (plan_id, line_no),
    CONSTRAINT ck_production_plan_line_no CHECK (line_no > 0),
    CONSTRAINT ck_production_plan_line_qty CHECK (planned_qty > 0),
    CONSTRAINT ck_production_plan_line_progress CHECK (in_progress_qty >= 0)
);

ALTER TABLE production_task
    ADD COLUMN plan_line_id UUID REFERENCES production_plan_line(id);

ALTER TABLE purchase_requisition_line
    ADD COLUMN source_plan_line_id UUID REFERENCES production_plan_line(id);

ALTER TABLE production_completion
    ADD COLUMN source_issue_id UUID REFERENCES production_material_issue(id);

CREATE INDEX idx_production_plan_line_product
    ON production_plan_line (product_id, plan_id, line_no);
CREATE INDEX idx_production_plan_line_bom
    ON production_plan_line (bom_id, plan_id, line_no);
CREATE INDEX idx_production_task_plan_line
    ON production_task (plan_line_id);
CREATE INDEX idx_purchase_requisition_line_plan_line
    ON purchase_requisition_line (source_plan_line_id);
CREATE INDEX idx_production_completion_source_issue
    ON production_completion (source_issue_id);

INSERT INTO sys_tenant_managed_table (table_name, restore_order)
VALUES ('production_plan_line', 485);

INSERT INTO production_plan_line (
    plan_id, line_no, bom_id, product_id, product_code_snapshot,
    product_name_snapshot, product_spec_snapshot, product_unit_snapshot,
    net_weight_snapshot, gross_weight_snapshot, warehouse_id,
    department_code, bom_code_snapshot, bom_version_no, planned_qty,
    plan_delivery_date, in_progress_qty, created_at, updated_at
)
SELECT plan.id,
       1,
       plan.bom_id,
       plan.product_id,
       COALESCE(plan.product_code_snapshot, product.code),
       COALESCE(plan.product_name_snapshot, product.name),
       COALESCE(plan.product_spec_snapshot, product.spec),
       COALESCE(plan.product_unit_snapshot, product.unit),
       COALESCE(plan.net_weight_snapshot, product.net_weight),
       COALESCE(plan.gross_weight_snapshot, product.gross_weight),
       plan.warehouse_id,
       plan.department_code,
       COALESCE(plan.bom_code_snapshot, bom.code),
       COALESCE(plan.bom_version_no, bom.version_no),
       plan.planned_qty,
       plan.plan_delivery_date,
       COALESCE(plan.in_progress_qty, 0),
       plan.created_at,
       plan.updated_at
FROM production_plan plan
JOIN md_product product ON product.id = plan.product_id
JOIN prod_bom bom ON bom.id = plan.bom_id;

UPDATE production_task task
SET plan_line_id = line.id
FROM production_plan_line line
WHERE task.plan_id = line.plan_id
  AND line.line_no = 1
  AND task.plan_line_id IS NULL;

UPDATE purchase_requisition_line requisition_line
SET source_plan_line_id = line.id
FROM production_plan_line line
WHERE requisition_line.source_plan_id = line.plan_id
  AND line.line_no = 1
  AND requisition_line.source_plan_line_id IS NULL;

-- One managed table adds one PK, one UK, four table-local FKs and three CHECKs;
-- the two source-line columns and receipt-to-issue trace add three further FKs
-- on existing managed tables.
DO $$
DECLARE
    sync_definition TEXT;
    evolved_definition TEXT;
BEGIN
    SELECT pg_get_functiondef('public.jdy_sync_tenant_schema_v98(text,boolean)'::regprocedure)
    INTO sync_definition;

    IF sync_definition IS NULL
       OR position('IF managed_count <> 86 THEN' IN sync_definition) = 0
       OR position('tenant managed table catalog drifted: expected=86 actual=%' IN sync_definition) = 0
       OR position('IF primary_count <> 86 OR unique_count <> 81 OR foreign_key_count <> 180 OR check_count <> 105 THEN' IN sync_definition) = 0
       OR position('tenant constraint count drifted: schema=% pk=% uk=% fk=% check=% expected=86/81/180/105' IN sync_definition) = 0
       OR position('RETURN managed_count;' IN sync_definition) = 0 THEN
        RAISE EXCEPTION 'V110 refused unexpected tenant sync function topology';
    END IF;

    evolved_definition := replace(sync_definition, 'IF managed_count <> 86 THEN', 'IF managed_count <> 87 THEN');
    evolved_definition := replace(evolved_definition, 'tenant managed table catalog drifted: expected=86 actual=%', 'tenant managed table catalog drifted: expected=87 actual=%');
    evolved_definition := replace(
        evolved_definition,
        'IF primary_count <> 86 OR unique_count <> 81 OR foreign_key_count <> 180 OR check_count <> 105 THEN',
        'IF primary_count <> 87 OR unique_count <> 82 OR foreign_key_count <> 187 OR check_count <> 108 THEN'
    );
    evolved_definition := replace(
        evolved_definition,
        'tenant constraint count drifted: schema=% pk=% uk=% fk=% check=% expected=86/81/180/105',
        'tenant constraint count drifted: schema=% pk=% uk=% fk=% check=% expected=87/82/187/108'
    );
    evolved_definition := replace(
        evolved_definition,
        'RETURN managed_count;',
        $indexes$
        EXECUTE format('CREATE INDEX IF NOT EXISTS idx_production_plan_line_product ON %I.production_plan_line (product_id, plan_id, line_no)', tenant_schema);
        EXECUTE format('CREATE INDEX IF NOT EXISTS idx_production_plan_line_bom ON %I.production_plan_line (bom_id, plan_id, line_no)', tenant_schema);
        EXECUTE format('CREATE INDEX IF NOT EXISTS idx_production_task_plan_line ON %I.production_task (plan_line_id)', tenant_schema);
        EXECUTE format('CREATE INDEX IF NOT EXISTS idx_purchase_requisition_line_plan_line ON %I.purchase_requisition_line (source_plan_line_id)', tenant_schema);
        EXECUTE format('CREATE INDEX IF NOT EXISTS idx_production_completion_source_issue ON %I.production_completion (source_issue_id)', tenant_schema);
        RETURN managed_count;
$indexes$
    );

    IF evolved_definition = sync_definition
       OR position('expected=86/81/180/105' IN evolved_definition) <> 0
       OR position('expected=87/82/187/108' IN evolved_definition) = 0
       OR position('idx_production_plan_line_product' IN evolved_definition) = 0 THEN
        RAISE EXCEPTION 'V110 failed to evolve tenant sync function exactly once';
    END IF;
    EXECUTE evolved_definition;
END $$;

-- Historical backups remain data-only but must retain the complete managed
-- table shape for restore planning.
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
            RAISE EXCEPTION 'V110 backup schema name is unsafe: schema=%', target_schema;
        END IF;
        IF to_regclass(format('%I.production_plan_line', target_schema)) IS NULL THEN
            EXECUTE format('CREATE TABLE %I.production_plan_line AS TABLE public.production_plan_line WITH NO DATA', target_schema);
        END IF;
        IF to_regclass(format('%I.production_task', target_schema)) IS NOT NULL THEN
            EXECUTE format('ALTER TABLE %I.production_task ADD COLUMN IF NOT EXISTS plan_line_id UUID', target_schema);
        END IF;
        IF to_regclass(format('%I.purchase_requisition_line', target_schema)) IS NOT NULL THEN
            EXECUTE format('ALTER TABLE %I.purchase_requisition_line ADD COLUMN IF NOT EXISTS source_plan_line_id UUID', target_schema);
        END IF;
        IF to_regclass(format('%I.production_completion', target_schema)) IS NOT NULL THEN
            EXECUTE format('ALTER TABLE %I.production_completion ADD COLUMN IF NOT EXISTS source_issue_id UUID', target_schema);
        END IF;
        IF to_regclass(format('%I.production_plan', target_schema)) IS NOT NULL
           AND to_regclass(format('%I.md_product', target_schema)) IS NOT NULL
           AND to_regclass(format('%I.prod_bom', target_schema)) IS NOT NULL THEN
            EXECUTE format($sql$
                INSERT INTO %1$I.production_plan_line (
                    id, plan_id, line_no, bom_id, product_id, product_code_snapshot,
                    product_name_snapshot, product_spec_snapshot, product_unit_snapshot,
                    net_weight_snapshot, gross_weight_snapshot, warehouse_id,
                    department_code, bom_code_snapshot, bom_version_no, planned_qty,
                    plan_delivery_date, in_progress_qty, created_at, updated_at
                )
                SELECT gen_random_uuid(), plan.id, 1, plan.bom_id, plan.product_id,
                       COALESCE(plan.product_code_snapshot, product.code),
                       COALESCE(plan.product_name_snapshot, product.name),
                       COALESCE(plan.product_spec_snapshot, product.spec),
                       COALESCE(plan.product_unit_snapshot, product.unit),
                       COALESCE(plan.net_weight_snapshot, product.net_weight),
                       COALESCE(plan.gross_weight_snapshot, product.gross_weight),
                       plan.warehouse_id, plan.department_code,
                       COALESCE(plan.bom_code_snapshot, bom.code),
                       COALESCE(plan.bom_version_no, bom.version_no),
                       plan.planned_qty, plan.plan_delivery_date,
                       COALESCE(plan.in_progress_qty, 0), plan.created_at, plan.updated_at
                FROM %1$I.production_plan plan
                JOIN %1$I.md_product product ON product.id = plan.product_id
                JOIN %1$I.prod_bom bom ON bom.id = plan.bom_id
                WHERE NOT EXISTS (
                    SELECT 1
                    FROM %1$I.production_plan_line existing
                    WHERE existing.plan_id = plan.id
                      AND existing.line_no = 1
                )
            $sql$, target_schema);
        END IF;
        IF to_regclass(format('%I.production_task', target_schema)) IS NOT NULL THEN
            EXECUTE format($sql$
                UPDATE %1$I.production_task task
                SET plan_line_id = line.id
                FROM %1$I.production_plan_line line
                WHERE task.plan_id = line.plan_id
                  AND line.line_no = 1
                  AND task.plan_line_id IS NULL
            $sql$, target_schema);
        END IF;
        IF to_regclass(format('%I.purchase_requisition_line', target_schema)) IS NOT NULL THEN
            EXECUTE format($sql$
                UPDATE %1$I.purchase_requisition_line requisition_line
                SET source_plan_line_id = line.id
                FROM %1$I.production_plan_line line
                WHERE requisition_line.source_plan_id = line.plan_id
                  AND line.line_no = 1
                  AND requisition_line.source_plan_line_id IS NULL
            $sql$, target_schema);
        END IF;
    END LOOP;
END $$;

-- Existing live tenants receive the line table and exact constraints/indexes,
-- then their historical single-model plans are backfilled as line 1.
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
            RAISE EXCEPTION 'V110 tenant schema name is unsafe: schema=%', target_schema;
        END IF;
        IF to_regclass(format('%I.production_plan_line', target_schema)) IS NULL THEN
            EXECUTE format('CREATE TABLE %I.production_plan_line (LIKE public.production_plan_line INCLUDING ALL)', target_schema);
        END IF;
        PERFORM public.jdy_sync_tenant_schema(target_schema, FALSE);

        EXECUTE format($sql$
            INSERT INTO %1$I.production_plan_line (
                plan_id, line_no, bom_id, product_id, product_code_snapshot,
                product_name_snapshot, product_spec_snapshot, product_unit_snapshot,
                net_weight_snapshot, gross_weight_snapshot, warehouse_id,
                department_code, bom_code_snapshot, bom_version_no, planned_qty,
                plan_delivery_date, in_progress_qty, created_at, updated_at
            )
            SELECT plan.id, 1, plan.bom_id, plan.product_id,
                   COALESCE(plan.product_code_snapshot, product.code),
                   COALESCE(plan.product_name_snapshot, product.name),
                   COALESCE(plan.product_spec_snapshot, product.spec),
                   COALESCE(plan.product_unit_snapshot, product.unit),
                   COALESCE(plan.net_weight_snapshot, product.net_weight),
                   COALESCE(plan.gross_weight_snapshot, product.gross_weight),
                   plan.warehouse_id, plan.department_code,
                   COALESCE(plan.bom_code_snapshot, bom.code),
                   COALESCE(plan.bom_version_no, bom.version_no),
                   plan.planned_qty, plan.plan_delivery_date,
                   COALESCE(plan.in_progress_qty, 0), plan.created_at, plan.updated_at
            FROM %1$I.production_plan plan
            JOIN %1$I.md_product product ON product.id = plan.product_id
            JOIN %1$I.prod_bom bom ON bom.id = plan.bom_id
            ON CONFLICT (plan_id, line_no) DO NOTHING
        $sql$, target_schema);

        EXECUTE format($sql$
            UPDATE %1$I.production_task task
            SET plan_line_id = line.id
            FROM %1$I.production_plan_line line
            WHERE task.plan_id = line.plan_id
              AND line.line_no = 1
              AND task.plan_line_id IS NULL
        $sql$, target_schema);

        EXECUTE format($sql$
            UPDATE %1$I.purchase_requisition_line requisition_line
            SET source_plan_line_id = line.id
            FROM %1$I.production_plan_line line
            WHERE requisition_line.source_plan_id = line.plan_id
              AND line.line_no = 1
              AND requisition_line.source_plan_line_id IS NULL
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

    IF managed_count <> 87
       OR primary_count <> 87
       OR unique_count <> 82
       OR foreign_key_count <> 191
       OR check_count <> 108 THEN
        RAISE EXCEPTION 'V110 managed topology drifted: expected=87/87/82/191/108';
    END IF;
END $$;
