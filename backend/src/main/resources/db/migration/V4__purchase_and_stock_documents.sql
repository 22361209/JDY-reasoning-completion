ALTER TABLE sales_order
    ADD COLUMN IF NOT EXISTS out_status VARCHAR(40) NOT NULL DEFAULT 'NOT_OUT';

CREATE TABLE IF NOT EXISTS purchase_order (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    bill_no VARCHAR(80) NOT NULL UNIQUE,
    supplier_id UUID NOT NULL REFERENCES md_supplier(id),
    bill_date DATE NOT NULL,
    department VARCHAR(120),
    status VARCHAR(40) NOT NULL DEFAULT 'DRAFT',
    in_status VARCHAR(40) NOT NULL DEFAULT 'NOT_IN',
    total_amount NUMERIC(18, 2) NOT NULL DEFAULT 0,
    owner_name VARCHAR(120),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    version BIGINT NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS purchase_order_line (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    order_id UUID NOT NULL REFERENCES purchase_order(id) ON DELETE CASCADE,
    line_no INTEGER NOT NULL,
    product_id UUID NOT NULL REFERENCES md_product(id),
    warehouse_id UUID REFERENCES md_warehouse(id),
    qty NUMERIC(18, 4) NOT NULL,
    unit_price NUMERIC(18, 2) NOT NULL,
    amount NUMERIC(18, 2) NOT NULL,
    CONSTRAINT uq_purchase_order_line_no UNIQUE (order_id, line_no)
);

CREATE INDEX IF NOT EXISTS idx_purchase_order_supplier_date
    ON purchase_order (supplier_id, bill_date DESC);

CREATE TABLE IF NOT EXISTS purchase_in (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    bill_no VARCHAR(80) NOT NULL UNIQUE,
    source_order_id UUID REFERENCES purchase_order(id),
    supplier_id UUID NOT NULL REFERENCES md_supplier(id),
    bill_date DATE NOT NULL,
    department VARCHAR(120),
    status VARCHAR(40) NOT NULL DEFAULT 'DRAFT',
    total_amount NUMERIC(18, 2) NOT NULL DEFAULT 0,
    owner_name VARCHAR(120),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    version BIGINT NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS purchase_in_line (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    bill_id UUID NOT NULL REFERENCES purchase_in(id) ON DELETE CASCADE,
    line_no INTEGER NOT NULL,
    product_id UUID NOT NULL REFERENCES md_product(id),
    warehouse_id UUID NOT NULL REFERENCES md_warehouse(id),
    qty NUMERIC(18, 4) NOT NULL,
    unit_price NUMERIC(18, 2) NOT NULL,
    amount NUMERIC(18, 2) NOT NULL,
    CONSTRAINT uq_purchase_in_line_no UNIQUE (bill_id, line_no)
);

CREATE TABLE IF NOT EXISTS sales_out (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    bill_no VARCHAR(80) NOT NULL UNIQUE,
    source_order_id UUID REFERENCES sales_order(id),
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

CREATE TABLE IF NOT EXISTS sales_out_line (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    bill_id UUID NOT NULL REFERENCES sales_out(id) ON DELETE CASCADE,
    line_no INTEGER NOT NULL,
    product_id UUID NOT NULL REFERENCES md_product(id),
    warehouse_id UUID NOT NULL REFERENCES md_warehouse(id),
    qty NUMERIC(18, 4) NOT NULL,
    unit_price NUMERIC(18, 2) NOT NULL,
    amount NUMERIC(18, 2) NOT NULL,
    CONSTRAINT uq_sales_out_line_no UNIQUE (bill_id, line_no)
);
