-- Sauti Yetu guardian OTP database-boundary hardening
-- Migration: 0010_guardian_otp_binding.sql

BEGIN;

ALTER TABLE guardian_phone_verification_challenges
  ADD CONSTRAINT guardian_otp_verified_timestamp_check
    CHECK ((delivery_status = 'verified') = (verified_at IS NOT NULL)),
  ADD CONSTRAINT guardian_otp_locked_requires_sent_at_check
    CHECK (delivery_status <> 'locked' OR sent_at IS NOT NULL),
  ADD CONSTRAINT guardian_otp_maximum_lifetime_check
    CHECK (expires_at <= created_at + interval '10 minutes');

CREATE FUNCTION validate_guardian_otp_challenge_insert()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  consent_phone_hash BYTEA;
  consent_status_value TEXT;
  consent_verified_at TIMESTAMPTZ;
  child_role TEXT;
  child_status TEXT;
BEGIN
  IF NEW.delivery_status <> 'pending'
    OR NEW.attempts <> 0
    OR NEW.sent_at IS NOT NULL
    OR NEW.verified_at IS NOT NULL
  THEN
    RAISE EXCEPTION 'guardian OTP challenges must start in pending state';
  END IF;

  SELECT
    gc.guardian_phone_lookup_hash,
    gc.status::text,
    gc.guardian_phone_verified_at,
    u.role::text,
    u.status::text
  INTO
    consent_phone_hash,
    consent_status_value,
    consent_verified_at,
    child_role,
    child_status
  FROM guardian_consents gc
  JOIN users u ON u.id = gc.child_user_id
  WHERE gc.id = NEW.consent_id
  FOR UPDATE OF gc, u;

  IF NOT FOUND
    OR consent_phone_hash IS DISTINCT FROM NEW.phone_lookup_hash
    OR consent_status_value NOT IN ('pending', 'rejected')
    OR consent_verified_at IS NOT NULL
    OR child_role NOT IN ('public_child', 'delegate')
    OR child_status IS DISTINCT FROM 'pending'
  THEN
    RAISE EXCEPTION 'guardian OTP challenge must match an unverified pending child consent';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER guardian_otp_challenges_validate_insert
BEFORE INSERT ON guardian_phone_verification_challenges
FOR EACH ROW EXECUTE FUNCTION validate_guardian_otp_challenge_insert();

CREATE FUNCTION prevent_unreviewed_guardian_contact_change()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.guardian_phone_lookup_hash IS DISTINCT FROM NEW.guardian_phone_lookup_hash
    OR OLD.guardian_phone_ciphertext IS DISTINCT FROM NEW.guardian_phone_ciphertext
  THEN
    RAISE EXCEPTION 'guardian contact changes require a separate verified workflow';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER guardian_consents_guardian_contact_immutable
BEFORE UPDATE OF guardian_phone_lookup_hash, guardian_phone_ciphertext
ON guardian_consents
FOR EACH ROW EXECUTE FUNCTION prevent_unreviewed_guardian_contact_change();

COMMIT;
