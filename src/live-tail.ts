import { once } from 'node:events';

import { Response } from 'express';

import { ParsedFilters } from './query-params';
import { queryLogsByIdRange } from './repository';

interface InsertedRange {
  minId: string;
  maxId: string;
}

interface Subscriber {
  response: Response;
  filters: ParsedFilters;
  queue: InsertedRange[];
  flushing: boolean;
  closed: boolean;
  seen: Set<string>;
  seenOrder: string[];
  heartbeat: NodeJS.Timeout;
}

const subscribers = new Set<Subscriber>();
const MAX_REMEMBERED_IDS = 50_000;

async function write(response: Response, value: string): Promise<void> {
  if (!response.write(value)) {
    await once(response, 'drain');
  }
}

async function flush(subscriber: Subscriber): Promise<void> {
  if (subscriber.flushing || subscriber.closed) return;
  subscriber.flushing = true;

  try {
    while (subscriber.queue.length && !subscriber.closed) {
      const range = subscriber.queue.shift()!;
      const logs = await queryLogsByIdRange(
        range.minId,
        range.maxId,
        subscriber.filters,
      );

      for (const log of logs) {
        if (subscriber.closed || subscriber.seen.has(log.id)) continue;

        subscriber.seen.add(log.id);
        subscriber.seenOrder.push(log.id);
        if (subscriber.seenOrder.length > MAX_REMEMBERED_IDS) {
          subscriber.seen.delete(subscriber.seenOrder.shift()!);
        }

        await write(
          subscriber.response,
          `event: log\ndata: ${JSON.stringify(log)}\n\n`,
        );
      }
    }
  } catch (error) {
    if (!subscriber.closed) {
      console.error('Live-tail delivery failed:', error);
      subscriber.response.end();
    }
  } finally {
    subscriber.flushing = false;
  }
}

export function publishInsertedRange(range: InsertedRange): void {
  for (const subscriber of subscribers) {
    subscriber.queue.push(range);
    void flush(subscriber);
  }
}

export function subscribeLiveTail(
  response: Response,
  filters: ParsedFilters,
): void {
  response.status(200);
  response.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  response.flushHeaders();
  response.write('event: ready\ndata: {}\n\n');

  const subscriber = {} as Subscriber;
  Object.assign(subscriber, {
    response,
    filters,
    queue: [],
    flushing: false,
    closed: false,
    seen: new Set<string>(),
    seenOrder: [],
    heartbeat: setInterval(() => {
      if (!subscriber.closed) response.write(': keep-alive\n\n');
    }, 15_000),
  });

  subscribers.add(subscriber);

  response.once('close', () => {
    subscriber.closed = true;
    clearInterval(subscriber.heartbeat);
    subscribers.delete(subscriber);
  });
}
