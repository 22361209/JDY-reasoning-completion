CREATE TABLE IF NOT EXISTS document_number_sequence (
    document_type VARCHAR(80) PRIMARY KEY,
    prefix VARCHAR(24) NOT NULL,
    last_number INTEGER NOT NULL DEFAULT 0,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
