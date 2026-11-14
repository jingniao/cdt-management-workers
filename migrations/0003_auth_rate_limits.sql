-- Atomic reservations prevent concurrent and cross-isolate login bypasses.
CREATE TABLE IF NOT EXISTS auth_rate_limits (
    key TEXT PRIMARY KEY,
    window_start INTEGER NOT NULL,
    attempts INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_auth_window ON auth_rate_limits(window_start);
