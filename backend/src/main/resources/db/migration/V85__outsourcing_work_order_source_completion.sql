ALTER TABLE outsourcing_work_order
    ADD COLUMN IF NOT EXISTS source_completion_id UUID REFERENCES production_completion(id),
    ADD COLUMN IF NOT EXISTS source_bill_no VARCHAR(80);

CREATE INDEX IF NOT EXISTS idx_outsourcing_work_order_source_completion
    ON outsourcing_work_order (source_completion_id);

CREATE INDEX IF NOT EXISTS idx_outsourcing_work_order_source_bill
    ON outsourcing_work_order (source_bill_no);
