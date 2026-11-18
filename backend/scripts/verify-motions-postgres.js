import pg from 'pg';
import { createSittingService } from '../src/domain/sittings.js';
import { createMotionService } from '../src/domain/motions.js';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const fail = message => { throw new Error(message); };
const encrypted = label => Buffer.from('synthetic encrypted ' + label, 'utf8');

async function adult(role, email) {
  const result = await pool.query(
    "INSERT INTO users (full_name, full_name_ciphertext, role, status, county, school, school_ciphertext, email_normalized, password_hash) " +
    "VALUES (NULL, $1, $2::account_role, 'active', 'Mombasa', NULL, NULL, $3, '$argon2id$synthetic-ci-only') RETURNING id",
    [encrypted(role), role, email]
  );
  return result.rows[0].id;
}

async function approvedDelegate(coordinatorId) {
  const phoneHash = Buffer.alloc(32, 51);
  const result = await pool.query(
    "INSERT INTO users (full_name, full_name_ciphertext, role, status, age, school, school_ciphertext, county, ward, guardian_phone_lookup_hash, guardian_phone_ciphertext, passphrase_hash) " +
    "VALUES (NULL, $1, 'delegate', 'active', 16, NULL, $2, 'Mombasa', 'Nyali', $3, $4, '$argon2id$synthetic-delegate') RETURNING id",
    [encrypted('delegate'), encrypted('school'), phoneHash, encrypted('guardian phone')]
  );
  const delegateId = result.rows[0].id;
  const consent = await pool.query(
    "INSERT INTO guardian_consents (child_user_id, guardian_name, guardian_name_ciphertext, guardian_phone_lookup_hash, guardian_phone_ciphertext, consent_text_version, status) " +
    "VALUES ($1, NULL, $2, $3, $4, 'ci-test-v1', 'pending') RETURNING id",
    [delegateId, encrypted('guardian name'), phoneHash, encrypted('guardian phone')]
  );
  const review = await pool.query(
    "INSERT INTO guardian_consent_reviews (consent_id, reviewed_by, decision, verification_method, evidence_reference) " +
    "VALUES ($1, $2, 'approved', 'in_person', 'ci-motion-review-0001') RETURNING id",
    [consent.rows[0].id, coordinatorId]
  );
  await pool.query(
    "UPDATE guardian_consents SET status = 'approved', reviewed_by = $2, reviewed_at = now(), granted_at = now(), latest_review_id = $3 WHERE id = $1",
    [consent.rows[0].id, coordinatorId, review.rows[0].id]
  );
  return delegateId;
}

const context = actorUserId => ({
  actorUserId, requestId: 'synthetic-motion-postgres-ci',
  networkFingerprint: Buffer.alloc(32, 61)
});

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
  const clerk = await adult('clerk', 'motion-clerk-ci@example.test');
  const coordinator = await adult('coordinator', 'motion-coordinator-ci@example.test');
  const stakeholder = await adult('stakeholder', 'motion-stakeholder-ci@example.test');
  const delegate = await approvedDelegate(coordinator);

  const sittings = createSittingService({ pool });
  const sitting = await sittings.createSitting({
    title: 'Synthetic plenary sitting for motion workflow',
    sessionNumber: 9,
    scheduledAt: '2027-02-15T09:00:00+03:00',
    venue: 'Synthetic Assembly Hall'
  }, context(clerk));
  await sittings.transitionSitting(sitting.id, { status: 'published' }, context(clerk));

  const motions = createMotionService({ pool });
  const submitted = await motions.submitMotion({
    sittingId: sitting.id,
    title: 'Improve access to safe school water',
    description: 'This private proposal asks the Assembly to review safe drinking water access in schools.'
  }, context(delegate));
  if (submitted.status !== 'submitted' || !submitted.motionNumber.startsWith('MOT-')) {
    fail('Delegate motion submission or numbering failed');
  }
  if ((await motions.listPublicMotions()).some(row => row.id === submitted.id)) {
    fail('Unreviewed motion appeared in public projection');
  }
  const own = await motions.listOwnMotions(context(delegate));
  if (!own.some(row => row.id === submitted.id && row.description.includes('private proposal'))) {
    fail('Delegate could not retrieve their own submission');
  }
  const queue = await motions.listClerkQueue(context(clerk));
  if (!queue.some(row => row.id === submitted.id && row.description.includes('private proposal'))) {
    fail('Clerk review queue did not return restricted motion text');
  }

  await expectRejected(
    () => motions.listClerkQueue(context(stakeholder)),
    'authorised active delegate or clerk',
    'Stakeholder accessed the restricted motion queue'
  );
  await expectRejected(
    () => motions.reviewMotion(submitted.id, { decision: 'reject', reasonCode: 'duplicate' }, context(delegate)),
    'authorised active delegate or clerk',
    'Delegate reviewed their own motion'
  );

  const reviewed = await motions.reviewMotion(submitted.id, {
    decision: 'schedule_debate',
    publicTitle: 'Improve safe drinking water access',
    publicSummary: 'The Assembly will debate practical improvements to safe drinking water in schools.'
  }, context(clerk));
  if (reviewed.status !== 'under_debate') fail('Clerk review did not schedule debate');
  const publicRows = await motions.listPublicMotions();
  const publicMotion = publicRows.find(row => row.id === submitted.id);
  if (!publicMotion || publicMotion.title !== 'Improve safe drinking water access') {
    fail('Reviewed motion missing from public projection');
  }
  if (Object.keys(publicMotion).some(key => ['description', 'proposedByUserId', 'reviewReasonCode'].includes(key))) {
    fail('Public motion projection exposes restricted fields');
  }

  const second = await motions.submitMotion({
    sittingId: sitting.id,
    title: 'Improve safe routes to school',
    description: 'This private proposal asks the Assembly to review safe routes to schools.'
  }, context(delegate));
  const rejected = await motions.reviewMotion(second.id, {
    decision: 'reject', reasonCode: 'duplicate'
  }, context(clerk));
  if (rejected.status !== 'rejected' || (await motions.listPublicMotions()).some(row => row.id === second.id)) {
    fail('Rejected motion was exposed publicly');
  }

  await expectRejected(
    () => runAs(clerk, client => client.query(
      "UPDATE motions SET title = 'Tampered title' WHERE id = $1", [submitted.id]
    )),
    'submitted motion identity and original text are immutable',
    'Database allowed original motion text to be changed'
  );
  await expectRejected(
    () => pool.query(
      "UPDATE motion_lifecycle_events SET metadata = '{}'::jsonb WHERE motion_id = $1", [submitted.id]
    ),
    'append-only',
    'Motion lifecycle history was mutable'
  );
  await expectRejected(
    () => runAs(clerk, client => client.query(
      "UPDATE motions SET status = 'rejected', reviewed_by = $2, reviewed_at = now(), review_reason_code = 'duplicate' WHERE id = $1",
      [second.id, clerk]
    )),
    'motion is not eligible for this review transition',
    'Database allowed a second review transition'
  );

  const auditRows = await pool.query(
    "SELECT action FROM audit_logs WHERE entity_type = 'motion' AND entity_id = $1", [submitted.id]
  );
  const actions = new Set(auditRows.rows.map(row => row.action));
  for (const action of ['motion.submitted', 'motion.reviewed']) {
    if (!actions.has(action)) fail('Missing audit action ' + action);
  }

  const columns = await pool.query(
    "SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'public_motion_summary'"
  );
  const publicColumns = new Set(columns.rows.map(row => row.column_name));
  for (const forbidden of ['description', 'proposed_by', 'review_reason_code']) {
    if (publicColumns.has(forbidden)) fail('Public view exposes ' + forbidden);
  }

  process.stdout.write('Delegate motion submission, clerk review, public projection and lifecycle audit integrity passed\n');
} finally {
  await pool.end();
}
