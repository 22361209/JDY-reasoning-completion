ALTER TABLE sales_quote DROP COLUMN IF EXISTS is_tax_inclusive;
ALTER TABLE sales_order DROP COLUMN IF EXISTS is_tax_inclusive;
ALTER TABLE delivery_notice DROP COLUMN IF EXISTS is_tax_inclusive;
ALTER TABLE sales_out DROP COLUMN IF EXISTS is_tax_inclusive;
ALTER TABLE purchase_order DROP COLUMN IF EXISTS is_tax_inclusive;
ALTER TABLE purchase_in DROP COLUMN IF EXISTS is_tax_inclusive;
ALTER TABLE purchase_return DROP COLUMN IF EXISTS is_tax_inclusive;
