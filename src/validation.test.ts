import test from 'node:test';
import assert from 'node:assert/strict';
import { validateLog } from './validation';

const valid = { timestamp: '2026-08-01T10:00:00.000Z', level: 'info', service: 'api', message: 'started', attributes: { attempts: 2 } };

test('accepts a valid structured log', () => {
  const result = validateLog(valid, 0);
  assert.equal(result.rejected, undefined);
  assert.equal(result.log?.attributes?.attempts, 2);
});

test('rejects invalid levels without throwing', () => {
  const result = validateLog({ ...valid, level: 'critical' }, 4);
  assert.deepEqual(result.rejected, { index: 4, reason: "invalid level: 'critical'" });
});

test('rejects nested attributes', () => {
  assert.match(validateLog({ ...valid, attributes: { nested: { x: 1 } } }, 0).rejected?.reason ?? '', /flat object/);
});
