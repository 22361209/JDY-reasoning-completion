ALTER TABLE md_product
    ADD COLUMN IF NOT EXISTS audit_status VARCHAR(40) NOT NULL DEFAULT 'AUDITED';

ALTER TABLE md_customer
    ADD COLUMN IF NOT EXISTS audit_status VARCHAR(40) NOT NULL DEFAULT 'AUDITED';

ALTER TABLE md_supplier
    ADD COLUMN IF NOT EXISTS audit_status VARCHAR(40) NOT NULL DEFAULT 'AUDITED';

ALTER TABLE md_warehouse
    ADD COLUMN IF NOT EXISTS audit_status VARCHAR(40) NOT NULL DEFAULT 'AUDITED';

ALTER TABLE md_product_category
    ADD COLUMN IF NOT EXISTS audit_status VARCHAR(40) NOT NULL DEFAULT 'AUDITED';

ALTER TABLE md_unit
    ADD COLUMN IF NOT EXISTS audit_status VARCHAR(40) NOT NULL DEFAULT 'AUDITED';

ALTER TABLE md_product ALTER COLUMN audit_status SET DEFAULT 'DRAFT';
ALTER TABLE md_customer ALTER COLUMN audit_status SET DEFAULT 'DRAFT';
ALTER TABLE md_supplier ALTER COLUMN audit_status SET DEFAULT 'DRAFT';
ALTER TABLE md_warehouse ALTER COLUMN audit_status SET DEFAULT 'DRAFT';
ALTER TABLE md_product_category ALTER COLUMN audit_status SET DEFAULT 'DRAFT';
ALTER TABLE md_unit ALTER COLUMN audit_status SET DEFAULT 'DRAFT';

CREATE SEQUENCE IF NOT EXISTS md_production_department_system_no_seq START WITH 500000001;

CREATE TABLE IF NOT EXISTS md_production_department (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    system_no BIGINT NOT NULL DEFAULT nextval('md_production_department_system_no_seq'),
    code VARCHAR(80) NOT NULL UNIQUE,
    name VARCHAR(160) NOT NULL,
    manager VARCHAR(120),
    remark TEXT,
    enabled BOOLEAN NOT NULL DEFAULT TRUE,
    audit_status VARCHAR(40) NOT NULL DEFAULT 'DRAFT',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    version BIGINT NOT NULL DEFAULT 0
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_md_production_department_system_no
    ON md_production_department (system_no);

INSERT INTO md_production_department (code, name, manager, remark, enabled, audit_status)
VALUES
    ('SCB', '生产部', '本地管理员', '默认生产部门', TRUE, 'AUDITED'),
    ('HJ', '焊接车间', '本地管理员', '焊接件生产与完工交接', TRUE, 'AUDITED'),
    ('DYWW', '电泳委外', '本地管理员', '焊接件表面处理委外承接', TRUE, 'AUDITED')
ON CONFLICT (code) DO UPDATE
SET name = EXCLUDED.name,
    manager = EXCLUDED.manager,
    remark = EXCLUDED.remark,
    enabled = EXCLUDED.enabled,
    audit_status = EXCLUDED.audit_status,
    updated_at = now();

ALTER TABLE production_plan
    ADD COLUMN IF NOT EXISTS department_code VARCHAR(80);

ALTER TABLE production_task
    ALTER COLUMN plan_id DROP NOT NULL;

CREATE TABLE IF NOT EXISTS outsourcing_surface_process (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    bill_no VARCHAR(80) NOT NULL UNIQUE,
    source_completion_id UUID REFERENCES production_completion(id),
    source_bill_no VARCHAR(80),
    product_id UUID NOT NULL REFERENCES md_product(id),
    product_code_snapshot VARCHAR(80),
    product_name_snapshot VARCHAR(200),
    product_spec_snapshot VARCHAR(200),
    product_unit_snapshot VARCHAR(40),
    net_weight_snapshot NUMERIC(18, 2),
    gross_weight_snapshot NUMERIC(18, 2),
    qty NUMERIC(18, 4) NOT NULL,
    processor_supplier_id UUID REFERENCES md_supplier(id),
    processor_supplier_code_snapshot VARCHAR(80),
    processor_supplier_name_snapshot VARCHAR(200),
    surface_treatment VARCHAR(120),
    status VARCHAR(40) NOT NULL DEFAULT 'DRAFT',
    remark TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    version BIGINT NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_outsourcing_surface_process_status_created
    ON outsourcing_surface_process (status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_outsourcing_surface_process_source
    ON outsourcing_surface_process (source_bill_no);
