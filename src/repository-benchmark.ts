import 'dotenv/config';

import { performance } from 'node:perf_hooks';
import { insertLogs } from './repository';
import { pool } from './db';
import { LogInput } from './types';

const TOTAL = Number(process.argv[2] ?? 200000);
const BATCH_SIZE = Number(process.argv[3] ?? 10000);

function makeBatch(size: number): LogInput[] {
  const timestamp = new Date().toISOString();

  return Array.from({ length: size }, (_, i) => ({
    timestamp,
    level: i % 20 === 0 ? 'error' : 'info',
    service: `service-${i % 5}`,
    message: `request completed ${i}`,
    attributes: {
      region: 'eu-west',
      attempt: i % 3,
    },
  }));
}

async function main(): Promise<void> {
  const batches: LogInput[][] = [];

  for (let offset = 0; offset < TOTAL; offset += BATCH_SIZE) {
    batches.push(
      makeBatch(
        Math.min(BATCH_SIZE, TOTAL - offset),
      ),
    );
  }

  const started = performance.now();

  for (const batch of batches) {
    await insertLogs(batch);
  }

  const seconds = (performance.now() - started) / 1000;

  console.log({
    total: TOTAL,
    batchSize: BATCH_SIZE,
    seconds: seconds.toFixed(2),
    logsPerSecond: Math.round(TOTAL / seconds),
  });

  await pool.end();
}

main().catch(async (error) => {
  console.error(error);
  await pool.end();
  process.exit(1);
});
