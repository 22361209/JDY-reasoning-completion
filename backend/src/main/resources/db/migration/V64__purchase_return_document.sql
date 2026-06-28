CREATE TABLE IF NOT EXISTS purchase_return (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    bill_no VARCHAR(80) NOT NULL UNIQUE,
    supplier_id UUID NOT NULL REFERENCES md_supplier(id),
    bill_date DATE NOT NULL,
    department VARCHAR(120),
    status VARCHAR(40) NOT NULL DEFAULT 'DRAFT',
    total_amount NUMERIC(18, 2) NOT NULL DEFAULT 0,
    is_tax_inclusive BOOLEAN NOT NULL DEFAULT FALSE,
    owner_name VARCHAR(120),
    remark TEXT,
    close_status VARCHAR(40) NOT NULL DEFAULT 'OPEN',
    close_reason TEXT,
    closed_by VARCHAR(120),
    closed_at TIMESTAMPTZ,
    frozen_status VARCHAR(40) NOT NULL DEFAULT 'NORMAL',
    frozen_reason TEXT,
    frozen_by VARCHAR(120),
    frozen_at TIMESTAMPTZ,
    reversed_at TIMESTAMPTZ,
    voided_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    version BIGINT NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS purchase_return_line (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    bill_id UUID NOT NULL REFERENCES purchase_return(id) ON DELETE CASCADE,
    line_no INTEGER NOT NULL,
    source_in_no VARCHAR(64),
    source_line_no INTEGER,
    product_id UUID NOT NULL REFERENCES md_product(id),
    warehouse_id UUID NOT NULL REFERENCES md_warehouse(id),
    qty NUMERIC(18, 4) NOT NULL,
    unit_price NUMERIC(18, 2) NOT NULL,
    amount NUMERIC(18, 2) NOT NULL,
    tax_rate NUMERIC(9, 4) NOT NULL DEFAULT 13,
    tax_amount NUMERIC(18, 2) NOT NULL DEFAULT 0,
    price_tax_total NUMERIC(18, 2) NOT NULL DEFAULT 0,
    line_remark TEXT,
    line_close_status VARCHAR(40) NOT NULL DEFAULT 'OPEN',
    line_close_reason TEXT,
    line_frozen_status VARCHAR(40) NOT NULL DEFAULT 'NORMAL',
    line_frozen_reason TEXT,
    CONSTRAINT uq_purchase_return_line_no UNIQUE (bill_id, line_no)
);

CREATE INDEX IF NOT EXISTS idx_purchase_return_supplier_date
    ON purchase_return (supplier_id, bill_date DESC);

CREATE INDEX IF NOT EXISTS idx_purchase_return_lifecycle
    ON purchase_return (status, close_status, frozen_status);

CREATE INDEX IF NOT EXISTS idx_purchase_return_line_source_in
    ON purchase_return_line (source_in_no, source_line_no);

CREATE INDEX IF NOT EXISTS idx_purchase_return_line_lifecycle
    ON purchase_return_line (bill_id, line_close_status, line_frozen_status);

INSERT INTO sys_permission_catalog (permission_code, module_name, permission_name, sort_no, enabled)
VALUES ('purchase.return.audit', '采购管理', '采购退货审核', 45, TRUE)
ON CONFLICT (permission_code) DO UPDATE
SET module_name = EXCLUDED.module_name,
    permission_name = EXCLUDED.permission_name,
    sort_no = EXCLUDED.sort_no,
    enabled = TRUE;

INSERT INTO sys_permission (role_id, permission_code, enabled)
SELECT r.id, 'purchase.return.audit', TRUE
FROM sys_role r
WHERE r.code = 'ADMIN'
ON CONFLICT (role_id, permission_code) DO UPDATE
SET enabled = EXCLUDED.enabled;
