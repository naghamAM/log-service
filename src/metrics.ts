import cluster from 'node:cluster';

type QueryKind = 'logs' | 'aggregate';

const SAMPLE_CAPACITY = 2_048;
const startedAt = Date.now();

class LatencySamples {
  private readonly values: number[] = [];
  private next = 0;
  count = 0;
  total = 0;

  add(value: number): void {
    this.count += 1;
    this.total += value;

    if (this.values.length < SAMPLE_CAPACITY) {
      this.values.push(value);
      return;
    }

    this.values[this.next] = value;
    this.next = (this.next + 1) % SAMPLE_CAPACITY;
  }

  snapshot(): {
    count: number;
    average: number;
    p50: number;
    p95: number;
    sampleSize: number;
  } {
    const sorted = [...this.values].sort((a, b) => a - b);
    const percentile = (fraction: number): number => {
      if (!sorted.length) return 0;
      return sorted[Math.ceil(sorted.length * fraction) - 1];
    };

    return {
      count: this.count,
      average: this.count ? Math.round(this.total / this.count) : 0,
      p50: Math.round(percentile(0.5)),
      p95: Math.round(percentile(0.95)),
      sampleSize: sorted.length,
    };
  }
}

let ingestionRequests = 0;
let acceptedLogs = 0;
let rejectedLogs = 0;
const ingestionLatency = new LatencySamples();
const queryLatency: Record<QueryKind, LatencySamples> = {
  logs: new LatencySamples(),
  aggregate: new LatencySamples(),
};

export function recordIngestion(
  accepted: number,
  rejected: number,
  durationMs: number,
): void {
  ingestionRequests += 1;
  acceptedLogs += accepted;
  rejectedLogs += rejected;
  ingestionLatency.add(durationMs);
}

export function recordQuery(kind: QueryKind, durationMs: number): void {
  queryLatency[kind].add(durationMs);
}

export function metrics(): Record<string, unknown> {
  const uptimeSeconds = Math.max((Date.now() - startedAt) / 1_000, 0.001);

  return {
    processId: process.pid,
    workerId: cluster.worker?.id ?? null,
    uptimeSeconds: Math.round(uptimeSeconds),
    requests: ingestionRequests,
    acceptedLogs,
    rejectedLogs,
    ingestionLogsPerSecond: Math.round(acceptedLogs / uptimeSeconds),
    ingestionDurationMs: ingestionLatency.snapshot(),
    queryDurationMs: {
      logs: queryLatency.logs.snapshot(),
      aggregate: queryLatency.aggregate.snapshot(),
    },
    note: 'Counters and latency samples are local to this worker process.',
  };
}
