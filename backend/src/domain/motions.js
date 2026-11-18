const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const REVIEW_DECISIONS = new Set(['schedule_debate', 'refer_to_committee', 'reject']);
const REJECTION_REASONS = new Set(['out_of_scope', 'duplicate', 'insufficient_detail', 'procedural']);

export class MotionValidationError extends Error {
  constructor(fields) { super('Motion details are invalid'); this.name = 'MotionValidationError'; this.fields = fields; }
}
export class MotionAccessError extends Error {
  constructor() { super('An authorised active delegate or clerk is required'); this.name = 'MotionAccessError'; }
}
export class MotionNotFoundError extends Error {
  constructor() { super('Motion was not found'); this.name = 'MotionNotFoundError'; }
}
export class MotionConflictError extends Error {
  constructor() { super('Motion is not available for this action'); this.name = 'MotionConflictError'; }
}

function object(value) { return value && typeof value === 'object' && !Array.isArray(value) ? value : {}; }
function cleanText(value, field, min, max, errors) {
  if (typeof value !== 'string') { errors.push(field); return ''; }
  const cleaned = value.replace(/\s+/gu, ' ').trim();
  if (cleaned.length < min || cleaned.length > max || /[\u0000-\u001f\u007f]/u.test(cleaned)) errors.push(field);
  return cleaned;
}
function containsContactDetails(value) {
  return /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/iu.test(value)
    || /(?:\+?254|0)(?:7|1)\d{8}\b/u.test(value)
    || /(?:https?:\/\/|www\.)/iu.test(value);
}
function validateId(value, field = 'motionId') {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) throw new MotionValidationError([field]);
  return value;
}
function validateLimit(value) {
  if (value === undefined || value === null || value === '') return 20;
  const text = String(value);
  if (!/^(?:[1-9]|[1-4][0-9]|50)$/u.test(text)) throw new MotionValidationError(['limit']);
  return Number(text);
}
function validateSubmission(payload) {
  const input = object(payload), errors = [];
  const allowed = new Set(['sittingId', 'title', 'description']);
  if (Object.keys(input).some(key => !allowed.has(key))) errors.push('request');
  const result = {
    sittingId: input.sittingId,
    title: cleanText(input.title, 'title', 5, 240, errors),
    description: cleanText(input.description, 'description', 10, 12000, errors)
  };
  try { result.sittingId = validateId(input.sittingId, 'sittingId'); }
  catch { errors.push('sittingId'); }
  if (errors.length) throw new MotionValidationError([...new Set(errors)]);
  return result;
}
function validateReview(payload) {
  const input = object(payload), errors = [];
  const allowed = new Set(['decision', 'publicTitle', 'publicSummary', 'committee', 'reasonCode']);
  if (Object.keys(input).some(key => !allowed.has(key)) || !REVIEW_DECISIONS.has(input.decision)) {
    throw new MotionValidationError(['request']);
  }
  const result = { decision: input.decision };
  if (input.decision === 'reject') {
    if (Object.hasOwn(input, 'publicTitle') || Object.hasOwn(input, 'publicSummary') || Object.hasOwn(input, 'committee')) {
      errors.push('request');
    }
    if (!REJECTION_REASONS.has(input.reasonCode)) errors.push('reasonCode');
    else result.reasonCode = input.reasonCode;
  } else {
    result.publicTitle = cleanText(input.publicTitle, 'publicTitle', 5, 160, errors);
    result.publicSummary = cleanText(input.publicSummary, 'publicSummary', 20, 1200, errors);
    if (containsContactDetails(result.publicTitle)) errors.push('publicTitle');
    if (containsContactDetails(result.publicSummary)) errors.push('publicSummary');
    if (input.decision === 'refer_to_committee') {
      result.committee = cleanText(input.committee, 'committee', 2, 120, errors);
    } else if (Object.hasOwn(input, 'committee') && input.committee !== null && input.committee !== '') {
      result.committee = cleanText(input.committee, 'committee', 2, 120, errors);
    } else {
      result.committee = null;
    }
    if (Object.hasOwn(input, 'reasonCode')) errors.push('request');
  }
  if (errors.length) throw new MotionValidationError([...new Set(errors)]);
  return result;
}
function formatNumber(value) {
  if (value === null || value === undefined) return null;
  return 'MOT-' + String(value).padStart(6, '0');
}
function mapPublicMotion(row) {
  return Object.freeze({
    id: row.id, motionNumber: formatNumber(row.motion_number), sittingId: row.sitting_id,
    title: row.title, summary: row.summary, committee: row.committee,
    status: row.status, submittedAt: row.submitted_at, reviewedAt: row.reviewed_at
  });
}
function mapMotion(row) {
  return Object.freeze({
    id: row.id, motionNumber: formatNumber(row.motion_number), sittingId: row.sitting_id,
    title: row.title, description: row.description, status: row.status,
    committee: row.committee, proposedByUserId: row.proposed_by,
    publicTitle: row.public_title, publicSummary: row.public_summary,
    submittedAt: row.submitted_at, reviewedAt: row.reviewed_at,
    reviewReasonCode: row.review_reason_code
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
  if (typeof actorUserId !== 'string' || !UUID_PATTERN.test(actorUserId)) throw new MotionAccessError();
  await client.query("SELECT set_config('app.actor_user_id', $1, true)", [actorUserId]);
}
async function requireDelegate(client, actorUserId) {
  const result = await client.query(
    'SELECT role::text AS role, status::text AS status FROM users WHERE id = $1 FOR SHARE',
    [actorUserId]
  );
  const actor = result.rows?.[0];
  if (!actor || actor.role !== 'delegate' || actor.status !== 'active') throw new MotionAccessError();
  const consent = await client.query(
    "SELECT id FROM guardian_consents WHERE child_user_id = $1 AND status = 'approved' AND withdrawn_at IS NULL ORDER BY created_at DESC LIMIT 1 FOR SHARE",
    [actorUserId]
  );
  if (!consent.rows?.length) throw new MotionAccessError();
}
async function requireClerk(client, actorUserId) {
  const result = await client.query(
    'SELECT role::text AS role, status::text AS status FROM users WHERE id = $1 FOR SHARE',
    [actorUserId]
  );
  const actor = result.rows?.[0];
  if (!actor || actor.status !== 'active' || !['clerk', 'admin'].includes(actor.role)) {
    throw new MotionAccessError();
  }
}
async function requireSittingOpen(client, sittingId) {
  const result = await client.query(
    'SELECT status::text AS status FROM sittings WHERE id = $1 FOR SHARE',
    [sittingId]
  );
  const status = result.rows?.[0]?.status;
  if (!['published', 'in_progress'].includes(status)) throw new MotionConflictError();
}
async function audit(client, actorUserId, action, motionId, context, metadata = {}) {
  await client.query(
    "INSERT INTO audit_logs (actor_user_id, action, entity_type, entity_id, request_id, ip_fingerprint, metadata) VALUES ($1, $2, 'motion', $3, $4, $5, $6::jsonb)",
    [actorUserId, action, motionId, context.requestId || null, context.networkFingerprint || null, JSON.stringify(metadata)]
  );
}
async function event(client, actorUserId, motionId, eventType, fromStatus, toStatus, context, metadata = {}) {
  await client.query(
    'INSERT INTO motion_lifecycle_events (motion_id, actor_user_id, event_type, from_status, to_status, request_id, metadata) VALUES ($1, $2, $3, $4::motion_status, $5::motion_status, $6, $7::jsonb)',
    [motionId, actorUserId, eventType, fromStatus, toStatus, context.requestId || null, JSON.stringify(metadata)]
  );
}

export function createMotionService({ pool }) {
  if (!pool || typeof pool.connect !== 'function' || typeof pool.query !== 'function') {
    throw new TypeError('Motion service requires a PostgreSQL pool');
  }

  async function listPublicMotions({ limit } = {}) {
    const result = await pool.query(
      'SELECT id, motion_number, sitting_id, title, summary, committee, status::text AS status, submitted_at, reviewed_at ' +
      'FROM public_motion_summary ORDER BY motion_number DESC LIMIT $1',
      [validateLimit(limit)]
    );
    return (result.rows || []).map(mapPublicMotion);
  }

  async function submitMotion(payload, context = {}) {
    const input = validateSubmission(payload);
    return transaction(pool, async client => {
      await setActor(client, context.actorUserId);
      await requireDelegate(client, context.actorUserId);
      await requireSittingOpen(client, input.sittingId);
      const result = await client.query(
        "INSERT INTO motions (sitting_id, title, description, proposed_by, status, submitted_at) VALUES ($1, $2, $3, $4, 'submitted', now()) " +
        'RETURNING id, motion_number, sitting_id, title, description, proposed_by, status::text AS status, committee, public_title, public_summary, submitted_at, reviewed_at, review_reason_code',
        [input.sittingId, input.title, input.description, context.actorUserId]
      );
      const row = result.rows?.[0];
      if (!row?.id) throw new Error('Motion insert returned no identifier');
      await event(client, context.actorUserId, row.id, 'submitted', null, 'submitted', context);
      await audit(client, context.actorUserId, 'motion.submitted', row.id, context, { status: 'submitted' });
      return mapMotion(row);
    });
  }

  async function listOwnMotions(context = {}) {
    return transaction(pool, async client => {
      await requireDelegate(client, context.actorUserId);
      const result = await client.query(
        'SELECT id, motion_number, sitting_id, title, description, proposed_by, status::text AS status, committee, public_title, public_summary, submitted_at, reviewed_at, review_reason_code ' +
        'FROM motions WHERE proposed_by = $1 ORDER BY created_at DESC LIMIT $2',
        [context.actorUserId, validateLimit(context.limit)]
      );
      await audit(client, context.actorUserId, 'motion.own_listed', null, context, { returned: result.rows?.length || 0 });
      return (result.rows || []).map(mapMotion);
    });
  }

  async function listClerkQueue(context = {}) {
    return transaction(pool, async client => {
      await requireClerk(client, context.actorUserId);
      const result = await client.query(
        "SELECT id, motion_number, sitting_id, title, description, proposed_by, status::text AS status, committee, public_title, public_summary, submitted_at, reviewed_at, review_reason_code " +
        "FROM motions WHERE status = 'submitted' ORDER BY submitted_at ASC, motion_number ASC LIMIT $1",
        [validateLimit(context.limit)]
      );
      await audit(client, context.actorUserId, 'motion.review_queue_listed', null, context, { returned: result.rows?.length || 0 });
      return (result.rows || []).map(mapMotion);
    });
  }

  async function getClerkMotion(idValue, context = {}) {
    const id = validateId(idValue);
    return transaction(pool, async client => {
      await requireClerk(client, context.actorUserId);
      const result = await client.query(
        'SELECT id, motion_number, sitting_id, title, description, proposed_by, status::text AS status, committee, public_title, public_summary, submitted_at, reviewed_at, review_reason_code ' +
        'FROM motions WHERE id = $1',
        [id]
      );
      const row = result.rows?.[0];
      if (!row) throw new MotionNotFoundError();
      await audit(client, context.actorUserId, 'motion.details_viewed', id, context, { status: row.status });
      return mapMotion(row);
    });
  }

  async function reviewMotion(idValue, payload, context = {}) {
    const id = validateId(idValue), input = validateReview(payload);
    return transaction(pool, async client => {
      await setActor(client, context.actorUserId);
      await requireClerk(client, context.actorUserId);
      const currentResult = await client.query(
        'SELECT id, sitting_id, status::text AS status FROM motions WHERE id = $1 FOR UPDATE',
        [id]
      );
      const current = currentResult.rows?.[0];
      if (!current) throw new MotionNotFoundError();
      if (current.status !== 'submitted') throw new MotionConflictError();

      let status, publicTitle = null, publicSummary = null, committee = null, reasonCode = null;
      if (input.decision === 'schedule_debate') {
        status = 'under_debate'; publicTitle = input.publicTitle; publicSummary = input.publicSummary; committee = input.committee;
      } else if (input.decision === 'refer_to_committee') {
        status = 'committee_review'; publicTitle = input.publicTitle; publicSummary = input.publicSummary; committee = input.committee;
      } else {
        status = 'rejected'; reasonCode = input.reasonCode;
      }
      if (status !== 'rejected') await requireSittingOpen(client, current.sitting_id);

      const result = await client.query(
        'UPDATE motions SET status = $2::motion_status, committee = $3, public_title = $4, public_summary = $5, ' +
        'reviewed_by = $6, reviewed_at = now(), review_reason_code = $7, updated_at = now() WHERE id = $1 ' +
        'RETURNING id, motion_number, sitting_id, title, description, proposed_by, status::text AS status, committee, public_title, public_summary, submitted_at, reviewed_at, review_reason_code',
        [id, status, committee, publicTitle, publicSummary, context.actorUserId, reasonCode]
      );
      const row = result.rows?.[0];
      await event(client, context.actorUserId, id, 'reviewed', 'submitted', status, context, { decision: input.decision });
      await audit(client, context.actorUserId, 'motion.reviewed', id, context, { decision: input.decision, status });
      return mapMotion(row);
    });
  }

  return Object.freeze({ listPublicMotions, submitMotion, listOwnMotions, listClerkQueue, getClerkMotion, reviewMotion });
}
