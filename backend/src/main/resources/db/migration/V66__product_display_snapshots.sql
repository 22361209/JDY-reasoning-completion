ALTER TABLE sales_quote_line
    ADD COLUMN IF NOT EXISTS product_code_snapshot VARCHAR(80),
    ADD COLUMN IF NOT EXISTS product_name_snapshot VARCHAR(200),
    ADD COLUMN IF NOT EXISTS product_spec_snapshot VARCHAR(200);

ALTER TABLE sales_order_line
    ADD COLUMN IF NOT EXISTS product_code_snapshot VARCHAR(80),
    ADD COLUMN IF NOT EXISTS product_name_snapshot VARCHAR(200),
    ADD COLUMN IF NOT EXISTS product_spec_snapshot VARCHAR(200);

ALTER TABLE delivery_notice_line
    ADD COLUMN IF NOT EXISTS product_code_snapshot VARCHAR(80),
    ADD COLUMN IF NOT EXISTS product_name_snapshot VARCHAR(200),
    ADD COLUMN IF NOT EXISTS product_spec_snapshot VARCHAR(200);

ALTER TABLE sales_out_line
    ADD COLUMN IF NOT EXISTS product_code_snapshot VARCHAR(80),
    ADD COLUMN IF NOT EXISTS product_name_snapshot VARCHAR(200),
    ADD COLUMN IF NOT EXISTS product_spec_snapshot VARCHAR(200);

ALTER TABLE purchase_order_line
    ADD COLUMN IF NOT EXISTS product_code_snapshot VARCHAR(80),
    ADD COLUMN IF NOT EXISTS product_name_snapshot VARCHAR(200),
    ADD COLUMN IF NOT EXISTS product_spec_snapshot VARCHAR(200);

ALTER TABLE purchase_in_line
    ADD COLUMN IF NOT EXISTS product_code_snapshot VARCHAR(80),
    ADD COLUMN IF NOT EXISTS product_name_snapshot VARCHAR(200),
    ADD COLUMN IF NOT EXISTS product_spec_snapshot VARCHAR(200);

ALTER TABLE purchase_return_line
    ADD COLUMN IF NOT EXISTS product_code_snapshot VARCHAR(80),
    ADD COLUMN IF NOT EXISTS product_name_snapshot VARCHAR(200),
    ADD COLUMN IF NOT EXISTS product_spec_snapshot VARCHAR(200);

ALTER TABLE other_stock_in_line
    ADD COLUMN IF NOT EXISTS product_code_snapshot VARCHAR(80),
    ADD COLUMN IF NOT EXISTS product_name_snapshot VARCHAR(200),
    ADD COLUMN IF NOT EXISTS product_spec_snapshot VARCHAR(200);

ALTER TABLE other_stock_out_line
    ADD COLUMN IF NOT EXISTS product_code_snapshot VARCHAR(80),
    ADD COLUMN IF NOT EXISTS product_name_snapshot VARCHAR(200),
    ADD COLUMN IF NOT EXISTS product_spec_snapshot VARCHAR(200);

ALTER TABLE stock_transfer_line
    ADD COLUMN IF NOT EXISTS product_code_snapshot VARCHAR(80),
    ADD COLUMN IF NOT EXISTS product_name_snapshot VARCHAR(200),
    ADD COLUMN IF NOT EXISTS product_spec_snapshot VARCHAR(200);

ALTER TABLE stock_count_line
    ADD COLUMN IF NOT EXISTS product_code_snapshot VARCHAR(80),
    ADD COLUMN IF NOT EXISTS product_name_snapshot VARCHAR(200),
    ADD COLUMN IF NOT EXISTS product_spec_snapshot VARCHAR(200);

ALTER TABLE stock_count_gain_line
    ADD COLUMN IF NOT EXISTS product_code_snapshot VARCHAR(80),
    ADD COLUMN IF NOT EXISTS product_name_snapshot VARCHAR(200),
    ADD COLUMN IF NOT EXISTS product_spec_snapshot VARCHAR(200);

ALTER TABLE stock_count_loss_line
    ADD COLUMN IF NOT EXISTS product_code_snapshot VARCHAR(80),
    ADD COLUMN IF NOT EXISTS product_name_snapshot VARCHAR(200),
    ADD COLUMN IF NOT EXISTS product_spec_snapshot VARCHAR(200);

ALTER TABLE production_plan
    ADD COLUMN IF NOT EXISTS product_code_snapshot VARCHAR(80),
    ADD COLUMN IF NOT EXISTS product_name_snapshot VARCHAR(200),
    ADD COLUMN IF NOT EXISTS product_spec_snapshot VARCHAR(200);

ALTER TABLE production_task
    ADD COLUMN IF NOT EXISTS product_code_snapshot VARCHAR(80),
    ADD COLUMN IF NOT EXISTS product_name_snapshot VARCHAR(200),
    ADD COLUMN IF NOT EXISTS product_spec_snapshot VARCHAR(200);

ALTER TABLE production_task_material_snapshot
    ADD COLUMN IF NOT EXISTS product_code_snapshot VARCHAR(80),
    ADD COLUMN IF NOT EXISTS product_name_snapshot VARCHAR(200),
    ADD COLUMN IF NOT EXISTS product_spec_snapshot VARCHAR(200);

ALTER TABLE production_material_issue_line
    ADD COLUMN IF NOT EXISTS product_code_snapshot VARCHAR(80),
    ADD COLUMN IF NOT EXISTS product_name_snapshot VARCHAR(200),
    ADD COLUMN IF NOT EXISTS product_spec_snapshot VARCHAR(200);

ALTER TABLE production_completion_line
    ADD COLUMN IF NOT EXISTS product_code_snapshot VARCHAR(80),
    ADD COLUMN IF NOT EXISTS product_name_snapshot VARCHAR(200),
    ADD COLUMN IF NOT EXISTS product_spec_snapshot VARCHAR(200);

UPDATE sales_quote_line l
SET product_code_snapshot = COALESCE(NULLIF(l.product_code_snapshot, ''), p.code),
    product_name_snapshot = COALESCE(NULLIF(l.product_name_snapshot, ''), p.name),
    product_spec_snapshot = COALESCE(l.product_spec_snapshot, p.spec)
FROM md_product p
WHERE p.id = l.product_id;

UPDATE sales_order_line l
SET product_code_snapshot = COALESCE(NULLIF(l.product_code_snapshot, ''), p.code),
    product_name_snapshot = COALESCE(NULLIF(l.product_name_snapshot, ''), p.name),
    product_spec_snapshot = COALESCE(l.product_spec_snapshot, p.spec)
FROM md_product p
WHERE p.id = l.product_id;

UPDATE delivery_notice_line l
SET product_code_snapshot = COALESCE(NULLIF(l.product_code_snapshot, ''), p.code),
    product_name_snapshot = COALESCE(NULLIF(l.product_name_snapshot, ''), p.name),
    product_spec_snapshot = COALESCE(l.product_spec_snapshot, p.spec)
FROM md_product p
WHERE p.id = l.product_id;

UPDATE sales_out_line l
SET product_code_snapshot = COALESCE(NULLIF(l.product_code_snapshot, ''), p.code),
    product_name_snapshot = COALESCE(NULLIF(l.product_name_snapshot, ''), p.name),
    product_spec_snapshot = COALESCE(l.product_spec_snapshot, p.spec)
FROM md_product p
WHERE p.id = l.product_id;

UPDATE purchase_order_line l
SET product_code_snapshot = COALESCE(NULLIF(l.product_code_snapshot, ''), p.code),
    product_name_snapshot = COALESCE(NULLIF(l.product_name_snapshot, ''), p.name),
    product_spec_snapshot = COALESCE(l.product_spec_snapshot, p.spec)
FROM md_product p
WHERE p.id = l.product_id;

UPDATE purchase_in_line l
SET product_code_snapshot = COALESCE(NULLIF(l.product_code_snapshot, ''), p.code),
    product_name_snapshot = COALESCE(NULLIF(l.product_name_snapshot, ''), p.name),
    product_spec_snapshot = COALESCE(l.product_spec_snapshot, p.spec)
FROM md_product p
WHERE p.id = l.product_id;

UPDATE purchase_return_line l
SET product_code_snapshot = COALESCE(NULLIF(l.product_code_snapshot, ''), p.code),
    product_name_snapshot = COALESCE(NULLIF(l.product_name_snapshot, ''), p.name),
    product_spec_snapshot = COALESCE(l.product_spec_snapshot, p.spec)
FROM md_product p
WHERE p.id = l.product_id;

UPDATE other_stock_in_line l
SET product_code_snapshot = COALESCE(NULLIF(l.product_code_snapshot, ''), p.code),
    product_name_snapshot = COALESCE(NULLIF(l.product_name_snapshot, ''), p.name),
    product_spec_snapshot = COALESCE(l.product_spec_snapshot, p.spec)
FROM md_product p
WHERE p.id = l.product_id;

UPDATE other_stock_out_line l
SET product_code_snapshot = COALESCE(NULLIF(l.product_code_snapshot, ''), p.code),
    product_name_snapshot = COALESCE(NULLIF(l.product_name_snapshot, ''), p.name),
    product_spec_snapshot = COALESCE(l.product_spec_snapshot, p.spec)
FROM md_product p
WHERE p.id = l.product_id;

UPDATE stock_transfer_line l
SET product_code_snapshot = COALESCE(NULLIF(l.product_code_snapshot, ''), p.code),
    product_name_snapshot = COALESCE(NULLIF(l.product_name_snapshot, ''), p.name),
    product_spec_snapshot = COALESCE(l.product_spec_snapshot, p.spec)
FROM md_product p
WHERE p.id = l.product_id;

UPDATE stock_count_line l
SET product_code_snapshot = COALESCE(NULLIF(l.product_code_snapshot, ''), p.code),
    product_name_snapshot = COALESCE(NULLIF(l.product_name_snapshot, ''), p.name),
    product_spec_snapshot = COALESCE(l.product_spec_snapshot, p.spec)
FROM md_product p
WHERE p.id = l.product_id;

UPDATE stock_count_gain_line l
SET product_code_snapshot = COALESCE(NULLIF(l.product_code_snapshot, ''), p.code),
    product_name_snapshot = COALESCE(NULLIF(l.product_name_snapshot, ''), p.name),
    product_spec_snapshot = COALESCE(l.product_spec_snapshot, p.spec)
FROM md_product p
WHERE p.id = l.product_id;

UPDATE stock_count_loss_line l
SET product_code_snapshot = COALESCE(NULLIF(l.product_code_snapshot, ''), p.code),
    product_name_snapshot = COALESCE(NULLIF(l.product_name_snapshot, ''), p.name),
    product_spec_snapshot = COALESCE(l.product_spec_snapshot, p.spec)
FROM md_product p
WHERE p.id = l.product_id;

UPDATE production_plan l
SET product_code_snapshot = COALESCE(NULLIF(l.product_code_snapshot, ''), p.code),
    product_name_snapshot = COALESCE(NULLIF(l.product_name_snapshot, ''), p.name),
    product_spec_snapshot = COALESCE(l.product_spec_snapshot, p.spec)
FROM md_product p
WHERE p.id = l.product_id;

UPDATE production_task l
SET product_code_snapshot = COALESCE(NULLIF(l.product_code_snapshot, ''), p.code),
    product_name_snapshot = COALESCE(NULLIF(l.product_name_snapshot, ''), p.name),
    product_spec_snapshot = COALESCE(l.product_spec_snapshot, p.spec)
FROM md_product p
WHERE p.id = l.product_id;

UPDATE production_task_material_snapshot l
SET product_code_snapshot = COALESCE(NULLIF(l.product_code_snapshot, ''), p.code),
    product_name_snapshot = COALESCE(NULLIF(l.product_name_snapshot, ''), p.name),
    product_spec_snapshot = COALESCE(l.product_spec_snapshot, p.spec)
FROM md_product p
WHERE p.id = l.product_id;

UPDATE production_material_issue_line l
SET product_code_snapshot = COALESCE(NULLIF(l.product_code_snapshot, ''), p.code),
    product_name_snapshot = COALESCE(NULLIF(l.product_name_snapshot, ''), p.name),
    product_spec_snapshot = COALESCE(l.product_spec_snapshot, p.spec)
FROM md_product p
WHERE p.id = l.product_id;

UPDATE production_completion_line l
SET product_code_snapshot = COALESCE(NULLIF(l.product_code_snapshot, ''), p.code),
    product_name_snapshot = COALESCE(NULLIF(l.product_name_snapshot, ''), p.name),
    product_spec_snapshot = COALESCE(l.product_spec_snapshot, p.spec)
FROM md_product p
WHERE p.id = l.product_id;
