ALTER TABLE purchase_order_line
    ADD COLUMN IF NOT EXISTS received_qty NUMERIC(18, 4) NOT NULL DEFAULT 0;

ALTER TABLE sales_order_line
    ADD COLUMN IF NOT EXISTS shipped_qty NUMERIC(18, 4) NOT NULL DEFAULT 0;

ALTER TABLE purchase_in
    ADD COLUMN IF NOT EXISTS reversed_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS voided_at TIMESTAMPTZ;

ALTER TABLE sales_out
    ADD COLUMN IF NOT EXISTS reversed_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS voided_at TIMESTAMPTZ;

CREATE TABLE IF NOT EXISTS ar_receivable (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    bill_no VARCHAR(80) NOT NULL UNIQUE,
    source_bill_no VARCHAR(80),
    customer_id UUID NOT NULL REFERENCES md_customer(id),
    bill_date DATE NOT NULL,
    amount NUMERIC(18, 2) NOT NULL,
    received_amount NUMERIC(18, 2) NOT NULL DEFAULT 0,
    status VARCHAR(40) NOT NULL DEFAULT 'OPEN',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS ar_receipt (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    bill_no VARCHAR(80) NOT NULL UNIQUE,
    receivable_id UUID NOT NULL REFERENCES ar_receivable(id),
    receipt_date DATE NOT NULL,
    amount NUMERIC(18, 2) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS ap_payable (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    bill_no VARCHAR(80) NOT NULL UNIQUE,
    source_bill_no VARCHAR(80),
    supplier_id UUID NOT NULL REFERENCES md_supplier(id),
    bill_date DATE NOT NULL,
    amount NUMERIC(18, 2) NOT NULL,
    paid_amount NUMERIC(18, 2) NOT NULL DEFAULT 0,
    status VARCHAR(40) NOT NULL DEFAULT 'OPEN',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS ap_payment (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    bill_no VARCHAR(80) NOT NULL UNIQUE,
    payable_id UUID NOT NULL REFERENCES ap_payable(id),
    payment_date DATE NOT NULL,
    amount NUMERIC(18, 2) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS prod_bom (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    code VARCHAR(80) NOT NULL UNIQUE,
    product_id UUID NOT NULL REFERENCES md_product(id),
    qty NUMERIC(18, 4) NOT NULL DEFAULT 1,
    enabled BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS prod_bom_line (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    bom_id UUID NOT NULL REFERENCES prod_bom(id) ON DELETE CASCADE,
    line_no INTEGER NOT NULL,
    material_id UUID NOT NULL REFERENCES md_product(id),
    qty NUMERIC(18, 4) NOT NULL,
    CONSTRAINT uq_prod_bom_line_no UNIQUE (bom_id, line_no)
);

CREATE TABLE IF NOT EXISTS production_task (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    bill_no VARCHAR(80) NOT NULL UNIQUE,
    bom_id UUID NOT NULL REFERENCES prod_bom(id),
    product_id UUID NOT NULL REFERENCES md_product(id),
    warehouse_id UUID NOT NULL REFERENCES md_warehouse(id),
    qty NUMERIC(18, 4) NOT NULL,
    issued_qty NUMERIC(18, 4) NOT NULL DEFAULT 0,
    completed_qty NUMERIC(18, 4) NOT NULL DEFAULT 0,
    status VARCHAR(40) NOT NULL DEFAULT 'DRAFT',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS production_material_issue (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    bill_no VARCHAR(80) NOT NULL UNIQUE,
    task_id UUID NOT NULL REFERENCES production_task(id),
    status VARCHAR(40) NOT NULL DEFAULT 'DRAFT',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    reversed_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS production_completion (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    bill_no VARCHAR(80) NOT NULL UNIQUE,
    task_id UUID NOT NULL REFERENCES production_task(id),
    qty NUMERIC(18, 4) NOT NULL,
    status VARCHAR(40) NOT NULL DEFAULT 'DRAFT',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    reversed_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS sys_role (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    code VARCHAR(80) NOT NULL UNIQUE,
    name VARCHAR(120) NOT NULL,
    enabled BOOLEAN NOT NULL DEFAULT TRUE
);

CREATE TABLE IF NOT EXISTS sys_user_role (
    user_id UUID NOT NULL REFERENCES sys_user(id),
    role_id UUID NOT NULL REFERENCES sys_role(id),
    PRIMARY KEY (user_id, role_id)
);

CREATE TABLE IF NOT EXISTS sys_permission (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    role_id UUID NOT NULL REFERENCES sys_role(id),
    permission_code VARCHAR(160) NOT NULL,
    enabled BOOLEAN NOT NULL DEFAULT TRUE,
    CONSTRAINT uq_sys_permission_role_code UNIQUE (role_id, permission_code)
);

INSERT INTO sys_role (code, name, enabled)
VALUES ('ADMIN', '系统管理员', TRUE), ('WAREHOUSE', '仓库员', TRUE), ('FINANCE', '财务员', TRUE)
ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name, enabled = EXCLUDED.enabled;
