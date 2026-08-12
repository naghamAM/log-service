import 'dotenv/config';
import express, { NextFunction, Request, Response } from 'express';
import cors from 'cors';
import { deleteExpired, migrate, pool } from './db';
import { aggregate, insertLogs, queryLogs } from './repository';
import { parseFilters } from './query-params';
import { validateLog } from './validation';
import { metrics, recordIngestion } from './metrics';

const app = express(); let ready = false;
app.use(cors()); app.use(express.json({ limit: process.env.MAX_BODY_SIZE ?? '10mb' }));
app.get('/health', (_req, res) => res.status(ready ? 200 : 503).json({ status: ready ? 'healthy' : 'starting' }));
app.get('/metrics', (_req, res) => res.json(metrics()));
app.post('/logs', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const started = performance.now();
    if (!req.body || !Array.isArray(req.body.logs)) return res.status(400).json({ error: 'body must be an object with a logs array' });
    const valid = []; const rejected = [];
    for (let i = 0; i < req.body.logs.length; i++) { const result = validateLog(req.body.logs[i], i); if (result.log) valid.push(result.log); if (result.rejected) rejected.push(result.rejected); }
    if (!valid.length) { recordIngestion(0, rejected.length, performance.now() - started); return res.status(400).json({ accepted: 0, rejected }); }
    await insertLogs(valid); recordIngestion(valid.length, rejected.length, performance.now() - started); res.json({ accepted: valid.length, rejected });
  } catch (error) { next(error); }
});
app.get('/logs', async (req, res, next) => { try { res.json(await queryLogs(parseFilters(req))); } catch (error) { next(error); } });
app.get('/logs/aggregate', async (req, res, next) => { try { res.json(await aggregate(parseFilters(req, true))); } catch (error) { next(error); } });
app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
  if (error instanceof SyntaxError && 'body' in error) return res.status(400).json({ error: 'malformed JSON' });
  if (error instanceof Error && (error.message.includes('invalid') || error.message.includes('must be') || error.message.includes('required'))) return res.status(400).json({ error: error.message });
  console.error(error); return res.status(500).json({ error: 'internal server error' });
});
app.use((_req, res) => res.status(404).json({ error: 'not found' }));

async function start(): Promise<void> {
  await pool.query('SELECT 1'); await migrate(); await deleteExpired(); ready = true;
  app.listen(Number(process.env.PORT ?? 8080), () => console.log('Log service listening on port 8080'));
  setInterval(() => void deleteExpired().catch(console.error), 60 * 60 * 1000).unref();
}
start().catch((error) => { console.error('Startup failed:', error); process.exit(1); });
process.on('SIGTERM', () => void pool.end().finally(() => process.exit(0)));
