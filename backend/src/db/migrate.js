import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const MIGRATIONS_DIRECTORY = fileURLToPath(
  new URL('../../database/migrations/', import.meta.url)
);
const MIGRATION_LOCK_ID = 918202611;

function migrationBody(sql, filename) {
  const withoutBegin = sql.replace(/^\s*BEGIN\s*;\s*/i, '');
  const withoutCommit = withoutBegin.replace(/\s*COMMIT\s*;\s*$/i, '');
  if (withoutBegin === sql || withoutCommit === withoutBegin) {
    throw new Error(`Migration ${filename} must have one outer BEGIN/COMMIT pair`);
  }
  return withoutCommit;
}

export async function runMigrations(pool) {
  const client = await pool.connect();
  const applied = [];

  try {
    await client.query('SELECT pg_advisory_lock($1::bigint)', [MIGRATION_LOCK_ID]);
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version TEXT PRIMARY KEY,
        checksum TEXT NOT NULL,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);

    const filenames = (await readdir(MIGRATIONS_DIRECTORY))
      .filter(name => /^\d{4}_[a-z0-9_]+\.sql$/.test(name))
      .sort();

    for (const filename of filenames) {
      const sql = await readFile(new URL(filename, `file://${MIGRATIONS_DIRECTORY}/`), 'utf8');
      const checksum = createHash('sha256').update(sql).digest('hex');
      const existing = await client.query(
        'SELECT checksum FROM schema_migrations WHERE version = $1',
        [filename]
      );

      if (existing.rowCount) {
        if (existing.rows[0].checksum !== checksum) {
          throw new Error(`Applied migration checksum changed: ${filename}`);
        }
        continue;
      }

      await client.query('BEGIN');
      try {
        await client.query(migrationBody(sql, filename));
        await client.query(
          'INSERT INTO schema_migrations (version, checksum) VALUES ($1, $2)',
          [filename, checksum]
        );
        await client.query('COMMIT');
        applied.push(filename);
      } catch (error) {
        await client.query('ROLLBACK');
        throw new Error(`Migration failed: ${filename}`, { cause: error });
      }
    }

    return applied;
  } finally {
    try {
      await client.query('SELECT pg_advisory_unlock($1::bigint)', [MIGRATION_LOCK_ID]);
    } finally {
      client.release();
    }
  }
}
