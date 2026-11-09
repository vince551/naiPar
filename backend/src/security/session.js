import { createHash, timingSafeEqual } from 'node:crypto';

export const SESSION_COOKIE_NAME = 'sauti_yetu_session';
export const SESSION_TTL_SECONDS = 8 * 60 * 60;

function hashToken(token) {
  return createHash('sha256').update(token, 'utf8').digest();
}

export function readSessionCookie(cookieHeader) {
  if (typeof cookieHeader !== 'string' || cookieHeader.length > 8192) return null;

  const values = [];
  for (const part of cookieHeader.split(';')) {
    const separator = part.indexOf('=');
    if (separator < 0) continue;
    const name = part.slice(0, separator).trim();
    if (name !== SESSION_COOKIE_NAME) continue;
    values.push(part.slice(separator + 1).trim());
  }

  if (values.length !== 1) return null;
  const token = values[0];
  return /^[A-Za-z0-9_-]{43}$/u.test(token) ? token : null;
}

export function serializeSessionCookie(token, { secure = false } = {}) {
  if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{43}$/u.test(token)) {
    throw new TypeError('Session token format is invalid');
  }

  return [
    `${SESSION_COOKIE_NAME}=${token}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${SESSION_TTL_SECONDS}`,
    ...(secure ? ['Secure'] : [])
  ].join('; ');
}

export function clearSessionCookie({ secure = false } = {}) {
  return [
    `${SESSION_COOKIE_NAME}=`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    'Max-Age=0',
    'Expires=Thu, 01 Jan 1970 00:00:00 GMT',
    ...(secure ? ['Secure'] : [])
  ].join('; ');
}

export function createSessionResolver({ pool, secureCookies = false }) {
  if (!pool) throw new TypeError('A database pool is required');

  return async function resolveSession(req, res, next) {
    const token = readSessionCookie(req.headers.cookie);
    if (!token) return next();

    try {
      const tokenHash = hashToken(token);
      const result = await pool.query(
        `SELECT
          s.id AS session_id,
          s.user_id,
          s.csrf_token_hash,
          u.role::text AS role,
          u.status::text AS status,
          CASE
            WHEN u.role IN ('public_child', 'delegate') THEN
              CASE WHEN EXISTS (
                SELECT 1
                FROM guardian_consents gc
                WHERE gc.child_user_id = u.id
                  AND gc.status = 'approved'
                  AND gc.withdrawn_at IS NULL
              ) THEN 'approved' ELSE 'pending' END
            ELSE 'approved'
          END AS guardian_consent_status
        FROM auth_sessions s
        JOIN users u ON u.id = s.user_id
        WHERE s.token_hash = $1
          AND s.revoked_at IS NULL
          AND s.expires_at > now()
        LIMIT 1`,
        [tokenHash]
      );

      const row = result.rows?.[0];
      if (!row) {
        res.setHeader('Set-Cookie', clearSessionCookie({ secure: secureCookies }));
        return next();
      }

      if (row.status !== 'active') {
        await pool.query(
          'UPDATE auth_sessions SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL',
          [row.session_id]
        );
        res.setHeader('Set-Cookie', clearSessionCookie({ secure: secureCookies }));
        return next();
      }

      req.sessionId = row.session_id;
      req.sessionCsrfHash = row.csrf_token_hash;
      req.auth = Object.freeze({
        userId: row.user_id,
        role: row.role,
        status: row.status,
        guardianConsentStatus: row.guardian_consent_status
      });

      // Reduce write load: update activity at most once per five minutes.
      await pool.query(
        `UPDATE auth_sessions
         SET last_seen_at = now()
         WHERE id = $1
           AND last_seen_at < now() - interval '5 minutes'`,
        [row.session_id]
      );

      return next();
    } catch (error) {
      return next(error);
    }
  };
}

export function requireSession(req, res, next) {
  if (!req.sessionId || !req.sessionCsrfHash) {
    return res.status(401).json({
      error: { code: 'SESSION_REQUIRED', message: 'Please sign in to continue.' }
    });
  }
  return next();
}

export function requireCsrf(req, res, next) {
  const supplied = req.get('x-csrf-token');
  if (
    typeof supplied !== 'string' ||
    !/^[A-Za-z0-9_-]{43}$/u.test(supplied) ||
    !Buffer.isBuffer(req.sessionCsrfHash)
  ) {
    return res.status(403).json({
      error: { code: 'CSRF_VALIDATION_FAILED', message: 'Refresh your session and try again.' }
    });
  }

  const expectedHash = req.sessionCsrfHash;
  const suppliedHash = hashToken(supplied);
  if (
    expectedHash.length !== suppliedHash.length ||
    !timingSafeEqual(expectedHash, suppliedHash)
  ) {
    return res.status(403).json({
      error: { code: 'CSRF_VALIDATION_FAILED', message: 'Refresh your session and try again.' }
    });
  }

  return next();
}
