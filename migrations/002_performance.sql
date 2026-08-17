-- Store attributes once, keep one ordered read index, and maintain compact
-- per-second aggregates. The statements are safe for both the original schema
-- and databases created during development of the optimized schema.

ALTER TABLE logs
  ALTER COLUMN service TYPE TEXT;

ALTER TABLE logs
  DROP CONSTRAINT IF EXISTS logs_pkey;

DROP INDEX IF EXISTS logs_time_id_desc;
DROP INDEX IF EXISTS logs_service_time_desc;
DROP INDEX IF EXISTS logs_level_time_desc;
DROP INDEX IF EXISTS logs_service_hash;
DROP INDEX IF EXISTS logs_level_hash;
DROP INDEX IF EXISTS logs_message_trgm;
DROP INDEX IF EXISTS logs_message_trgm_gist;
DROP INDEX IF EXISTS logs_attribute_values_gin;

ALTER TABLE logs
  DROP COLUMN IF EXISTS attribute_values;

CREATE UNIQUE INDEX logs_time_id_desc
  ON logs (timestamp DESC, id DESC);

CREATE INDEX logs_attributes_gin
  ON logs USING GIN (attributes jsonb_path_ops)
  WITH (fastupdate = on, gin_pending_list_limit = 65536);

CREATE TABLE IF NOT EXISTS log_rollups (
  second_start TIMESTAMPTZ NOT NULL,
  service TEXT NOT NULL,
  level VARCHAR(10) NOT NULL,
  count BIGINT NOT NULL CHECK (count >= 0),
  PRIMARY KEY (second_start, service, level)
);

INSERT INTO log_rollups (second_start, service, level, count)
SELECT date_trunc('second', timestamp), service, level, count(*)
FROM logs
GROUP BY 1, 2, 3
ON CONFLICT (second_start, service, level)
DO UPDATE SET count = EXCLUDED.count;
