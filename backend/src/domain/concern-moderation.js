const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const EMAIL_PATTERN = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/iu;
const PHONE_PATTERN = /(?<!\d)(?:\+?254|0)?(?:7|1)\d(?:[\s().-]?\d){7}(?!\d)/u;
const URL_PATTERN = /(?:https?:\/\/|\bwww\.)/iu;

const ALLOWED_TRANSITIONS = new Map([
  ['submitted', new Set(['under_review', 'escalated', 'referred_to_safeguarding'])],
  ['under_review', new Set(['consolidated', 'escalated', 'responded', 'closed', 'referred_to_safeguarding'])],
  ['consolidated', new Set(['escalated', 'responded', 'closed', 'referred_to_safeguarding'])],
  ['escalated', new Set(['under_review', 'responded', 'closed', 'referred_to_safeguarding'])],
  ['responded', new Set(['under_review', 'closed', 'referred_to_safeguarding'])],
  ['closed', new Set()],
  ['referred_to_safeguarding', new Set()]
]);

export class ConcernModerationValidationError extends Error {
  constructor(fields) {
    super('Concern moderation details are invalid');
    this.name = 'ConcernModerationValidationError';
    this.fields = fields;
  }
}

export class ConcernModerationForbiddenError extends Error {
  constructor() {
    super('An active coordinator assigned to this county is required');
    this.name = 'ConcernModerationForbiddenError';
  }
}

export class ConcernModerationNotFoundError extends Error {
  constructor() {
    super('Concern was not found');
    this.name = 'ConcernModerationNotFoundError';
  }
}

export class ConcernModerationConflictError extends Error {
  constructor() {
    super('Concern is not available for this moderation action');
    this.name = 'ConcernModerationConflictError';
  }
}

function validateConcernId(value) {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) {
    throw new ConcernModerationValidationError(['concernId']);
  }
  return value;
}

function cleanText(value, field, min, max, fields) {
  if (typeof value !== 'string') {
    fields.push(field);
    return '';
  }
  const cleaned = value.replace(/\r\n?/gu, '\n').trim();
  if (
    cleaned.length < min ||
    cleaned.length > max ||
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(cleaned)
  ) {
    fields.push(field);
  }
  return cleaned;
}

function rejectContactDetails(value, field, fields) {
  if (EMAIL_PATTERN.test(value) || PHONE_PATTERN.test(value) || URL_PATTERN.test(value)) {
    fields.push(field);
  }
}

function validateModeration(payload) {
  const input = payload && typeof payload === 'object' && !Array.isArray(payload)
    ? payload
    : {};
  const fields = [];

  if (Object.keys(input).some(key => !['decision', 'internalNote'].includes(key))) {
    fields.push('request');
  }

  const decision = input.decision;
  if (!ALLOWED_TRANSITIONS.size || ![...ALLOWED_TRANSITIONS.values()].some(set => set.has(decision))) {
    fields.push('decision');
  }

  let internalNote = null;
  if (input.internalNote !== undefined && input.internalNote !== null && input.internalNote !== '') {
    internalNote = cleanText(input.internalNote, 'internalNote', 3, 2000, fields);
  }

  if (fields.length) throw new ConcernModerationValidationError([...new Set(fields)]);
  return Object.freeze({ decision, internalNote });
}

function validatePublication(payload) {
  const input = payload && typeof payload === 'object' && !Array.isArray(payload)
    ? payload
    : {};
  const fields = [];

  if (Object.keys(input).some(key => !['publicTheme', 'publicTitle'].includes(key))) {
    fields.push('request');
  }

  const publicTheme = cleanText(input.publicTheme, 'publicTheme', 2, 80, fields);
  const publicTitle = cleanText(input.publicTitle, 'publicTitle', 5, 160, fields);
  rejectContactDetails(publicTheme, 'publicTheme', fields);
  rejectContactDetails(publicTitle, 'publicTitle', fields);

  if (fields.length) throw new ConcernModerationValidationError([...new Set(fields)]);
  return Object.freeze({ publicTheme, publicTitle });
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

async function setActorContext(client, actorUserId) {
  if (typeof actorUserId !== 'string' || !UUID_PATTERN.test(actorUserId)) {
    throw new ConcernModerationForbiddenError();
  }
  await client.query(
    "SELECT set_config('app.actor_user_id', $1, true)",
    [actorUserId]
  );
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
  if (!coordinator?.county) throw new ConcernModerationForbiddenError();
  return coordinator.county;
}

async function writeAudit(client, {
  actorUserId,
  action,
  entityId,
  requestId,
  networkFingerprint,
  metadata = {}
}) {
  await client.query(
    `INSERT INTO audit_logs (
       actor_user_id, action, entity_type, entity_id,
       request_id, ip_fingerprint, metadata
     ) VALUES ($1, $2, 'concern', $3, $4, $5, $6::jsonb)`,
    [
      actorUserId,
      action,
      entityId,
      requestId || null,
      networkFingerprint || null,
      JSON.stringify(metadata)
    ]
  );
}

async function requireRecentDetailRead(client, concernId, actorUserId) {
  const result = await client.query(
    `SELECT EXISTS (
       SELECT 1
       FROM audit_logs
       WHERE actor_user_id = $1
         AND entity_type = 'concern'
         AND entity_id = $2
         AND action = 'concern.moderation_details_viewed'
         AND created_at >= now() - interval '30 minutes'
     ) AS viewed`,
    [actorUserId, concernId]
  );
  if (result.rows?.[0]?.viewed !== true) {
    throw new ConcernModerationConflictError();
  }
}

async function insertModerationEvent(client, {
  concernId,
  actorUserId,
  eventType,
  fromStatus,
  toStatus,
  internalNoteCiphertext = null
}) {
  await client.query(
    `INSERT INTO concern_moderation_events (
       concern_id, actor_user_id, event_type, from_status, to_status,
       internal_note_ciphertext
     ) VALUES ($1, $2, $3, $4::concern_status, $5::concern_status, $6)`,
    [concernId, actorUserId, eventType, fromStatus, toStatus, internalNoteCiphertext]
  );
}

export function createConcernModerationService({ pool, fieldCrypto }) {
  if (
    !pool ||
    typeof pool.connect !== 'function' ||
    typeof pool.query !== 'function' ||
    typeof fieldCrypto?.encryptField !== 'function' ||
    typeof fieldCrypto?.decryptField !== 'function'
  ) {
    throw new TypeError('Concern moderation dependencies are incomplete');
  }

  async function listReviewQueue({
    actorUserId,
    requestId,
    networkFingerprint
  } = {}) {
    return withTransaction(pool, async client => {
      const county = await requireActiveCoordinator(client, actorUserId);
      const result = await client.query(
        `SELECT
           c.id,
           c.status::text AS status,
           c.created_at,
           c.updated_at,
           (c.assigned_coordinator = $1) AS assigned_to_me
         FROM concerns c
         WHERE c.county = $2
           AND c.status NOT IN ('closed', 'referred_to_safeguarding')
           AND (c.assigned_coordinator IS NULL OR c.assigned_coordinator = $1)
         ORDER BY c.created_at ASC
         LIMIT 100`,
        [actorUserId, county]
      );

      await writeAudit(client, {
        actorUserId,
        action: 'concern.moderation_queue_viewed',
        entityId: null,
        requestId,
        networkFingerprint,
        metadata: { returned: result.rows?.length || 0 }
      });

      return (result.rows || []).map(row => Object.freeze({
        concernId: row.id,
        status: row.status,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        assignedToMe: row.assigned_to_me === true
      }));
    });
  }

  async function getConcernDetails(concernIdValue, {
    actorUserId,
    requestId,
    networkFingerprint
  } = {}) {
    const concernId = validateConcernId(concernIdValue);

    return withTransaction(pool, async client => {
      const county = await requireActiveCoordinator(client, actorUserId);
      const result = await client.query(
        `SELECT
           c.id,
           c.status::text AS status,
           c.created_at,
           c.updated_at,
           c.county,
           c.sub_county,
           c.ward,
           c.assigned_coordinator,
           c.is_public,
           c.public_theme,
           c.public_title,
           c.theme_ciphertext,
           c.title_ciphertext,
           c.description_ciphertext,
           latest.internal_note_ciphertext
         FROM concerns c
         LEFT JOIN LATERAL (
           SELECT e.internal_note_ciphertext
           FROM concern_moderation_events e
           WHERE e.concern_id = c.id
             AND e.internal_note_ciphertext IS NOT NULL
           ORDER BY e.created_at DESC
           LIMIT 1
         ) latest ON true
         WHERE c.id = $1
           AND c.county = $2
           AND c.status NOT IN ('closed', 'referred_to_safeguarding')
           AND (
             c.assigned_coordinator IS NULL
             OR c.assigned_coordinator = $3
             OR c.status IN ('consolidated', 'responded')
           )
         FOR SHARE OF c`,
        [concernId, county, actorUserId]
      );
      const row = result.rows?.[0];
      if (!row) throw new ConcernModerationNotFoundError();

      await writeAudit(client, {
        actorUserId,
        action: 'concern.moderation_details_viewed',
        entityId: concernId,
        requestId,
        networkFingerprint,
        metadata: { status: row.status }
      });

      return Object.freeze({
        concernId: row.id,
        status: row.status,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        location: Object.freeze({
          county: row.county,
          subCounty: row.sub_county,
          ward: row.ward
        }),
        privateContent: Object.freeze({
          theme: fieldCrypto.decryptField(row.theme_ciphertext),
          title: fieldCrypto.decryptField(row.title_ciphertext),
          description: fieldCrypto.decryptField(row.description_ciphertext)
        }),
        latestInternalNote: row.internal_note_ciphertext
          ? fieldCrypto.decryptField(row.internal_note_ciphertext)
          : null,
        publication: Object.freeze({
          isPublic: row.is_public,
          theme: row.public_theme,
          title: row.public_title
        }),
        assignedToMe: row.assigned_coordinator === actorUserId
      });
    });
  }

  async function moderateConcern(concernIdValue, payload, {
    actorUserId,
    requestId,
    networkFingerprint
  } = {}) {
    const concernId = validateConcernId(concernIdValue);
    const input = validateModeration(payload);

    return withTransaction(pool, async client => {
      await setActorContext(client, actorUserId);
      const county = await requireActiveCoordinator(client, actorUserId);
      const result = await client.query(
        `SELECT id, status::text AS status, assigned_coordinator, is_public
         FROM concerns
         WHERE id = $1 AND county = $2
         FOR UPDATE`,
        [concernId, county]
      );
      const row = result.rows?.[0];
      if (!row || row.status === 'referred_to_safeguarding') {
        throw new ConcernModerationNotFoundError();
      }
      if (row.assigned_coordinator && row.assigned_coordinator !== actorUserId) {
        throw new ConcernModerationConflictError();
      }
      if (!ALLOWED_TRANSITIONS.get(row.status)?.has(input.decision)) {
        throw new ConcernModerationConflictError();
      }

      const unpublish = row.is_public && !['consolidated', 'responded'].includes(input.decision);
      const updated = await client.query(
        `UPDATE concerns
         SET status = $2::concern_status,
             assigned_coordinator = COALESCE(assigned_coordinator, $3),
             last_moderated_by = $3,
             last_moderated_at = now(),
             is_public = CASE WHEN $4 THEN false ELSE is_public END,
             public_theme = CASE WHEN $4 THEN NULL ELSE public_theme END,
             public_title = CASE WHEN $4 THEN NULL ELSE public_title END,
             updated_at = now()
         WHERE id = $1
         RETURNING id, status::text AS status, updated_at`,
        [concernId, input.decision, actorUserId, unpublish]
      );

      await insertModerationEvent(client, {
        concernId,
        actorUserId,
        eventType: 'status_change',
        fromStatus: row.status,
        toStatus: input.decision,
        internalNoteCiphertext: input.internalNote
          ? fieldCrypto.encryptField(input.internalNote)
          : null
      });

      if (unpublish) {
        await insertModerationEvent(client, {
          concernId,
          actorUserId,
          eventType: 'unpublished',
          fromStatus: row.status,
          toStatus: input.decision
        });
      }

      await writeAudit(client, {
        actorUserId,
        action: 'concern.moderated',
        entityId: concernId,
        requestId,
        networkFingerprint,
        metadata: {
          fromStatus: row.status,
          toStatus: input.decision,
          unpublished: unpublish,
          internalNoteEncrypted: Boolean(input.internalNote)
        }
      });

      return Object.freeze({
        concernId: updated.rows[0].id,
        status: updated.rows[0].status,
        updatedAt: updated.rows[0].updated_at,
        isPublic: row.is_public === true && !unpublish
      });
    });
  }

  async function publishConcern(concernIdValue, payload, {
    actorUserId,
    requestId,
    networkFingerprint
  } = {}) {
    const concernId = validateConcernId(concernIdValue);
    const input = validatePublication(payload);

    return withTransaction(pool, async client => {
      await setActorContext(client, actorUserId);
      const county = await requireActiveCoordinator(client, actorUserId);
      await requireRecentDetailRead(client, concernId, actorUserId);
      const result = await client.query(
        `SELECT id, status::text AS status, assigned_coordinator,
                last_moderated_by, is_public
         FROM concerns
         WHERE id = $1 AND county = $2
         FOR UPDATE`,
        [concernId, county]
      );
      const row = result.rows?.[0];
      if (!row || row.status === 'referred_to_safeguarding') {
        throw new ConcernModerationNotFoundError();
      }
      if (
        row.is_public ||
        !['consolidated', 'responded'].includes(row.status) ||
        !row.assigned_coordinator ||
        !row.last_moderated_by ||
        row.last_moderated_by === actorUserId
      ) {
        throw new ConcernModerationConflictError();
      }

      const updated = await client.query(
        `UPDATE concerns
         SET is_public = true,
             public_theme = $2,
             public_title = $3,
             published_by = $4,
             published_at = now(),
             updated_at = now()
         WHERE id = $1
         RETURNING id, status::text AS status, public_theme, public_title, published_at`,
        [concernId, input.publicTheme, input.publicTitle, actorUserId]
      );

      await insertModerationEvent(client, {
        concernId,
        actorUserId,
        eventType: 'published',
        fromStatus: row.status,
        toStatus: row.status
      });

      await writeAudit(client, {
        actorUserId,
        action: 'concern.publication_approved',
        entityId: concernId,
        requestId,
        networkFingerprint,
        metadata: { secondReviewer: true, redactedProjection: true }
      });

      return Object.freeze({
        concernId: updated.rows[0].id,
        status: updated.rows[0].status,
        publicTheme: updated.rows[0].public_theme,
        publicTitle: updated.rows[0].public_title,
        publishedAt: updated.rows[0].published_at
      });
    });
  }

  async function unpublishConcern(concernIdValue, {
    actorUserId,
    requestId,
    networkFingerprint
  } = {}) {
    const concernId = validateConcernId(concernIdValue);

    return withTransaction(pool, async client => {
      await setActorContext(client, actorUserId);
      const county = await requireActiveCoordinator(client, actorUserId);
      const result = await client.query(
        `SELECT id, status::text AS status, is_public
         FROM concerns
         WHERE id = $1 AND county = $2
         FOR UPDATE`,
        [concernId, county]
      );
      const row = result.rows?.[0];
      if (!row) throw new ConcernModerationNotFoundError();
      if (!row.is_public) throw new ConcernModerationConflictError();

      await client.query(
        `UPDATE concerns
         SET is_public = false,
             public_theme = NULL,
             public_title = NULL,
             updated_at = now()
         WHERE id = $1`,
        [concernId]
      );

      await insertModerationEvent(client, {
        concernId,
        actorUserId,
        eventType: 'unpublished',
        fromStatus: row.status,
        toStatus: row.status
      });

      await writeAudit(client, {
        actorUserId,
        action: 'concern.unpublished',
        entityId: concernId,
        requestId,
        networkFingerprint,
        metadata: { publicProjectionCleared: true }
      });

      return Object.freeze({ concernId, isPublic: false });
    });
  }

  async function listPublicConcerns() {
    const result = await pool.query(
      `SELECT id, theme, title, status, created_at
       FROM public_concern_summary
       ORDER BY created_at DESC
       LIMIT 50`
    );
    return (result.rows || []).map(row => Object.freeze({
      concernId: row.id,
      theme: row.theme,
      title: row.title,
      status: row.status,
      createdAt: row.created_at
    }));
  }

  return Object.freeze({
    listReviewQueue,
    getConcernDetails,
    moderateConcern,
    publishConcern,
    unpublishConcern,
    listPublicConcerns
  });
}
