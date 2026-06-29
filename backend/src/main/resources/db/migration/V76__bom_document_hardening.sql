ALTER TABLE prod_bom
    ADD COLUMN IF NOT EXISTS audit_status VARCHAR(40) NOT NULL DEFAULT 'AUDITED',
    ADD COLUMN IF NOT EXISTS bom_category VARCHAR(120),
    ADD COLUMN IF NOT EXISTS remark TEXT;

UPDATE prod_bom
SET audit_status = 'AUDITED'
WHERE audit_status IS NULL OR audit_status = '';

ALTER TABLE prod_bom_line
    ADD COLUMN IF NOT EXISTS product_qty NUMERIC(18, 4) NOT NULL DEFAULT 1,
    ADD COLUMN IF NOT EXISTS material_qty NUMERIC(18, 4),
    ADD COLUMN IF NOT EXISTS unit_qty NUMERIC(18, 4),
    ADD COLUMN IF NOT EXISTS issue_method VARCHAR(40) NOT NULL DEFAULT '按单领料',
    ADD COLUMN IF NOT EXISTS issue_warehouse_id UUID REFERENCES md_warehouse(id),
    ADD COLUMN IF NOT EXISTS issue_warehouse_code VARCHAR(80),
    ADD COLUMN IF NOT EXISTS fixed_loss_qty NUMERIC(18, 4) NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS loss_rate NUMERIC(9, 4) NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS child_bom_id UUID REFERENCES prod_bom(id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS child_bom_code_snapshot VARCHAR(80),
    ADD COLUMN IF NOT EXISTS child_bom_version_no INTEGER;

UPDATE prod_bom_line
SET material_qty = COALESCE(material_qty, qty),
    unit_qty = COALESCE(unit_qty, qty),
    product_qty = COALESCE(NULLIF(product_qty, 0), 1)
WHERE material_qty IS NULL
   OR unit_qty IS NULL
   OR product_qty IS NULL
   OR product_qty = 0;

UPDATE prod_bom_line line
SET issue_warehouse_id = COALESCE(line.issue_warehouse_id, product.default_warehouse_id),
    issue_warehouse_code = COALESCE(NULLIF(line.issue_warehouse_code, ''), product.default_warehouse_code)
FROM md_product product
WHERE product.id = line.material_id;

CREATE INDEX IF NOT EXISTS idx_prod_bom_audit_current
    ON prod_bom (audit_status, enabled, is_current);

CREATE INDEX IF NOT EXISTS idx_prod_bom_line_material
    ON prod_bom_line (material_id, bom_id);
