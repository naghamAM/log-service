import { pool } from './db';
import { LogInput, StoredLog } from './types';
import { ParsedFilters } from './query-params';

const normalise = (attributes: Record<string, unknown>) => Object.fromEntries(Object.entries(attributes).map(([key, value]) => [key, String(value)]));
export async function insertLogs(logs: LogInput[]): Promise<void> {
  if (!logs.length) return;
  await pool.query(`INSERT INTO logs (timestamp, level, service, message, attributes, attribute_values)
    SELECT * FROM UNNEST($1::timestamptz[], $2::varchar[], $3::varchar[], $4::text[], $5::jsonb[], $6::jsonb[])`, [
    logs.map((l) => l.timestamp), logs.map((l) => l.level), logs.map((l) => l.service), logs.map((l) => l.message),
    logs.map((l) => JSON.stringify(l.attributes ?? {})), logs.map((l) => JSON.stringify(normalise(l.attributes ?? {}))),
  ]);
}
function where(filters: ParsedFilters, params: unknown[]): string[] {
  const clauses: string[] = [];
  const add = (sql: string, value: unknown) => { params.push(value); clauses.push(sql.replace('?', `$${params.length}`)); };
  if (filters.service) add('service = ?', filters.service); if (filters.level) add('level = ?', filters.level);
  if (filters.since) add('timestamp >= ?', filters.since); if (filters.until) add('timestamp < ?', filters.until);
  if (filters.q) add('message ILIKE ?', `%${filters.q}%`);
  if (Object.keys(filters.attributes).length) add('attribute_values @> ?', JSON.stringify(filters.attributes));
  return clauses;
}
export async function queryLogs(filters: ParsedFilters): Promise<{ logs: StoredLog[]; next_cursor: string | null }> {
  const params: unknown[] = []; const clauses = where(filters, params);
  if (filters.cursor) { params.push(filters.cursor.timestamp, filters.cursor.id); clauses.push(`(timestamp, id) < ($${params.length - 1}::timestamptz, $${params.length}::bigint)`); }
  params.push(filters.limit + 1);
  const rows = (await pool.query(`SELECT id::text, timestamp, level, service, message, attributes FROM logs ${clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''} ORDER BY timestamp DESC, id DESC LIMIT $${params.length}`, params)).rows as StoredLog[];
  const hasMore = rows.length > filters.limit; const logs = rows.slice(0, filters.limit);
  const last = logs.at(-1); return { logs, next_cursor: hasMore && last ? Buffer.from(JSON.stringify({ timestamp: last.timestamp, id: last.id })).toString('base64url') : null };
}
export async function aggregate(filters: ParsedFilters): Promise<{ buckets: { start: string; group: string | null; count: number }[] }> {
  const params: unknown[] = []; const clauses = where(filters, params);
  const interval = ({ '1m': '1 minute', '5m': '5 minutes', '1h': '1 hour', '1d': '1 day' } as Record<string, string>)[filters.bucket!];
  params.push(interval); const bucketParam = `$${params.length}`; const groupColumn = filters.groupBy ? filters.groupBy : 'NULL::text';
  const rows = (await pool.query(`SELECT date_trunc(CASE WHEN ${bucketParam} IN ('1 minute','5 minutes') THEN 'minute' WHEN ${bucketParam} = '1 hour' THEN 'hour' ELSE 'day' END, timestamp) - CASE WHEN ${bucketParam} = '5 minutes' THEN (extract(minute from timestamp)::int % 5) * interval '1 minute' ELSE interval '0' END AS start, ${groupColumn} AS "group", count(*)::int AS count FROM logs WHERE ${clauses.join(' AND ')} GROUP BY 1, 2 ORDER BY 1 ASC, 2 ASC`, params)).rows;
  return { buckets: rows.map((r) => ({ start: new Date(r.start).toISOString(), group: r.group, count: r.count })) };
}
