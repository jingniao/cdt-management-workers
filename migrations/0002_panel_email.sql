-- Optional email configuration now lives in the panel. Preserve existing values.
INSERT INTO settings(key, value) VALUES('notify_mail_webhook_url', '') ON CONFLICT(key) DO NOTHING;
INSERT INTO settings(key, value) VALUES('notify_mail_api_key', '') ON CONFLICT(key) DO NOTHING;
