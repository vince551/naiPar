const CHILD_ROLES = new Set(['public_child', 'delegate']);
const ALLOWED_FIELDS = new Set(['theme', 'title', 'description']);
const EMAIL_PATTERN = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/iu;
const PHONE_PATTERN = /(?<!\d)(?:\+?254|0)?(?:7|1)\d(?:[\s().-]?\d){7}(?!\d)/u;
const URL_PATTERN = /(?:https?:\/\/|\bwww\.)/iu;

export class ConcernValidationError extends Error {
  constructor(fields) {
    super('Concern details are invalid');
    this.name = 'ConcernValidationError';
    this.fields = fields;
  }
}

export class ConcernAccessError extends Error {
  constructor() {
    super('Concern access is not permitted');
    this.name = 'ConcernAccessError';
  }
}

function cleanField(value, field, min, max, errors, { multiline = false } = {}) {
  if (typeof value !== 'string') {
    errors.push(field);
    return '';
  }

  const cleaned = multiline
    ? value.replace(/\r\n?/gu, '\n').replace(/[\t ]+/gu, ' ').replace(/\n{3,}/gu, '\n\n').trim()
    : value.trim().replace(/\s+/gu, ' ');

  const invalidControls = multiline
    ? /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(cleaned)
    : /[\u0000-\u001f\u007f]/u.test(cleaned);

  if (cleaned.length < min || cleaned.length > max || invalidControls) {
    errors.push(field);
  }
  return cleaned;
}

export function validateConcern(payload) {
  const input = payload && typeof payload === 'object' && !Array.isArray(payload)
    ? payload
    : {};
  const errors = [];

  if (Object.keys(input).some(key => !ALLOWED_FIELDS.has(key))) {
    errors.push('request');
  }

  const theme = cleanField(input.theme, 'theme', 2, 80, errors);
  const title = cleanField(input.title, 'title', 5, 160, errors);
  const description = cleanField(input.description, 'description', 10, 4000, errors, {
    multiline: true
  });

  const combined = [theme, title, description].join('\n');
  if (EMAIL_PATTERN.test(combined) || PHONE_PATTERN.test(combined) || URL_PATTERN.test(combined)) {
    errors.push('description');
  }

  if (errors.length) {
    throw new ConcernValidationError([...new Set(errors)]);
  }

  return Object.freeze({ theme, title, description });
}

function ensureChildAccess(row) {
  if (
    !row ||
    row.status !== 'active' ||
    !CHILD_ROLES.has(row.role) ||
    row.guardian_consent_approved !== true
  ) {
    throw new ConcernAccessError();
  }
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
        // Preserve the original error.
      }
    }
    throw error;
  } finally {
    client.release();
  }
}

async function lockEligibleChild(client, actorUserId) {
  const result = await client.query(
    `SELECT
       u.role::text AS role,
       u.status::text AS status,
       EXISTS (
         SELECT 1
         FROM guardian_consents gc
         WHERE gc.child_user_id = u.id
           AND gc.status = 'approved'
           AND gc.withdrawn_at IS NULL
       ) AS guardian_consent_approved
     FROM users u
     WHERE u.id = $1
     FOR UPDATE`,
    [actorUserId]
  );
  const row = result.rows?.[0];
  ensureChildAccess(row);
}

export function createConcernService({ pool }) {
  if (!pool || typeof pool.connect !== 'function') {
    throw new TypeError('A PostgreSQL pool is required');
  }

  async function submitConcern(payload, {
    actorUserId,
    requestId,
    networkFingerprint
  } = {}) {
    const input = validateConcern(payload);
    if (typeof actorUserId !== 'string' || !actorUserId) {
      throw new ConcernAccessError();
    }

    return withTransaction(pool, async client => {
      await lockEligibleChild(client, actorUserId);

      const inserted = await client.query(
        `INSERT INTO concerns (
           submitted_by, theme, title, description, is_public
         ) VALUES ($1, $2, $3, $4, false)
         RETURNING id, theme, title, status::text AS status, created_at`,
        [actorUserId, input.theme, input.title, input.description]
      );
      const concern = inserted.rows?.[0];
      if (!concern?.id) throw new Error('Concern insert returned no identifier');

      await client.query(
        `INSERT INTO audit_logs (
           actor_user_id, action, entity_type, entity_id,
           request_id, ip_fingerprint, metadata
         ) VALUES (
           $1, 'concern.submitted', 'concern', $2, $3, $4, $5::jsonb
         )`,
        [
          actorUserId,
          concern.id,
          requestId || null,
          networkFingerprint || null,
          JSON.stringify({ theme: input.theme, visibility: 'private' })
        ]
      );

      return Object.freeze({
        id: concern.id,
        theme: concern.theme,
        title: concern.title,
        status: concern.status,
        createdAt: concern.created_at
      });
    });
  }

  async function listOwnConcerns({
    actorUserId,
    requestId,
    networkFingerprint
  } = {}) {
    if (typeof actorUserId !== 'string' || !actorUserId) {
      throw new ConcernAccessError();
    }

    return withTransaction(pool, async client => {
      await lockEligibleChild(client, actorUserId);

      const result = await client.query(
        `SELECT
           id, theme, title, description,
           status::text AS status, created_at, updated_at
         FROM concerns
         WHERE submitted_by = $1
         ORDER BY created_at DESC
         LIMIT 50`,
        [actorUserId]
      );
      const rows = result.rows || [];

      await client.query(
        `INSERT INTO audit_logs (
           actor_user_id, action, entity_type, entity_id,
           request_id, ip_fingerprint, metadata
         ) VALUES (
           $1, 'concern.owner_listed', 'concern_collection', NULL, $2, $3, $4::jsonb
         )`,
        [
          actorUserId,
          requestId || null,
          networkFingerprint || null,
          JSON.stringify({ recordCount: rows.length })
        ]
      );

      return rows.map(row => Object.freeze({
        id: row.id,
        theme: row.theme,
        title: row.title,
        description: row.description,
        status: row.status,
        createdAt: row.created_at,
        updatedAt: row.updated_at
      }));
    });
  }

  return Object.freeze({ submitConcern, listOwnConcerns });
}
