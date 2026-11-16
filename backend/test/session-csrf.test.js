import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { issueCsrfToken } from '../src/security/session.js';

const sessionId = '00000000-0000-4000-8000-000000000041';

test('CSRF refresh rotates the stored digest and returns only the raw token once', async () => {
  let call;
  const pool = {
    async query(sql, params) {
      call = { sql, params };
      return { rowCount: 1, rows: [{ id: sessionId }] };
    }
  };

  const token = await issueCsrfToken(pool, sessionId);
  assert.match(token, /^[A-Za-z0-9_-]{43}$/u);
  assert.match(call.sql, /revoked_at IS NULL/u);
  assert.match(call.sql, /expires_at > now\(\)/u);
  assert.match(call.sql, /u\.status = 'active'/u);
  assert.equal(call.params[1], sessionId);
  assert.deepEqual(
    call.params[0],
    createHash('sha256').update(token, 'utf8').digest()
  );
  assert.notEqual(call.params[0].toString('base64url'), token);
});

test('CSRF refresh fails closed when the session is revoked or expired', async () => {
  const pool = { async query() { return { rowCount: 0, rows: [] }; } };
  assert.equal(await issueCsrfToken(pool, sessionId), null);
});

test('CSRF refresh rejects a missing session identifier', async () => {
  await assert.rejects(
    issueCsrfToken({ query: async () => ({ rowCount: 1 }) }, ''),
    TypeError
  );
});
