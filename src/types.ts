export const LEVELS = ['debug', 'info', 'warn', 'error'] as const;
export type Level = (typeof LEVELS)[number];
export type Attributes = Record<string, string | number | boolean>;
export interface LogInput { timestamp: string; level: Level; service: string; message: string; attributes?: Attributes }
export interface StoredLog extends Omit<LogInput, 'timestamp'> { id: string; timestamp: string; attributes: Attributes }
export interface Rejection { index: number; reason: string }
