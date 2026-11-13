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
  createGuardianPhoneVerificationService,
  GuardianOtpProviderUnavailableError,
  GuardianOtpValidationError,
  GuardianOtpVerificationFailedError
} from './domain/guardian-phone-verification.js';
import {
  createGuardianConsentReviewService,
  ConsentReviewConflictError,
  ConsentReviewForbiddenError,
  ConsentReviewNotFoundError,
  ConsentReviewValidationError
} from './domain/guardian-consent-review.js';
import {
  createConcernService,
  ConcernAccessError,
  ConcernValidationError
} from './domain/concerns.js';
import {
  createConcernModerationService,
  ConcernModerationConflictError,
  ConcernModerationForbiddenError,
  ConcernModerationNotFoundError,
  ConcernModerationValidationError
} from './domain/concern-moderation.js';
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
  dummyCredentialHash,
  smsGateway
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
  const concerns = createConcernService({ pool, fieldCrypto });
  const concernModeration = createConcernModerationService({ pool, fieldCrypto });
  const guardianPhoneVerification = createGuardianPhoneVerificationService({
    pool,
    fieldCrypto,
    otpPepper: config.guardianOtpPepper,
    smsGateway
  });
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

  const guardianOtpRequestLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 3,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    message: {
      error: {
        code: 'OTP_REQUEST_RATE_LIMITED',
        message: 'Too many verification requests. Please try again later.'
      }
    }
  });

  const guardianOtpVerifyLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 10,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    message: {
      error: {
        code: 'OTP_VERIFY_RATE_LIMITED',
        message: 'Too many verification attempts. Please try again later.'
      }
    }
  });

  app.post(
    '/api/v1/auth/guardian-phone-verification/request',
    guardianOtpRequestLimiter,
    async (req, res, next) => {
      try {
        const data = await guardianPhoneVerification.requestCode(req.body, {
          requestId: req.requestId,
          networkFingerprint: fieldCrypto.fingerprintNetworkAddress(req.ip)
        });
        res.status(202).json({
          data,
          message: 'If the registration details match, a verification code will be sent to the registered guardian phone.'
        });
      } catch (error) {
        next(error);
      }
    }
  );

  app.post(
    '/api/v1/auth/guardian-phone-verification/verify',
    guardianOtpVerifyLimiter,
    async (req, res, next) => {
      try {
        const data = await guardianPhoneVerification.verifyCode(req.body, {
          requestId: req.requestId,
          networkFingerprint: fieldCrypto.fingerprintNetworkAddress(req.ip)
        });
        res.status(200).json({ data });
      } catch (error) {
        next(error);
      }
    }
  );

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

  const childParticipationAccess = [
    requireSession,
    requireAuthenticated,
    requireRoles('public_child', 'delegate')
  ];

  const concernSubmissionLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 5,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    message: {
      error: {
        code: 'CONCERN_SUBMISSION_RATE_LIMITED',
        message: 'Too many submissions. Please try again later.'
      }
    }
  });

  app.post(
    '/api/v1/participation/concerns',
    ...childParticipationAccess,
    requireCsrf,
    concernSubmissionLimiter,
    async (req, res, next) => {
      try {
        const data = await concerns.submitConcern(req.body, {
          actorUserId: req.auth.userId,
          requestId: req.requestId,
          networkFingerprint: fieldCrypto.fingerprintNetworkAddress(req.ip)
        });
        res.status(201).json({
          data,
          message: 'Your concern was submitted privately for review.'
        });
      } catch (error) {
        next(error);
      }
    }
  );

  app.get(
    '/api/v1/participation/my-concerns',
    ...childParticipationAccess,
    async (req, res, next) => {
      try {
        const data = await concerns.listOwnConcerns({
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
    '/api/v1/coordinator/concerns',
    ...coordinatorReviewAccess,
    async (req, res, next) => {
      try {
        const data = await concernModeration.listReviewQueue({
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
    '/api/v1/coordinator/concerns/:concernId',
    ...coordinatorReviewAccess,
    async (req, res, next) => {
      try {
        const data = await concernModeration.getConcernDetails(req.params.concernId, {
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
    '/api/v1/coordinator/concerns/:concernId/moderation',
    ...coordinatorReviewAccess,
    requireCsrf,
    async (req, res, next) => {
      try {
        const data = await concernModeration.moderateConcern(
          req.params.concernId,
          req.body,
          {
            actorUserId: req.auth.userId,
            requestId: req.requestId,
            networkFingerprint: fieldCrypto.fingerprintNetworkAddress(req.ip)
          }
        );
        res.status(200).json({ data, message: 'Concern moderation decision recorded.' });
      } catch (error) {
        next(error);
      }
    }
  );

  app.post(
    '/api/v1/coordinator/concerns/:concernId/publish',
    ...coordinatorReviewAccess,
    requireCsrf,
    async (req, res, next) => {
      try {
        const data = await concernModeration.publishConcern(
          req.params.concernId,
          req.body,
          {
            actorUserId: req.auth.userId,
            requestId: req.requestId,
            networkFingerprint: fieldCrypto.fingerprintNetworkAddress(req.ip)
          }
        );
        res.status(200).json({ data, message: 'De-identified public summary approved.' });
      } catch (error) {
        next(error);
      }
    }
  );

  app.post(
    '/api/v1/coordinator/concerns/:concernId/unpublish',
    ...coordinatorReviewAccess,
    requireCsrf,
    async (req, res, next) => {
      try {
        const data = await concernModeration.unpublishConcern(req.params.concernId, {
          actorUserId: req.auth.userId,
          requestId: req.requestId,
          networkFingerprint: fieldCrypto.fingerprintNetworkAddress(req.ip)
        });
        res.status(200).json({ data, message: 'Public concern summary withdrawn.' });
      } catch (error) {
        next(error);
      }
    }
  );

  // This endpoint reads only the database's de-identified public projection.
  // It never queries raw concern narratives or submitter records.
  app.get('/api/v1/public/concerns', async (_req, res, next) => {
    try {
      const data = await concernModeration.listPublicConcerns();
      res.status(200).json({ data });
    } catch (error) {
      next(error);
    }
  });

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
    if (error instanceof GuardianOtpValidationError) {
      return res.status(400).json({
        error: {
          code: 'GUARDIAN_OTP_VALIDATION_FAILED',
          message: 'Check the guardian verification details.',
          fields: error.fields
        }
      });
    }

    if (error instanceof GuardianOtpProviderUnavailableError) {
      return res.status(503).json({
        error: {
          code: 'GUARDIAN_OTP_UNAVAILABLE',
          message: 'Guardian phone verification is not configured. Please contact the Assembly Secretariat.'
        }
      });
    }

    if (error instanceof GuardianOtpVerificationFailedError) {
      return res.status(400).json({
        error: {
          code: 'GUARDIAN_OTP_INVALID',
          message: 'The code is invalid, expired or could not be verified.'
        }
      });
    }

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

    if (error instanceof ConcernModerationValidationError) {
      return res.status(400).json({
        error: {
          code: 'CONCERN_MODERATION_VALIDATION_FAILED',
          message: 'Check the moderation details and remove private contact information from public wording.',
          fields: error.fields
        }
      });
    }

    if (error instanceof ConcernModerationForbiddenError) {
      return res.status(403).json({
        error: {
          code: 'COORDINATOR_CONCERN_ACCESS_REQUIRED',
          message: 'Only an active coordinator assigned to this county may review concerns.'
        }
      });
    }

    if (error instanceof ConcernModerationNotFoundError) {
      return res.status(404).json({
        error: {
          code: 'CONCERN_NOT_FOUND',
          message: 'The concern was not found in your county review scope.'
        }
      });
    }

    if (error instanceof ConcernModerationConflictError) {
      return res.status(409).json({
        error: {
          code: 'CONCERN_MODERATION_CONFLICT',
          message: 'The concern has changed or is not eligible for this moderation action.'
        }
      });
    }

    if (error instanceof ConcernValidationError) {
      return res.status(400).json({
        error: {
          code: 'CONCERN_VALIDATION_FAILED',
          message: 'Check the concern details and remove private contact information.',
          fields: error.fields
        }
      });
    }

    if (error instanceof ConcernAccessError) {
      return res.status(403).json({
        error: {
          code: 'CHILD_PARTICIPATION_ACCESS_REQUIRED',
          message: 'Only an active child or delegate with approved guardian consent may access private concerns.'
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
