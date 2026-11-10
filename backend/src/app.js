import express from 'express';
import helmet from 'helmet';
import { rateLimit } from 'express-rate-limit';
import { randomUUID } from 'node:crypto';
import {
  createChildRegistrationService,
  RegistrationConflictError,
  RegistrationValidationError
} from './domain/child-registration.js';
import {
  createAuthenticationService,
  AuthenticationFailedError,
  AuthenticationValidationError
} from './domain/authentication.js';
import { createFieldCrypto } from './security/field-crypto.js';
import { requireAuthenticated, requireRoles } from './security/authorization.js';
import {
  createGuardianConsentReviewService,
  ConsentReviewConflictError,
  ConsentReviewForbiddenError,
  ConsentReviewNotFoundError,
  ConsentReviewValidationError
} from './domain/guardian-consent-review.js';
import {
  clearSessionCookie,
  createSessionResolver,
  requireCsrf,
  requireSession,
  serializeSessionCookie
} from './security/session.js';

export function createApp({
  pool,
  config,
  hashPassphrase,
  verifySecret,
  dummyCredentialHash
}) {
  if (!pool || !config) throw new TypeError('API dependencies are incomplete');

  const app = express();
  const secureCookies = config.nodeEnv === 'production';
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
  const authentication = createAuthenticationService({
    pool,
    fieldCrypto,
    verifySecret,
    dummyCredentialHash
  });
  const consentReview = createGuardianConsentReviewService({ pool, fieldCrypto });
  const resolveSession = createSessionResolver({ pool, secureCookies });

  app.disable('x-powered-by');
  app.set('trust proxy', config.trustProxy ? 1 : false);
  app.use(helmet());
  app.use((req, res, next) => {
    req.requestId = randomUUID();
    res.setHeader('X-Request-Id', req.requestId);
    res.setHeader('Cache-Control', 'no-store');
    next();
  });
  app.use(express.json({ limit: '16kb', strict: true }));

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

  // Session identity is loaded only from a server-issued, hashed session cookie.
  // No client-provided role, user ID or guardian-consent status is trusted.
  app.use('/api/v1', resolveSession);

  const childRegistrationLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 5,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    message: {
      error: {
        code: 'REGISTRATION_RATE_LIMITED',
        message: 'Too many registration attempts. Please try again later.'
      }
    }
  });

  const loginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 10,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    message: {
      error: {
        code: 'LOGIN_RATE_LIMITED',
        message: 'Too many sign-in attempts. Please try again later.'
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

  app.post('/api/v1/auth/login', loginLimiter, async (req, res, next) => {
    try {
      const networkFingerprint = fieldCrypto.fingerprintNetworkAddress(req.ip);
      const result = await authentication.authenticate(req.body, {
        requestId: req.requestId,
        networkFingerprint
      });

      // Revoke an existing browser session after new credentials are verified,
      // preventing a shared device from silently retaining the previous account.
      if (req.sessionId && req.auth?.userId) {
        try {
          await authentication.revokeSession({
            sessionId: req.sessionId,
            userId: req.auth.userId,
            requestId: req.requestId,
            networkFingerprint
          });
        } catch (error) {
          // Do not leave an unissued replacement session active if rotation fails.
          try {
            await authentication.revokeSession({
              sessionId: result.sessionId,
              userId: result.userId,
              requestId: req.requestId,
              networkFingerprint
            });
          } catch {
            // Preserve the original failure; expiry still bounds the orphaned session.
          }
          throw error;
        }
      }

      res.setHeader(
        'Set-Cookie',
        serializeSessionCookie(result.sessionToken, { secure: secureCookies })
      );
      res.status(200).json({
        data: {
          userId: result.userId,
          role: result.role,
          csrfToken: result.csrfToken,
          expiresAt: result.expiresAt
        },
        message: 'Sign-in successful.'
      });
    } catch (error) {
      next(error);
    }
  });

  const coordinatorReviewAccess = [
    requireSession,
    requireAuthenticated,
    requireRoles('coordinator')
  ];

  app.get(
    '/api/v1/coordinator/guardian-consents',
    ...coordinatorReviewAccess,
    async (req, res, next) => {
      try {
        const data = await consentReview.listReviewQueue({
          actorUserId: req.auth.userId,
          requestId: req.requestId,
          networkFingerprint: fieldCrypto.fingerprintNetworkAddress(req.ip)
        });
        res.status(200).json({ data });
      } catch (error) {
        next(error);
      }
    }
  );

  app.get(
    '/api/v1/coordinator/guardian-consents/:consentId',
    ...coordinatorReviewAccess,
    async (req, res, next) => {
      try {
        const data = await consentReview.getReviewDetails(req.params.consentId, {
          actorUserId: req.auth.userId,
          requestId: req.requestId,
          networkFingerprint: fieldCrypto.fingerprintNetworkAddress(req.ip)
        });
        res.status(200).json({ data });
      } catch (error) {
        next(error);
      }
    }
  );

  app.post(
    '/api/v1/coordinator/guardian-consents/:consentId/review',
    ...coordinatorReviewAccess,
    requireCsrf,
    async (req, res, next) => {
      try {
        const data = await consentReview.reviewConsent(
          req.params.consentId,
          req.body,
          {
            actorUserId: req.auth.userId,
            requestId: req.requestId,
            networkFingerprint: fieldCrypto.fingerprintNetworkAddress(req.ip)
          }
        );
        res.status(200).json({ data, message: 'Guardian consent review recorded.' });
      } catch (error) {
        next(error);
      }
    }
  );

  app.get('/api/v1/auth/session', requireAuthenticated, (req, res) => {
    res.status(200).json({
      data: {
        userId: req.auth.userId,
        role: req.auth.role
      }
    });
  });

  app.post(
    '/api/v1/auth/logout',
    requireSession,
    requireCsrf,
    async (req, res, next) => {
      try {
        await authentication.revokeSession({
          sessionId: req.sessionId,
          userId: req.auth.userId,
          requestId: req.requestId,
          networkFingerprint: fieldCrypto.fingerprintNetworkAddress(req.ip)
        });
        res.setHeader('Set-Cookie', clearSessionCookie({ secure: secureCookies }));
        res.status(204).end();
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
    if (error instanceof ConsentReviewValidationError) {
      return res.status(400).json({
        error: {
          code: 'VALIDATION_FAILED',
          message: 'Check the review details.',
          fields: error.fields
        }
      });
    }

    if (error instanceof ConsentReviewForbiddenError) {
      return res.status(403).json({
        error: {
          code: 'COORDINATOR_ACCESS_REQUIRED',
          message: 'Only an active coordinator may review guardian consent.'
        }
      });
    }

    if (error instanceof ConsentReviewNotFoundError) {
      return res.status(404).json({
        error: {
          code: 'CONSENT_REQUEST_NOT_FOUND',
          message: 'The guardian consent request was not found.'
        }
      });
    }

    if (error instanceof ConsentReviewConflictError) {
      return res.status(409).json({
        error: {
          code: 'CONSENT_REVIEW_CONFLICT',
          message: 'This consent request is no longer available for review.'
        }
      });
    }

    if (error instanceof RegistrationValidationError ||
        error instanceof AuthenticationValidationError) {
      return res.status(400).json({
        error: {
          code: 'VALIDATION_FAILED',
          message: 'Check the highlighted details.',
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

    if (error instanceof AuthenticationFailedError) {
      return res.status(401).json({
        error: {
          code: 'INVALID_CREDENTIALS',
          message: 'The sign-in details are invalid or the account is not yet authorised.'
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
    // session tokens, CSRF tokens or raw exception messages.
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
