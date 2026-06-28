ALTER TABLE purchase_order_line
    ADD COLUMN IF NOT EXISTS supplier_material_code VARCHAR(120) NOT NULL DEFAULT '',
    ADD COLUMN IF NOT EXISTS plan_delivery_date DATE;
