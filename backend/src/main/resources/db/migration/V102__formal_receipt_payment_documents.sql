-- A141 turns the V5 immediate-settlement rows into read-only legacy formal
-- documents while preserving their original ids, numbers, dates, amounts and
-- source links.  No statement in this migration changes an AR/AP settled total.

ALTER TABLE sales_order
    ADD COLUMN currency VARCHAR(8) NOT NULL DEFAULT 'CNY',
    ADD CONSTRAINT ck_sales_order_currency CHECK (currency IN ('CNY', 'USD'));

ALTER TABLE delivery_notice
    ADD COLUMN currency VARCHAR(8) NOT NULL DEFAULT 'CNY',
    ADD CONSTRAINT ck_delivery_notice_currency CHECK (currency IN ('CNY', 'USD'));

ALTER TABLE sales_out
    ADD COLUMN currency VARCHAR(8) NOT NULL DEFAULT 'CNY',
    ADD CONSTRAINT ck_sales_out_currency CHECK (currency IN ('CNY', 'USD'));

ALTER TABLE purchase_order
    ADD COLUMN currency VARCHAR(8) NOT NULL DEFAULT 'CNY',
    ADD CONSTRAINT ck_purchase_order_currency CHECK (currency IN ('CNY', 'USD'));

ALTER TABLE purchase_in
    ADD COLUMN currency VARCHAR(8) NOT NULL DEFAULT 'CNY',
    ADD CONSTRAINT ck_purchase_in_currency CHECK (currency IN ('CNY', 'USD'));

ALTER TABLE ar_receivable
    ADD COLUMN currency VARCHAR(8) NOT NULL DEFAULT 'CNY',
    ADD CONSTRAINT ck_ar_receivable_currency CHECK (currency IN ('CNY', 'USD'));

ALTER TABLE ap_payable
    ADD COLUMN currency VARCHAR(8) NOT NULL DEFAULT 'CNY',
    ADD CONSTRAINT ck_ap_payable_currency CHECK (currency IN ('CNY', 'USD'));

ALTER TABLE ar_receipt RENAME COLUMN receivable_id TO legacy_receivable_id;
ALTER TABLE ar_receipt RENAME COLUMN receipt_date TO bill_date;
ALTER TABLE ar_receipt
    ADD COLUMN party_id UUID,
    ADD COLUMN currency VARCHAR(8) NOT NULL DEFAULT 'CNY',
    ADD COLUMN status VARCHAR(40) NOT NULL DEFAULT 'DRAFT',
    ADD COLUMN version BIGINT NOT NULL DEFAULT 0,
    ADD COLUMN remark TEXT,
    ADD COLUMN legacy_imported BOOLEAN NOT NULL DEFAULT FALSE,
    ADD COLUMN updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    ADD COLUMN audited_at TIMESTAMPTZ,
    ADD COLUMN audited_by UUID;

UPDATE ar_receipt receipt
SET party_id = receivable.customer_id,
    currency = receivable.currency,
    status = 'AUDITED',
    legacy_imported = TRUE,
    updated_at = receipt.created_at,
    audited_at = receipt.created_at
FROM ar_receivable receivable
WHERE receivable.id = receipt.legacy_receivable_id;

DO $$
DECLARE
    orphan_count BIGINT;
BEGIN
    SELECT count(*)
    INTO orphan_count
    FROM ar_receipt
    WHERE party_id IS NULL;
    IF orphan_count <> 0 THEN
        RAISE EXCEPTION 'V102 refused orphan public legacy receipts: count=%', orphan_count;
    END IF;
END $$;

ALTER TABLE ar_receipt
    ALTER COLUMN party_id SET NOT NULL,
    ALTER COLUMN legacy_receivable_id DROP NOT NULL,
    ADD CONSTRAINT fk_ar_receipt_party
        FOREIGN KEY (party_id) REFERENCES md_customer(id),
    ADD CONSTRAINT ck_ar_receipt_currency
        CHECK (currency IN ('CNY', 'USD')),
    ADD CONSTRAINT ck_ar_receipt_status
        CHECK (status IN ('DRAFT', 'AUDITED')),
    ADD CONSTRAINT ck_ar_receipt_version
        CHECK (version >= 0),
    ADD CONSTRAINT ck_ar_receipt_amount
        CHECK (amount >= 0);

ALTER TABLE ap_payment RENAME COLUMN payable_id TO legacy_payable_id;
ALTER TABLE ap_payment RENAME COLUMN payment_date TO bill_date;
ALTER TABLE ap_payment
    ADD COLUMN party_id UUID,
    ADD COLUMN currency VARCHAR(8) NOT NULL DEFAULT 'CNY',
    ADD COLUMN status VARCHAR(40) NOT NULL DEFAULT 'DRAFT',
    ADD COLUMN version BIGINT NOT NULL DEFAULT 0,
    ADD COLUMN remark TEXT,
    ADD COLUMN legacy_imported BOOLEAN NOT NULL DEFAULT FALSE,
    ADD COLUMN updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    ADD COLUMN audited_at TIMESTAMPTZ,
    ADD COLUMN audited_by UUID;

UPDATE ap_payment payment
SET party_id = payable.supplier_id,
    currency = payable.currency,
    status = 'AUDITED',
    legacy_imported = TRUE,
    updated_at = payment.created_at,
    audited_at = payment.created_at
FROM ap_payable payable
WHERE payable.id = payment.legacy_payable_id;

DO $$
DECLARE
    orphan_count BIGINT;
BEGIN
    SELECT count(*)
    INTO orphan_count
    FROM ap_payment
    WHERE party_id IS NULL;
    IF orphan_count <> 0 THEN
        RAISE EXCEPTION 'V102 refused orphan public legacy payments: count=%', orphan_count;
    END IF;
END $$;

ALTER TABLE ap_payment
    ALTER COLUMN party_id SET NOT NULL,
    ALTER COLUMN legacy_payable_id DROP NOT NULL,
    ADD CONSTRAINT fk_ap_payment_party
        FOREIGN KEY (party_id) REFERENCES md_supplier(id),
    ADD CONSTRAINT ck_ap_payment_currency
        CHECK (currency IN ('CNY', 'USD')),
    ADD CONSTRAINT ck_ap_payment_status
        CHECK (status IN ('DRAFT', 'AUDITED')),
    ADD CONSTRAINT ck_ap_payment_version
        CHECK (version >= 0),
    ADD CONSTRAINT ck_ap_payment_amount
        CHECK (amount >= 0);

CREATE TABLE ar_receipt_fund_line (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    receipt_id UUID NOT NULL,
    line_no INTEGER NOT NULL,
    account_id UUID NOT NULL,
    payment_method VARCHAR(40) NOT NULL,
    amount NUMERIC(18, 2) NOT NULL,
    fee NUMERIC(18, 2) NOT NULL DEFAULT 0,
    transaction_no VARCHAR(120),
    remark TEXT,
    CONSTRAINT fk_ar_receipt_fund_line_receipt
        FOREIGN KEY (receipt_id) REFERENCES ar_receipt(id) ON DELETE CASCADE,
    CONSTRAINT fk_ar_receipt_fund_line_account
        FOREIGN KEY (account_id) REFERENCES md_financial_account(id),
    CONSTRAINT uq_ar_receipt_fund_line_no UNIQUE (receipt_id, line_no),
    CONSTRAINT ck_ar_receipt_fund_line_no CHECK (line_no > 0),
    CONSTRAINT ck_ar_receipt_fund_payment_method
        CHECK (payment_method IN ('CASH', 'BANK_TRANSFER', 'OTHER')),
    CONSTRAINT ck_ar_receipt_fund_amount CHECK (amount >= 0),
    CONSTRAINT ck_ar_receipt_fund_fee CHECK (fee = 0)
);

CREATE INDEX idx_ar_receipt_fund_line_account
    ON ar_receipt_fund_line (account_id);

CREATE TABLE ar_receipt_allocation (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    receipt_id UUID NOT NULL,
    line_no INTEGER NOT NULL,
    receivable_id UUID NOT NULL,
    source_amount NUMERIC(18, 2) NOT NULL,
    settled_before NUMERIC(18, 2) NOT NULL,
    unsettled_before NUMERIC(18, 2) NOT NULL,
    settlement_amount NUMERIC(18, 2) NOT NULL,
    remark TEXT,
    CONSTRAINT fk_ar_receipt_allocation_receipt
        FOREIGN KEY (receipt_id) REFERENCES ar_receipt(id) ON DELETE CASCADE,
    CONSTRAINT fk_ar_receipt_allocation_source
        FOREIGN KEY (receivable_id) REFERENCES ar_receivable(id),
    CONSTRAINT uq_ar_receipt_allocation_line_no UNIQUE (receipt_id, line_no),
    CONSTRAINT uq_ar_receipt_allocation_source UNIQUE (receipt_id, receivable_id),
    CONSTRAINT ck_ar_receipt_allocation_line_no CHECK (line_no > 0),
    CONSTRAINT ck_ar_receipt_allocation_amounts CHECK (
        source_amount >= 0
        AND settled_before >= 0
        AND unsettled_before >= 0
        AND settlement_amount >= 0
    )
);

CREATE INDEX idx_ar_receipt_allocation_source
    ON ar_receipt_allocation (receivable_id);

CREATE TABLE ap_payment_fund_line (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    payment_id UUID NOT NULL,
    line_no INTEGER NOT NULL,
    account_id UUID NOT NULL,
    payment_method VARCHAR(40) NOT NULL,
    amount NUMERIC(18, 2) NOT NULL,
    fee NUMERIC(18, 2) NOT NULL DEFAULT 0,
    transaction_no VARCHAR(120),
    remark TEXT,
    CONSTRAINT fk_ap_payment_fund_line_payment
        FOREIGN KEY (payment_id) REFERENCES ap_payment(id) ON DELETE CASCADE,
    CONSTRAINT fk_ap_payment_fund_line_account
        FOREIGN KEY (account_id) REFERENCES md_financial_account(id),
    CONSTRAINT uq_ap_payment_fund_line_no UNIQUE (payment_id, line_no),
    CONSTRAINT ck_ap_payment_fund_line_no CHECK (line_no > 0),
    CONSTRAINT ck_ap_payment_fund_payment_method
        CHECK (payment_method IN ('CASH', 'BANK_TRANSFER', 'OTHER')),
    CONSTRAINT ck_ap_payment_fund_amount CHECK (amount >= 0),
    CONSTRAINT ck_ap_payment_fund_fee CHECK (fee = 0)
);

CREATE INDEX idx_ap_payment_fund_line_account
    ON ap_payment_fund_line (account_id);

CREATE TABLE ap_payment_allocation (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    payment_id UUID NOT NULL,
    line_no INTEGER NOT NULL,
    payable_id UUID NOT NULL,
    source_amount NUMERIC(18, 2) NOT NULL,
    settled_before NUMERIC(18, 2) NOT NULL,
    unsettled_before NUMERIC(18, 2) NOT NULL,
    settlement_amount NUMERIC(18, 2) NOT NULL,
    remark TEXT,
    CONSTRAINT fk_ap_payment_allocation_payment
        FOREIGN KEY (payment_id) REFERENCES ap_payment(id) ON DELETE CASCADE,
    CONSTRAINT fk_ap_payment_allocation_source
        FOREIGN KEY (payable_id) REFERENCES ap_payable(id),
    CONSTRAINT uq_ap_payment_allocation_line_no UNIQUE (payment_id, line_no),
    CONSTRAINT uq_ap_payment_allocation_source UNIQUE (payment_id, payable_id),
    CONSTRAINT ck_ap_payment_allocation_line_no CHECK (line_no > 0),
    CONSTRAINT ck_ap_payment_allocation_amounts CHECK (
        source_amount >= 0
        AND settled_before >= 0
        AND unsettled_before >= 0
        AND settlement_amount >= 0
    )
);

CREATE INDEX idx_ap_payment_allocation_source
    ON ap_payment_allocation (payable_id);

WITH receipt_history AS (
    SELECT receipt.id AS receipt_id,
           receipt.legacy_receivable_id AS receivable_id,
           receivable.amount AS source_amount,
           receipt.amount AS settlement_amount,
           COALESCE(
               sum(receipt.amount) OVER (
                   PARTITION BY receipt.legacy_receivable_id
                   ORDER BY receipt.bill_date, receipt.created_at, receipt.id
                   ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING
               ),
               0
           ) AS prior_settled
    FROM ar_receipt receipt
    JOIN ar_receivable receivable ON receivable.id = receipt.legacy_receivable_id
    WHERE receipt.legacy_imported
)
INSERT INTO ar_receipt_allocation (
    receipt_id, line_no, receivable_id, source_amount,
    settled_before, unsettled_before, settlement_amount
)
SELECT receipt_id,
       1,
       receivable_id,
       source_amount,
       LEAST(source_amount, prior_settled),
       GREATEST(source_amount - prior_settled, 0),
       settlement_amount
FROM receipt_history;

WITH payment_history AS (
    SELECT payment.id AS payment_id,
           payment.legacy_payable_id AS payable_id,
           payable.amount AS source_amount,
           payment.amount AS settlement_amount,
           COALESCE(
               sum(payment.amount) OVER (
                   PARTITION BY payment.legacy_payable_id
                   ORDER BY payment.bill_date, payment.created_at, payment.id
                   ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING
               ),
               0
           ) AS prior_settled
    FROM ap_payment payment
    JOIN ap_payable payable ON payable.id = payment.legacy_payable_id
    WHERE payment.legacy_imported
)
INSERT INTO ap_payment_allocation (
    payment_id, line_no, payable_id, source_amount,
    settled_before, unsettled_before, settlement_amount
)
SELECT payment_id,
       1,
       payable_id,
       source_amount,
       LEAST(source_amount, prior_settled),
       GREATEST(source_amount - prior_settled, 0),
       settlement_amount
FROM payment_history;

CREATE INDEX idx_ar_receipt_party_date
    ON ar_receipt (party_id, bill_date DESC);
CREATE INDEX idx_ar_receipt_status_date
    ON ar_receipt (status, bill_date DESC);
CREATE INDEX idx_ap_payment_party_date
    ON ap_payment (party_id, bill_date DESC);
CREATE INDEX idx_ap_payment_status_date
    ON ap_payment (status, bill_date DESC);

INSERT INTO sys_tenant_managed_table (table_name, restore_order)
VALUES
    ('ar_receipt_fund_line', 701),
    ('ar_receipt_allocation', 702),
    ('ap_payment_fund_line', 721),
    ('ap_payment_allocation', 722);

-- Preserve V99's runtime exemption wrapper.  Only evolve the exact fail-closed
-- totals in the V98 implementation body; V98/V99/V100 remain immutable.
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
       OR position('IF managed_count <> 74 THEN' IN sync_definition) = 0
       OR position('tenant managed table catalog drifted: expected=74 actual=%' IN sync_definition) = 0
       OR position(
           'IF primary_count <> 74 OR unique_count <> 66 OR foreign_key_count <> 153 OR check_count <> 16 THEN'
           IN sync_definition
       ) = 0
       OR position(
           'tenant constraint count drifted: schema=% pk=% uk=% fk=% check=% expected=74/66/153/16'
           IN sync_definition
       ) = 0 THEN
        RAISE EXCEPTION 'V102 refused unexpected tenant sync function topology';
    END IF;

    evolved_definition := replace(
        sync_definition,
        'IF managed_count <> 74 THEN',
        'IF managed_count <> 78 THEN'
    );
    evolved_definition := replace(
        evolved_definition,
        'tenant managed table catalog drifted: expected=74 actual=%',
        'tenant managed table catalog drifted: expected=78 actual=%'
    );
    evolved_definition := replace(
        evolved_definition,
        'IF primary_count <> 74 OR unique_count <> 66 OR foreign_key_count <> 153 OR check_count <> 16 THEN',
        'IF primary_count <> 78 OR unique_count <> 72 OR foreign_key_count <> 163 OR check_count <> 43 THEN'
    );
    evolved_definition := replace(
        evolved_definition,
        'tenant constraint count drifted: schema=% pk=% uk=% fk=% check=% expected=74/66/153/16',
        'tenant constraint count drifted: schema=% pk=% uk=% fk=% check=% expected=78/72/163/43'
    );

    IF evolved_definition = sync_definition
       OR position('managed_count <> 74' IN evolved_definition) <> 0
       OR position('expected=74/66/153/16' IN evolved_definition) <> 0
       OR position('managed_count <> 78' IN evolved_definition) = 0
       OR position('expected=78/72/163/43' IN evolved_definition) = 0 THEN
        RAISE EXCEPTION 'V102 failed to evolve tenant sync function totals exactly once';
    END IF;

    EXECUTE evolved_definition;
END $$;

-- Apply the data-preserving shape change to every already-registered tenant and
-- every historical backup schema.  Backup copies are data-only by design; the
-- restore target receives the canonical constraints through the managed schema.
CREATE FUNCTION public.jdy_v102_migrate_settlement_schema(
    requested_schema TEXT,
    backup_mode BOOLEAN
)
RETURNS VOID
LANGUAGE plpgsql
AS $$
DECLARE
    target_schema TEXT := btrim(requested_schema);
    table_name TEXT;
    orphan_count BIGINT;
    receipt_count BIGINT;
    receipt_allocation_count BIGINT;
    payment_count BIGINT;
    payment_allocation_count BIGINT;
BEGIN
    IF target_schema IS NULL OR target_schema !~ '^[a-z][a-z0-9_]{0,62}$' OR lower(target_schema) = 'public' THEN
        RAISE EXCEPTION 'V102 target schema is unsafe or platform-scoped: schema=%', requested_schema;
    END IF;

    FOREACH table_name IN ARRAY ARRAY[
        'sales_order', 'delivery_notice', 'sales_out', 'purchase_order',
        'purchase_in', 'ar_receivable', 'ar_receipt', 'ap_payable', 'ap_payment'
    ]
    LOOP
        IF to_regclass(format('%I.%I', target_schema, table_name)) IS NULL THEN
            RAISE EXCEPTION 'V102 target schema lacks required table: schema=% table=%', target_schema, table_name;
        END IF;
    END LOOP;

    FOREACH table_name IN ARRAY ARRAY[
        'sales_order', 'delivery_notice', 'sales_out', 'purchase_order',
        'purchase_in', 'ar_receivable', 'ap_payable'
    ]
    LOOP
        EXECUTE format(
            'ALTER TABLE %I.%I ADD COLUMN currency VARCHAR(8) NOT NULL DEFAULT ''CNY''',
            target_schema,
            table_name
        );
    END LOOP;

    EXECUTE format('ALTER TABLE %I.ar_receipt RENAME COLUMN receivable_id TO legacy_receivable_id', target_schema);
    EXECUTE format('ALTER TABLE %I.ar_receipt RENAME COLUMN receipt_date TO bill_date', target_schema);
    EXECUTE format($sql$
        ALTER TABLE %1$I.ar_receipt
            ADD COLUMN party_id UUID,
            ADD COLUMN currency VARCHAR(8) NOT NULL DEFAULT 'CNY',
            ADD COLUMN status VARCHAR(40) NOT NULL DEFAULT 'DRAFT',
            ADD COLUMN version BIGINT NOT NULL DEFAULT 0,
            ADD COLUMN remark TEXT,
            ADD COLUMN legacy_imported BOOLEAN NOT NULL DEFAULT FALSE,
            ADD COLUMN updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            ADD COLUMN audited_at TIMESTAMPTZ,
            ADD COLUMN audited_by UUID
    $sql$, target_schema);
    EXECUTE format($sql$
        UPDATE %1$I.ar_receipt receipt
        SET party_id = receivable.customer_id,
            currency = receivable.currency,
            status = 'AUDITED',
            legacy_imported = TRUE,
            updated_at = receipt.created_at,
            audited_at = receipt.created_at
        FROM %1$I.ar_receivable receivable
        WHERE receivable.id = receipt.legacy_receivable_id
    $sql$, target_schema);
    EXECUTE format('SELECT count(*) FROM %I.ar_receipt WHERE party_id IS NULL', target_schema)
    INTO orphan_count;
    IF orphan_count <> 0 THEN
        RAISE EXCEPTION 'V102 refused orphan legacy receipts: schema=% count=%', target_schema, orphan_count;
    END IF;
    EXECUTE format($sql$
        ALTER TABLE %1$I.ar_receipt
            ALTER COLUMN party_id SET NOT NULL,
            ALTER COLUMN legacy_receivable_id DROP NOT NULL
    $sql$, target_schema);

    EXECUTE format('ALTER TABLE %I.ap_payment RENAME COLUMN payable_id TO legacy_payable_id', target_schema);
    EXECUTE format('ALTER TABLE %I.ap_payment RENAME COLUMN payment_date TO bill_date', target_schema);
    EXECUTE format($sql$
        ALTER TABLE %1$I.ap_payment
            ADD COLUMN party_id UUID,
            ADD COLUMN currency VARCHAR(8) NOT NULL DEFAULT 'CNY',
            ADD COLUMN status VARCHAR(40) NOT NULL DEFAULT 'DRAFT',
            ADD COLUMN version BIGINT NOT NULL DEFAULT 0,
            ADD COLUMN remark TEXT,
            ADD COLUMN legacy_imported BOOLEAN NOT NULL DEFAULT FALSE,
            ADD COLUMN updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            ADD COLUMN audited_at TIMESTAMPTZ,
            ADD COLUMN audited_by UUID
    $sql$, target_schema);
    EXECUTE format($sql$
        UPDATE %1$I.ap_payment payment
        SET party_id = payable.supplier_id,
            currency = payable.currency,
            status = 'AUDITED',
            legacy_imported = TRUE,
            updated_at = payment.created_at,
            audited_at = payment.created_at
        FROM %1$I.ap_payable payable
        WHERE payable.id = payment.legacy_payable_id
    $sql$, target_schema);
    EXECUTE format('SELECT count(*) FROM %I.ap_payment WHERE party_id IS NULL', target_schema)
    INTO orphan_count;
    IF orphan_count <> 0 THEN
        RAISE EXCEPTION 'V102 refused orphan legacy payments: schema=% count=%', target_schema, orphan_count;
    END IF;
    EXECUTE format($sql$
        ALTER TABLE %1$I.ap_payment
            ALTER COLUMN party_id SET NOT NULL,
            ALTER COLUMN legacy_payable_id DROP NOT NULL
    $sql$, target_schema);

    -- Add CHECKs from their original SQL spelling instead of letting the V98
    -- synchronizer recreate pg_get_constraintdef output.  PostgreSQL otherwise
    -- normalizes VARCHAR IN expressions differently on the second inspection,
    -- making a correct schema look like a same-name collision.
    IF NOT backup_mode THEN
        FOREACH table_name IN ARRAY ARRAY[
            'sales_order', 'delivery_notice', 'sales_out', 'purchase_order',
            'purchase_in', 'ar_receivable', 'ap_payable'
        ]
        LOOP
            EXECUTE format(
                'ALTER TABLE %I.%I ADD CONSTRAINT %I CHECK (currency IN (''CNY'', ''USD''))',
                target_schema,
                table_name,
                'ck_' || table_name || '_currency'
            );
        END LOOP;
        EXECUTE format($sql$
            ALTER TABLE %1$I.ar_receipt
                ADD CONSTRAINT ck_ar_receipt_currency CHECK (currency IN ('CNY', 'USD')),
                ADD CONSTRAINT ck_ar_receipt_status CHECK (status IN ('DRAFT', 'AUDITED')),
                ADD CONSTRAINT ck_ar_receipt_version CHECK (version >= 0),
                ADD CONSTRAINT ck_ar_receipt_amount CHECK (amount >= 0)
        $sql$, target_schema);
        EXECUTE format($sql$
            ALTER TABLE %1$I.ap_payment
                ADD CONSTRAINT ck_ap_payment_currency CHECK (currency IN ('CNY', 'USD')),
                ADD CONSTRAINT ck_ap_payment_status CHECK (status IN ('DRAFT', 'AUDITED')),
                ADD CONSTRAINT ck_ap_payment_version CHECK (version >= 0),
                ADD CONSTRAINT ck_ap_payment_amount CHECK (amount >= 0)
        $sql$, target_schema);
    END IF;

    IF backup_mode THEN
        EXECUTE format('CREATE TABLE %I.ar_receipt_fund_line AS TABLE public.ar_receipt_fund_line WITH NO DATA', target_schema);
        EXECUTE format('CREATE TABLE %I.ar_receipt_allocation AS TABLE public.ar_receipt_allocation WITH NO DATA', target_schema);
        EXECUTE format('CREATE TABLE %I.ap_payment_fund_line AS TABLE public.ap_payment_fund_line WITH NO DATA', target_schema);
        EXECUTE format('CREATE TABLE %I.ap_payment_allocation AS TABLE public.ap_payment_allocation WITH NO DATA', target_schema);
    ELSE
        EXECUTE format('CREATE TABLE %I.ar_receipt_fund_line (LIKE public.ar_receipt_fund_line INCLUDING ALL)', target_schema);
        EXECUTE format('CREATE TABLE %I.ar_receipt_allocation (LIKE public.ar_receipt_allocation INCLUDING ALL)', target_schema);
        EXECUTE format('CREATE TABLE %I.ap_payment_fund_line (LIKE public.ap_payment_fund_line INCLUDING ALL)', target_schema);
        EXECUTE format('CREATE TABLE %I.ap_payment_allocation (LIKE public.ap_payment_allocation INCLUDING ALL)', target_schema);
    END IF;

    EXECUTE format($sql$
        WITH receipt_history AS (
            SELECT receipt.id AS receipt_id,
                   receipt.legacy_receivable_id AS receivable_id,
                   receivable.amount AS source_amount,
                   receipt.amount AS settlement_amount,
                   COALESCE(
                       sum(receipt.amount) OVER (
                           PARTITION BY receipt.legacy_receivable_id
                           ORDER BY receipt.bill_date, receipt.created_at, receipt.id
                           ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING
                       ),
                       0
                   ) AS prior_settled
            FROM %1$I.ar_receipt receipt
            JOIN %1$I.ar_receivable receivable ON receivable.id = receipt.legacy_receivable_id
            WHERE receipt.legacy_imported
        )
        INSERT INTO %1$I.ar_receipt_allocation (
            id, receipt_id, line_no, receivable_id, source_amount,
            settled_before, unsettled_before, settlement_amount, remark
        )
        SELECT gen_random_uuid(),
               receipt_id,
               1,
               receivable_id,
               source_amount,
               LEAST(source_amount, prior_settled),
               GREATEST(source_amount - prior_settled, 0),
               settlement_amount,
               NULL
        FROM receipt_history
    $sql$, target_schema);

    EXECUTE format($sql$
        WITH payment_history AS (
            SELECT payment.id AS payment_id,
                   payment.legacy_payable_id AS payable_id,
                   payable.amount AS source_amount,
                   payment.amount AS settlement_amount,
                   COALESCE(
                       sum(payment.amount) OVER (
                           PARTITION BY payment.legacy_payable_id
                           ORDER BY payment.bill_date, payment.created_at, payment.id
                           ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING
                       ),
                       0
                   ) AS prior_settled
            FROM %1$I.ap_payment payment
            JOIN %1$I.ap_payable payable ON payable.id = payment.legacy_payable_id
            WHERE payment.legacy_imported
        )
        INSERT INTO %1$I.ap_payment_allocation (
            id, payment_id, line_no, payable_id, source_amount,
            settled_before, unsettled_before, settlement_amount, remark
        )
        SELECT gen_random_uuid(),
               payment_id,
               1,
               payable_id,
               source_amount,
               LEAST(source_amount, prior_settled),
               GREATEST(source_amount - prior_settled, 0),
               settlement_amount,
               NULL
        FROM payment_history
    $sql$, target_schema);

    EXECUTE format('SELECT count(*) FROM %I.ar_receipt WHERE legacy_imported', target_schema)
    INTO receipt_count;
    EXECUTE format('SELECT count(*) FROM %I.ar_receipt_allocation', target_schema)
    INTO receipt_allocation_count;
    EXECUTE format('SELECT count(*) FROM %I.ap_payment WHERE legacy_imported', target_schema)
    INTO payment_count;
    EXECUTE format('SELECT count(*) FROM %I.ap_payment_allocation', target_schema)
    INTO payment_allocation_count;
    IF receipt_count <> receipt_allocation_count OR payment_count <> payment_allocation_count THEN
        RAISE EXCEPTION
            'V102 legacy allocation mismatch: schema=% receipts=%/% payments=%/%',
            target_schema, receipt_count, receipt_allocation_count, payment_count, payment_allocation_count;
    END IF;
END $$;

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
        PERFORM public.jdy_v102_migrate_settlement_schema(backup_schema, TRUE);
    END LOOP;
END $$;

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
        PERFORM public.jdy_v102_migrate_settlement_schema(tenant_schema, FALSE);
        PERFORM public.jdy_sync_tenant_schema(tenant_schema, FALSE);
    END LOOP;
END $$;

DROP FUNCTION public.jdy_v102_migrate_settlement_schema(TEXT, BOOLEAN);

-- Fail closed on both topology and one-to-one legacy allocation preservation.
DO $$
DECLARE
    managed_count INTEGER;
    primary_count INTEGER;
    unique_count INTEGER;
    foreign_key_count INTEGER;
    check_count INTEGER;
    receipt_mismatch_count BIGINT;
    payment_mismatch_count BIGINT;
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

    IF managed_count <> 78
       OR primary_count <> 78
       OR unique_count <> 72
       OR foreign_key_count <> 167
       OR check_count <> 43 THEN
        RAISE EXCEPTION
            'V102 managed topology drifted: tables=% pk=% uk=% fk=% check=% expected=78/78/72/167/43',
            managed_count, primary_count, unique_count, foreign_key_count, check_count;
    END IF;

    SELECT count(*)
    INTO receipt_mismatch_count
    FROM ar_receipt receipt
    LEFT JOIN ar_receipt_allocation allocation
      ON allocation.receipt_id = receipt.id
     AND allocation.receivable_id = receipt.legacy_receivable_id
     AND allocation.settlement_amount = receipt.amount
    WHERE receipt.legacy_imported
      AND allocation.id IS NULL;

    SELECT count(*)
    INTO payment_mismatch_count
    FROM ap_payment payment
    LEFT JOIN ap_payment_allocation allocation
      ON allocation.payment_id = payment.id
     AND allocation.payable_id = payment.legacy_payable_id
     AND allocation.settlement_amount = payment.amount
    WHERE payment.legacy_imported
      AND allocation.id IS NULL;

    IF receipt_mismatch_count <> 0 OR payment_mismatch_count <> 0 THEN
        RAISE EXCEPTION
            'V102 public legacy reconciliation failed: receipts=% payments=%',
            receipt_mismatch_count, payment_mismatch_count;
    END IF;
END $$;
