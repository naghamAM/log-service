import { Request } from 'express';
import { Level, LEVELS } from './types';

export interface ParsedFilters { service?: string; level?: Level; since?: string; until?: string; q?: string; attributes: Record<string, string>; limit: number; cursor?: { timestamp: string; id: string }; bucket?: '1m' | '5m' | '1h' | '1d'; groupBy?: 'service' | 'level' }
const single = (value: unknown, name: string): string | undefined => { if (value === undefined) return undefined; if (typeof value !== 'string') throw new Error(`${name} must be a single string`); return value; };
const date = (value: string | undefined, name: string): string | undefined => { if (!value) return undefined; if (Number.isNaN(new Date(value).getTime())) throw new Error(`invalid ${name} timestamp`); return new Date(value).toISOString(); };

export function parseFilters(req: Request, aggregation = false): ParsedFilters {
  const q = req.query; const service = single(q.service, 'service'); const level = single(q.level, 'level');
  if (level && !LEVELS.includes(level as Level)) throw new Error(`invalid level: '${level}'`);
  const since = date(single(q.since, 'since'), 'since'); const until = date(single(q.until, 'until'), 'until');
  if (since && until && new Date(until) <= new Date(since)) throw new Error('until must be later than since');
  const rawLimit = single(q.limit, 'limit'); const limit = rawLimit === undefined ? 100 : Number(rawLimit);
  if (!Number.isInteger(limit) || limit < 1 || limit > 1000) throw new Error('limit must be an integer between 1 and 1000');
  const attributes: Record<string, string> = {};
  for (const [key, raw] of Object.entries(q)) if (key.startsWith('attr.')) { const value = single(raw, key); if (!key.slice(5) || value === undefined) throw new Error(`invalid attribute filter: ${key}`); attributes[key.slice(5)] = value; }
  let cursor: ParsedFilters['cursor']; const rawCursor = single(q.cursor, 'cursor');
  if (rawCursor) { try { const parsed = JSON.parse(Buffer.from(rawCursor, 'base64url').toString()); if (!parsed || typeof parsed.id !== 'string' || typeof parsed.timestamp !== 'string' || Number.isNaN(new Date(parsed.timestamp).getTime())) throw new Error(); cursor = parsed; } catch { throw new Error('invalid cursor'); } }
  const filters: ParsedFilters = { service, level: level as Level | undefined, since, until, q: single(q.q, 'q'), attributes, limit, cursor };
  if (aggregation) { if (!since || !until) throw new Error('since and until are required'); const bucket = single(q.bucket, 'bucket'); if (!bucket || !['1m', '5m', '1h', '1d'].includes(bucket)) throw new Error('bucket must be one of: 1m, 5m, 1h, 1d'); const groupBy = single(q.group_by, 'group_by'); if (groupBy && groupBy !== 'service' && groupBy !== 'level') throw new Error('group_by must be service or level'); filters.bucket = bucket as ParsedFilters['bucket']; filters.groupBy = groupBy as ParsedFilters['groupBy']; }
  return filters;
}
