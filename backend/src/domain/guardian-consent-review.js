const CHILD_ROLES = new Set(['public_child', 'delegate']);
const VERIFICATION_METHODS = new Set(['in_person', 'verified_call', 'document_review', 'guardian_otp']);
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const EVIDENCE_REFERENCE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{7,127}$/u;

export class ConsentReviewValidationError extends Error {
  constructor(fields) {
    super('Guardian consent review details are invalid');
    this.name = 'ConsentReviewValidationError';
    this.fields = fields;
  }
}

export class ConsentReviewForbiddenError extends Error {
  constructor() {
    super('An active coordinator is required');
    this.name = 'ConsentReviewForbiddenError';
  }
}

export class ConsentReviewNotFoundError extends Error {
  constructor() {
    super('Guardian consent request was not found');
    this.name = 'ConsentReviewNotFoundError';
  }
}

export class ConsentReviewConflictError extends Error {
  constructor() {
    super('Guardian consent request is no longer reviewable');
    this.name = 'ConsentReviewConflictError';
  }
}

function validateConsentId(value) {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) {
    throw new ConsentReviewValidationError(['consentId']);
  }
  return value;
}

function validateReview(payload) {
  const input = payload && typeof payload === 'object' && !Array.isArray(payload)
    ? payload
    : {};
  const fields = [];
  const decision = input.decision;
  const verificationMethod = input.verificationMethod;
  const evidenceReference = typeof input.evidenceReference === 'string'
    ? input.evidenceReference.trim()
    : '';

  if (!['approved', 'rejected'].includes(decision)) fields.push('decision');
  if (!VERIFICATION_METHODS.has(verificationMethod)) fields.push('verificationMethod');
  if (verificationMethod === 'guardian_otp') {
    if (evidenceReference && !EVIDENCE_REFERENCE_PATTERN.test(evidenceReference)) fields.push('evidenceReference');
  } else if (!EVIDENCE_REFERENCE_PATTERN.test(evidenceReference)) {
    fields.push('evidenceReference');
  }

  if (fields.length) {
    throw new ConsentReviewValidationError([...new Set(fields)]);
  }

  return Object.freeze({ decision, verificationMethod, evidenceReference });
}

async function withTransaction(pool, work) {
  const client = await pool.connect();
  let committed = false;

  try {
    await client.query('BEGIN');
    const result = await work(client);
    await client.query('COMMIT');
    committed = true;
    return result;
  } catch (error) {
    if (!committed) {
      try {
        await client.query('ROLLBACK');
      } catch {
        // Preserve the original failure.
      }
    }
    throw error;
  } finally {
    client.release();
  }
}

async function requireActiveCoordinator(client, actorUserId) {
  const result = await client.query(
    `SELECT id, county
     FROM users
     WHERE id = $1
       AND role = 'coordinator'
       AND status = 'active'
     FOR SHARE`,
    [actorUserId]
  );

  const coordinator = result.rows?.[0];
  if (!coordinator?.county) throw new ConsentReviewForbiddenError();
  return coordinator.county;
}

async function writeAudit(client, {
  actorUserId,
  action,
  entityType,
  entityId = null,
  requestId,
  networkFingerprint,
  metadata = {}
}) {
  await client.query(
    `INSERT INTO audit_logs (
      actor_user_id,
      action,
      entity_type,
      entity_id,
      request_id,
      ip_fingerprint,
      metadata
    ) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)`,
    [
      actorUserId,
      action,
      entityType,
      entityId,
      requestId || null,
      networkFingerprint || null,
      JSON.stringify(metadata)
    ]
  );
}

export function createGuardianConsentReviewService({ pool, fieldCrypto }) {
  if (!pool || !fieldCrypto || typeof fieldCrypto.decryptField !== 'function') {
    throw new TypeError('Guardian consent review dependencies are incomplete');
  }

  async function listReviewQueue({ actorUserId, requestId, networkFingerprint }) {
    return withTransaction(pool, async client => {
      const coordinatorCounty = await requireActiveCoordinator(client, actorUserId);

      const result = await client.query(
        `SELECT
          gc.id,
          gc.status::text AS status,
          gc.consent_text_version,
          gc.created_at
        FROM guardian_consents gc
        JOIN users u ON u.id = gc.child_user_id
        WHERE gc.status IN ('pending', 'rejected')
          AND u.county = $1
        ORDER BY gc.created_at ASC
        LIMIT 100`,
        [coordinatorCounty]
      );

      await writeAudit(client, {
        actorUserId,
        action: 'guardian.consent_queue_viewed',
        entityType: 'guardian_consent_queue',
        requestId,
        networkFingerprint,
        metadata: { returned: result.rows?.length || 0 }
      });

      return (result.rows || []).map(row => Object.freeze({
        consentId: row.id,
        status: row.status,
        consentNoticeVersion: row.consent_text_version,
        createdAt: row.created_at
      }));
    });
  }

  async function getReviewDetails(consentIdValue, {
    actorUserId,
    requestId,
    networkFingerprint
  } = {}) {
    const consentId = validateConsentId(consentIdValue);

    return withTransaction(pool, async client => {
      const coordinatorCounty = await requireActiveCoordinator(client, actorUserId);

      const result = await client.query(
        `SELECT
          gc.id,
          gc.status::text AS consent_status,
          gc.consent_text_version,
          gc.created_at,
          gc.consent_document_storage_key,
          gc.guardian_name_ciphertext,
          gc.guardian_phone_ciphertext,
          u.full_name_ciphertext,
          u.age,
          u.school_ciphertext,
          u.county,
          u.ward
        FROM guardian_consents gc
        JOIN users u ON u.id = gc.child_user_id
        WHERE gc.id = $1
          AND u.county = $2
        FOR SHARE OF gc, u`,
        [consentId, coordinatorCounty]
      );

      const row = result.rows?.[0];
      if (!row) throw new ConsentReviewNotFoundError();
      if (!['pending', 'rejected'].includes(row.consent_status)) {
        throw new ConsentReviewConflictError();
      }

      // This is the only endpoint that decrypts child/guardian identity for
      // review. Its read is audited before the data is returned to the caller.
      await writeAudit(client, {
        actorUserId,
        action: 'guardian.consent_review_details_viewed',
        entityType: 'guardian_consent',
        entityId: consentId,
        requestId,
        networkFingerprint,
        metadata: { consentStatus: row.consent_status }
      });

      return Object.freeze({
        consentId: row.id,
        status: row.consent_status,
        consentNoticeVersion: row.consent_text_version,
        createdAt: row.created_at,
        consentDocumentAvailable: Boolean(row.consent_document_storage_key),
        child: Object.freeze({
          fullName: fieldCrypto.decryptField(row.full_name_ciphertext),
          age: row.age,
          school: fieldCrypto.decryptField(row.school_ciphertext),
          county: row.county,
          ward: row.ward
        }),
        guardian: Object.freeze({
          name: fieldCrypto.decryptField(row.guardian_name_ciphertext),
          phone: fieldCrypto.decryptField(row.guardian_phone_ciphertext)
        })
      });
    });
  }

  async function reviewConsent(consentIdValue, payload, {
    actorUserId,
    requestId,
    networkFingerprint
  } = {}) {
    const consentId = validateConsentId(consentIdValue);
    const input = validateReview(payload);

    return withTransaction(pool, async client => {
      const coordinatorCounty = await requireActiveCoordinator(client, actorUserId);

      const consentResult = await client.query(
        `SELECT
          gc.id,
          gc.child_user_id,
          gc.status::text AS consent_status,
          gc.guardian_phone_verified_at,
          gc.guardian_phone_verification_challenge_id,
          u.role::text AS child_role,
          u.status::text AS account_status
        FROM guardian_consents gc
        JOIN users u ON u.id = gc.child_user_id
        WHERE gc.id = $1
          AND u.county = $2
        FOR UPDATE OF gc, u`,
        [consentId, coordinatorCounty]
      );

      const consent = consentResult.rows?.[0];
      if (!consent) throw new ConsentReviewNotFoundError();
      if (
        !['pending', 'rejected'].includes(consent.consent_status) ||
        !CHILD_ROLES.has(consent.child_role) ||
        consent.account_status !== 'pending'
      ) {
        throw new ConsentReviewConflictError();
      }

      if (
        input.verificationMethod === 'guardian_otp' &&
        (!consent.guardian_phone_verified_at || !consent.guardian_phone_verification_challenge_id)
      ) {
        throw new ConsentReviewConflictError();
      }

      const evidenceReference = input.verificationMethod === 'guardian_otp'
        ? consent.guardian_phone_verification_challenge_id
        : input.evidenceReference;

      const reviewResult = await client.query(
        `INSERT INTO guardian_consent_reviews (
          consent_id,
          reviewed_by,
          decision,
          verification_method,
          evidence_reference
        ) VALUES ($1, $2, $3, $4, $5)
        RETURNING id`,
        [
          consentId,
          actorUserId,
          input.decision,
          input.verificationMethod,
          evidenceReference
        ]
      );

      const reviewId = reviewResult.rows?.[0]?.id;
      if (!reviewId) throw new Error('Guardian consent review insert returned no identifier');

      const updatedConsent = await client.query(
        `UPDATE guardian_consents
         SET
           status = $2::consent_status,
           reviewed_by = $3,
           reviewed_at = now(),
           granted_at = CASE WHEN $2 = 'approved' THEN now() ELSE NULL END,
           withdrawn_at = NULL,
           latest_review_id = $4
         WHERE id = $1
         RETURNING status::text AS status, reviewed_at, granted_at`,
        [consentId, input.decision, actorUserId, reviewId]
      );

      if (!updatedConsent.rows?.[0]) throw new ConsentReviewConflictError();

      let accountStatus = 'pending';
      if (input.decision === 'approved') {
        const activated = await client.query(
          `UPDATE users
           SET status = 'active'
           WHERE id = $1
             AND status = 'pending'
             AND role IN ('public_child', 'delegate')
           RETURNING id`,
          [consent.child_user_id]
        );
        if (!activated.rows?.[0]) throw new ConsentReviewConflictError();
        accountStatus = 'active';
      }

      await writeAudit(client, {
        actorUserId,
        action: input.decision === 'approved'
          ? 'guardian.consent_approved'
          : 'guardian.consent_rejected',
        entityType: 'guardian_consent',
        entityId: consentId,
        requestId,
        networkFingerprint,
        metadata: {
          decision: input.decision,
          verificationMethod: input.verificationMethod
        }
      });

      return Object.freeze({
        consentId,
        status: updatedConsent.rows[0].status,
        accountStatus,
        reviewedAt: updatedConsent.rows[0].reviewed_at
      });
    });
  }

  return Object.freeze({
    listReviewQueue,
    getReviewDetails,
    reviewConsent
  });
}
