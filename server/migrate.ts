import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { Pool } from 'pg';

type MigrationClient = {
  query(sql: string, values?: unknown[]): Promise<{ rows: { name: string; checksum: string }[] }>;
  release(): void;
};
type MigrationPool = { connect(): Promise<MigrationClient> };

export async function runMigrations(pool: MigrationPool, directory: string): Promise<void> {
  const sequence = (name: string) => BigInt(name.slice(0, name.indexOf('_')));
  const files = readdirSync(directory)
    .filter(name => /^\d+_[A-Za-z0-9_-]+\.sql$/.test(name))
    .sort((left, right) => {
      const first = sequence(left), second = sequence(right);
      return first < second ? -1 : first > second ? 1 : left.localeCompare(right);
    });
  const migrations = files.map(name => {
    const sql = readFileSync(resolve(directory, name), 'utf8');
    const checksum = createHash('sha256').update(sql).digest('hex');
    return { name, sql, checksum };
  });
  const client = await pool.connect();
  let locked = false;
  try {
    await client.query("SELECT pg_advisory_lock(hashtext('autospectrum_migrations'))");
    locked = true;
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      name text PRIMARY KEY,
      checksum text NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now()
    )`);
    const result = await client.query('SELECT name, checksum FROM schema_migrations');
    const applied = new Map(result.rows.map(row => [row.name, row.checksum]));
    for (const migration of migrations) {
      const existing = applied.get(migration.name);
      if (existing && existing !== migration.checksum) {
        throw new Error(`Applied migration changed: ${migration.name}`);
      }
    }
    for (const migration of migrations) {
      const existing = applied.get(migration.name);
      if (existing) continue;
      await client.query('BEGIN');
      try {
        await client.query(migration.sql);
        await client.query('INSERT INTO schema_migrations (name, checksum) VALUES ($1, $2)', [migration.name, migration.checksum]);
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      }
    }
  } finally {
    if (locked) await client.query("SELECT pg_advisory_unlock(hashtext('autospectrum_migrations'))");
    client.release();
  }
}

async function main(): Promise<void> {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    await runMigrations(pool, fileURLToPath(new URL('./migrations/', import.meta.url)));
  } finally {
    await pool.end();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
