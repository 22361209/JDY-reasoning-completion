INSERT INTO sys_setting (setting_key, setting_value)
VALUES ('security.session_timeout_minutes', '30')
ON CONFLICT (setting_key) DO NOTHING;
