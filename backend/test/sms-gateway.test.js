import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createSmsGateway,
  SmsGatewayDeliveryError
} from '../src/integrations/sms-gateway.js';

test('SMS gateway is disabled when no endpoint or token is configured', () => {
  assert.equal(createSmsGateway({}), null);
});

test('SMS gateway requires an HTTPS endpoint and token together', () => {
  assert.throws(
    () => createSmsGateway({ endpoint: 'https://sms.example.test/send' }),
    /configured together/u
  );
  assert.throws(
    () => createSmsGateway({
      endpoint: 'http://sms.example.test/send',
      apiToken: 'synthetic-sms-gateway-token-that-is-long-enough'
    }),
    /HTTPS URL/u
  );
});

test('SMS gateway sends a bearer-authenticated idempotent JSON request', async () => {
  let captured;
  const gateway = createSmsGateway({
    endpoint: 'https://sms.example.test/v1/messages',
    apiToken: 'synthetic-sms-gateway-token-that-is-long-enough',
    fetchImpl: async (url, options) => {
      captured = { url: String(url), options };
      return { ok: true, body: { async cancel() {} } };
    }
  });

  await gateway.sendMessage({
    to: '+254700000001',
    message: 'Synthetic verification code',
    idempotencyKey: '33333333-3333-4333-8333-333333333333'
  });

  assert.equal(captured.url, 'https://sms.example.test/v1/messages');
  assert.equal(captured.options.method, 'POST');
  assert.equal(captured.options.redirect, 'error');
  assert.equal(captured.options.headers.Authorization, 'Bearer synthetic-sms-gateway-token-that-is-long-enough');
  assert.equal(captured.options.headers['Idempotency-Key'], '33333333-3333-4333-8333-333333333333');
  assert.deepEqual(JSON.parse(captured.options.body), {
    to: '+254700000001',
    message: 'Synthetic verification code'
  });
});

test('SMS gateway failures expose no provider response details', async () => {
  const gateway = createSmsGateway({
    endpoint: 'https://sms.example.test/v1/messages',
    apiToken: 'synthetic-sms-gateway-token-that-is-long-enough',
    fetchImpl: async () => ({
      ok: false,
      body: { async cancel() {} },
      text: async () => 'sensitive synthetic provider response'
    })
  });

  await assert.rejects(
    gateway.sendMessage({
      to: '+254700000001',
      message: 'Synthetic message',
      idempotencyKey: '33333333-3333-4333-8333-333333333333'
    }),
    error => {
      assert.ok(error instanceof SmsGatewayDeliveryError);
      assert.equal(error.message.includes('sensitive synthetic'), false);
      return true;
    }
  );
});
