ALTER TABLE sales_order
    ADD COLUMN IF NOT EXISTS close_mode VARCHAR(40);

CREATE INDEX IF NOT EXISTS idx_sales_order_close_mode
    ON sales_order (close_status, close_mode);
