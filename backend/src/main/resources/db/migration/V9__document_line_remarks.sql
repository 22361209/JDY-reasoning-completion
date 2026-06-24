ALTER TABLE sales_order_line
    ADD COLUMN IF NOT EXISTS line_remark VARCHAR(200);

ALTER TABLE purchase_order_line
    ADD COLUMN IF NOT EXISTS line_remark VARCHAR(200);

ALTER TABLE sales_out_line
    ADD COLUMN IF NOT EXISTS line_remark VARCHAR(200);

ALTER TABLE purchase_in_line
    ADD COLUMN IF NOT EXISTS line_remark VARCHAR(200);
