CREATE TABLE IF NOT EXISTS md_product_category (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    code VARCHAR(80) NOT NULL UNIQUE,
    name VARCHAR(120) NOT NULL UNIQUE,
    parent_code VARCHAR(80),
    sort_no INTEGER NOT NULL DEFAULT 0,
    remark TEXT,
    enabled BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMP NOT NULL DEFAULT now(),
    updated_at TIMESTAMP NOT NULL DEFAULT now(),
    version BIGINT NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS md_unit (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    code VARCHAR(80) NOT NULL UNIQUE,
    name VARCHAR(120) NOT NULL UNIQUE,
    decimal_places INTEGER NOT NULL DEFAULT 0,
    sort_no INTEGER NOT NULL DEFAULT 0,
    remark TEXT,
    enabled BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMP NOT NULL DEFAULT now(),
    updated_at TIMESTAMP NOT NULL DEFAULT now(),
    version BIGINT NOT NULL DEFAULT 0
);

ALTER TABLE md_product
    ADD COLUMN IF NOT EXISTS oe_no VARCHAR(120),
    ADD COLUMN IF NOT EXISTS position_name VARCHAR(120),
    ADD COLUMN IF NOT EXISTS surface_treatment VARCHAR(120),
    ADD COLUMN IF NOT EXISTS min_stock_qty NUMERIC(18, 4),
    ADD COLUMN IF NOT EXISTS safety_stock_qty NUMERIC(18, 4),
    ADD COLUMN IF NOT EXISTS max_stock_qty NUMERIC(18, 4),
    ADD COLUMN IF NOT EXISTS purchase_price NUMERIC(18, 6),
    ADD COLUMN IF NOT EXISTS max_purchase_price NUMERIC(18, 6),
    ADD COLUMN IF NOT EXISTS subcontract_price NUMERIC(18, 6),
    ADD COLUMN IF NOT EXISTS wholesale_price NUMERIC(18, 6),
    ADD COLUMN IF NOT EXISTS retail_price NUMERIC(18, 6);

INSERT INTO md_product_category (code, name, sort_no)
VALUES
    ('CPZC', '成品总成', 10),
    ('YCL', '原材料', 20),
    ('ZZBCP', '自制半成品', 30),
    ('WWBCP', '委外半成品', 40),
    ('CPCL', '冲压材料', 50),
    ('WLRQ', '物料容器', 60),
    ('ZJ', '支架', 70),
    ('ZPGJ', '装配管件', 80),
    ('BB', '摆臂', 90),
    ('CT', '衬套', 100),
    ('QT', '球头', 110),
    ('BZJ', '标准件', 120),
    ('BZFL', '包装辅料', 130),
    ('FL', '辅料', 140)
ON CONFLICT (code) DO UPDATE
SET name = EXCLUDED.name,
    sort_no = EXCLUDED.sort_no,
    updated_at = now();

INSERT INTO md_product_category (code, name, sort_no)
SELECT 'CAT-' || lpad(row_number() OVER (ORDER BY source.category)::text, 4, '0'),
       source.category,
       900 + row_number() OVER (ORDER BY source.category)
FROM (
    SELECT DISTINCT trim(category) AS category
    FROM md_product
    WHERE trim(COALESCE(category, '')) <> ''
) source
WHERE NOT EXISTS (
    SELECT 1 FROM md_product_category existing WHERE existing.name = source.category
)
ON CONFLICT DO NOTHING;

INSERT INTO md_unit (code, name, decimal_places, sort_no)
SELECT unit_code, unit_code, decimal_places, sort_no
FROM (
    VALUES
        ('PCS', 0, 10),
        ('只', 0, 20),
        ('件', 0, 30),
        ('套', 0, 40),
        ('个', 0, 50),
        ('条', 2, 60),
        ('箱', 0, 70),
        ('KGS', 3, 80),
        ('kg', 3, 90),
        ('米', 2, 100)
) AS seed(unit_code, decimal_places, sort_no)
ON CONFLICT (code) DO UPDATE
SET decimal_places = EXCLUDED.decimal_places,
    sort_no = EXCLUDED.sort_no,
    updated_at = now();

INSERT INTO md_unit (code, name, decimal_places, sort_no)
SELECT source.unit_code,
       source.unit_code,
       0,
       900 + row_number() OVER (ORDER BY source.unit_code)
FROM (
    SELECT DISTINCT trim(unit) AS unit_code
    FROM md_product
    WHERE trim(COALESCE(unit, '')) <> ''
) source
WHERE NOT EXISTS (
    SELECT 1 FROM md_unit existing WHERE existing.code = source.unit_code
)
ON CONFLICT DO NOTHING;
