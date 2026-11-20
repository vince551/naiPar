import pg from 'pg';
import { createFieldCrypto } from '../src/security/field-crypto.js';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const encryptionKey = Buffer.from(process.env.GUARDIAN_PHONE_ENCRYPTION_KEY_BASE64, 'base64');
const fieldCrypto = createFieldCrypto({
  encryptionKey,
  guardianPhoneLookupPepper: process.env.GUARDIAN_PHONE_LOOKUP_PEPPER,
  auditFingerprintPepper: process.env.AUDIT_FINGERPRINT_PEPPER
});
function fail(message) { throw new Error(message); }
async function createAdult(role, email, county, organisation) {
  const result = await pool.query(
    'INSERT INTO users (full_name, full_name_ciphertext, role, status, county, organisation, school, school_ciphertext, email_normalized, password_hash, passphrase_hash) ' +
    "VALUES (NULL, $1, $2::account_role, 'active', $3, $4, NULL, NULL, $5, '$argon2id$synthetic-ci', NULL) RETURNING id",
    [fieldCrypto.encryptField('Synthetic ' + role), role, county, organisation, email]
  );
  return result.rows[0].id;
}
async function addAudit(client, actor, id, action) {
  await client.query(
    "INSERT INTO audit_logs (actor_user_id, action, entity_type, entity_id, metadata) VALUES ($1, $2, 'adult_account_invitation', $3, '{}'::jsonb)",
    [actor, action, id]
  );
}
async function addEvent(client, id, actor, type, from, to) {
  await client.query(
    'INSERT INTO adult_invitation_events (invitation_id, actor_user_id, event_type, from_state, to_state) VALUES ($1, $2, $3, $4, $5)',
    [id, actor, type, from, to]
  );
}
async function rejectedUpdate(actorId, sql, params) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT set_config('app.actor_user_id', $1, true)", [actorId]);
    await client.query(sql, params);
    await client.query('COMMIT');
    return '';
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    return String(error.message);
  } finally {
    client.release();
  }
}

try {
  const adminId = await createAdult('admin', 'synthetic-admin@example.test', 'Mombasa', null);
  const stakeholderId = await createAdult('stakeholder', 'synthetic-stakeholder@example.test', null, 'Synthetic Civic Partner');

  const client = await pool.connect();
  let invitationId;
  try {
    await client.query('BEGIN');
    await client.query("SELECT set_config('app.actor_user_id', $1, true)", [adminId]);
    const inserted = await client.query(
      'INSERT INTO adult_account_invitations (email_normalized, invited_role, county, organisation, token_hash, invited_by, expires_at) ' +
      "VALUES ('synthetic-clerk@example.test', 'clerk', 'Mombasa', NULL, $1, $2, now() + interval '48 hours') RETURNING id",
      [Buffer.alloc(32, 11), adminId]
    );
    invitationId = inserted.rows[0].id;
    await addEvent(client, invitationId, adminId, 'issued', null, 'pending');
    await addAudit(client, adminId, invitationId, 'adult_invitation.issued');
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }

  let nonAdminBlocked = false;
  const blockedClient = await pool.connect();
  try {
    await blockedClient.query('BEGIN');
    await blockedClient.query("SELECT set_config('app.actor_user_id', $1, true)", [stakeholderId]);
    await blockedClient.query(
      'INSERT INTO adult_account_invitations (email_normalized, invited_role, organisation, token_hash, invited_by, expires_at) ' +
      "VALUES ('blocked@example.test', 'stakeholder', 'Synthetic Partner', $1, $2, now() + interval '48 hours')",
      [Buffer.alloc(32, 12), stakeholderId]
    );
  } catch (error) {
    nonAdminBlocked = String(error.message).includes('active administrator');
  } finally {
    await blockedClient.query('ROLLBACK').catch(() => {});
    blockedClient.release();
  }
  if (!nonAdminBlocked) fail('A stakeholder was able to issue an adult invitation');

  const clerkId = await createAdult('clerk', 'synthetic-clerk@example.test', 'Mombasa', null);
  const acceptClient = await pool.connect();
  try {
    await acceptClient.query('BEGIN');
    await acceptClient.query("SELECT set_config('app.actor_user_id', $1, true)", [clerkId]);
    await acceptClient.query("SELECT set_config('app.adult_invitation_acceptance', 'true', true)");
    await acceptClient.query(
      'UPDATE adult_account_invitations SET accepted_by = $2, accepted_at = now() WHERE id = $1',
      [invitationId, clerkId]
    );
    await addEvent(acceptClient, invitationId, clerkId, 'accepted', 'pending', 'accepted');
    await addAudit(acceptClient, clerkId, invitationId, 'adult_invitation.accepted');
    await acceptClient.query('COMMIT');
  } catch (error) {
    await acceptClient.query('ROLLBACK');
    throw error;
  } finally {
    acceptClient.release();
  }

  const immutableError = await rejectedUpdate(
    adminId,
    'UPDATE adult_account_invitations SET token_hash = $2 WHERE id = $1',
    [invitationId, Buffer.alloc(32, 99)]
  );
  if (!immutableError.includes('immutable')) fail('An invitation token digest was mutable');

  let eventMutationBlocked = false;
  try {
    await pool.query(
      "UPDATE adult_invitation_events SET metadata = jsonb_build_object('changed', true) WHERE invitation_id = $1",
      [invitationId]
    );
  } catch (error) {
    eventMutationBlocked = String(error.message).includes('append-only');
  }
  if (!eventMutationBlocked) fail('Adult invitation history was mutable');

  const acceptedRevokeError = await rejectedUpdate(
    adminId,
    'UPDATE adult_account_invitations SET revoked_at = now() WHERE id = $1',
    [invitationId]
  );
  if (!acceptedRevokeError.includes('invalid adult invitation lifecycle transition')) {
    fail('An accepted invitation could be revoked');
  }

  let invitationDeleteBlocked = false;
  try {
    await pool.query('DELETE FROM adult_account_invitations WHERE id = $1', [invitationId]);
  } catch (error) {
    invitationDeleteBlocked = String(error.message).includes('cannot be deleted');
  }
  if (!invitationDeleteBlocked) fail('An adult invitation record could be deleted');

  const checks = await pool.query(
    "SELECT (SELECT count(*) FROM adult_account_invitations) AS invitations, " +
    "(SELECT count(*) FROM adult_invitation_events) AS events, " +
    "(SELECT count(*) FROM audit_logs WHERE entity_type = 'adult_account_invitation') AS audits"
  );
  if (Number(checks.rows[0].invitations) !== 1 || Number(checks.rows[0].events) !== 2 || Number(checks.rows[0].audits) !== 2) {
    fail('Adult invitation audit/event counts did not match the expected lifecycle');
  }

  process.stdout.write('Adult invitation role enforcement, acceptance, revocation guards and append-only audit integrity passed\n');
} finally {
  await pool.end();
}
