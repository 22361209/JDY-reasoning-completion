ALTER TABLE sales_order
    ADD COLUMN IF NOT EXISTS is_tax_inclusive BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE sales_out
    ADD COLUMN IF NOT EXISTS is_tax_inclusive BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE purchase_order
    ADD COLUMN IF NOT EXISTS is_tax_inclusive BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE purchase_in
    ADD COLUMN IF NOT EXISTS is_tax_inclusive BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE sales_order_line
    ADD COLUMN IF NOT EXISTS tax_rate NUMERIC(9, 4) NOT NULL DEFAULT 13,
    ADD COLUMN IF NOT EXISTS tax_amount NUMERIC(18, 2) NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS price_tax_total NUMERIC(18, 2) NOT NULL DEFAULT 0;

ALTER TABLE sales_out_line
    ADD COLUMN IF NOT EXISTS tax_rate NUMERIC(9, 4) NOT NULL DEFAULT 13,
    ADD COLUMN IF NOT EXISTS tax_amount NUMERIC(18, 2) NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS price_tax_total NUMERIC(18, 2) NOT NULL DEFAULT 0;

ALTER TABLE purchase_order_line
    ADD COLUMN IF NOT EXISTS tax_rate NUMERIC(9, 4) NOT NULL DEFAULT 13,
    ADD COLUMN IF NOT EXISTS tax_amount NUMERIC(18, 2) NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS price_tax_total NUMERIC(18, 2) NOT NULL DEFAULT 0;

ALTER TABLE purchase_in_line
    ADD COLUMN IF NOT EXISTS tax_rate NUMERIC(9, 4) NOT NULL DEFAULT 13,
    ADD COLUMN IF NOT EXISTS tax_amount NUMERIC(18, 2) NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS price_tax_total NUMERIC(18, 2) NOT NULL DEFAULT 0;

UPDATE sales_order_line
SET tax_amount = round(amount * tax_rate / 100, 2),
    price_tax_total = amount + round(amount * tax_rate / 100, 2)
WHERE price_tax_total = 0 AND amount <> 0;

UPDATE sales_out_line
SET tax_amount = round(amount * tax_rate / 100, 2),
    price_tax_total = amount + round(amount * tax_rate / 100, 2)
WHERE price_tax_total = 0 AND amount <> 0;

UPDATE purchase_order_line
SET tax_amount = round(amount * tax_rate / 100, 2),
    price_tax_total = amount + round(amount * tax_rate / 100, 2)
WHERE price_tax_total = 0 AND amount <> 0;

UPDATE purchase_in_line
SET tax_amount = round(amount * tax_rate / 100, 2),
    price_tax_total = amount + round(amount * tax_rate / 100, 2)
WHERE price_tax_total = 0 AND amount <> 0;

UPDATE sales_order so
SET total_amount = COALESCE((
    SELECT SUM(price_tax_total)
    FROM sales_order_line l
    WHERE l.order_id = so.id
), 0);

UPDATE sales_out so
SET total_amount = COALESCE((
    SELECT SUM(price_tax_total)
    FROM sales_out_line l
    WHERE l.bill_id = so.id
), 0);

UPDATE purchase_order po
SET total_amount = COALESCE((
    SELECT SUM(price_tax_total)
    FROM purchase_order_line l
    WHERE l.order_id = po.id
), 0);

UPDATE purchase_in pi
SET total_amount = COALESCE((
    SELECT SUM(price_tax_total)
    FROM purchase_in_line l
    WHERE l.bill_id = pi.id
), 0);
