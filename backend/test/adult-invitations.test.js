import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  AdultInvitationAccessError,
  AdultInvitationConflictError,
  AdultInvitationInvalidError,
  AdultInvitationNotFoundError,
  AdultInvitationValidationError,
  createAdultInvitationService
} from '../src/domain/adult-invitations.js';

const admin = '00000000-0000-4000-8000-000000000101';
const stakeholder = '00000000-0000-4000-8000-000000000102';
const invitationId = '00000000-0000-4000-8000-000000000103';
const accountId = '00000000-0000-4000-8000-000000000104';
const context = actorUserId => ({ actorUserId, requestId: 'synthetic-adult-invite', networkFingerprint: Buffer.alloc(32, 9) });
const validInvite = { email: 'clerk@example.test', role: 'clerk', county: 'Mombasa' };
const validToken = 'A'.repeat(43);

function fakePool({ adminRole = 'admin', adminStatus = 'active', failAudit = false, existingInvitation = null } = {}) {
  const roles = new Map([[admin, { role: adminRole, status: adminStatus }], [stakeholder, { role: 'stakeholder', status: 'active' }]]);
  const invitations = existingInvitation ? [{ ...existingInvitation }] : [];
  const users = [];
  const events = [];
  const audits = [];
  const calls = [];
  let nextInvitation = 0;
  let released = 0;

  const run = async (sql, params = []) => {
    calls.push({ sql, params });
    if (sql.includes('SELECT set_config')) return { rows: [{ set_config: params[0] }] };
    if (sql.includes('SELECT role::text AS role, status::text AS status FROM users')) {
      const actor = roles.get(params[0]);
      return { rows: actor ? [{ ...actor }] : [] };
    }
    if (sql.includes('SELECT id, (expires_at > now()) AS is_live FROM adult_account_invitations')) {
      const row = invitations.find(item => item.email_normalized === params[0] && !item.accepted_at && !item.revoked_at);
      return { rows: row ? [{ id: row.id, is_live: row.is_live }] : [] };
    }
    if (sql.includes('SELECT id FROM users WHERE email_normalized = $1')) {
      return { rows: users.some(item => item.email_normalized === params[0]) ? [{ id: 'existing-user' }] : [] };
    }
    if (sql.includes('INSERT INTO adult_account_invitations')) {
      nextInvitation += 1;
      const row = {
        id: nextInvitation === 1 ? invitationId : '00000000-0000-4000-8000-000000000105',
        email_normalized: params[0], role: params[1], county: params[2], organisation: params[3],
        token_hash: params[4], invited_by: params[5],
        expires_at: new Date('2027-02-17T06:00:00.000Z'),
        created_at: new Date('2027-02-15T06:00:00.000Z'),
        accepted_at: null, revoked_at: null
      };
      invitations.push(row);
      return { rows: [{ ...row }] };
    }
    if (sql.includes('WHERE token_hash = $1') && sql.includes('adult_account_invitations')) {
      const row = invitations.find(item => Buffer.compare(item.token_hash, params[0]) === 0
        && !item.accepted_at && !item.revoked_at);
      return { rows: row ? [{
        id: row.id, email_normalized: row.email_normalized, role: row.role,
        county: row.county, organisation: row.organisation, expires_at: row.expires_at
      }] : [] };
    }
    if (sql.includes('INSERT INTO users')) {
      const row = {
        id: accountId, role: params[1], status: 'active',
        email_normalized: params[4], full_name_ciphertext: params[0], password_hash: params[5]
      };
      users.push(row);
      roles.set(accountId, { role: row.role, status: row.status });
      return { rows: [{ id: row.id, role: row.role, status: row.status, email_normalized: row.email_normalized }] };
    }
    if (sql.includes('UPDATE adult_account_invitations SET accepted_by')) {
      const row = invitations.find(item => item.id === params[0]);
      if (!row) return { rows: [] };
      row.accepted_by = params[1];
      row.accepted_at = new Date('2027-02-15T07:00:00.000Z');
      return { rows: [{ id: row.id }] };
    }
    if (sql.includes('SELECT id, email_normalized, invited_role::text AS role, county, organisation, expires_at, accepted_at, revoked_at, created_at, (expires_at > now()) AS is_live')) {
      const row = invitations.find(item => item.id === params[0]);
      return { rows: row ? [{ ...row, is_live: !row.accepted_at && !row.revoked_at }] : [] };
    }
    if (sql.includes('UPDATE adult_account_invitations SET revoked_at')) {
      const row = invitations.find(item => item.id === params[0]);
      if (!row) return { rows: [] };
      row.revoked_at = new Date('2027-02-15T07:00:00.000Z');
      return { rows: [{ ...row }] };
    }
    if (sql.includes('FROM adult_account_invitations') && sql.includes('expires_at > now()')) {
      return { rows: invitations.filter(item => !item.accepted_at && !item.revoked_at).map(item => ({ ...item })) };
    }
    if (sql.includes('INSERT INTO adult_invitation_events')) {
      events.push(params);
      return { rows: [], rowCount: 1 };
    }
    if (sql.includes('INSERT INTO audit_logs')) {
      if (failAudit) throw new Error('synthetic audit failure');
      audits.push(params);
      return { rows: [], rowCount: 1 };
    }
    return { rows: [], rowCount: 1 };
  };

  return {
    roles, invitations, users, events, audits, calls,
    get released() { return released; },
    async connect() {
      return { query: run, release() { released += 1; } };
    }
  };
}
function service(pool) {
  return createAdultInvitationService({
    pool,
    fieldCrypto: { encryptField: value => Buffer.from('cipher:' + value) },
    hashPassword: async value => '$argon2id$synthetic$' + value.length
  });
}

test('active administrator issues a single-use token while storing only its SHA-256 digest', async () => {
  const pool = fakePool();
  const result = await service(pool).createInvitation(validInvite, context(admin));
  assert.match(result.invitationToken, /^[A-Za-z0-9_-]{43}$/u);
  assert.equal(result.role, 'clerk');
  assert.equal(result.email, 'clerk@example.test');
  assert.equal(pool.invitations.length, 1);
  assert.equal(pool.invitations[0].token_hash.length, 32);
  assert.deepEqual(pool.invitations[0].token_hash, createHash('sha256').update(result.invitationToken).digest());
  assert.notEqual(pool.invitations[0].token_hash.toString(), result.invitationToken);
  assert.equal(pool.events[0][2], 'issued');
  assert.equal(pool.audits[0][1], 'adult_invitation.issued');
});

test('only an active administrator may issue, list or revoke invitations', async () => {
  await assert.rejects(service(fakePool()).createInvitation(validInvite, context(stakeholder)), AdultInvitationAccessError);
  await assert.rejects(service(fakePool({ adminRole: 'clerk' })).createInvitation(validInvite, context(admin)), AdultInvitationAccessError);
  await assert.rejects(service(fakePool({ adminStatus: 'suspended' })).createInvitation(validInvite, context(admin)), AdultInvitationAccessError);
  await assert.rejects(service(fakePool()).listInvitations(context(stakeholder)), AdultInvitationAccessError);
  await assert.rejects(service(fakePool()).revokeInvitation(invitationId, context(stakeholder)), AdultInvitationAccessError);
});

test('invitation validation restricts roles, email, county, organisation and unexpected fields', async () => {
  const api = service(fakePool());
  await assert.rejects(api.createInvitation({ ...validInvite, role: 'admin' }, context(admin)), AdultInvitationValidationError);
  await assert.rejects(api.createInvitation({ ...validInvite, role: 'delegate' }, context(admin)), AdultInvitationValidationError);
  await assert.rejects(api.createInvitation({ ...validInvite, email: 'not-an-email' }, context(admin)), AdultInvitationValidationError);
  await assert.rejects(api.createInvitation({ email: 'coordinator@example.test', role: 'coordinator' }, context(admin)), AdultInvitationValidationError);
  await assert.rejects(api.createInvitation({ email: 'stakeholder@example.test', role: 'stakeholder' }, context(admin)), AdultInvitationValidationError);
  await assert.rejects(api.createInvitation({ ...validInvite, extra: 'not allowed' }, context(admin)), AdultInvitationValidationError);
});

test('an existing live invitation or account prevents duplicate provisioning', async () => {
  const live = fakePool({ existingInvitation: {
    id: invitationId, email_normalized: validInvite.email, is_live: true, accepted_at: null, revoked_at: null
  } });
  await assert.rejects(service(live).createInvitation(validInvite, context(admin)), AdultInvitationConflictError);
  const account = fakePool();
  account.users.push({ id: accountId, email_normalized: validInvite.email });
  await assert.rejects(service(account).createInvitation(validInvite, context(admin)), AdultInvitationConflictError);
});

test('expired invitations are revoked and audited before a replacement is issued', async () => {
  const expired = fakePool({ existingInvitation: {
    id: invitationId, email_normalized: validInvite.email, is_live: false, accepted_at: null, revoked_at: null
  } });
  const result = await service(expired).createInvitation(validInvite, context(admin));
  assert.equal(expired.invitations[0].revoked_at instanceof Date, true);
  assert.equal(expired.events[0][2], 'revoked');
  assert.equal(expired.audits[0][1], 'adult_invitation.revoked');
  assert.equal(result.role, 'clerk');
});

test('invitation acceptance creates an active adult account with encrypted name and Argon2id password', async () => {
  const pool = fakePool();
  const api = service(pool);
  const issued = await api.createInvitation(validInvite, context(admin));
  const accepted = await api.acceptInvitation({
    token: issued.invitationToken,
    fullName: 'Synthetic Assembly Clerk',
    password: 'synthetic-strong-password-123'
  }, context());
  assert.equal(accepted.userId, accountId);
  assert.equal(accepted.role, 'clerk');
  assert.equal(accepted.status, 'active');
  assert.equal(pool.users[0].full_name_ciphertext.toString(), 'cipher:Synthetic Assembly Clerk');
  assert.match(pool.users[0].password_hash, /^\$argon2id\$/u);
  assert.equal(pool.invitations[0].accepted_by, accountId);
  assert.equal(pool.events[1][2], 'accepted');
  assert.equal(pool.audits[1][1], 'adult_invitation.accepted');
  await assert.rejects(api.acceptInvitation({
    token: issued.invitationToken,
    fullName: 'Synthetic Assembly Clerk',
    password: 'synthetic-strong-password-123'
  }, context()), AdultInvitationInvalidError);
});

test('invalid, expired, revoked and malformed tokens fail without revealing invitation existence', async () => {
  const api = service(fakePool());
  await assert.rejects(api.acceptInvitation({ token: 'bad', fullName: 'Synthetic User', password: 'synthetic-strong-password-123' }), AdultInvitationValidationError);
  await assert.rejects(api.acceptInvitation({ token: validToken, fullName: 'Synthetic User', password: 'synthetic-strong-password-123' }), AdultInvitationInvalidError);
});

test('passwords must be sufficiently long and full names must be valid', async () => {
  const api = service(fakePool());
  await assert.rejects(api.acceptInvitation({ token: validToken, fullName: 'A', password: 'short' }), AdultInvitationValidationError);
});

test('administrators can list minimal pending invitation metadata and revoke a live invitation', async () => {
  const pool = fakePool();
  const api = service(pool);
  const issued = await api.createInvitation(validInvite, context(admin));
  const listed = await api.listInvitations(context(admin));
  assert.equal(listed.length, 1);
  assert.equal(listed[0].email, validInvite.email);
  assert.equal(Object.hasOwn(listed[0], 'invitationToken'), false);
  const revoked = await api.revokeInvitation(issued.id, context(admin));
  assert.ok(revoked.revokedAt);
  assert.equal(pool.events[1][2], 'revoked');
  assert.equal(pool.audits[2][1], 'adult_invitation.revoked');
});

test('accepted or expired invitations cannot be revoked or reused', async () => {
  const pool = fakePool();
  const api = service(pool);
  const issued = await api.createInvitation(validInvite, context(admin));
  await api.acceptInvitation({
    token: issued.invitationToken,
    fullName: 'Synthetic Assembly Clerk',
    password: 'synthetic-strong-password-123'
  }, context());
  await assert.rejects(api.revokeInvitation(issued.id, context(admin)), AdultInvitationConflictError);
});

test('audit failure rolls back invitation issuance', async () => {
  const pool = fakePool({ failAudit: true });
  await assert.rejects(service(pool).createInvitation(validInvite, context(admin)), /synthetic audit failure/u);
  assert.equal(pool.released, 1);
});
