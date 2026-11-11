export class SmsGatewayDeliveryError extends Error {
  constructor() {
    super('SMS gateway delivery failed');
    this.name = 'SmsGatewayDeliveryError';
  }
}

export function createSmsGateway({ endpoint, apiToken, fetchImpl = globalThis.fetch } = {}) {
  if (!endpoint && !apiToken) return null;
  if (typeof endpoint !== 'string' || typeof apiToken !== 'string' || apiToken.length < 32) {
    throw new Error('SMS gateway URL and a 32-byte token must be configured together');
  }
  if (typeof fetchImpl !== 'function') {
    throw new Error('This Node.js runtime does not provide fetch');
  }

  const url = new URL(endpoint);
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.hash
  ) {
    throw new Error('SMS_GATEWAY_URL must be an HTTPS URL without embedded credentials or fragments');
  }

  return Object.freeze({
    async sendMessage({ to, message, idempotencyKey }) {
      if (
        typeof to !== 'string' ||
        typeof message !== 'string' ||
        typeof idempotencyKey !== 'string'
      ) {
        throw new SmsGatewayDeliveryError();
      }

      let response;
      try {
        response = await fetchImpl(url, {
          method: 'POST',
          redirect: 'error',
          headers: {
            Authorization: `Bearer ${apiToken}`,
            'Content-Type': 'application/json',
            'Idempotency-Key': idempotencyKey
          },
          body: JSON.stringify({ to, message }),
          signal: AbortSignal.timeout(8_000)
        });
      } catch {
        throw new SmsGatewayDeliveryError();
      }

      if (!response?.ok) {
        try {
          await response?.body?.cancel();
        } catch {
          // Ignore body cleanup errors; do not expose gateway response details.
        }
        throw new SmsGatewayDeliveryError();
      }

      try {
        await response.body?.cancel();
      } catch {
        // The gateway has accepted the request; body cleanup is non-critical.
      }
    }
  });
}
