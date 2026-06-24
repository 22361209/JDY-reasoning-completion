ALTER TABLE sys_print_template
    ADD COLUMN IF NOT EXISTS paper_size VARCHAR(20) NOT NULL DEFAULT 'A4',
    ADD COLUMN IF NOT EXISTS page_orientation VARCHAR(20) NOT NULL DEFAULT 'PORTRAIT',
    ADD COLUMN IF NOT EXISTS margin_top_mm NUMERIC(6, 2) NOT NULL DEFAULT 12,
    ADD COLUMN IF NOT EXISTS margin_right_mm NUMERIC(6, 2) NOT NULL DEFAULT 12,
    ADD COLUMN IF NOT EXISTS margin_bottom_mm NUMERIC(6, 2) NOT NULL DEFAULT 12,
    ADD COLUMN IF NOT EXISTS margin_left_mm NUMERIC(6, 2) NOT NULL DEFAULT 12,
    ADD COLUMN IF NOT EXISTS copy_count INTEGER NOT NULL DEFAULT 1;

UPDATE sys_print_template
SET paper_size = COALESCE(NULLIF(paper_size, ''), 'A4'),
    page_orientation = COALESCE(NULLIF(page_orientation, ''), 'PORTRAIT'),
    margin_top_mm = COALESCE(margin_top_mm, 12),
    margin_right_mm = COALESCE(margin_right_mm, 12),
    margin_bottom_mm = COALESCE(margin_bottom_mm, 12),
    margin_left_mm = COALESCE(margin_left_mm, 12),
    copy_count = COALESCE(copy_count, 1);
