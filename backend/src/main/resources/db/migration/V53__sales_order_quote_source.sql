ALTER TABLE sales_order_line
    ADD COLUMN IF NOT EXISTS source_order_no VARCHAR(80),
    ADD COLUMN IF NOT EXISTS source_line_no INTEGER;

CREATE INDEX IF NOT EXISTS idx_sales_order_line_source_order
    ON sales_order_line (source_order_no, source_line_no);
