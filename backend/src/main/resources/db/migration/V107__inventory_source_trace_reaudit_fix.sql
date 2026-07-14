-- A147 forward-only correction for the V106 shape already published to a
-- shared development database. Never rewrite V106 or repair its history:
-- remove the cycle-blocking unique index, cover every registered backup, and
-- repair the historical product-completion source prefix conservatively.

DO $$
DECLARE
    target_schema TEXT;
BEGIN
    FOR target_schema IN
        SELECT 'public'
        UNION
        SELECT DISTINCT btrim(schema_name)
        FROM public.sys_account_set
        WHERE nullif(btrim(schema_name), '') IS NOT NULL
          AND lower(btrim(schema_name)) <> 'public'
        UNION
        SELECT DISTINCT btrim(backup_schema_name)
        FROM public.sys_account_set_backup
        WHERE nullif(btrim(backup_schema_name), '') IS NOT NULL
        ORDER BY 1
    LOOP
        IF target_schema !~ '^[a-z][a-z0-9_]{0,62}$' THEN
            RAISE EXCEPTION 'V107 inventory trace schema is unsafe: schema=%', target_schema;
        END IF;
        IF to_regclass(format('%I.inv_stock_txn', target_schema)) IS NULL THEN
            CONTINUE;
        END IF;

        EXECUTE format(
            'DROP INDEX IF EXISTS %I.%I',
            target_schema,
            'uq_inv_stock_txn_exact_posting_fact'
        );
        EXECUTE format(
            'DROP INDEX IF EXISTS %I.%I',
            target_schema,
            'idx_inv_stock_txn_exact_posting_fact'
        );
        EXECUTE format(
            'CREATE INDEX %I ON %I.inv_stock_txn (account_set_id, source_bill_type, source_bill_id, source_bill_line_id, posting_action, txn_type) WHERE trace_quality = ''EXACT''',
            'idx_inv_stock_txn_exact_posting_fact',
            target_schema
        );
    END LOOP;
END $$;

-- V106 classified public and live tenant history, but its published form only
-- added nullable columns to backup tables. Classify registered backups here,
-- then perform header-only backfill in public/live/backup schemas. The mapping
-- deliberately never writes source_bill_line_id.
DO $$
DECLARE
    target_schema TEXT;
    mapping RECORD;
BEGIN
    FOR target_schema IN
        SELECT 'public'
        UNION
        SELECT DISTINCT btrim(schema_name)
        FROM public.sys_account_set
        WHERE nullif(btrim(schema_name), '') IS NOT NULL
          AND lower(btrim(schema_name)) <> 'public'
        UNION
        SELECT DISTINCT btrim(backup_schema_name)
        FROM public.sys_account_set_backup
        WHERE nullif(btrim(backup_schema_name), '') IS NOT NULL
        ORDER BY 1
    LOOP
        IF target_schema !~ '^[a-z][a-z0-9_]{0,62}$' THEN
            RAISE EXCEPTION 'V107 inventory trace backfill schema is unsafe: schema=%', target_schema;
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
                ('PRODUCTION_ISSUE', 'production_material_issue', '(created_at AT TIME ZONE ''Asia/Shanghai'')::date'),
                ('PRODUCTION_COMPLETE', 'production_completion', '(created_at AT TIME ZONE ''Asia/Shanghai'')::date'),
                ('PRODUCTION_COMPLETION', 'production_completion', '(created_at AT TIME ZONE ''Asia/Shanghai'')::date'),
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

-- V106 used the database session time zone when it derived production dates
-- from timestamptz headers. Repair only already-resolved HEADER_ONLY history by
-- its persisted header id; the historical line id remains deliberately NULL.
DO $$
DECLARE
    target_schema TEXT;
    mapping RECORD;
BEGIN
    FOR target_schema IN
        SELECT 'public'
        UNION
        SELECT DISTINCT btrim(schema_name)
        FROM public.sys_account_set
        WHERE nullif(btrim(schema_name), '') IS NOT NULL
          AND lower(btrim(schema_name)) <> 'public'
        UNION
        SELECT DISTINCT btrim(backup_schema_name)
        FROM public.sys_account_set_backup
        WHERE nullif(btrim(backup_schema_name), '') IS NOT NULL
        ORDER BY 1
    LOOP
        IF target_schema !~ '^[a-z][a-z0-9_]{0,62}$' THEN
            RAISE EXCEPTION 'V107 production date repair schema is unsafe: schema=%', target_schema;
        END IF;
        IF to_regclass(format('%I.inv_stock_txn', target_schema)) IS NULL THEN
            CONTINUE;
        END IF;

        FOR mapping IN
            SELECT * FROM (VALUES
                ('PRODUCTION_ISSUE', 'production_material_issue'),
                ('PRODUCTION_COMPLETE', 'production_completion'),
                ('PRODUCTION_COMPLETION', 'production_completion')
            ) AS values_row(source_prefix, header_table)
        LOOP
            IF to_regclass(format('%I.%I', target_schema, mapping.header_table)) IS NULL THEN
                CONTINUE;
            END IF;
            EXECUTE format($sql$
                UPDATE %1$I.inv_stock_txn txn
                SET source_bill_date = (header.created_at AT TIME ZONE 'Asia/Shanghai')::date
                FROM %1$I.%2$I header
                WHERE txn.source_bill_id = header.id
                  AND txn.source_bill_line_id IS NULL
                  AND txn.trace_quality = 'HEADER_ONLY'
                  AND split_part(txn.source_bill_type, ':', 1) LIKE %3$L || '%%'
            $sql$, target_schema, mapping.header_table, mapping.source_prefix);
        END LOOP;
    END LOOP;
END $$;
