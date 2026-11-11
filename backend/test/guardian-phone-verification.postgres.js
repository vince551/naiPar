import pg from 'pg';
import { randomBytes, randomUUID } from 'node:crypto';

const { Pool } = pg;
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const encrypted = label => Buffer.from(`synthetic encrypted ${label}`);
const phoneHash = () => randomBytes(32);

async function createChild({ county, label }) {
  const lookupHash = phoneHash();
  const child = await pool.query(
    `INSERT INTO users (
      full_name, full_name_ciphertext, role, status, age,
      school, school_ciphertext, county, ward,
      guardian_phone_lookup_hash, guardian_phone_ciphertext, passphrase_hash
    ) VALUES (
      NULL, $1, 'public_child', 'pending', 14,
      NULL, $2, $3, 'Synthetic Ward', $4, $5, '$argon2id$synthetic'
    )
    RETURNING id`,
    [encrypted(`${label} child`), encrypted(`${label} school`), county, lookupHash, encrypted(`${label} guardian phone`)]
  );
  const childId = child.rows[0].id;
  const consent = await pool.query(
    `INSERT INTO guardian_consents (
      child_user_id, guardian_name, guardian_name_ciphertext,
      guardian_phone_lookup_hash, guardian_phone_ciphertext,
      consent_text_version, status
    ) VALUES ($1, NULL, $2, $3, $4, 'ci-otp-test-v1', 'pending')
    RETURNING id`,
    [childId, encrypted(`${label} guardian name`), lookupHash, encrypted(`${label} guardian phone`)]
  );
  return { childId, consentId: consent.rows[0].id, lookupHash };
}

async function expectFailure(work, expectedText, label) {
  let failure = null;
  try {
    await work();
  } catch (error) {
    failure = error;
  }
  if (!failure || !String(failure.message).includes(expectedText)) {
    throw new Error(`${label}: expected database rejection containing "${expectedText}"`);
  }
}

try {
  const coordinatorResult = await pool.query(
    `INSERT INTO users (
      full_name, full_name_ciphertext, role, status, county,
      school, school_ciphertext, email_normalized, password_hash
    ) VALUES (
      NULL, $1, 'coordinator', 'active', 'Mombasa',
      NULL, NULL, $2, '$argon2id$synthetic'
    )
    RETURNING id`,
    [encrypted('OTP test coordinator'), `otp-coordinator-${randomUUID()}@example.test`]
  );
  const coordinatorId = coordinatorResult.rows[0].id;

  const noProof = await createChild({ county: 'Mombasa', label: 'no-proof' });
  const noProofReview = await pool.query(
    `INSERT INTO guardian_consent_reviews (
      consent_id, reviewed_by, decision, verification_method, evidence_reference
    ) VALUES ($1, $2, 'approved', 'guardian_otp', 'synthetic-no-proof-0001')
    RETURNING id`,
    [noProof.consentId, coordinatorId]
  );
  await expectFailure(
    () => pool.query(
      `UPDATE guardian_consents
       SET status = 'approved', reviewed_by = $2, reviewed_at = now(),
           granted_at = now(), latest_review_id = $3
       WHERE id = $1`,
      [noProof.consentId, coordinatorId, noProofReview.rows[0].id]
    ),
    'guardian OTP approval requires verified phone possession',
    'OTP review without phone proof'
  );

  const valid = await createChild({ county: 'Mombasa', label: 'valid' });
  const challenge = await pool.query(
    `INSERT INTO guardian_phone_verification_challenges (
      consent_id, phone_lookup_hash, otp_hash, expires_at
    ) VALUES ($1, $2, $3, now() + interval '10 minutes')
    RETURNING id`,
    [valid.consentId, valid.lookupHash, Buffer.alloc(32, 77)]
  );
  const challengeId = challenge.rows[0].id;

  await pool.query(
    `UPDATE guardian_phone_verification_challenges
     SET delivery_status = 'sent', sent_at = now()
     WHERE id = $1`,
    [challengeId]
  );
  const verified = await pool.query(
    `UPDATE guardian_phone_verification_challenges
     SET delivery_status = 'verified', verified_at = now()
     WHERE id = $1
     RETURNING verified_at`,
    [challengeId]
  );
  await pool.query(
    `UPDATE guardian_consents
     SET guardian_phone_verified_at = $2,
         guardian_phone_verification_challenge_id = $3
     WHERE id = $1`,
    [valid.consentId, verified.rows[0].verified_at, challengeId]
  );

  const review = await pool.query(
    `INSERT INTO guardian_consent_reviews (
      consent_id, reviewed_by, decision, verification_method, evidence_reference
    ) VALUES ($1, $2, 'approved', 'guardian_otp', $3)
    RETURNING id`,
    [valid.consentId, coordinatorId, challengeId]
  );
  await pool.query(
    `UPDATE guardian_consents
     SET status = 'approved', reviewed_by = $2, reviewed_at = now(),
         granted_at = now(), latest_review_id = $3
     WHERE id = $1`,
    [valid.consentId, coordinatorId, review.rows[0].id]
  );

  await expectFailure(
    () => pool.query(
      'UPDATE guardian_phone_verification_challenges SET otp_hash = $2 WHERE id = $1',
      [challengeId, Buffer.alloc(32, 78)]
    ),
    'challenge identity is immutable',
    'OTP hash mutation'
  );
  await expectFailure(
    () => pool.query(
      'DELETE FROM guardian_phone_verification_challenges WHERE id = $1',
      [challengeId]
    ),
    'cannot be deleted',
    'OTP challenge deletion'
  );

  const otherCounty = await createChild({ county: 'Kilifi', label: 'cross-county' });
  const crossCountyReview = await pool.query(
    `INSERT INTO guardian_consent_reviews (
      consent_id, reviewed_by, decision, verification_method, evidence_reference
    ) VALUES ($1, $2, 'approved', 'in_person', 'synthetic-cross-county-0001')
    RETURNING id`,
    [otherCounty.consentId, coordinatorId]
  );
  await expectFailure(
    () => pool.query(
      `UPDATE guardian_consents
       SET status = 'approved', reviewed_by = $2, reviewed_at = now(),
           granted_at = now(), latest_review_id = $3
       WHERE id = $1`,
      [otherCounty.consentId, coordinatorId, crossCountyReview.rows[0].id]
    ),
    'coordinator county must match',
    'cross-county consent review'
  );

  process.stdout.write('Guardian OTP PostgreSQL integrity checks passed\\n');
} finally {
  await pool.end();
}
