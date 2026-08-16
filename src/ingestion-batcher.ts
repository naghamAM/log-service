import { insertLogs } from './repository';
import { LogInput } from './types';

interface PendingWrite { logs: LogInput[]; resolve: () => void; reject: (error: unknown) => void }

let pending: PendingWrite[] = [];
let timer: NodeJS.Timeout | undefined;

/**
 * Coalesces concurrent HTTP batches into one PostgreSQL write. Each caller is
 * resolved only after that write succeeds, so a 200 response still means data
 * is stored. The short 5ms window trades negligible latency for far fewer DB
 * round trips during high-volume ingestion.
 */
export function enqueueLogs(logs: LogInput[]): Promise<void> {
  return new Promise((resolve, reject) => {
    pending.push({ logs, resolve, reject });
    if (!timer) timer = setTimeout(flush, 5);
  });
}

async function flush(): Promise<void> {
  timer = undefined;
  const writes = pending;
  pending = [];
  try {
    await insertLogs(writes.flatMap((write) => write.logs));
    writes.forEach((write) => write.resolve());
  } catch (error) {
    writes.forEach((write) => write.reject(error));
  }
  if (pending.length && !timer) timer = setTimeout(flush, 5);
}
