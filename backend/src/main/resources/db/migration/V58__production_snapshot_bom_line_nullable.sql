ALTER TABLE production_task_material_snapshot
    DROP CONSTRAINT IF EXISTS production_task_material_snapshot_source_bom_line_id_fkey;

ALTER TABLE production_task_material_snapshot
    ADD CONSTRAINT production_task_material_snapshot_source_bom_line_id_fkey
    FOREIGN KEY (source_bom_line_id)
    REFERENCES prod_bom_line(id)
    ON DELETE SET NULL;
