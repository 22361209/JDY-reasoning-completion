CREATE TABLE IF NOT EXISTS inv_safety_stock_setting (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    product_id UUID NOT NULL REFERENCES md_product(id),
    warehouse_id UUID NOT NULL REFERENCES md_warehouse(id),
    safety_qty NUMERIC(18, 4) NOT NULL,
    max_qty NUMERIC(18, 4),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    version BIGINT NOT NULL DEFAULT 0,
    CONSTRAINT uq_inv_safety_stock_setting_product_warehouse UNIQUE (product_id, warehouse_id),
    CONSTRAINT ck_inv_safety_stock_setting_qty CHECK (
        safety_qty >= 0
        AND (max_qty IS NULL OR max_qty >= safety_qty)
    )
);

CREATE INDEX IF NOT EXISTS idx_inv_safety_stock_setting_product_warehouse
    ON inv_safety_stock_setting (product_id, warehouse_id);

INSERT INTO inv_safety_stock_setting (product_id, warehouse_id, safety_qty, max_qty)
SELECT p.id, w.id, 20, 200
FROM md_product p, md_warehouse w
WHERE p.code = 'CP-118' AND w.code = 'CK-001'
ON CONFLICT (product_id, warehouse_id) DO UPDATE
SET safety_qty = EXCLUDED.safety_qty,
    max_qty = EXCLUDED.max_qty,
    updated_at = now(),
    version = inv_safety_stock_setting.version + 1;

INSERT INTO inv_safety_stock_setting (product_id, warehouse_id, safety_qty, max_qty)
SELECT p.id, w.id, 100, 1000
FROM md_product p, md_warehouse w
WHERE p.code = 'CP-001' AND w.code = 'CK-001'
ON CONFLICT (product_id, warehouse_id) DO UPDATE
SET safety_qty = EXCLUDED.safety_qty,
    max_qty = EXCLUDED.max_qty,
    updated_at = now(),
    version = inv_safety_stock_setting.version + 1;

INSERT INTO sys_permission_catalog (permission_code, module_name, permission_name, sort_no, enabled)
VALUES ('inventory.stock_alert.manage', '库存管理', '库存预警设置', 61, TRUE)
ON CONFLICT (permission_code) DO UPDATE
SET module_name = EXCLUDED.module_name,
    permission_name = EXCLUDED.permission_name,
    sort_no = EXCLUDED.sort_no,
    enabled = EXCLUDED.enabled;

INSERT INTO sys_permission (role_id, permission_code, enabled)
SELECT r.id, 'inventory.stock_alert.manage', TRUE
FROM sys_role r
WHERE r.code IN ('admin', 'warehouse')
ON CONFLICT (role_id, permission_code) DO UPDATE
SET enabled = EXCLUDED.enabled;
