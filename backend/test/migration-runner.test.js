import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runMigrations } from '../src/db/migrate.js';

function createMigrationPool() {
  const applied = new Map();
  const statements = [];

  return {
    applied,
    statements,
    async connect() {
      return {
        async query(sql, params = []) {
          statements.push({ sql, params });
          if (sql.startsWith('SELECT checksum')) {
            const checksum = applied.get(params[0]);
            return checksum
              ? { rowCount: 1, rows: [{ checksum }] }
              : { rowCount: 0, rows: [] };
          }
          if (sql.startsWith('INSERT INTO schema_migrations')) {
            applied.set(params[0], params[1]);
            return { rowCount: 1, rows: [] };
          }
          return { rowCount: 0, rows: [] };
        },
        release() {}
      };
    }
  };
}

test('migration runner applies and records migrations atomically, then skips them', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'sauti-migrations-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(
    join(directory, '0001_sample.sql'),
    '-- sample migration with a header comment\nBEGIN;\nCREATE TABLE sample_table (id integer);\nCOMMIT;\n'
  );

  const pool = createMigrationPool();
  const applied = await runMigrations(pool, { migrationsDirectory: directory });
  assert.deepEqual(applied, ['0001_sample.sql']);
  assert.ok(pool.statements.some(entry => entry.sql === 'BEGIN'));
  assert.ok(pool.statements.some(entry => entry.sql === 'COMMIT'));
  assert.ok(pool.statements.some(entry => entry.sql.includes('CREATE TABLE sample_table')));

  assert.deepEqual(
    await runMigrations(pool, { migrationsDirectory: directory }),
    []
  );
});

test('migration runner refuses to silently change an applied migration', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'sauti-migrations-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const migrationPath = join(directory, '0001_sample.sql');
  await writeFile(migrationPath, 'BEGIN;\nSELECT 1;\nCOMMIT;\n');

  const pool = createMigrationPool();
  await runMigrations(pool, { migrationsDirectory: directory });
  await writeFile(migrationPath, 'BEGIN;\nSELECT 2;\nCOMMIT;\n');

  await assert.rejects(
    runMigrations(pool, { migrationsDirectory: directory }),
    /checksum changed/
  );
});
