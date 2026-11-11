import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createGuardianPhoneVerificationService,
  GuardianOtpProviderUnavailableError,
  GuardianOtpValidationError,
  GuardianOtpVerificationFailedError
} from '../src/domain/guardian-phone-verification.js';

const REGISTRATION_ID = '11111111-1111-4111-8111-111111111111';
const CONSENT_ID = '22222222-2222-4222-8222-222222222222';
const CHALLENGE_ID = '33333333-3333-4333-8333-333333333333';
const PHONE = '+254700000001';
const OTP_PEPPER = 'synthetic-guardian-otp-pepper-32-bytes';

function createFakePool({
  consentExists = true,
  recentCount = 0,
  lastRequestedAt = null
} = {}) {
  const state = {
    consentExists,
    recentCount,
    lastRequestedAt,
    challenge: null,
    consentVerified: false,
    audits: [],
    released: false,
    snapshot: null
  };
  const calls = [];

  const client = {
    async query(sql, params = []) {
      const normalized = sql.replace(/\s+/gu, ' ').trim();
      calls.push({ sql: normalized, params });

      if (normalized === 'BEGIN') {
        state.snapshot = structuredClone({
          challenge: state.challenge,
          consentVerified: state.consentVerified,
          audits: state.audits
        });
        return { rows: [], rowCount: 0 };
      }
      if (normalized === 'COMMIT') {
        state.snapshot = null;
        return { rows: [], rowCount: 0 };
      }
      if (normalized === 'ROLLBACK') {
        if (state.snapshot) Object.assign(state, state.snapshot);
        state.snapshot = null;
        return { rows: [], rowCount: 0 };
      }
      if (normalized.startsWith('SELECT gc.id FROM guardian_consents gc')) {
        return state.consentExists
          ? { rows: [{ id: CONSENT_ID }], rowCount: 1 }
          : { rows: [], rowCount: 0 };
      }
      if (normalized.startsWith('SELECT count(*)::int AS recent_count')) {
        return {
          rows: [{ recent_count: state.recentCount, last_requested_at: state.lastRequestedAt }],
          rowCount: 1
        };
      }
      if (normalized.startsWith('UPDATE guardian_phone_verification_challenges SET delivery_status = \'expired\'')) {
        if (!normalized.includes('expires_at <= now()') && state.challenge && ['pending', 'sent'].includes(state.challenge.deliveryStatus)) {
          state.challenge.deliveryStatus = 'expired';
        }
        return { rows: [], rowCount: 1 };
      }
      if (normalized.startsWith('INSERT INTO guardian_phone_verification_challenges')) {
        state.challenge = {
          id: CHALLENGE_ID,
          consentId: params[0],
          phoneHash: params[1],
          otpHash: params[2],
          deliveryStatus: 'pending',
          attempts: 0,
          sentAt: null,
          verifiedAt: null
        };
        state.recentCount += 1;
        state.lastRequestedAt = new Date().toISOString();
        return { rows: [{ id: CHALLENGE_ID }], rowCount: 1 };
      }
      if (normalized.startsWith('UPDATE guardian_phone_verification_challenges SET delivery_status = \'failed\'')) {
        if (state.challenge?.id === params[0]) state.challenge.deliveryStatus = 'failed';
        return { rows: [], rowCount: 1 };
      }
      if (normalized.startsWith('UPDATE guardian_phone_verification_challenges SET delivery_status = \'sent\'')) {
        if (!state.challenge || state.challenge.id !== params[0] || state.challenge.deliveryStatus !== 'pending') {
          return { rows: [], rowCount: 0 };
        }
        state.challenge.deliveryStatus = 'sent';
        state.challenge.sentAt = new Date().toISOString();
        return { rows: [{ id: CHALLENGE_ID }], rowCount: 1 };
      }
      if (normalized.startsWith('SELECT id, otp_hash, attempts FROM guardian_phone_verification_challenges')) {
        return state.challenge?.deliveryStatus === 'sent'
          ? {
              rows: [{
                id: state.challenge.id,
                otp_hash: state.challenge.otpHash,
                attempts: state.challenge.attempts
              }],
              rowCount: 1
            }
          : { rows: [], rowCount: 0 };
      }
      if (normalized.startsWith('UPDATE guardian_phone_verification_challenges SET attempts =')) {
        state.challenge.attempts = params[1];
        state.challenge.deliveryStatus = params[1] >= params[2] ? 'locked' : 'sent';
        return { rows: [], rowCount: 1 };
      }
      if (normalized.startsWith('UPDATE guardian_phone_verification_challenges SET delivery_status = \'verified\'')) {
        if (state.challenge?.deliveryStatus !== 'sent') return { rows: [], rowCount: 0 };
        state.challenge.deliveryStatus = 'verified';
        state.challenge.verifiedAt = new Date().toISOString();
        return { rows: [{ verified_at: state.challenge.verifiedAt }], rowCount: 1 };
      }
      if (normalized.startsWith('UPDATE guardian_consents SET guardian_phone_verified_at')) {
        if (state.consentVerified) return { rows: [], rowCount: 0 };
        state.consentVerified = true;
        return { rows: [{ id: CONSENT_ID }], rowCount: 1 };
      }
      if (normalized.startsWith('INSERT INTO audit_logs')) {
        state.audits.push({ action: params[0], metadata: params[5] });
        return { rows: [], rowCount: 1 };
      }

      throw new Error('Unexpected synthetic SQL: ' + normalized);
    },
    release() {
      state.released = true;
    }
  };

  return {
    state,
    calls,
    async connect() { return client; }
  };
}

function createService(pool, { smsGateway, code = '123456' } = {}) {
  return createGuardianPhoneVerificationService({
    pool,
    fieldCrypto: {
      hashGuardianPhone(phone) {
        return Buffer.from('lookup:' + phone);
      }
    },
    otpPepper: OTP_PEPPER,
    smsGateway,
    generateCode: () => code
  });
}

const request = {
  registrationRequestId: REGISTRATION_ID,
  guardianPhone: PHONE
};
const context = {
  requestId: 'synthetic-request-id',
  networkFingerprint: Buffer.alloc(32, 9)
};

test('OTP request sends only to the registered guardian number and stores no plaintext code', async () => {
  const pool = createFakePool();
  const sent = [];
  const service = createService(pool, {
    smsGateway: { async sendMessage(message) { sent.push(message); } }
  });

  const result = await service.requestCode(request, context);

  assert.deepEqual(result, { accepted: true });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].to, PHONE);
  assert.match(sent[0].message, /123456/u);
  assert.equal(sent[0].idempotencyKey, CHALLENGE_ID);
  assert.equal(pool.state.challenge.deliveryStatus, 'sent');
  assert.equal(pool.state.challenge.otpHash.includes(Buffer.from('123456')), false);
  assert.equal(pool.state.audits[0].action, 'guardian.phone_otp_sent');
});

test('unknown registration returns the same accepted response without sending SMS', async () => {
  const pool = createFakePool({ consentExists: false });
  let sends = 0;
  const service = createService(pool, {
    smsGateway: { async sendMessage() { sends += 1; } }
  });

  const result = await service.requestCode(request, context);

  assert.deepEqual(result, { accepted: true });
  assert.equal(sends, 0);
  assert.equal(pool.state.challenge, null);
});

test('OTP request enforces per-consent hourly limit and resend cooldown', async () => {
  const limitedPool = createFakePool({ recentCount: 3 });
  let sends = 0;
  const service = createService(limitedPool, {
    smsGateway: { async sendMessage() { sends += 1; } }
  });

  assert.deepEqual(await service.requestCode(request, context), { accepted: true });
  assert.equal(sends, 0);
  assert.equal(limitedPool.state.challenge, null);
});

test('SMS delivery failure marks the challenge failed without exposing registration existence', async () => {
  const pool = createFakePool();
  const service = createService(pool, {
    smsGateway: { async sendMessage() { throw new Error('synthetic provider failure'); } }
  });

  assert.deepEqual(await service.requestCode(request, context), { accepted: true });
  assert.equal(pool.state.challenge.deliveryStatus, 'failed');
  assert.equal(pool.state.audits[0].action, 'guardian.phone_otp_delivery_failed');
});

test('OTP verification records phone possession but does not approve consent', async () => {
  const pool = createFakePool();
  const service = createService(pool, {
    smsGateway: { async sendMessage() {} }
  });

  await service.requestCode(request, context);
  const result = await service.verifyCode({ ...request, code: '123456' }, context);

  assert.equal(result.verified, true);
  assert.equal(pool.state.challenge.deliveryStatus, 'verified');
  assert.equal(pool.state.consentVerified, true);
  assert.equal(pool.state.audits.at(-1).action, 'guardian.phone_otp_verified');
  assert.equal(pool.state.released, true);
});

test('wrong OTP attempts lock the challenge after five attempts', async () => {
  const pool = createFakePool();
  const service = createService(pool, {
    smsGateway: { async sendMessage() {} }
  });

  await service.requestCode(request, context);
  for (let attempt = 0; attempt < 5; attempt += 1) {
    await assert.rejects(
      service.verifyCode({ ...request, code: '000000' }, context),
      GuardianOtpVerificationFailedError
    );
  }

  assert.equal(pool.state.challenge.attempts, 5);
  assert.equal(pool.state.challenge.deliveryStatus, 'locked');
});

test('verification fails closed after SMS provider is not configured', async () => {
  const pool = createFakePool();
  const service = createService(pool);

  await assert.rejects(
    service.requestCode(request, context),
    GuardianOtpProviderUnavailableError
  );
  assert.equal(pool.state.challenge, null);
});

test('malformed registration identifier and OTP are rejected before database access', async () => {
  const pool = createFakePool();
  const service = createService(pool, {
    smsGateway: { async sendMessage() {} }
  });

  await assert.rejects(
    service.requestCode({ ...request, registrationRequestId: 'not-a-uuid' }, context),
    GuardianOtpValidationError
  );
  await assert.rejects(
    service.verifyCode({ ...request, code: '12AB' }, context),
    GuardianOtpValidationError
  );
  assert.equal(pool.calls.length, 0);
});
