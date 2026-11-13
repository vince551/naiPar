import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ConcernModerationConflictError,
  ConcernModerationForbiddenError,
  ConcernModerationNotFoundError,
  ConcernModerationValidationError,
  createConcernModerationService
} from '../src/domain/concern-moderation.js';

const coordinatorId = '00000000-0000-4000-8000-000000000021';
const secondCoordinatorId = '00000000-0000-4000-8000-000000000022';
const otherCountyCoordinatorId = '00000000-0000-4000-8000-000000000023';
const concernId = '00000000-0000-4000-8000-000000000024';

const encrypted = value => Buffer.from(`encrypted:${value}`, 'utf8');
const fieldCrypto = {
  encryptField: value => encrypted(value),
  decryptField: value => {
    const text = Buffer.from(value).toString('utf8');
    if (!text.startsWith('encrypted:')) throw new Error('synthetic decrypt failure');
    return text.slice('encrypted:'.length);
  }
};

function createFakePool({
  coordinatorCounty = 'Mombasa',
  coordinatorRole = 'coordinator',
  coordinatorStatus = 'active',
  concernStatus = 'submitted',
  assignedCoordinator = null,
  isPublic = false,
  lastModeratedBy = null,
  publicRows = []
} = {}) {
  const calls = [];
  const events = [];
  const state = {
    status: concernStatus,
    assignedCoordinator,
    isPublic,
    lastModeratedBy,
    publicTheme: null,
    publicTitle: null
  };
  let released = false;

  const runQuery = async (sql, params = []) => {
    calls.push({ sql, params });
    if (sql.includes('SELECT id, county') && sql.includes('FROM users')) {
      return {
        rows: coordinatorStatus === 'active' && coordinatorRole === 'coordinator'
          ? [{ id: coordinatorId, county: coordinatorCounty }]
          : []
      };
    }
    if (sql.includes('LEFT JOIN LATERAL')) {
      return {
        rows: [{
          id: concernId,
          status: state.status,
          created_at: '2026-11-13T10:00:00.000Z',
          updated_at: '2026-11-13T10:00:00.000Z',
          county: 'Mombasa',
          sub_county: 'Nyali',
          ward: 'Kongowea',
          assigned_coordinator: state.assignedCoordinator,
          is_public: state.isPublic,
          public_theme: state.publicTheme,
          public_title: state.publicTitle,
          theme_ciphertext: encrypted('Education access'),
          title_ciphertext: encrypted('Improve reading materials'),
          description_ciphertext: encrypted('The community library needs more age-appropriate books.'),
          internal_note_ciphertext: encrypted('Contact the county education office.')
        }]
      };
    }
    if (sql.includes('SELECT') && sql.includes('FROM concerns c')) {
      return {
        rows: [{
          id: concernId,
          status: state.status,
          created_at: '2026-11-13T10:00:00.000Z',
          updated_at: '2026-11-13T10:00:00.000Z',
          assigned_to_me: state.assignedCoordinator === coordinatorId
        }]
      };
    }
    if (sql.includes('SELECT id, status::text AS status, is_public')) {
      return { rows: [{ id: concernId, status: state.status, is_public: state.isPublic }] };
    }
    if (sql.includes('SELECT id, status::text AS status, assigned_coordinator')) {
      return {
        rows: [{
          id: concernId,
          status: state.status,
          assigned_coordinator: state.assignedCoordinator,
          is_public: state.isPublic,
          last_moderated_by: state.lastModeratedBy
        }]
      };
    }
    if (sql.includes('UPDATE concerns') && sql.includes('SET status =')) {
      state.status = params[1];
      state.assignedCoordinator = state.assignedCoordinator || params[2];
      state.lastModeratedBy = params[2];
      if (params[3]) {
        state.isPublic = false;
        state.publicTheme = null;
        state.publicTitle = null;
      }
      return {
        rows: [{
          id: concernId,
          status: state.status,
          updated_at: '2026-11-13T10:05:00.000Z'
        }]
      };
    }
    if (sql.includes('UPDATE concerns') && sql.includes('SET is_public = true')) {
      state.isPublic = true;
      state.publicTheme = params[1];
      state.publicTitle = params[2];
      return {
        rows: [{
          id: concernId,
          status: state.status,
          public_theme: state.publicTheme,
          public_title: state.publicTitle,
          published_at: '2026-11-13T10:10:00.000Z'
        }]
      };
    }
    if (sql.includes('UPDATE concerns') && sql.includes('SET is_public = false')) {
      state.isPublic = false;
      state.publicTheme = null;
      state.publicTitle = null;
      return { rows: [], rowCount: 1 };
    }
    if (sql.includes('INSERT INTO concern_moderation_events')) {
      events.push(params);
      return { rows: [], rowCount: 1 };
    }
    if (sql.includes('INSERT INTO audit_logs')) {
      return { rows: [], rowCount: 1 };
    }
    return { rows: [], rowCount: 1 };
  };

  return {
    calls,
    events,
    state,
    get released() { return released; },
    async connect() {
      return {
        query: runQuery,
        release() { released = true; }
      };
    },
    async query(sql, params = []) {
      calls.push({ sql, params });
      if (sql.includes('FROM public_concern_summary')) return { rows: publicRows };
      return { rows: [], rowCount: 1 };
    }
  };
}

const serviceFor = options => {
  const pool = createFakePool(options);
  return { pool, service: createConcernModerationService({ pool, fieldCrypto }) };
};

test('lists a minimal county-scoped moderation queue and audits the read', async () => {
  const { pool, service } = serviceFor();
  const rows = await service.listReviewQueue({
    actorUserId: coordinatorId,
    requestId: 'synthetic-moderation-queue'
  });

  assert.equal(rows.length, 1);
  assert.equal(rows[0].concernId, concernId);
  const queueQuery = pool.calls.find(call => call.sql.includes('FROM concerns c'));
  assert.deepEqual(queueQuery.params, [coordinatorId, 'Mombasa']);
  assert.doesNotMatch(queueQuery.sql, /description_ciphertext|submitted_by|guardian/iu);
  assert.ok(pool.calls.some(call => call.sql.includes('concern.moderation_queue_viewed')));
});

test('denies queue access to inactive, non-coordinator or unassigned-county accounts', async () => {
  for (const options of [
    { coordinatorStatus: 'suspended' },
    { coordinatorRole: 'stakeholder' },
    { coordinatorCounty: null }
  ]) {
    const { pool, service } = serviceFor(options);
    await assert.rejects(
      service.listReviewQueue({ actorUserId: coordinatorId }),
      ConcernModerationForbiddenError
    );
    assert.ok(!pool.calls.some(call => call.sql.includes('FROM concerns c')));
  }
});

test('returns private concern details only to an active coordinator in the matching county', async () => {
  const { pool, service } = serviceFor();
  const details = await service.getConcernDetails(concernId, {
    actorUserId: coordinatorId,
    requestId: 'synthetic-detail-read'
  });

  assert.equal(details.privateContent.description, 'The community library needs more age-appropriate books.');
  assert.equal(details.latestInternalNote, 'Contact the county education office.');
  assert.equal(details.location.ward, 'Kongowea');
  assert.ok(pool.calls.some(call => call.sql.includes('concern.moderation_details_viewed')));
  assert.ok(!pool.calls.some(call => call.params.some(value => value === details.privateContent.description)));
});

test('rejects malformed concern identifiers and hides concerns outside coordinator scope', async () => {
  const { pool, service } = serviceFor();
  await assert.rejects(
    service.getConcernDetails('not-a-uuid', { actorUserId: coordinatorId }),
    ConcernModerationValidationError
  );

  const scoped = createFakePool({ coordinatorCounty: 'Kilifi' });
  scoped.connect = async () => ({
    async query(sql, params = []) {
      scoped.calls.push({ sql, params });
      if (sql.includes('SELECT id, county')) return { rows: [{ id: coordinatorId, county: 'Kilifi' }] };
      if (sql.includes('LEFT JOIN LATERAL')) return { rows: [] };
      return { rows: [], rowCount: 1 };
    },
    release() {}
  });
  const scopedService = createConcernModerationService({ pool: scoped, fieldCrypto });
  await assert.rejects(
    scopedService.getConcernDetails(concernId, { actorUserId: coordinatorId }),
    ConcernModerationNotFoundError
  );
});

test('moderates a concern, assigns it to the coordinator and encrypts the internal note', async () => {
  const { pool, service } = serviceFor();
  const result = await service.moderateConcern(concernId, {
    decision: 'under_review',
    internalNote: 'Contact the county education office.'
  }, {
    actorUserId: coordinatorId,
    requestId: 'synthetic-moderation-write'
  });

  assert.equal(result.status, 'under_review');
  assert.equal(result.isPublic, false);
  assert.equal(pool.state.assignedCoordinator, coordinatorId);
  const event = pool.events.find(params => params[2] === 'status_change');
  assert.ok(event);
  assert.deepEqual(event[5], encrypted('Contact the county education office.'));
  const audit = pool.calls.find(call => call.sql.includes('INSERT INTO audit_logs'));
  assert.ok(audit);
  assert.ok(!JSON.stringify(audit.params).includes('Contact the county education office.'));
  assert.ok(pool.calls.some(call => call.sql.includes("set_config('app.actor_user_id'")));
});

test('prevents another coordinator from taking over an assigned concern and rejects invalid transitions', async () => {
  const assigned = createFakePool({ assignedCoordinator: secondCoordinatorId });
  const assignedService = createConcernModerationService({ pool: assigned, fieldCrypto });
  await assert.rejects(
    assignedService.moderateConcern(concernId, { decision: 'under_review' }, {
      actorUserId: coordinatorId
    }),
    ConcernModerationConflictError
  );

  const closed = createFakePool({ concernStatus: 'closed' });
  const closedService = createConcernModerationService({ pool: closed, fieldCrypto });
  await assert.rejects(
    closedService.moderateConcern(concernId, { decision: 'under_review' }, {
      actorUserId: coordinatorId
    }),
    ConcernModerationConflictError
  );
});

test('requires a different coordinator to approve a de-identified public projection', async () => {
  const { pool, service } = serviceFor({
    concernStatus: 'consolidated',
    assignedCoordinator: secondCoordinatorId,
    lastModeratedBy: secondCoordinatorId
  });
  const result = await service.publishConcern(concernId, {
    publicTheme: 'Education access',
    publicTitle: 'Improve community library resources'
  }, {
    actorUserId: coordinatorId,
    requestId: 'synthetic-publication'
  });

  assert.equal(result.publicTitle, 'Improve community library resources');
  assert.equal(pool.state.isPublic, true);
  assert.ok(pool.events.some(params => params[2] === 'published'));
  assert.ok(pool.calls.some(call => call.sql.includes('concern.publication_approved')));
});

test('rejects public wording containing contact details or unsupported fields', async () => {
  const { service } = serviceFor({
    concernStatus: 'consolidated',
    assignedCoordinator: secondCoordinatorId,
    lastModeratedBy: secondCoordinatorId
  });
  for (const payload of [
    { publicTheme: 'Education access', publicTitle: 'Call 0712345678 for books' },
    { publicTheme: 'Education access', publicTitle: 'Contact child@example.test' },
    { publicTheme: 'Education access', publicTitle: 'See https://example.test' },
    { publicTheme: 'Education access', publicTitle: 'A safe title', county: 'Mombasa' }
  ]) {
    await assert.rejects(
      service.publishConcern(concernId, payload, { actorUserId: coordinatorId }),
      ConcernModerationValidationError
    );
  }
});

test('prevents the same coordinator who moderated a concern from publishing it', async () => {
  const { service } = serviceFor({
    concernStatus: 'responded',
    assignedCoordinator: coordinatorId,
    lastModeratedBy: coordinatorId
  });
  await assert.rejects(
    service.publishConcern(concernId, {
      publicTheme: 'Education access',
      publicTitle: 'Improve community library resources'
    }, { actorUserId: coordinatorId }),
    ConcernModerationConflictError
  );
});

test('unpublishes a public concern and clears the public projection', async () => {
  const { pool, service } = serviceFor({
    concernStatus: 'responded',
    assignedCoordinator: secondCoordinatorId,
    lastModeratedBy: secondCoordinatorId,
    isPublic: true
  });
  const result = await service.unpublishConcern(concernId, {
    actorUserId: coordinatorId,
    requestId: 'synthetic-unpublish'
  });

  assert.equal(result.isPublic, false);
  assert.equal(pool.state.publicTitle, null);
  assert.ok(pool.events.some(params => params[2] === 'unpublished'));
});

test('serves only the redacted public database projection', async () => {
  const { pool, service } = serviceFor({
    publicRows: [{
      id: concernId,
      theme: 'Education access',
      title: 'Improve community library resources',
      status: 'responded',
      created_at: '2026-11-13T10:00:00.000Z'
    }]
  });
  const rows = await service.listPublicConcerns();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].title, 'Improve community library resources');
  assert.match(pool.calls[0].sql, /FROM public_concern_summary/u);
  assert.doesNotMatch(pool.calls[0].sql, /FROM concerns\b|submitted_by|description_ciphertext/iu);
});
