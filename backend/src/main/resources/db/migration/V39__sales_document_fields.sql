ALTER TABLE sales_order
    ADD COLUMN IF NOT EXISTS remark VARCHAR(500),
    ADD COLUMN IF NOT EXISTS created_by UUID REFERENCES sys_user(id);

ALTER TABLE sales_out
    ADD COLUMN IF NOT EXISTS remark VARCHAR(500),
    ADD COLUMN IF NOT EXISTS created_by UUID REFERENCES sys_user(id);

ALTER TABLE sales_order_line
    ADD COLUMN IF NOT EXISTS plan_delivery_date DATE;

ALTER TABLE sales_out_line
    ADD COLUMN IF NOT EXISTS plan_delivery_date DATE;
