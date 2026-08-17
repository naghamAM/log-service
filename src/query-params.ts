import { Request } from 'express';

import { parseIsoTimestamp } from './timestamp';
import { Level, LEVELS } from './types';

export interface ParsedFilters {
  service?: string;
  level?: Level;
  since?: string;
  until?: string;
  q?: string;
  attributes: Record<string, string>;
  limit: number;
  cursor?: { timestamp: string; id: string };
  bucket?: '1m' | '5m' | '1h' | '1d';
  groupBy?: 'service' | 'level';
}

function single(value: unknown, name: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== 'string') {
    throw new Error(`${name} must be a single string`);
  }

  return value;
}

function date(value: string | undefined, name: string): string | undefined {
  if (!value) {
    return undefined;
  }

  const parsed = parseIsoTimestamp(value);
  if (!parsed) {
    throw new Error(`invalid ${name} timestamp`);
  }

  return parsed.toISOString();
}

function parseCursor(value: string | undefined): ParsedFilters['cursor'] {
  if (!value) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(
      Buffer.from(value, 'base64url').toString(),
    );

    if (
      !parsed ||
      typeof parsed.id !== 'string' ||
      !parseIsoTimestamp(parsed.timestamp)
    ) {
      throw new Error('invalid cursor');
    }

    return parsed;
  } catch {
    throw new Error('invalid cursor');
  }
}

export function parseFilters(
  req: Request,
  aggregation = false,
): ParsedFilters {
  const query = req.query;
  const service = single(query.service, 'service');
  const level = single(query.level, 'level');

  if (level && !LEVELS.includes(level as Level)) {
    throw new Error(`invalid level: '${level}'`);
  }

  const since = date(single(query.since, 'since'), 'since');
  const until = date(single(query.until, 'until'), 'until');

  if (since && until && new Date(until) <= new Date(since)) {
    throw new Error('until must be later than since');
  }

  const rawLimit = single(query.limit, 'limit');
  const limit = rawLimit === undefined ? 100 : Number(rawLimit);
  if (!Number.isInteger(limit) || limit < 1 || limit > 1000) {
    throw new Error('limit must be an integer between 1 and 1000');
  }

  const attributes: Record<string, string> = {};
  for (const [key, raw] of Object.entries(query)) {
    if (!key.startsWith('attr.')) {
      continue;
    }

    const value = single(raw, key);
    if (!key.slice(5) || value === undefined) {
      throw new Error(`invalid attribute filter: ${key}`);
    }

    attributes[key.slice(5)] = value;
  }

  const filters: ParsedFilters = {
    service,
    level: level as Level | undefined,
    since,
    until,
    q: single(query.q, 'q'),
    attributes,
    limit,
    cursor: parseCursor(single(query.cursor, 'cursor')),
  };

  if (!aggregation) {
    return filters;
  }

  if (!since || !until) {
    throw new Error('since and until are required');
  }

  const bucket = single(query.bucket, 'bucket');
  if (!bucket || !['1m', '5m', '1h', '1d'].includes(bucket)) {
    throw new Error('bucket must be one of: 1m, 5m, 1h, 1d');
  }

  const groupBy = single(query.group_by, 'group_by');
  if (groupBy && groupBy !== 'service' && groupBy !== 'level') {
    throw new Error('group_by must be service or level');
  }

  filters.bucket = bucket as ParsedFilters['bucket'];
  filters.groupBy = groupBy as ParsedFilters['groupBy'];
  return filters;
}
