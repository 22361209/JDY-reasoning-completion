ALTER TABLE sales_quote_line
    ADD COLUMN IF NOT EXISTS customer_order_no VARCHAR(120);

ALTER TABLE sales_order_line
    ADD COLUMN IF NOT EXISTS customer_order_no VARCHAR(120);

ALTER TABLE delivery_notice_line
    ADD COLUMN IF NOT EXISTS customer_order_no VARCHAR(120);

ALTER TABLE sales_out_line
    ADD COLUMN IF NOT EXISTS customer_order_no VARCHAR(120);

CREATE TABLE IF NOT EXISTS md_product_partner_code (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    product_id UUID NOT NULL REFERENCES md_product(id),
    partner_type VARCHAR(20) NOT NULL,
    customer_id UUID REFERENCES md_customer(id),
    supplier_id UUID REFERENCES md_supplier(id),
    partner_product_code VARCHAR(120) NOT NULL,
    partner_product_name VARCHAR(240),
    enabled BOOLEAN NOT NULL DEFAULT TRUE,
    remark TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT ck_product_partner_type CHECK (partner_type IN ('CUSTOMER', 'SUPPLIER')),
    CONSTRAINT ck_product_partner_owner CHECK (
        (partner_type = 'CUSTOMER' AND customer_id IS NOT NULL AND supplier_id IS NULL)
        OR (partner_type = 'SUPPLIER' AND supplier_id IS NOT NULL AND customer_id IS NULL)
    )
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_product_partner_code_customer
    ON md_product_partner_code (product_id, customer_id, partner_product_code)
    WHERE partner_type = 'CUSTOMER' AND enabled = TRUE;

CREATE UNIQUE INDEX IF NOT EXISTS uq_product_partner_code_supplier
    ON md_product_partner_code (product_id, supplier_id, partner_product_code)
    WHERE partner_type = 'SUPPLIER' AND enabled = TRUE;
