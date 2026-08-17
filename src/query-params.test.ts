import assert from 'node:assert/strict';
import test from 'node:test';
import { Request } from 'express';

import { parseFilters } from './query-params';

function request(query: Record<string, unknown>): Request {
  return { query } as unknown as Request;
}

test('parses combinable query filters and normalizes ISO timestamps', () => {
  const result = parseFilters(request({
    service: 'checkout',
    level: 'error',
    since: '2026-08-01T10:00:00+02:00',
    until: '2026-08-01T11:00:00+02:00',
    'attr.user_id': '42',
    q: 'declined',
    limit: '500',
  }));

  assert.equal(result.since, '2026-08-01T08:00:00.000Z');
  assert.equal(result.limit, 500);
  assert.deepEqual(result.attributes, { user_id: '42' });
});

test('rejects malformed timestamps, invalid limits, and malformed cursors', () => {
  assert.throws(() => parseFilters(request({ since: '2026-8-1' })), /invalid since timestamp/);
  assert.throws(() => parseFilters(request({ limit: '0' })), /limit must be/);
  assert.throws(() => parseFilters(request({ cursor: 'not-a-cursor' })), /invalid cursor/);
});
