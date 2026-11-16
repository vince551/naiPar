import test from 'node:test';
import assert from 'node:assert/strict';
import { ApiError, createApiClient } from './api.js';

function response(status, payload = null) {
  return {
    status,
    ok: status >= 200 && status < 300,
    async json() { return payload; }
  };
}

test('login sends credentials only in a JSON body and includes the HttpOnly session cookie', async () => {
  let request;
  const api = createApiClient({
    fetchImpl: async (url, options) => {
      request = { url, options };
      return response(200, { data: { userId: 'synthetic-user', role: 'delegate', csrfToken: 'synthetic-csrf' } });
    }
  });

  const result = await api.login('child', '0712345678', 'sample mango river');
  assert.equal(result.role, 'delegate');
  assert.equal(request.url, '/api/v1/auth/login');
  assert.equal(request.options.method, 'POST');
  assert.equal(request.options.credentials, 'include');
  assert.equal(request.options.cache, 'no-store');
  assert.equal(request.options.headers['Content-Type'], 'application/json');
  assert.equal(request.options.headers['x-csrf-token'], undefined);
  assert.deepEqual(JSON.parse(request.options.body), {
    mode: 'child',
    identifier: '0712345678',
    secret: 'sample mango river'
  });
});

test('state-changing authenticated requests attach the CSRF header', async () => {
  let request;
  const api = createApiClient({
    fetchImpl: async (_url, options) => {
      request = options;
      return response(201, { data: { id: 'synthetic-concern', status: 'submitted' } });
    }
  });

  await api.submitConcern({
    theme: 'Education access',
    title: 'Improve reading materials',
    description: 'Our library needs more age-appropriate books.'
  }, 'synthetic-csrf-token');

  assert.equal(request.headers['x-csrf-token'], 'synthetic-csrf-token');
  assert.equal(request.credentials, 'include');
});

test('API errors preserve safe status, code and field metadata', async () => {
  const api = createApiClient({
    fetchImpl: async () => response(400, {
      error: {
        code: 'VALIDATION_FAILED',
        message: 'Check the highlighted details.',
        fields: ['guardianPhone']
      }
    })
  });

  await assert.rejects(
    api.registerChild({}),
    error => error instanceof ApiError &&
      error.status === 400 &&
      error.code === 'VALIDATION_FAILED' &&
      error.fields[0] === 'guardianPhone'
  );
});

test('logout handles an empty successful response', async () => {
  let request;
  const api = createApiClient({
    fetchImpl: async (_url, options) => {
      request = options;
      return response(204);
    }
  });

  assert.equal(await api.logout('synthetic-csrf-token'), null);
  assert.equal(request.headers['x-csrf-token'], 'synthetic-csrf-token');
});

test('API client does not expose non-JSON server error bodies', async () => {
  const api = createApiClient({
    fetchImpl: async () => ({
      status: 502,
      ok: false,
      async json() { throw new Error('synthetic upstream detail'); }
    })
  });

  await assert.rejects(
    api.getSession(),
    error => error instanceof ApiError && error.status === 502 && error.code === 'API_ERROR'
  );
});
