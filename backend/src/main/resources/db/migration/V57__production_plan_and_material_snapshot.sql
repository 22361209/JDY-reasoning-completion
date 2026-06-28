CREATE TABLE IF NOT EXISTS production_plan (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    bill_no VARCHAR(80) NOT NULL UNIQUE,
    bom_id UUID NOT NULL REFERENCES prod_bom(id),
    product_id UUID NOT NULL REFERENCES md_product(id),
    warehouse_id UUID NOT NULL REFERENCES md_warehouse(id),
    planned_qty NUMERIC(18, 4) NOT NULL,
    source_type VARCHAR(40) NOT NULL DEFAULT 'SELF',
    status VARCHAR(40) NOT NULL DEFAULT 'AUDITED',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE production_task
    ADD COLUMN IF NOT EXISTS plan_id UUID REFERENCES production_plan(id);

CREATE TABLE IF NOT EXISTS production_task_material_snapshot (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    task_id UUID NOT NULL REFERENCES production_task(id) ON DELETE CASCADE,
    line_no INTEGER NOT NULL,
    source_bom_line_id UUID REFERENCES prod_bom_line(id),
    product_id UUID NOT NULL REFERENCES md_product(id),
    unit_qty NUMERIC(18, 4) NOT NULL,
    required_qty NUMERIC(18, 4) NOT NULL,
    issued_qty NUMERIC(18, 4) NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT uq_production_task_material_snapshot_line UNIQUE (task_id, line_no)
);

INSERT INTO production_plan (bill_no, bom_id, product_id, warehouse_id, planned_qty, source_type, status, created_at, updated_at)
SELECT 'SCJH-' || t.bill_no,
       t.bom_id,
       t.product_id,
       t.warehouse_id,
       t.qty,
       'SELF',
       'AUDITED',
       t.created_at,
       t.updated_at
FROM production_task t
WHERE t.plan_id IS NULL
  AND NOT EXISTS (
      SELECT 1
      FROM production_plan p
      WHERE p.bill_no = 'SCJH-' || t.bill_no
  );

UPDATE production_task t
SET plan_id = p.id
FROM production_plan p
WHERE t.plan_id IS NULL
  AND p.bill_no = 'SCJH-' || t.bill_no;

INSERT INTO production_task_material_snapshot (task_id, line_no, source_bom_line_id, product_id, unit_qty, required_qty)
SELECT t.id,
       l.line_no,
       l.id,
       l.material_id,
       l.qty,
       l.qty * t.qty
FROM production_task t
JOIN prod_bom_line l ON l.bom_id = t.bom_id
WHERE NOT EXISTS (
    SELECT 1
    FROM production_task_material_snapshot s
    WHERE s.task_id = t.id
      AND s.line_no = l.line_no
);

ALTER TABLE production_task
    ALTER COLUMN plan_id SET NOT NULL;

CREATE INDEX IF NOT EXISTS idx_production_plan_status_created
    ON production_plan (status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_production_task_plan
    ON production_task (plan_id);

CREATE INDEX IF NOT EXISTS idx_production_task_material_snapshot_task
    ON production_task_material_snapshot (task_id, line_no);
