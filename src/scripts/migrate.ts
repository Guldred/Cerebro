import 'reflect-metadata';
import { promises as fs } from 'fs';
import * as path from 'path';
import { Pool } from 'pg';
import { loadConfig } from '../config/config';

/**
 * Minimal forward-only migration runner: applies every db/migrations/*.sql file
 * (sorted) exactly once, tracked in schema_migrations. Enough for the MVP; swap
 * for a full migration framework when the schema starts evolving (critique P3).
 */
async function main(): Promise<void> {
  const config = loadConfig();
  const pool = new Pool({ connectionString: config.databaseUrl });
  const migrationsDir = path.join(process.cwd(), 'db', 'migrations');

  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        filename TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )`);

    const files = (await fs.readdir(migrationsDir)).filter((f) => f.endsWith('.sql')).sort();
    const applied = new Set(
      (await pool.query<{ filename: string }>('SELECT filename FROM schema_migrations')).rows.map(
        (r) => r.filename,
      ),
    );

    let count = 0;
    for (const file of files) {
      if (applied.has(file)) {
        console.log(`= skip ${file} (already applied)`);
        continue;
      }
      const sql = await fs.readFile(path.join(migrationsDir, file), 'utf8');
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (filename) VALUES ($1)', [file]);
        await client.query('COMMIT');
        console.log(`+ applied ${file}`);
        count++;
      } catch (err) {
        await client.query('ROLLBACK');
        throw new Error(`Migration ${file} failed: ${String(err)}`);
      } finally {
        client.release();
      }
    }
    console.log(`Done. ${count} migration(s) applied.`);
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
