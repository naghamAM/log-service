import 'dotenv/config';

import cluster from 'node:cluster';
import path from 'node:path';

import cors from 'cors';
import express, {
  NextFunction,
  Request,
  Response,
} from 'express';

import {
  deleteExpired,
  migrate,
  pool,
} from './db';

import {
  aggregate,
  queryLogs,
} from './repository';

import { parseFilters } from './query-params';
import { validateLog } from './validation';

import {
  metrics,
  recordIngestion,
  recordQuery,
} from './metrics';

import { enqueueLogs } from './ingestion-batcher';
import {
  publishInsertedRange,
  subscribeLiveTail,
} from './live-tail';

interface IngestionMessage {
  type: 'logs-ingested';
  minId: string;
  maxId: string;
}

function isIngestionMessage(value: unknown): value is IngestionMessage {
  if (!value || typeof value !== 'object') return false;
  const message = value as Record<string, unknown>;
  return message.type === 'logs-ingested' &&
    typeof message.minId === 'string' &&
    typeof message.maxId === 'string';
}

const app = express();

const yieldToEventLoop = (): Promise<void> =>
  new Promise((resolve) => setImmediate(resolve));

const MAX_CONCURRENT_INGESTION_REQUESTS = 4;
let activeIngestionRequests = 0;
const ingestionQueue: Array<() => void> = [];

let ready = false;

app.use(cors());

app.use(
  '/dashboard',
  express.static(
    path.join(process.cwd(), 'public', 'dashboard'),
    { index: 'index.html' },
  ),
);

app.use((req, res, next) => {
  if (req.method !== 'POST' || req.path !== '/logs') {
    next();
    return;
  }

  const enter = () => {
    activeIngestionRequests += 1;
    let released = false;

    const release = () => {
      if (released) return;
      released = true;
      activeIngestionRequests -= 1;
      ingestionQueue.shift()?.();
    };

    res.once('finish', release);
    res.once('close', release);
    next();
  };

  if (activeIngestionRequests < MAX_CONCURRENT_INGESTION_REQUESTS) {
    enter();
  } else {
    ingestionQueue.push(enter);
  }
});

app.use(
  express.json({
    limit:
      process.env.MAX_BODY_SIZE ??
      '10mb',
  }),
);

// --------------------------------------
// Health
// --------------------------------------

app.get(
  '/health',
  (_req, res) => {
    res
      .status(ready ? 200 : 503)
      .json({
        status:
          ready
            ? 'healthy'
            : 'starting',
      });
  },
);

// --------------------------------------
// Metrics
// --------------------------------------

app.get(
  '/metrics',
  (_req, res) => {
    res.json(metrics());
  },
);

// --------------------------------------
// Temporary benchmark: HTTP + JSON parse
// --------------------------------------

app.post(
  '/_bench/parse',
  (
    req: Request,
    res: Response,
  ) => {
    if (
      !req.body ||
      !Array.isArray(req.body.logs)
    ) {
      return res
        .status(400)
        .json({
          error:
            'body must be an object with a logs array',
        });
    }

    return res.json({
      accepted:
        req.body.logs.length,
      rejected: [],
    });
  },
);

// --------------------------------------
// Temporary benchmark:
// HTTP + JSON parse + validation
// --------------------------------------

app.post(
  '/_bench/validate',
  (
    req: Request,
    res: Response,
  ) => {
    if (
      !req.body ||
      !Array.isArray(req.body.logs)
    ) {
      return res
        .status(400)
        .json({
          error:
            'body must be an object with a logs array',
        });
    }

    let accepted = 0;
    let rejected = 0;

    for (
      let i = 0;
      i < req.body.logs.length;
      i++
    ) {
      const result =
        validateLog(
          req.body.logs[i],
          i,
        );

      if (result.log) {
        accepted += 1;
      }

      if (result.rejected) {
        rejected += 1;
      }
    }

    return res.json({
      accepted,
      rejected,
    });
  },
);

// --------------------------------------
// POST /logs
// --------------------------------------

app.post(
  '/logs',
  async (
    req: Request,
    res: Response,
    next: NextFunction,
  ) => {
    try {
      const started =
        performance.now();

      if (
        !req.body ||
        !Array.isArray(
          req.body.logs,
        )
      ) {
        return res
          .status(400)
          .json({
            error:
              'body must be an object with a logs array',
          });
      }

      const valid = [];
      const rejected = [];

      for (
        let i = 0;
        i <
        req.body.logs.length;
        i++
      ) {
        if (i > 0 && i % 50 === 0) {
          await yieldToEventLoop();
        }

        const result =
          validateLog(
            req.body.logs[i],
            i,
          );

        if (result.log) {
          valid.push(
            result.log,
          );
        }

        if (
          result.rejected
        ) {
          rejected.push(
            result.rejected,
          );
        }
      }

      if (!valid.length) {
        recordIngestion(
          0,
          rejected.length,
          performance.now() -
            started,
        );

        return res
          .status(400)
          .json({
            accepted: 0,
            rejected,
          });
      }

      await enqueueLogs(valid);

      recordIngestion(
        valid.length,
        rejected.length,
        performance.now() -
          started,
      );

      return res.json({
        accepted:
          valid.length,
        rejected,
      });
    } catch (error) {
      next(error);
    }
  },
);

// --------------------------------------
// GET /logs/tail
// --------------------------------------

app.get(
  '/logs/tail',
  (
    req,
    res,
    next,
  ) => {
    try {
      const filters = parseFilters(req);
      subscribeLiveTail(res, filters);
    } catch (error) {
      next(error);
    }
  },
);

// --------------------------------------
// GET /logs
// --------------------------------------

app.get(
  '/logs',
  async (
    req,
    res,
    next,
  ) => {
    const started = performance.now();

    try {
      const filters =
        parseFilters(req);

      const result =
        await queryLogs(
          filters,
        );

      res.json(result);
    } catch (error) {
      next(error);
    } finally {
      recordQuery('logs', performance.now() - started);
    }
  },
);

// --------------------------------------
// GET /logs/aggregate
// --------------------------------------

app.get(
  '/logs/aggregate',
  async (
    req,
    res,
    next,
  ) => {
    const started = performance.now();

    try {
      const filters =
        parseFilters(
          req,
          true,
        );

      const result =
        await aggregate(
          filters,
        );

      res.json(result);
    } catch (error) {
      next(error);
    } finally {
      recordQuery('aggregate', performance.now() - started);
    }
  },
);

// --------------------------------------
// Error handling
// --------------------------------------

app.use(
  (
    error: unknown,
    _req: Request,
    res: Response,
    _next: NextFunction,
  ) => {
    if (
      error instanceof
        SyntaxError &&
      'body' in error
    ) {
      return res
        .status(400)
        .json({
          error:
            'malformed JSON',
        });
    }

    if (
      error instanceof Error &&
      (
        error.message.includes(
          'invalid',
        ) ||
        error.message.includes(
          'must be',
        ) ||
        error.message.includes(
          'required',
        )
      )
    ) {
      return res
        .status(400)
        .json({
          error:
            error.message,
        });
    }

    console.error(error);

    return res
      .status(500)
      .json({
        error:
          'internal server error',
      });
  },
);

// --------------------------------------
// 404
// --------------------------------------

app.use(
  (_req, res) => {
    res
      .status(404)
      .json({
        error: 'not found',
      });
  },
);

// --------------------------------------
// Startup
// --------------------------------------

async function startWorker(): Promise<void> {
  await pool.query(
    'SELECT 1',
  );

  ready = true;

  process.on('message', (message: unknown) => {
    if (isIngestionMessage(message)) {
      publishInsertedRange(message);
    }
  });

  app.listen(
    Number(
      process.env.PORT ??
        8080,
    ),
    () => {
      console.log(
        `Log worker ${process.pid} listening on port 8080`,
      );
    },
  );
}

async function startPrimary(): Promise<void> {
  await pool.query('SELECT 1');
  await migrate();
  await deleteExpired();

  for (let worker = 0; worker < 3; worker++) {
    cluster.fork();
  }

  cluster.on('message', (_worker, message: unknown) => {
    if (!isIngestionMessage(message)) return;

    for (const worker of Object.values(cluster.workers ?? {})) {
      worker?.send(message);
    }
  });

  setInterval(
    () =>
      void deleteExpired()
        .catch(
          console.error,
        ),
    60 * 60 * 1000,
  ).unref();
}

const startup = cluster.isPrimary
  ? startPrimary()
  : startWorker();

startup.catch(
  (error) => {
    console.error(
      'Startup failed:',
      error,
    );

    process.exit(1);
  },
);

// --------------------------------------
// Shutdown
// --------------------------------------

process.on(
  'SIGTERM',
  () => {
    if (cluster.isPrimary) {
      for (const worker of Object.values(cluster.workers ?? {})) {
        worker?.kill('SIGTERM');
      }
    }

    void pool
      .end()
      .finally(
        () =>
          process.exit(0),
      );
  },
);
