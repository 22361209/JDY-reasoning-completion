-- A147: make every new formal inventory fact traceable to the exact document
-- header and line that produced it. Historical rows are classified
-- conservatively; line ids are never guessed from product/quantity.
ALTER TABLE inv_stock_txn
    ADD COLUMN IF NOT EXISTS source_bill_no VARCHAR(80),
    ADD COLUMN IF NOT EXISTS source_bill_date DATE,
    ADD COLUMN IF NOT EXISTS posting_action VARCHAR(24),
    ADD COLUMN IF NOT EXISTS qty_on_hand_after NUMERIC(18, 4),
    ADD COLUMN IF NOT EXISTS trace_quality VARCHAR(24),
    ADD COLUMN IF NOT EXISTS reversal_of_txn_id UUID;

-- New rows are inserted with all trace fields by InventoryPostingService.
-- Existing data is deliberately not assigned a fabricated business date or
-- line id. The source string is only parsed into a human-readable bill number.
UPDATE inv_stock_txn
SET source_bill_no = CASE
        WHEN position(':' IN source_bill_type) > 0
            THEN NULLIF(btrim(substring(source_bill_type FROM position(':' IN source_bill_type) + 1)), '')
        ELSE NULL
    END,
    posting_action = CASE
        WHEN txn_type LIKE '%\_RED\_REVERSE' ESCAPE '\' THEN 'RED_REVERSE'
        WHEN txn_type LIKE '%\_RED' ESCAPE '\' THEN 'RED_AUDIT'
        WHEN txn_type LIKE '%\_RESERVE\_REVERSE' ESCAPE '\' THEN 'RELEASE'
        WHEN txn_type LIKE '%\_RESERVE' ESCAPE '\' THEN 'RESERVE'
        WHEN txn_type LIKE '%\_REVERSE' ESCAPE '\' THEN 'REVERSE'
        ELSE 'AUDIT'
    END,
    trace_quality = CASE
        WHEN source_bill_type ~ '^A[0-9]+' THEN 'TEST'
        ELSE 'LEGACY'
    END
WHERE trace_quality IS NULL;

-- Evolve existing tenant and backup tables before any restore can observe a
-- column mismatch. jdy_sync_tenant_schema supplies tenant columns and parity;
-- backup schemas are data-only snapshots and receive matching nullable shells.
DO $$
DECLARE
    target_schema TEXT;
BEGIN
    FOR target_schema IN
        SELECT DISTINCT btrim(schema_name)
        FROM public.sys_account_set
        WHERE nullif(btrim(schema_name), '') IS NOT NULL
          AND lower(btrim(schema_name)) <> 'public'
        ORDER BY 1
    LOOP
        IF target_schema !~ '^[a-z][a-z0-9_]{0,62}$' THEN
            RAISE EXCEPTION 'V106 tenant schema name is unsafe: schema=%', target_schema;
        END IF;
        PERFORM public.jdy_sync_tenant_schema(target_schema, FALSE);
    END LOOP;

    FOR target_schema IN
        SELECT DISTINCT btrim(backup_schema_name)
        FROM public.sys_account_set_backup
        WHERE nullif(btrim(backup_schema_name), '') IS NOT NULL
        ORDER BY 1
    LOOP
        IF target_schema !~ '^[a-z][a-z0-9_]{0,62}$' THEN
            RAISE EXCEPTION 'V106 backup schema name is unsafe: schema=%', target_schema;
        END IF;
        IF to_regclass(format('%I.inv_stock_txn', target_schema)) IS NULL THEN
            CONTINUE;
        END IF;
        EXECUTE format('ALTER TABLE %I.inv_stock_txn ADD COLUMN IF NOT EXISTS source_bill_no VARCHAR(80)', target_schema);
        EXECUTE format('ALTER TABLE %I.inv_stock_txn ADD COLUMN IF NOT EXISTS source_bill_date DATE', target_schema);
        EXECUTE format('ALTER TABLE %I.inv_stock_txn ADD COLUMN IF NOT EXISTS posting_action VARCHAR(24)', target_schema);
        EXECUTE format('ALTER TABLE %I.inv_stock_txn ADD COLUMN IF NOT EXISTS qty_on_hand_after NUMERIC(18, 4)', target_schema);
        EXECUTE format('ALTER TABLE %I.inv_stock_txn ADD COLUMN IF NOT EXISTS trace_quality VARCHAR(24)', target_schema);
        EXECUTE format('ALTER TABLE %I.inv_stock_txn ADD COLUMN IF NOT EXISTS reversal_of_txn_id UUID', target_schema);
    END LOOP;
END $$;

-- Backfill only headers that can be located by an exact, unique bill number.
-- This intentionally leaves source_bill_line_id NULL and marks HEADER_ONLY.
DO $$
DECLARE
    target_schema TEXT;
    mapping RECORD;
BEGIN
    FOR target_schema IN
        SELECT 'public'
        UNION ALL
        SELECT DISTINCT btrim(schema_name)
        FROM public.sys_account_set
        WHERE nullif(btrim(schema_name), '') IS NOT NULL
          AND lower(btrim(schema_name)) <> 'public'
        ORDER BY 1
    LOOP
        IF target_schema !~ '^[a-z][a-z0-9_]{0,62}$' THEN
            RAISE EXCEPTION 'V106 trace backfill schema is unsafe: schema=%', target_schema;
        END IF;
        IF to_regclass(format('%I.inv_stock_txn', target_schema)) IS NULL THEN
            CONTINUE;
        END IF;

        EXECUTE format($sql$
            UPDATE %1$I.inv_stock_txn
            SET source_bill_no = CASE
                    WHEN position(':' IN source_bill_type) > 0
                        THEN NULLIF(btrim(substring(source_bill_type FROM position(':' IN source_bill_type) + 1)), '')
                    ELSE source_bill_no
                END,
                posting_action = CASE
                    WHEN txn_type LIKE '%%\_RED\_REVERSE' ESCAPE '\' THEN 'RED_REVERSE'
                    WHEN txn_type LIKE '%%\_RED' ESCAPE '\' THEN 'RED_AUDIT'
                    WHEN txn_type LIKE '%%\_RESERVE\_REVERSE' ESCAPE '\' THEN 'RELEASE'
                    WHEN txn_type LIKE '%%\_RESERVE' ESCAPE '\' THEN 'RESERVE'
                    WHEN txn_type LIKE '%%\_REVERSE' ESCAPE '\' THEN 'REVERSE'
                    ELSE 'AUDIT'
                END,
                trace_quality = CASE
                    WHEN source_bill_type ~ '^A[0-9]+' THEN 'TEST'
                    ELSE 'LEGACY'
                END
            WHERE trace_quality IS NULL
        $sql$, target_schema);

        FOR mapping IN
            SELECT * FROM (VALUES
                ('PURCHASE_IN', 'purchase_in', 'bill_date'),
                ('PURCHASE_RETURN', 'purchase_return', 'bill_date'),
                ('SALES_OUT', 'sales_out', 'bill_date'),
                ('SALES_RETURN', 'sales_return', 'bill_date'),
                ('DELIVERY_NOTICE', 'delivery_notice', 'bill_date'),
                ('PRODUCTION_ISSUE', 'production_material_issue', 'created_at::date'),
                ('PRODUCTION_COMPLETION', 'production_completion', 'created_at::date'),
                ('OTHER_STOCK_IN', 'other_stock_in', 'bill_date'),
                ('OTHER_STOCK_OUT', 'other_stock_out', 'bill_date'),
                ('STOCK_TRANSFER', 'stock_transfer', 'bill_date'),
                ('STOCK_COUNT_GAIN', 'stock_count_gain', 'bill_date'),
                ('STOCK_COUNT_LOSS', 'stock_count_loss', 'bill_date'),
                ('OUTSOURCING_ISSUE', 'outsourcing_material_issue', 'bill_date'),
                ('OUTSOURCING_RECEIPT', 'outsourcing_receipt', 'bill_date'),
                ('OUTSOURCING_RETURN', 'outsourcing_return', 'bill_date'),
                ('OUTSOURCING_SCRAP', 'outsourcing_scrap', 'bill_date')
            ) AS values_row(source_prefix, header_table, date_expression)
        LOOP
            IF to_regclass(format('%I.%I', target_schema, mapping.header_table)) IS NULL THEN
                CONTINUE;
            END IF;
            EXECUTE format($sql$
                WITH unique_header AS (
                    SELECT bill_no, min(id::text)::uuid AS id, min(%3$s) AS bill_date
                    FROM %1$I.%2$I
                    GROUP BY bill_no
                    HAVING count(*) = 1
                )
                UPDATE %1$I.inv_stock_txn txn
                SET source_bill_id = header.id,
                    source_bill_no = header.bill_no,
                    source_bill_date = header.bill_date,
                    trace_quality = 'HEADER_ONLY'
                FROM unique_header header
                WHERE txn.source_bill_no = header.bill_no
                  AND split_part(txn.source_bill_type, ':', 1) LIKE %4$L || '%%'
                  AND txn.source_bill_line_id IS NULL
                  AND txn.trace_quality = 'LEGACY'
            $sql$, target_schema, mapping.header_table, mapping.date_expression, mapping.source_prefix);
        END LOOP;
    END LOOP;
END $$;

CREATE INDEX IF NOT EXISTS idx_inv_stock_txn_scope_business_time
    ON inv_stock_txn (account_set_id, source_bill_date DESC, occurred_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_inv_stock_txn_exact_source
    ON inv_stock_txn (account_set_id, source_bill_type, source_bill_id, source_bill_line_id);
CREATE INDEX IF NOT EXISTS idx_inv_stock_txn_reversal
    ON inv_stock_txn (account_set_id, reversal_of_txn_id)
    WHERE reversal_of_txn_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_inv_stock_txn_exact_posting_fact
    ON inv_stock_txn (
        account_set_id,
        source_bill_type,
        source_bill_id,
        source_bill_line_id,
        posting_action,
        txn_type
    )
    WHERE trace_quality = 'EXACT';

-- jdy_sync does not replicate ordinary indexes, so create the same bounded
-- indexes explicitly in each registered tenant schema.
DO $$
DECLARE
    target_schema TEXT;
BEGIN
    FOR target_schema IN
        SELECT DISTINCT btrim(schema_name)
        FROM public.sys_account_set
        WHERE nullif(btrim(schema_name), '') IS NOT NULL
          AND lower(btrim(schema_name)) <> 'public'
        ORDER BY 1
    LOOP
        EXECUTE format(
            'CREATE INDEX IF NOT EXISTS idx_inv_stock_txn_scope_business_time ON %I.inv_stock_txn (account_set_id, source_bill_date DESC, occurred_at DESC, id DESC)',
            target_schema
        );
        EXECUTE format(
            'CREATE INDEX IF NOT EXISTS idx_inv_stock_txn_exact_source ON %I.inv_stock_txn (account_set_id, source_bill_type, source_bill_id, source_bill_line_id)',
            target_schema
        );
        EXECUTE format(
            'CREATE INDEX IF NOT EXISTS idx_inv_stock_txn_reversal ON %I.inv_stock_txn (account_set_id, reversal_of_txn_id) WHERE reversal_of_txn_id IS NOT NULL',
            target_schema
        );
        EXECUTE format(
            'CREATE UNIQUE INDEX IF NOT EXISTS uq_inv_stock_txn_exact_posting_fact ON %I.inv_stock_txn (account_set_id, source_bill_type, source_bill_id, source_bill_line_id, posting_action, txn_type) WHERE trace_quality = ''EXACT''',
            target_schema
        );
    END LOOP;
END $$;
