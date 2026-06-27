CREATE TABLE IF NOT EXISTS sales_quote (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    bill_no VARCHAR(80) NOT NULL UNIQUE,
    customer_id UUID NOT NULL REFERENCES md_customer(id),
    bill_date DATE NOT NULL,
    department VARCHAR(120),
    status VARCHAR(40) NOT NULL DEFAULT 'DRAFT',
    enabled BOOLEAN NOT NULL DEFAULT TRUE,
    total_amount NUMERIC(18, 2) NOT NULL DEFAULT 0,
    is_tax_inclusive BOOLEAN NOT NULL DEFAULT FALSE,
    owner_name VARCHAR(120),
    remark VARCHAR(500),
    created_by UUID REFERENCES sys_user(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    version BIGINT NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS sales_quote_line (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    quote_id UUID NOT NULL REFERENCES sales_quote(id) ON DELETE CASCADE,
    line_no INTEGER NOT NULL,
    product_id UUID NOT NULL REFERENCES md_product(id),
    warehouse_id UUID REFERENCES md_warehouse(id),
    qty NUMERIC(18, 4),
    unit_price NUMERIC(18, 2) NOT NULL,
    amount NUMERIC(18, 2) NOT NULL DEFAULT 0,
    tax_rate NUMERIC(8, 4) NOT NULL DEFAULT 13,
    tax_amount NUMERIC(18, 2) NOT NULL DEFAULT 0,
    price_tax_total NUMERIC(18, 2) NOT NULL DEFAULT 0,
    line_remark VARCHAR(500),
    plan_delivery_date DATE,
    CONSTRAINT uq_sales_quote_line_no UNIQUE (quote_id, line_no)
);

CREATE INDEX IF NOT EXISTS idx_sales_quote_customer_date
    ON sales_quote (customer_id, bill_date DESC, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_sales_quote_line_product
    ON sales_quote_line (product_id);
