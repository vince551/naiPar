import test from 'node:test';
import assert from 'node:assert/strict';
import { readConfig } from '../src/config.js';

const baseEnv = () => ({
  NODE_ENV: 'test',
  DATABASE_URL: 'postgresql://synthetic:synthetic@localhost:5432/sauti_yetu_test',
  DATABASE_SSL: 'false',
  GUARDIAN_PHONE_ENCRYPTION_KEY_BASE64: Buffer.alloc(32).toString('base64'),
  GUARDIAN_PHONE_LOOKUP_PEPPER: 'synthetic-guardian-lookup-pepper-32-bytes',
  AUDIT_FINGERPRINT_PEPPER: 'synthetic-audit-fingerprint-pepper-32-bytes',
  GUARDIAN_OTP_PEPPER: 'synthetic-guardian-otp-pepper-32-bytes',
  CONSENT_NOTICE_VERSION: 'synthetic-consent-v1'
});

test('configuration accepts independent OTP pepper and no SMS gateway', () => {
  const config = readConfig(baseEnv());
  assert.equal(config.guardianOtpPepper, 'synthetic-guardian-otp-pepper-32-bytes');
  assert.equal(config.smsGatewayUrl, null);
  assert.equal(config.smsGatewayToken, null);
});

test('configuration rejects reused guardian, audit and OTP peppers', () => {
  const env = baseEnv();
  env.GUARDIAN_OTP_PEPPER = env.GUARDIAN_PHONE_LOOKUP_PEPPER;
  assert.throws(() => readConfig(env), /must be different secrets/u);
});

test('configuration requires SMS gateway URL and token as a pair', () => {
  const env = baseEnv();
  env.SMS_GATEWAY_URL = 'https://sms.example.test/send';
  assert.throws(() => readConfig(env), /configured together/u);
});

test('configuration rejects insecure SMS gateway URLs', () => {
  const env = baseEnv();
  env.SMS_GATEWAY_URL = 'http://sms.example.test/send';
  env.SMS_GATEWAY_TOKEN = 'synthetic-sms-gateway-token-that-is-long-enough';
  assert.throws(() => readConfig(env), /HTTPS URL/u);
});

test('production database connections require TLS', () => {
  const env = baseEnv();
  env.NODE_ENV = 'production';
  assert.throws(() => readConfig(env), /DATABASE_SSL=true/u);
});
