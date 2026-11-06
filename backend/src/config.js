import { decodeEncryptionKey } from './security/field-crypto.js';

function required(env, name) {
  const value = env[name];
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value.trim();
}

function requiredSecret(env, name) {
  const value = required(env, name);
  if (Buffer.byteLength(value, 'utf8') < 32) {
    throw new Error(`${name} must contain at least 32 bytes`);
  }
  return value;
}

export function readConfig(env = process.env) {
  const nodeEnv = env.NODE_ENV || 'development';
  const port = Number.parseInt(env.PORT || '4000', 10);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('PORT must be an integer between 1 and 65535');
  }
  const databaseUrl = required(env, 'DATABASE_URL');
  const databaseSsl = env.DATABASE_SSL === 'true';

  if (nodeEnv === 'production' && !databaseSsl) {
    throw new Error('DATABASE_SSL=true is required in production');
  }

  const encryptionKey = decodeEncryptionKey(
    required(env, 'GUARDIAN_PHONE_ENCRYPTION_KEY_BASE64')
  );

  return Object.freeze({
    nodeEnv,
    port,
    databaseUrl,
    migrationDatabaseUrl: env.MIGRATION_DATABASE_URL?.trim() || null,
    databaseSsl,
    trustProxy: env.TRUST_PROXY === 'true',
    consentNoticeVersion: required(env, 'CONSENT_NOTICE_VERSION'),
    encryptionKey,
    guardianPhoneLookupPepper: requiredSecret(env, 'GUARDIAN_PHONE_LOOKUP_PEPPER'),
    auditFingerprintPepper: requiredSecret(env, 'AUDIT_FINGERPRINT_PEPPER')
  });
}
