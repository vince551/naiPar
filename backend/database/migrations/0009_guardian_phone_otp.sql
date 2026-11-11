-- Sauti Yetu guardian phone possession verification (OTP)
-- Migration: 0009_guardian_phone_otp.sql
-- OTP verifies access to the registered phone only. It does not itself grant
-- legal guardian status or replace coordinator consent review.

BEGIN;

CREATE TYPE guardian_otp_delivery_status AS ENUM (
  'pending', 'sent', 'verified', 'failed', 'expired', 'locked'
);

CREATE TABLE guardian_phone_verification_challenges (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  consent_id UUID NOT NULL REFERENCES guardian_consents(id) ON DELETE RESTRICT,
  phone_lookup_hash BYTEA NOT NULL CHECK (octet_length(phone_lookup_hash) = 32),
  otp_hash BYTEA NOT NULL CHECK (octet_length(otp_hash) = 32),
  delivery_status guardian_otp_delivery_status NOT NULL DEFAULT 'pending',
  attempts SMALLINT NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 5),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,
  sent_at TIMESTAMPTZ,
  verified_at TIMESTAMPTZ,
  request_fingerprint BYTEA,
  CHECK (expires_at > created_at),
  CHECK (delivery_status <> 'sent' OR sent_at IS NOT NULL),
  CHECK (delivery_status <> 'verified' OR (sent_at IS NOT NULL AND verified_at IS NOT NULL)),
  CHECK (delivery_status <> 'pending' OR (sent_at IS NULL AND verified_at IS NULL))
);

CREATE INDEX guardian_otp_consent_created_idx
  ON guardian_phone_verification_challenges(consent_id, created_at DESC);

CREATE INDEX guardian_otp_expiry_idx
  ON guardian_phone_verification_challenges(expires_at)
  WHERE delivery_status IN ('pending', 'sent');

CREATE UNIQUE INDEX guardian_otp_one_active_per_consent_idx
  ON guardian_phone_verification_challenges(consent_id)
  WHERE delivery_status IN ('pending', 'sent');

ALTER TABLE guardian_consents
  ADD COLUMN guardian_phone_verified_at TIMESTAMPTZ,
  ADD COLUMN guardian_phone_verification_challenge_id UUID
    REFERENCES guardian_phone_verification_challenges(id) ON DELETE RESTRICT,
  ADD CONSTRAINT guardian_consents_phone_verification_pair_check
    CHECK (
      (guardian_phone_verified_at IS NULL)
      = (guardian_phone_verification_challenge_id IS NULL)
    );

CREATE INDEX guardian_consents_phone_lookup_idx
  ON guardian_consents(guardian_phone_lookup_hash);

ALTER TABLE guardian_consent_reviews
  DROP CONSTRAINT guardian_consent_reviews_verification_method_check,
  ADD CONSTRAINT guardian_consent_reviews_verification_method_check
    CHECK (
      verification_method IN (
        'in_person', 'verified_call', 'document_review', 'guardian_otp'
      )
    );

CREATE FUNCTION enforce_guardian_otp_challenge_integrity()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'guardian phone verification challenges cannot be deleted';
  END IF;

  IF OLD.consent_id IS DISTINCT FROM NEW.consent_id
    OR OLD.phone_lookup_hash IS DISTINCT FROM NEW.phone_lookup_hash
    OR OLD.otp_hash IS DISTINCT FROM NEW.otp_hash
    OR OLD.created_at IS DISTINCT FROM NEW.created_at
    OR OLD.expires_at IS DISTINCT FROM NEW.expires_at
    OR OLD.request_fingerprint IS DISTINCT FROM NEW.request_fingerprint
  THEN
    RAISE EXCEPTION 'guardian phone verification challenge identity is immutable';
  END IF;

  IF NEW.attempts < OLD.attempts OR NEW.attempts > OLD.attempts + 1 THEN
    RAISE EXCEPTION 'guardian OTP attempts may only increase by one';
  END IF;

  IF OLD.delivery_status = 'pending'
    AND NEW.delivery_status NOT IN ('sent', 'failed', 'expired')
  THEN
    RAISE EXCEPTION 'invalid guardian OTP delivery transition';
  END IF;

  IF OLD.delivery_status = 'sent'
    AND NEW.delivery_status NOT IN ('verified', 'failed', 'expired', 'locked')
  THEN
    RAISE EXCEPTION 'invalid guardian OTP verification transition';
  END IF;

  IF OLD.delivery_status NOT IN ('pending', 'sent')
    AND NEW.delivery_status IS DISTINCT FROM OLD.delivery_status
  THEN
    RAISE EXCEPTION 'completed guardian OTP challenges are immutable';
  END IF;

  IF NEW.delivery_status = 'sent' AND NEW.sent_at IS NULL THEN
    RAISE EXCEPTION 'sent guardian OTP requires sent_at';
  END IF;

  IF NEW.delivery_status = 'verified' AND NEW.verified_at IS NULL THEN
    RAISE EXCEPTION 'verified guardian OTP requires verified_at';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER guardian_otp_challenges_integrity
BEFORE UPDATE OR DELETE ON guardian_phone_verification_challenges
FOR EACH ROW EXECUTE FUNCTION enforce_guardian_otp_challenge_integrity();

CREATE FUNCTION enforce_guardian_phone_verification_reference()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  challenge_consent_id UUID;
  challenge_status TEXT;
  challenge_verified_at TIMESTAMPTZ;
BEGIN
  IF OLD.guardian_phone_verified_at IS NOT NULL
    AND (
      NEW.guardian_phone_verified_at IS DISTINCT FROM OLD.guardian_phone_verified_at
      OR NEW.guardian_phone_verification_challenge_id
        IS DISTINCT FROM OLD.guardian_phone_verification_challenge_id
    )
  THEN
    RAISE EXCEPTION 'guardian phone verification evidence is immutable';
  END IF;

  IF NEW.guardian_phone_verification_challenge_id IS NOT NULL THEN
    SELECT consent_id, delivery_status::text, verified_at
      INTO challenge_consent_id, challenge_status, challenge_verified_at
    FROM guardian_phone_verification_challenges
    WHERE id = NEW.guardian_phone_verification_challenge_id;

    IF NOT FOUND
      OR challenge_consent_id IS DISTINCT FROM NEW.id
      OR challenge_status IS DISTINCT FROM 'verified'
      OR challenge_verified_at IS NULL
      OR NEW.guardian_phone_verified_at IS DISTINCT FROM challenge_verified_at
    THEN
      RAISE EXCEPTION 'guardian phone verification must reference a verified challenge for this consent';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER guardian_consents_phone_verification_reference
BEFORE UPDATE OF guardian_phone_verified_at, guardian_phone_verification_challenge_id
ON guardian_consents
FOR EACH ROW EXECUTE FUNCTION enforce_guardian_phone_verification_reference();

CREATE FUNCTION require_phone_proof_for_otp_consent_approval()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  review_method TEXT;
BEGIN
  IF NEW.status = 'approved' AND NEW.status IS DISTINCT FROM OLD.status THEN
    SELECT verification_method
      INTO review_method
    FROM guardian_consent_reviews
    WHERE id = NEW.latest_review_id
      AND consent_id = NEW.id;

    IF review_method = 'guardian_otp'
      AND (
        NEW.guardian_phone_verified_at IS NULL
        OR NEW.guardian_phone_verification_challenge_id IS NULL
      )
    THEN
      RAISE EXCEPTION 'guardian OTP approval requires verified phone possession';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER guardian_consents_require_otp_proof
BEFORE UPDATE OF status, latest_review_id
ON guardian_consents
FOR EACH ROW EXECUTE FUNCTION require_phone_proof_for_otp_consent_approval();

COMMIT;
