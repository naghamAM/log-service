import { Attributes, LEVELS, LogInput, Rejection } from './types';

const isPlainObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
export function validateLog(value: unknown, index: number): { log?: LogInput; rejected?: Rejection } {
  if (!isPlainObject(value)) return { rejected: { index, reason: 'entry must be an object' } };
  const { timestamp, level, service, message, attributes } = value;
  const date = typeof timestamp === 'string' ? new Date(timestamp) : new Date('invalid');
  if (Number.isNaN(date.getTime()) || typeof timestamp !== 'string') return { rejected: { index, reason: 'invalid timestamp' } };
  if (date.getTime() > Date.now() + 5 * 60_000) return { rejected: { index, reason: 'timestamp is more than five minutes in the future' } };
  if (typeof level !== 'string' || !LEVELS.includes(level as typeof LEVELS[number])) return { rejected: { index, reason: `invalid level: '${String(level)}'` } };
  if (typeof service !== 'string' || !service.trim()) return { rejected: { index, reason: 'service must be a non-empty string' } };
  if (typeof message !== 'string' || !message.trim()) return { rejected: { index, reason: 'message must be a non-empty string' } };
  if (attributes !== undefined && (!isPlainObject(attributes) || Object.values(attributes).some((v) => !['string', 'number', 'boolean'].includes(typeof v) || (typeof v === 'number' && !Number.isFinite(v))))) return { rejected: { index, reason: 'attributes must be a flat object with string, number, or boolean values' } };
  return { log: { timestamp: date.toISOString(), level: level as LogInput['level'], service: service.trim(), message: message.trim(), attributes: (attributes ?? {}) as Attributes } };
}
