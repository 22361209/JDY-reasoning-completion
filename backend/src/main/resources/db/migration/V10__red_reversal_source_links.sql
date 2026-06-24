ALTER TABLE sales_out
    ADD COLUMN IF NOT EXISTS red_source_bill_id UUID REFERENCES sales_out(id);

ALTER TABLE purchase_in
    ADD COLUMN IF NOT EXISTS red_source_bill_id UUID REFERENCES purchase_in(id);

UPDATE sales_out red
SET red_source_bill_id = original.id
FROM sales_out original
WHERE red.red_source_bill_id IS NULL
  AND red.status = 'RED_REVERSED'
  AND red.bill_no = concat('HC-', original.bill_no);

UPDATE purchase_in red
SET red_source_bill_id = original.id
FROM purchase_in original
WHERE red.red_source_bill_id IS NULL
  AND red.status = 'RED_REVERSED'
  AND red.bill_no = concat('HC-', original.bill_no);

CREATE INDEX IF NOT EXISTS idx_sales_out_red_source_bill
    ON sales_out (red_source_bill_id);

CREATE INDEX IF NOT EXISTS idx_purchase_in_red_source_bill
    ON purchase_in (red_source_bill_id);
