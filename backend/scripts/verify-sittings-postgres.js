import pg from 'pg';
import { createSittingService } from '../src/domain/sittings.js';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const fail = message => { throw new Error(message); };
const synthetic = label => Buffer.from('synthetic encrypted ' + label, 'utf8');

async function user(role, email) {
  const result = await pool.query(
    "INSERT INTO users (full_name, full_name_ciphertext, role, status, county, school, school_ciphertext, email_normalized, password_hash) " +
    "VALUES (NULL, $1, $2::account_role, 'active', 'Mombasa', NULL, NULL, $3, '$argon2id$synthetic-ci-only') RETURNING id",
    [synthetic(role), role, email]
  );
  return result.rows[0].id;
}

async function expectRejected(work, fragment, label) {
  let rejected = false;
  try { await work(); } catch (error) { rejected = String(error.message).includes(fragment); }
  if (!rejected) fail(label);
}

async function runAs(actorId, work) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT set_config('app.actor_user_id', $1, true)", [actorId]);
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch { /* preserve original */ }
    throw error;
  } finally { client.release(); }
}

try {
  const clerk = await user('clerk', 'sitting-clerk-ci@example.test');
  const speaker = await user('speaker', 'sitting-speaker-ci@example.test');
  const coordinator = await user('coordinator', 'sitting-coordinator-ci@example.test');
  const stakeholder = await user('stakeholder', 'sitting-stakeholder-ci@example.test');
  const service = createSittingService({ pool });
  const ctx = actorUserId => ({
    actorUserId,
    requestId: 'synthetic-sitting-ci',
    networkFingerprint: Buffer.alloc(32, 19)
  });

  const draft = await service.createSitting({
    title: 'Children’s Assembly plenary sitting',
    sessionNumber: 4,
    scheduledAt: '2027-02-15T09:00:00+03:00',
    venue: 'Mombasa County Assembly Hall'
  }, ctx(clerk));
  if (draft.status !== 'draft') fail('New sitting was not a draft');
  if ((await service.listPublicSittings()).some(row => row.id === draft.id)) {
    fail('Draft leaked to public projection');
  }
  if (!(await service.listAssemblySittings(ctx(clerk))).some(row => row.id === draft.id)) {
    fail('Clerk could not see draft');
  }
  if ((await service.listAssemblySittings(ctx(speaker))).some(row => row.id === draft.id)) {
    fail('Speaker could see draft');
  }

  await expectRejected(
    () => service.listAssemblySittings(ctx(stakeholder)),
    'authorised active Assembly account',
    'Stakeholder accessed restricted Assembly list'
  );
  await expectRejected(
    () => service.createSitting({
      title: 'Unauthorised sitting',
      scheduledAt: '2027-02-15T09:00:00+03:00'
    }, ctx(coordinator)),
    'authorised active Assembly account',
    'Coordinator created a sitting'
  );

  const updated = await service.updateSitting(draft.id, { title: 'Revised plenary sitting' }, ctx(clerk));
  if (updated.title !== 'Revised plenary sitting') fail('Draft update failed');

  const published = await service.transitionSitting(draft.id, { status: 'published' }, ctx(clerk));
  if (published.status !== 'published' || !published.publishedAt) fail('Publish transition failed');
  if (!(await service.listPublicSittings()).some(row => row.id === draft.id)) {
    fail('Published sitting missing from public view');
  }
  if (!(await service.listAssemblySittings(ctx(speaker))).some(row => row.id === draft.id)) {
    fail('Speaker could not see published sitting');
  }

  await expectRejected(
    () => service.updateSitting(draft.id, { title: 'Post-publication edit' }, ctx(clerk)),
    'not available for this action',
    'Published sitting was editable'
  );

  await service.transitionSitting(draft.id, { status: 'in_progress' }, ctx(clerk));
  const concluded = await service.transitionSitting(draft.id, { status: 'concluded' }, ctx(clerk));
  if (concluded.status !== 'concluded' || !concluded.concludedAt) fail('Conclude transition failed');
  await expectRejected(
    () => service.transitionSitting(draft.id, { status: 'cancelled' }, ctx(clerk)),
    'not available for this action',
    'Terminal sitting status changed'
  );

  const eventRows = await pool.query(
    'SELECT event_type FROM sitting_lifecycle_events WHERE sitting_id = $1',
    [draft.id]
  );
  const eventTypes = new Set(eventRows.rows.map(row => row.event_type));
  for (const value of ['created','updated','published','started','concluded']) {
    if (!eventTypes.has(value)) fail('Missing lifecycle event ' + value);
  }

  const auditRows = await pool.query(
    "SELECT action FROM audit_logs WHERE entity_type = 'sitting' AND entity_id = $1",
    [draft.id]
  );
  const auditActions = new Set(auditRows.rows.map(row => row.action));
  for (const value of ['sitting.created','sitting.updated','sitting.status_changed']) {
    if (!auditActions.has(value)) fail('Missing audit action ' + value);
  }

  await expectRejected(
    () => pool.query(
      "UPDATE sitting_lifecycle_events SET metadata = '{}'::jsonb WHERE sitting_id = $1",
      [draft.id]
    ),
    'append-only',
    'Lifecycle event history was mutable'
  );

  const columns = await pool.query(
    "SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'public_sitting_summary'"
  );
  const exposed = new Set(columns.rows.map(row => row.column_name));
  for (const column of ['created_by','order_paper_storage_key']) {
    if (exposed.has(column)) fail('Public projection exposes ' + column);
  }

  const cancelled = await service.createSitting({
    title: 'Synthetic committee sitting',
    scheduledAt: '2027-02-16T09:00:00+03:00'
  }, ctx(clerk));
  await service.transitionSitting(cancelled.id, { status: 'cancelled' }, ctx(clerk));
  if ((await service.listPublicSittings()).some(row => row.id === cancelled.id)) {
    fail('Cancelled draft became public');
  }

  await expectRejected(
    () => runAs(clerk, client => client.query(
      "UPDATE sittings SET status = 'concluded', updated_at = now() WHERE id = $1",
      [cancelled.id]
    )),
    'unsupported sitting lifecycle transition',
    'Database accepted an invalid direct transition'
  );

  await expectRejected(
    () => runAs(clerk, client => client.query(
      "INSERT INTO sittings (title, scheduled_at, status, created_by) VALUES ('Missing audit test sitting', '2027-02-17T06:00:00Z', 'draft', $1)",
      [clerk]
    )),
    'matching append-only lifecycle event',
    'Database accepted a sitting without lifecycle and audit records'
  );

  process.stdout.write('Official sitting lifecycle, access scope, public projection and audit integrity passed\n');
} finally {
  await pool.end();
}
