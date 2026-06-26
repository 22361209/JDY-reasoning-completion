ALTER TABLE md_product
    ADD COLUMN IF NOT EXISTS default_sale_price NUMERIC(18, 6);

UPDATE md_product
SET default_sale_price = CASE code
    WHEN 'CP-001' THEN 86.000000
    WHEN 'PJ-014' THEN 12.000000
    ELSE default_sale_price
END
WHERE default_sale_price IS NULL
  AND code IN ('CP-001', 'PJ-014');
