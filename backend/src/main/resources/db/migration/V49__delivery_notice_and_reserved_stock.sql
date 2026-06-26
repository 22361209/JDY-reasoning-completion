CREATE TABLE IF NOT EXISTS delivery_notice (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    bill_no VARCHAR(80) NOT NULL UNIQUE,
    customer_id UUID NOT NULL REFERENCES md_customer(id),
    bill_date DATE NOT NULL,
    department VARCHAR(120),
    status VARCHAR(40) NOT NULL DEFAULT 'DRAFT',
    close_status VARCHAR(40) NOT NULL DEFAULT 'OPEN',
    frozen_status VARCHAR(40) NOT NULL DEFAULT 'NORMAL',
    total_amount NUMERIC(18, 2) NOT NULL DEFAULT 0,
    is_tax_inclusive BOOLEAN NOT NULL DEFAULT FALSE,
    owner_name VARCHAR(120),
    remark TEXT,
    created_by UUID REFERENCES sys_user(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    version BIGINT NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS delivery_notice_line (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    bill_id UUID NOT NULL REFERENCES delivery_notice(id) ON DELETE CASCADE,
    line_no INTEGER NOT NULL,
    source_order_no VARCHAR(80),
    source_line_no INTEGER,
    product_id UUID NOT NULL REFERENCES md_product(id),
    warehouse_id UUID NOT NULL REFERENCES md_warehouse(id),
    qty NUMERIC(18, 4) NOT NULL,
    unit_price NUMERIC(18, 2) NOT NULL,
    amount NUMERIC(18, 2) NOT NULL,
    tax_rate NUMERIC(8, 4) NOT NULL DEFAULT 13,
    tax_amount NUMERIC(18, 2) NOT NULL DEFAULT 0,
    price_tax_total NUMERIC(18, 2) NOT NULL DEFAULT 0,
    line_remark TEXT,
    plan_delivery_date DATE,
    line_close_status VARCHAR(40) NOT NULL DEFAULT 'OPEN',
    line_frozen_status VARCHAR(40) NOT NULL DEFAULT 'NORMAL',
    CONSTRAINT uq_delivery_notice_line_no UNIQUE (bill_id, line_no)
);

CREATE INDEX IF NOT EXISTS idx_delivery_notice_customer_date
    ON delivery_notice (customer_id, bill_date DESC);

CREATE INDEX IF NOT EXISTS idx_delivery_notice_line_source
    ON delivery_notice_line (source_order_no, source_line_no);

ALTER TABLE sales_out
    ADD COLUMN IF NOT EXISTS source_delivery_notice_id UUID REFERENCES delivery_notice(id);

ALTER TABLE sales_out_line
    ADD COLUMN IF NOT EXISTS source_delivery_notice_no VARCHAR(80),
    ADD COLUMN IF NOT EXISTS source_delivery_line_no INTEGER;

CREATE INDEX IF NOT EXISTS idx_sales_out_source_delivery_notice
    ON sales_out (source_delivery_notice_id);

CREATE INDEX IF NOT EXISTS idx_sales_out_line_source_delivery
    ON sales_out_line (source_delivery_notice_no, source_delivery_line_no);
