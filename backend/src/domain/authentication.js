import { createHash, randomBytes } from 'node:crypto';
import { normalizeKenyanPhone } from '../security/phone.js';

export class AuthenticationValidationError extends Error {
  constructor(fields) {
    super('Sign-in details are invalid');
    this.name = 'AuthenticationValidationError';
    this.fields = fields;
  }
}

export class AuthenticationFailedError extends Error {
  constructor() {
    super('Authentication could not be completed');
    this.name = 'AuthenticationFailedError';
  }
}

const CHILD_ROLES = new Set(['public_child', 'delegate']);

function validateLogin(payload) {
  const input = payload && typeof payload === 'object' && !Array.isArray(payload)
    ? payload
    : {};
  const fields = [];
  const mode = input.mode;

  if (!['child', 'adult'].includes(mode)) fields.push('mode');

  const secret = typeof input.secret === 'string' ? input.secret : '';
  if (
    secret.length < 8 ||
    secret.length > 256 ||
    /[\u0000-\u001f\u007f]/u.test(secret)
  ) {
    fields.push('secret');
  }

  let identifier = '';
  if (mode === 'child') {
    try {
      identifier = normalizeKenyanPhone(input.identifier);
    } catch {
      fields.push('identifier');
    }
    const words = secret.trim().split(/\s+/u).filter(Boolean);
    if (secret.trim().length < 12 || words.length < 3) fields.push('secret');
  } else if (mode === 'adult') {
    identifier = typeof input.identifier === 'string'
      ? input.identifier.trim().toLowerCase()
      : '';
    if (
      identifier.length > 254 ||
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(identifier)
    ) {
      fields.push('identifier');
    }
  }

  if (fields.length) {
    throw new AuthenticationValidationError([...new Set(fields)]);
  }

  return Object.freeze({ mode, identifier, secret });
}

function safeDigest(value) {
  return createHash('sha256').update(value, 'utf8').digest();
}

async function verifySafely(verifySecret, encodedHash, secret) {
  if (typeof encodedHash !== 'string' || !encodedHash.startsWith('$argon2')) return false;
  try {
    return await verifySecret(encodedHash, secret);
  } catch {
    return false;
  }
}

export function createAuthenticationService({
  pool,
  fieldCrypto,
  verifySecret,
  dummyCredentialHash
}) {
  if (
    !pool ||
    !fieldCrypto ||
    typeof verifySecret !== 'function' ||
    typeof dummyCredentialHash !== 'string' ||
    !dummyCredentialHash.startsWith('$argon2')
  ) {
    throw new TypeError('Authentication dependencies are incomplete');
  }

  async function findChildAccount(identifierHash, secret) {
    const result = await pool.query(
      `SELECT
        u.id,
        u.role::text AS role,
        u.status::text AS status,
        u.passphrase_hash AS credential_hash,
        EXISTS (
          SELECT 1
          FROM guardian_consents gc
          WHERE gc.child_user_id = u.id
            AND gc.status = 'approved'
            AND gc.withdrawn_at IS NULL
        ) AS guardian_consent_approved
      FROM users u
      WHERE u.role IN ('public_child', 'delegate')
        AND u.guardian_phone_lookup_hash = $1
      ORDER BY u.created_at DESC
      LIMIT 11`,
      [identifierHash]
    );

    const candidates = result.rows || [];
    if (candidates.length === 0 || candidates.length > 10) {
      await verifySafely(verifySecret, dummyCredentialHash, secret);
      return null;
    }

    const matches = [];
    for (const candidate of candidates) {
      if (await verifySafely(verifySecret, candidate.credential_hash, secret)) {
        matches.push(candidate);
      }
    }

    // A shared guardian phone may identify multiple children. The passphrase
    // must select exactly one child; ambiguous matches fail closed.
    if (matches.length !== 1) return null;

    const account = matches[0];
    if (
      account.status !== 'active' ||
      !CHILD_ROLES.has(account.role) ||
      account.guardian_consent_approved !== true
    ) {
      return null;
    }
    return account;
  }

  async function findAdultAccount(email, secret) {
    const result = await pool.query(
      `SELECT
        id,
        role::text AS role,
        status::text AS status,
        password_hash AS credential_hash
      FROM users
      WHERE email_normalized = $1
        AND role NOT IN ('public_child', 'delegate')
      LIMIT 1`,
      [email]
    );

    const account = result.rows?.[0];
    if (!account) {
      await verifySafely(verifySecret, dummyCredentialHash, secret);
      return null;
    }

    const valid = await verifySafely(verifySecret, account.credential_hash, secret);
    if (!valid || account.status !== 'active') return null;
    return account;
  }

  async function createSession(account, { requestId, networkFingerprint, mode } = {}) {
    const sessionToken = randomBytes(32).toString('base64url');
    const csrfToken = randomBytes(32).toString('base64url');
    const tokenHash = safeDigest(sessionToken);
    const csrfTokenHash = safeDigest(csrfToken);
    const client = await pool.connect();
    let committed = false;

    try {
      await client.query('BEGIN');

      const sessionResult = await client.query(
        `INSERT INTO auth_sessions (
          user_id,
          token_hash,
          csrf_token_hash,
          expires_at,
          ip_fingerprint
        ) VALUES (
          $1, $2, $3, now() + interval '8 hours', $4
        )
        RETURNING id, expires_at`,
        [account.id, tokenHash, csrfTokenHash, networkFingerprint || null]
      );

      const session = sessionResult.rows?.[0];
      if (!session?.id) throw new Error('Session insert returned no identifier');

      await client.query(
        'UPDATE users SET last_login_at = now() WHERE id = $1',
        [account.id]
      );

      await client.query(
        `INSERT INTO audit_logs (
          actor_user_id,
          action,
          entity_type,
          entity_id,
          request_id,
          ip_fingerprint,
          metadata
        ) VALUES (
          $1,
          'auth.login_success',
          'auth_session',
          $2,
          $3,
          $4,
          $5::jsonb
        )`,
        [
          account.id,
          session.id,
          requestId || null,
          networkFingerprint || null,
          JSON.stringify({ role: account.role, mode })
        ]
      );

      await client.query('COMMIT');
      committed = true;

      return Object.freeze({
        userId: account.id,
        role: account.role,
        sessionId: session.id,
        sessionToken,
        csrfToken,
        expiresAt: session.expires_at
      });
    } catch (error) {
      if (!committed) {
        try {
          await client.query('ROLLBACK');
        } catch {
          // Keep the original error.
        }
      }
      throw error;
    } finally {
      client.release();
    }
  }

  async function authenticate(payload, context = {}) {
    const input = validateLogin(payload);
    let account = null;

    if (input.mode === 'child') {
      const identifierHash = fieldCrypto.hashGuardianPhone(input.identifier);
      account = await findChildAccount(identifierHash, input.secret);
    } else {
      account = await findAdultAccount(input.identifier, input.secret);
    }

    if (!account) throw new AuthenticationFailedError();

    return createSession(account, { ...context, mode: input.mode });
  }

  async function revokeSession({ sessionId, userId, requestId, networkFingerprint }) {
    const client = await pool.connect();
    let committed = false;

    try {
      await client.query('BEGIN');
      const result = await client.query(
        `UPDATE auth_sessions
         SET revoked_at = now()
         WHERE id = $1
           AND user_id = $2
           AND revoked_at IS NULL`,
        [sessionId, userId]
      );

      if (result.rowCount !== 1) {
        throw new AuthenticationFailedError();
      }

      await client.query(
        `INSERT INTO audit_logs (
          actor_user_id,
          action,
          entity_type,
          entity_id,
          request_id,
          ip_fingerprint,
          metadata
        ) VALUES (
          $1, 'auth.logout', 'auth_session', $2, $3, $4, '{}'::jsonb
        )`,
        [userId, sessionId, requestId || null, networkFingerprint || null]
      );

      await client.query('COMMIT');
      committed = true;
    } catch (error) {
      if (!committed) {
        try {
          await client.query('ROLLBACK');
        } catch {
          // Keep the original error.
        }
      }
      throw error;
    } finally {
      client.release();
    }
  }

  return Object.freeze({ authenticate, revokeSession });
}
