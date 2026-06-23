CREATE TABLE IF NOT EXISTS sales_order (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    bill_no VARCHAR(80) NOT NULL UNIQUE,
    customer_id UUID NOT NULL REFERENCES md_customer(id),
    bill_date DATE NOT NULL,
    department VARCHAR(120),
    status VARCHAR(40) NOT NULL DEFAULT 'DRAFT',
    total_amount NUMERIC(18, 2) NOT NULL DEFAULT 0,
    owner_name VARCHAR(120),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    version BIGINT NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS sales_order_line (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    order_id UUID NOT NULL REFERENCES sales_order(id) ON DELETE CASCADE,
    line_no INTEGER NOT NULL,
    product_id UUID NOT NULL REFERENCES md_product(id),
    warehouse_id UUID REFERENCES md_warehouse(id),
    qty NUMERIC(18, 4) NOT NULL,
    unit_price NUMERIC(18, 2) NOT NULL,
    amount NUMERIC(18, 2) NOT NULL,
    CONSTRAINT uq_sales_order_line_no UNIQUE (order_id, line_no)
);

CREATE INDEX IF NOT EXISTS idx_sales_order_customer_date
    ON sales_order (customer_id, bill_date DESC);
