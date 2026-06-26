ALTER TABLE sales_out_line
    ADD COLUMN IF NOT EXISTS source_order_no VARCHAR(64);

ALTER TABLE purchase_in_line
    ADD COLUMN IF NOT EXISTS source_order_no VARCHAR(64);

UPDATE sales_out_line l
SET source_order_no = so_src.bill_no
FROM sales_out so
JOIN sales_order so_src ON so_src.id = so.source_order_id
WHERE l.bill_id = so.id
  AND l.source_order_no IS NULL;

UPDATE purchase_in_line l
SET source_order_no = po.bill_no
FROM purchase_in pi
JOIN purchase_order po ON po.id = pi.source_order_id
WHERE l.bill_id = pi.id
  AND l.source_order_no IS NULL;

CREATE INDEX IF NOT EXISTS idx_sales_out_line_source_order
    ON sales_out_line (source_order_no, source_line_no);

CREATE INDEX IF NOT EXISTS idx_purchase_in_line_source_order
    ON purchase_in_line (source_order_no, source_line_no);
