import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SittingConflictError, SittingForbiddenError, SittingNotFoundError,
  SittingValidationError, createSittingService
} from '../src/domain/sittings.js';

const clerk = '00000000-0000-4000-8000-000000000031';
const speaker = '00000000-0000-4000-8000-000000000032';
const stakeholder = '00000000-0000-4000-8000-000000000033';
const id = '00000000-0000-4000-8000-000000000034';
const context = actorUserId => ({ actorUserId, requestId: 'synthetic-sitting-request' });

function fakePool({ role = 'clerk', status = 'active', failAudit = false, publicRows = [] } = {}) {
  const calls = [], events = [];
  const state = {
    id, title: 'Children’s Assembly plenary sitting', session_number: 4,
    scheduled_at: '2027-02-15T06:00:00.000Z', venue: 'Mombasa County Assembly Hall',
    status: 'draft', published_at: null, concluded_at: null
  };
  let released = false;
  const run = async (sql, params = []) => {
    calls.push({ sql, params });
    if (sql.includes('FROM users u')) return { rows: [{ role, status, guardian_consent_approved: true }] };
    if (sql.includes('FROM users WHERE id = $1 FOR SHARE')) return { rows: [{ role, status }] };
    if (sql.includes('INSERT INTO sittings')) {
      Object.assign(state, { title: params[0], session_number: params[1], scheduled_at: params[2], venue: params[3] });
      return { rows: [{ ...state }] };
    }
    if (sql.includes('SELECT id, title, session_number') && sql.includes('FOR UPDATE')) return { rows: [{ ...state }] };
    if (sql.includes('SELECT id, status::text AS status FROM sittings')) return { rows: [{ id, status: state.status }] };
    if (sql.includes('UPDATE sittings SET title =')) {
      Object.assign(state, { title: params[1], session_number: params[2], scheduled_at: params[3], venue: params[4] });
      return { rows: [{ ...state }] };
    }
    if (sql.includes('UPDATE sittings SET status =')) {
      state.status = params[1];
      if (state.status === 'published') state.published_at = '2027-02-14T10:00:00.000Z';
      if (state.status === 'concluded') state.concluded_at = '2027-02-15T12:00:00.000Z';
      return { rows: [{ ...state }] };
    }
    if (sql.includes('INSERT INTO sitting_lifecycle_events')) { events.push(params); return { rows: [], rowCount: 1 }; }
    if (sql.includes('INSERT INTO audit_logs')) {
      if (failAudit) throw new Error('synthetic audit failure');
      return { rows: [], rowCount: 1 };
    }
    if (sql.includes('FROM sittings WHERE ($1::boolean')) return { rows: params[0] || state.status !== 'draft' ? [{ ...state }] : [] };
    if (sql.includes('FROM sittings WHERE id = $1 AND ($2::boolean')) return { rows: params[1] || state.status !== 'draft' ? [{ ...state }] : [] };
    return { rows: [], rowCount: 1 };
  };
  return {
    calls, events, state, get released() { return released; },
    async connect() { return { query: run, release() { released = true; } }; },
    async query(sql, params = []) {
      calls.push({ sql, params });
      if (sql.includes('FROM public_sitting_summary')) return { rows: publicRows };
      return { rows: [], rowCount: 1 };
    }
  };
}

const valid = {
  title: 'Children’s Assembly plenary sitting',
  sessionNumber: 4,
  scheduledAt: '2027-02-15T09:00:00+03:00'
};

test('creates a draft with lifecycle and audit records', async () => {
  const pool = fakePool(), service = createSittingService({ pool });
  const row = await service.createSitting(valid, context(clerk));
  assert.equal(row.status, 'draft');
  assert.equal(pool.events[0][2], 'created');
  assert.ok(pool.calls.some(c => c.params[1] === 'sitting.created'));
  assert.equal(pool.released, true);
});

test('rejects non-clerks, inactive officials and malformed input', async () => {
  for (const options of [
    { role: 'stakeholder' }, { role: 'coordinator' },
    { role: 'speaker' }, { role: 'clerk', status: 'suspended' }
  ]) {
    const pool = fakePool(options), service = createSittingService({ pool });
    await assert.rejects(service.createSitting(valid, context(clerk)), SittingForbiddenError);
  }
  const service = createSittingService({ pool: fakePool() });
  await assert.rejects(
    service.createSitting({ ...valid, scheduledAt: '2027-02-15T09:00:00' }, context(clerk)),
    SittingValidationError
  );
  await assert.rejects(
    service.createSitting({ ...valid, unexpected: true }, context(clerk)),
    SittingValidationError
  );
  await assert.rejects(service.listPublicSittings({ limit: '500' }), SittingValidationError);
});

test('updates drafts only and records changed field names, not content', async () => {
  const pool = fakePool(), service = createSittingService({ pool });
  const row = await service.updateSitting(id, { title: 'Revised plenary sitting' }, context(clerk));
  assert.equal(row.title, 'Revised plenary sitting');
  assert.equal(pool.events[0][2], 'updated');
  const audit = pool.calls.find(c => c.params[1] === 'sitting.updated');
  assert.ok(audit);
  assert.doesNotMatch(JSON.stringify(audit.params), /Revised plenary sitting/u);
});

test('rejects editing published sittings and enforces terminal lifecycle states', async () => {
  const pool = fakePool(), service = createSittingService({ pool });
  await service.transitionSitting(id, { status: 'published' }, context(clerk));
  await assert.rejects(
    service.updateSitting(id, { title: 'Not allowed' }, context(clerk)),
    SittingConflictError
  );
  await service.transitionSitting(id, { status: 'in_progress' }, context(clerk));
  await service.transitionSitting(id, { status: 'concluded' }, context(clerk));
  await assert.rejects(
    service.transitionSitting(id, { status: 'cancelled' }, context(clerk)),
    SittingConflictError
  );
  assert.equal(pool.events.length, 3);
});

test('restricts drafts to clerks and administrators and denies stakeholders', async () => {
  const clerkPool = fakePool({ role: 'clerk' });
  assert.equal((await createSittingService({ pool: clerkPool }).listAssemblySittings(context(clerk))).length, 1);
  const speakerPool = fakePool({ role: 'speaker' });
  const speakerService = createSittingService({ pool: speakerPool });
  assert.equal((await speakerService.listAssemblySittings(context(speaker))).length, 0);
  await assert.rejects(speakerService.getAssemblySitting(id, context(speaker)), SittingNotFoundError);
  const stakeholderService = createSittingService({ pool: fakePool({ role: 'stakeholder' }) });
  await assert.rejects(stakeholderService.listAssemblySittings(context(stakeholder)), SittingForbiddenError);
});

test('public listing reads only the narrow published view', async () => {
  const pool = fakePool({ publicRows: [{
    id, title: 'Published plenary sitting', session_number: 4,
    scheduled_at: '2027-02-15T06:00:00.000Z', venue: 'Assembly Hall',
    status: 'published', published_at: '2027-02-14T10:00:00.000Z', concluded_at: null
  }] });
  const rows = await createSittingService({ pool }).listPublicSittings();
  assert.equal(rows.length, 1);
  const query = pool.calls.find(c => c.sql.includes('public_sitting_summary'));
  assert.ok(query);
  assert.doesNotMatch(query.sql, /created_by|order_paper_storage_key/iu);
});

test('rejects malformed identifiers and rolls back if audit persistence fails', async () => {
  const invalidPool = fakePool(), invalidService = createSittingService({ pool: invalidPool });
  await assert.rejects(
    invalidService.getAssemblySitting('not-a-uuid', context(speaker)),
    SittingValidationError
  );
  assert.equal(invalidPool.calls.length, 0);
  const pool = fakePool({ failAudit: true }), service = createSittingService({ pool });
  await assert.rejects(service.createSitting(valid, context(clerk)), /synthetic audit failure/u);
  assert.ok(pool.calls.some(c => c.sql === 'ROLLBACK'));
});
