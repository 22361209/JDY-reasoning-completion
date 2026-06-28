ALTER TABLE md_product
    ADD COLUMN IF NOT EXISTS net_weight NUMERIC(18,2),
    ADD COLUMN IF NOT EXISTS gross_weight NUMERIC(18,2);

CREATE OR REPLACE FUNCTION fill_product_material_snapshot_attrs()
RETURNS trigger AS $$
DECLARE
    material_attrs RECORD;
BEGIN
    IF NEW.product_id IS NULL THEN
        RETURN NEW;
    END IF;

    SELECT unit, net_weight, gross_weight
    INTO material_attrs
    FROM md_product
    WHERE id = NEW.product_id;

    IF NOT FOUND THEN
        RETURN NEW;
    END IF;

    IF TG_OP = 'INSERT' OR NEW.product_id IS DISTINCT FROM OLD.product_id THEN
        NEW.product_unit_snapshot := material_attrs.unit;
        NEW.net_weight_snapshot := material_attrs.net_weight;
        NEW.gross_weight_snapshot := material_attrs.gross_weight;
    ELSE
        NEW.product_unit_snapshot := COALESCE(NULLIF(NEW.product_unit_snapshot, ''), material_attrs.unit);
        NEW.net_weight_snapshot := COALESCE(NEW.net_weight_snapshot, material_attrs.net_weight);
        NEW.gross_weight_snapshot := COALESCE(NEW.gross_weight_snapshot, material_attrs.gross_weight);
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DO $$
DECLARE
    target_table text;
BEGIN
    FOREACH target_table IN ARRAY ARRAY[
        'sales_quote_line',
        'sales_order_line',
        'delivery_notice_line',
        'sales_out_line',
        'purchase_order_line',
        'purchase_in_line',
        'purchase_return_line',
        'other_stock_in_line',
        'other_stock_out_line',
        'stock_transfer_line',
        'stock_count_line',
        'stock_count_gain_line',
        'stock_count_loss_line',
        'production_plan',
        'production_task',
        'production_task_material_snapshot',
        'production_material_issue_line',
        'production_completion_line'
    ]
    LOOP
        EXECUTE format(
            'ALTER TABLE %I
                ADD COLUMN IF NOT EXISTS product_unit_snapshot VARCHAR(40),
                ADD COLUMN IF NOT EXISTS net_weight_snapshot NUMERIC(18,2),
                ADD COLUMN IF NOT EXISTS gross_weight_snapshot NUMERIC(18,2)',
            target_table
        );

        EXECUTE format(
            'UPDATE %I line
             SET product_unit_snapshot = COALESCE(NULLIF(line.product_unit_snapshot, ''''), p.unit),
                 net_weight_snapshot = COALESCE(line.net_weight_snapshot, p.net_weight),
                 gross_weight_snapshot = COALESCE(line.gross_weight_snapshot, p.gross_weight)
             FROM md_product p
             WHERE p.id = line.product_id',
            target_table
        );

        EXECUTE format('DROP TRIGGER IF EXISTS trg_fill_product_material_snapshot_attrs ON %I', target_table);
        EXECUTE format(
            'CREATE TRIGGER trg_fill_product_material_snapshot_attrs
             BEFORE INSERT OR UPDATE OF product_id, product_unit_snapshot, net_weight_snapshot, gross_weight_snapshot
             ON %I
             FOR EACH ROW
             EXECUTE FUNCTION fill_product_material_snapshot_attrs()',
            target_table
        );
    END LOOP;
END $$;
