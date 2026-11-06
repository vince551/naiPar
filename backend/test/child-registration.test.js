import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createChildRegistrationService,
  RegistrationValidationError,
  validateChildRegistration
} from '../src/domain/child-registration.js';
import { normalizeKenyanPhone } from '../src/security/phone.js';
import { createFieldCrypto } from '../src/security/field-crypto.js';
import { requireAuthenticated, requireRoles } from '../src/security/authorization.js';

const validInput = () => ({
  fullName: 'Sample Child',
  age: 14,
  school: 'Sample School',
  county: 'Mombasa',
  ward: 'Nyali',
  guardianName: 'Sample Guardian',
  guardianPhone: '0712 345 678',
  passphrase: 'sample mango river'
});

function createFakePool({ failOnAudit = false } = {}) {
  const calls = [];
  let released = false;
  let connections = 0;

  return {
    calls,
    get released() { return released; },
    get connections() { return connections; },
    async connect() {
      connections += 1;
      return {
        async query(sql, params = []) {
          calls.push({ sql, params });
          if (failOnAudit && sql.includes('INSERT INTO audit_logs')) {
            throw new Error('synthetic database failure');
          }
          if (sql.includes('INSERT INTO users')) {
            return { rows: [{ id: '00000000-0000-4000-8000-000000000001' }] };
          }
          if (sql.includes('INSERT INTO guardian_consents')) {
            return { rows: [{ id: '00000000-0000-4000-8000-000000000002' }] };
          }
          return { rows: [], rowCount: 1 };
        },
        release() { released = true; }
      };
    }
  };
}

function createFakeCrypto() {
  return {
    encryptField(value) {
      return Buffer.from(`encrypted:${value}`, 'utf8');
    },
    hashGuardianPhone(value) {
      return Buffer.from(`lookup-hash:${value}`, 'utf8');
    }
  };
}

function createResponse() {
  return {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; }
  };
}


test('encrypts identity fields with authenticated encryption and detects tampering', () => {
  const crypto = createFieldCrypto({
    encryptionKey: Buffer.alloc(32, 7),
    guardianPhoneLookupPepper: 'lookup-pepper-for-tests-32-bytes',
    auditFingerprintPepper: 'audit-pepper-for-tests-32-bytes!'
  });

  const encrypted = crypto.encryptField('Synthetic Guardian');
  assert.notEqual(encrypted.toString('utf8'), 'Synthetic Guardian');
  assert.equal(crypto.decryptField(encrypted), 'Synthetic Guardian');
  assert.deepEqual(
    crypto.hashGuardianPhone('+254712345678'),
    crypto.hashGuardianPhone('+254712345678')
  );

  const tampered = Buffer.from(encrypted);
  tampered[tampered.length - 1] ^= 1;
  assert.throws(() => crypto.decryptField(tampered));
});

test('normalises Kenyan mobile formats to E.164', () => {
  assert.equal(normalizeKenyanPhone('0712 345 678'), '+254712345678');
  assert.equal(normalizeKenyanPhone('254712345678'), '+254712345678');
  assert.equal(normalizeKenyanPhone('+254712345678'), '+254712345678');
  assert.throws(() => normalizeKenyanPhone('12345'), /valid Kenyan mobile/);
});

test('validates child registration and never accepts adult age as child', () => {
  const result = validateChildRegistration(validInput());
  assert.equal(result.guardianPhone, '+254712345678');
  assert.equal(result.age, 14);

  assert.throws(
    () => validateChildRegistration({ ...validInput(), age: 18 }),
    error => error instanceof RegistrationValidationError && error.fields.includes('age')
  );
});

test('rejects short or non-three-word passphrases', () => {
  assert.throws(
    () => validateChildRegistration({ ...validInput(), passphrase: 'short phrase' }),
    error => error instanceof RegistrationValidationError && error.fields.includes('passphrase')
  );
});

test('creates pending child and guardian-consent records in one transaction', async () => {
  const pool = createFakePool();
  let hashedSecret = '';
  const service = createChildRegistrationService({
    pool,
    fieldCrypto: createFakeCrypto(),
    hashPassphrase: async secret => {
      hashedSecret = secret;
      return 'synthetic-argon2id-hash';
    },
    consentNoticeVersion: 'test-consent-v1'
  });

  const result = await service(validInput(), {
    requestId: 'synthetic-request-id',
    networkFingerprint: Buffer.from('synthetic-fingerprint')
  });

  assert.equal(result.accountStatus, 'pending');
  assert.equal(result.guardianConsentStatus, 'pending');
  assert.equal(hashedSecret, 'sample mango river');
  assert.equal(pool.released, true);

  const userInsert = pool.calls.find(call => call.sql.includes('INSERT INTO users'));
  const consentInsert = pool.calls.find(call => call.sql.includes('INSERT INTO guardian_consents'));
  const auditInsert = pool.calls.find(call => call.sql.includes('INSERT INTO audit_logs'));

  assert.ok(userInsert);
  assert.ok(consentInsert);
  assert.ok(auditInsert);
  assert.equal(userInsert.params[0].toString(), 'encrypted:Sample Child');
  assert.equal(userInsert.params[1], 14);
  assert.equal(userInsert.params[2].toString(), 'encrypted:Sample School');
  assert.equal(userInsert.params[6].toString(), 'encrypted:+254712345678');
  assert.equal(userInsert.params[7], 'synthetic-argon2id-hash');
  assert.equal(consentInsert.params[0], result.registrationRequestId);
  assert.equal(consentInsert.params[4], 'test-consent-v1');
  assert.ok(!userInsert.params.includes('Sample Child'));
  assert.ok(!userInsert.params.includes('sample mango river'));
  assert.ok(pool.calls.some(call => call.sql === 'COMMIT'));
});

test('invalid registration is rejected before opening a database connection', async () => {
  const pool = createFakePool();
  const service = createChildRegistrationService({
    pool,
    fieldCrypto: createFakeCrypto(),
    hashPassphrase: async () => 'synthetic-hash',
    consentNoticeVersion: 'test-consent-v1'
  });

  await assert.rejects(
    service({ ...validInput(), guardianPhone: 'not-a-phone' }),
    RegistrationValidationError
  );
  assert.equal(pool.connections, 0);
});

test('rolls back the whole registration if audit insertion fails', async () => {
  const pool = createFakePool({ failOnAudit: true });
  const service = createChildRegistrationService({
    pool,
    fieldCrypto: createFakeCrypto(),
    hashPassphrase: async () => 'synthetic-hash',
    consentNoticeVersion: 'test-consent-v1'
  });

  await assert.rejects(service(validInput()), /synthetic database failure/);
  assert.ok(pool.calls.some(call => call.sql === 'ROLLBACK'));
  assert.equal(pool.released, true);
});

test('role middleware denies public child access to coordinator-only operations', () => {
  const req = {
    auth: {
      userId: 'synthetic-user',
      role: 'public_child',
      status: 'active',
      guardianConsentStatus: 'approved'
    }
  };
  const res = createResponse();
  let continued = false;

  requireRoles('coordinator')(req, res, () => { continued = true; });

  assert.equal(res.statusCode, 403);
  assert.equal(res.body.error.code, 'INSUFFICIENT_ROLE');
  assert.equal(continued, false);
});

test('child access is blocked until guardian consent is approved', () => {
  const req = {
    auth: {
      userId: 'synthetic-user',
      role: 'delegate',
      status: 'active',
      guardianConsentStatus: 'pending'
    }
  };
  const res = createResponse();
  let continued = false;

  requireAuthenticated(req, res, () => { continued = true; });

  assert.equal(res.statusCode, 403);
  assert.equal(res.body.error.code, 'GUARDIAN_CONSENT_REQUIRED');
  assert.equal(continued, false);
});

test('active coordinator is allowed through a coordinator-only guard', () => {
  const req = {
    auth: {
      userId: 'synthetic-coordinator',
      role: 'coordinator',
      status: 'active'
    }
  };
  const res = createResponse();
  let continued = false;

  requireRoles('coordinator')(req, res, () => { continued = true; });

  assert.equal(continued, true);
});
