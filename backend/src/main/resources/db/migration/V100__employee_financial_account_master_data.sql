CREATE SEQUENCE md_employee_system_no_seq START WITH 600000001;
CREATE SEQUENCE md_financial_account_system_no_seq START WITH 700000001;

CREATE TABLE md_employee (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    system_no BIGINT NOT NULL DEFAULT nextval('md_employee_system_no_seq'),
    code VARCHAR(80) NOT NULL,
    name VARCHAR(200) NOT NULL,
    position VARCHAR(120),
    department VARCHAR(160),
    phone VARCHAR(80),
    email VARCHAR(200),
    remark TEXT,
    enabled BOOLEAN NOT NULL DEFAULT TRUE,
    audit_status VARCHAR(40) NOT NULL DEFAULT 'DRAFT',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    version BIGINT NOT NULL DEFAULT 0,
    CONSTRAINT uq_md_employee_code UNIQUE (code),
    CONSTRAINT ck_md_employee_audit_status CHECK (audit_status IN ('DRAFT', 'AUDITED'))
);

CREATE UNIQUE INDEX uq_md_employee_system_no
    ON md_employee (system_no);

CREATE INDEX idx_md_employee_enabled_audit_code
    ON md_employee (enabled, audit_status, code);

CREATE TABLE md_financial_account (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    system_no BIGINT NOT NULL DEFAULT nextval('md_financial_account_system_no_seq'),
    code VARCHAR(80) NOT NULL,
    name VARCHAR(200) NOT NULL,
    account_type VARCHAR(40) NOT NULL,
    bank_name VARCHAR(200),
    account_no VARCHAR(120),
    account_holder VARCHAR(200),
    currency VARCHAR(8) NOT NULL DEFAULT 'CNY',
    remark TEXT,
    enabled BOOLEAN NOT NULL DEFAULT TRUE,
    audit_status VARCHAR(40) NOT NULL DEFAULT 'DRAFT',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    version BIGINT NOT NULL DEFAULT 0,
    CONSTRAINT uq_md_financial_account_code UNIQUE (code),
    CONSTRAINT ck_md_financial_account_type
        CHECK (account_type IN ('CASH', 'BANK', 'DEPOSIT')),
    CONSTRAINT ck_md_financial_account_currency
        CHECK (currency IN ('CNY', 'USD')),
    CONSTRAINT ck_md_financial_account_audit_status
        CHECK (audit_status IN ('DRAFT', 'AUDITED')),
    CONSTRAINT ck_md_financial_account_bank_fields
        CHECK (
            (
                account_type = 'CASH'
                AND bank_name IS NULL
                AND account_no IS NULL
                AND account_holder IS NULL
            )
            OR
            (
                account_type IN ('BANK', 'DEPOSIT')
                AND nullif(btrim(bank_name), '') IS NOT NULL
                AND nullif(btrim(account_no), '') IS NOT NULL
                AND nullif(btrim(account_holder), '') IS NOT NULL
            )
        )
);

CREATE UNIQUE INDEX uq_md_financial_account_system_no
    ON md_financial_account (system_no);

CREATE INDEX idx_md_financial_account_enabled_audit_code
    ON md_financial_account (enabled, audit_status, code);

ALTER TABLE sys_user_account_set
    ADD COLUMN employee_code VARCHAR(80);

ALTER TABLE sys_user_account_set
    ADD CONSTRAINT ck_sys_user_account_set_employee_code_nonblank
    CHECK (employee_code IS NULL OR nullif(btrim(employee_code), '') IS NOT NULL);

CREATE UNIQUE INDEX uq_sys_user_account_set_employee
    ON sys_user_account_set (account_set_id, employee_code)
    WHERE employee_code IS NOT NULL;

INSERT INTO sys_tenant_managed_table (table_name, restore_order)
VALUES
    ('md_employee', 135),
    ('md_financial_account', 136);

-- V99 deliberately keeps the implementation body under this versioned name and
-- wraps it with the four-exemption runtime guard. Evolve only the two exact
-- fail-closed totals here instead of weakening that wrapper or changing V98/V99.
DO $$
DECLARE
    sync_definition TEXT;
    evolved_definition TEXT;
BEGIN
    SELECT pg_get_functiondef(
        'public.jdy_sync_tenant_schema_v98(text,boolean)'::regprocedure
    )
    INTO sync_definition;

    IF sync_definition IS NULL
       OR position('IF managed_count <> 72 THEN' IN sync_definition) = 0
       OR position('tenant managed table catalog drifted: expected=72 actual=%' IN sync_definition) = 0
       OR position(
           'IF primary_count <> 72 OR unique_count <> 64 OR foreign_key_count <> 153 OR check_count <> 11 THEN'
           IN sync_definition
       ) = 0
       OR position(
           'tenant constraint count drifted: schema=% pk=% uk=% fk=% check=% expected=72/64/153/11'
           IN sync_definition
       ) = 0 THEN
        RAISE EXCEPTION 'V100 refused unexpected tenant sync function topology';
    END IF;

    evolved_definition := replace(
        sync_definition,
        'IF managed_count <> 72 THEN',
        'IF managed_count <> 74 THEN'
    );
    evolved_definition := replace(
        evolved_definition,
        'tenant managed table catalog drifted: expected=72 actual=%',
        'tenant managed table catalog drifted: expected=74 actual=%'
    );
    evolved_definition := replace(
        evolved_definition,
        'IF primary_count <> 72 OR unique_count <> 64 OR foreign_key_count <> 153 OR check_count <> 11 THEN',
        'IF primary_count <> 74 OR unique_count <> 66 OR foreign_key_count <> 153 OR check_count <> 16 THEN'
    );
    evolved_definition := replace(
        evolved_definition,
        'tenant constraint count drifted: schema=% pk=% uk=% fk=% check=% expected=72/64/153/11',
        'tenant constraint count drifted: schema=% pk=% uk=% fk=% check=% expected=74/66/153/16'
    );

    IF evolved_definition = sync_definition
       OR position('managed_count <> 72' IN evolved_definition) <> 0
       OR position('expected=72/64/153/11' IN evolved_definition) <> 0
       OR position('managed_count <> 74' IN evolved_definition) = 0
       OR position('expected=74/66/153/16' IN evolved_definition) = 0 THEN
        RAISE EXCEPTION 'V100 failed to evolve tenant sync function totals exactly once';
    END IF;

    EXECUTE evolved_definition;
END $$;

-- A backup created before V100 has no rows for either newly introduced master.
-- Add empty column-compatible tables so that the existing restore preflight can
-- still restore that backup without inventing employee or account data.
DO $$
DECLARE
    backup_schema TEXT;
BEGIN
    FOR backup_schema IN
        SELECT DISTINCT btrim(backup_schema_name)
        FROM public.sys_account_set_backup
        WHERE nullif(btrim(backup_schema_name), '') IS NOT NULL
        ORDER BY 1
    LOOP
        IF NOT EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = backup_schema) THEN
            CONTINUE;
        END IF;
        IF to_regclass(format('%I.%I', backup_schema, 'md_employee')) IS NULL THEN
            EXECUTE format(
                'CREATE TABLE %I.md_employee AS TABLE public.md_employee WITH NO DATA',
                backup_schema
            );
        END IF;
        IF to_regclass(format('%I.%I', backup_schema, 'md_financial_account')) IS NULL THEN
            EXECUTE format(
                'CREATE TABLE %I.md_financial_account AS TABLE public.md_financial_account WITH NO DATA',
                backup_schema
            );
        END IF;
    END LOOP;
END $$;

-- Existing tenant schemas must gain the two new tables before the strict
-- create_missing=FALSE synchronizer is allowed to inspect them. Any pre-existing
-- table is retained only long enough for that synchronizer to prove exact parity.
DO $$
DECLARE
    tenant_schema TEXT;
BEGIN
    FOR tenant_schema IN
        SELECT DISTINCT btrim(schema_name)
        FROM public.sys_account_set
        WHERE nullif(btrim(schema_name), '') IS NOT NULL
          AND lower(btrim(schema_name)) <> 'public'
        ORDER BY 1
    LOOP
        IF to_regclass(format('%I.%I', tenant_schema, 'md_employee')) IS NULL THEN
            EXECUTE format(
                'CREATE TABLE %I.md_employee (LIKE public.md_employee INCLUDING ALL)',
                tenant_schema
            );
        END IF;
        IF to_regclass(format('%I.%I', tenant_schema, 'md_financial_account')) IS NULL THEN
            EXECUTE format(
                'CREATE TABLE %I.md_financial_account (LIKE public.md_financial_account INCLUDING ALL)',
                tenant_schema
            );
        END IF;
        PERFORM public.jdy_sync_tenant_schema(tenant_schema, FALSE);
    END LOOP;
END $$;

-- The exact totals below are derived from the resulting DDL. The public schema
-- retains four platform account-set FKs that are intentionally omitted from
-- tenants, hence public FK=157 while every tenant FK=153.
DO $$
DECLARE
    managed_count INTEGER;
    primary_count INTEGER;
    unique_count INTEGER;
    foreign_key_count INTEGER;
    check_count INTEGER;
BEGIN
    SELECT count(*)::INTEGER
    INTO managed_count
    FROM public.sys_tenant_managed_table;

    SELECT count(*) FILTER (WHERE constraint_row.contype = 'p')::INTEGER,
           count(*) FILTER (WHERE constraint_row.contype = 'u')::INTEGER,
           count(*) FILTER (WHERE constraint_row.contype = 'f')::INTEGER,
           count(*) FILTER (WHERE constraint_row.contype = 'c')::INTEGER
    INTO primary_count, unique_count, foreign_key_count, check_count
    FROM pg_constraint constraint_row
    JOIN pg_class table_row ON table_row.oid = constraint_row.conrelid
    JOIN pg_namespace schema_row
      ON schema_row.oid = table_row.relnamespace
     AND schema_row.nspname = 'public'
    JOIN public.sys_tenant_managed_table managed
      ON managed.table_name = table_row.relname;

    IF managed_count <> 74
       OR primary_count <> 74
       OR unique_count <> 66
       OR foreign_key_count <> 157
       OR check_count <> 16 THEN
        RAISE EXCEPTION
            'V100 managed topology drifted: tables=% pk=% uk=% fk=% check=% expected=74/74/66/157/16',
            managed_count, primary_count, unique_count, foreign_key_count, check_count;
    END IF;
END $$;
