import {
  createCipheriv,
  createHmac,
  randomBytes
} from 'node:crypto';

export function decodeEncryptionKey(encoded) {
  if (typeof encoded !== 'string' || encoded.length === 0) {
    throw new Error('GUARDIAN_PHONE_ENCRYPTION_KEY_BASE64 is required');
  }

  const key = Buffer.from(encoded, 'base64');
  if (key.length !== 32 || key.toString('base64').replace(/=+$/, '') !== encoded.replace(/=+$/, '')) {
    throw new Error('GUARDIAN_PHONE_ENCRYPTION_KEY_BASE64 must encode exactly 32 random bytes');
  }
  return key;
}

function secretBuffer(secret, name) {
  const value = Buffer.isBuffer(secret) ? secret : Buffer.from(String(secret || ''), 'utf8');
  if (value.length < 32) {
    throw new Error(`${name} must contain at least 32 bytes`);
  }
  return value;
}

export function createFieldCrypto({
  encryptionKey,
  guardianPhoneLookupPepper,
  auditFingerprintPepper
}) {
  if (!Buffer.isBuffer(encryptionKey) || encryptionKey.length !== 32) {
    throw new Error('Field encryption requires a 32-byte AES-256 key');
  }

  const lookupKey = secretBuffer(guardianPhoneLookupPepper, 'Guardian lookup pepper');
  const auditKey = secretBuffer(auditFingerprintPepper, 'Audit fingerprint pepper');

  function encryptField(value) {
    if (typeof value !== 'string') throw new TypeError('Only text fields can be encrypted');
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', encryptionKey, iv);
    const ciphertext = Buffer.concat([
      cipher.update(value, 'utf8'),
      cipher.final()
    ]);
    const tag = cipher.getAuthTag();

    // Version byte | 96-bit nonce | 128-bit authentication tag | ciphertext.
    return Buffer.concat([Buffer.from([1]), iv, tag, ciphertext]);
  }

  function hashGuardianPhone(normalizedPhone) {
    return createHmac('sha256', lookupKey)
      .update(normalizedPhone, 'utf8')
      .digest();
  }

  function fingerprintNetworkAddress(address) {
    return createHmac('sha256', auditKey)
      .update(String(address || 'unknown'), 'utf8')
      .digest();
  }

  return Object.freeze({
    encryptField,
    hashGuardianPhone,
    fingerprintNetworkAddress
  });
}
