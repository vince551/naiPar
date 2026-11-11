import { createHmac, randomInt, randomUUID, timingSafeEqual } from 'node:crypto';
import { normalizeKenyanPhone } from '../security/phone.js';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const OTP_PATTERN = /^\d{6}$/u;
const MAX_ATTEMPTS = 5;

export class GuardianOtpValidationError extends Error {
  constructor(fields) {
    super('Guardian phone verification details are invalid');
    this.name = 'GuardianOtpValidationError';
    this.fields = fields;
  }
}

export class GuardianOtpProviderUnavailableError extends Error {
  constructor() {
    super('Guardian SMS verification is not configured');
    this.name = 'GuardianOtpProviderUnavailableError';
  }
}

export class GuardianOtpVerificationFailedError extends Error {
  constructor() {
    super('Guardian phone verification could not be completed');
    this.name = 'GuardianOtpVerificationFailedError';
  }
}

function normalizeRegistrationId(value) {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) {
    throw new GuardianOtpValidationError(['registrationRequestId']);
  }
  return value;
}

function normalizePhone(value) {
  try {
    return normalizeKenyanPhone(value);
  } catch {
    throw new GuardianOtpValidationError(['guardianPhone']);
  }
}

function validateRequest(payload) {
  const input = payload && typeof payload === 'object' && !Array.isArray(payload)
    ? payload
    : {};
  return Object.freeze({
    registrationRequestId: normalizeRegistrationId(input.registrationRequestId),
    guardianPhone: normalizePhone(input.guardianPhone)
  });
}

function validateVerification(payload) {
  const input = payload && typeof payload === 'object' && !Array.isArray(payload)
    ? payload
    : {};
  const registrationRequestId = normalizeRegistrationId(input.registrationRequestId);
  const guardianPhone = normalizePhone(input.guardianPhone);
  const code = typeof input.code === 'string' ? input.code.trim() : '';

  if (!OTP_PATTERN.test(code)) {
    throw new GuardianOtpValidationError(['code']);
  }

  return Object.freeze({ registrationRequestId, guardianPhone, code });
}

function createOtpDigest(pepper, consentId, challengeId, code) {
  return createHmac('sha256', pepper)
    .update(consentId, 'utf8')
    .update(':', 'utf8')
    .update(challengeId, 'utf8')
    .update(':', 'utf8')
    .update(code, 'utf8')
    .digest();
}

function safeDigestEqual(expected, actual) {
  if (!Buffer.isBuffer(actual) || actual.length !== expected.length) {
    // Keep a fixed-size comparison on malformed or unexpected database values.
    timingSafeEqual(expected, Buffer.alloc(expected.length));
    return false;
  }
  return timingSafeEqual(expected, actual);
}

async function withTransaction(pool, work) {
  const client = await pool.connect();
  let committed = false;

  try {
    await client.query('BEGIN');
    const result = await work(client);
    await client.query('COMMIT');
    committed = true;
    return result;
  } catch (error) {
    if (!committed) {
      try {
        await client.query('ROLLBACK');
      } catch {
        // Preserve the original failure.
      }
    }
    throw error;
  } finally {
    client.release();
  }
}

async function writeAudit(client, {
  action,
  challengeId,
  requestId,
  networkFingerprint,
  metadata
}) {
  await client.query(
    `INSERT INTO audit_logs (
      actor_user_id,
      action,
      entity_type,
      entity_id,
      request_id,
      ip_fingerprint,
      metadata
    ) VALUES (NULL, $1, 'guardian_phone_verification_challenge', $2, $3, $4, $5::jsonb)`,
    [
      action,
      challengeId,
      requestId || null,
      networkFingerprint || null,
      JSON.stringify(metadata)
    ]
  );
}

export function createGuardianPhoneVerificationService({
  pool,
  fieldCrypto,
  otpPepper,
  smsGateway,
  generateCode = () => String(randomInt(0, 1_000_000)).padStart(6, '0')
}) {
  if (!pool || typeof fieldCrypto?.hashGuardianPhone !== 'function') {
    throw new TypeError('Guardian phone verification dependencies are incomplete');
  }
  const pepper = Buffer.isBuffer(otpPepper)
    ? otpPepper
    : Buffer.from(String(otpPepper || ''), 'utf8');
  if (pepper.length < 32) {
    throw new TypeError('Guardian OTP pepper must contain at least 32 bytes');
  }

  async function requestCode(payload, {
    requestId,
    networkFingerprint
  } = {}) {
    if (!smsGateway || typeof smsGateway.sendMessage !== 'function') {
      throw new GuardianOtpProviderUnavailableError();
    }

    const input = validateRequest(payload);
    const phoneLookupHash = fieldCrypto.hashGuardianPhone(input.guardianPhone);

    // Lock the consent row to serialise simultaneous resend attempts. The
    // endpoint always returns the same accepted response for unknown,
    // mismatched, already-verified and rate-limited registrations.
    const challenge = await withTransaction(pool, async client => {
      const consentResult = await client.query(
        `SELECT gc.id
         FROM guardian_consents gc
         JOIN users u ON u.id = gc.child_user_id
         WHERE gc.child_user_id = $1
           AND gc.guardian_phone_lookup_hash = $2
           AND gc.status IN ('pending', 'rejected')
           AND gc.guardian_phone_verified_at IS NULL
           AND u.status = 'pending'
           AND u.role IN ('public_child', 'delegate')
         FOR UPDATE OF gc, u`,
        [input.registrationRequestId, phoneLookupHash]
      );
      const consent = consentResult.rows?.[0];
      if (!consent) return null;

      const recentResult = await client.query(
        `SELECT
           count(*)::int AS recent_count,
           max(created_at) AS last_requested_at,
           COALESCE(max(created_at) > now() - interval '60 seconds', false) AS cooldown_active
         FROM guardian_phone_verification_challenges
         WHERE consent_id = $1
           AND created_at > now() - interval '1 hour'`,
        [consent.id]
      );
      const recent = recentResult.rows?.[0] || {};
      if (Number(recent.recent_count || 0) >= 3 || recent.cooldown_active === true) {
        return null;
      }

      await client.query(
        `UPDATE guardian_phone_verification_challenges
         SET delivery_status = 'expired'
         WHERE consent_id = $1
           AND delivery_status IN ('pending', 'sent')`,
        [consent.id]
      );

      const code = generateCode();
      if (typeof code !== 'string' || !OTP_PATTERN.test(code)) {
        throw new TypeError('OTP generator must return a six-digit string');
      }
      const challengeId = randomUUID();
      const otpHash = createOtpDigest(pepper, consent.id, challengeId, code);
      const inserted = await client.query(
        `INSERT INTO guardian_phone_verification_challenges (
          id,
          consent_id,
          phone_lookup_hash,
          otp_hash,
          expires_at,
          request_fingerprint
        ) VALUES ($1, $2, $3, $4, now() + interval '10 minutes', $5)
        RETURNING id`,
        [challengeId, consent.id, phoneLookupHash, otpHash, networkFingerprint || null]
      );
      const id = inserted.rows?.[0]?.id;
      if (!id || id !== challengeId) throw new Error('Guardian OTP challenge insert returned no identifier');

      return Object.freeze({ id, code, consentId: consent.id });
    });

    if (!challenge) return Object.freeze({ accepted: true });

    const message = `Sauti Yetu guardian phone verification code: ${challenge.code}. It expires in 10 minutes. Do not share it. This verifies phone access only; it does not grant consent.`;

    try {
      await smsGateway.sendMessage({
        to: input.guardianPhone,
        message,
        idempotencyKey: challenge.id
      });
    } catch {
      await withTransaction(pool, async client => {
        await client.query(
          `UPDATE guardian_phone_verification_challenges
           SET delivery_status = 'failed'
           WHERE id = $1 AND delivery_status = 'pending'`,
          [challenge.id]
        );
        await writeAudit(client, {
          action: 'guardian.phone_otp_delivery_failed',
          challengeId: challenge.id,
          requestId,
          networkFingerprint,
          metadata: { delivery: 'failed' }
        });
      });
      // Do not reveal whether a child registration or phone number exists.
      return Object.freeze({ accepted: true });
    }

    await withTransaction(pool, async client => {
      const sent = await client.query(
        `UPDATE guardian_phone_verification_challenges
         SET delivery_status = 'sent', sent_at = now()
         WHERE id = $1
           AND delivery_status = 'pending'
           AND expires_at > now()
         RETURNING id`,
        [challenge.id]
      );
      if (sent.rowCount !== 1) {
        throw new GuardianOtpVerificationFailedError();
      }
      await writeAudit(client, {
        action: 'guardian.phone_otp_sent',
        challengeId: challenge.id,
        requestId,
        networkFingerprint,
        metadata: { delivery: 'sent', expiresInSeconds: 600 }
      });
    });

    return Object.freeze({ accepted: true });
  }

  async function verifyCode(payload, {
    requestId,
    networkFingerprint
  } = {}) {
    const input = validateVerification(payload);
    const phoneLookupHash = fieldCrypto.hashGuardianPhone(input.guardianPhone);

    const result = await withTransaction(pool, async client => {
      const consentResult = await client.query(
        `SELECT gc.id
         FROM guardian_consents gc
         JOIN users u ON u.id = gc.child_user_id
         WHERE gc.child_user_id = $1
           AND gc.guardian_phone_lookup_hash = $2
           AND gc.status IN ('pending', 'rejected')
           AND gc.guardian_phone_verified_at IS NULL
           AND u.status = 'pending'
           AND u.role IN ('public_child', 'delegate')
         FOR UPDATE OF gc, u`,
        [input.registrationRequestId, phoneLookupHash]
      );
      const consent = consentResult.rows?.[0];
      if (!consent) return { verified: false };

      await client.query(
        `UPDATE guardian_phone_verification_challenges
         SET delivery_status = 'expired'
         WHERE consent_id = $1
           AND delivery_status IN ('pending', 'sent')
           AND expires_at <= now()`,
        [consent.id]
      );

      const challengeResult = await client.query(
        `SELECT id, otp_hash, attempts
         FROM guardian_phone_verification_challenges
         WHERE consent_id = $1
           AND phone_lookup_hash = $2
           AND delivery_status = 'sent'
           AND expires_at > now()
           AND attempts < $3
         ORDER BY created_at DESC
         LIMIT 1
         FOR UPDATE`,
        [consent.id, phoneLookupHash, MAX_ATTEMPTS]
      );
      const challenge = challengeResult.rows?.[0];
      if (!challenge) return { verified: false };

      const expected = createOtpDigest(pepper, consent.id, challenge.id, input.code);
      const valid = safeDigestEqual(expected, challenge.otp_hash);

      if (!valid) {
        const nextAttempts = Number(challenge.attempts) + 1;
        await client.query(
          `UPDATE guardian_phone_verification_challenges
           SET attempts = $2,
               delivery_status = CASE WHEN $2 >= $3
                 THEN 'locked'::guardian_otp_delivery_status
                 ELSE 'sent'::guardian_otp_delivery_status
               END
           WHERE id = $1`,
          [challenge.id, nextAttempts, MAX_ATTEMPTS]
        );
        await writeAudit(client, {
          action: 'guardian.phone_otp_failed',
          challengeId: challenge.id,
          requestId,
          networkFingerprint,
          metadata: { attempt: nextAttempts, locked: nextAttempts >= MAX_ATTEMPTS }
        });
        return { verified: false };
      }

      const verified = await client.query(
        `UPDATE guardian_phone_verification_challenges
         SET delivery_status = 'verified', verified_at = now()
         WHERE id = $1
           AND delivery_status = 'sent'
           AND expires_at > now()
           AND attempts < $2
         RETURNING verified_at`,
        [challenge.id, MAX_ATTEMPTS]
      );
      const verifiedAt = verified.rows?.[0]?.verified_at;
      if (!verifiedAt) return { verified: false };

      const updatedConsent = await client.query(
        `UPDATE guardian_consents
         SET guardian_phone_verified_at = $2,
             guardian_phone_verification_challenge_id = $3
         WHERE id = $1
           AND guardian_phone_verified_at IS NULL
           AND status IN ('pending', 'rejected')
         RETURNING id`,
        [consent.id, verifiedAt, challenge.id]
      );
      if (updatedConsent.rowCount !== 1) {
        throw new GuardianOtpVerificationFailedError();
      }

      await writeAudit(client, {
        action: 'guardian.phone_otp_verified',
        challengeId: challenge.id,
        requestId,
        networkFingerprint,
        metadata: { verification: 'phone_possession_only' }
      });

      return { verified: true };
    });

    if (!result.verified) throw new GuardianOtpVerificationFailedError();
    return Object.freeze({
      verified: true,
      message: 'Guardian phone access verified. Coordinator consent review is still required.'
    });
  }

  return Object.freeze({ requestCode, verifyCode });
}
