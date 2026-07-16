-- F087 / A163: same-currency cash transfer.  The two new tables are empty
-- document/fact tables; no opening balance, FX, or historical financial data
-- is created or rewritten by this migration.

CREATE TABLE cash_transfer (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    bill_no VARCHAR(80) NOT NULL,
    bill_date DATE NOT NULL,
    source_account_id UUID NOT NULL,
    target_account_id UUID NOT NULL,
    currency VARCHAR(8) NOT NULL,
    amount NUMERIC(18, 2) NOT NULL DEFAULT 0,
    remark TEXT,
    status VARCHAR(40) NOT NULL DEFAULT 'DRAFT',
    audited_at TIMESTAMPTZ,
    reversed_at TIMESTAMPTZ,
    version BIGINT NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT fk_cash_transfer_source_account FOREIGN KEY (source_account_id) REFERENCES md_financial_account(id),
    CONSTRAINT fk_cash_transfer_target_account FOREIGN KEY (target_account_id) REFERENCES md_financial_account(id),
    CONSTRAINT uq_cash_transfer_bill_no UNIQUE (bill_no),
    CONSTRAINT ck_cash_transfer_currency CHECK (currency IN ('CNY', 'USD')),
    CONSTRAINT ck_cash_transfer_amount CHECK (amount >= 0),
    CONSTRAINT ck_cash_transfer_accounts_differ CHECK (source_account_id <> target_account_id),
    CONSTRAINT ck_cash_transfer_status CHECK (status IN ('DRAFT', 'AUDITED')),
    CONSTRAINT ck_cash_transfer_version CHECK (version >= 0),
    CONSTRAINT ck_cash_transfer_timestamps CHECK (
        updated_at >= created_at
        AND (audited_at IS NULL OR audited_at >= created_at)
        AND (reversed_at IS NULL OR reversed_at >= created_at)
    )
);

CREATE TABLE cash_transfer_fact (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    cash_transfer_id UUID NOT NULL REFERENCES cash_transfer(id) ON DELETE CASCADE,
    account_id UUID NOT NULL REFERENCES md_financial_account(id),
    currency VARCHAR(8) NOT NULL,
    amount_delta NUMERIC(18, 2) NOT NULL,
    posting_action VARCHAR(24) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT uq_cash_transfer_fact_leg UNIQUE (cash_transfer_id, account_id, posting_action),
    CONSTRAINT ck_cash_transfer_fact_currency CHECK (currency IN ('CNY', 'USD')),
    CONSTRAINT ck_cash_transfer_fact_delta CHECK (amount_delta <> 0)
);

CREATE INDEX idx_cash_transfer_status_date ON cash_transfer (status, bill_date DESC, id DESC);
CREATE INDEX idx_cash_transfer_source_date ON cash_transfer (source_account_id, bill_date DESC, id DESC);
CREATE INDEX idx_cash_transfer_target_date ON cash_transfer (target_account_id, bill_date DESC, id DESC);
CREATE INDEX idx_cash_transfer_fact_account ON cash_transfer_fact (account_id, currency, created_at DESC);

INSERT INTO sys_permission_catalog (permission_code, module_name, permission_name, sort_no, enabled)
VALUES ('finance.cash_transfer.audit', '应收应付', '资金转账审核', 63, TRUE)
ON CONFLICT (permission_code) DO UPDATE
SET module_name = EXCLUDED.module_name,
    permission_name = EXCLUDED.permission_name,
    sort_no = EXCLUDED.sort_no,
    enabled = EXCLUDED.enabled;

INSERT INTO sys_permission (role_id, permission_code, enabled)
SELECT id, 'finance.cash_transfer.audit', TRUE
FROM sys_role
WHERE code IN ('ADMIN', 'FINANCE')
ON CONFLICT (role_id, permission_code) DO UPDATE SET enabled = EXCLUDED.enabled;

INSERT INTO sys_tenant_managed_table (table_name, restore_order)
VALUES
    ('cash_transfer', 723),
    ('cash_transfer_fact', 724);

-- Evolve the V99-wrapped strict tenant synchronizer once.  The two tables add
-- two PKs, two UNIQUE constraints, four tenant-local FKs and eight CHECKs.
DO $$
DECLARE
    sync_definition TEXT;
    evolved_definition TEXT;
BEGIN
    SELECT pg_get_functiondef('public.jdy_sync_tenant_schema_v98(text,boolean)'::regprocedure)
    INTO sync_definition;

    IF sync_definition IS NULL
       OR position('IF managed_count <> 84 THEN' IN sync_definition) = 0
       OR position('IF primary_count <> 84 OR unique_count <> 79 OR foreign_key_count <> 176 OR check_count <> 97 THEN' IN sync_definition) = 0
       OR position('RETURN managed_count;' IN sync_definition) = 0 THEN
        RAISE EXCEPTION 'V109 refused unexpected tenant sync function topology';
    END IF;

    evolved_definition := replace(sync_definition, 'IF managed_count <> 84 THEN', 'IF managed_count <> 86 THEN');
    evolved_definition := replace(evolved_definition, 'tenant managed table catalog drifted: expected=84 actual=%', 'tenant managed table catalog drifted: expected=86 actual=%');
    evolved_definition := replace(
        evolved_definition,
        'IF primary_count <> 84 OR unique_count <> 79 OR foreign_key_count <> 176 OR check_count <> 97 THEN',
        'IF primary_count <> 86 OR unique_count <> 81 OR foreign_key_count <> 180 OR check_count <> 105 THEN'
    );
    evolved_definition := replace(
        evolved_definition,
        'tenant constraint count drifted: schema=% pk=% uk=% fk=% check=% expected=84/79/176/97',
        'tenant constraint count drifted: schema=% pk=% uk=% fk=% check=% expected=86/81/180/105'
    );
    evolved_definition := replace(
        evolved_definition,
        'RETURN managed_count;',
        $indexes$
        EXECUTE format('CREATE INDEX IF NOT EXISTS idx_cash_transfer_status_date ON %I.cash_transfer (status, bill_date DESC, id DESC)', tenant_schema);
        EXECUTE format('CREATE INDEX IF NOT EXISTS idx_cash_transfer_source_date ON %I.cash_transfer (source_account_id, bill_date DESC, id DESC)', tenant_schema);
        EXECUTE format('CREATE INDEX IF NOT EXISTS idx_cash_transfer_target_date ON %I.cash_transfer (target_account_id, bill_date DESC, id DESC)', tenant_schema);
        EXECUTE format('CREATE INDEX IF NOT EXISTS idx_cash_transfer_fact_account ON %I.cash_transfer_fact (account_id, currency, created_at DESC)', tenant_schema);
        RETURN managed_count;
$indexes$
    );

    IF evolved_definition = sync_definition
       OR position('expected=84/79/176/97' IN evolved_definition) <> 0
       OR position('expected=86/81/180/105' IN evolved_definition) = 0
       OR position('idx_cash_transfer_status_date' IN evolved_definition) = 0 THEN
        RAISE EXCEPTION 'V109 failed to evolve tenant sync function totals exactly once';
    END IF;
    EXECUTE evolved_definition;
END $$;

DO $$
DECLARE
    target_schema TEXT;
BEGIN
    FOR target_schema IN
        SELECT DISTINCT btrim(backup_schema_name) FROM public.sys_account_set_backup
        WHERE nullif(btrim(backup_schema_name), '') IS NOT NULL
        ORDER BY 1
    LOOP
        IF target_schema !~ '^[a-z][a-z0-9_]{0,62}$' THEN
            RAISE EXCEPTION 'V109 schema name is unsafe: schema=%', target_schema;
        END IF;
        IF to_regclass(format('%I.cash_transfer', target_schema)) IS NULL THEN
            EXECUTE format('CREATE TABLE %I.cash_transfer AS TABLE public.cash_transfer WITH NO DATA', target_schema);
        END IF;
        IF to_regclass(format('%I.cash_transfer_fact', target_schema)) IS NULL THEN
            EXECUTE format('CREATE TABLE %I.cash_transfer_fact AS TABLE public.cash_transfer_fact WITH NO DATA', target_schema);
        END IF;
    END LOOP;

    FOR target_schema IN
        SELECT DISTINCT btrim(schema_name) FROM public.sys_account_set
        WHERE nullif(btrim(schema_name), '') IS NOT NULL AND lower(btrim(schema_name)) <> 'public'
        ORDER BY 1
    LOOP
        IF target_schema !~ '^[a-z][a-z0-9_]{0,62}$' THEN
            RAISE EXCEPTION 'V109 tenant schema name is unsafe: schema=%', target_schema;
        END IF;
        IF to_regclass(format('%I.cash_transfer', target_schema)) IS NULL THEN
            EXECUTE format('CREATE TABLE %I.cash_transfer (LIKE public.cash_transfer INCLUDING ALL)', target_schema);
        END IF;
        IF to_regclass(format('%I.cash_transfer_fact', target_schema)) IS NULL THEN
            EXECUTE format('CREATE TABLE %I.cash_transfer_fact (LIKE public.cash_transfer_fact INCLUDING ALL)', target_schema);
        END IF;
        PERFORM public.jdy_sync_tenant_schema(target_schema, FALSE);
    END LOOP;
END $$;

DO $$
DECLARE
    managed_count INTEGER;
    primary_count INTEGER;
    unique_count INTEGER;
    foreign_key_count INTEGER;
    check_count INTEGER;
BEGIN
    SELECT count(*)::INTEGER INTO managed_count FROM public.sys_tenant_managed_table;
    SELECT count(*) FILTER (WHERE c.contype = 'p')::INTEGER,
           count(*) FILTER (WHERE c.contype = 'u')::INTEGER,
           count(*) FILTER (WHERE c.contype = 'f')::INTEGER,
           count(*) FILTER (WHERE c.contype = 'c')::INTEGER
    INTO primary_count, unique_count, foreign_key_count, check_count
    FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace AND n.nspname = 'public'
    JOIN public.sys_tenant_managed_table m ON m.table_name = t.relname;
    IF managed_count <> 86 OR primary_count <> 86 OR unique_count <> 81 OR foreign_key_count <> 184 OR check_count <> 105 THEN
        RAISE EXCEPTION 'V109 managed topology drifted: expected=86/86/81/184/105';
    END IF;
END $$;
