CREATE TABLE IF NOT EXISTS production_material_issue_line (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    issue_id UUID NOT NULL REFERENCES production_material_issue(id) ON DELETE CASCADE,
    line_no INTEGER NOT NULL,
    product_id UUID NOT NULL REFERENCES md_product(id),
    warehouse_id UUID NOT NULL REFERENCES md_warehouse(id),
    qty NUMERIC(18, 4) NOT NULL,
    unit_price NUMERIC(18, 6) NOT NULL DEFAULT 1,
    amount NUMERIC(18, 2) NOT NULL DEFAULT 0,
    CONSTRAINT uq_production_issue_line_no UNIQUE (issue_id, line_no)
);

CREATE TABLE IF NOT EXISTS production_completion_line (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    completion_id UUID NOT NULL REFERENCES production_completion(id) ON DELETE CASCADE,
    line_no INTEGER NOT NULL,
    product_id UUID NOT NULL REFERENCES md_product(id),
    warehouse_id UUID NOT NULL REFERENCES md_warehouse(id),
    qty NUMERIC(18, 4) NOT NULL,
    unit_price NUMERIC(18, 6) NOT NULL DEFAULT 1,
    amount NUMERIC(18, 2) NOT NULL DEFAULT 0,
    CONSTRAINT uq_production_completion_line_no UNIQUE (completion_id, line_no)
);
