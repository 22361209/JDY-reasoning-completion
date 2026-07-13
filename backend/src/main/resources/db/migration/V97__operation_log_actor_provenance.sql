ALTER TABLE public.sys_operation_log
    ADD COLUMN actor_type VARCHAR(32) NOT NULL DEFAULT 'HISTORICAL_UNKNOWN',
    ADD COLUMN actor_username VARCHAR(80),
    ADD COLUMN actor_display_name VARCHAR(120),
    ADD COLUMN target_no VARCHAR(200) NOT NULL DEFAULT '';

UPDATE public.sys_operation_log operation_log
SET actor_type = 'USER',
    actor_username = operation_user.username
FROM public.sys_user operation_user
WHERE operation_log.operated_by = operation_user.id;

DO $$
DECLARE
    missing_actor_count BIGINT;
    missing_actor_samples TEXT;
BEGIN
    WITH orphans AS (
        SELECT operation_log.id, operation_log.operated_by
        FROM public.sys_operation_log operation_log
        LEFT JOIN public.sys_user operation_user ON operation_user.id = operation_log.operated_by
        WHERE operation_log.operated_by IS NOT NULL
          AND operation_user.id IS NULL
    )
    SELECT count(*),
           (
               SELECT string_agg(format('(id=%s, operated_by=%s)', sample.id, sample.operated_by), ', ' ORDER BY sample.id)
               FROM (
                   SELECT id, operated_by
                   FROM orphans
                   ORDER BY id
                   LIMIT 20
               ) sample
           )
    INTO missing_actor_count, missing_actor_samples
    FROM orphans;

    IF missing_actor_count > 0 THEN
        RAISE EXCEPTION 'V97 refused: schema=public table=sys_operation_log orphan_count=% orphan_samples=[%]',
            missing_actor_count,
            missing_actor_samples;
    END IF;
END $$;

ALTER TABLE public.sys_operation_log
    ALTER COLUMN actor_type DROP DEFAULT,
    ADD CONSTRAINT ck_sys_operation_log_actor_type
        CHECK (actor_type IN ('USER', 'SYSTEM', 'ANONYMOUS', 'HISTORICAL_UNKNOWN')),
    ADD CONSTRAINT ck_sys_operation_log_actor_provenance
        CHECK (
            (
                actor_type = 'USER'
                AND operated_by IS NOT NULL
                AND NULLIF(BTRIM(actor_username), '') IS NOT NULL
                AND (actor_display_name IS NULL OR NULLIF(BTRIM(actor_display_name), '') IS NOT NULL)
            )
            OR
            (
                actor_type IN ('SYSTEM', 'ANONYMOUS', 'HISTORICAL_UNKNOWN')
                AND operated_by IS NULL
                AND actor_username IS NULL
                AND actor_display_name IS NULL
            )
        ),
    ADD CONSTRAINT ck_sys_operation_log_failure_reason
        CHECK (success OR NULLIF(BTRIM(failure_reason), '') IS NOT NULL);

CREATE INDEX idx_sys_operation_log_actor_time
    ON public.sys_operation_log (actor_type, actor_username, operated_at DESC);

CREATE INDEX idx_sys_operation_log_target_time
    ON public.sys_operation_log (target_type, target_id, operated_at DESC);

CREATE INDEX idx_sys_operation_log_target_no_time
    ON public.sys_operation_log (target_type, target_no, operated_at DESC);

DO $$
DECLARE
    tenant_schema TEXT;
    missing_actor_count BIGINT;
    missing_actor_samples TEXT;
BEGIN
    FOR tenant_schema IN
        SELECT DISTINCT BTRIM(account_set.schema_name)
        FROM public.sys_account_set account_set
        WHERE NULLIF(BTRIM(account_set.schema_name), '') IS NOT NULL
          AND LOWER(BTRIM(account_set.schema_name)) <> 'public'
        ORDER BY BTRIM(account_set.schema_name)
    LOOP
        IF tenant_schema !~ '^[a-z][a-z0-9_]{0,62}$' THEN
            RAISE EXCEPTION 'V97 refused: registered tenant schema name is unsafe: schema=%', tenant_schema;
        END IF;

        IF NOT EXISTS (
            SELECT 1
            FROM pg_namespace namespace
            WHERE namespace.nspname = tenant_schema
        ) THEN
            RAISE EXCEPTION 'V97 refused: registered tenant schema does not exist: schema=%', tenant_schema;
        END IF;

        IF to_regclass(format('%I.sys_operation_log', tenant_schema)) IS NULL THEN
            RAISE EXCEPTION 'V97 refused: registered tenant operation log table does not exist: schema=% table=sys_operation_log',
                tenant_schema;
        END IF;

        EXECUTE format(
            'ALTER TABLE %I.sys_operation_log
                ADD COLUMN actor_type VARCHAR(32) NOT NULL DEFAULT ''HISTORICAL_UNKNOWN'',
                ADD COLUMN actor_username VARCHAR(80),
                ADD COLUMN actor_display_name VARCHAR(120),
                ADD COLUMN target_no VARCHAR(200) NOT NULL DEFAULT ''''' ,
            tenant_schema
        );

        EXECUTE format(
            'UPDATE %I.sys_operation_log operation_log
             SET actor_type = ''USER'',
                 actor_username = operation_user.username
             FROM public.sys_user operation_user
             WHERE operation_log.operated_by = operation_user.id',
            tenant_schema
        );

        EXECUTE format(
            'WITH orphans AS (
                 SELECT operation_log.id, operation_log.operated_by
                 FROM %I.sys_operation_log operation_log
                 LEFT JOIN public.sys_user operation_user ON operation_user.id = operation_log.operated_by
                 WHERE operation_log.operated_by IS NOT NULL
                   AND operation_user.id IS NULL
             )
             SELECT count(*),
                    (
                        SELECT string_agg(format(''(id=%%s, operated_by=%%s)'', sample.id, sample.operated_by), '', '' ORDER BY sample.id)
                        FROM (
                            SELECT id, operated_by
                            FROM orphans
                            ORDER BY id
                            LIMIT 20
                        ) sample
                    )
             FROM orphans',
            tenant_schema
        ) INTO missing_actor_count, missing_actor_samples;

        IF missing_actor_count > 0 THEN
            RAISE EXCEPTION 'V97 refused: schema=% table=sys_operation_log orphan_count=% orphan_samples=[%]',
                tenant_schema,
                missing_actor_count,
                missing_actor_samples;
        END IF;

        EXECUTE format(
            'ALTER TABLE %I.sys_operation_log
                ALTER COLUMN actor_type DROP DEFAULT,
                ADD CONSTRAINT ck_sys_operation_log_actor_type
                    CHECK (actor_type IN (''USER'', ''SYSTEM'', ''ANONYMOUS'', ''HISTORICAL_UNKNOWN'')),
                ADD CONSTRAINT ck_sys_operation_log_actor_provenance
                    CHECK (
                        (
                            actor_type = ''USER''
                            AND operated_by IS NOT NULL
                            AND NULLIF(BTRIM(actor_username), '''') IS NOT NULL
                            AND (actor_display_name IS NULL OR NULLIF(BTRIM(actor_display_name), '''') IS NOT NULL)
                        )
                        OR
                        (
                            actor_type IN (''SYSTEM'', ''ANONYMOUS'', ''HISTORICAL_UNKNOWN'')
                            AND operated_by IS NULL
                            AND actor_username IS NULL
                            AND actor_display_name IS NULL
                        )
                    ),
                ADD CONSTRAINT ck_sys_operation_log_failure_reason
                    CHECK (success OR NULLIF(BTRIM(failure_reason), '''') IS NOT NULL)',
            tenant_schema
        );

        EXECUTE format(
            'CREATE INDEX idx_sys_operation_log_actor_time
                ON %I.sys_operation_log (actor_type, actor_username, operated_at DESC)',
            tenant_schema
        );
        EXECUTE format(
            'CREATE INDEX idx_sys_operation_log_target_time
                ON %I.sys_operation_log (target_type, target_id, operated_at DESC)',
            tenant_schema
        );
        EXECUTE format(
            'CREATE INDEX idx_sys_operation_log_target_no_time
                ON %I.sys_operation_log (target_type, target_no, operated_at DESC)',
            tenant_schema
        );
    END LOOP;
END $$;
