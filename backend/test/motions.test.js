import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MotionAccessError, MotionConflictError, MotionNotFoundError,
  MotionValidationError, createMotionService
} from '../src/domain/motions.js';

const delegate = '00000000-0000-4000-8000-000000000041';
const clerk = '00000000-0000-4000-8000-000000000042';
const stakeholder = '00000000-0000-4000-8000-000000000043';
const sittingId = '00000000-0000-4000-8000-000000000044';
const motionId = '00000000-0000-4000-8000-000000000045';
const context = actorUserId => ({ actorUserId, requestId: 'synthetic-motion-request' });
const submission = {
  sittingId,
  title: 'Improve access to safe school water',
  description: 'This motion asks the Assembly to review safe drinking water access in schools.'
};

function fakePool({
  role = 'delegate', status = 'active', consent = true,
  sittingStatus = 'in_progress', motionStatus = 'submitted',
  failAudit = false, motionExists = true, publicRows = []
} = {}) {
  const calls = [], events = [], audits = [];
  const state = {
    id: motionId, motion_number: '42', sitting_id: sittingId,
    title: submission.title, description: submission.description,
    proposed_by: delegate, status: motionStatus, committee: null,
    public_title: null, public_summary: null, submitted_at: '2027-02-15T06:00:00.000Z',
    reviewed_at: null, review_reason_code: null
  };
  let released = 0;
  const run = async (sql, params = []) => {
    calls.push({ sql, params });
    if (sql.includes('FROM users WHERE id = $1 FOR SHARE')) return { rows: [{ role, status }] };
    if (sql.includes('FROM guardian_consents WHERE child_user_id')) return { rows: consent ? [{ id: 'consent-fixture' }] : [] };
    if (sql.includes('FROM sittings WHERE id = $1 FOR SHARE')) return { rows: [{ status: sittingStatus }] };
    if (sql.includes('INSERT INTO motions')) return { rows: [{ ...state }] };
    if (sql.includes('FROM motions WHERE id = $1 FOR UPDATE')) return { rows: motionExists ? [{ id: motionId, sitting_id: sittingId, status: state.status }] : [] };
    if (sql.includes('UPDATE motions SET status =')) {
      Object.assign(state, {
        status: params[1], committee: params[2], public_title: params[3],
        public_summary: params[4], reviewed_by: params[5],
        reviewed_at: '2027-02-15T07:00:00.000Z', review_reason_code: params[6]
      });
      return { rows: [{ ...state }] };
    }
    if (sql.includes('FROM motions WHERE proposed_by = $1')) return { rows: [{ ...state }] };
    if (sql.includes("FROM motions WHERE status = 'submitted'")) return { rows: state.status === 'submitted' ? [{ ...state }] : [] };
    if (sql.includes('FROM motions WHERE id = $1')) return { rows: motionExists ? [{ ...state }] : [] };
    if (sql.includes('INSERT INTO motion_lifecycle_events')) { events.push(params); return { rows: [], rowCount: 1 }; }
    if (sql.includes('INSERT INTO audit_logs')) {
      if (failAudit) throw new Error('synthetic audit failure');
      audits.push(params); return { rows: [], rowCount: 1 };
    }
    return { rows: [], rowCount: 1 };
  };
  return {
    calls, events, audits, state, get released() { return released; },
    async connect() { return { query: run, release() { released += 1; } }; },
    async query(sql, params = []) {
      calls.push({ sql, params });
      if (sql.includes('FROM public_motion_summary')) return { rows: publicRows };
      return { rows: [], rowCount: 1 };
    }
  };
}

test('delegate submits a motion only to a published or in-progress sitting with consent', async () => {
  const pool = fakePool();
  const row = await createMotionService({ pool }).submitMotion(submission, context(delegate));
  assert.equal(row.status, 'submitted');
  assert.equal(row.motionNumber, 'MOT-000042');
  assert.equal(pool.events[0][2], 'submitted');
  assert.equal(pool.audits[0][1], 'motion.submitted');
  assert.equal(pool.released, 1);
});

test('submission rejects non-delegates, inactive accounts, missing consent and closed sittings', async () => {
  for (const options of [
    { role: 'clerk' }, { role: 'public_child' }, { role: 'delegate', status: 'suspended' },
    { role: 'delegate', consent: false }
  ]) {
    await assert.rejects(
      createMotionService({ pool: fakePool(options) }).submitMotion(submission, context(delegate)),
      MotionAccessError
    );
  }
  await assert.rejects(
    createMotionService({ pool: fakePool({ sittingStatus: 'draft' }) }).submitMotion(submission, context(delegate)),
    MotionConflictError
  );
  await assert.rejects(
    createMotionService({ pool: fakePool({ sittingStatus: 'concluded' }) }).submitMotion(submission, context(delegate)),
    MotionConflictError
  );
});

test('submission validates exact fields, identifiers and narrative lengths', async () => {
  const service = createMotionService({ pool: fakePool() });
  await assert.rejects(service.submitMotion({ ...submission, extra: true }, context(delegate)), MotionValidationError);
  await assert.rejects(service.submitMotion({ ...submission, sittingId: 'bad-id' }, context(delegate)), MotionValidationError);
  await assert.rejects(service.submitMotion({ ...submission, title: 'x' }, context(delegate)), MotionValidationError);
  await assert.rejects(service.submitMotion({ ...submission, description: 'short' }, context(delegate)), MotionValidationError);
});

test('a delegate can list only their own motion records', async () => {
  const pool = fakePool();
  const rows = await createMotionService({ pool }).listOwnMotions(context(delegate));
  assert.equal(rows.length, 1);
  assert.ok(pool.calls.some(call => call.sql.includes('WHERE proposed_by = $1') && call.params[0] === delegate));
  assert.ok(pool.audits.some(call => call[1] === 'motion.own_listed'));
  await assert.rejects(
    createMotionService({ pool: fakePool({ role: 'public_child' }) }).listOwnMotions(context(delegate)),
    MotionAccessError
  );
});

test('only active clerks and administrators can inspect the restricted review queue', async () => {
  const pool = fakePool({ role: 'clerk' });
  const rows = await createMotionService({ pool }).listClerkQueue(context(clerk));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].description, submission.description);
  assert.ok(pool.calls.some(call => call.sql.includes("WHERE status = 'submitted'")));
  await assert.rejects(
    createMotionService({ pool: fakePool({ role: 'stakeholder' }) }).listClerkQueue(context(stakeholder)),
    MotionAccessError
  );
  await assert.rejects(
    createMotionService({ pool: fakePool({ role: 'delegate' }) }).listClerkQueue(context(delegate)),
    MotionAccessError
  );
});

test('clerk detail access is audited and missing records are not disclosed', async () => {
  const pool = fakePool({ role: 'clerk' });
  const row = await createMotionService({ pool }).getClerkMotion(motionId, context(clerk));
  assert.equal(row.proposedByUserId, delegate);
  assert.ok(pool.audits.some(call => call[1] === 'motion.details_viewed'));
  await assert.rejects(
    createMotionService({ pool: fakePool({ role: 'clerk', motionExists: false }) }).getClerkMotion(motionId, context(clerk)),
    MotionNotFoundError
  );
});

test('clerk can schedule a motion for debate using separately reviewed public wording', async () => {
  const pool = fakePool({ role: 'clerk' });
  const row = await createMotionService({ pool }).reviewMotion(motionId, {
    decision: 'schedule_debate',
    publicTitle: 'Improve safe drinking water access',
    publicSummary: 'The Assembly will debate practical improvements to safe drinking water in schools.'
  }, context(clerk));
  assert.equal(row.status, 'under_debate');
  assert.equal(row.publicTitle, 'Improve safe drinking water access');
  assert.equal(pool.events[0][2], 'reviewed');
  assert.deepEqual(JSON.parse(pool.audits[0][5]), { decision: 'schedule_debate', status: 'under_debate' });
  assert.doesNotMatch(JSON.stringify(pool.audits), /safe drinking water in schools/u);
});

test('committee referral requires a committee and rejection requires a reason code', async () => {
  const service = createMotionService({ pool: fakePool({ role: 'clerk' }) });
  await assert.rejects(service.reviewMotion(motionId, {
    decision: 'refer_to_committee',
    publicTitle: 'Improve safe drinking water access',
    publicSummary: 'The Assembly will review practical improvements to safe drinking water.',
  }, context(clerk)), MotionValidationError);
  await assert.rejects(service.reviewMotion(motionId, { decision: 'reject' }, context(clerk)), MotionValidationError);
  const referred = await createMotionService({ pool: fakePool({ role: 'clerk' }) }).reviewMotion(motionId, {
    decision: 'refer_to_committee',
    publicTitle: 'Improve safe drinking water access',
    publicSummary: 'The Assembly will review practical improvements to safe drinking water.',
    committee: 'Health and Wellbeing'
  }, context(clerk));
  assert.equal(referred.status, 'committee_review');
  assert.equal(referred.committee, 'Health and Wellbeing');
  const rejected = await createMotionService({ pool: fakePool({ role: 'clerk' }) }).reviewMotion(motionId, {
    decision: 'reject', reasonCode: 'duplicate'
  }, context(clerk));
  assert.equal(rejected.status, 'rejected');
  assert.equal(rejected.publicTitle, null);
});

test('public wording rejects obvious contact details and unknown review fields', async () => {
  const service = createMotionService({ pool: fakePool({ role: 'clerk' }) });
  await assert.rejects(service.reviewMotion(motionId, {
    decision: 'schedule_debate',
    publicTitle: 'Contact 0712345678 for details',
    publicSummary: 'The Assembly will debate safe drinking water access in schools.'
  }, context(clerk)), MotionValidationError);
  await assert.rejects(service.reviewMotion(motionId, {
    decision: 'schedule_debate',
    publicTitle: 'Safe drinking water access',
    publicSummary: 'The Assembly will debate safe drinking water access in schools.',
    unknown: true
  }, context(clerk)), MotionValidationError);
});

test('only submitted motions can be reviewed once and the sitting must remain open', async () => {
  const pool = fakePool({ role: 'clerk', motionStatus: 'under_debate' });
  await assert.rejects(
    createMotionService({ pool }).reviewMotion(motionId, {
      decision: 'reject', reasonCode: 'out_of_scope'
    }, context(clerk)),
    MotionConflictError
  );
  await assert.rejects(
    createMotionService({ pool: fakePool({ role: 'clerk', sittingStatus: 'concluded' }) }).reviewMotion(motionId, {
      decision: 'schedule_debate',
      publicTitle: 'Safe drinking water access',
      publicSummary: 'The Assembly will debate safe drinking water access in schools.'
    }, context(clerk)),
    MotionConflictError
  );
  await assert.rejects(
    createMotionService({ pool: fakePool({ role: 'delegate' }) }).reviewMotion(motionId, {
      decision: 'reject', reasonCode: 'out_of_scope'
    }, context(delegate)),
    MotionAccessError
  );
});

test('public listing reads only the de-identified projection', async () => {
  const pool = fakePool({ publicRows: [{
    id: motionId, motion_number: '42', sitting_id: sittingId,
    title: 'Improve safe drinking water access',
    summary: 'The Assembly will debate practical improvements to safe drinking water in schools.',
    committee: null, status: 'under_debate',
    submitted_at: '2027-02-15T06:00:00.000Z', reviewed_at: '2027-02-15T07:00:00.000Z'
  }] });
  const rows = await createMotionService({ pool }).listPublicMotions();
  assert.equal(rows[0].motionNumber, 'MOT-000042');
  const query = pool.calls.find(call => call.sql.includes('public_motion_summary'));
  assert.ok(query);
  assert.doesNotMatch(query.sql, /description|proposed_by|guardian|email/iu);
  assert.ok(!Object.hasOwn(rows[0], 'description'));
  await assert.rejects(createMotionService({ pool }).listPublicMotions({ limit: '500' }), MotionValidationError);
});

test('audit failure rolls back motion submission', async () => {
  const pool = fakePool({ failAudit: true });
  await assert.rejects(
    createMotionService({ pool }).submitMotion(submission, context(delegate)),
    /synthetic audit failure/u
  );
  assert.ok(pool.calls.some(call => call.sql === 'ROLLBACK'));
});
