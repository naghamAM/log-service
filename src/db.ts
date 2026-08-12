import { Pool } from 'pg';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

export const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: Number(process.env.PGPOOL_MAX ?? 8), idleTimeoutMillis: 30_000 });

export async function migrate(): Promise<void> {
  await pool.query('CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())');
  const directory = path.join(process.cwd(), 'migrations');
  for (const name of (await readdir(directory)).filter((file) => file.endsWith('.sql')).sort()) {
    if ((await pool.query('SELECT 1 FROM schema_migrations WHERE name = $1', [name])).rowCount) continue;
    const client = await pool.connect();
    try { await client.query('BEGIN'); await client.query(await readFile(path.join(directory, name), 'utf8')); await client.query('INSERT INTO schema_migrations(name) VALUES ($1)', [name]); await client.query('COMMIT'); }
    catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
  }
}

export async function deleteExpired(): Promise<void> {
  const days = Number(process.env.RETENTION_DAYS ?? 30);
  // Small batches prevent a retention sweep from holding long locks.
  while (true) {
    const result = await pool.query(`DELETE FROM logs WHERE id IN (SELECT id FROM logs WHERE timestamp < now() - ($1 * interval '1 day') LIMIT 10000)`, [days]);
    if (result.rowCount === 0) break;
  }
}
