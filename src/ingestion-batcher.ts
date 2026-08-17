import { insertLogs } from './repository';
import { LogInput } from './types';

interface PendingWrite {
  logs: LogInput[];
  resolve: () => void;
  reject: (error: unknown) => void;
}

const FLUSH_DELAY_MS = 5;
const MAX_LOGS_PER_DB_BATCH = 20_000;

let pending: PendingWrite[] = [];
let timer: NodeJS.Timeout | undefined;
let flushing = false;

export function enqueueLogs(logs: LogInput[]): Promise<void> {
  return new Promise((resolve, reject) => {
    pending.push({
      logs,
      resolve,
      reject,
    });

    scheduleFlush();
  });
}

function scheduleFlush(): void {
  if (timer || flushing) {
    return;
  }

  timer = setTimeout(() => {
    timer = undefined;
    void flush();
  }, FLUSH_DELAY_MS);
}

async function flush(): Promise<void> {
  if (flushing) {
    return;
  }

  flushing = true;

  const writes = pending;
  pending = [];

  if (!writes.length) {
    flushing = false;
    return;
  }

  try {
    const allLogs = writes.flatMap(
      (write) => write.logs,
    );

    for (
      let offset = 0;
      offset < allLogs.length;
      offset += MAX_LOGS_PER_DB_BATCH
    ) {
      const insertedRange = await insertLogs(
        allLogs.slice(
          offset,
          offset + MAX_LOGS_PER_DB_BATCH,
        ),
      );

      if (insertedRange && process.send) {
        process.send({
          type: 'logs-ingested',
          ...insertedRange,
        });
      }
    }

    for (const write of writes) {
      write.resolve();
    }
  } catch (error) {
    for (const write of writes) {
      write.reject(error);
    }
  } finally {
    flushing = false;

    if (pending.length) {
      scheduleFlush();
    }
  }
}
