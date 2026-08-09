-- A181 closes three persisted-data gaps found by visible UAT:
-- 1. cash-transfer facts need a lifecycle version so audit/reverse cycles remain
--    append-only without colliding on the original action-only unique key;
-- 2. purchase-order header remarks need a real persisted column;
-- 3. an AP reversal fact is no longer current after its source document has
--    been audited again. Preserve that row for audit history but exclude it
--    from current settlement/report facts with the REVERSED status.

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
            RAISE EXCEPTION 'V117 schema name is unsafe: schema=%', target_schema;
        END IF;

        IF to_regclass(format('%I.purchase_order', target_schema)) IS NOT NULL THEN
            EXECUTE format(
                'ALTER TABLE %I.purchase_order ADD COLUMN IF NOT EXISTS remark TEXT',
                target_schema
            );
        END IF;

        IF to_regclass(format('%I.cash_transfer_fact', target_schema)) IS NOT NULL THEN
            EXECUTE format(
                'ALTER TABLE %I.cash_transfer_fact ADD COLUMN IF NOT EXISTS posting_version BIGINT',
                target_schema
            );
            EXECUTE format($sql$
                UPDATE %1$I.cash_transfer_fact
                SET posting_version = CASE posting_action
                    WHEN 'AUDIT' THEN 1
                    WHEN 'REVERSE' THEN 2
                    ELSE 1
                END
                WHERE posting_version IS NULL
            $sql$, target_schema);
            EXECUTE format(
                'ALTER TABLE %I.cash_transfer_fact ALTER COLUMN posting_version SET DEFAULT 1',
                target_schema
            );
            EXECUTE format(
                'ALTER TABLE %I.cash_transfer_fact ALTER COLUMN posting_version SET NOT NULL',
                target_schema
            );
        END IF;

        IF to_regclass(format('%I.ap_payable', target_schema)) IS NOT NULL THEN
            IF to_regclass(format('%I.purchase_in', target_schema)) IS NOT NULL THEN
                EXECUTE format($sql$
                    UPDATE %1$I.ap_payable reversal
                    SET status = 'REVERSED',
                        updated_at = now()
                    WHERE reversal.bill_no = 'YF-CX-' || reversal.source_bill_no
                      AND reversal.paid_amount = 0
                      AND reversal.status <> 'REVERSED'
                      AND EXISTS (
                          SELECT 1
                          FROM %1$I.purchase_in source
                          WHERE source.bill_no = reversal.source_bill_no
                            AND source.status = 'AUDITED'
                      )
                $sql$, target_schema);
            END IF;
            IF to_regclass(format('%I.purchase_return', target_schema)) IS NOT NULL THEN
                EXECUTE format($sql$
                    UPDATE %1$I.ap_payable reversal
                    SET status = 'REVERSED',
                        updated_at = now()
                    WHERE reversal.bill_no = 'YF-TH-CX-' || reversal.source_bill_no
                      AND reversal.paid_amount = 0
                      AND reversal.status <> 'REVERSED'
                      AND EXISTS (
                          SELECT 1
                          FROM %1$I.purchase_return source
                          WHERE source.bill_no = reversal.source_bill_no
                            AND source.status = 'AUDITED'
                      )
                $sql$, target_schema);
            END IF;
        END IF;
    END LOOP;
END $$;

-- Historical backup schemas intentionally remain data-only. The live public
-- and tenant schemas retain exactly one unique fact key, now including the
-- lifecycle version. Constraint totals therefore do not change.
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
        ORDER BY 1
    LOOP
        IF target_schema !~ '^[a-z][a-z0-9_]{0,62}$' THEN
            RAISE EXCEPTION 'V117 live schema name is unsafe: schema=%', target_schema;
        END IF;
        IF to_regclass(format('%I.cash_transfer_fact', target_schema)) IS NULL THEN
            CONTINUE;
        END IF;
        EXECUTE format(
            'ALTER TABLE %I.cash_transfer_fact DROP CONSTRAINT IF EXISTS uq_cash_transfer_fact_leg',
            target_schema
        );
        EXECUTE format(
            'ALTER TABLE %I.cash_transfer_fact ADD CONSTRAINT uq_cash_transfer_fact_leg UNIQUE (cash_transfer_id, account_id, posting_action, posting_version)',
            target_schema
        );
    END LOOP;
END $$;
