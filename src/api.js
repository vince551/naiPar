export class ApiError extends Error {
  constructor({ status, code, message, fields = [] }) {
    super(message || 'The request could not be completed.');
    this.name = 'ApiError';
    this.status = status;
    this.code = code || 'API_ERROR';
    this.fields = Array.isArray(fields) ? fields : [];
  }
}

export function createApiClient({ baseUrl = '', fetchImpl = globalThis.fetch } = {}) {
  if (typeof fetchImpl !== 'function') {
    throw new TypeError('A Fetch-compatible function is required');
  }

  const root = String(baseUrl).replace(/\/$/u, '');

  async function request(path, {
    method = 'GET',
    body,
    csrfToken,
    headers: extraHeaders = {}
  } = {}) {
    const headers = {
      Accept: 'application/json',
      ...extraHeaders
    };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (csrfToken) headers['x-csrf-token'] = csrfToken;

    const response = await fetchImpl(`${root}/api/v1${path}`, {
      method,
      credentials: 'include',
      cache: 'no-store',
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    });

    if (response.status === 204) return null;

    let payload = null;
    try {
      payload = await response.json();
    } catch {
      payload = null;
    }

    if (!response.ok) {
      const error = payload?.error || {};
      throw new ApiError({
        status: response.status,
        code: error.code,
        message: error.message,
        fields: error.fields
      });
    }

    return payload?.data ?? payload;
  }

  return Object.freeze({
    getSession: () => request('/auth/session'),
    refreshCsrf: () => request('/auth/csrf', { method: 'POST', body: {} }),
    login: (mode, identifier, secret) => request('/auth/login', {
      method: 'POST',
      body: { mode, identifier, secret }
    }),
    logout: csrfToken => request('/auth/logout', {
      method: 'POST',
      body: {},
      csrfToken
    }),
    registerChild: details => request('/auth/child/registration-requests', {
      method: 'POST',
      body: details
    }),
    requestGuardianOtp: details => request('/auth/guardian-phone-verification/request', {
      method: 'POST',
      body: details
    }),
    verifyGuardianOtp: details => request('/auth/guardian-phone-verification/verify', {
      method: 'POST',
      body: details
    }),
    submitConcern: (details, csrfToken) => request('/participation/concerns', {
      method: 'POST',
      body: details,
      csrfToken
    }),
    listOwnConcerns: () => request('/participation/my-concerns'),
    listPublicConcerns: () => request('/public/concerns')
  });
}

export const api = createApiClient();
