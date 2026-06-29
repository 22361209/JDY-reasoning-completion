CREATE TABLE IF NOT EXISTS sys_account_set (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    code VARCHAR(80) NOT NULL UNIQUE,
    name VARCHAR(200) NOT NULL,
    environment VARCHAR(80) NOT NULL DEFAULT '本地开发',
    database_name VARCHAR(120),
    schema_name VARCHAR(120),
    attachment_prefix VARCHAR(240),
    redis_key_prefix VARCHAR(120),
    accounting_period VARCHAR(20) NOT NULL DEFAULT '2026-06',
    business_period VARCHAR(20) NOT NULL DEFAULT '2026-06',
    enabled BOOLEAN NOT NULL DEFAULT TRUE,
    initialized BOOLEAN NOT NULL DEFAULT FALSE,
    initialized_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    version BIGINT NOT NULL DEFAULT 0
);

INSERT INTO sys_account_set (
    id, code, name, environment, database_name, schema_name, attachment_prefix, redis_key_prefix,
    accounting_period, business_period, enabled, initialized
)
VALUES (
    '00000000-0000-0000-0000-000000000001'::uuid,
    'BLD-TEST',
    '博莱德机械测试账套',
    '本地开发',
    current_database(),
    current_schema(),
    'account-sets/BLD-TEST',
    'BLD-TEST',
    '2026-06',
    '2026-06',
    TRUE,
    TRUE
)
ON CONFLICT (code) DO UPDATE
SET name = EXCLUDED.name,
    environment = EXCLUDED.environment,
    database_name = COALESCE(sys_account_set.database_name, EXCLUDED.database_name),
    schema_name = COALESCE(sys_account_set.schema_name, EXCLUDED.schema_name),
    attachment_prefix = COALESCE(sys_account_set.attachment_prefix, EXCLUDED.attachment_prefix),
    redis_key_prefix = COALESCE(sys_account_set.redis_key_prefix, EXCLUDED.redis_key_prefix),
    accounting_period = EXCLUDED.accounting_period,
    business_period = EXCLUDED.business_period,
    enabled = TRUE,
    updated_at = now();

ALTER TABLE sys_user
    ADD COLUMN IF NOT EXISTS default_account_set_id UUID REFERENCES sys_account_set(id);

UPDATE sys_user
SET default_account_set_id = '00000000-0000-0000-0000-000000000001'::uuid
WHERE default_account_set_id IS NULL;

ALTER TABLE document_number_sequence
    ADD COLUMN IF NOT EXISTS id UUID DEFAULT gen_random_uuid(),
    ADD COLUMN IF NOT EXISTS account_set_id UUID REFERENCES sys_account_set(id),
    ADD COLUMN IF NOT EXISTS width INTEGER NOT NULL DEFAULT 6,
    ADD COLUMN IF NOT EXISTS description VARCHAR(160),
    ADD COLUMN IF NOT EXISTS enabled BOOLEAN NOT NULL DEFAULT TRUE;

UPDATE document_number_sequence
SET id = gen_random_uuid()
WHERE id IS NULL;

UPDATE document_number_sequence
SET account_set_id = '00000000-0000-0000-0000-000000000001'::uuid
WHERE account_set_id IS NULL;

ALTER TABLE document_number_sequence
    ALTER COLUMN id SET NOT NULL,
    ALTER COLUMN account_set_id SET NOT NULL;

ALTER TABLE document_number_sequence
    DROP CONSTRAINT IF EXISTS document_number_sequence_pkey;

ALTER TABLE document_number_sequence
    ADD CONSTRAINT document_number_sequence_pkey PRIMARY KEY (id);

CREATE UNIQUE INDEX IF NOT EXISTS uq_document_number_sequence_account_type
    ON document_number_sequence (account_set_id, document_type);

ALTER TABLE inv_stock_balance
    ADD COLUMN IF NOT EXISTS account_set_id UUID REFERENCES sys_account_set(id) DEFAULT '00000000-0000-0000-0000-000000000001'::uuid;

UPDATE inv_stock_balance
SET account_set_id = '00000000-0000-0000-0000-000000000001'::uuid
WHERE account_set_id IS NULL;

ALTER TABLE inv_stock_balance
    ALTER COLUMN account_set_id SET NOT NULL;

ALTER TABLE inv_stock_balance
    DROP CONSTRAINT IF EXISTS uq_inv_stock_balance_product_warehouse;

CREATE UNIQUE INDEX IF NOT EXISTS uq_inv_stock_balance_account_product_warehouse
    ON inv_stock_balance (account_set_id, product_id, warehouse_id);

ALTER TABLE inv_stock_txn
    ADD COLUMN IF NOT EXISTS account_set_id UUID REFERENCES sys_account_set(id) DEFAULT '00000000-0000-0000-0000-000000000001'::uuid;

UPDATE inv_stock_txn
SET account_set_id = '00000000-0000-0000-0000-000000000001'::uuid
WHERE account_set_id IS NULL;

ALTER TABLE inv_stock_txn
    ALTER COLUMN account_set_id SET NOT NULL;

DROP INDEX IF EXISTS idx_inv_stock_txn_product_warehouse_time;

CREATE INDEX IF NOT EXISTS idx_inv_stock_txn_account_product_warehouse_time
    ON inv_stock_txn (account_set_id, product_id, warehouse_id, occurred_at DESC);

CREATE TABLE IF NOT EXISTS inv_stock_opening (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    account_set_id UUID NOT NULL REFERENCES sys_account_set(id),
    product_id UUID NOT NULL REFERENCES md_product(id),
    warehouse_id UUID NOT NULL REFERENCES md_warehouse(id),
    qty NUMERIC(18, 4) NOT NULL DEFAULT 0,
    unit_cost NUMERIC(18, 6),
    amount NUMERIC(18, 2),
    remark TEXT,
    updated_by UUID REFERENCES sys_user(id),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT uq_inv_stock_opening_account_product_warehouse UNIQUE (account_set_id, product_id, warehouse_id),
    CONSTRAINT ck_inv_stock_opening_qty_nonnegative CHECK (qty >= 0)
);

INSERT INTO sys_permission_catalog (permission_code, module_name, permission_name, sort_no, enabled)
VALUES
    ('system.account_set.manage', '系统设置', '账套管理', 12, TRUE),
    ('system.numbering_rule.manage', '系统设置', '单据编号规则', 18, TRUE),
    ('inventory.opening_stock.manage', '库存管理', '库存期初数维护', 52, TRUE)
ON CONFLICT (permission_code) DO UPDATE
SET module_name = EXCLUDED.module_name,
    permission_name = EXCLUDED.permission_name,
    sort_no = EXCLUDED.sort_no,
    enabled = TRUE;

INSERT INTO sys_permission (role_id, permission_code, enabled)
SELECT r.id, p.permission_code, TRUE
FROM sys_role r
CROSS JOIN (
    VALUES
        ('system.account_set.manage'),
        ('system.numbering_rule.manage'),
        ('inventory.opening_stock.manage')
) AS p(permission_code)
WHERE r.code = 'ADMIN'
ON CONFLICT (role_id, permission_code) DO UPDATE
SET enabled = EXCLUDED.enabled;

INSERT INTO sys_permission (role_id, permission_code, enabled)
SELECT r.id, 'inventory.opening_stock.manage', TRUE
FROM sys_role r
WHERE r.code = 'WAREHOUSE'
ON CONFLICT (role_id, permission_code) DO UPDATE
SET enabled = EXCLUDED.enabled;
