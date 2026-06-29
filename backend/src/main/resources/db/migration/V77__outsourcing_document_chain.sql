CREATE TABLE IF NOT EXISTS outsourcing_work_order (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    bill_no VARCHAR(80) NOT NULL UNIQUE,
    supplier_id UUID NOT NULL REFERENCES md_supplier(id),
    supplier_code_snapshot VARCHAR(80),
    supplier_name_snapshot VARCHAR(200),
    bill_date DATE NOT NULL DEFAULT CURRENT_DATE,
    status VARCHAR(40) NOT NULL DEFAULT 'DRAFT',
    remark TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    version BIGINT NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS outsourcing_work_order_line (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    work_order_id UUID NOT NULL REFERENCES outsourcing_work_order(id) ON DELETE CASCADE,
    line_no INTEGER NOT NULL,
    product_id UUID NOT NULL REFERENCES md_product(id),
    product_code_snapshot VARCHAR(80),
    product_name_snapshot VARCHAR(200),
    product_spec_snapshot VARCHAR(200),
    product_unit_snapshot VARCHAR(40),
    net_weight_snapshot NUMERIC(18, 2),
    gross_weight_snapshot NUMERIC(18, 2),
    bom_id UUID REFERENCES prod_bom(id),
    bom_code_snapshot VARCHAR(80),
    bom_version_no INTEGER,
    warehouse_id UUID REFERENCES md_warehouse(id),
    warehouse_code_snapshot VARCHAR(80),
    qty NUMERIC(18, 4) NOT NULL,
    issued_qty NUMERIC(18, 4) NOT NULL DEFAULT 0,
    received_qty NUMERIC(18, 4) NOT NULL DEFAULT 0,
    plan_delivery_date DATE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT uq_outsourcing_work_order_line_no UNIQUE (work_order_id, line_no)
);

CREATE TABLE IF NOT EXISTS outsourcing_work_order_component (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    work_order_id UUID NOT NULL REFERENCES outsourcing_work_order(id) ON DELETE CASCADE,
    line_no INTEGER NOT NULL,
    source_bom_line_id UUID REFERENCES prod_bom_line(id) ON DELETE SET NULL,
    product_id UUID NOT NULL REFERENCES md_product(id),
    product_code_snapshot VARCHAR(80),
    product_name_snapshot VARCHAR(200),
    product_spec_snapshot VARCHAR(200),
    product_unit_snapshot VARCHAR(40),
    net_weight_snapshot NUMERIC(18, 2),
    gross_weight_snapshot NUMERIC(18, 2),
    warehouse_id UUID REFERENCES md_warehouse(id),
    warehouse_code_snapshot VARCHAR(80),
    unit_qty NUMERIC(18, 6),
    required_qty NUMERIC(18, 4) NOT NULL,
    issued_qty NUMERIC(18, 4) NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT uq_outsourcing_work_order_component_no UNIQUE (work_order_id, line_no)
);

CREATE TABLE IF NOT EXISTS outsourcing_material_issue (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    bill_no VARCHAR(80) NOT NULL UNIQUE,
    source_work_order_id UUID NOT NULL REFERENCES outsourcing_work_order(id),
    source_work_order_no VARCHAR(80),
    supplier_id UUID NOT NULL REFERENCES md_supplier(id),
    supplier_code_snapshot VARCHAR(80),
    supplier_name_snapshot VARCHAR(200),
    bill_date DATE NOT NULL DEFAULT CURRENT_DATE,
    status VARCHAR(40) NOT NULL DEFAULT 'DRAFT',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    version BIGINT NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS outsourcing_material_issue_line (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    issue_id UUID NOT NULL REFERENCES outsourcing_material_issue(id) ON DELETE CASCADE,
    line_no INTEGER NOT NULL,
    source_component_id UUID REFERENCES outsourcing_work_order_component(id) ON DELETE SET NULL,
    product_id UUID NOT NULL REFERENCES md_product(id),
    product_code_snapshot VARCHAR(80),
    product_name_snapshot VARCHAR(200),
    product_spec_snapshot VARCHAR(200),
    product_unit_snapshot VARCHAR(40),
    net_weight_snapshot NUMERIC(18, 2),
    gross_weight_snapshot NUMERIC(18, 2),
    warehouse_id UUID REFERENCES md_warehouse(id),
    warehouse_code_snapshot VARCHAR(80),
    qty NUMERIC(18, 4) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT uq_outsourcing_material_issue_line_no UNIQUE (issue_id, line_no)
);

CREATE TABLE IF NOT EXISTS outsourcing_receipt (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    bill_no VARCHAR(80) NOT NULL UNIQUE,
    source_work_order_id UUID NOT NULL REFERENCES outsourcing_work_order(id),
    source_work_order_no VARCHAR(80),
    supplier_id UUID NOT NULL REFERENCES md_supplier(id),
    supplier_code_snapshot VARCHAR(80),
    supplier_name_snapshot VARCHAR(200),
    bill_date DATE NOT NULL DEFAULT CURRENT_DATE,
    status VARCHAR(40) NOT NULL DEFAULT 'DRAFT',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    version BIGINT NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS outsourcing_receipt_line (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    receipt_id UUID NOT NULL REFERENCES outsourcing_receipt(id) ON DELETE CASCADE,
    line_no INTEGER NOT NULL,
    source_work_order_line_id UUID REFERENCES outsourcing_work_order_line(id) ON DELETE SET NULL,
    product_id UUID NOT NULL REFERENCES md_product(id),
    product_code_snapshot VARCHAR(80),
    product_name_snapshot VARCHAR(200),
    product_spec_snapshot VARCHAR(200),
    product_unit_snapshot VARCHAR(40),
    net_weight_snapshot NUMERIC(18, 2),
    gross_weight_snapshot NUMERIC(18, 2),
    warehouse_id UUID REFERENCES md_warehouse(id),
    warehouse_code_snapshot VARCHAR(80),
    qty NUMERIC(18, 4) NOT NULL,
    returned_qty NUMERIC(18, 4) NOT NULL DEFAULT 0,
    scrapped_qty NUMERIC(18, 4) NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT uq_outsourcing_receipt_line_no UNIQUE (receipt_id, line_no)
);

CREATE TABLE IF NOT EXISTS outsourcing_return (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    bill_no VARCHAR(80) NOT NULL UNIQUE,
    source_receipt_id UUID NOT NULL REFERENCES outsourcing_receipt(id),
    source_receipt_no VARCHAR(80),
    supplier_id UUID NOT NULL REFERENCES md_supplier(id),
    supplier_code_snapshot VARCHAR(80),
    supplier_name_snapshot VARCHAR(200),
    bill_date DATE NOT NULL DEFAULT CURRENT_DATE,
    status VARCHAR(40) NOT NULL DEFAULT 'DRAFT',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    version BIGINT NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS outsourcing_return_line (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    return_id UUID NOT NULL REFERENCES outsourcing_return(id) ON DELETE CASCADE,
    line_no INTEGER NOT NULL,
    source_receipt_line_id UUID REFERENCES outsourcing_receipt_line(id) ON DELETE SET NULL,
    product_id UUID NOT NULL REFERENCES md_product(id),
    product_code_snapshot VARCHAR(80),
    product_name_snapshot VARCHAR(200),
    product_spec_snapshot VARCHAR(200),
    product_unit_snapshot VARCHAR(40),
    net_weight_snapshot NUMERIC(18, 2),
    gross_weight_snapshot NUMERIC(18, 2),
    warehouse_id UUID REFERENCES md_warehouse(id),
    warehouse_code_snapshot VARCHAR(80),
    qty NUMERIC(18, 4) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT uq_outsourcing_return_line_no UNIQUE (return_id, line_no)
);

CREATE TABLE IF NOT EXISTS outsourcing_scrap (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    bill_no VARCHAR(80) NOT NULL UNIQUE,
    source_receipt_id UUID NOT NULL REFERENCES outsourcing_receipt(id),
    source_receipt_no VARCHAR(80),
    supplier_id UUID NOT NULL REFERENCES md_supplier(id),
    supplier_code_snapshot VARCHAR(80),
    supplier_name_snapshot VARCHAR(200),
    bill_date DATE NOT NULL DEFAULT CURRENT_DATE,
    status VARCHAR(40) NOT NULL DEFAULT 'DRAFT',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    version BIGINT NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS outsourcing_scrap_line (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    scrap_id UUID NOT NULL REFERENCES outsourcing_scrap(id) ON DELETE CASCADE,
    line_no INTEGER NOT NULL,
    source_receipt_line_id UUID REFERENCES outsourcing_receipt_line(id) ON DELETE SET NULL,
    product_id UUID NOT NULL REFERENCES md_product(id),
    product_code_snapshot VARCHAR(80),
    product_name_snapshot VARCHAR(200),
    product_spec_snapshot VARCHAR(200),
    product_unit_snapshot VARCHAR(40),
    net_weight_snapshot NUMERIC(18, 2),
    gross_weight_snapshot NUMERIC(18, 2),
    warehouse_id UUID REFERENCES md_warehouse(id),
    warehouse_code_snapshot VARCHAR(80),
    qty NUMERIC(18, 4) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT uq_outsourcing_scrap_line_no UNIQUE (scrap_id, line_no)
);

CREATE INDEX IF NOT EXISTS idx_outsourcing_work_order_status_created ON outsourcing_work_order (status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_outsourcing_issue_status_created ON outsourcing_material_issue (status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_outsourcing_receipt_status_created ON outsourcing_receipt (status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_outsourcing_return_status_created ON outsourcing_return (status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_outsourcing_scrap_status_created ON outsourcing_scrap (status, created_at DESC);
