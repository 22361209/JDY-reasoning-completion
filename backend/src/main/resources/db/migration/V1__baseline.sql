CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE sys_user (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    username VARCHAR(80) NOT NULL UNIQUE,
    display_name VARCHAR(120) NOT NULL,
    password_hash VARCHAR(255),
    enabled BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_by UUID,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_by UUID,
    version BIGINT NOT NULL DEFAULT 0
);

CREATE TABLE sys_operation_log (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    module_code VARCHAR(80) NOT NULL,
    action_code VARCHAR(80) NOT NULL,
    target_type VARCHAR(120) NOT NULL,
    target_id UUID,
    before_state JSONB,
    after_state JSONB,
    success BOOLEAN NOT NULL,
    failure_reason TEXT,
    operated_by UUID,
    operated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE md_product (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    code VARCHAR(80) NOT NULL UNIQUE,
    name VARCHAR(200) NOT NULL,
    spec VARCHAR(200),
    unit VARCHAR(40) NOT NULL,
    enabled BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_by UUID,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_by UUID,
    version BIGINT NOT NULL DEFAULT 0
);

CREATE TABLE md_warehouse (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    code VARCHAR(80) NOT NULL UNIQUE,
    name VARCHAR(200) NOT NULL,
    allow_negative_stock BOOLEAN NOT NULL DEFAULT FALSE,
    enabled BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_by UUID,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_by UUID,
    version BIGINT NOT NULL DEFAULT 0
);

CREATE TABLE inv_stock_balance (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    product_id UUID NOT NULL REFERENCES md_product(id),
    warehouse_id UUID NOT NULL REFERENCES md_warehouse(id),
    qty_on_hand NUMERIC(18, 4) NOT NULL DEFAULT 0,
    qty_available NUMERIC(18, 4) NOT NULL DEFAULT 0,
    qty_reserved NUMERIC(18, 4) NOT NULL DEFAULT 0,
    unit_cost NUMERIC(18, 6),
    amount NUMERIC(18, 2),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    version BIGINT NOT NULL DEFAULT 0,
    CONSTRAINT uq_inv_stock_balance_product_warehouse UNIQUE (product_id, warehouse_id),
    CONSTRAINT ck_inv_stock_balance_qty_nonnegative CHECK (qty_on_hand >= 0 AND qty_available >= 0 AND qty_reserved >= 0)
);

CREATE TABLE inv_stock_txn (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    txn_type VARCHAR(80) NOT NULL,
    product_id UUID NOT NULL REFERENCES md_product(id),
    warehouse_id UUID NOT NULL REFERENCES md_warehouse(id),
    qty_delta NUMERIC(18, 4) NOT NULL,
    source_bill_type VARCHAR(80) NOT NULL,
    source_bill_id UUID NOT NULL,
    source_bill_line_id UUID,
    unit_cost NUMERIC(18, 6),
    amount NUMERIC(18, 2),
    occurred_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_inv_stock_txn_product_warehouse_time
    ON inv_stock_txn (product_id, warehouse_id, occurred_at DESC);

CREATE INDEX idx_inv_stock_txn_source
    ON inv_stock_txn (source_bill_type, source_bill_id);

CREATE TABLE sys_outbox_event (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    event_type VARCHAR(160) NOT NULL,
    aggregate_type VARCHAR(120) NOT NULL,
    aggregate_id UUID NOT NULL,
    payload JSONB NOT NULL,
    status VARCHAR(40) NOT NULL DEFAULT 'PENDING',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    published_at TIMESTAMPTZ,
    failure_reason TEXT
);

CREATE INDEX idx_sys_outbox_event_status_created
    ON sys_outbox_event (status, created_at);
