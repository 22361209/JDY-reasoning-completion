CREATE TABLE md_product_name (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    code VARCHAR(200) NOT NULL UNIQUE,
    name VARCHAR(200) NOT NULL UNIQUE,
    remark TEXT,
    enabled BOOLEAN NOT NULL DEFAULT TRUE,
    audit_status VARCHAR(20) NOT NULL DEFAULT 'DRAFT',
    version BIGINT NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT ck_md_product_name_audit_status CHECK (audit_status IN ('DRAFT', 'AUDITED'))
);

CREATE INDEX idx_md_product_name_status ON md_product_name (enabled, audit_status, name);

INSERT INTO md_product_name (code, name, enabled, audit_status)
SELECT name, name, TRUE, 'AUDITED'
FROM md_product
WHERE btrim(COALESCE(name, '')) <> ''
ON CONFLICT (name) DO NOTHING;

INSERT INTO sys_tenant_managed_table (table_name, restore_order)
VALUES ('md_product_name', 137);

-- Keep the strict V99 tenant synchronizer in step with one table, one primary
-- key, two unique constraints and one CHECK constraint.
DO $$
DECLARE
    sync_definition TEXT;
    evolved_definition TEXT;
    before_managed_count INTEGER;
    after_managed_count INTEGER;
    before_constraint_totals TEXT;
    after_constraint_totals TEXT;
BEGIN
    SELECT pg_get_functiondef('public.jdy_sync_tenant_schema_v98(text,boolean)'::regprocedure)
    INTO sync_definition;

    IF sync_definition IS NULL OR position('RETURN managed_count;' IN sync_definition) = 0 THEN
        RAISE EXCEPTION 'V114 refused unexpected tenant sync function topology';
    END IF;

    IF position('IF managed_count <> 89 THEN' IN sync_definition) > 0 THEN
        before_managed_count := 89;
        after_managed_count := 90;
        before_constraint_totals := '89/85/199/117';
        after_constraint_totals := '90/87/199/118';
    ELSIF position('IF managed_count <> 86 THEN' IN sync_definition) > 0 THEN
        before_managed_count := 86;
        after_managed_count := 87;
        before_constraint_totals := '86/81/180/105';
        after_constraint_totals := '87/83/180/106';
    ELSE
        RAISE EXCEPTION 'V114 refused unknown tenant sync function totals';
    END IF;

    evolved_definition := replace(
        sync_definition,
        'IF managed_count <> ' || before_managed_count || ' THEN',
        'IF managed_count <> ' || after_managed_count || ' THEN'
    );
    evolved_definition := replace(
        evolved_definition,
        'tenant managed table catalog drifted: expected=' || before_managed_count || ' actual=%',
        'tenant managed table catalog drifted: expected=' || after_managed_count || ' actual=%'
    );
    evolved_definition := replace(
        evolved_definition,
        'IF primary_count <> ' || split_part(before_constraint_totals, '/', 1)
            || ' OR unique_count <> ' || split_part(before_constraint_totals, '/', 2)
            || ' OR foreign_key_count <> ' || split_part(before_constraint_totals, '/', 3)
            || ' OR check_count <> ' || split_part(before_constraint_totals, '/', 4) || ' THEN',
        'IF primary_count <> ' || split_part(after_constraint_totals, '/', 1)
            || ' OR unique_count <> ' || split_part(after_constraint_totals, '/', 2)
            || ' OR foreign_key_count <> ' || split_part(after_constraint_totals, '/', 3)
            || ' OR check_count <> ' || split_part(after_constraint_totals, '/', 4) || ' THEN'
    );
    evolved_definition := replace(
        evolved_definition,
        'tenant constraint count drifted: schema=% pk=% uk=% fk=% check=% expected=' || before_constraint_totals,
        'tenant constraint count drifted: schema=% pk=% uk=% fk=% check=% expected=' || after_constraint_totals
    );

    IF evolved_definition = sync_definition
       OR position('expected=' || before_constraint_totals IN evolved_definition) <> 0
       OR position('expected=' || after_constraint_totals IN evolved_definition) = 0 THEN
        RAISE EXCEPTION 'V114 failed to evolve tenant sync function totals exactly once';
    END IF;
    EXECUTE evolved_definition;
END $$;

DO $$
DECLARE
    target_schema TEXT;
BEGIN
    FOR target_schema IN
        SELECT DISTINCT btrim(backup_schema_name)
        FROM public.sys_account_set_backup
        WHERE nullif(btrim(backup_schema_name), '') IS NOT NULL
        ORDER BY 1
    LOOP
        IF target_schema !~ '^[a-z][a-z0-9_]{0,62}$' THEN
            RAISE EXCEPTION 'V114 backup schema name is unsafe: schema=%', target_schema;
        END IF;
        IF to_regclass(format('%I.md_product_name', target_schema)) IS NULL THEN
            EXECUTE format('CREATE TABLE %I.md_product_name AS TABLE public.md_product_name WITH NO DATA', target_schema);
        END IF;
    END LOOP;

    FOR target_schema IN
        SELECT DISTINCT btrim(schema_name)
        FROM public.sys_account_set
        WHERE nullif(btrim(schema_name), '') IS NOT NULL
          AND lower(btrim(schema_name)) <> 'public'
        ORDER BY 1
    LOOP
        IF target_schema !~ '^[a-z][a-z0-9_]{0,62}$' THEN
            RAISE EXCEPTION 'V114 tenant schema name is unsafe: schema=%', target_schema;
        END IF;
        IF to_regclass(format('%I.md_product_name', target_schema)) IS NULL THEN
            EXECUTE format('CREATE TABLE %I.md_product_name (LIKE public.md_product_name INCLUDING ALL)', target_schema);
        END IF;
        PERFORM public.jdy_sync_tenant_schema(target_schema, FALSE);
        EXECUTE format($sql$
            INSERT INTO %1$I.md_product_name (code, name, enabled, audit_status)
            SELECT name, name, TRUE, 'AUDITED'
            FROM %1$I.md_product
            WHERE btrim(COALESCE(name, '')) <> ''
            ON CONFLICT (name) DO NOTHING
        $sql$, target_schema);
    END LOOP;
END $$;
