import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createGuardianConsentReviewService,
  ConsentReviewConflictError,
  ConsentReviewForbiddenError,
  ConsentReviewValidationError
} from '../src/domain/guardian-consent-review.js';

const CONSENT_ID = '11111111-1111-4111-8111-111111111111';
const COORDINATOR_ID = '22222222-2222-4222-8222-222222222222';
const CHILD_ID = '33333333-3333-4333-8333-333333333333';
const REVIEW_ID = '44444444-4444-4444-8444-444444444444';

function createFakePool({
  role = 'coordinator',
  consentStatus = 'pending',
  accountStatus = 'pending',
  coordinatorCounty = 'Mombasa',
  childCounty = 'Mombasa',
  failAudit = false
} = {}) {
  const state = {
    role,
    consentStatus,
    accountStatus,
    coordinatorCounty,
    childCounty,
    reviews: [],
    audits: [],
    released: false,
    transactionSnapshot: null
  };
  const calls = [];

  const client = {
    async query(sql, params = []) {
      const normalized = sql.replace(/\s+/gu, ' ').trim();
      calls.push({ sql: normalized, params });

      if (normalized === 'BEGIN') {
        state.transactionSnapshot = {
          consentStatus: state.consentStatus,
          accountStatus: state.accountStatus,
          reviews: [...state.reviews],
          audits: [...state.audits]
        };
        return { rows: [], rowCount: 0 };
      }
      if (normalized === 'COMMIT') {
        state.transactionSnapshot = null;
        return { rows: [], rowCount: 0 };
      }
      if (normalized === 'ROLLBACK') {
        if (state.transactionSnapshot) {
          Object.assign(state, state.transactionSnapshot);
          state.transactionSnapshot = null;
        }
        return { rows: [], rowCount: 0 };
      }
      if (normalized.startsWith('SELECT id, county FROM users')) {
        return role === 'coordinator'
          ? { rows: [{ id: params[0], county: state.coordinatorCounty }], rowCount: 1 }
          : { rows: [], rowCount: 0 };
      }
      if (normalized.includes('FROM guardian_consents gc') &&
          normalized.includes("WHERE gc.status IN ('pending', 'rejected')")) {
        return state.childCounty === params[0] ? {
          rows: [{
            id: CONSENT_ID,
            status: state.consentStatus,
            consent_text_version: 'synthetic-consent-v1',
            created_at: '2026-11-10T10:00:00.000Z'
          }],
          rowCount: 1
        } : { rows: [], rowCount: 0 };
      }
      if (normalized.includes('gc.guardian_name_ciphertext') &&
          normalized.includes('FOR SHARE OF gc, u')) {
        return state.childCounty === params[1] ? {
          rows: [{
            id: CONSENT_ID,
            consent_status: state.consentStatus,
            consent_text_version: 'synthetic-consent-v1',
            created_at: '2026-11-10T10:00:00.000Z',
            consent_document_storage_key: null,
            guardian_name_ciphertext: Buffer.from('Synthetic Guardian'),
            guardian_phone_ciphertext: Buffer.from('+254700000001'),
            full_name_ciphertext: Buffer.from('Synthetic Child'),
            age: 14,
            school_ciphertext: Buffer.from('Synthetic School'),
            county: 'Mombasa',
            ward: 'Nyali'
          }],
          rowCount: 1
        } : { rows: [], rowCount: 0 };
      }
      if (normalized.includes('gc.child_user_id') &&
          normalized.includes('FOR UPDATE OF gc, u')) {
        return state.childCounty === params[1] ? {
          rows: [{
            id: CONSENT_ID,
            child_user_id: CHILD_ID,
            consent_status: state.consentStatus,
            child_role: 'public_child',
            account_status: state.accountStatus
          }],
          rowCount: 1
        } : { rows: [], rowCount: 0 };
      }
      if (normalized.startsWith('INSERT INTO guardian_consent_reviews')) {
        state.reviews.push({ decision: params[2], method: params[3], reference: params[4] });
        return { rows: [{ id: REVIEW_ID }], rowCount: 1 };
      }
      if (normalized.startsWith('UPDATE guardian_consents')) {
        state.consentStatus = params[1];
        return {
          rows: [{
            status: state.consentStatus,
            reviewed_at: '2026-11-10T10:05:00.000Z',
            granted_at: state.consentStatus === 'approved' ? '2026-11-10T10:05:00.000Z' : null
          }],
          rowCount: 1
        };
      }
      if (normalized.startsWith('UPDATE users')) {
        state.accountStatus = 'active';
        return { rows: [{ id: CHILD_ID }], rowCount: 1 };
      }
      if (normalized.startsWith('INSERT INTO audit_logs')) {
        if (failAudit) throw new Error('synthetic audit failure');
        state.audits.push({ action: params[1], metadata: params[6] });
        return { rows: [], rowCount: 1 };
      }

      return { rows: [], rowCount: 0 };
    },
    release() {
      state.released = true;
    }
  };

  return {
    state,
    calls,
    async connect() {
      return client;
    }
  };
}

function createService(pool) {
  return createGuardianConsentReviewService({
    pool,
    fieldCrypto: {
      decryptField(value) {
        return Buffer.from(value).toString('utf8');
      }
    }
  });
}

const context = {
  actorUserId: COORDINATOR_ID,
  requestId: 'synthetic-request-id',
  networkFingerprint: Buffer.alloc(32, 7)
};

const approval = {
  decision: 'approved',
  verificationMethod: 'verified_call',
  evidenceReference: 'guardian-check-0001'
};

test('coordinator queue returns minimal records and writes an audit event', async () => {
  const pool = createFakePool();
  const service = createService(pool);

  const queue = await service.listReviewQueue(context);

  assert.equal(queue.length, 1);
  assert.deepEqual(Object.keys(queue[0]).sort(), [
    'consentId', 'consentNoticeVersion', 'createdAt', 'status'
  ]);
  assert.equal(pool.state.audits[0].action, 'guardian.consent_queue_viewed');
  assert.equal(pool.state.released, true);
});

test('coordinator detail view decrypts identity only in the restricted service and audits the read', async () => {
  const pool = createFakePool();
  const service = createService(pool);

  const details = await service.getReviewDetails(CONSENT_ID, context);

  assert.equal(details.child.fullName, 'Synthetic Child');
  assert.equal(details.child.school, 'Synthetic School');
  assert.equal(details.guardian.name, 'Synthetic Guardian');
  assert.equal(details.guardian.phone, '+254700000001');
  assert.equal(pool.state.audits[0].action, 'guardian.consent_review_details_viewed');
  assert.equal(pool.state.audits[0].metadata.includes('+254700000001'), false);
});

test('approval records the review before changing consent and activates the child atomically', async () => {
  const pool = createFakePool();
  const service = createService(pool);

  const result = await service.reviewConsent(CONSENT_ID, approval, context);

  assert.equal(result.status, 'approved');
  assert.equal(result.accountStatus, 'active');
  assert.equal(pool.state.consentStatus, 'approved');
  assert.equal(pool.state.accountStatus, 'active');
  assert.equal(pool.state.reviews.length, 1);
  assert.equal(pool.state.audits[0].action, 'guardian.consent_approved');

  const reviewIndex = pool.calls.findIndex(call => call.sql.startsWith('INSERT INTO guardian_consent_reviews'));
  const consentIndex = pool.calls.findIndex(call => call.sql.startsWith('UPDATE guardian_consents'));
  const userIndex = pool.calls.findIndex(call => call.sql.startsWith('UPDATE users'));
  const auditIndex = pool.calls.findIndex(call => call.sql.startsWith('INSERT INTO audit_logs'));
  assert.ok(reviewIndex < consentIndex);
  assert.ok(consentIndex < userIndex);
  assert.ok(userIndex < auditIndex);
  assert.ok(pool.calls.some(call => call.sql === 'COMMIT'));
});

test('rejection is recorded but does not activate the child account', async () => {
  const pool = createFakePool();
  const service = createService(pool);

  const result = await service.reviewConsent(CONSENT_ID, {
    decision: 'rejected',
    verificationMethod: 'document_review',
    evidenceReference: 'guardian-check-0002'
  }, context);

  assert.equal(result.status, 'rejected');
  assert.equal(result.accountStatus, 'pending');
  assert.equal(pool.state.accountStatus, 'pending');
  assert.equal(pool.calls.some(call => call.sql.startsWith('UPDATE users')), false);
});

test('non-coordinator actors cannot list or review consent requests', async () => {
  const pool = createFakePool({ role: 'stakeholder' });
  const service = createService(pool);

  await assert.rejects(
    service.listReviewQueue(context),
    ConsentReviewForbiddenError
  );
  assert.equal(pool.calls.some(call => call.sql.startsWith('SELECT gc.id, gc.status')), false);
  assert.ok(pool.calls.some(call => call.sql === 'ROLLBACK'));
});

test('already approved consent cannot be reviewed again', async () => {
  const pool = createFakePool({ consentStatus: 'approved', accountStatus: 'active' });
  const service = createService(pool);

  await assert.rejects(
    service.reviewConsent(CONSENT_ID, {
      decision: 'rejected',
      verificationMethod: 'verified_call',
      evidenceReference: 'guardian-check-0003'
    }, context),
    ConsentReviewConflictError
  );
  assert.equal(pool.state.reviews.length, 0);
});

test('invalid consent IDs and evidence references are rejected before database access', async () => {
  const pool = createFakePool();
  const service = createService(pool);

  await assert.rejects(
    service.getReviewDetails('not-a-uuid', context),
    ConsentReviewValidationError
  );
  await assert.rejects(
    service.reviewConsent(CONSENT_ID, {
      ...approval,
      evidenceReference: '../private/phone'
    }, context),
    ConsentReviewValidationError
  );
  assert.equal(pool.calls.length, 0);
});

test('audit failure rolls back the review transaction', async () => {
  const pool = createFakePool({ failAudit: true });
  const service = createService(pool);

  await assert.rejects(
    service.reviewConsent(CONSENT_ID, approval, context),
    /synthetic audit failure/
  );

  assert.equal(pool.state.consentStatus, 'pending');
  assert.equal(pool.state.accountStatus, 'pending');
  assert.equal(pool.state.reviews.length, 0);
  assert.ok(pool.calls.some(call => call.sql === 'ROLLBACK'));
  assert.equal(pool.state.released, true);
});

test('coordinators cannot inspect consent requests outside their assigned county', async () => {
  const pool = createFakePool({ coordinatorCounty: 'Kilifi', childCounty: 'Mombasa' });
  const service = createService(pool);

  const queue = await service.listReviewQueue(context);
  assert.equal(queue.length, 0);
  await assert.rejects(
    service.getReviewDetails(CONSENT_ID, context),
    /not found/
  );
  await assert.rejects(
    service.reviewConsent(CONSENT_ID, approval, context),
    /not found/
  );
  assert.equal(pool.state.reviews.length, 0);
});
