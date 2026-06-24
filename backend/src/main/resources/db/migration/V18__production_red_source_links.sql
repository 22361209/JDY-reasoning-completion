ALTER TABLE production_material_issue
    ADD COLUMN IF NOT EXISTS red_source_bill_id UUID REFERENCES production_material_issue(id);

ALTER TABLE production_completion
    ADD COLUMN IF NOT EXISTS red_source_bill_id UUID REFERENCES production_completion(id);

UPDATE production_material_issue red
SET red_source_bill_id = original.id
FROM production_material_issue original
WHERE red.red_source_bill_id IS NULL
  AND red.status = 'RED_REVERSED'
  AND red.bill_no = concat('HC-', original.bill_no);

UPDATE production_completion red
SET red_source_bill_id = original.id
FROM production_completion original
WHERE red.red_source_bill_id IS NULL
  AND red.status = 'RED_REVERSED'
  AND red.bill_no = concat('HC-', original.bill_no);

CREATE INDEX IF NOT EXISTS idx_production_material_issue_red_source_bill
    ON production_material_issue (red_source_bill_id);

CREATE INDEX IF NOT EXISTS idx_production_completion_red_source_bill
    ON production_completion (red_source_bill_id);
