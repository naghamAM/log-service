CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE TABLE IF NOT EXISTS logs (
  id BIGSERIAL PRIMARY KEY,

  timestamp TIMESTAMPTZ NOT NULL,

  level VARCHAR(10) NOT NULL
    CHECK (level IN ('debug', 'info', 'warn', 'error')),

  service VARCHAR(100) NOT NULL
    CHECK (length(btrim(service)) > 0),

  message TEXT NOT NULL
    CHECK (length(btrim(message)) > 0),

  attributes JSONB NOT NULL DEFAULT '{}'::jsonb,

  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS logs_time_id_desc
  ON logs (timestamp DESC, id DESC);

CREATE INDEX IF NOT EXISTS logs_service_time_desc
  ON logs (service, timestamp DESC, id DESC);

CREATE INDEX IF NOT EXISTS logs_level_time_desc
  ON logs (level, timestamp DESC, id DESC);

CREATE INDEX IF NOT EXISTS logs_message_trgm
  ON logs USING GIN (message gin_trgm_ops);
