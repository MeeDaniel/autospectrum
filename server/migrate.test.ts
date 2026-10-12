import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runMigrations } from './migrate';

const tempDirs: string[] = [];
afterEach(() => { for (const directory of tempDirs.splice(0)) rmSync(directory, { recursive: true, force: true }); });

function migrationDir(files: Record<string, string>): string {
  const directory = mkdtempSync(join(tmpdir(), 'autospectrum-migrate-'));
  tempDirs.push(directory);
  for (const [name, sql] of Object.entries(files)) writeFileSync(join(directory, name), sql);
  return directory;
}

function fakePool(failSql?: string) {
  const applied = new Map<string, string>();
  const executed: string[] = [];
  const client = {
    async query(sql: string, values: unknown[] = []) {
      if (sql.startsWith('SELECT name, checksum FROM schema_migrations')) {
        return { rows: [...applied].map(([name, checksum]) => ({ name, checksum })) };
      }
      if (sql.startsWith('INSERT INTO schema_migrations')) {
        applied.set(String(values[0]), String(values[1]));
      }
      executed.push(sql.trim());
      if (sql.trim() === failSql) throw new Error('SQL failed');
      return { rows: [] };
    },
    release() {},
  };
  return { pool: { connect: async () => client }, applied, executed };
}

describe('SQL migrations', () => {
  it('applies numbered files in order and skips them on the next run', async () => {
    const directory = migrationDir({
      '002_second.sql': 'CREATE TABLE second(id integer);',
      '001_first.sql': 'CREATE TABLE first(id integer);',
      'notes.txt': 'not a migration',
    });
    const { pool, applied, executed } = fakePool();

    await runMigrations(pool, directory);
    await runMigrations(pool, directory);

    expect(executed.filter(sql => sql.startsWith('CREATE TABLE first') || sql.startsWith('CREATE TABLE second'))).toEqual([
      'CREATE TABLE first(id integer);',
      'CREATE TABLE second(id integer);',
    ]);
    expect([...applied.keys()]).toEqual(['001_first.sql', '002_second.sql']);
    expect(executed.filter(sql => sql === 'BEGIN')).toHaveLength(2);
    expect(executed.filter(sql => sql === 'COMMIT')).toHaveLength(2);
  });

  it('rejects a changed applied file before applying any new migration', async () => {
    const directory = migrationDir({ '002_second.sql': 'CREATE TABLE original(id integer);' });
    const { pool, applied, executed } = fakePool();
    await runMigrations(pool, directory);
    writeFileSync(join(directory, '001_first.sql'), 'CREATE TABLE first(id integer);');
    writeFileSync(join(directory, '002_second.sql'), 'CREATE TABLE changed(id integer);');

    await expect(runMigrations(pool, directory)).rejects.toThrow('Applied migration changed: 002_second.sql');
    expect([...applied.keys()]).toEqual(['002_second.sql']);
    expect(executed).not.toContain('CREATE TABLE first(id integer);');
  });

  it('uses numeric sequence order even when file number widths differ', async () => {
    const directory = migrationDir({
      '10_tenth.sql': 'CREATE TABLE tenth(id integer);',
      '2_second.sql': 'CREATE TABLE second(id integer);',
    });
    const { pool, executed } = fakePool();
    await runMigrations(pool, directory);
    expect(executed.filter(sql => sql.startsWith('CREATE TABLE second') || sql.startsWith('CREATE TABLE tenth'))).toEqual([
      'CREATE TABLE second(id integer);',
      'CREATE TABLE tenth(id integer);',
    ]);
  });

  it('rolls back a failed file without recording it as applied', async () => {
    const sql = 'CREATE TABLE broken(id integer);';
    const directory = migrationDir({ '001_broken.sql': sql });
    const { pool, applied, executed } = fakePool(sql);

    await expect(runMigrations(pool, directory)).rejects.toThrow('SQL failed');
    expect(applied.size).toBe(0);
    expect(executed).toContain('ROLLBACK');
    expect(executed).not.toContain('COMMIT');
  });
});
