ALTER TABLE prod_bom
    ADD COLUMN IF NOT EXISTS version_no INTEGER NOT NULL DEFAULT 1,
    ADD COLUMN IF NOT EXISTS is_current BOOLEAN NOT NULL DEFAULT TRUE,
    ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now();

WITH ranked AS (
    SELECT id,
           ROW_NUMBER() OVER (PARTITION BY product_id ORDER BY created_at DESC, code DESC) AS current_rank,
           ROW_NUMBER() OVER (PARTITION BY product_id ORDER BY created_at ASC, code ASC) AS version_rank
    FROM prod_bom
)
UPDATE prod_bom bom
SET version_no = ranked.version_rank,
    is_current = ranked.current_rank = 1,
    enabled = ranked.current_rank = 1,
    updated_at = now()
FROM ranked
WHERE ranked.id = bom.id;

CREATE UNIQUE INDEX IF NOT EXISTS uq_prod_bom_current_product
    ON prod_bom (product_id)
    WHERE enabled = TRUE AND is_current = TRUE;

ALTER TABLE production_plan
    ADD COLUMN IF NOT EXISTS bom_code_snapshot VARCHAR(80),
    ADD COLUMN IF NOT EXISTS bom_version_no INTEGER,
    ADD COLUMN IF NOT EXISTS plan_delivery_date DATE,
    ADD COLUMN IF NOT EXISTS in_progress_qty NUMERIC(18, 4) NOT NULL DEFAULT 0;

UPDATE production_plan plan
SET bom_code_snapshot = COALESCE(plan.bom_code_snapshot, bom.code),
    bom_version_no = COALESCE(plan.bom_version_no, bom.version_no)
FROM prod_bom bom
WHERE bom.id = plan.bom_id;

ALTER TABLE production_task
    ADD COLUMN IF NOT EXISTS department_code VARCHAR(80),
    ADD COLUMN IF NOT EXISTS bom_code_snapshot VARCHAR(80),
    ADD COLUMN IF NOT EXISTS bom_version_no INTEGER;

UPDATE production_task task
SET department_code = COALESCE(task.department_code, (
        SELECT plan.department_code
        FROM production_plan plan
        WHERE plan.id = task.plan_id
    )),
    bom_code_snapshot = COALESCE(task.bom_code_snapshot, bom.code),
    bom_version_no = COALESCE(task.bom_version_no, bom.version_no)
FROM prod_bom bom
WHERE bom.id = task.bom_id;

ALTER TABLE production_task_material_snapshot
    ADD COLUMN IF NOT EXISTS bom_code_snapshot VARCHAR(80),
    ADD COLUMN IF NOT EXISTS bom_version_no INTEGER;

UPDATE production_task_material_snapshot snapshot
SET bom_code_snapshot = COALESCE(snapshot.bom_code_snapshot, task.bom_code_snapshot, bom.code),
    bom_version_no = COALESCE(snapshot.bom_version_no, task.bom_version_no, bom.version_no)
FROM production_task task
JOIN prod_bom bom ON bom.id = task.bom_id
WHERE task.id = snapshot.task_id;

CREATE TABLE IF NOT EXISTS purchase_requisition (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    bill_no VARCHAR(80) NOT NULL UNIQUE,
    source_plan_id UUID REFERENCES production_plan(id),
    source_plan_no VARCHAR(80),
    supplier_id UUID NOT NULL REFERENCES md_supplier(id),
    supplier_code_snapshot VARCHAR(80),
    supplier_name_snapshot VARCHAR(200),
    bill_date DATE NOT NULL DEFAULT CURRENT_DATE,
    department VARCHAR(120),
    status VARCHAR(40) NOT NULL DEFAULT 'AUDITED',
    total_amount NUMERIC(18, 2) NOT NULL DEFAULT 0,
    owner_name VARCHAR(120),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    version BIGINT NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS purchase_requisition_line (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    requisition_id UUID NOT NULL REFERENCES purchase_requisition(id) ON DELETE CASCADE,
    line_no INTEGER NOT NULL,
    source_plan_id UUID REFERENCES production_plan(id),
    source_plan_no VARCHAR(80),
    source_bom_line_id UUID REFERENCES prod_bom_line(id) ON DELETE SET NULL,
    product_id UUID NOT NULL REFERENCES md_product(id),
    product_code_snapshot VARCHAR(80),
    product_name_snapshot VARCHAR(200),
    product_spec_snapshot VARCHAR(200),
    product_unit_snapshot VARCHAR(40),
    net_weight_snapshot NUMERIC(18, 2),
    gross_weight_snapshot NUMERIC(18, 2),
    supplier_material_code VARCHAR(120),
    warehouse_id UUID REFERENCES md_warehouse(id),
    qty NUMERIC(18, 4) NOT NULL,
    ordered_qty NUMERIC(18, 4) NOT NULL DEFAULT 0,
    plan_delivery_date DATE,
    line_close_status VARCHAR(40) NOT NULL DEFAULT 'OPEN',
    line_frozen_status VARCHAR(40) NOT NULL DEFAULT 'NORMAL',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT uq_purchase_requisition_line_no UNIQUE (requisition_id, line_no)
);

ALTER TABLE purchase_order_line
    ADD COLUMN IF NOT EXISTS source_requisition_no VARCHAR(80),
    ADD COLUMN IF NOT EXISTS source_requisition_line_no INTEGER;

CREATE INDEX IF NOT EXISTS idx_purchase_requisition_status_created
    ON purchase_requisition (status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_purchase_requisition_supplier
    ON purchase_requisition (supplier_id, bill_date DESC);

CREATE INDEX IF NOT EXISTS idx_purchase_requisition_line_source
    ON purchase_requisition_line (source_plan_no, source_bom_line_id);
