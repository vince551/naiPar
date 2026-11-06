import { normalizeKenyanPhone } from '../security/phone.js';

export class RegistrationValidationError extends Error {
  constructor(fields) {
    super('Registration details are invalid');
    this.name = 'RegistrationValidationError';
    this.fields = fields;
  }
}

export class RegistrationConflictError extends Error {
  constructor() {
    super('Registration could not be accepted');
    this.name = 'RegistrationConflictError';
  }
}

function cleanText(value, field, min, max, errors) {
  if (typeof value !== 'string') {
    errors.push(field);
    return '';
  }

  const cleaned = value.trim().replace(/\s+/g, ' ');
  if (
    cleaned.length < min ||
    cleaned.length > max ||
    /[\u0000-\u001f\u007f]/u.test(cleaned)
  ) {
    errors.push(field);
  }
  return cleaned;
}

export function validateChildRegistration(payload) {
  const errors = [];
  const input = payload && typeof payload === 'object' && !Array.isArray(payload)
    ? payload
    : {};

  const fullName = cleanText(input.fullName, 'fullName', 2, 120, errors);
  const school = cleanText(input.school, 'school', 2, 180, errors);
  const county = cleanText(input.county, 'county', 2, 100, errors);
  const ward = cleanText(input.ward, 'ward', 2, 100, errors);
  const guardianName = cleanText(input.guardianName, 'guardianName', 2, 120, errors);

  const age = Number(input.age);
  if (!Number.isInteger(age) || age < 5 || age > 17) {
    errors.push('age');
  }

  let guardianPhone = '';
  try {
    guardianPhone = normalizeKenyanPhone(input.guardianPhone);
  } catch {
    errors.push('guardianPhone');
  }

  const passphrase = typeof input.passphrase === 'string'
    ? input.passphrase.trim().replace(/\s+/g, ' ')
    : '';
  const passphraseWords = passphrase ? passphrase.split(' ') : [];
  if (
    passphrase.length < 12 ||
    passphrase.length > 120 ||
    passphraseWords.length < 3 ||
    /[\u0000-\u001f\u007f]/u.test(passphrase)
  ) {
    errors.push('passphrase');
  }

  if (errors.length) {
    throw new RegistrationValidationError([...new Set(errors)]);
  }

  return Object.freeze({
    fullName,
    age,
    school,
    county,
    ward,
    guardianName,
    guardianPhone,
    passphrase
  });
}

export function createChildRegistrationService({
  pool,
  fieldCrypto,
  hashPassphrase,
  consentNoticeVersion
}) {
  if (!pool || !fieldCrypto || typeof hashPassphrase !== 'function') {
    throw new TypeError('Child registration dependencies are incomplete');
  }
  if (typeof consentNoticeVersion !== 'string' || !consentNoticeVersion.trim()) {
    throw new TypeError('A server-controlled consent notice version is required');
  }

  return async function registerChild(payload, { requestId, networkFingerprint } = {}) {
    const input = validateChildRegistration(payload);

    // The client cannot assert that consent has been granted. This request
    // creates a pending record; guardian verification is a separate workflow.
    const [
      passphraseHash
    ] = await Promise.all([
      hashPassphrase(input.passphrase)
    ]);

    const phoneLookupHash = fieldCrypto.hashGuardianPhone(input.guardianPhone);
    const encryptedFullName = fieldCrypto.encryptField(input.fullName);
    const encryptedSchool = fieldCrypto.encryptField(input.school);
    const encryptedGuardianName = fieldCrypto.encryptField(input.guardianName);
    const encryptedUserGuardianPhone = fieldCrypto.encryptField(input.guardianPhone);
    const encryptedConsentGuardianPhone = fieldCrypto.encryptField(input.guardianPhone);

    const client = await pool.connect();
    let committed = false;

    try {
      await client.query('BEGIN');

      const userResult = await client.query(
        `INSERT INTO users (
          full_name,
          full_name_ciphertext,
          role,
          status,
          age,
          school,
          school_ciphertext,
          county,
          ward,
          guardian_phone_lookup_hash,
          guardian_phone_ciphertext,
          passphrase_hash
        ) VALUES (
          NULL, $1, 'public_child', 'pending', $2, NULL, $3, $4, $5, $6, $7, $8
        )
        RETURNING id`,
        [
          encryptedFullName,
          input.age,
          encryptedSchool,
          input.county,
          input.ward,
          phoneLookupHash,
          encryptedUserGuardianPhone,
          passphraseHash
        ]
      );

      const userId = userResult.rows[0]?.id;
      if (!userId) throw new Error('Child registration insert returned no identifier');

      const consentResult = await client.query(
        `INSERT INTO guardian_consents (
          child_user_id,
          guardian_name,
          guardian_name_ciphertext,
          guardian_phone_lookup_hash,
          guardian_phone_ciphertext,
          consent_text_version,
          status
        ) VALUES ($1, NULL, $2, $3, $4, $5, 'pending')
        RETURNING id`,
        [
          userId,
          encryptedGuardianName,
          phoneLookupHash,
          encryptedConsentGuardianPhone,
          consentNoticeVersion.trim()
        ]
      );

      const consentId = consentResult.rows[0]?.id;
      if (!consentId) throw new Error('Guardian consent insert returned no identifier');

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
          NULL,
          'child.registration_requested',
          'user',
          $1,
          $2,
          $3,
          $4::jsonb
        )`,
        [
          userId,
          requestId || null,
          networkFingerprint || null,
          JSON.stringify({ consentId, role: 'public_child', status: 'pending' })
        ]
      );

      await client.query('COMMIT');
      committed = true;

      return Object.freeze({
        registrationRequestId: userId,
        accountStatus: 'pending',
        guardianConsentStatus: 'pending'
      });
    } catch (error) {
      if (!committed) {
        try {
          await client.query('ROLLBACK');
        } catch {
          // Preserve the original failure; the connection is released below.
        }
      }
      if (error?.code === '23505') throw new RegistrationConflictError();
      throw error;
    } finally {
      client.release();
    }
  };
}
