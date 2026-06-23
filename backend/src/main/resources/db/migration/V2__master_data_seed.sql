ALTER TABLE md_product
    ADD COLUMN IF NOT EXISTS category VARCHAR(120) NOT NULL DEFAULT '成品总成';

CREATE TABLE IF NOT EXISTS md_customer (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    code VARCHAR(80) NOT NULL UNIQUE,
    name VARCHAR(200) NOT NULL,
    contact VARCHAR(120),
    phone VARCHAR(80),
    region VARCHAR(160),
    enabled BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    version BIGINT NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS md_supplier (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    code VARCHAR(80) NOT NULL UNIQUE,
    name VARCHAR(200) NOT NULL,
    contact VARCHAR(120),
    phone VARCHAR(80),
    enabled BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    version BIGINT NOT NULL DEFAULT 0
);

INSERT INTO md_product (code, name, spec, category, unit, enabled)
VALUES
    ('CP-001', '控制臂总成', '左前 / 黑色', '成品总成', '只', TRUE),
    ('PJ-014', '衬套', '65mm / 加强', '零配件', '件', TRUE),
    ('CP-118', '后摆臂总成', '右后 / 银色', '成品总成', '只', FALSE)
ON CONFLICT (code) DO UPDATE
SET name = EXCLUDED.name,
    spec = EXCLUDED.spec,
    category = EXCLUDED.category,
    unit = EXCLUDED.unit,
    enabled = EXCLUDED.enabled,
    updated_at = now();

INSERT INTO md_customer (code, name, contact, phone, region, enabled)
VALUES
    ('KH-001', '广州测试客户', '陈经理', '13800000001', '广东广州', TRUE),
    ('KH-002', '佛山测试客户', '李主管', '13800000002', '广东佛山', TRUE),
    ('KH-009', '东莞备用客户', '周工', '13800000009', '广东东莞', FALSE)
ON CONFLICT (code) DO UPDATE
SET name = EXCLUDED.name,
    contact = EXCLUDED.contact,
    phone = EXCLUDED.phone,
    region = EXCLUDED.region,
    enabled = EXCLUDED.enabled,
    updated_at = now();

INSERT INTO md_supplier (code, name, contact, phone, enabled)
VALUES
    ('GYS-001', '广州钢材供应商', '王经理', '13900000001', TRUE),
    ('GYS-002', '佛山电泳加工厂', '赵主管', '13900000002', TRUE)
ON CONFLICT (code) DO UPDATE
SET name = EXCLUDED.name,
    contact = EXCLUDED.contact,
    phone = EXCLUDED.phone,
    enabled = EXCLUDED.enabled,
    updated_at = now();

INSERT INTO md_warehouse (code, name, allow_negative_stock, enabled)
VALUES
    ('CK-001', '成品仓', FALSE, TRUE),
    ('CK-002', '原料仓', FALSE, TRUE),
    ('CK-003', '半成品仓', FALSE, TRUE)
ON CONFLICT (code) DO UPDATE
SET name = EXCLUDED.name,
    allow_negative_stock = EXCLUDED.allow_negative_stock,
    enabled = EXCLUDED.enabled,
    updated_at = now();

INSERT INTO inv_stock_balance (product_id, warehouse_id, qty_on_hand, qty_available, qty_reserved, unit_cost, amount)
SELECT p.id, w.id, 1280, 1120, 160, 86.000000, 110080.00
FROM md_product p, md_warehouse w
WHERE p.code = 'CP-001' AND w.code = 'CK-001'
ON CONFLICT (product_id, warehouse_id) DO UPDATE
SET qty_on_hand = EXCLUDED.qty_on_hand,
    qty_available = EXCLUDED.qty_available,
    qty_reserved = EXCLUDED.qty_reserved,
    unit_cost = EXCLUDED.unit_cost,
    amount = EXCLUDED.amount,
    updated_at = now();

INSERT INTO inv_stock_balance (product_id, warehouse_id, qty_on_hand, qty_available, qty_reserved, unit_cost, amount)
SELECT p.id, w.id, 320, 280, 40, 3.200000, 1024.00
FROM md_product p, md_warehouse w
WHERE p.code = 'PJ-014' AND w.code = 'CK-002'
ON CONFLICT (product_id, warehouse_id) DO UPDATE
SET qty_on_hand = EXCLUDED.qty_on_hand,
    qty_available = EXCLUDED.qty_available,
    qty_reserved = EXCLUDED.qty_reserved,
    unit_cost = EXCLUDED.unit_cost,
    amount = EXCLUDED.amount,
    updated_at = now();

INSERT INTO inv_stock_balance (product_id, warehouse_id, qty_on_hand, qty_available, qty_reserved, unit_cost, amount)
SELECT p.id, w.id, 18, 12, 6, 92.000000, 1656.00
FROM md_product p, md_warehouse w
WHERE p.code = 'CP-118' AND w.code = 'CK-001'
ON CONFLICT (product_id, warehouse_id) DO UPDATE
SET qty_on_hand = EXCLUDED.qty_on_hand,
    qty_available = EXCLUDED.qty_available,
    qty_reserved = EXCLUDED.qty_reserved,
    unit_cost = EXCLUDED.unit_cost,
    amount = EXCLUDED.amount,
    updated_at = now();
