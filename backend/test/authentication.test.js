import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import {
  createAuthenticationService,
  AuthenticationFailedError,
  AuthenticationValidationError
} from '../src/domain/authentication.js';
import {
  SESSION_COOKIE_NAME,
  clearSessionCookie,
  createSessionResolver,
  readSessionCookie,
  requireCsrf,
  requireSession,
  serializeSessionCookie
} from '../src/security/session.js';

const DUMMY_HASH = '$argon2id$synthetic-dummy-hash';
const CHILD_HASH = '$argon2id$synthetic-child-hash';
const ADULT_HASH = '$argon2id$synthetic-adult-hash';

function createPool({
  childRows = [],
  adultRow = null,
  failOnAudit = false,
  lockedStatusOverride = null,
  lockedConsentApprovedOverride = null,
  lockedCredentialHashOverride = null
} = {}) {
  const queries = [];
  const clientQueries = [];
  let connects = 0;
  let released = false;

  const client = {
    async query(sql, params = []) {
      clientQueries.push({ sql, params });
      if (failOnAudit && sql.includes('INSERT INTO audit_logs')) {
        throw new Error('synthetic audit failure');
      }
      if (sql.includes('FROM users') && sql.includes('FOR UPDATE')) {
        const account = [...childRows, ...(adultRow ? [adultRow] : [])]
          .find(candidate => candidate.id === params[0]);
        if (!account) return { rows: [], rowCount: 0 };
        const isChild = ['public_child', 'delegate'].includes(account.role);
        return {
          rows: [{
            id: account.id,
            role: account.role,
            status: lockedStatusOverride || account.status,
            passphrase_hash: isChild ? (lockedCredentialHashOverride || account.credential_hash) : null,
            password_hash: isChild ? null : (lockedCredentialHashOverride || account.credential_hash)
          }],
          rowCount: 1
        };
      }
      if (sql.includes('FROM guardian_consents')) {
        const child = childRows.find(candidate => candidate.id === params[0]);
        const approved = lockedConsentApprovedOverride === null
          ? child?.guardian_consent_approved
          : lockedConsentApprovedOverride;
        return { rows: approved ? [{ id: 'synthetic-consent' }] : [], rowCount: approved ? 1 : 0 };
      }
      if (sql.includes('INSERT INTO auth_sessions')) {
        return {
          rows: [{
            id: '00000000-0000-4000-8000-000000000101',
            expires_at: '2026-11-09T23:00:00.000Z'
          }],
          rowCount: 1
        };
      }
      if (sql.startsWith('UPDATE auth_sessions')) return { rows: [], rowCount: 1 };
      return { rows: [], rowCount: 1 };
    },
    release() { released = true; }
  };

  return {
    queries,
    clientQueries,
    get connects() { return connects; },
    get released() { return released; },
    async query(sql, params = []) {
      queries.push({ sql, params });
      if (sql.includes('guardian_phone_lookup_hash = $1')) {
        return { rows: childRows, rowCount: childRows.length };
      }
      if (sql.includes('WHERE email_normalized = $1')) {
        return { rows: adultRow ? [adultRow] : [], rowCount: adultRow ? 1 : 0 };
      }
      return { rows: [], rowCount: 1 };
    },
    async connect() {
      connects += 1;
      return client;
    }
  };
}

function createService(pool, verifySecret) {
  return createAuthenticationService({
    pool,
    fieldCrypto: {
      hashGuardianPhone: value => Buffer.from(`synthetic-lookup:${value}`)
    },
    verifySecret,
    dummyCredentialHash: DUMMY_HASH
  });
}

test('child login creates a hashed session only for an active account with approved consent', async () => {
  const pool = createPool({
    childRows: [{
      id: '00000000-0000-4000-8000-000000000001',
      role: 'public_child',
      status: 'active',
      credential_hash: CHILD_HASH,
      guardian_consent_approved: true
    }]
  });
  const verified = [];
  const service = createService(pool, async (hash, secret) => {
    verified.push({ hash, secret });
    return hash === CHILD_HASH && secret === 'sample mango river';
  });

  const result = await service.authenticate({
    mode: 'child',
    identifier: '0712 345 678',
    secret: 'sample mango river'
  }, {
    requestId: 'synthetic-request',
    networkFingerprint: Buffer.from('synthetic-network-fingerprint')
  });

  assert.equal(result.role, 'public_child');
  assert.equal(result.userId, '00000000-0000-4000-8000-000000000001');
  assert.match(result.sessionToken, /^[A-Za-z0-9_-]{43}$/u);
  assert.match(result.csrfToken, /^[A-Za-z0-9_-]{43}$/u);
  assert.equal(pool.connects, 1);
  assert.ok(verified.some(entry => entry.hash === CHILD_HASH));

  const sessionInsert = pool.clientQueries.find(entry => entry.sql.includes('INSERT INTO auth_sessions'));
  assert.ok(sessionInsert);
  assert.deepEqual(
    sessionInsert.params[1],
    createHash('sha256').update(result.sessionToken).digest()
  );
  assert.deepEqual(
    sessionInsert.params[2],
    createHash('sha256').update(result.csrfToken).digest()
  );
  assert.ok(!sessionInsert.params.includes(result.sessionToken));
  assert.ok(!sessionInsert.params.includes(result.csrfToken));
  assert.ok(pool.clientQueries.some(entry => entry.sql.includes('INSERT INTO auth_attempts') && entry.params[1] === true));
  assert.ok(pool.clientQueries.some(entry => entry.sql === 'COMMIT'));
  assert.equal(pool.released, true);
});

test('child login fails closed while guardian consent is pending', async () => {
  const pool = createPool({
    childRows: [{
      id: 'synthetic-child',
      role: 'delegate',
      status: 'active',
      credential_hash: CHILD_HASH,
      guardian_consent_approved: false
    }]
  });
  const service = createService(pool, async hash => hash === CHILD_HASH);

  await assert.rejects(
    service.authenticate({
      mode: 'child',
      identifier: '+254712345678',
      secret: 'sample mango river'
    }),
    AuthenticationFailedError
  );
  assert.equal(pool.connects, 0);
});

test('child login rejects ambiguous matches for siblings sharing a guardian phone', async () => {
  const pool = createPool({
    childRows: [1, 2].map(index => ({
      id: `synthetic-child-${index}`,
      role: 'public_child',
      status: 'active',
      credential_hash: CHILD_HASH,
      guardian_consent_approved: true
    }))
  });
  const service = createService(pool, async hash => hash === CHILD_HASH);

  await assert.rejects(
    service.authenticate({
      mode: 'child',
      identifier: '0712345678',
      secret: 'sample mango river'
    }),
    AuthenticationFailedError
  );
  assert.equal(pool.connects, 0);
});

test('adult login normalises email and accepts only an active adult account', async () => {
  const pool = createPool({
    adultRow: {
      id: 'synthetic-official',
      role: 'coordinator',
      status: 'active',
      credential_hash: ADULT_HASH
    }
  });
  const service = createService(pool, async (hash, secret) =>
    hash === ADULT_HASH && secret === 'synthetic adult password'
  );

  const result = await service.authenticate({
    mode: 'adult',
    identifier: ' Coordinator@Example.org ',
    secret: 'synthetic adult password'
  });

  assert.equal(result.role, 'coordinator');
  assert.equal(
    pool.queries[0].params[0],
    'coordinator@example.org'
  );
});

test('unknown adult account performs dummy Argon2 verification and returns generic failure', async () => {
  const pool = createPool();
  const verified = [];
  const service = createService(pool, async (hash, secret) => {
    verified.push({ hash, secret });
    return false;
  });

  await assert.rejects(
    service.authenticate({
      mode: 'adult',
      identifier: 'unknown@example.org',
      secret: 'synthetic adult password'
    }),
    AuthenticationFailedError
  );
  assert.deepEqual(verified, [{
    hash: DUMMY_HASH,
    secret: 'synthetic adult password'
  }]);
  assert.equal(pool.connects, 0);
  const failedAttempt = pool.queries.find(entry => entry.sql.includes('INSERT INTO auth_attempts'));
  assert.ok(failedAttempt);
  assert.equal(failedAttempt.params[1], false);
  assert.ok(!failedAttempt.params.includes('unknown@example.org'));
});

test('invalid login input is rejected before database access', async () => {
  const pool = createPool();
  const service = createService(pool, async () => false);

  await assert.rejects(
    service.authenticate({
      mode: 'child',
      identifier: 'not-a-phone',
      secret: 'short'
    }),
    AuthenticationValidationError
  );
  assert.equal(pool.queries.length, 0);
});

test('session creation rolls back when audit insertion fails', async () => {
  const pool = createPool({
    adultRow: {
      id: 'synthetic-official',
      role: 'clerk',
      status: 'active',
      credential_hash: ADULT_HASH
    },
    failOnAudit: true
  });
  const service = createService(pool, async hash => hash === ADULT_HASH);

  await assert.rejects(
    service.authenticate({
      mode: 'adult',
      identifier: 'clerk@example.org',
      secret: 'synthetic adult password'
    }),
    /synthetic audit failure/
  );
  assert.ok(pool.clientQueries.some(entry => entry.sql === 'ROLLBACK'));
  assert.equal(pool.released, true);
});

test('session cookie is HttpOnly, SameSite=Lax and Secure in production', () => {
  const token = randomBytes(32).toString('base64url');
  const cookie = serializeSessionCookie(token, { secure: true });
  assert.match(cookie, new RegExp(`^${SESSION_COOKIE_NAME}=`));
  assert.match(cookie, /HttpOnly/u);
  assert.match(cookie, /SameSite=Lax/u);
  assert.match(cookie, /Secure/u);
  assert.match(clearSessionCookie({ secure: true }), /Max-Age=0/u);
});

test('session cookie parser rejects malformed and duplicate session cookies', () => {
  const token = randomBytes(32).toString('base64url');
  assert.equal(
    readSessionCookie(`other=value; ${SESSION_COOKIE_NAME}=${token}`),
    token
  );
  assert.equal(readSessionCookie(`${SESSION_COOKIE_NAME}=bad`), null);
  assert.equal(
    readSessionCookie(`${SESSION_COOKIE_NAME}=${token}; ${SESSION_COOKIE_NAME}=${token}`),
    null
  );
});

test('session resolver hashes the cookie token and builds trusted auth context', async () => {
  const token = randomBytes(32).toString('base64url');
  const tokenHash = createHash('sha256').update(token).digest();
  const calls = [];
  const pool = {
    async query(sql, params = []) {
      calls.push({ sql, params });
      if (sql.includes('FROM auth_sessions s')) {
        return {
          rows: [{
            session_id: 'synthetic-session',
            user_id: 'synthetic-delegate',
            csrf_token_hash: Buffer.alloc(32, 4),
            role: 'delegate',
            status: 'active',
            guardian_consent_status: 'approved'
          }]
        };
      }
      return { rows: [], rowCount: 1 };
    }
  };
  const resolver = createSessionResolver({ pool, secureCookies: true });
  const req = {
    headers: { cookie: `${SESSION_COOKIE_NAME}=${token}` }
  };
  const headers = {};
  const res = { setHeader(name, value) { headers[name] = value; } };
  let nextCalled = false;

  await resolver(req, res, error => {
    assert.equal(error, undefined);
    nextCalled = true;
  });

  assert.equal(nextCalled, true);
  assert.deepEqual(req.auth, {
    userId: 'synthetic-delegate',
    role: 'delegate',
    status: 'active',
    guardianConsentStatus: 'approved'
  });
  assert.equal(req.sessionId, 'synthetic-session');
  assert.deepEqual(calls[0].params[0], tokenHash);
});

test('CSRF middleware requires a matching token and session', () => {
  const token = randomBytes(32).toString('base64url');
  const hash = createHash('sha256').update(token).digest();
  const req = {
    sessionId: 'synthetic-session',
    sessionCsrfHash: hash,
    get(name) { return name === 'x-csrf-token' ? token : undefined; }
  };
  const res = {
    statusCode: 200,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; }
  };
  let continued = false;

  requireSession(req, res, () => {});
  requireCsrf(req, res, () => { continued = true; });
  assert.equal(continued, true);

  req.get = () => 'wrong-token';
  requireCsrf(req, res, () => { throw new Error('Invalid CSRF token passed'); });
  assert.equal(res.statusCode, 403);
  assert.equal(res.body.error.code, 'CSRF_VALIDATION_FAILED');
});


test('logout revokes only the matching server-side session and writes an audit event', async () => {
  const pool = createPool();
  const service = createService(pool, async () => false);

  await service.revokeSession({
    sessionId: 'synthetic-session',
    userId: 'synthetic-user',
    requestId: 'synthetic-logout-request',
    networkFingerprint: Buffer.from('synthetic-network-fingerprint')
  });

  const revoke = pool.clientQueries.find(entry => entry.sql.includes('UPDATE auth_sessions'));
  const audit = pool.clientQueries.find(entry => entry.sql.includes('auth.logout'));
  assert.ok(revoke);
  assert.deepEqual(revoke.params, ['synthetic-session', 'synthetic-user']);
  assert.ok(audit);
  assert.ok(pool.clientQueries.some(entry => entry.sql === 'COMMIT'));
  assert.equal(pool.released, true);
});

test('session middleware clears a cookie when the database account is suspended', async () => {
  const token = randomBytes(32).toString('base64url');
  const calls = [];
  const pool = {
    async query(sql, params = []) {
      calls.push({ sql, params });
      if (sql.includes('FROM auth_sessions s')) {
        return {
          rows: [{
            session_id: 'synthetic-session',
            user_id: 'synthetic-user',
            csrf_token_hash: Buffer.alloc(32, 4),
            role: 'coordinator',
            status: 'suspended',
            guardian_consent_status: 'approved'
          }]
        };
      }
      return { rows: [], rowCount: 1 };
    }
  };
  const resolver = createSessionResolver({ pool, secureCookies: true });
  const req = { headers: { cookie: `${SESSION_COOKIE_NAME}=${token}` } };
  const headers = {};
  const res = { setHeader(name, value) { headers[name] = value; } };
  let nextCalled = false;

  await resolver(req, res, () => { nextCalled = true; });

  assert.equal(nextCalled, true);
  assert.equal(req.auth, undefined);
  assert.match(headers['Set-Cookie'], /Max-Age=0/u);
  assert.ok(calls.some(entry => entry.sql.startsWith('UPDATE auth_sessions')));
});


test('session issuance rechecks account status under a row lock', async () => {
  const pool = createPool({
    adultRow: {
      id: 'synthetic-official',
      role: 'coordinator',
      status: 'active',
      credential_hash: ADULT_HASH
    },
    lockedStatusOverride: 'suspended'
  });
  const service = createService(pool, async hash => hash === ADULT_HASH);

  await assert.rejects(
    service.authenticate({
      mode: 'adult',
      identifier: 'coordinator@example.org',
      secret: 'synthetic adult password'
    }),
    AuthenticationFailedError
  );
  assert.ok(pool.clientQueries.some(entry => entry.sql.includes('FOR UPDATE')));
  assert.ok(pool.clientQueries.some(entry => entry.sql === 'ROLLBACK'));
  assert.equal(
    pool.clientQueries.some(entry => entry.sql.includes('INSERT INTO auth_sessions')),
    false
  );
});

test('session issuance rechecks guardian consent under a row lock', async () => {
  const pool = createPool({
    childRows: [{
      id: 'synthetic-child',
      role: 'delegate',
      status: 'active',
      credential_hash: CHILD_HASH,
      guardian_consent_approved: true
    }],
    lockedConsentApprovedOverride: false
  });
  const service = createService(pool, async hash => hash === CHILD_HASH);

  await assert.rejects(
    service.authenticate({
      mode: 'child',
      identifier: '0712345678',
      secret: 'sample mango river'
    }),
    AuthenticationFailedError
  );
  assert.ok(pool.clientQueries.some(entry => entry.sql.includes('FROM guardian_consents')));
  assert.ok(pool.clientQueries.some(entry => entry.sql === 'ROLLBACK'));
  assert.equal(
    pool.clientQueries.some(entry => entry.sql.includes('INSERT INTO auth_sessions')),
    false
  );
});
