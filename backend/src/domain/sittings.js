const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const DATE_TIME_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/u;
const READER_ROLES = new Set(['delegate','speaker','clerk','coordinator','admin']);
const OFFICIAL_ROLES = new Set(['clerk','admin']);
const TRANSITIONS = new Map([
  ['draft', new Set(['published','cancelled'])],
  ['published', new Set(['in_progress','cancelled'])],
  ['in_progress', new Set(['concluded'])],
  ['concluded', new Set()],
  ['cancelled', new Set()]
]);
const EVENT_TYPES = Object.freeze({
  published: 'published', in_progress: 'started', concluded: 'concluded', cancelled: 'cancelled'
});

export class SittingValidationError extends Error {
  constructor(fields) { super('Sitting details are invalid'); this.name = 'SittingValidationError'; this.fields = fields; }
}
export class SittingForbiddenError extends Error {
  constructor() { super('An authorised active Assembly account is required'); this.name = 'SittingForbiddenError'; }
}
export class SittingNotFoundError extends Error {
  constructor() { super('Sitting was not found'); this.name = 'SittingNotFoundError'; }
}
export class SittingConflictError extends Error {
  constructor() { super('Sitting is not available for this action'); this.name = 'SittingConflictError'; }
}

function object(value) { return value && typeof value === 'object' && !Array.isArray(value) ? value : {}; }
function cleanText(value, field, min, max, errors) {
  if (typeof value !== 'string') { errors.push(field); return ''; }
  const cleaned = value.replace(/\s+/gu, ' ').trim();
  if (cleaned.length < min || cleaned.length > max || /[\u0000-\u001f\u007f]/u.test(cleaned)) errors.push(field);
  return cleaned;
}
function cleanVenue(value, field, errors) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string') { errors.push(field); return null; }
  const cleaned = value.replace(/\s+/gu, ' ').trim();
  if (!cleaned) return null;
  if (cleaned.length < 2 || cleaned.length > 200 || /[\u0000-\u001f\u007f]/u.test(cleaned)) errors.push(field);
  return cleaned;
}
function cleanSessionNumber(value, field, errors) {
  if (value === undefined || value === null || value === '') return null;
  if (!Number.isInteger(value) || value < 1 || value > 100000) errors.push(field);
  return Number.isInteger(value) && value >= 1 && value <= 100000 ? value : null;
}
function cleanDate(value, field, errors) {
  if (typeof value !== 'string' || !DATE_TIME_PATTERN.test(value)) { errors.push(field); return null; }
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) { errors.push(field); return null; }
  return date.toISOString();
}
function validateCreate(payload) {
  const input = object(payload), errors = [];
  const allowed = new Set(['title','sessionNumber','scheduledAt','venue']);
  if (Object.keys(input).some(key => !allowed.has(key))) errors.push('request');
  const result = {
    title: cleanText(input.title, 'title', 3, 240, errors),
    sessionNumber: cleanSessionNumber(input.sessionNumber, 'sessionNumber', errors),
    scheduledAt: cleanDate(input.scheduledAt, 'scheduledAt', errors),
    venue: cleanVenue(input.venue, 'venue', errors)
  };
  if (errors.length) throw new SittingValidationError([...new Set(errors)]);
  return result;
}
function validateUpdate(payload) {
  const input = object(payload), errors = [], result = {};
  const allowed = new Set(['title','sessionNumber','scheduledAt','venue']);
  if (!Object.keys(input).length || Object.keys(input).some(key => !allowed.has(key))) errors.push('request');
  if (Object.hasOwn(input, 'title')) result.title = cleanText(input.title, 'title', 3, 240, errors);
  if (Object.hasOwn(input, 'sessionNumber')) result.sessionNumber = cleanSessionNumber(input.sessionNumber, 'sessionNumber', errors);
  if (Object.hasOwn(input, 'scheduledAt')) result.scheduledAt = cleanDate(input.scheduledAt, 'scheduledAt', errors);
  if (Object.hasOwn(input, 'venue')) result.venue = cleanVenue(input.venue, 'venue', errors);
  if (errors.length) throw new SittingValidationError([...new Set(errors)]);
  return result;
}
function validateTransition(payload) {
  const input = object(payload);
  if (Object.keys(input).some(key => key !== 'status') ||
      !['published','in_progress','concluded','cancelled'].includes(input.status)) {
    throw new SittingValidationError(['status']);
  }
  return input.status;
}
function validateId(value) {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) throw new SittingValidationError(['sittingId']);
  return value;
}
function validateLimit(value) {
  if (value === undefined || value === null || value === '') return 20;
  const text = String(value);
  if (!/^(?:[1-9]|[1-4][0-9]|50)$/u.test(text)) throw new SittingValidationError(['limit']);
  return Number(text);
}
function mapSitting(row) {
  return Object.freeze({
    id: row.id, title: row.title, sessionNumber: row.session_number,
    scheduledAt: row.scheduled_at, venue: row.venue, status: row.status,
    publishedAt: row.published_at, concludedAt: row.concluded_at
  });
}
async function transaction(pool, work) {
  const client = await pool.connect(); let committed = false;
  try {
    await client.query('BEGIN');
    const result = await work(client);
    await client.query('COMMIT'); committed = true; return result;
  } catch (error) {
    if (!committed) { try { await client.query('ROLLBACK'); } catch { /* preserve original */ } }
    throw error;
  } finally { client.release(); }
}
async function setActor(client, actorUserId) {
  if (typeof actorUserId !== 'string' || !UUID_PATTERN.test(actorUserId)) throw new SittingForbiddenError();
  await client.query("SELECT set_config('app.actor_user_id', $1, true)", [actorUserId]);
}
async function requireOfficial(client, actorUserId) {
  const result = await client.query(
    'SELECT role::text AS role, status::text AS status FROM users WHERE id = $1 FOR SHARE',
    [actorUserId]
  );
  const actor = result.rows?.[0];
  if (!actor || actor.status !== 'active' || !OFFICIAL_ROLES.has(actor.role)) throw new SittingForbiddenError();
}
async function requireReader(client, actorUserId) {
  const result = await client.query(
    'SELECT u.role::text AS role, u.status::text AS status, ' +
    "EXISTS (SELECT 1 FROM guardian_consents gc WHERE gc.child_user_id = u.id AND gc.status = 'approved' AND gc.withdrawn_at IS NULL) AS guardian_consent_approved " +
    'FROM users u WHERE u.id = $1 FOR SHARE OF u',
    [actorUserId]
  );
  const actor = result.rows?.[0];
  if (!actor || actor.status !== 'active' || !READER_ROLES.has(actor.role) ||
      (actor.role === 'delegate' && actor.guardian_consent_approved !== true)) {
    throw new SittingForbiddenError();
  }
  return actor.role;
}
async function audit(client, actorUserId, action, sittingId, context, metadata = {}) {
  await client.query(
    "INSERT INTO audit_logs (actor_user_id, action, entity_type, entity_id, request_id, ip_fingerprint, metadata) VALUES ($1, $2, 'sitting', $3, $4, $5, $6::jsonb)",
    [actorUserId, action, sittingId, context.requestId || null, context.networkFingerprint || null, JSON.stringify(metadata)]
  );
}
async function event(client, actorUserId, sittingId, eventType, fromStatus, toStatus, context, metadata = {}) {
  await client.query(
    'INSERT INTO sitting_lifecycle_events (sitting_id, actor_user_id, event_type, from_status, to_status, request_id, metadata) VALUES ($1, $2, $3, $4::sitting_status, $5::sitting_status, $6, $7::jsonb)',
    [sittingId, actorUserId, eventType, fromStatus, toStatus, context.requestId || null, JSON.stringify(metadata)]
  );
}

export function createSittingService({ pool }) {
  if (!pool || typeof pool.connect !== 'function' || typeof pool.query !== 'function') {
    throw new TypeError('Sitting service requires a PostgreSQL pool');
  }

  async function listPublicSittings({ limit } = {}) {
    const result = await pool.query(
      'SELECT id, title, session_number, scheduled_at, venue, status::text AS status, published_at, concluded_at ' +
      'FROM public_sitting_summary ORDER BY scheduled_at ASC, id ASC LIMIT $1',
      [validateLimit(limit)]
    );
    return (result.rows || []).map(mapSitting);
  }

  async function listAssemblySittings(context = {}) {
    const limit = validateLimit(context.limit);
    return transaction(pool, async client => {
      const role = await requireReader(client, context.actorUserId);
      const drafts = role === 'clerk' || role === 'admin';
      const result = await client.query(
        "SELECT id, title, session_number, scheduled_at, venue, status::text AS status, published_at, concluded_at FROM sittings " +
        "WHERE ($1::boolean OR status IN ('published','in_progress','concluded')) ORDER BY scheduled_at ASC, id ASC LIMIT $2",
        [drafts, limit]
      );
      await audit(client, context.actorUserId, 'sitting.assembly_listed', null, context, {
        returned: result.rows?.length || 0, includesDrafts: drafts
      });
      return (result.rows || []).map(mapSitting);
    });
  }

  async function getAssemblySitting(idValue, context = {}) {
    const id = validateId(idValue);
    return transaction(pool, async client => {
      const role = await requireReader(client, context.actorUserId);
      const drafts = role === 'clerk' || role === 'admin';
      const result = await client.query(
        "SELECT id, title, session_number, scheduled_at, venue, status::text AS status, published_at, concluded_at FROM sittings " +
        "WHERE id = $1 AND ($2::boolean OR status IN ('published','in_progress','concluded'))",
        [id, drafts]
      );
      const row = result.rows?.[0];
      if (!row) throw new SittingNotFoundError();
      await audit(client, context.actorUserId, 'sitting.details_viewed', id, context, { status: row.status });
      return mapSitting(row);
    });
  }

  async function createSitting(payload, context = {}) {
    const input = validateCreate(payload);
    return transaction(pool, async client => {
      await setActor(client, context.actorUserId);
      await requireOfficial(client, context.actorUserId);
      const result = await client.query(
        "INSERT INTO sittings (title, session_number, scheduled_at, venue, status, created_by) VALUES ($1, $2, $3, $4, 'draft', $5) " +
        'RETURNING id, title, session_number, scheduled_at, venue, status::text AS status, published_at, concluded_at',
        [input.title, input.sessionNumber, input.scheduledAt, input.venue, context.actorUserId]
      );
      const row = result.rows?.[0];
      if (!row?.id) throw new Error('Sitting insert returned no identifier');
      await event(client, context.actorUserId, row.id, 'created', null, 'draft', context);
      await audit(client, context.actorUserId, 'sitting.created', row.id, context, { status: 'draft' });
      return mapSitting(row);
    });
  }

  async function updateSitting(idValue, payload, context = {}) {
    const id = validateId(idValue), input = validateUpdate(payload);
    return transaction(pool, async client => {
      await setActor(client, context.actorUserId);
      await requireOfficial(client, context.actorUserId);
      const currentResult = await client.query(
        'SELECT id, title, session_number, scheduled_at, venue, status::text AS status FROM sittings WHERE id = $1 FOR UPDATE',
        [id]
      );
      const current = currentResult.rows?.[0];
      if (!current) throw new SittingNotFoundError();
      if (current.status !== 'draft') throw new SittingConflictError();
      const values = [
        id,
        Object.hasOwn(input, 'title') ? input.title : current.title,
        Object.hasOwn(input, 'sessionNumber') ? input.sessionNumber : current.session_number,
        Object.hasOwn(input, 'scheduledAt') ? input.scheduledAt : current.scheduled_at,
        Object.hasOwn(input, 'venue') ? input.venue : current.venue
      ];
      const result = await client.query(
        'UPDATE sittings SET title = $2, session_number = $3, scheduled_at = $4, venue = $5, updated_at = now() WHERE id = $1 ' +
        'RETURNING id, title, session_number, scheduled_at, venue, status::text AS status, published_at, concluded_at',
        values
      );
      const row = result.rows?.[0];
      await event(client, context.actorUserId, id, 'updated', 'draft', 'draft', context, { changedFields: Object.keys(input) });
      await audit(client, context.actorUserId, 'sitting.updated', id, context, { changedFields: Object.keys(input) });
      return mapSitting(row);
    });
  }

  async function transitionSitting(idValue, payload, context = {}) {
    const id = validateId(idValue), target = validateTransition(payload);
    return transaction(pool, async client => {
      await setActor(client, context.actorUserId);
      await requireOfficial(client, context.actorUserId);
      const currentResult = await client.query(
        'SELECT id, status::text AS status FROM sittings WHERE id = $1 FOR UPDATE',
        [id]
      );
      const current = currentResult.rows?.[0];
      if (!current) throw new SittingNotFoundError();
      if (!TRANSITIONS.get(current.status)?.has(target)) throw new SittingConflictError();
      const result = await client.query(
        'UPDATE sittings SET status = $2::sitting_status, ' +
        "published_at = CASE WHEN $2 = 'published' THEN now() ELSE published_at END, " +
        "concluded_at = CASE WHEN $2 = 'concluded' THEN now() ELSE concluded_at END, " +
        'updated_at = now() WHERE id = $1 ' +
        'RETURNING id, title, session_number, scheduled_at, venue, status::text AS status, published_at, concluded_at',
        [id, target]
      );
      const row = result.rows?.[0];
      await event(client, context.actorUserId, id, EVENT_TYPES[target], current.status, target, context);
      await audit(client, context.actorUserId, 'sitting.status_changed', id, context, {
        fromStatus: current.status, toStatus: target
      });
      return mapSitting(row);
    });
  }

  return Object.freeze({ listPublicSittings, listAssemblySittings, getAssemblySitting, createSitting, updateSitting, transitionSitting });
}
