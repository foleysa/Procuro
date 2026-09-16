-- Data Factory Day 0 — Postgres serving tables.
-- Apply when DATABASE_URL is set (drizzle-kit push or this file).
-- Idempotent. Does not require GCP credentials.
-- Reuses existing `market_signals` (do not recreate that table here).

CREATE TABLE IF NOT EXISTS data_factory_usage_log (
  id text PRIMARY KEY,
  org_id text REFERENCES orgs (id) ON DELETE SET NULL,
  actor text NOT NULL,
  route text NOT NULL,
  package_id text,
  source_id text,
  status_code text NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS data_factory_usage_org_idx
  ON data_factory_usage_log (org_id);
CREATE INDEX IF NOT EXISTS data_factory_usage_created_at_idx
  ON data_factory_usage_log (created_at);
CREATE INDEX IF NOT EXISTS data_factory_usage_package_idx
  ON data_factory_usage_log (package_id);

CREATE TABLE IF NOT EXISTS data_factory_layer_c_labels (
  id text PRIMARY KEY,
  public_signal_id text NOT NULL,
  package_id text,
  phase text NOT NULL,
  decide_action text,
  learn_outcome text,
  owner_role text,
  occurred_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS data_factory_layer_c_signal_idx
  ON data_factory_layer_c_labels (public_signal_id);
CREATE INDEX IF NOT EXISTS data_factory_layer_c_phase_idx
  ON data_factory_layer_c_labels (phase);

-- news_events: metadata only. Do NOT add html / body / full_text columns.
CREATE TABLE IF NOT EXISTS news_events (
  id text PRIMARY KEY,
  source_id text NOT NULL,
  title text NOT NULL,
  url text NOT NULL,
  published timestamptz,
  entities jsonb NOT NULL DEFAULT '[]'::jsonb,
  event_type text NOT NULL,
  severity text NOT NULL,
  raw_payload_pointer text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS news_events_url_uq ON news_events (url);
CREATE INDEX IF NOT EXISTS news_events_source_idx ON news_events (source_id);
CREATE INDEX IF NOT EXISTS news_events_published_idx ON news_events (published);
CREATE INDEX IF NOT EXISTS news_events_type_idx ON news_events (event_type);
