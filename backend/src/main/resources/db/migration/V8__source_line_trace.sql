ALTER TABLE sales_out_line
    ADD COLUMN IF NOT EXISTS source_line_no INTEGER;

ALTER TABLE purchase_in_line
    ADD COLUMN IF NOT EXISTS source_line_no INTEGER;

UPDATE sales_out_line
SET source_line_no = line_no
WHERE source_line_no IS NULL;

UPDATE purchase_in_line
SET source_line_no = line_no
WHERE source_line_no IS NULL;
