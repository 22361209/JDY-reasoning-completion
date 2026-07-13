CREATE TABLE sys_tenant_managed_table (
    table_name TEXT PRIMARY KEY,
    restore_order INTEGER NOT NULL UNIQUE,
    CONSTRAINT ck_sys_tenant_managed_table_restore_order CHECK (restore_order > 0)
);

INSERT INTO sys_tenant_managed_table (table_name, restore_order)
VALUES
    ('document_number_sequence', 10),
    ('doc_edit_lock', 20),
    ('sys_list_filter_preset', 30),
    ('sys_operation_log', 40),
    ('sys_outbox_event', 50),
    ('sys_notification_outbox', 60),
    ('sys_print_template', 70),
    ('md_product_category', 80),
    ('md_unit', 90),
    ('md_customer', 100),
    ('md_supplier', 110),
    ('md_warehouse', 120),
    ('md_production_department', 130),
    ('md_product', 140),
    ('md_product_partner_code', 150),
    ('inv_stock_balance', 160),
    ('inv_stock_txn', 170),
    ('inv_stock_opening', 180),
    ('inv_safety_stock_setting', 190),
    ('other_stock_in', 200),
    ('other_stock_in_line', 210),
    ('other_stock_out', 220),
    ('other_stock_out_line', 230),
    ('stock_count', 240),
    ('stock_count_line', 250),
    ('stock_count_gain', 260),
    ('stock_count_gain_line', 270),
    ('stock_count_loss', 280),
    ('stock_count_loss_line', 290),
    ('stock_transfer', 300),
    ('stock_transfer_line', 310),
    ('sales_quote', 320),
    ('sales_quote_line', 330),
    ('sales_order', 340),
    ('sales_order_line', 350),
    ('delivery_notice', 360),
    ('delivery_notice_line', 370),
    ('sales_out', 380),
    ('sales_out_line', 390),
    ('purchase_order', 400),
    ('purchase_order_line', 410),
    ('purchase_in', 420),
    ('purchase_in_line', 430),
    ('purchase_return', 440),
    ('purchase_return_line', 450),
    ('prod_bom', 460),
    ('prod_bom_line', 470),
    ('production_plan', 480),
    ('production_task', 490),
    ('production_task_material_snapshot', 500),
    ('production_material_issue', 510),
    ('production_material_issue_line', 520),
    ('production_completion', 530),
    ('production_completion_line', 540),
    ('purchase_requisition', 550),
    ('purchase_requisition_line', 560),
    ('outsourcing_work_order', 570),
    ('outsourcing_work_order_line', 580),
    ('outsourcing_work_order_component', 590),
    ('outsourcing_material_issue', 600),
    ('outsourcing_material_issue_line', 610),
    ('outsourcing_receipt', 620),
    ('outsourcing_receipt_line', 630),
    ('outsourcing_return', 640),
    ('outsourcing_return_line', 650),
    ('outsourcing_scrap', 660),
    ('outsourcing_scrap_line', 670),
    ('outsourcing_surface_process', 680),
    ('ar_receivable', 690),
    ('ar_receipt', 700),
    ('ap_payable', 710),
    ('ap_payment', 720);

-- A tenant schema is an isolation boundary and may belong to exactly one account set.
-- Public transition rows are intentionally outside this uniqueness rule.
DO $$
DECLARE
    duplicate_schemas TEXT;
BEGIN
    SELECT string_agg(format('%s(%s)', normalized_schema, row_count), ', ' ORDER BY normalized_schema)
    INTO duplicate_schemas
    FROM (
        SELECT lower(btrim(schema_name)) AS normalized_schema,
               count(*) AS row_count
        FROM sys_account_set
        WHERE nullif(btrim(schema_name), '') IS NOT NULL
          AND lower(btrim(schema_name)) <> 'public'
        GROUP BY lower(btrim(schema_name))
        HAVING count(*) > 1
    ) duplicate_row;
    IF duplicate_schemas IS NOT NULL THEN
        RAISE EXCEPTION 'V98 refused duplicate tenant schema registrations: %', duplicate_schemas;
    END IF;
END $$;

CREATE UNIQUE INDEX uq_sys_account_set_tenant_schema_name
    ON sys_account_set ((lower(btrim(schema_name))))
    WHERE nullif(btrim(schema_name), '') IS NOT NULL
      AND lower(btrim(schema_name)) <> 'public';

-- These are the only public-mode FKs that are intentionally not tenant FKs.
-- Assert their exact current semantics so the exemption cannot silently expand.
DO $$
DECLARE
    exemption_count INTEGER;
BEGIN
    WITH expected(child_table, constraint_name) AS (
        VALUES
            ('document_number_sequence', 'document_number_sequence_account_set_id_fkey'),
            ('inv_stock_balance', 'inv_stock_balance_account_set_id_fkey'),
            ('inv_stock_opening', 'inv_stock_opening_account_set_id_fkey'),
            ('inv_stock_txn', 'inv_stock_txn_account_set_id_fkey')
    )
    SELECT count(*)::INTEGER
    INTO exemption_count
    FROM expected
    JOIN pg_class child_table ON child_table.relname = expected.child_table
    JOIN pg_namespace child_namespace
      ON child_namespace.oid = child_table.relnamespace
     AND child_namespace.nspname = 'public'
    JOIN pg_constraint constraint_row
      ON constraint_row.conrelid = child_table.oid
     AND constraint_row.conname = expected.constraint_name
     AND constraint_row.contype = 'f'
    JOIN pg_class parent_table
      ON parent_table.oid = constraint_row.confrelid
     AND parent_table.relname = 'sys_account_set'
    JOIN pg_namespace parent_namespace
      ON parent_namespace.oid = parent_table.relnamespace
     AND parent_namespace.nspname = 'public'
    JOIN pg_attribute child_column
      ON child_column.attrelid = child_table.oid
     AND child_column.attnum = constraint_row.conkey[1]
     AND child_column.attname = 'account_set_id'
    JOIN pg_attribute parent_column
      ON parent_column.attrelid = parent_table.oid
     AND parent_column.attnum = constraint_row.confkey[1]
     AND parent_column.attname = 'id'
    WHERE cardinality(constraint_row.conkey) = 1
      AND cardinality(constraint_row.confkey) = 1;
    IF exemption_count <> 4 THEN
        RAISE EXCEPTION 'V98 tenant scope FK exemption drifted: expected=4 actual=%', exemption_count;
    END IF;
END $$;

-- A136 actor regression cleanup was authorized only for these seven exact fixture rows.
-- Any partial match, changed marker, restored parent, or additional orphan is rejected.
DO $$
DECLARE
    fixture_ids UUID[] := ARRAY[
        '131e93c0-5271-460e-8d8f-431ec03986e4'::UUID,
        '9a5fb2f7-309c-45a3-8d5b-5aae3a34f92e'::UUID,
        'ae91013b-2044-44ed-909c-ee51d3e61e8e'::UUID,
        'c11247c8-5fdc-4210-b045-8297116630b5'::UUID,
        'd7d8f88f-f93d-41f0-8e7f-04614ce959c1'::UUID,
        'd7d99356-4a97-45cd-a967-bec759abf4bc'::UUID,
        'f38e869c-bd8d-4d1c-93fe-e94390d44298'::UUID
    ];
    matched_count INTEGER;
    invalid_count INTEGER;
    deleted_count INTEGER;
BEGIN
    IF to_regclass('tenant_a119ops_49f5546b.stock_count_line') IS NULL THEN
        RETURN;
    END IF;

    SELECT count(*)::INTEGER,
           count(*) FILTER (
               WHERE line_remark NOT LIKE 'A136_ACTOR_%'
                  OR product_code_snapshot NOT LIKE 'A136P-%-TENANT'
                  OR EXISTS (
                      SELECT 1
                      FROM tenant_a119ops_49f5546b.stock_count bill
                      WHERE bill.id = line.bill_id
                  )
                  OR EXISTS (
                      SELECT 1
                      FROM tenant_a119ops_49f5546b.md_product product
                      WHERE product.id = line.product_id
                  )
           )::INTEGER
    INTO matched_count, invalid_count
    FROM tenant_a119ops_49f5546b.stock_count_line line
    WHERE line.id = ANY (fixture_ids);

    IF matched_count NOT IN (0, 7) THEN
        RAISE EXCEPTION 'V98 refused A136 fixture cleanup: expected 0 or 7 exact rows, found %', matched_count;
    END IF;
    IF invalid_count <> 0 THEN
        RAISE EXCEPTION 'V98 refused A136 fixture cleanup: % exact rows no longer satisfy marker and missing-parent contract', invalid_count;
    END IF;

    DELETE FROM tenant_a119ops_49f5546b.stock_count_line line
    WHERE line.id = ANY (fixture_ids)
      AND line.line_remark LIKE 'A136_ACTOR_%'
      AND line.product_code_snapshot LIKE 'A136P-%-TENANT'
      AND NOT EXISTS (
          SELECT 1
          FROM tenant_a119ops_49f5546b.stock_count bill
          WHERE bill.id = line.bill_id
      )
      AND NOT EXISTS (
          SELECT 1
          FROM tenant_a119ops_49f5546b.md_product product
          WHERE product.id = line.product_id
      );
    GET DIAGNOSTICS deleted_count = ROW_COUNT;

    IF deleted_count <> matched_count THEN
        RAISE EXCEPTION 'V98 refused A136 fixture cleanup: matched %, deleted %', matched_count, deleted_count;
    END IF;
END $$;

-- V86 removed the obsolete document-header tax flag from public. Existing tenant copies
-- predate that migration. Only false/empty legacy columns are deterministic to remove.
DO $$
DECLARE
    tenant_schema TEXT;
    table_name TEXT;
    true_count BIGINT;
BEGIN
    FOR tenant_schema IN
        SELECT DISTINCT btrim(schema_name)
        FROM sys_account_set
        WHERE nullif(btrim(schema_name), '') IS NOT NULL
          AND lower(btrim(schema_name)) <> 'public'
        ORDER BY 1
    LOOP
        IF tenant_schema !~ '^[a-z][a-z0-9_]{0,62}$' THEN
            RAISE EXCEPTION 'V98 refused: registered tenant schema name is unsafe: schema=%', tenant_schema;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = tenant_schema) THEN
            RAISE EXCEPTION 'V98 refused: registered tenant schema does not exist: schema=%', tenant_schema;
        END IF;

        FOREACH table_name IN ARRAY ARRAY[
            'sales_quote', 'sales_order', 'delivery_notice', 'sales_out',
            'purchase_order', 'purchase_in', 'purchase_return'
        ]
        LOOP
            IF to_regclass(format('%I.%I', tenant_schema, table_name)) IS NULL THEN
                RAISE EXCEPTION 'V98 refused: registered tenant table does not exist: schema=% table=%', tenant_schema, table_name;
            END IF;
            IF EXISTS (
                SELECT 1
                FROM pg_attribute
                WHERE attrelid = to_regclass(format('%I.%I', tenant_schema, table_name))
                  AND attname = 'is_tax_inclusive'
                  AND attnum > 0
                  AND NOT attisdropped
            ) THEN
                EXECUTE format(
                    'SELECT count(*) FROM %I.%I WHERE is_tax_inclusive IS TRUE',
                    tenant_schema,
                    table_name
                ) INTO true_count;
                IF true_count <> 0 THEN
                    RAISE EXCEPTION 'V98 refused obsolete-column cleanup: schema=% table=% true_rows=%',
                        tenant_schema, table_name, true_count;
                END IF;
                EXECUTE format(
                    'ALTER TABLE %I.%I DROP COLUMN is_tax_inclusive',
                    tenant_schema,
                    table_name
                );
            END IF;
        END LOOP;
    END LOOP;
END $$;

CREATE OR REPLACE FUNCTION public.jdy_sync_tenant_schema(
    requested_schema TEXT,
    create_missing BOOLEAN DEFAULT FALSE
)
RETURNS INTEGER
LANGUAGE plpgsql
AS $$
DECLARE
    tenant_schema TEXT := btrim(requested_schema);
    managed RECORD;
    source_column RECORD;
    source_constraint RECORD;
    source_fk RECORD;
    source_table_oid OID;
    target_table_oid OID;
    target_parent_oid OID;
    target_column_type TEXT;
    target_column_not_null BOOLEAN;
    target_column_default TEXT;
    target_column_found BOOLEAN;
    source_constraint_definition TEXT;
    extra_columns TEXT;
    child_columns TEXT[];
    parent_columns TEXT[];
    child_column_sql TEXT;
    parent_column_sql TEXT;
    all_non_null_sql TEXT;
    any_non_null_sql TEXT;
    join_sql TEXT;
    orphan_predicate TEXT;
    orphan_count BIGINT;
    target_parent_schema TEXT;
    equivalent_exists BOOLEAN;
    constraint_name_exists BOOLEAN;
    fk_definition TEXT;
    managed_count INTEGER;
    registration_count INTEGER;
    primary_count INTEGER;
    unique_count INTEGER;
    foreign_key_count INTEGER;
    check_count INTEGER;
BEGIN
    IF tenant_schema IS NULL OR tenant_schema !~ '^[a-z][a-z0-9_]{0,62}$' OR lower(tenant_schema) = 'public' THEN
        RAISE EXCEPTION 'tenant schema name is unsafe or platform-scoped: schema=%', requested_schema;
    END IF;
    SELECT count(*)::INTEGER
    INTO registration_count
    FROM public.sys_account_set account_set
    WHERE btrim(account_set.schema_name) = tenant_schema;
    IF registration_count <> 1 THEN
        RAISE EXCEPTION 'tenant schema registration count must equal one: schema=% count=%',
            tenant_schema, registration_count;
    END IF;

    IF EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = tenant_schema) THEN
        IF create_missing THEN
            RAISE EXCEPTION 'new tenant schema already exists and cannot be adopted: schema=%', tenant_schema;
        END IF;
    ELSE
        IF NOT create_missing THEN
            RAISE EXCEPTION 'registered tenant schema does not exist: schema=%', tenant_schema;
        END IF;
        EXECUTE format('CREATE SCHEMA %I', tenant_schema);
    END IF;

    SELECT count(*)::INTEGER
    INTO managed_count
    FROM public.sys_tenant_managed_table;
    IF managed_count <> 72 THEN
        RAISE EXCEPTION 'tenant managed table catalog drifted: expected=72 actual=%', managed_count;
    END IF;

    FOR managed IN
        SELECT table_name, restore_order
        FROM public.sys_tenant_managed_table
        ORDER BY restore_order
    LOOP
        IF to_regclass(format('%I.%I', 'public', managed.table_name)) IS NULL THEN
            RAISE EXCEPTION 'public reference table does not exist: table=%', managed.table_name;
        END IF;
        IF to_regclass(format('%I.%I', tenant_schema, managed.table_name)) IS NULL THEN
            IF NOT create_missing THEN
                RAISE EXCEPTION 'registered tenant table does not exist: schema=% table=%', tenant_schema, managed.table_name;
            END IF;
            EXECUTE format(
                'CREATE TABLE %I.%I (LIKE public.%I INCLUDING ALL)',
                tenant_schema,
                managed.table_name,
                managed.table_name
            );
        END IF;
    END LOOP;

    FOR managed IN
        SELECT table_name, restore_order
        FROM public.sys_tenant_managed_table
        ORDER BY restore_order
    LOOP
        source_table_oid := to_regclass(format('%I.%I', 'public', managed.table_name));
        target_table_oid := to_regclass(format('%I.%I', tenant_schema, managed.table_name));

        FOR source_column IN
            SELECT attribute.attname AS column_name,
                   format_type(attribute.atttypid, attribute.atttypmod) AS data_type,
                   attribute.attnotnull AS not_null,
                   attribute.attidentity AS identity_kind,
                   attribute.attgenerated AS generated_kind,
                   pg_get_expr(default_value.adbin, default_value.adrelid) AS default_expression
            FROM pg_attribute attribute
            LEFT JOIN pg_attrdef default_value
              ON default_value.adrelid = attribute.attrelid
             AND default_value.adnum = attribute.attnum
            WHERE attribute.attrelid = source_table_oid
              AND attribute.attnum > 0
              AND NOT attribute.attisdropped
            ORDER BY attribute.attnum
        LOOP
            SELECT format_type(attribute.atttypid, attribute.atttypmod),
                   attribute.attnotnull,
                   pg_get_expr(default_value.adbin, default_value.adrelid)
            INTO target_column_type, target_column_not_null, target_column_default
            FROM pg_attribute attribute
            LEFT JOIN pg_attrdef default_value
              ON default_value.adrelid = attribute.attrelid
             AND default_value.adnum = attribute.attnum
            WHERE attribute.attrelid = target_table_oid
              AND attribute.attname = source_column.column_name
              AND attribute.attnum > 0
              AND NOT attribute.attisdropped;
            target_column_found := FOUND;

            IF NOT target_column_found THEN
                IF source_column.identity_kind <> '' OR source_column.generated_kind <> '' THEN
                    RAISE EXCEPTION 'cannot infer missing generated column: schema=% table=% column=%',
                        tenant_schema, managed.table_name, source_column.column_name;
                END IF;
                EXECUTE format(
                    'ALTER TABLE %I.%I ADD COLUMN %I %s%s%s',
                    tenant_schema,
                    managed.table_name,
                    source_column.column_name,
                    source_column.data_type,
                    CASE
                        WHEN source_column.default_expression IS NULL THEN ''
                        ELSE ' DEFAULT ' || source_column.default_expression
                    END,
                    CASE WHEN source_column.not_null THEN ' NOT NULL' ELSE '' END
                );
                CONTINUE;
            END IF;

            IF target_column_type <> source_column.data_type THEN
                RAISE EXCEPTION 'tenant column type drift: schema=% table=% column=% expected=% actual=%',
                    tenant_schema, managed.table_name, source_column.column_name,
                    source_column.data_type, target_column_type;
            END IF;

            IF target_column_default IS DISTINCT FROM source_column.default_expression THEN
                IF source_column.default_expression IS NULL THEN
                    EXECUTE format(
                        'ALTER TABLE %I.%I ALTER COLUMN %I DROP DEFAULT',
                        tenant_schema, managed.table_name, source_column.column_name
                    );
                ELSE
                    EXECUTE format(
                        'ALTER TABLE %I.%I ALTER COLUMN %I SET DEFAULT %s',
                        tenant_schema, managed.table_name, source_column.column_name,
                        source_column.default_expression
                    );
                END IF;
            END IF;

            IF target_column_not_null IS DISTINCT FROM source_column.not_null THEN
                EXECUTE format(
                    'ALTER TABLE %I.%I ALTER COLUMN %I %s NOT NULL',
                    tenant_schema,
                    managed.table_name,
                    source_column.column_name,
                    CASE WHEN source_column.not_null THEN 'SET' ELSE 'DROP' END
                );
            END IF;
        END LOOP;

        SELECT string_agg(attribute.attname, ', ' ORDER BY attribute.attnum)
        INTO extra_columns
        FROM pg_attribute attribute
        WHERE attribute.attrelid = target_table_oid
          AND attribute.attnum > 0
          AND NOT attribute.attisdropped
          AND NOT EXISTS (
              SELECT 1
              FROM pg_attribute reference_attribute
              WHERE reference_attribute.attrelid = source_table_oid
                AND reference_attribute.attname = attribute.attname
                AND reference_attribute.attnum > 0
                AND NOT reference_attribute.attisdropped
          );
        IF extra_columns IS NOT NULL THEN
            RAISE EXCEPTION 'tenant has unknown extra columns: schema=% table=% columns=%',
                tenant_schema, managed.table_name, extra_columns;
        END IF;
    END LOOP;

    FOR source_constraint IN
        SELECT constraint_row.oid,
               constraint_row.conname,
               constraint_row.contype,
               child_table.relname AS child_table,
               pg_get_constraintdef(constraint_row.oid, TRUE) AS definition
        FROM pg_constraint constraint_row
        JOIN pg_class child_table ON child_table.oid = constraint_row.conrelid
        JOIN pg_namespace child_namespace ON child_namespace.oid = child_table.relnamespace
        JOIN public.sys_tenant_managed_table managed_table ON managed_table.table_name = child_table.relname
        WHERE child_namespace.nspname = 'public'
          AND constraint_row.contype IN ('p', 'u', 'c')
        ORDER BY managed_table.restore_order, constraint_row.contype, constraint_row.conname
    LOOP
        target_table_oid := to_regclass(format('%I.%I', tenant_schema, source_constraint.child_table));
        SELECT EXISTS (
            SELECT 1
            FROM pg_constraint target_constraint
            WHERE target_constraint.conrelid = target_table_oid
              AND target_constraint.contype = source_constraint.contype
              AND pg_get_constraintdef(target_constraint.oid, TRUE) = source_constraint.definition
        ) INTO equivalent_exists;
        IF equivalent_exists THEN
            CONTINUE;
        END IF;

        SELECT EXISTS (
            SELECT 1
            FROM pg_constraint target_constraint
            WHERE target_constraint.conrelid = target_table_oid
              AND target_constraint.conname = source_constraint.conname
        ) INTO constraint_name_exists;
        IF constraint_name_exists THEN
            RAISE EXCEPTION 'tenant constraint name collision: schema=% table=% constraint=%',
                tenant_schema, source_constraint.child_table, source_constraint.conname;
        END IF;

        source_constraint_definition := source_constraint.definition;
        EXECUTE format(
            'ALTER TABLE %I.%I ADD CONSTRAINT %I %s',
            tenant_schema,
            source_constraint.child_table,
            source_constraint.conname,
            source_constraint_definition
        );
    END LOOP;

    FOR source_fk IN
        SELECT constraint_row.oid,
               constraint_row.conname,
               constraint_row.conrelid AS source_child_oid,
               constraint_row.confrelid AS source_parent_oid,
               constraint_row.conkey,
               constraint_row.confkey,
               constraint_row.confmatchtype,
               constraint_row.confupdtype,
               constraint_row.confdeltype,
               constraint_row.condeferrable,
               constraint_row.condeferred,
               child_table.relname AS child_table,
               parent_table.relname AS parent_table,
               managed_table.restore_order
        FROM pg_constraint constraint_row
        JOIN pg_class child_table ON child_table.oid = constraint_row.conrelid
        JOIN pg_namespace child_namespace ON child_namespace.oid = child_table.relnamespace
        JOIN pg_class parent_table ON parent_table.oid = constraint_row.confrelid
        JOIN public.sys_tenant_managed_table managed_table ON managed_table.table_name = child_table.relname
        WHERE child_namespace.nspname = 'public'
          AND constraint_row.contype = 'f'
          -- A119 deliberately uses a namespace-derived scope UUID inside each tenant for
          -- these four already-schema-isolated tables. Their public-schema FK is not a
          -- tenant constraint: the value is not public.sys_account_set.id.
          AND constraint_row.conname NOT IN (
              'document_number_sequence_account_set_id_fkey',
              'inv_stock_balance_account_set_id_fkey',
              'inv_stock_opening_account_set_id_fkey',
              'inv_stock_txn_account_set_id_fkey'
          )
        ORDER BY managed_table.restore_order, constraint_row.conname
    LOOP
        SELECT array_agg(attribute.attname ORDER BY key_column.ordinality)
        INTO child_columns
        FROM unnest(source_fk.conkey) WITH ORDINALITY key_column(attnum, ordinality)
        JOIN pg_attribute attribute
          ON attribute.attrelid = source_fk.source_child_oid
         AND attribute.attnum = key_column.attnum;

        SELECT array_agg(attribute.attname ORDER BY key_column.ordinality)
        INTO parent_columns
        FROM unnest(source_fk.confkey) WITH ORDINALITY key_column(attnum, ordinality)
        JOIN pg_attribute attribute
          ON attribute.attrelid = source_fk.source_parent_oid
         AND attribute.attnum = key_column.attnum;

        target_parent_schema := CASE
            WHEN EXISTS (
                SELECT 1
                FROM public.sys_tenant_managed_table
                WHERE table_name = source_fk.parent_table
            ) THEN tenant_schema
            ELSE 'public'
        END;
        target_table_oid := to_regclass(format('%I.%I', tenant_schema, source_fk.child_table));
        target_parent_oid := to_regclass(format('%I.%I', target_parent_schema, source_fk.parent_table));
        IF target_parent_oid IS NULL THEN
            RAISE EXCEPTION 'tenant FK parent does not exist: schema=% constraint=% parent=%.%',
                tenant_schema, source_fk.conname, target_parent_schema, source_fk.parent_table;
        END IF;

        SELECT string_agg(format('%I', child_columns[position]), ', ' ORDER BY position),
               string_agg(format('%I', parent_columns[position]), ', ' ORDER BY position),
               string_agg(format('c.%I IS NOT NULL', child_columns[position]), ' AND ' ORDER BY position),
               string_agg(format('c.%I IS NOT NULL', child_columns[position]), ' OR ' ORDER BY position),
               string_agg(format('p.%I = c.%I', parent_columns[position], child_columns[position]), ' AND ' ORDER BY position)
        INTO child_column_sql, parent_column_sql, all_non_null_sql, any_non_null_sql, join_sql
        FROM generate_subscripts(child_columns, 1) AS position;

        orphan_predicate := CASE source_fk.confmatchtype
            WHEN 's' THEN format('(%s) AND NOT EXISTS (SELECT 1 FROM %I.%I p WHERE %s)',
                all_non_null_sql, target_parent_schema, source_fk.parent_table, join_sql)
            WHEN 'f' THEN format('((%s) AND NOT (%s)) OR ((%s) AND NOT EXISTS (SELECT 1 FROM %I.%I p WHERE %s))',
                any_non_null_sql, all_non_null_sql, all_non_null_sql,
                target_parent_schema, source_fk.parent_table, join_sql)
            ELSE NULL
        END;
        IF orphan_predicate IS NULL THEN
            RAISE EXCEPTION 'unsupported FK match type: schema=% constraint=% match_type=%',
                tenant_schema, source_fk.conname, source_fk.confmatchtype;
        END IF;

        EXECUTE format(
            'SELECT count(*) FROM %I.%I c WHERE %s',
            tenant_schema,
            source_fk.child_table,
            orphan_predicate
        ) INTO orphan_count;
        IF orphan_count <> 0 THEN
            RAISE EXCEPTION 'tenant FK orphan preflight failed: schema=% constraint=% child=% parent=%.% orphan_count=%',
                tenant_schema, source_fk.conname, source_fk.child_table,
                target_parent_schema, source_fk.parent_table, orphan_count;
        END IF;

        SELECT EXISTS (
            SELECT 1
            FROM pg_constraint target_constraint
            WHERE target_constraint.conrelid = target_table_oid
              AND target_constraint.contype = 'f'
              AND target_constraint.confrelid = target_parent_oid
              AND ARRAY(
                  SELECT attribute.attname::TEXT
                  FROM unnest(target_constraint.conkey) WITH ORDINALITY key_column(attnum, ordinality)
                  JOIN pg_attribute attribute
                    ON attribute.attrelid = target_constraint.conrelid
                   AND attribute.attnum = key_column.attnum
                  ORDER BY key_column.ordinality
              ) = child_columns
              AND ARRAY(
                  SELECT attribute.attname::TEXT
                  FROM unnest(target_constraint.confkey) WITH ORDINALITY key_column(attnum, ordinality)
                  JOIN pg_attribute attribute
                    ON attribute.attrelid = target_constraint.confrelid
                   AND attribute.attnum = key_column.attnum
                  ORDER BY key_column.ordinality
              ) = parent_columns
              AND target_constraint.confmatchtype = source_fk.confmatchtype
              AND target_constraint.confupdtype = source_fk.confupdtype
              AND target_constraint.confdeltype = source_fk.confdeltype
              AND target_constraint.condeferrable = source_fk.condeferrable
              AND target_constraint.condeferred = source_fk.condeferred
              AND target_constraint.convalidated
        ) INTO equivalent_exists;
        IF equivalent_exists THEN
            CONTINUE;
        END IF;

        SELECT EXISTS (
            SELECT 1
            FROM pg_constraint target_constraint
            WHERE target_constraint.conrelid = target_table_oid
              AND target_constraint.conname = source_fk.conname
        ) INTO constraint_name_exists;
        IF constraint_name_exists THEN
            RAISE EXCEPTION 'tenant FK name collision: schema=% table=% constraint=%',
                tenant_schema, source_fk.child_table, source_fk.conname;
        END IF;

        fk_definition := format(
            'FOREIGN KEY (%s) REFERENCES %I.%I (%s)',
            child_column_sql,
            target_parent_schema,
            source_fk.parent_table,
            parent_column_sql
        );
        IF source_fk.confmatchtype = 'f' THEN
            fk_definition := fk_definition || ' MATCH FULL';
        END IF;
        fk_definition := fk_definition || CASE source_fk.confupdtype
            WHEN 'r' THEN ' ON UPDATE RESTRICT'
            WHEN 'c' THEN ' ON UPDATE CASCADE'
            WHEN 'n' THEN ' ON UPDATE SET NULL'
            WHEN 'd' THEN ' ON UPDATE SET DEFAULT'
            ELSE ''
        END;
        fk_definition := fk_definition || CASE source_fk.confdeltype
            WHEN 'r' THEN ' ON DELETE RESTRICT'
            WHEN 'c' THEN ' ON DELETE CASCADE'
            WHEN 'n' THEN ' ON DELETE SET NULL'
            WHEN 'd' THEN ' ON DELETE SET DEFAULT'
            ELSE ''
        END;
        IF source_fk.condeferrable THEN
            fk_definition := fk_definition || ' DEFERRABLE';
            IF source_fk.condeferred THEN
                fk_definition := fk_definition || ' INITIALLY DEFERRED';
            END IF;
        END IF;

        EXECUTE format(
            'ALTER TABLE %I.%I ADD CONSTRAINT %I %s',
            tenant_schema,
            source_fk.child_table,
            source_fk.conname,
            fk_definition
        );
    END LOOP;

    SELECT count(*) FILTER (WHERE constraint_row.contype = 'p')::INTEGER,
           count(*) FILTER (WHERE constraint_row.contype = 'u')::INTEGER,
           count(*) FILTER (WHERE constraint_row.contype = 'f')::INTEGER,
           count(*) FILTER (WHERE constraint_row.contype = 'c')::INTEGER
    INTO primary_count, unique_count, foreign_key_count, check_count
    FROM pg_constraint constraint_row
    JOIN pg_class child_table ON child_table.oid = constraint_row.conrelid
    JOIN pg_namespace child_namespace ON child_namespace.oid = child_table.relnamespace
    JOIN public.sys_tenant_managed_table managed_table ON managed_table.table_name = child_table.relname
    WHERE child_namespace.nspname = tenant_schema;
    IF primary_count <> 72 OR unique_count <> 64 OR foreign_key_count <> 153 OR check_count <> 11 THEN
        RAISE EXCEPTION 'tenant constraint count drifted: schema=% pk=% uk=% fk=% check=% expected=72/64/153/11',
            tenant_schema, primary_count, unique_count, foreign_key_count, check_count;
    END IF;

    RETURN managed_count;
END $$;

DO $$
DECLARE
    tenant_schema TEXT;
BEGIN
    FOR tenant_schema IN
        SELECT DISTINCT btrim(schema_name)
        FROM sys_account_set
        WHERE nullif(btrim(schema_name), '') IS NOT NULL
          AND lower(btrim(schema_name)) <> 'public'
        ORDER BY 1
    LOOP
        PERFORM public.jdy_sync_tenant_schema(tenant_schema, FALSE);
    END LOOP;
END $$;
