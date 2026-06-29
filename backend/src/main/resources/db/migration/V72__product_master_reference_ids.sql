ALTER TABLE md_product
    ADD COLUMN IF NOT EXISTS product_category_id UUID,
    ADD COLUMN IF NOT EXISTS unit_id UUID,
    ADD COLUMN IF NOT EXISTS default_warehouse_id UUID,
    ADD COLUMN IF NOT EXISTS default_supplier_id UUID,
    ADD COLUMN IF NOT EXISTS default_workshop_id UUID;

INSERT INTO md_product_category (code, name, sort_no, enabled, audit_status)
SELECT 'CAT-' || lpad(row_number() OVER (ORDER BY source.category)::text, 4, '0'),
       source.category,
       1900 + row_number() OVER (ORDER BY source.category),
       TRUE,
       'AUDITED'
FROM (
    SELECT DISTINCT trim(category) AS category
    FROM md_product
    WHERE trim(COALESCE(category, '')) <> ''
) source
WHERE NOT EXISTS (
    SELECT 1
    FROM md_product_category existing
    WHERE existing.code = source.category OR existing.name = source.category
)
ON CONFLICT DO NOTHING;

INSERT INTO md_unit (code, name, decimal_places, sort_no, enabled, audit_status)
SELECT source.unit_code,
       source.unit_code,
       0,
       1900 + row_number() OVER (ORDER BY source.unit_code),
       TRUE,
       'AUDITED'
FROM (
    SELECT DISTINCT trim(unit) AS unit_code
    FROM md_product
    WHERE trim(COALESCE(unit, '')) <> ''
) source
WHERE NOT EXISTS (
    SELECT 1
    FROM md_unit existing
    WHERE existing.code = source.unit_code OR existing.name = source.unit_code
)
ON CONFLICT DO NOTHING;

UPDATE md_product product
SET product_category_id = category.id,
    category = category.name
FROM md_product_category category
WHERE product.product_category_id IS NULL
  AND (category.code = product.category OR category.name = product.category);

UPDATE md_product product
SET unit_id = unit.id,
    unit = unit.code
FROM md_unit unit
WHERE product.unit_id IS NULL
  AND (unit.code = product.unit OR unit.name = product.unit);

UPDATE md_product product
SET default_warehouse_id = warehouse.id,
    default_warehouse_code = warehouse.code
FROM md_warehouse warehouse
WHERE product.default_warehouse_id IS NULL
  AND trim(COALESCE(product.default_warehouse_code, '')) <> ''
  AND (warehouse.code = product.default_warehouse_code OR warehouse.name = product.default_warehouse_code);

UPDATE md_product product
SET default_supplier_id = supplier.id,
    default_supplier_code = supplier.code
FROM md_supplier supplier
WHERE product.default_supplier_id IS NULL
  AND trim(COALESCE(product.default_supplier_code, '')) <> ''
  AND (supplier.code = product.default_supplier_code OR supplier.name = product.default_supplier_code);

UPDATE md_product product
SET default_workshop_id = department.id,
    default_workshop = department.name
FROM md_production_department department
WHERE product.default_workshop_id IS NULL
  AND trim(COALESCE(product.default_workshop, '')) <> ''
  AND (department.code = product.default_workshop OR department.name = product.default_workshop);

ALTER TABLE md_product ALTER COLUMN product_category_id SET NOT NULL;
ALTER TABLE md_product ALTER COLUMN unit_id SET NOT NULL;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'fk_md_product_category_ref'
    ) THEN
        ALTER TABLE md_product
            ADD CONSTRAINT fk_md_product_category_ref
            FOREIGN KEY (product_category_id) REFERENCES md_product_category(id);
    END IF;
END $$;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'fk_md_product_unit_ref'
    ) THEN
        ALTER TABLE md_product
            ADD CONSTRAINT fk_md_product_unit_ref
            FOREIGN KEY (unit_id) REFERENCES md_unit(id);
    END IF;
END $$;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'fk_md_product_default_warehouse_ref'
    ) THEN
        ALTER TABLE md_product
            ADD CONSTRAINT fk_md_product_default_warehouse_ref
            FOREIGN KEY (default_warehouse_id) REFERENCES md_warehouse(id);
    END IF;
END $$;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'fk_md_product_default_supplier_ref'
    ) THEN
        ALTER TABLE md_product
            ADD CONSTRAINT fk_md_product_default_supplier_ref
            FOREIGN KEY (default_supplier_id) REFERENCES md_supplier(id);
    END IF;
END $$;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'fk_md_product_default_workshop_ref'
    ) THEN
        ALTER TABLE md_product
            ADD CONSTRAINT fk_md_product_default_workshop_ref
            FOREIGN KEY (default_workshop_id) REFERENCES md_production_department(id);
    END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_md_product_category_id ON md_product (product_category_id);
CREATE INDEX IF NOT EXISTS idx_md_product_unit_id ON md_product (unit_id);
CREATE INDEX IF NOT EXISTS idx_md_product_default_warehouse_id ON md_product (default_warehouse_id);
CREATE INDEX IF NOT EXISTS idx_md_product_default_supplier_id ON md_product (default_supplier_id);
CREATE INDEX IF NOT EXISTS idx_md_product_default_workshop_id ON md_product (default_workshop_id);
