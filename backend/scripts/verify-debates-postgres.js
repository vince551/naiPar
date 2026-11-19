import pg from 'pg';
import { createSittingService } from '../src/domain/sittings.js';
import { createMotionService } from '../src/domain/motions.js';
import { createDebateService } from '../src/domain/debates.js';

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

async function approvedDelegate(coordinatorId, suffix, phoneByte) {
  const phoneHash = Buffer.alloc(32, phoneByte);
  const result = await pool.query(
    "INSERT INTO users (full_name, full_name_ciphertext, role, status, age, school, school_ciphertext, county, ward, guardian_phone_lookup_hash, guardian_phone_ciphertext, passphrase_hash) " +
    "VALUES (NULL, $1, 'delegate', 'active', 16, NULL, $2, 'Mombasa', 'Nyali', $3, $4, '$argon2id$synthetic-delegate') RETURNING id",
    [encrypted('delegate ' + suffix), encrypted('school ' + suffix), phoneHash, encrypted('guardian phone ' + suffix)]
  );
  const delegateId = result.rows[0].id;
  const consent = await pool.query(
    "INSERT INTO guardian_consents (child_user_id, guardian_name, guardian_name_ciphertext, guardian_phone_lookup_hash, guardian_phone_ciphertext, consent_text_version, status) " +
    "VALUES ($1, NULL, $2, $3, $4, 'ci-test-v1', 'pending') RETURNING id",
    [delegateId, encrypted('guardian ' + suffix), phoneHash, encrypted('guardian phone ' + suffix)]
  );
  const review = await pool.query(
    "INSERT INTO guardian_consent_reviews (consent_id, reviewed_by, decision, verification_method, evidence_reference) " +
    "VALUES ($1, $2, 'approved', 'in_person', $3) RETURNING id",
    [consent.rows[0].id, coordinatorId, 'ci-debate-consent-' + suffix]
  );
  await pool.query(
    "UPDATE guardian_consents SET status = 'approved', reviewed_by = $2, reviewed_at = now(), granted_at = now(), latest_review_id = $3 WHERE id = $1",
    [consent.rows[0].id, coordinatorId, review.rows[0].id]
  );
  return delegateId;
}

const context = actorUserId => ({
  actorUserId,
  requestId: 'synthetic-debate-postgres-ci',
  networkFingerprint: Buffer.alloc(32, 71)
});

async function expectRejected(work, fragment, label) {
  let rejected = false;
  try { await work(); } catch (error) { rejected = String(error.message).includes(fragment); }
  if (!rejected) fail(label);
}

try {
  const clerk = await adult('clerk', 'debate-clerk-ci@example.test');
  const coordinator = await adult('coordinator', 'debate-coordinator-ci@example.test');
  const stakeholder = await adult('stakeholder', 'debate-stakeholder-ci@example.test');
  const firstDelegate = await approvedDelegate(coordinator, 'one', 71);
  const secondDelegate = await approvedDelegate(coordinator, 'two', 72);

  const sittings = createSittingService({ pool });
  const sitting = await sittings.createSitting({
    title: 'Synthetic plenary sitting for debate workflow',
    sessionNumber: 15,
    scheduledAt: '2027-03-15T09:00:00+03:00',
    venue: 'Synthetic Assembly Hall'
  }, context(clerk));
  await sittings.transitionSitting(sitting.id, { status: 'published' }, context(clerk));

  const motions = createMotionService({ pool });
  const motion = await motions.submitMotion({
    sittingId: sitting.id,
    title: 'Improve access to safe school water',
    description: 'This private proposal asks the Assembly to review safe drinking water access in schools.'
  }, context(firstDelegate));
  await motions.reviewMotion(motion.id, {
    decision: 'schedule_debate',
    publicTitle: 'Improve safe drinking water access',
    publicSummary: 'The Assembly will debate practical improvements to safe drinking water in schools.'
  }, context(clerk));

  const debates = createDebateService({ pool });
  const first = await debates.requestSpeakerSlot(motion.id, {}, context(firstDelegate));
  const second = await debates.requestSpeakerSlot(motion.id, {}, context(secondDelegate));
  if (first.status !== 'pending' || second.status !== 'pending') {
    fail('Delegate speaker requests were not recorded as pending');
  }

  await expectRejected(
    () => debates.requestSpeakerSlot(motion.id, {}, context(firstDelegate)),
    'not available',
    'Delegate submitted a duplicate speaker request'
  );

  const own = await debates.listOwnRequests(context(firstDelegate));
  if (own.length !== 1 || own[0].id !== first.id) fail('Delegate could not retrieve only their own speaker request');

  const clerkQueue = await debates.listClerkQueue(motion.id, context(clerk));
  if (clerkQueue.length !== 2 || !clerkQueue.some(row => row.speakerUserId === firstDelegate)) {
    fail('Clerk queue did not return the restricted speaker requests');
  }

  await expectRejected(
    () => debates.listClerkQueue(motion.id, context(stakeholder)),
    'active delegate or authorised clerk',
    'Stakeholder accessed the restricted debate queue'
  );
  await expectRejected(
    () => debates.listOwnRequests(context(stakeholder)),
    'active delegate or authorised clerk',
    'Stakeholder accessed a delegate speaker request list'
  );

  const firstApproved = await debates.reviewRequest(first.id, {
    decision: 'approve', allocatedSeconds: 120
  }, context(clerk));
  const secondApproved = await debates.reviewRequest(second.id, {
    decision: 'approve', allocatedSeconds: 90
  }, context(clerk));
  if (firstApproved.queuePosition !== 1 || secondApproved.queuePosition !== 2) {
    fail('Clerk approval did not allocate a sequential queue');
  }

  await expectRejected(
    () => debates.startSpeaker(second.id, {}, context(clerk)),
    'not available',
    'Clerk started a later speaker before the earlier queue entry'
  );

  await debates.startSpeaker(first.id, {}, context(clerk));
  await expectRejected(
    () => debates.startSpeaker(second.id, {}, context(clerk)),
    'not available',
    'Two speakers were allowed on the floor at once'
  );

  const firstFinished = await debates.finishSpeaker(first.id, {}, context(clerk));
  if (firstFinished.status !== 'completed' || !firstFinished.speakingEndedAt) {
    fail('First speaker finish was not recorded');
  }
  await debates.startSpeaker(second.id, {}, context(clerk));
  const secondFinished = await debates.finishSpeaker(second.id, {}, context(clerk));
  if (secondFinished.status !== 'completed') fail('Second speaker did not complete after the first');

  const persisted = await pool.query(
    'SELECT id, status::text AS status, queue_position, allocated_seconds, speaking_started_at, speaking_ended_at ' +
    'FROM debate_requests WHERE motion_id = $1 ORDER BY queue_position',
    [motion.id]
  );
  if (persisted.rows.length !== 2 || persisted.rows.some(row => row.status !== 'completed' || !row.speaking_started_at || !row.speaking_ended_at)) {
    fail('Debate request lifecycle timestamps or final states were not persisted');
  }

  const eventRows = await pool.query(
    "SELECT event_type FROM debate_request_events WHERE debate_request_id = ANY($1::uuid[]) ORDER BY created_at, id",
    [[first.id, second.id]]
  );
  const eventTypes = eventRows.rows.map(row => row.event_type);
  for (const expected of ['requested', 'approved', 'speaker_started', 'speaker_finished']) {
    if (!eventTypes.includes(expected)) fail('Missing append-only debate event: ' + expected);
  }

  const auditRows = await pool.query(
    "SELECT action FROM audit_logs WHERE entity_type = 'debate_request' AND entity_id = ANY($1::uuid[])",
    [[first.id, second.id]]
  );
  const auditActions = auditRows.rows.map(row => row.action);
  for (const expected of [
    'debate_request.requested', 'debate_request.approved',
    'debate_request.speaker_started', 'debate_request.speaker_finished'
  ]) {
    if (!auditActions.includes(expected)) fail('Missing debate audit action: ' + expected);
  }

  await expectRejected(
    () => pool.query(
      "INSERT INTO debate_requests (motion_id, speaker_id, status) VALUES ($1, $2, 'pending')",
      [motion.id, firstDelegate]
    ),
    'authenticated debate actor context is required',
    'Direct database insert bypassed the authenticated actor requirement'
  );

  await expectRejected(
    () => pool.query(
      "UPDATE debate_request_events SET metadata = '{\"tampered\":true}'::jsonb WHERE debate_request_id = $1",
      [first.id]
    ),
    'append-only',
    'Debate lifecycle history was mutable'
  );

  const publicProjection = await pool.query(
    "SELECT to_regclass('public.public_debate_queue') AS public_debate_queue, " +
    "to_regclass('public.debate_one_active_speaker_per_motion') AS active_speaker_index"
  );
  if (publicProjection.rows[0].public_debate_queue || !publicProjection.rows[0].active_speaker_index) {
    fail('Debate queue public isolation or active-speaker index is incorrect');
  }

  const closedSitting = await sittings.createSitting({
    title: 'Synthetic closed sitting for debate access test',
    sessionNumber: 16,
    scheduledAt: '2027-03-16T09:00:00+03:00',
    venue: 'Synthetic Assembly Hall'
  }, context(clerk));
  await sittings.transitionSitting(closedSitting.id, { status: 'published' }, context(clerk));
  const closedMotion = await motions.submitMotion({
    sittingId: closedSitting.id,
    title: 'Improve accessible school transport',
    description: 'This private proposal asks the Assembly to review accessible transport for learners.'
  }, context(secondDelegate));
  await motions.reviewMotion(closedMotion.id, {
    decision: 'schedule_debate',
    publicTitle: 'Improve accessible school transport',
    publicSummary: 'The Assembly will debate accessible transport improvements for learners.'
  }, context(clerk));
  await sittings.transitionSitting(closedSitting.id, { status: 'in_progress' }, context(clerk));
  await sittings.transitionSitting(closedSitting.id, { status: 'concluded' }, context(clerk));
  await expectRejected(
    () => debates.requestSpeakerSlot(closedMotion.id, {}, context(secondDelegate)),
    'not available',
    'Delegate requested a speaking slot after the sitting concluded'
  );

  process.stdout.write('Debate speaker queue and floor lifecycle integrity passed\n');
} finally {
  await pool.end();
}
