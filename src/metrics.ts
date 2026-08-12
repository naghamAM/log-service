interface MetricSnapshot { requests: number; acceptedLogs: number; rejectedLogs: number; ingestionDurationMs: { count: number; total: number; average: number } }

let requests = 0;
let acceptedLogs = 0;
let rejectedLogs = 0;
let ingestionCount = 0;
let ingestionDurationTotal = 0;

export function recordIngestion(accepted: number, rejected: number, durationMs: number): void {
  requests += 1;
  acceptedLogs += accepted;
  rejectedLogs += rejected;
  ingestionCount += 1;
  ingestionDurationTotal += durationMs;
}

export function metrics(): MetricSnapshot {
  return { requests, acceptedLogs, rejectedLogs, ingestionDurationMs: { count: ingestionCount, total: Math.round(ingestionDurationTotal), average: ingestionCount ? Math.round(ingestionDurationTotal / ingestionCount) : 0 } };
}
