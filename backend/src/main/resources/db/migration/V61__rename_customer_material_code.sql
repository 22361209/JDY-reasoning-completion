ALTER TABLE sales_quote_line
    RENAME COLUMN customer_order_no TO customer_material_code;

ALTER TABLE sales_order_line
    RENAME COLUMN customer_order_no TO customer_material_code;

ALTER TABLE delivery_notice_line
    RENAME COLUMN customer_order_no TO customer_material_code;

ALTER TABLE sales_out_line
    RENAME COLUMN customer_order_no TO customer_material_code;
