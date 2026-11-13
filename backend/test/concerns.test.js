import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ConcernAccessError,
  ConcernValidationError,
  createConcernService,
  validateConcern
} from '../src/domain/concerns.js';

const actorId = '00000000-0000-4000-8000-000000000011';
const concernId = '00000000-0000-4000-8000-000000000012';

const validInput = () => ({
  theme: 'Education access',
  title: 'Improve access to reading materials',
  description: 'Our community library has too few age-appropriate books for learners.'
});

function createFakePool({ role = 'public_child', status = 'active', consent = true, failAudit = false } = {}) {
  const calls = [];
  let released = false;

  return {
    calls,
    get released() { return released; },
    async connect() {
      return {
        async query(sql, params = []) {
          calls.push({ sql, params });
          if (failAudit && sql.includes('INSERT INTO audit_logs')) {
            throw new Error('synthetic audit failure');
          }
          if (sql.includes('SELECT') && sql.includes('FROM users u')) {
            return {
              rows: [{
                role,
                status,
                guardian_consent_approved: consent,
                county: 'Mombasa',
                sub_county: 'Nyali',
                ward: 'Kongowea'
              }]
            };
          }
          if (sql.includes('INSERT INTO concerns')) {
            return {
              rows: [{
                id: concernId,
                status: 'submitted',
                created_at: '2026-11-12T12:00:00.000Z'
              }]
            };
          }
          if (sql.includes('SELECT') && sql.includes('FROM concerns')) {
            return {
              rows: [{
                id: concernId,
                theme_ciphertext: Buffer.from('encrypted:Education access'),
                title_ciphertext: Buffer.from('encrypted:Improve access to reading materials'),
                description_ciphertext: Buffer.from('encrypted:Our community library has too few age-appropriate books for learners.'),
                status: 'submitted',
                created_at: '2026-11-12T12:00:00.000Z',
                updated_at: '2026-11-12T12:00:00.000Z'
              }]
            };
          }
          return { rows: [], rowCount: 1 };
        },
        release() { released = true; }
      };
    }
  };
}

const fieldCrypto = {
  encryptField(value) { return Buffer.from(`encrypted:${value}`, 'utf8'); },
  decryptField(value) {
    const text = Buffer.from(value).toString('utf8');
    if (!text.startsWith('encrypted:')) throw new Error('synthetic decrypt failure');
    return text.slice('encrypted:'.length);
  }
};

test('validates concern text and normalises safe whitespace', () => {
  const result = validateConcern({
    ...validInput(),
    description: '  Our library\r\n\r\nneeds more books.  '
  });
  assert.equal(result.description, 'Our library\n\nneeds more books.');
});

test('rejects unsupported identity, location and publication fields', () => {
  for (const extra of [
    { guardianPhone: '0712345678' },
    { county: 'Mombasa' },
    { submittedBy: actorId },
    { isPublic: true },
    { status: 'responded' }
  ]) {
    assert.throws(
      () => validateConcern({ ...validInput(), ...extra }),
      error => error instanceof ConcernValidationError && error.fields.includes('request')
    );
  }
});

test('rejects email addresses, phone numbers and URLs in child submissions', () => {
  for (const description of [
    'Please contact me at child@example.test about this issue.',
    'My phone number is 0712345678 and I need help.',
    'More details are at https://example.test/private'
  ]) {
    assert.throws(
      () => validateConcern({ ...validInput(), description }),
      error => error instanceof ConcernValidationError && error.fields.includes('description')
    );
  }
});

test('rejects malformed or oversized concern content', () => {
  assert.throws(
    () => validateConcern({ ...validInput(), title: 'Hi' }),
    ConcernValidationError
  );
  assert.throws(
    () => validateConcern({ ...validInput(), description: 'x'.repeat(4001) }),
    ConcernValidationError
  );
});

test('creates an encrypted, private concern and writes a content-minimised audit event', async () => {
  const pool = createFakePool();
  const service = createConcernService({ pool, fieldCrypto });

  const result = await service.submitConcern(validInput(), {
    actorUserId: actorId,
    requestId: 'synthetic-request-001',
    networkFingerprint: Buffer.from('synthetic-network-fingerprint')
  });

  assert.equal(result.id, concernId);
  assert.equal(result.status, 'submitted');
  assert.equal(result.title, validInput().title);
  assert.equal(pool.released, true);

  const insert = pool.calls.find(call => call.sql.includes('INSERT INTO concerns'));
  const audit = pool.calls.find(call => call.sql.includes('INSERT INTO audit_logs'));
  assert.ok(insert);
  assert.ok(audit);
  assert.match(insert.sql, /theme_ciphertext,\s*title_ciphertext,\s*description_ciphertext,\s*county,\s*sub_county,\s*ward,\s*is_public/iu);
  assert.match(insert.sql, /VALUES \(\$1, \$2, \$3, \$4, \$5, \$6, \$7, false\)/u);
  assert.deepEqual(insert.params, [
    actorId,
    Buffer.from(\`encrypted:\${validInput().theme}\`),
    Buffer.from(\`encrypted:\${validInput().title}\`),
    Buffer.from(\`encrypted:\${validInput().description}\`),
    'Mombasa',
    'Nyali',
    'Kongowea'
  ]);
  assert.equal(audit.params[4], JSON.stringify({
    visibility: 'private',
    contentEncrypted: true
  }));
  assert.ok(!audit.params[4].includes('reading materials'));
  assert.ok(pool.calls.some(call => call.sql === 'COMMIT'));
});

test('lists only the authenticated child own encrypted concern records', async () => {
  const pool = createFakePool();
  const service = createConcernService({ pool, fieldCrypto });
  const rows = await service.listOwnConcerns({
    actorUserId: actorId,
    requestId: 'synthetic-request-002'
  });

  const select = pool.calls.find(call => call.sql.includes('FROM concerns'));
  assert.deepEqual(select.params, [actorId]);
  assert.match(select.sql, /WHERE submitted_by = \$1/u);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].description, validInput().description);
  assert.ok(pool.calls.some(call => call.sql.includes('concern.owner_listed')));
});

test('rejects suspended, unconsented and non-child accounts before writing', async () => {
  for (const options of [
    { status: 'suspended' },
    { consent: false },
    { role: 'stakeholder' },
    { role: 'coordinator' }
  ]) {
    const pool = createFakePool(options);
    const service = createConcernService({ pool, fieldCrypto });
    await assert.rejects(
      service.submitConcern(validInput(), { actorUserId: actorId }),
      ConcernAccessError
    );
    assert.ok(!pool.calls.some(call => call.sql.includes('INSERT INTO concerns')));
    assert.ok(pool.calls.some(call => call.sql === 'ROLLBACK'));
  }
});

test('rolls back a concern if the audit write fails', async () => {
  const pool = createFakePool({ failAudit: true });
  const service = createConcernService({ pool, fieldCrypto });
  await assert.rejects(
    service.submitConcern(validInput(), { actorUserId: actorId }),
    /synthetic audit failure/u
  );
  assert.ok(pool.calls.some(call => call.sql === 'ROLLBACK'));
  assert.equal(pool.released, true);
});

test('rejects requests without a server-authenticated child identity', async () => {
  const pool = createFakePool();
  const service = createConcernService({ pool, fieldCrypto });
  await assert.rejects(service.submitConcern(validInput()), ConcernAccessError);
  assert.equal(pool.calls.length, 0);
});
