INSERT INTO sys_setting (setting_key, setting_value)
VALUES
    ('security.password_min_length', '8'),
    ('security.password_require_uppercase', 'true'),
    ('security.password_require_lowercase', 'true'),
    ('security.password_require_digit', 'true'),
    ('security.password_require_symbol', 'true')
ON CONFLICT (setting_key) DO NOTHING;
