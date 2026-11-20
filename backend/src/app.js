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
  createSittingService,
  SittingConflictError,
  SittingForbiddenError,
  SittingNotFoundError,
  SittingValidationError
} from './domain/sittings.js';
import {
  createMotionService,
  MotionAccessError,
  MotionConflictError,
  MotionNotFoundError,
  MotionValidationError
} from './domain/motions.js';
import {
  createDebateService,
  DebateAccessError,
  DebateConflictError,
  DebateNotFoundError,
  DebateValidationError
} from './domain/debates.js';
import {
  createAdultInvitationService,
  AdultInvitationAccessError,
  AdultInvitationConflictError,
  AdultInvitationInvalidError,
  AdultInvitationNotFoundError,
  AdultInvitationValidationError
} from './domain/adult-invitations.js';
import {
  clearSessionCookie,
  createSessionResolver,
  issueCsrfToken,
  requireCsrf,
  requireSession,
  serializeSessionCookie
} from './security/session.js';

function requireJsonContentType(req, res, next) {
  if (!req.is('application/json')) {
    return res.status(415).json({
      error: { code: 'JSON_REQUIRED', message: 'Send this request as application/json.' }
    });
  }
  return next();
}

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
  const sittings = createSittingService({ pool });
  const motions = createMotionService({ pool });
  const debates = createDebateService({ pool });
  const adultInvitations = createAdultInvitationService({ pool, fieldCrypto, hashPassword: hashPassphrase });
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

  // Public readers receive only published metadata from the narrow database view.
  app.get('/api/v1/public/sittings', async (req, res, next) => {
    try {
      const data = await sittings.listPublicSittings({ limit: req.query.limit });
      res.status(200).json({ data });
    } catch (error) { next(error); }
  });

  const sittingReadAccess = [
    requireSession, requireAuthenticated,
    requireRoles('delegate', 'speaker', 'clerk', 'coordinator', 'admin')
  ];
  const sittingWriteAccess = [
    requireSession, requireAuthenticated, requireRoles('clerk', 'admin')
  ];

  app.get('/api/v1/assembly/sittings', ...sittingReadAccess, async (req, res, next) => {
    try {
      const data = await sittings.listAssemblySittings({
        actorUserId: req.auth.userId, limit: req.query.limit, requestId: req.requestId,
        networkFingerprint: fieldCrypto.fingerprintNetworkAddress(req.ip)
      });
      res.status(200).json({ data });
    } catch (error) { next(error); }
  });

  app.get('/api/v1/assembly/sittings/:sittingId', ...sittingReadAccess, async (req, res, next) => {
    try {
      const data = await sittings.getAssemblySitting(req.params.sittingId, {
        actorUserId: req.auth.userId, requestId: req.requestId,
        networkFingerprint: fieldCrypto.fingerprintNetworkAddress(req.ip)
      });
      res.status(200).json({ data });
    } catch (error) { next(error); }
  });

  app.post('/api/v1/assembly/sittings', ...sittingWriteAccess, requireCsrf, requireJsonContentType, async (req, res, next) => {
    try {
      const data = await sittings.createSitting(req.body, {
        actorUserId: req.auth.userId, requestId: req.requestId,
        networkFingerprint: fieldCrypto.fingerprintNetworkAddress(req.ip)
      });
      res.status(201).json({ data, message: 'Sitting draft created.' });
    } catch (error) { next(error); }
  });

  app.patch('/api/v1/assembly/sittings/:sittingId', ...sittingWriteAccess, requireCsrf, requireJsonContentType, async (req, res, next) => {
    try {
      const data = await sittings.updateSitting(req.params.sittingId, req.body, {
        actorUserId: req.auth.userId, requestId: req.requestId,
        networkFingerprint: fieldCrypto.fingerprintNetworkAddress(req.ip)
      });
      res.status(200).json({ data, message: 'Sitting draft updated.' });
    } catch (error) { next(error); }
  });

  app.post('/api/v1/assembly/sittings/:sittingId/transitions', ...sittingWriteAccess, requireCsrf, requireJsonContentType, async (req, res, next) => {
    try {
      const data = await sittings.transitionSitting(req.params.sittingId, req.body, {
        actorUserId: req.auth.userId, requestId: req.requestId,
        networkFingerprint: fieldCrypto.fingerprintNetworkAddress(req.ip)
      });
      res.status(200).json({ data, message: 'Sitting lifecycle updated.' });
    } catch (error) { next(error); }
  });


  // Public readers receive only reviewed wording from the narrow motion view.
  app.get('/api/v1/public/motions', async (req, res, next) => {
    try {
      const data = await motions.listPublicMotions({ limit: req.query.limit });
      res.status(200).json({ data });
    } catch (error) { next(error); }
  });

  const delegateMotionAccess = [
    requireSession, requireAuthenticated, requireRoles('delegate')
  ];
  const clerkMotionAccess = [
    requireSession, requireAuthenticated, requireRoles('clerk', 'admin')
  ];
  const motionSubmissionLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 5,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    message: {
      error: {
        code: 'MOTION_SUBMISSION_RATE_LIMITED',
        message: 'Too many motion submissions. Please try again later.'
      }
    }
  });

  app.get('/api/v1/assembly/motions/mine', ...delegateMotionAccess, async (req, res, next) => {
    try {
      const data = await motions.listOwnMotions({
        actorUserId: req.auth.userId, limit: req.query.limit,
        requestId: req.requestId,
        networkFingerprint: fieldCrypto.fingerprintNetworkAddress(req.ip)
      });
      res.status(200).json({ data });
    } catch (error) { next(error); }
  });

  app.post('/api/v1/assembly/motions', ...delegateMotionAccess, requireCsrf, requireJsonContentType, motionSubmissionLimiter, async (req, res, next) => {
    try {
      const data = await motions.submitMotion(req.body, {
        actorUserId: req.auth.userId, requestId: req.requestId,
        networkFingerprint: fieldCrypto.fingerprintNetworkAddress(req.ip)
      });
      res.status(201).json({ data, message: 'Motion submitted for clerk review.' });
    } catch (error) { next(error); }
  });

  app.get('/api/v1/clerk/motions', ...clerkMotionAccess, async (req, res, next) => {
    try {
      const data = await motions.listClerkQueue({
        actorUserId: req.auth.userId, limit: req.query.limit,
        requestId: req.requestId,
        networkFingerprint: fieldCrypto.fingerprintNetworkAddress(req.ip)
      });
      res.status(200).json({ data });
    } catch (error) { next(error); }
  });

  app.get('/api/v1/clerk/motions/:motionId', ...clerkMotionAccess, async (req, res, next) => {
    try {
      const data = await motions.getClerkMotion(req.params.motionId, {
        actorUserId: req.auth.userId, requestId: req.requestId,
        networkFingerprint: fieldCrypto.fingerprintNetworkAddress(req.ip)
      });
      res.status(200).json({ data });
    } catch (error) { next(error); }
  });

  app.post('/api/v1/clerk/motions/:motionId/review', ...clerkMotionAccess, requireCsrf, requireJsonContentType, async (req, res, next) => {
    try {
      const data = await motions.reviewMotion(req.params.motionId, req.body, {
        actorUserId: req.auth.userId, requestId: req.requestId,
        networkFingerprint: fieldCrypto.fingerprintNetworkAddress(req.ip)
      });
      res.status(200).json({ data, message: 'Motion review decision recorded.' });
    } catch (error) { next(error); }
  });

  const delegateDebateAccess = [
    requireSession, requireAuthenticated, requireRoles('delegate')
  ];
  const clerkDebateAccess = [
    requireSession, requireAuthenticated, requireRoles('clerk', 'admin')
  ];
  const debateRequestLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 5,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    message: {
      error: {
        code: 'DEBATE_REQUEST_RATE_LIMITED',
        message: 'Too many speaking requests. Please try again later.'
      }
    }
  });

  app.post('/api/v1/assembly/motions/:motionId/debate-requests',
    ...delegateDebateAccess, requireCsrf, requireJsonContentType, debateRequestLimiter,
    async (req, res, next) => {
      try {
        const data = await debates.requestSpeakerSlot(req.params.motionId, req.body, {
          actorUserId: req.auth.userId, requestId: req.requestId,
          networkFingerprint: fieldCrypto.fingerprintNetworkAddress(req.ip)
        });
        res.status(201).json({ data, message: 'Speaking request submitted for clerk review.' });
      } catch (error) { next(error); }
    }
  );

  app.get('/api/v1/assembly/debate-requests/mine', ...delegateDebateAccess, async (req, res, next) => {
    try {
      const data = await debates.listOwnRequests({
        actorUserId: req.auth.userId, limit: req.query.limit,
        requestId: req.requestId,
        networkFingerprint: fieldCrypto.fingerprintNetworkAddress(req.ip)
      });
      res.status(200).json({ data });
    } catch (error) { next(error); }
  });

  app.get('/api/v1/clerk/motions/:motionId/debate-requests', ...clerkDebateAccess, async (req, res, next) => {
    try {
      const data = await debates.listClerkQueue(req.params.motionId, {
        actorUserId: req.auth.userId, limit: req.query.limit,
        requestId: req.requestId,
        networkFingerprint: fieldCrypto.fingerprintNetworkAddress(req.ip)
      });
      res.status(200).json({ data });
    } catch (error) { next(error); }
  });

  app.post('/api/v1/clerk/debate-requests/:requestId/review',
    ...clerkDebateAccess, requireCsrf, requireJsonContentType,
    async (req, res, next) => {
      try {
        const data = await debates.reviewRequest(req.params.requestId, req.body, {
          actorUserId: req.auth.userId, requestId: req.requestId,
          networkFingerprint: fieldCrypto.fingerprintNetworkAddress(req.ip)
        });
        res.status(200).json({ data, message: 'Speaking request reviewed.' });
      } catch (error) { next(error); }
    }
  );

  app.post('/api/v1/clerk/debate-requests/:requestId/start',
    ...clerkDebateAccess, requireCsrf, requireJsonContentType,
    async (req, res, next) => {
      try {
        const data = await debates.startSpeaker(req.params.requestId, req.body, {
          actorUserId: req.auth.userId, requestId: req.requestId,
          networkFingerprint: fieldCrypto.fingerprintNetworkAddress(req.ip)
        });
        res.status(200).json({ data, message: 'Speaker is now on the floor.' });
      } catch (error) { next(error); }
    }
  );

  app.post('/api/v1/clerk/debate-requests/:requestId/finish',
    ...clerkDebateAccess, requireCsrf, requireJsonContentType,
    async (req, res, next) => {
      try {
        const data = await debates.finishSpeaker(req.params.requestId, req.body, {
          actorUserId: req.auth.userId, requestId: req.requestId,
          networkFingerprint: fieldCrypto.fingerprintNetworkAddress(req.ip)
        });
        res.status(200).json({ data, message: 'Speaker turn completed.' });
      } catch (error) { next(error); }
    }
  );

  const adminInvitationAccess = [
    requireSession, requireAuthenticated, requireRoles('admin')
  ];
  const adultInvitationCreateLimiter = rateLimit({
    windowMs: 60 * 60 * 1000,
    limit: 10,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    message: {
      error: {
        code: 'ADULT_INVITATION_RATE_LIMITED',
        message: 'Too many adult invitations have been issued. Please try again later.'
      }
    }
  });
  const adultInvitationAcceptLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 5,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    message: {
      error: {
        code: 'ADULT_INVITATION_ACCEPT_RATE_LIMITED',
        message: 'Too many invitation attempts. Please try again later.'
      }
    }
  });

  app.get('/api/v1/admin/adult-invitations', ...adminInvitationAccess, async (req, res, next) => {
    try {
      const data = await adultInvitations.listInvitations({
        actorUserId: req.auth.userId, limit: req.query.limit,
        requestId: req.requestId,
        networkFingerprint: fieldCrypto.fingerprintNetworkAddress(req.ip)
      });
      res.status(200).json({ data });
    } catch (error) { next(error); }
  });

  app.post('/api/v1/admin/adult-invitations',
    ...adminInvitationAccess, requireCsrf, requireJsonContentType, adultInvitationCreateLimiter,
    async (req, res, next) => {
      try {
        const data = await adultInvitations.createInvitation(req.body, {
          actorUserId: req.auth.userId, requestId: req.requestId,
          networkFingerprint: fieldCrypto.fingerprintNetworkAddress(req.ip)
        });
        res.status(201).json({
          data,
          message: 'Invitation created. Deliver the one-time token through an approved secure channel; it will not be shown again.'
        });
      } catch (error) { next(error); }
    }
  );

  app.post('/api/v1/admin/adult-invitations/:invitationId/revoke',
    ...adminInvitationAccess, requireCsrf, requireJsonContentType,
    async (req, res, next) => {
      try {
        const data = await adultInvitations.revokeInvitation(req.params.invitationId, {
          actorUserId: req.auth.userId, requestId: req.requestId,
          networkFingerprint: fieldCrypto.fingerprintNetworkAddress(req.ip)
        });
        res.status(200).json({ data, message: 'Adult invitation revoked.' });
      } catch (error) { next(error); }
    }
  );

  app.post('/api/v1/auth/adult-invitations/accept',
    requireJsonContentType, adultInvitationAcceptLimiter,
    async (req, res, next) => {
      try {
        const data = await adultInvitations.acceptInvitation(req.body, {
          requestId: req.requestId,
          networkFingerprint: fieldCrypto.fingerprintNetworkAddress(req.ip)
        });
        res.status(201).json({
          data,
          message: 'Adult account activated. Sign in using the invited work email and the password you created.'
        });
      } catch (error) { next(error); }
    }
  );

  const csrfBootstrapLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 20,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    message: {
      error: {
        code: 'CSRF_REFRESH_RATE_LIMITED',
        message: 'Please wait before refreshing session security.'
      }
    }
  });

  // A CSRF token is intentionally re-issued through a JSON POST so a
  // browser form cannot trigger this bootstrap cross-site. The raw token is
  // returned once; only its SHA-256 digest is persisted.
  app.post(
    '/api/v1/auth/csrf',
    csrfBootstrapLimiter,
    requireJsonContentType,
    requireSession,
    requireAuthenticated,
    async (req, res, next) => {
      try {
        const csrfToken = await issueCsrfToken(pool, req.sessionId);
        if (!csrfToken) {
          res.setHeader('Set-Cookie', clearSessionCookie({ secure: secureCookies }));
          return res.status(401).json({
            error: { code: 'SESSION_REQUIRED', message: 'Please sign in to continue.' }
          });
        }
        res.setHeader('Cache-Control', 'no-store');
        res.status(200).json({ data: { csrfToken } });
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

    if (error instanceof AdultInvitationValidationError) {
      return res.status(400).json({
        error: { code: 'ADULT_INVITATION_VALIDATION_FAILED', message: 'Check the invitation details.', fields: error.fields }
      });
    }
    if (error instanceof AdultInvitationAccessError) {
      return res.status(403).json({
        error: { code: 'ADULT_INVITATION_ACCESS_REQUIRED', message: 'Only an active administrator may manage adult invitations.' }
      });
    }
    if (error instanceof AdultInvitationNotFoundError) {
      return res.status(404).json({
        error: { code: 'ADULT_INVITATION_NOT_FOUND', message: 'The invitation was not found.' }
      });
    }
    if (error instanceof AdultInvitationConflictError) {
      return res.status(409).json({
        error: { code: 'ADULT_INVITATION_CONFLICT', message: 'The invitation or account is no longer available for this action.' }
      });
    }
    if (error instanceof AdultInvitationInvalidError) {
      return res.status(400).json({
        error: { code: 'ADULT_INVITATION_INVALID', message: 'The invitation is invalid, expired or already used.' }
      });
    }

    if (error instanceof MotionValidationError) {
      return res.status(400).json({
        error: { code: 'MOTION_VALIDATION_FAILED', message: 'Check the motion details and reviewed public wording.', fields: error.fields }
      });
    }
    if (error instanceof MotionAccessError) {
      return res.status(403).json({
        error: { code: 'MOTION_ACCESS_REQUIRED', message: 'An active delegate or authorised clerk is required.' }
      });
    }
    if (error instanceof MotionNotFoundError) {
      return res.status(404).json({
        error: { code: 'MOTION_NOT_FOUND', message: 'The motion was not found or is not visible to this account.' }
      });
    }
    if (error instanceof MotionConflictError) {
      return res.status(409).json({
        error: { code: 'MOTION_WORKFLOW_CONFLICT', message: 'The motion or sitting has changed and is not eligible for this action.' }
      });
    }

    if (error instanceof DebateValidationError) {
      return res.status(400).json({
        error: { code: 'DEBATE_VALIDATION_FAILED', message: 'Check the speaking request or review details.', fields: error.fields }
      });
    }
    if (error instanceof DebateAccessError) {
      return res.status(403).json({
        error: { code: 'DEBATE_ACCESS_REQUIRED', message: 'An active delegate or authorised clerk is required.' }
      });
    }
    if (error instanceof DebateNotFoundError) {
      return res.status(404).json({
        error: { code: 'DEBATE_REQUEST_NOT_FOUND', message: 'The debate request or motion was not found.' }
      });
    }
    if (error instanceof DebateConflictError) {
      return res.status(409).json({
        error: { code: 'DEBATE_WORKFLOW_CONFLICT', message: 'The request, queue order or floor state has changed.' }
      });
    }

    if (error instanceof SittingValidationError) {
      return res.status(400).json({
        error: { code: 'SITTING_VALIDATION_FAILED', message: 'Check the sitting details.', fields: error.fields }
      });
    }
    if (error instanceof SittingForbiddenError) {
      return res.status(403).json({
        error: { code: 'SITTING_ACCESS_REQUIRED', message: 'An authorised active Assembly account is required.' }
      });
    }
    if (error instanceof SittingNotFoundError) {
      return res.status(404).json({
        error: { code: 'SITTING_NOT_FOUND', message: 'The sitting was not found or is not visible to this account.' }
      });
    }
    if (error instanceof SittingConflictError) {
      return res.status(409).json({
        error: { code: 'SITTING_LIFECYCLE_CONFLICT', message: 'The sitting has changed or is not eligible for this action.' }
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
