-- A142 introduces a formal sales-return fact.  A return offsets only the
-- still-unreceived portion of its source receivable; any excess remains an
-- explicit pending-refund fact.  Historical zero/negative AR rows remain
-- untouched and can never carry a return offset.

ALTER TABLE ar_receivable
    ADD COLUMN return_offset_amount NUMERIC(18, 2) NOT NULL DEFAULT 0,
    ADD CONSTRAINT ck_ar_receivable_return_offset
        CHECK (
            return_offset_amount >= 0
            AND (
                (amount > 0 AND received_amount >= 0 AND received_amount + return_offset_amount <= amount)
                OR (amount <= 0 AND return_offset_amount = 0)
            )
        );

CREATE TABLE sales_return (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    bill_no VARCHAR(80) NOT NULL,
    customer_id UUID NOT NULL,
    bill_date DATE NOT NULL,
    department VARCHAR(120),
    status VARCHAR(40) NOT NULL DEFAULT 'DRAFT',
    total_amount NUMERIC(18, 2) NOT NULL DEFAULT 0,
    currency VARCHAR(8) NOT NULL,
    owner_name VARCHAR(120),
    remark TEXT,
    close_status VARCHAR(40) NOT NULL DEFAULT 'OPEN',
    close_reason TEXT,
    closed_by UUID,
    closed_at TIMESTAMPTZ,
    frozen_status VARCHAR(40) NOT NULL DEFAULT 'NORMAL',
    frozen_reason TEXT,
    frozen_by UUID,
    frozen_at TIMESTAMPTZ,
    reversed_at TIMESTAMPTZ,
    voided_at TIMESTAMPTZ,
    void_reason TEXT,
    void_verified_username VARCHAR(80),
    void_verified_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    version BIGINT NOT NULL DEFAULT 0,
    CONSTRAINT fk_sales_return_customer
        FOREIGN KEY (customer_id) REFERENCES md_customer(id),
    CONSTRAINT uq_sales_return_bill_no UNIQUE (bill_no),
    CONSTRAINT ck_sales_return_status
        CHECK (status IN ('DRAFT', 'AUDITED', 'VOID')),
    CONSTRAINT ck_sales_return_currency
        CHECK (currency IN ('CNY', 'USD')),
    CONSTRAINT ck_sales_return_total_amount CHECK (total_amount >= 0),
    CONSTRAINT ck_sales_return_version CHECK (version >= 0),
    CONSTRAINT ck_sales_return_close_status
        CHECK (close_status IN ('OPEN', 'CLOSED')),
    CONSTRAINT ck_sales_return_frozen_status
        CHECK (frozen_status IN ('NORMAL', 'FROZEN'))
);

CREATE TABLE sales_return_line (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    bill_id UUID NOT NULL,
    line_no INTEGER NOT NULL,
    source_out_line_id UUID NOT NULL,
    source_out_no VARCHAR(80) NOT NULL,
    source_line_no INTEGER NOT NULL,
    product_id UUID NOT NULL,
    product_code_snapshot VARCHAR(80) NOT NULL,
    product_name_snapshot VARCHAR(200) NOT NULL,
    product_spec_snapshot VARCHAR(200),
    product_unit_snapshot VARCHAR(80),
    net_weight_snapshot NUMERIC(18, 4),
    gross_weight_snapshot NUMERIC(18, 4),
    warehouse_id UUID NOT NULL,
    qty NUMERIC(18, 4) NOT NULL,
    unit_price NUMERIC(18, 2) NOT NULL,
    amount NUMERIC(18, 2) NOT NULL,
    tax_rate NUMERIC(9, 4) NOT NULL DEFAULT 0,
    tax_amount NUMERIC(18, 2) NOT NULL DEFAULT 0,
    price_tax_total NUMERIC(18, 2) NOT NULL DEFAULT 0,
    line_remark TEXT,
    line_close_status VARCHAR(40) NOT NULL DEFAULT 'OPEN',
    line_close_reason TEXT,
    line_frozen_status VARCHAR(40) NOT NULL DEFAULT 'NORMAL',
    line_frozen_reason TEXT,
    CONSTRAINT fk_sales_return_line_bill
        FOREIGN KEY (bill_id) REFERENCES sales_return(id) ON DELETE CASCADE,
    CONSTRAINT fk_sales_return_line_source
        FOREIGN KEY (source_out_line_id) REFERENCES sales_out_line(id),
    CONSTRAINT fk_sales_return_line_product
        FOREIGN KEY (product_id) REFERENCES md_product(id),
    CONSTRAINT fk_sales_return_line_warehouse
        FOREIGN KEY (warehouse_id) REFERENCES md_warehouse(id),
    CONSTRAINT uq_sales_return_line_no UNIQUE (bill_id, line_no),
    CONSTRAINT uq_sales_return_line_source UNIQUE (bill_id, source_out_line_id),
    CONSTRAINT ck_sales_return_line_no CHECK (line_no > 0),
    CONSTRAINT ck_sales_return_line_source_no CHECK (source_line_no > 0),
    CONSTRAINT ck_sales_return_line_qty CHECK (qty > 0),
    CONSTRAINT ck_sales_return_line_unit_price CHECK (unit_price >= 0),
    CONSTRAINT ck_sales_return_line_amount CHECK (amount >= 0),
    CONSTRAINT ck_sales_return_line_tax_rate CHECK (tax_rate >= 0),
    CONSTRAINT ck_sales_return_line_tax_amount CHECK (tax_amount >= 0),
    CONSTRAINT ck_sales_return_line_price_tax_total CHECK (price_tax_total >= 0),
    CONSTRAINT ck_sales_return_line_close_status
        CHECK (line_close_status IN ('OPEN', 'CLOSED')),
    CONSTRAINT ck_sales_return_line_frozen_status
        CHECK (line_frozen_status IN ('NORMAL', 'FROZEN'))
);

CREATE TABLE sales_return_finance_allocation (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    sales_return_id UUID NOT NULL,
    receivable_id UUID NOT NULL,
    source_out_no VARCHAR(80) NOT NULL,
    receivable_bill_no VARCHAR(80) NOT NULL,
    currency VARCHAR(8) NOT NULL,
    source_amount NUMERIC(18, 2) NOT NULL,
    received_before NUMERIC(18, 2) NOT NULL,
    return_offset_before NUMERIC(18, 2) NOT NULL,
    unsettled_before NUMERIC(18, 2) NOT NULL,
    return_amount NUMERIC(18, 2) NOT NULL,
    offset_amount NUMERIC(18, 2) NOT NULL,
    pending_refund_amount NUMERIC(18, 2) NOT NULL,
    refunded_amount NUMERIC(18, 2) NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT fk_sales_return_finance_return
        FOREIGN KEY (sales_return_id) REFERENCES sales_return(id) ON DELETE CASCADE,
    CONSTRAINT fk_sales_return_finance_receivable
        FOREIGN KEY (receivable_id) REFERENCES ar_receivable(id),
    CONSTRAINT uq_sales_return_finance_source
        UNIQUE (sales_return_id, receivable_id),
    CONSTRAINT ck_sales_return_finance_currency
        CHECK (currency IN ('CNY', 'USD')),
    CONSTRAINT ck_sales_return_finance_amounts
        CHECK (
            source_amount > 0
            AND received_before >= 0
            AND return_offset_before >= 0
            AND unsettled_before >= 0
            AND return_amount >= 0
            AND offset_amount >= 0
            AND pending_refund_amount >= 0
            AND refunded_amount >= 0
        ),
    CONSTRAINT ck_sales_return_finance_split
        CHECK (
            return_amount = offset_amount + pending_refund_amount
            AND refunded_amount <= pending_refund_amount
        ),
    CONSTRAINT ck_sales_return_finance_snapshot
        CHECK (received_before + return_offset_before + unsettled_before = source_amount)
);

CREATE INDEX idx_sales_return_customer_date
    ON sales_return (customer_id, bill_date DESC);
CREATE INDEX idx_sales_return_status_date
    ON sales_return (status, bill_date DESC);
CREATE INDEX idx_sales_return_line_source
    ON sales_return_line (source_out_no, source_line_no);
CREATE INDEX idx_sales_return_line_source_id
    ON sales_return_line (source_out_line_id);
CREATE INDEX idx_sales_return_line_product_warehouse
    ON sales_return_line (product_id, warehouse_id);
CREATE INDEX idx_sales_return_finance_receivable
    ON sales_return_finance_allocation (receivable_id);
CREATE INDEX idx_sales_return_finance_pending
    ON sales_return_finance_allocation (pending_refund_amount, refunded_amount);

INSERT INTO sys_tenant_managed_table (table_name, restore_order)
VALUES
    ('sales_return', 391),
    ('sales_return_line', 392),
    ('sales_return_finance_allocation', 699);

-- Preserve V99's runtime exemption wrapper and evolve only the exact V102
-- fail-closed topology totals.  Three managed tables add three PKs, four UKs,
-- seven tenant-local FKs and twenty-one CHECK constraints.
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
       OR position('IF managed_count <> 78 THEN' IN sync_definition) = 0
       OR position('tenant managed table catalog drifted: expected=78 actual=%' IN sync_definition) = 0
       OR position(
           'IF primary_count <> 78 OR unique_count <> 72 OR foreign_key_count <> 163 OR check_count <> 43 THEN'
           IN sync_definition
       ) = 0
       OR position(
           'tenant constraint count drifted: schema=% pk=% uk=% fk=% check=% expected=78/72/163/43'
           IN sync_definition
       ) = 0 THEN
        RAISE EXCEPTION 'V103 refused unexpected tenant sync function topology';
    END IF;

    evolved_definition := replace(
        sync_definition,
        'IF managed_count <> 78 THEN',
        'IF managed_count <> 81 THEN'
    );
    evolved_definition := replace(
        evolved_definition,
        'tenant managed table catalog drifted: expected=78 actual=%',
        'tenant managed table catalog drifted: expected=81 actual=%'
    );
    evolved_definition := replace(
        evolved_definition,
        'IF primary_count <> 78 OR unique_count <> 72 OR foreign_key_count <> 163 OR check_count <> 43 THEN',
        'IF primary_count <> 81 OR unique_count <> 76 OR foreign_key_count <> 170 OR check_count <> 64 THEN'
    );
    evolved_definition := replace(
        evolved_definition,
        'tenant constraint count drifted: schema=% pk=% uk=% fk=% check=% expected=78/72/163/43',
        'tenant constraint count drifted: schema=% pk=% uk=% fk=% check=% expected=81/76/170/64'
    );

    IF evolved_definition = sync_definition
       OR position('managed_count <> 78' IN evolved_definition) <> 0
       OR position('expected=78/72/163/43' IN evolved_definition) <> 0
       OR position('managed_count <> 81' IN evolved_definition) = 0
       OR position('expected=81/76/170/64' IN evolved_definition) = 0 THEN
        RAISE EXCEPTION 'V103 failed to evolve tenant sync function totals exactly once';
    END IF;

    EXECUTE evolved_definition;
END $$;

-- Historical backup schemas are data-only snapshots.  Add the column and empty
-- new tables without inventing constraints; the restored tenant receives the
-- canonical V103 topology from the managed schema.
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
        IF backup_schema !~ '^[a-z][a-z0-9_]{0,62}$' THEN
            RAISE EXCEPTION 'V103 backup schema name is unsafe: schema=%', backup_schema;
        END IF;
        IF to_regclass(format('%I.ar_receivable', backup_schema)) IS NULL THEN
            RAISE EXCEPTION 'V103 backup schema lacks ar_receivable: schema=%', backup_schema;
        END IF;

        EXECUTE format(
            'ALTER TABLE %I.ar_receivable ADD COLUMN return_offset_amount NUMERIC(18, 2) NOT NULL DEFAULT 0',
            backup_schema
        );
        IF to_regclass(format('%I.sales_return', backup_schema)) IS NULL THEN
            EXECUTE format(
                'CREATE TABLE %I.sales_return AS TABLE public.sales_return WITH NO DATA',
                backup_schema
            );
        END IF;
        IF to_regclass(format('%I.sales_return_line', backup_schema)) IS NULL THEN
            EXECUTE format(
                'CREATE TABLE %I.sales_return_line AS TABLE public.sales_return_line WITH NO DATA',
                backup_schema
            );
        END IF;
        IF to_regclass(format('%I.sales_return_finance_allocation', backup_schema)) IS NULL THEN
            EXECUTE format(
                'CREATE TABLE %I.sales_return_finance_allocation AS TABLE public.sales_return_finance_allocation WITH NO DATA',
                backup_schema
            );
        END IF;
    END LOOP;
END $$;

-- Existing tenants receive the new column and table shells before strict
-- create_missing=FALSE synchronization proves exact column/constraint parity.
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
        IF tenant_schema !~ '^[a-z][a-z0-9_]{0,62}$' THEN
            RAISE EXCEPTION 'V103 tenant schema name is unsafe: schema=%', tenant_schema;
        END IF;
        IF to_regclass(format('%I.ar_receivable', tenant_schema)) IS NULL THEN
            RAISE EXCEPTION 'V103 tenant schema lacks ar_receivable: schema=%', tenant_schema;
        END IF;

        EXECUTE format(
            'ALTER TABLE %I.ar_receivable ADD COLUMN return_offset_amount NUMERIC(18, 2) NOT NULL DEFAULT 0',
            tenant_schema
        );
        IF to_regclass(format('%I.sales_return', tenant_schema)) IS NULL THEN
            EXECUTE format(
                'CREATE TABLE %I.sales_return (LIKE public.sales_return INCLUDING ALL)',
                tenant_schema
            );
        END IF;
        IF to_regclass(format('%I.sales_return_line', tenant_schema)) IS NULL THEN
            EXECUTE format(
                'CREATE TABLE %I.sales_return_line (LIKE public.sales_return_line INCLUDING ALL)',
                tenant_schema
            );
        END IF;
        IF to_regclass(format('%I.sales_return_finance_allocation', tenant_schema)) IS NULL THEN
            EXECUTE format(
                'CREATE TABLE %I.sales_return_finance_allocation (LIKE public.sales_return_finance_allocation INCLUDING ALL)',
                tenant_schema
            );
        END IF;
        PERFORM public.jdy_sync_tenant_schema(tenant_schema, FALSE);
    END LOOP;
END $$;

-- Public keeps the four deliberate platform-account-set FK exemptions, hence
-- its FK total remains four above every tenant.  Fail closed on exact V103 DDL.
DO $$
DECLARE
    managed_count INTEGER;
    primary_count INTEGER;
    unique_count INTEGER;
    foreign_key_count INTEGER;
    check_count INTEGER;
    invalid_ar_count BIGINT;
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

    IF managed_count <> 81
       OR primary_count <> 81
       OR unique_count <> 76
       OR foreign_key_count <> 174
       OR check_count <> 64 THEN
        RAISE EXCEPTION
            'V103 managed topology drifted: tables=% pk=% uk=% fk=% check=% expected=81/81/76/174/64',
            managed_count, primary_count, unique_count, foreign_key_count, check_count;
    END IF;

    SELECT count(*)
    INTO invalid_ar_count
    FROM ar_receivable
    WHERE return_offset_amount <> 0
       OR (amount > 0 AND received_amount + return_offset_amount > amount);
    IF invalid_ar_count <> 0 THEN
        RAISE EXCEPTION 'V103 receivable offset backfill failed: invalid_rows=%', invalid_ar_count;
    END IF;
END $$;
