ALTER TABLE sales_quote_line
    ADD COLUMN IF NOT EXISTS customer_order_no VARCHAR(120);

ALTER TABLE sales_order_line
    ADD COLUMN IF NOT EXISTS customer_order_no VARCHAR(120);

ALTER TABLE delivery_notice_line
    ADD COLUMN IF NOT EXISTS customer_order_no VARCHAR(120);

ALTER TABLE sales_out_line
    ADD COLUMN IF NOT EXISTS customer_order_no VARCHAR(120);
