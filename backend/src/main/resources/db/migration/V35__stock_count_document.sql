CREATE TABLE IF NOT EXISTS stock_count (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    bill_no VARCHAR(80) NOT NULL UNIQUE,
    bill_date DATE NOT NULL,
    department VARCHAR(120),
    document_type VARCHAR(80) NOT NULL DEFAULT 'STK_StockCountInput',
    business_type VARCHAR(80) NOT NULL DEFAULT '盘点单',
    status VARCHAR(40) NOT NULL DEFAULT 'DRAFT',
    owner_name VARCHAR(120),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_by UUID,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_by UUID,
    reversed_at TIMESTAMPTZ,
    voided_at TIMESTAMPTZ,
    version BIGINT NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS stock_count_line (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    bill_id UUID NOT NULL REFERENCES stock_count(id) ON DELETE CASCADE,
    line_no INTEGER NOT NULL,
    product_id UUID NOT NULL REFERENCES md_product(id),
    warehouse_id UUID NOT NULL REFERENCES md_warehouse(id),
    system_qty NUMERIC(18, 4) NOT NULL DEFAULT 0,
    counted_qty NUMERIC(18, 4) NOT NULL,
    diff_qty NUMERIC(18, 4) NOT NULL,
    unit_price NUMERIC(18, 6) NOT NULL DEFAULT 0,
    line_remark TEXT,
    CONSTRAINT uq_stock_count_line_no UNIQUE (bill_id, line_no)
);

CREATE INDEX IF NOT EXISTS idx_stock_count_status_date
    ON stock_count (status, bill_date DESC);

CREATE INDEX IF NOT EXISTS idx_stock_count_line_product_warehouse
    ON stock_count_line (product_id, warehouse_id);

INSERT INTO sys_permission_catalog (permission_code, module_name, permission_name, sort_no, enabled)
VALUES ('inventory.stock_count.audit', '库存管理', '盘点单审核', 58, TRUE)
ON CONFLICT (permission_code) DO UPDATE
SET module_name = EXCLUDED.module_name,
    permission_name = EXCLUDED.permission_name,
    sort_no = EXCLUDED.sort_no,
    enabled = EXCLUDED.enabled;

INSERT INTO sys_permission (role_id, permission_code, enabled)
SELECT r.id, 'inventory.stock_count.audit', TRUE
FROM sys_role r
WHERE r.code IN ('ADMIN', 'WAREHOUSE')
ON CONFLICT (role_id, permission_code) DO UPDATE
SET enabled = EXCLUDED.enabled;
