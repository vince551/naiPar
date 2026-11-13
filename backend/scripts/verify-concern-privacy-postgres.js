import assert from 'node:assert/strict';
import pg from 'pg';

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error('DATABASE_URL is required');

const pool = new pg.Pool({ connectionString });
const client = await pool.connect();

async function expectCheckViolation(sql, params) {
  await client.query('SAVEPOINT expected_constraint_failure');
  let failed = false;
  try {
    await client.query(sql, params);
  } catch (error) {
    failed = error?.code === '23514';
  }
  await client.query('ROLLBACK TO SAVEPOINT expected_constraint_failure');
  await client.query('RELEASE SAVEPOINT expected_constraint_failure');
  assert.equal(failed, true, 'Expected a database CHECK constraint violation');
}

try {
  await client.query('BEGIN');

  const privateTheme = Buffer.from('synthetic encrypted theme');
  const privateTitle = Buffer.from('synthetic encrypted title');
  const privateDescription = Buffer.from('synthetic encrypted child narrative');

  const inserted = await client.query(
    `INSERT INTO concerns (
       theme_ciphertext, title_ciphertext, description_ciphertext, is_public
     ) VALUES ($1, $2, $3, false)
     RETURNING id`,
    [privateTheme, privateTitle, privateDescription]
  );
  const concernId = inserted.rows[0].id;

  const stored = await client.query(
    `SELECT theme, title, description,
            theme_ciphertext, title_ciphertext, description_ciphertext,
            is_public
     FROM concerns WHERE id = $1`,
    [concernId]
  );
  assert.equal(stored.rowCount, 1);
  assert.equal(stored.rows[0].theme, null);
  assert.equal(stored.rows[0].title, null);
  assert.equal(stored.rows[0].description, null);
  assert.deepEqual(stored.rows[0].theme_ciphertext, privateTheme);
  assert.deepEqual(stored.rows[0].title_ciphertext, privateTitle);
  assert.deepEqual(stored.rows[0].description_ciphertext, privateDescription);
  assert.equal(stored.rows[0].is_public, false);

  const initiallyPublic = await client.query(
    'SELECT id FROM public_concern_summary WHERE id = $1',
    [concernId]
  );
  assert.equal(initiallyPublic.rowCount, 0);

  await expectCheckViolation(
    `INSERT INTO concerns (theme, title, description, is_public)
     VALUES ('Education', 'Synthetic plaintext title', 'Synthetic plaintext narrative.', false)`,
    []
  );

  const publicColumns = await client.query(
    `SELECT column_name
     FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'public_concern_summary'`
  );
  const exposedColumns = new Set(publicColumns.rows.map(row => row.column_name));
  for (const forbidden of [
    'submitted_by', 'county', 'sub_county', 'ward',
    'description', 'guardian_phone', 'internal_note'
  ]) {
    assert.equal(exposedColumns.has(forbidden), false, `Public view exposes ${forbidden}`);
  }

  await client.query('ROLLBACK');
  process.stdout.write('Encrypted concern storage and minimal public projection passed\\n');
} catch (error) {
  try {
    await client.query('ROLLBACK');
  } catch {
    // Preserve the original integration failure.
  }
  throw error;
} finally {
  client.release();
  await pool.end();
}
