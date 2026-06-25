CREATE TABLE IF NOT EXISTS other_stock_in (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    bill_no VARCHAR(80) NOT NULL UNIQUE,
    bill_date DATE NOT NULL,
    department VARCHAR(120),
    business_type VARCHAR(80) NOT NULL DEFAULT '其他入库',
    status VARCHAR(40) NOT NULL DEFAULT 'DRAFT',
    total_amount NUMERIC(18, 2) NOT NULL DEFAULT 0,
    owner_name VARCHAR(120),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_by UUID,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_by UUID,
    reversed_at TIMESTAMPTZ,
    voided_at TIMESTAMPTZ,
    version BIGINT NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS other_stock_in_line (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    bill_id UUID NOT NULL REFERENCES other_stock_in(id) ON DELETE CASCADE,
    line_no INTEGER NOT NULL,
    product_id UUID NOT NULL REFERENCES md_product(id),
    warehouse_id UUID NOT NULL REFERENCES md_warehouse(id),
    qty NUMERIC(18, 4) NOT NULL,
    unit_price NUMERIC(18, 6) NOT NULL DEFAULT 0,
    amount NUMERIC(18, 2) NOT NULL DEFAULT 0,
    line_remark TEXT,
    CONSTRAINT uq_other_stock_in_line_no UNIQUE (bill_id, line_no)
);

CREATE INDEX IF NOT EXISTS idx_other_stock_in_status_date
    ON other_stock_in (status, bill_date DESC);

CREATE INDEX IF NOT EXISTS idx_other_stock_in_line_product_warehouse
    ON other_stock_in_line (product_id, warehouse_id);

INSERT INTO sys_permission_catalog (permission_code, module_name, permission_name, sort_no, enabled)
VALUES ('inventory.other_stock_in.audit', '库存管理', '其他入库审核', 55, TRUE)
ON CONFLICT (permission_code) DO UPDATE
SET module_name = EXCLUDED.module_name,
    permission_name = EXCLUDED.permission_name,
    sort_no = EXCLUDED.sort_no,
    enabled = EXCLUDED.enabled;

INSERT INTO sys_permission (role_id, permission_code, enabled)
SELECT r.id, 'inventory.other_stock_in.audit', TRUE
FROM sys_role r
WHERE r.code IN ('ADMIN', 'WAREHOUSE')
ON CONFLICT (role_id, permission_code) DO UPDATE
SET enabled = EXCLUDED.enabled;
