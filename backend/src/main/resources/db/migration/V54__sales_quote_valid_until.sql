ALTER TABLE sales_quote
    ADD COLUMN IF NOT EXISTS valid_until DATE;

UPDATE sales_quote
SET valid_until = COALESCE(valid_until, bill_date + 30)
WHERE valid_until IS NULL;

ALTER TABLE sales_quote
    ALTER COLUMN valid_until SET NOT NULL;

CREATE INDEX IF NOT EXISTS idx_sales_quote_valid_until
    ON sales_quote (valid_until);
