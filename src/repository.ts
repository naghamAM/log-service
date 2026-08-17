import { pool } from './db';
import { ParsedFilters } from './query-params';
import { LogInput, StoredLog } from './types';

export async function insertLogs(
  logs: LogInput[],
): Promise<{ minId: string; maxId: string } | undefined> {
  if (!logs.length) {
    return;
  }

  const result = await pool.query(
    `
      WITH batch AS (
        SELECT *
        FROM jsonb_to_recordset($1::jsonb) AS entry(
          timestamp timestamptz,
          level varchar(10),
          service text,
          message text,
          attributes jsonb
        )
      ),
      inserted AS (
        INSERT INTO logs (
          timestamp,
          level,
          service,
          message,
          attributes
        )
        SELECT
          timestamp,
          level,
          service,
          message,
          COALESCE(attributes, '{}'::jsonb)
        FROM batch
        RETURNING id, timestamp, service, level
      ),
      grouped AS (
        SELECT
          date_trunc('second', timestamp) AS second_start,
          service,
          level,
          count(*) AS count
        FROM inserted
        GROUP BY 1, 2, 3
      ),
      rollup_write AS (
        INSERT INTO log_rollups (
          second_start,
          service,
          level,
          count
        )
        SELECT second_start, service, level, count
        FROM grouped
        ON CONFLICT (second_start, service, level)
        DO UPDATE SET count = log_rollups.count + EXCLUDED.count
        RETURNING 1
      )
      SELECT
        min(id)::text AS "minId",
        max(id)::text AS "maxId",
        (SELECT count(*) FROM rollup_write) AS rollups_written
      FROM inserted
    `,
    [JSON.stringify(logs)],
  );

  const row = result.rows[0] as
    | { minId: string | null; maxId: string | null }
    | undefined;

  return row?.minId && row.maxId
    ? { minId: row.minId, maxId: row.maxId }
    : undefined;
}

function where(
  filters: ParsedFilters,
  params: unknown[],
): string[] {
  const clauses: string[] = [];

  if (filters.service) {
    params.push(filters.service);

    clauses.push(
      `service = $${params.length}`,
    );
  }

  if (filters.level) {
    params.push(filters.level);

    clauses.push(
      `level = $${params.length}`,
    );
  }

  if (filters.since) {
    params.push(filters.since);

    clauses.push(
      `timestamp >= $${params.length}`,
    );
  }

  if (filters.until) {
    params.push(filters.until);

    clauses.push(
      `timestamp < $${params.length}`,
    );
  }

  if (filters.q) {
    params.push(
      `%${filters.q}%`,
    );

    clauses.push(
      `message ILIKE $${params.length}`,
    );
  }

  for (const [key, value] of Object.entries(filters.attributes)) {
    const variants: Array<string | number | boolean> = [value];

    if (value === 'true' || value === 'false') {
      variants.push(value === 'true');
    }

    if (value !== '') {
      const numeric = Number(value);
      if (Number.isFinite(numeric) && String(numeric) === value) {
        variants.push(numeric);
      }
    }

    const alternatives = variants.map((variant) => {
      params.push(JSON.stringify({ [key]: variant }));
      return `attributes @> $${params.length}::jsonb`;
    });

    clauses.push(`(${alternatives.join(' OR ')})`);
  }

  return clauses;
}

export async function queryLogs(
  filters: ParsedFilters,
): Promise<{
  logs: StoredLog[];
  next_cursor: string | null;
}> {
  const params: unknown[] = [];

  const clauses = where(
    filters,
    params,
  );

  if (filters.cursor) {
    params.push(
      filters.cursor.timestamp,
      filters.cursor.id,
    );

    clauses.push(
      `(timestamp, id) < (` +
        `$${params.length - 1}::timestamptz, ` +
        `$${params.length}::bigint` +
      `)`,
    );
  }

  params.push(
    filters.limit + 1,
  );

  const result =
    await pool.query(
      `
        SELECT
          id::text,
          timestamp,
          level,
          service,
          message,
          attributes
        FROM logs
        ${
          clauses.length
            ? `WHERE ${clauses.join(' AND ')}`
            : ''
        }
        ORDER BY
          logs.timestamp DESC,
          logs.id DESC
        LIMIT $${params.length}
      `,
      params,
    );

  const rows =
    result.rows as StoredLog[];

  const hasMore =
    rows.length > filters.limit;

  const logs =
    rows.slice(
      0,
      filters.limit,
    );

  const last =
    logs.at(-1);

  return {
    logs,

    next_cursor:
      hasMore && last
        ? Buffer.from(
            JSON.stringify({
              timestamp:
                last.timestamp,
              id: last.id,
            }),
          ).toString(
            'base64url',
          )
        : null,
  };
}

export async function queryLogsByIdRange(
  minId: string,
  maxId: string,
  filters: ParsedFilters,
): Promise<StoredLog[]> {
  const params: unknown[] = [minId, maxId];
  const clauses = [
    'id >= $1::bigint',
    'id <= $2::bigint',
    ...where(filters, params),
  ];

  const result = await pool.query(
    `
      SELECT
        id::text,
        timestamp,
        level,
        service,
        message,
        attributes
      FROM logs
      WHERE ${clauses.join(' AND ')}
      ORDER BY logs.id ASC
    `,
    params,
  );

  return result.rows as StoredLog[];
}

async function aggregateFromRollups(
  filters: ParsedFilters,
  interval: string,
  groupColumn: string,
): Promise<{ rows: Record<string, unknown>[] }> {
  const since = filters.since!;
  const until = filters.until!;
  const rollupStart = new Date(
    Math.ceil(Date.parse(since) / 1000) * 1000,
  ).toISOString();
  const rollupEnd = new Date(
    Math.floor(Date.parse(until) / 1000) * 1000,
  ).toISOString();

  if (rollupStart >= rollupEnd) {
    return { rows: [] };
  }

  const params: unknown[] = [since, until, rollupStart, rollupEnd];
  const rawClauses = [
    'timestamp >= $1',
    'timestamp < $2',
    '(timestamp < $3 OR timestamp >= $4)',
  ];
  const rollupClauses = [
    'second_start >= $3',
    'second_start < $4',
  ];

  if (filters.service) {
    params.push(filters.service);
    rawClauses.push(`service = $${params.length}`);
    rollupClauses.push(`service = $${params.length}`);
  }

  if (filters.level) {
    params.push(filters.level);
    rawClauses.push(`level = $${params.length}`);
    rollupClauses.push(`level = $${params.length}`);
  }

  params.push(interval);
  const intervalParam = `$${params.length}`;

  return pool.query(
    `
      WITH events AS (
        SELECT
          timestamp AS event_time,
          service,
          level,
          1::bigint AS event_count
        FROM logs
        WHERE ${rawClauses.join(' AND ')}

        UNION ALL

        SELECT
          second_start AS event_time,
          service,
          level,
          count AS event_count
        FROM log_rollups
        WHERE ${rollupClauses.join(' AND ')}
      )
      SELECT
        date_trunc(
          CASE
            WHEN ${intervalParam} IN ('1 minute', '5 minutes') THEN 'minute'
            WHEN ${intervalParam} = '1 hour' THEN 'hour'
            ELSE 'day'
          END,
          event_time
        )
        - CASE
            WHEN ${intervalParam} = '5 minutes'
            THEN (extract(minute FROM event_time)::int % 5) * interval '1 minute'
            ELSE interval '0'
          END AS start,
        ${groupColumn} AS "group",
        sum(event_count)::int AS count
      FROM events
      GROUP BY 1, 2
      ORDER BY 1 ASC, 2 ASC
    `,
    params,
  );
}

export async function aggregate(
  filters: ParsedFilters,
): Promise<{
  buckets: {
    start: string;
    group: string | null;
    count: number;
  }[];
}> {
  const intervals:
    Record<string, string> = {
      '1m': '1 minute',
      '5m': '5 minutes',
      '1h': '1 hour',
      '1d': '1 day',
    };

  const interval =
    intervals[
      filters.bucket!
    ];

  const groupColumn =
    filters.groupBy ===
    'service'
      ? 'service'
      : filters.groupBy ===
          'level'
        ? 'level'
        : 'NULL::text';

  if (
    !filters.q &&
    Object.keys(filters.attributes).length === 0
  ) {
    const rollupResult = await aggregateFromRollups(
      filters,
      interval,
      groupColumn,
    );

    if (rollupResult.rows.length) {
      return {
        buckets: rollupResult.rows.map((row) => ({
          start: new Date(row.start as string).toISOString(),
          group: row.group as string | null,
          count: Number(row.count),
        })),
      };
    }
  }

  const params: unknown[] = [];
  const clauses = where(filters, params);

  params.push(interval);
  const intervalParam = `$${params.length}`;

  const result =
    await pool.query(
      `
        SELECT
          date_trunc(
            CASE
              WHEN ${intervalParam}
                IN (
                  '1 minute',
                  '5 minutes'
                )
                THEN 'minute'

              WHEN ${intervalParam}
                = '1 hour'
                THEN 'hour'

              ELSE 'day'
            END,
            timestamp
          )
          -
          CASE
            WHEN ${intervalParam}
              = '5 minutes'
            THEN (
              extract(
                minute
                FROM timestamp
              )::int % 5
            ) * interval '1 minute'

            ELSE interval '0'
          END AS start,

          ${groupColumn}
            AS "group",

          count(*)::int
            AS count

        FROM logs

        ${
          clauses.length
            ? `WHERE ${clauses.join(' AND ')}`
            : ''
        }

        GROUP BY 1, 2

        ORDER BY 1 ASC, 2 ASC
      `,
      params,
    );

  return {
    buckets:
      result.rows.map(
        (row) => ({
          start:
            new Date(
              row.start,
            ).toISOString(),

          group:
            row.group,

          count:
            row.count,
        }),
      ),
  };
}
