ALTER TABLE prod_bom
    DROP CONSTRAINT IF EXISTS prod_bom_code_key;

CREATE UNIQUE INDEX IF NOT EXISTS uq_prod_bom_product_version
    ON prod_bom (product_id, version_no);

CREATE UNIQUE INDEX IF NOT EXISTS uq_prod_bom_current_code
    ON prod_bom (code)
    WHERE enabled = TRUE AND is_current = TRUE;
