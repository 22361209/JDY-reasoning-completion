ALTER TABLE md_product
    ADD COLUMN IF NOT EXISTS drawing_file_name VARCHAR(255),
    ADD COLUMN IF NOT EXISTS drawing_file_data TEXT,
    ADD COLUMN IF NOT EXISTS image_file_names TEXT,
    ADD COLUMN IF NOT EXISTS image_file_data TEXT;
