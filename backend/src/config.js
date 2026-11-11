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
  const guardianPhoneLookupPepper = requiredSecret(env, 'GUARDIAN_PHONE_LOOKUP_PEPPER');
  const auditFingerprintPepper = requiredSecret(env, 'AUDIT_FINGERPRINT_PEPPER');
  const guardianOtpPepper = requiredSecret(env, 'GUARDIAN_OTP_PEPPER');
  const independentPeppers = [guardianPhoneLookupPepper, auditFingerprintPepper, guardianOtpPepper];
  if (new Set(independentPeppers).size !== independentPeppers.length) {
    throw new Error('Guardian lookup, audit fingerprint and OTP peppers must be different secrets');
  }

  const smsGatewayUrl = env.SMS_GATEWAY_URL?.trim() || null;
  const smsGatewayToken = env.SMS_GATEWAY_TOKEN?.trim() || null;
  if (Boolean(smsGatewayUrl) !== Boolean(smsGatewayToken)) {
    throw new Error('SMS_GATEWAY_URL and SMS_GATEWAY_TOKEN must be configured together');
  }
  if (smsGatewayUrl) {
    let parsedSmsGatewayUrl;
    try {
      parsedSmsGatewayUrl = new URL(smsGatewayUrl);
    } catch {
      throw new Error('SMS_GATEWAY_URL must be a valid HTTPS URL');
    }
    if (parsedSmsGatewayUrl.protocol !== 'https:' || parsedSmsGatewayUrl.username || parsedSmsGatewayUrl.password || parsedSmsGatewayUrl.hash) {
      throw new Error('SMS_GATEWAY_URL must be an HTTPS URL without embedded credentials or fragments');
    }
    if (Buffer.byteLength(smsGatewayToken, 'utf8') < 32) {
      throw new Error('SMS_GATEWAY_TOKEN must contain at least 32 bytes');
    }
  }

  return Object.freeze({
    nodeEnv,
    port,
    databaseUrl,
    migrationDatabaseUrl: env.MIGRATION_DATABASE_URL?.trim() || null,
    databaseSsl,
    trustProxy: env.TRUST_PROXY === 'true',
    consentNoticeVersion: required(env, 'CONSENT_NOTICE_VERSION'),
    encryptionKey,
    guardianPhoneLookupPepper,
    auditFingerprintPepper,
    guardianOtpPepper,
    smsGatewayUrl,
    smsGatewayToken
  });
}
