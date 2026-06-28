CREATE SEQUENCE IF NOT EXISTS md_product_system_no_seq START WITH 100000001;
CREATE SEQUENCE IF NOT EXISTS md_customer_system_no_seq START WITH 200000001;
CREATE SEQUENCE IF NOT EXISTS md_supplier_system_no_seq START WITH 300000001;
CREATE SEQUENCE IF NOT EXISTS md_warehouse_system_no_seq START WITH 400000001;

ALTER TABLE md_product ADD COLUMN IF NOT EXISTS system_no BIGINT;
ALTER TABLE md_customer ADD COLUMN IF NOT EXISTS system_no BIGINT;
ALTER TABLE md_supplier ADD COLUMN IF NOT EXISTS system_no BIGINT;
ALTER TABLE md_warehouse ADD COLUMN IF NOT EXISTS system_no BIGINT;

WITH ranked AS (
    SELECT id, 100000000 + row_number() OVER (ORDER BY code) AS generated_no
    FROM md_product
    WHERE system_no IS NULL
)
UPDATE md_product target
SET system_no = ranked.generated_no
FROM ranked
WHERE target.id = ranked.id;

WITH ranked AS (
    SELECT id, 200000000 + row_number() OVER (ORDER BY code) AS generated_no
    FROM md_customer
    WHERE system_no IS NULL
)
UPDATE md_customer target
SET system_no = ranked.generated_no
FROM ranked
WHERE target.id = ranked.id;

WITH ranked AS (
    SELECT id, 300000000 + row_number() OVER (ORDER BY code) AS generated_no
    FROM md_supplier
    WHERE system_no IS NULL
)
UPDATE md_supplier target
SET system_no = ranked.generated_no
FROM ranked
WHERE target.id = ranked.id;

WITH ranked AS (
    SELECT id, 400000000 + row_number() OVER (ORDER BY code) AS generated_no
    FROM md_warehouse
    WHERE system_no IS NULL
)
UPDATE md_warehouse target
SET system_no = ranked.generated_no
FROM ranked
WHERE target.id = ranked.id;

SELECT setval('md_product_system_no_seq', GREATEST((SELECT COALESCE(MAX(system_no), 100000000) FROM md_product), 100000000), TRUE);
SELECT setval('md_customer_system_no_seq', GREATEST((SELECT COALESCE(MAX(system_no), 200000000) FROM md_customer), 200000000), TRUE);
SELECT setval('md_supplier_system_no_seq', GREATEST((SELECT COALESCE(MAX(system_no), 300000000) FROM md_supplier), 300000000), TRUE);
SELECT setval('md_warehouse_system_no_seq', GREATEST((SELECT COALESCE(MAX(system_no), 400000000) FROM md_warehouse), 400000000), TRUE);

ALTER TABLE md_product ALTER COLUMN system_no SET DEFAULT nextval('md_product_system_no_seq');
ALTER TABLE md_customer ALTER COLUMN system_no SET DEFAULT nextval('md_customer_system_no_seq');
ALTER TABLE md_supplier ALTER COLUMN system_no SET DEFAULT nextval('md_supplier_system_no_seq');
ALTER TABLE md_warehouse ALTER COLUMN system_no SET DEFAULT nextval('md_warehouse_system_no_seq');

ALTER TABLE md_product ALTER COLUMN system_no SET NOT NULL;
ALTER TABLE md_customer ALTER COLUMN system_no SET NOT NULL;
ALTER TABLE md_supplier ALTER COLUMN system_no SET NOT NULL;
ALTER TABLE md_warehouse ALTER COLUMN system_no SET NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_md_product_system_no ON md_product (system_no);
CREATE UNIQUE INDEX IF NOT EXISTS uq_md_customer_system_no ON md_customer (system_no);
CREATE UNIQUE INDEX IF NOT EXISTS uq_md_supplier_system_no ON md_supplier (system_no);
CREATE UNIQUE INDEX IF NOT EXISTS uq_md_warehouse_system_no ON md_warehouse (system_no);
