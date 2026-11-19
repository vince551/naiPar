const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const REJECTION_REASONS = new Set(['not_relevant', 'capacity', 'procedural', 'other']);

export class DebateValidationError extends Error {
  constructor(fields) { super('Debate request details are invalid'); this.name = 'DebateValidationError'; this.fields = fields; }
}
export class DebateAccessError extends Error {
  constructor() { super('An active delegate or authorised clerk is required'); this.name = 'DebateAccessError'; }
}
export class DebateNotFoundError extends Error {
  constructor() { super('Debate record was not found'); this.name = 'DebateNotFoundError'; }
}
export class DebateConflictError extends Error {
  constructor() { super('Debate request is not available for this action'); this.name = 'DebateConflictError'; }
}

function object(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}
function validateId(value, field) {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) {
    throw new DebateValidationError([field]);
  }
  return value;
}
function validateLimit(value) {
  if (value === undefined || value === null || value === '') return 20;
  const text = String(value);
  if (!/^(?:[1-9]|[1-4][0-9]|50)$/u.test(text)) throw new DebateValidationError(['limit']);
  return Number(text);
}
function validateEmptyBody(payload) {
  const input = object(payload);
  if (Object.keys(input).length) throw new DebateValidationError(['request']);
}
function validateReview(payload) {
  const input = object(payload);
  const errors = [];
  if (input.decision === 'approve') {
    if (Object.keys(input).some(key => !['decision', 'allocatedSeconds'].includes(key))) errors.push('request');
    const seconds = input.allocatedSeconds === undefined ? 120 : input.allocatedSeconds;
    if (!Number.isInteger(seconds) || seconds < 30 || seconds > 600) errors.push('allocatedSeconds');
    if (errors.length) throw new DebateValidationError([...new Set(errors)]);
    return { decision: 'approve', allocatedSeconds: seconds, reasonCode: null };
  }
  if (input.decision === 'reject') {
    if (Object.keys(input).some(key => !['decision', 'reasonCode'].includes(key))) errors.push('request');
    if (!REJECTION_REASONS.has(input.reasonCode)) errors.push('reasonCode');
    if (errors.length) throw new DebateValidationError([...new Set(errors)]);
    return { decision: 'reject', allocatedSeconds: null, reasonCode: input.reasonCode };
  }
  throw new DebateValidationError(['decision']);
}
function formatMotionNumber(value) {
  if (value === null || value === undefined) return null;
  return 'MOT-' + String(value).padStart(6, '0');
}
function mapRequest(row, includeSpeaker = false) {
  const result = {
    id: row.id,
    motionId: row.motion_id,
    motionNumber: formatMotionNumber(row.motion_number),
    motionTitle: row.motion_title,
    status: row.status,
    queuePosition: row.queue_position,
    allocatedSeconds: row.allocated_seconds,
    requestedAt: row.requested_at,
    reviewedAt: row.reviewed_at,
    speakingStartedAt: row.speaking_started_at,
    speakingEndedAt: row.speaking_ended_at,
    reviewReasonCode: row.review_reason_code
  };
  if (includeSpeaker) result.speakerUserId = row.speaker_id;
  return Object.freeze(result);
}
async function transaction(pool, work) {
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
      try { await client.query('ROLLBACK'); } catch { /* preserve original error */ }
    }
    throw error;
  } finally {
    client.release();
  }
}
async function setActor(client, actorUserId) {
  if (typeof actorUserId !== 'string' || !UUID_PATTERN.test(actorUserId)) throw new DebateAccessError();
  await client.query("SELECT set_config('app.actor_user_id', $1, true)", [actorUserId]);
}
async function requireDelegate(client, actorUserId) {
  if (typeof actorUserId !== 'string' || !UUID_PATTERN.test(actorUserId)) throw new DebateAccessError();
  const result = await client.query(
    'SELECT role::text AS role, status::text AS status FROM users WHERE id = $1 FOR SHARE',
    [actorUserId]
  );
  const actor = result.rows?.[0];
  if (!actor || actor.role !== 'delegate' || actor.status !== 'active') throw new DebateAccessError();
  const consent = await client.query(
    "SELECT id FROM guardian_consents WHERE child_user_id = $1 AND status = 'approved' AND withdrawn_at IS NULL ORDER BY created_at DESC LIMIT 1 FOR SHARE",
    [actorUserId]
  );
  if (!consent.rows?.length) throw new DebateAccessError();
}
async function requireClerk(client, actorUserId) {
  if (typeof actorUserId !== 'string' || !UUID_PATTERN.test(actorUserId)) throw new DebateAccessError();
  const result = await client.query(
    'SELECT role::text AS role, status::text AS status FROM users WHERE id = $1 FOR SHARE',
    [actorUserId]
  );
  const actor = result.rows?.[0];
  if (!actor || actor.status !== 'active' || !['clerk', 'admin'].includes(actor.role)) {
    throw new DebateAccessError();
  }
}
async function lockDebatableMotion(client, motionId, requireOpenSitting = true) {
  const result = await client.query(
    'SELECT motion.id, motion.status::text AS status, sitting.status::text AS sitting_status ' +
    'FROM motions AS motion JOIN sittings AS sitting ON sitting.id = motion.sitting_id ' +
    'WHERE motion.id = $1 FOR UPDATE OF motion, sitting',
    [motionId]
  );
  const motion = result.rows?.[0];
  if (!motion) throw new DebateNotFoundError();
  if (motion.status !== 'under_debate') throw new DebateConflictError();
  if (requireOpenSitting && !['published', 'in_progress'].includes(motion.sitting_status)) {
    throw new DebateConflictError();
  }
  return motion;
}
async function requestMotionId(client, requestId) {
  const result = await client.query(
    'SELECT motion_id FROM debate_requests WHERE id = $1',
    [requestId]
  );
  const motionId = result.rows?.[0]?.motion_id;
  if (!motionId) throw new DebateNotFoundError();
  return motionId;
}
async function loadRequestForUpdate(client, requestId) {
  const result = await client.query(
    'SELECT id, motion_id, speaker_id, status::text AS status, requested_at, reviewed_by, reviewed_at, ' +
    'speaking_started_at, speaking_ended_at, allocated_seconds, queue_position, review_reason_code ' +
    'FROM debate_requests WHERE id = $1 FOR UPDATE',
    [requestId]
  );
  const row = result.rows?.[0];
  if (!row) throw new DebateNotFoundError();
  return row;
}
async function audit(client, actorUserId, action, requestId, context, metadata = {}) {
  await client.query(
    "INSERT INTO audit_logs (actor_user_id, action, entity_type, entity_id, request_id, ip_fingerprint, metadata) " +
    "VALUES ($1, $2, 'debate_request', $3, $4, $5, $6::jsonb)",
    [
      actorUserId, action, requestId || null, context.requestId || null,
      context.networkFingerprint || null, JSON.stringify(metadata)
    ]
  );
}
async function event(client, actorUserId, requestId, eventType, fromStatus, toStatus, context, metadata = {}) {
  await client.query(
    'INSERT INTO debate_request_events ' +
    '(debate_request_id, actor_user_id, event_type, from_status, to_status, request_id, metadata) ' +
    'VALUES ($1, $2, $3, $4::debate_request_status, $5::debate_request_status, $6, $7::jsonb)',
    [
      requestId, actorUserId, eventType, fromStatus, toStatus,
      context.requestId || null, JSON.stringify(metadata)
    ]
  );
}

export function createDebateService({ pool }) {
  if (!pool || typeof pool.connect !== 'function') {
    throw new TypeError('Debate service requires a PostgreSQL pool');
  }

  async function requestSpeakerSlot(motionIdValue, payload, context = {}) {
    const motionId = validateId(motionIdValue, 'motionId');
    validateEmptyBody(payload);
    return transaction(pool, async client => {
      await setActor(client, context.actorUserId);
      await requireDelegate(client, context.actorUserId);
      await lockDebatableMotion(client, motionId);

      const existing = await client.query(
        "SELECT id FROM debate_requests WHERE motion_id = $1 AND speaker_id = $2 " +
        "AND status IN ('pending', 'approved', 'completed') LIMIT 1",
        [motionId, context.actorUserId]
      );
      if (existing.rows?.length) throw new DebateConflictError();

      const inserted = await client.query(
        "INSERT INTO debate_requests (motion_id, speaker_id, status) " +
        "VALUES ($1, $2, 'pending') " +
        "RETURNING id, motion_id, speaker_id, status::text AS status, requested_at, reviewed_at, " +
        "speaking_started_at, speaking_ended_at, allocated_seconds, queue_position, review_reason_code",
        [motionId, context.actorUserId]
      );
      const row = inserted.rows?.[0];
      if (!row?.id) throw new Error('Debate request insert returned no identifier');
      await event(client, context.actorUserId, row.id, 'requested', null, 'pending', context);
      await audit(client, context.actorUserId, 'debate_request.requested', row.id, context, { status: 'pending' });
      return mapRequest({ ...row, motion_number: null, motion_title: null });
    });
  }

  async function listOwnRequests(context = {}) {
    return transaction(pool, async client => {
      await requireDelegate(client, context.actorUserId);
      const result = await client.query(
        "SELECT request.id, request.motion_id, motion.motion_number, " +
        "COALESCE(motion.public_title, motion.title) AS motion_title, " +
        "request.status::text AS status, request.queue_position, request.allocated_seconds, " +
        "request.requested_at, request.reviewed_at, request.speaking_started_at, " +
        "request.speaking_ended_at, request.review_reason_code " +
        "FROM debate_requests AS request " +
        "JOIN motions AS motion ON motion.id = request.motion_id " +
        "WHERE request.speaker_id = $1 " +
        "ORDER BY request.requested_at DESC LIMIT $2",
        [context.actorUserId, validateLimit(context.limit)]
      );
      await audit(client, context.actorUserId, 'debate_request.own_listed', null, context, {
        returned: result.rows?.length || 0
      });
      return (result.rows || []).map(row => mapRequest(row));
    });
  }

  async function listClerkQueue(motionIdValue, context = {}) {
    const motionId = validateId(motionIdValue, 'motionId');
    return transaction(pool, async client => {
      await requireClerk(client, context.actorUserId);
      const motion = await client.query(
        'SELECT id FROM motions WHERE id = $1',
        [motionId]
      );
      if (!motion.rows?.length) throw new DebateNotFoundError();

      const result = await client.query(
        "SELECT request.id, request.motion_id, request.speaker_id, motion.motion_number, " +
        "COALESCE(motion.public_title, motion.title) AS motion_title, " +
        "request.status::text AS status, request.queue_position, request.allocated_seconds, " +
        "request.requested_at, request.reviewed_at, request.speaking_started_at, " +
        "request.speaking_ended_at, request.review_reason_code " +
        "FROM debate_requests AS request " +
        "JOIN motions AS motion ON motion.id = request.motion_id " +
        "WHERE request.motion_id = $1 " +
        "ORDER BY request.queue_position NULLS LAST, request.requested_at ASC LIMIT $2",
        [motionId, validateLimit(context.limit)]
      );
      await audit(client, context.actorUserId, 'debate_request.clerk_queue_listed', null, context, {
        returned: result.rows?.length || 0
      });
      return (result.rows || []).map(row => mapRequest(row, true));
    });
  }

  async function reviewRequest(requestIdValue, payload, context = {}) {
    const requestId = validateId(requestIdValue, 'requestId');
    const input = validateReview(payload);
    return transaction(pool, async client => {
      await setActor(client, context.actorUserId);
      await requireClerk(client, context.actorUserId);
      const motionId = await requestMotionId(client, requestId);
      await lockDebatableMotion(client, motionId, input.decision === 'approve');
      const current = await loadRequestForUpdate(client, requestId);
      if (current.status !== 'pending') throw new DebateConflictError();

      let queuePosition = null;
      let nextStatus = 'rejected';
      let allocatedSeconds = current.allocated_seconds;
      if (input.decision === 'approve') {
        const next = await client.query(
          'SELECT COALESCE(MAX(queue_position), 0) + 1 AS next_position ' +
          'FROM debate_requests WHERE motion_id = $1',
          [motionId]
        );
        queuePosition = Number(next.rows?.[0]?.next_position || 1);
        nextStatus = 'approved';
        allocatedSeconds = input.allocatedSeconds;
      }

      const updated = await client.query(
        'UPDATE debate_requests SET status = $2::debate_request_status, reviewed_by = $3, ' +
        'reviewed_at = now(), allocated_seconds = $4, queue_position = $5, review_reason_code = $6 ' +
        'WHERE id = $1 RETURNING id, motion_id, speaker_id, status::text AS status, requested_at, ' +
        'reviewed_at, speaking_started_at, speaking_ended_at, allocated_seconds, queue_position, review_reason_code',
        [requestId, nextStatus, context.actorUserId, allocatedSeconds, queuePosition, input.reasonCode]
      );
      const row = updated.rows?.[0];
      const eventType = input.decision === 'approve' ? 'approved' : 'rejected';
      const action = 'debate_request.' + eventType;
      await event(client, context.actorUserId, requestId, eventType, 'pending', nextStatus, context, {
        queuePosition, allocatedSeconds: input.decision === 'approve' ? allocatedSeconds : null,
        reasonCode: input.reasonCode
      });
      await audit(client, context.actorUserId, action, requestId, context, {
        status: nextStatus, queuePosition,
        allocatedSeconds: input.decision === 'approve' ? allocatedSeconds : null,
        reasonCode: input.reasonCode
      });
      return mapRequest({ ...row, motion_number: null, motion_title: null });
    });
  }

  async function startSpeaker(requestIdValue, payload, context = {}) {
    const requestId = validateId(requestIdValue, 'requestId');
    validateEmptyBody(payload);
    return transaction(pool, async client => {
      await setActor(client, context.actorUserId);
      await requireClerk(client, context.actorUserId);
      const motionId = await requestMotionId(client, requestId);
      await lockDebatableMotion(client, motionId);
      const current = await loadRequestForUpdate(client, requestId);
      if (current.status !== 'approved' || current.speaking_started_at || current.speaking_ended_at) {
        throw new DebateConflictError();
      }

      const active = await client.query(
        "SELECT id FROM debate_requests WHERE motion_id = $1 AND id <> $2 " +
        "AND status = 'approved' AND speaking_started_at IS NOT NULL " +
        "AND speaking_ended_at IS NULL LIMIT 1",
        [motionId, requestId]
      );
      if (active.rows?.length) throw new DebateConflictError();

      const earlier = await client.query(
        "SELECT id FROM debate_requests WHERE motion_id = $1 AND id <> $2 " +
        "AND status = 'approved' AND speaking_started_at IS NULL " +
        "AND queue_position < $3 LIMIT 1",
        [motionId, requestId, current.queue_position]
      );
      if (earlier.rows?.length) throw new DebateConflictError();

      const updated = await client.query(
        'UPDATE debate_requests SET speaking_started_at = now() ' +
        'WHERE id = $1 RETURNING id, motion_id, speaker_id, status::text AS status, requested_at, ' +
        'reviewed_at, speaking_started_at, speaking_ended_at, allocated_seconds, queue_position, review_reason_code',
        [requestId]
      );
      const row = updated.rows?.[0];
      await event(client, context.actorUserId, requestId, 'speaker_started', 'approved', 'approved', context, {
        queuePosition: current.queue_position, allocatedSeconds: current.allocated_seconds
      });
      await audit(client, context.actorUserId, 'debate_request.speaker_started', requestId, context, {
        queuePosition: current.queue_position
      });
      return mapRequest({ ...row, motion_number: null, motion_title: null });
    });
  }

  async function finishSpeaker(requestIdValue, payload, context = {}) {
    const requestId = validateId(requestIdValue, 'requestId');
    validateEmptyBody(payload);
    return transaction(pool, async client => {
      await setActor(client, context.actorUserId);
      await requireClerk(client, context.actorUserId);
      const motionId = await requestMotionId(client, requestId);
      await lockDebatableMotion(client, motionId, false);
      const current = await loadRequestForUpdate(client, requestId);
      if (current.status !== 'approved' || !current.speaking_started_at || current.speaking_ended_at) {
        throw new DebateConflictError();
      }

      const updated = await client.query(
        "UPDATE debate_requests SET status = 'completed', speaking_ended_at = now() " +
        'WHERE id = $1 RETURNING id, motion_id, speaker_id, status::text AS status, requested_at, ' +
        'reviewed_at, speaking_started_at, speaking_ended_at, allocated_seconds, queue_position, review_reason_code',
        [requestId]
      );
      const row = updated.rows?.[0];
      await event(client, context.actorUserId, requestId, 'speaker_finished', 'approved', 'completed', context, {
        queuePosition: current.queue_position, allocatedSeconds: current.allocated_seconds
      });
      await audit(client, context.actorUserId, 'debate_request.speaker_finished', requestId, context, {
        queuePosition: current.queue_position
      });
      return mapRequest({ ...row, motion_number: null, motion_title: null });
    });
  }

  return Object.freeze({
    requestSpeakerSlot,
    listOwnRequests,
    listClerkQueue,
    reviewRequest,
    startSpeaker,
    finishSpeaker
  });
}
