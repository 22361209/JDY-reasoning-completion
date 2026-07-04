ALTER TABLE prod_bom
    ADD COLUMN IF NOT EXISTS updated_by UUID;

CREATE INDEX IF NOT EXISTS idx_prod_bom_updated_by
    ON prod_bom (updated_by);
