import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DebateAccessError, DebateConflictError, DebateNotFoundError,
  DebateValidationError, createDebateService
} from '../src/domain/debates.js';

const delegate = '00000000-0000-4000-8000-000000000041';
const secondDelegate = '00000000-0000-4000-8000-000000000042';
const clerk = '00000000-0000-4000-8000-000000000043';
const stakeholder = '00000000-0000-4000-8000-000000000044';
const motionId = '00000000-0000-4000-8000-000000000045';
const requestOne = '00000000-0000-4000-8000-000000000046';
const requestTwo = '00000000-0000-4000-8000-000000000047';
const context = actorUserId => ({ actorUserId, requestId: 'synthetic-debate-request' });

function fakePool({
  motionStatus = 'under_debate',
  sittingStatus = 'in_progress',
  consent = true,
  failAudit = false,
  requestRows = []
} = {}) {
  const calls = [], events = [], audits = [], requests = [...requestRows];
  const roles = new Map([
    [delegate, 'delegate'], [secondDelegate, 'delegate'],
    [clerk, 'clerk'], [stakeholder, 'stakeholder']
  ]);
  const statuses = new Map([...roles.keys()].map(id => [id, 'active']));
  let nextId = 0;
  let released = 0;

  const run = async (sql, params = []) => {
    calls.push({ sql, params });
    if (sql.includes('SELECT set_config')) return { rows: [{ set_config: params[0] }] };
    if (sql.includes('SELECT role::text AS role, status::text AS status FROM users')) {
      const id = params[0];
      return { rows: roles.has(id) ? [{ role: roles.get(id), status: statuses.get(id) }] : [] };
    }
    if (sql.includes('FROM guardian_consents WHERE child_user_id')) {
      return { rows: consent ? [{ id: 'synthetic-consent' }] : [] };
    }
    if (sql.includes('FROM motions AS motion JOIN sittings AS sitting') && sql.includes('FOR UPDATE OF motion, sitting')) {
      return { rows: [{ id: motionId, status: motionStatus, sitting_status: sittingStatus }] };
    }
    if (sql.includes('SELECT id FROM motions WHERE id = $1')) {
      return { rows: [{ id: motionId }] };
    }
    if (sql.includes('SELECT id FROM debate_requests WHERE motion_id = $1 AND speaker_id = $2')) {
      return {
        rows: requests.some(row => row.motion_id === params[0] && row.speaker_id === params[1]
          && ['pending', 'approved', 'completed'].includes(row.status))
          ? [{ id: 'existing-request' }] : []
      };
    }
    if (sql.includes('INSERT INTO debate_requests')) {
      nextId += 1;
      const row = {
        id: nextId === 1 ? requestOne : requestTwo,
        motion_id: params[0], speaker_id: params[1], status: 'pending',
        requested_at: '2027-02-15T06:00:00.000Z', reviewed_by: null, reviewed_at: null,
        speaking_started_at: null, speaking_ended_at: null,
        allocated_seconds: 120, queue_position: null, review_reason_code: null
      };
      requests.push(row);
      return { rows: [{ ...row }] };
    }
    if (sql.includes('SELECT motion_id FROM debate_requests WHERE id = $1')) {
      const row = requests.find(item => item.id === params[0]);
      return { rows: row ? [{ motion_id: row.motion_id }] : [] };
    }
    if (sql.includes('FROM debate_requests WHERE id = $1 FOR UPDATE')) {
      const row = requests.find(item => item.id === params[0]);
      return { rows: row ? [{ ...row }] : [] };
    }
    if (sql.includes('SELECT COALESCE(MAX(queue_position)')) {
      const positions = requests.filter(row => row.motion_id === params[0] && row.queue_position !== null)
        .map(row => row.queue_position);
      return { rows: [{ next_position: Math.max(0, ...positions) + 1 }] };
    }
    if (sql.includes("FROM debate_requests WHERE motion_id = $1 AND id <> $2 AND status = 'approved' AND speaking_started_at IS NOT NULL")) {
      return { rows: requests.some(row => row.motion_id === params[0] && row.id !== params[1]
        && row.status === 'approved' && row.speaking_started_at && !row.speaking_ended_at)
        ? [{ id: 'active-speaker' }] : [] };
    }
    if (sql.includes("FROM debate_requests WHERE motion_id = $1 AND id <> $2 AND status = 'approved' AND speaking_started_at IS NULL")) {
      return { rows: requests.some(row => row.motion_id === params[0] && row.id !== params[1]
        && row.status === 'approved' && !row.speaking_started_at && row.queue_position < params[2])
        ? [{ id: 'earlier-speaker' }] : [] };
    }
    if (sql.includes('UPDATE debate_requests SET status = $2')) {
      const row = requests.find(item => item.id === params[0]);
      if (!row) return { rows: [] };
      Object.assign(row, {
        status: params[1], reviewed_by: params[2],
        reviewed_at: '2027-02-15T07:00:00.000Z',
        allocated_seconds: params[3], queue_position: params[4],
        review_reason_code: params[5]
      });
      return { rows: [{ ...row }] };
    }
    if (sql.includes('UPDATE debate_requests SET speaking_started_at')) {
      const row = requests.find(item => item.id === params[0]);
      if (!row) return { rows: [] };
      row.speaking_started_at = '2027-02-15T07:05:00.000Z';
      return { rows: [{ ...row }] };
    }
    if (sql.includes("UPDATE debate_requests SET status = 'completed'")) {
      const row = requests.find(item => item.id === params[0]);
      if (!row) return { rows: [] };
      row.status = 'completed';
      row.speaking_ended_at = '2027-02-15T07:07:00.000Z';
      return { rows: [{ ...row }] };
    }
    if (sql.includes('WHERE request.speaker_id = $1')) {
      return { rows: requests.filter(row => row.speaker_id === params[0]).map(row => ({
        ...row, motion_number: 42, motion_title: 'Improve safe drinking water access'
      })) };
    }
    if (sql.includes('FROM debate_requests AS request')) {
      return { rows: requests.filter(row => row.motion_id === params[0]).map(row => ({
        ...row, motion_number: 42, motion_title: 'Improve safe drinking water access'
      })) };
    }
    if (sql.includes('INSERT INTO debate_request_events')) {
      events.push(params);
      return { rows: [], rowCount: 1 };
    }
    if (sql.includes('INSERT INTO audit_logs')) {
      if (failAudit) throw new Error('synthetic audit failure');
      audits.push(params);
      return { rows: [], rowCount: 1 };
    }
    return { rows: [], rowCount: 1 };
  };

  return {
    calls, events, audits, requests, roles, statuses,
    get released() { return released; },
    async connect() {
      return { query: run, release() { released += 1; } };
    }
  };
}

test('active delegate with approved consent can request a slot on a motion under debate', async () => {
  const pool = fakePool();
  const row = await createDebateService({ pool }).requestSpeakerSlot(motionId, {}, context(delegate));
  assert.equal(row.status, 'pending');
  assert.equal(row.motionId, motionId);
  assert.equal(row.queuePosition, null);
  assert.equal(pool.events[0][2], 'requested');
  assert.equal(pool.audits[0][1], 'debate_request.requested');
  assert.equal(pool.released, 1);
});

test('speaker requests reject public children, adults, inactive accounts, missing consent and closed motions', async () => {
  const noConsent = fakePool({ consent: false });
  await assert.rejects(
    createDebateService({ pool: noConsent }).requestSpeakerSlot(motionId, {}, context(delegate)),
    DebateAccessError
  );

  const publicChildPool = fakePool();
  publicChildPool.roles.set(delegate, 'public_child');
  await assert.rejects(
    createDebateService({ pool: publicChildPool }).requestSpeakerSlot(motionId, {}, context(delegate)),
    DebateAccessError
  );

  const inactivePool = fakePool();
  inactivePool.statuses.set(delegate, 'suspended');
  await assert.rejects(
    createDebateService({ pool: inactivePool }).requestSpeakerSlot(motionId, {}, context(delegate)),
    DebateAccessError
  );

  await assert.rejects(
    createDebateService({ pool: fakePool({ motionStatus: 'submitted' }) })
      .requestSpeakerSlot(motionId, {}, context(delegate)),
    DebateConflictError
  );
  await assert.rejects(
    createDebateService({ pool: fakePool({ sittingStatus: 'concluded' }) })
      .requestSpeakerSlot(motionId, {}, context(delegate)),
    DebateConflictError
  );
});

test('speaker request validates motion identifiers and rejects unexpected request fields', async () => {
  const service = createDebateService({ pool: fakePool() });
  await assert.rejects(service.requestSpeakerSlot('not-a-uuid', {}, context(delegate)), DebateValidationError);
  await assert.rejects(service.requestSpeakerSlot(motionId, { note: 'private details' }, context(delegate)), DebateValidationError);
  await assert.rejects(service.requestSpeakerSlot(motionId, [], context(delegate)), DebateValidationError);
});

test('a delegate cannot submit a second pending, approved or completed request for the same motion', async () => {
  const pool = fakePool();
  const service = createDebateService({ pool });
  await service.requestSpeakerSlot(motionId, {}, context(delegate));
  await assert.rejects(service.requestSpeakerSlot(motionId, {}, context(delegate)), DebateConflictError);
});

test('delegates can list only their own speaker requests', async () => {
  const pool = fakePool({ requestRows: [
    { id: requestOne, motion_id: motionId, speaker_id: delegate, status: 'pending', queue_position: null, allocated_seconds: 120 },
    { id: requestTwo, motion_id: motionId, speaker_id: secondDelegate, status: 'pending', queue_position: null, allocated_seconds: 120 }
  ] });
  const rows = await createDebateService({ pool }).listOwnRequests(context(delegate));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, requestOne);
  assert.ok(pool.calls.some(call => call.sql.includes('WHERE request.speaker_id = $1') && call.params[0] === delegate));
  assert.ok(pool.audits.some(call => call[1] === 'debate_request.own_listed'));
  await assert.rejects(
    createDebateService({ pool: fakePool() }).listOwnRequests(context(stakeholder)),
    DebateAccessError
  );
});

test('only active clerks and administrators can inspect the restricted speaker queue', async () => {
  const pool = fakePool({ requestRows: [
    { id: requestOne, motion_id: motionId, speaker_id: delegate, status: 'pending', queue_position: null, allocated_seconds: 120 }
  ] });
  const rows = await createDebateService({ pool }).listClerkQueue(motionId, context(clerk));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].speakerUserId, delegate);
  assert.ok(pool.audits.some(call => call[1] === 'debate_request.clerk_queue_listed'));
  await assert.rejects(
    createDebateService({ pool: fakePool() }).listClerkQueue(motionId, context(stakeholder)),
    DebateAccessError
  );
  await assert.rejects(
    createDebateService({ pool: fakePool() }).listClerkQueue(motionId, context(delegate)),
    DebateAccessError
  );
});

test('clerk approval allocates the next queue position and bounded speaking time', async () => {
  const pool = fakePool({ role: 'clerk' });
  pool.requests.push({
    id: requestOne, motion_id: motionId, speaker_id: delegate, status: 'pending',
    requested_at: '2027-02-15T06:00:00.000Z', reviewed_by: null, reviewed_at: null,
    speaking_started_at: null, speaking_ended_at: null, allocated_seconds: 120,
    queue_position: null, review_reason_code: null
  });
  const row = await createDebateService({ pool }).reviewRequest(requestOne, {
    decision: 'approve', allocatedSeconds: 180
  }, context(clerk));
  assert.equal(row.status, 'approved');
  assert.equal(row.queuePosition, 1);
  assert.equal(row.allocatedSeconds, 180);
  assert.equal(pool.events[0][2], 'approved');
  assert.equal(pool.audits[0][1], 'debate_request.approved');
});

test('clerk rejection requires a controlled reason and does not allocate a queue position', async () => {
  const makePool = () => {
    const pool = fakePool();
    pool.requests.push({
      id: requestOne, motion_id: motionId, speaker_id: delegate, status: 'pending',
      requested_at: '2027-02-15T06:00:00.000Z', reviewed_by: null, reviewed_at: null,
      speaking_started_at: null, speaking_ended_at: null, allocated_seconds: 120,
      queue_position: null, review_reason_code: null
    });
    return pool;
  };
  await assert.rejects(
    createDebateService({ pool: makePool() }).reviewRequest(requestOne, { decision: 'reject' }, context(clerk)),
    DebateValidationError
  );
  const pool = makePool();
  const row = await createDebateService({ pool }).reviewRequest(requestOne, {
    decision: 'reject', reasonCode: 'capacity'
  }, context(clerk));
  assert.equal(row.status, 'rejected');
  assert.equal(row.queuePosition, null);
  assert.equal(row.reviewReasonCode, 'capacity');
});

test('review rejects invalid durations, unknown fields and non-clerk actors', async () => {
  const pool = fakePool();
  pool.requests.push({
    id: requestOne, motion_id: motionId, speaker_id: delegate, status: 'pending',
    requested_at: '2027-02-15T06:00:00.000Z', reviewed_by: null, reviewed_at: null,
    speaking_started_at: null, speaking_ended_at: null, allocated_seconds: 120,
    queue_position: null, review_reason_code: null
  });
  const service = createDebateService({ pool });
  await assert.rejects(service.reviewRequest(requestOne, {
    decision: 'approve', allocatedSeconds: 10
  }, context(clerk)), DebateValidationError);
  await assert.rejects(service.reviewRequest(requestOne, {
    decision: 'approve', allocatedSeconds: 120, note: 'extra'
  }, context(clerk)), DebateValidationError);
  await assert.rejects(service.reviewRequest(requestOne, {
    decision: 'approve', allocatedSeconds: 120
  }, context(delegate)), DebateAccessError);
});

test('speaker cannot start out of order or while another speaker is on the floor', async () => {
  const pool = fakePool();
  pool.requests.push(
    {
      id: requestOne, motion_id: motionId, speaker_id: delegate, status: 'approved',
      requested_at: '2027-02-15T06:00:00.000Z', reviewed_by: clerk, reviewed_at: '2027-02-15T07:00:00Z',
      speaking_started_at: null, speaking_ended_at: null, allocated_seconds: 120,
      queue_position: 1, review_reason_code: null
    },
    {
      id: requestTwo, motion_id: motionId, speaker_id: secondDelegate, status: 'approved',
      requested_at: '2027-02-15T06:01:00.000Z', reviewed_by: clerk, reviewed_at: '2027-02-15T07:00:00Z',
      speaking_started_at: null, speaking_ended_at: null, allocated_seconds: 90,
      queue_position: 2, review_reason_code: null
    }
  );
  const service = createDebateService({ pool });
  await assert.rejects(service.startSpeaker(requestTwo, {}, context(clerk)), DebateConflictError);
  await service.startSpeaker(requestOne, {}, context(clerk));
  await assert.rejects(service.startSpeaker(requestTwo, {}, context(clerk)), DebateConflictError);
  assert.equal(pool.requests[0].speaking_started_at, '2027-02-15T07:05:00.000Z');
  assert.equal(pool.audits[0][1], 'debate_request.speaker_started');
});

test('clerk can finish only a speaker who has started and then advance the queue', async () => {
  const pool = fakePool();
  pool.requests.push(
    {
      id: requestOne, motion_id: motionId, speaker_id: delegate, status: 'approved',
      requested_at: '2027-02-15T06:00:00.000Z', reviewed_by: clerk, reviewed_at: '2027-02-15T07:00:00Z',
      speaking_started_at: '2027-02-15T07:05:00Z', speaking_ended_at: null,
      allocated_seconds: 120, queue_position: 1, review_reason_code: null
    },
    {
      id: requestTwo, motion_id: motionId, speaker_id: secondDelegate, status: 'approved',
      requested_at: '2027-02-15T06:01:00.000Z', reviewed_by: clerk, reviewed_at: '2027-02-15T07:00:00Z',
      speaking_started_at: null, speaking_ended_at: null,
      allocated_seconds: 90, queue_position: 2, review_reason_code: null
    }
  );
  const service = createDebateService({ pool });
  await assert.rejects(service.finishSpeaker(requestTwo, {}, context(clerk)), DebateConflictError);
  const finished = await service.finishSpeaker(requestOne, {}, context(clerk));
  assert.equal(finished.status, 'completed');
  assert.ok(finished.speakingEndedAt);
  await service.startSpeaker(requestTwo, {}, context(clerk));
  assert.ok(pool.audits.some(call => call[1] === 'debate_request.speaker_finished'));
});

test('missing debate requests return a non-disclosing not-found error', async () => {
  const pool = fakePool();
  await assert.rejects(
    createDebateService({ pool }).reviewRequest(requestOne, {
      decision: 'reject', reasonCode: 'other'
    }, context(clerk)),
    DebateNotFoundError
  );
});

test('audit failure rolls back a speaker request', async () => {
  const pool = fakePool({ failAudit: true });
  await assert.rejects(
    createDebateService({ pool }).requestSpeakerSlot(motionId, {}, context(delegate)),
    /synthetic audit failure/u
  );
  assert.ok(pool.calls.some(call => call.sql === 'ROLLBACK'));
  assert.equal(pool.released, 1);
});
