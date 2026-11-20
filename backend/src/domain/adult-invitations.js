import { createHash, randomBytes } from 'node:crypto';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/u;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u;
const INVITABLE_ROLES = new Set(['clerk', 'coordinator', 'stakeholder']);

export class AdultInvitationValidationError extends Error {
  constructor(fields) {
    super('Adult invitation details are invalid');
    this.name = 'AdultInvitationValidationError';
    this.fields = fields;
  }
}
export class AdultInvitationAccessError extends Error {
  constructor() {
    super('An active administrator is required');
    this.name = 'AdultInvitationAccessError';
  }
}
export class AdultInvitationNotFoundError extends Error {
  constructor() {
    super('Adult invitation was not found');
    this.name = 'AdultInvitationNotFoundError';
  }
}
export class AdultInvitationConflictError extends Error {
  constructor() {
    super('Adult invitation is not available for this action');
    this.name = 'AdultInvitationConflictError';
  }
}
export class AdultInvitationInvalidError extends Error {
  constructor() {
    super('Adult invitation is invalid or no longer available');
    this.name = 'AdultInvitationInvalidError';
  }
}

function object(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}
function cleanText(value, field, min, max, errors) {
  if (typeof value !== 'string') {
    errors.push(field);
    return '';
  }
  const cleaned = value.replace(/\s+/gu, ' ').trim();
  if (cleaned.length < min || cleaned.length > max || /[\u0000-\u001f\u007f]/u.test(cleaned)) {
    errors.push(field);
  }
  return cleaned;
}
function validateId(value, field) {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) {
    throw new AdultInvitationValidationError([field]);
  }
  return value;
}
function validateLimit(value) {
  if (value === undefined || value === null || value === '') return 20;
  const text = String(value);
  if (!/^(?:[1-9]|[1-4][0-9]|50)$/u.test(text)) {
    throw new AdultInvitationValidationError(['limit']);
  }
  return Number(text);
}
function validateCreate(payload) {
  const input = object(payload);
  const errors = [];
  const allowed = new Set(['email', 'role', 'county', 'organisation']);
  if (Object.keys(input).some(key => !allowed.has(key))) errors.push('request');

  const email = typeof input.email === 'string' ? input.email.trim().toLowerCase() : '';
  if (email.length < 5 || email.length > 254 || !EMAIL_PATTERN.test(email)) errors.push('email');
  if (!INVITABLE_ROLES.has(input.role)) errors.push('role');

  const county = input.county === undefined || input.county === null || input.county === ''
    ? null
    : cleanText(input.county, 'county', 2, 100, errors);
  const organisation = input.organisation === undefined || input.organisation === null || input.organisation === ''
    ? null
    : cleanText(input.organisation, 'organisation', 2, 200, errors);

  if (['clerk', 'coordinator'].includes(input.role) && !county) errors.push('county');
  if (input.role === 'stakeholder' && !organisation) errors.push('organisation');
  if (errors.length) throw new AdultInvitationValidationError([...new Set(errors)]);

  return Object.freeze({ email, role: input.role, county, organisation });
}
function validateAccept(payload) {
  const input = object(payload);
  const errors = [];
  if (Object.keys(input).some(key => !['token', 'fullName', 'password'].includes(key))) errors.push('request');
  if (typeof input.token !== 'string' || !TOKEN_PATTERN.test(input.token)) errors.push('token');

  const fullName = cleanText(input.fullName, 'fullName', 2, 160, errors);
  const password = typeof input.password === 'string' ? input.password : '';
  if (
    password.length < 12 ||
    password.length > 128 ||
    /[\u0000-\u001f\u007f]/u.test(password)
  ) errors.push('password');

  if (errors.length) throw new AdultInvitationValidationError([...new Set(errors)]);
  return Object.freeze({ token: input.token, fullName, password });
}
function digestToken(token) {
  return createHash('sha256').update(token, 'utf8').digest();
}
function mapInvitation(row) {
  return Object.freeze({
    id: row.id,
    email: row.email_normalized,
    role: row.role || row.invited_role,
    county: row.county,
    organisation: row.organisation,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
    acceptedAt: row.accepted_at || null,
    revokedAt: row.revoked_at || null
  });
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
  if (typeof actorUserId !== 'string' || !UUID_PATTERN.test(actorUserId)) {
    throw new AdultInvitationAccessError();
  }
  await client.query("SELECT set_config('app.actor_user_id', $1, true)", [actorUserId]);
}
async function requireAdmin(client, actorUserId) {
  const result = await client.query(
    'SELECT role::text AS role, status::text AS status FROM users WHERE id = $1 FOR SHARE',
    [actorUserId]
  );
  const actor = result.rows?.[0];
  if (!actor || actor.role !== 'admin' || actor.status !== 'active') {
    throw new AdultInvitationAccessError();
  }
}
async function writeEvent(client, invitationId, actorUserId, eventType, fromState, toState, context, metadata = {}) {
  await client.query(
    'INSERT INTO adult_invitation_events ' +
    '(invitation_id, actor_user_id, event_type, from_state, to_state, request_id, metadata) ' +
    'VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)',
    [invitationId, actorUserId, eventType, fromState, toState, context.requestId || null, JSON.stringify(metadata)]
  );
}
async function writeAudit(client, invitationId, actorUserId, action, context, metadata = {}) {
  await client.query(
    "INSERT INTO audit_logs (actor_user_id, action, entity_type, entity_id, request_id, ip_fingerprint, metadata) " +
    "VALUES ($1, $2, 'adult_account_invitation', $3, $4, $5, $6::jsonb)",
    [
      actorUserId, action, invitationId || null, context.requestId || null,
      context.networkFingerprint || null, JSON.stringify(metadata)
    ]
  );
}

export function createAdultInvitationService({ pool, fieldCrypto, hashPassword }) {
  if (
    !pool || typeof pool.connect !== 'function' ||
    !fieldCrypto || typeof fieldCrypto.encryptField !== 'function' ||
    typeof hashPassword !== 'function'
  ) {
    throw new TypeError('Adult invitation dependencies are incomplete');
  }

  async function createInvitation(payload, context = {}) {
    const input = validateCreate(payload);
    const actorUserId = context.actorUserId;
    const token = randomBytes(32).toString('base64url');
    const tokenHash = digestToken(token);

    const invitation = await transaction(pool, async client => {
      await setActor(client, actorUserId);
      await requireAdmin(client, actorUserId);

      const existing = await client.query(
        'SELECT id, (expires_at > now()) AS is_live FROM adult_account_invitations ' +
        'WHERE email_normalized = $1 AND accepted_at IS NULL AND revoked_at IS NULL FOR UPDATE',
        [input.email]
      );
      const pending = existing.rows?.[0];
      if (pending?.is_live) throw new AdultInvitationConflictError();
      if (pending) {
        await client.query(
          'UPDATE adult_account_invitations SET revoked_at = now() WHERE id = $1',
          [pending.id]
        );
        await writeEvent(client, pending.id, actorUserId, 'revoked', 'pending', 'revoked', context, {
          reason: 'expired_replaced'
        });
        await writeAudit(client, pending.id, actorUserId, 'adult_invitation.revoked', context, {
          reason: 'expired_replaced'
        });
      }

      const existingAccount = await client.query(
        'SELECT id FROM users WHERE email_normalized = $1 LIMIT 1',
        [input.email]
      );
      if (existingAccount.rows?.length) throw new AdultInvitationConflictError();

      const inserted = await client.query(
        'INSERT INTO adult_account_invitations ' +
        '(email_normalized, invited_role, county, organisation, token_hash, invited_by, expires_at) ' +
        "VALUES ($1, $2::account_role, $3, $4, $5, $6, now() + interval '48 hours') " +
        'RETURNING id, email_normalized, invited_role::text AS role, county, organisation, expires_at, created_at',
        [input.email, input.role, input.county, input.organisation, tokenHash, actorUserId]
      );
      const row = inserted.rows?.[0];
      if (!row?.id) throw new Error('Adult invitation insert returned no identifier');
      await writeEvent(client, row.id, actorUserId, 'issued', null, 'pending', context, { role: input.role });
      await writeAudit(client, row.id, actorUserId, 'adult_invitation.issued', context, { role: input.role });
      return row;
    });

    // The bearer token is returned once to the authenticated administrator.
    // Only its SHA-256 digest is stored; it must never be logged or re-displayed.
    return Object.freeze({ ...mapInvitation(invitation), invitationToken: token });
  }

  async function listInvitations(context = {}) {
    return transaction(pool, async client => {
      await setActor(client, context.actorUserId);
      await requireAdmin(client, context.actorUserId);
      const result = await client.query(
        'SELECT id, email_normalized, invited_role::text AS role, county, organisation, ' +
        'expires_at, accepted_at, revoked_at, created_at ' +
        'FROM adult_account_invitations ' +
        'WHERE accepted_at IS NULL AND revoked_at IS NULL AND expires_at > now() ' +
        'ORDER BY created_at DESC LIMIT $1',
        [validateLimit(context.limit)]
      );
      await writeAudit(client, null, context.actorUserId, 'adult_invitation.listed', context, {
        returned: result.rows?.length || 0
      });
      return (result.rows || []).map(mapInvitation);
    });
  }

  async function revokeInvitation(idValue, context = {}) {
    const invitationId = validateId(idValue, 'invitationId');
    return transaction(pool, async client => {
      await setActor(client, context.actorUserId);
      await requireAdmin(client, context.actorUserId);
      const selected = await client.query(
        'SELECT id, email_normalized, invited_role::text AS role, county, organisation, ' +
        'expires_at, accepted_at, revoked_at, created_at, (expires_at > now()) AS is_live ' +
        'FROM adult_account_invitations WHERE id = $1 FOR UPDATE',
        [invitationId]
      );
      const current = selected.rows?.[0];
      if (!current) throw new AdultInvitationNotFoundError();
      if (current.accepted_at || current.revoked_at || !current.is_live) {
        throw new AdultInvitationConflictError();
      }
      const updated = await client.query(
        'UPDATE adult_account_invitations SET revoked_at = now() WHERE id = $1 ' +
        'RETURNING id, email_normalized, invited_role::text AS role, county, organisation, expires_at, accepted_at, revoked_at, created_at',
        [invitationId]
      );
      await writeEvent(client, invitationId, context.actorUserId, 'revoked', 'pending', 'revoked', context);
      await writeAudit(client, invitationId, context.actorUserId, 'adult_invitation.revoked', context, {});
      return mapInvitation(updated.rows?.[0]);
    });
  }

  async function acceptInvitation(payload, context = {}) {
    const input = validateAccept(payload);
    const passwordHash = await hashPassword(input.password);
    if (typeof passwordHash !== 'string' || !passwordHash.startsWith('$argon2id$')) {
      throw new TypeError('Adult passwords must be hashed with Argon2id');
    }
    const tokenHash = digestToken(input.token);
    try {
      return await transaction(pool, async client => {
        const selected = await client.query(
          'SELECT id, email_normalized, invited_role::text AS role, county, organisation, expires_at ' +
          'FROM adult_account_invitations ' +
          'WHERE token_hash = $1 AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > now() FOR UPDATE',
          [tokenHash]
        );
        const invitation = selected.rows?.[0];
        if (!invitation) throw new AdultInvitationInvalidError();

        const existingAccount = await client.query(
          'SELECT id FROM users WHERE email_normalized = $1 LIMIT 1',
          [invitation.email_normalized]
        );
        if (existingAccount.rows?.length) throw new AdultInvitationInvalidError();

        const created = await client.query(
          'INSERT INTO users ' +
          '(full_name, full_name_ciphertext, role, status, county, organisation, school, school_ciphertext, ' +
          'email_normalized, password_hash, passphrase_hash) ' +
          "VALUES (NULL, $1, $2::account_role, 'active', $3, $4, NULL, NULL, $5, $6, NULL) " +
          'RETURNING id, role::text AS role, status::text AS status, email_normalized',
          [
            fieldCrypto.encryptField(input.fullName), invitation.role, invitation.county,
            invitation.organisation, invitation.email_normalized, passwordHash
          ]
        );
        const account = created.rows?.[0];
        if (!account?.id) throw new Error('Adult account insert returned no identifier');

        await setActor(client, account.id);
        await client.query("SELECT set_config('app.adult_invitation_acceptance', 'true', true)");
        await client.query(
          'UPDATE adult_account_invitations SET accepted_by = $2, accepted_at = now() WHERE id = $1',
          [invitation.id, account.id]
        );
        await writeEvent(client, invitation.id, account.id, 'accepted', 'pending', 'accepted', context, {
          role: account.role
        });
        await writeAudit(client, invitation.id, account.id, 'adult_invitation.accepted', context, {
          role: account.role
        });
        return Object.freeze({
          userId: account.id,
          email: account.email_normalized,
          role: account.role,
          status: account.status
        });
      });
    } catch (error) {
      if (error instanceof AdultInvitationInvalidError) throw error;
      if (error?.code === '23505') throw new AdultInvitationInvalidError();
      throw error;
    }
  }

  return Object.freeze({ createInvitation, listInvitations, revokeInvitation, acceptInvitation });
}
