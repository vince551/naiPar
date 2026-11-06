-- Sauti Yetu privacy hardening for child registration
-- Migration: 0004_encrypted_identity_fields.sql
-- New backend writes encrypted identity/contact fields only. This migration
-- deliberately refuses legacy plaintext identity rows; review and re-encrypt
-- any existing development data before applying it to a populated database.

BEGIN;

ALTER TABLE users
  ADD COLUMN full_name_ciphertext BYTEA,
  ADD COLUMN school_ciphertext BYTEA;

ALTER TABLE users
  ALTER COLUMN full_name DROP NOT NULL;

ALTER TABLE users
  DROP CONSTRAINT users_guardian_phone_lookup_hash_key;

CREATE INDEX users_guardian_phone_lookup_hash_idx
  ON users(guardian_phone_lookup_hash);

ALTER TABLE users
  ADD CONSTRAINT users_encrypted_identity_check
  CHECK (
    full_name IS NULL
    AND full_name_ciphertext IS NOT NULL
    AND school IS NULL
    AND school_ciphertext IS NOT NULL
  );

ALTER TABLE users
  ADD CONSTRAINT users_child_guardian_phone_ciphertext_check
  CHECK (
    role NOT IN ('public_child', 'delegate')
    OR guardian_phone_ciphertext IS NOT NULL
  );

ALTER TABLE guardian_consents
  ADD COLUMN guardian_name_ciphertext BYTEA,
  ADD COLUMN guardian_phone_ciphertext BYTEA;

ALTER TABLE guardian_consents
  ALTER COLUMN guardian_name DROP NOT NULL;

ALTER TABLE guardian_consents
  ADD CONSTRAINT guardian_consents_encrypted_identity_check
  CHECK (
    guardian_name IS NULL
    AND guardian_name_ciphertext IS NOT NULL
    AND guardian_phone_ciphertext IS NOT NULL
  );

CREATE UNIQUE INDEX guardian_consents_one_pending_per_child_idx
  ON guardian_consents(child_user_id)
  WHERE status = 'pending';

COMMIT;
