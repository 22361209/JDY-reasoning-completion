UPDATE sales_quote_line
SET tax_amount = CASE
        WHEN tax_amount = 0 THEN round(amount * tax_rate / 100, 2)
        ELSE tax_amount
    END,
    price_tax_total = amount + CASE
        WHEN tax_amount = 0 THEN round(amount * tax_rate / 100, 2)
        ELSE tax_amount
    END
WHERE amount <> 0
  AND price_tax_total = 0;

UPDATE sales_order_line
SET tax_amount = CASE
        WHEN tax_amount = 0 THEN round(amount * tax_rate / 100, 2)
        ELSE tax_amount
    END,
    price_tax_total = amount + CASE
        WHEN tax_amount = 0 THEN round(amount * tax_rate / 100, 2)
        ELSE tax_amount
    END
WHERE amount <> 0
  AND price_tax_total = 0;

UPDATE delivery_notice_line
SET tax_amount = CASE
        WHEN tax_amount = 0 THEN round(amount * tax_rate / 100, 2)
        ELSE tax_amount
    END,
    price_tax_total = amount + CASE
        WHEN tax_amount = 0 THEN round(amount * tax_rate / 100, 2)
        ELSE tax_amount
    END
WHERE amount <> 0
  AND price_tax_total = 0;

UPDATE sales_out_line
SET tax_amount = CASE
        WHEN tax_amount = 0 THEN round(amount * tax_rate / 100, 2)
        ELSE tax_amount
    END,
    price_tax_total = amount + CASE
        WHEN tax_amount = 0 THEN round(amount * tax_rate / 100, 2)
        ELSE tax_amount
    END
WHERE amount <> 0
  AND price_tax_total = 0;

UPDATE purchase_order_line
SET tax_amount = CASE
        WHEN tax_amount = 0 THEN round(amount * tax_rate / 100, 2)
        ELSE tax_amount
    END,
    price_tax_total = amount + CASE
        WHEN tax_amount = 0 THEN round(amount * tax_rate / 100, 2)
        ELSE tax_amount
    END
WHERE amount <> 0
  AND price_tax_total = 0;

UPDATE purchase_in_line
SET tax_amount = CASE
        WHEN tax_amount = 0 THEN round(amount * tax_rate / 100, 2)
        ELSE tax_amount
    END,
    price_tax_total = amount + CASE
        WHEN tax_amount = 0 THEN round(amount * tax_rate / 100, 2)
        ELSE tax_amount
    END
WHERE amount <> 0
  AND price_tax_total = 0;

UPDATE sales_quote sq
SET total_amount = COALESCE((
    SELECT SUM(price_tax_total)
    FROM sales_quote_line l
    WHERE l.quote_id = sq.id
), 0);

UPDATE sales_order so
SET total_amount = COALESCE((
    SELECT SUM(price_tax_total)
    FROM sales_order_line l
    WHERE l.order_id = so.id
), 0);

UPDATE delivery_notice dn
SET total_amount = COALESCE((
    SELECT SUM(price_tax_total)
    FROM delivery_notice_line l
    WHERE l.bill_id = dn.id
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
