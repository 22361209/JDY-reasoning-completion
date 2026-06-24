CREATE TABLE IF NOT EXISTS sys_print_template (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    document_type VARCHAR(80) NOT NULL,
    template_code VARCHAR(80) NOT NULL,
    template_name VARCHAR(120) NOT NULL,
    company_name VARCHAR(200) NOT NULL,
    header_note VARCHAR(240) NOT NULL DEFAULT '',
    footer_note VARCHAR(240) NOT NULL DEFAULT '',
    show_signature BOOLEAN NOT NULL DEFAULT TRUE,
    show_seal BOOLEAN NOT NULL DEFAULT TRUE,
    is_default BOOLEAN NOT NULL DEFAULT TRUE,
    enabled BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT uq_sys_print_template_doc_code UNIQUE (document_type, template_code)
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_sys_print_template_default
    ON sys_print_template (document_type)
    WHERE is_default AND enabled;

INSERT INTO sys_print_template (
    document_type,
    template_code,
    template_name,
    company_name,
    header_note,
    footer_note,
    show_signature,
    show_seal,
    is_default,
    enabled
)
SELECT document_type,
       'STANDARD',
       '标准套打模板',
       '博莱德机械测试账套',
       '会计期间 2026-06 / 业务期间 2026-06',
       '本单据由 JDY 推理补完 ERP 生成，请按公司制度完成签字、盖章与归档。',
       TRUE,
       TRUE,
       TRUE,
       TRUE
FROM (VALUES
    ('sales-order'),
    ('purchase-order'),
    ('sales-out'),
    ('purchase-in'),
    ('material-issue'),
    ('product-in')
) AS seed(document_type)
ON CONFLICT (document_type, template_code) DO UPDATE
SET template_name = EXCLUDED.template_name,
    company_name = EXCLUDED.company_name,
    header_note = EXCLUDED.header_note,
    footer_note = EXCLUDED.footer_note,
    show_signature = EXCLUDED.show_signature,
    show_seal = EXCLUDED.show_seal,
    is_default = EXCLUDED.is_default,
    enabled = EXCLUDED.enabled,
    updated_at = now();
