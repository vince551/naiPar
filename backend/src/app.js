import express from 'express';
import helmet from 'helmet';
import { rateLimit } from 'express-rate-limit';
import { randomUUID } from 'node:crypto';
import {
  createChildRegistrationService,
  RegistrationConflictError,
  RegistrationValidationError
} from './domain/child-registration.js';
import { createFieldCrypto } from './security/field-crypto.js';

export function createApp({ pool, config, hashPassphrase }) {
  if (!pool || !config) throw new TypeError('API dependencies are incomplete');

  const app = express();
  const fieldCrypto = createFieldCrypto({
    encryptionKey: config.encryptionKey,
    guardianPhoneLookupPepper: config.guardianPhoneLookupPepper,
    auditFingerprintPepper: config.auditFingerprintPepper
  });
  const registerChild = createChildRegistrationService({
    pool,
    fieldCrypto,
    hashPassphrase,
    consentNoticeVersion: config.consentNoticeVersion
  });

  app.disable('x-powered-by');
  app.set('trust proxy', config.trustProxy ? 1 : false);
  app.use(helmet());
  app.use(express.json({ limit: '16kb', strict: true }));
  app.use((req, res, next) => {
    req.requestId = randomUUID();
    res.setHeader('X-Request-Id', req.requestId);
    res.setHeader('Cache-Control', 'no-store');
    next();
  });

  app.get('/health/live', (_req, res) => {
    res.status(200).json({ status: 'ok', service: 'sauti-yetu-api' });
  });

  app.get('/health/ready', async (_req, res) => {
    try {
      await pool.query('SELECT 1');
      res.status(200).json({ status: 'ready' });
    } catch {
      res.status(503).json({ status: 'not_ready' });
    }
  });

  const childRegistrationLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 5,
    standardHeaders: true,
    legacyHeaders: false,
    message: {
      error: {
        code: 'REGISTRATION_RATE_LIMITED',
        message: 'Too many registration attempts. Please try again later.'
      }
    }
  });

  app.post(
    '/api/v1/auth/child/registration-requests',
    childRegistrationLimiter,
    async (req, res, next) => {
      try {
        const result = await registerChild(req.body, {
          requestId: req.requestId,
          networkFingerprint: fieldCrypto.fingerprintNetworkAddress(req.ip)
        });

        res.status(202).json({
          data: result,
          message: 'Registration request received. The account remains inactive until guardian consent is verified.'
        });
      } catch (error) {
        next(error);
      }
    }
  );

  app.use((_req, res) => {
    res.status(404).json({
      error: { code: 'NOT_FOUND', message: 'The requested endpoint was not found.' }
    });
  });

  app.use((error, req, res, _next) => {
    if (error instanceof RegistrationValidationError) {
      return res.status(400).json({
        error: {
          code: 'VALIDATION_FAILED',
          message: 'Check the highlighted registration details.',
          fields: error.fields
        }
      });
    }

    if (error instanceof RegistrationConflictError) {
      return res.status(409).json({
        error: {
          code: 'REGISTRATION_CONFLICT',
          message: 'This registration could not be accepted. Please contact the Assembly Secretariat.'
        }
      });
    }

    if (error?.type === 'entity.parse.failed') {
      return res.status(400).json({
        error: { code: 'INVALID_JSON', message: 'The request body must contain valid JSON.' }
      });
    }

    if (error?.type === 'entity.too.large') {
      return res.status(413).json({
        error: { code: 'PAYLOAD_TOO_LARGE', message: 'The request body is too large.' }
      });
    }

    // Do not log request bodies, names, phone numbers, passphrases, SQL text,
    // or raw exception messages. The request ID supports safe correlation.
    console.error(JSON.stringify({
      event: 'api_request_failed',
      requestId: req.requestId,
      errorType: error?.name || 'Error',
      databaseCode: error?.code || undefined
    }));

    return res.status(500).json({
      error: {
        code: 'INTERNAL_ERROR',
        message: 'The request could not be completed. Please try again later.'
      }
    });
  });

  return app;
}
