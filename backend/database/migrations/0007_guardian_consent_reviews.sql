-- Sauti Yetu guardian consent review workflow
-- Migration: 0007_guardian_consent_reviews.sql
-- Records a coordinator's manual verification decision and enforces the
-- decision-to-review relationship at the database boundary. This is not OTP.

BEGIN;

CREATE TABLE guardian_consent_reviews (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  consent_id UUID NOT NULL REFERENCES guardian_consents(id) ON DELETE RESTRICT,
  reviewed_by UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  decision TEXT NOT NULL CHECK (decision IN ('approved', 'rejected')),
  verification_method TEXT NOT NULL CHECK (
    verification_method IN ('in_person', 'verified_call', 'document_review')
  ),
  evidence_reference TEXT NOT NULL CHECK (
    length(evidence_reference) BETWEEN 8 AND 128
    AND evidence_reference ~ '^[A-Za-z0-9][A-Za-z0-9_-]{7,127}$'
  ),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX guardian_consent_reviews_consent_time_idx
  ON guardian_consent_reviews(consent_id, created_at DESC);

ALTER TABLE guardian_consents
  ADD COLUMN latest_review_id UUID,
  ADD CONSTRAINT guardian_consents_latest_review_fkey
    FOREIGN KEY (latest_review_id)
    REFERENCES guardian_consent_reviews(id)
    ON DELETE RESTRICT,
  ADD CONSTRAINT guardian_consents_reviewed_status_check
    CHECK (
      status NOT IN ('approved', 'rejected')
      OR (
        reviewed_by IS NOT NULL
        AND reviewed_at IS NOT NULL
        AND latest_review_id IS NOT NULL
      )
    );

CREATE FUNCTION reject_guardian_consent_review_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'guardian_consent_reviews are append-only';
END;
$$;

CREATE TRIGGER guardian_consent_reviews_no_update_delete
BEFORE UPDATE OR DELETE ON guardian_consent_reviews
FOR EACH ROW EXECUTE FUNCTION reject_guardian_consent_review_mutation();

CREATE FUNCTION enforce_guardian_consent_review()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  review_decision TEXT;
  review_consent_id UUID;
  review_actor_id UUID;
  reviewer_role TEXT;
  reviewer_status TEXT;
BEGIN
  IF NEW.withdrawn_at IS NOT NULL AND NEW.status <> 'withdrawn' THEN
    RAISE EXCEPTION 'withdrawn_at requires withdrawn status';
  END IF;

  IF NEW.latest_review_id IS DISTINCT FROM OLD.latest_review_id
    AND NEW.status IS NOT DISTINCT FROM OLD.status
  THEN
    RAISE EXCEPTION 'latest consent review can only change with a decision';
  END IF;

  IF NEW.status IS DISTINCT FROM OLD.status THEN
    IF NEW.status IN ('approved', 'rejected') THEN
      IF OLD.status NOT IN ('pending', 'rejected') THEN
        RAISE EXCEPTION 'consent cannot be reviewed from its current status';
      END IF;

      IF NEW.latest_review_id IS NULL
        OR NEW.reviewed_by IS NULL
        OR NEW.reviewed_at IS NULL
      THEN
        RAISE EXCEPTION 'a recorded coordinator review is required';
      END IF;

      SELECT decision, consent_id, reviewed_by
        INTO review_decision, review_consent_id, review_actor_id
      FROM guardian_consent_reviews
      WHERE id = NEW.latest_review_id;

      IF NOT FOUND
        OR review_consent_id IS DISTINCT FROM NEW.id
        OR review_actor_id IS DISTINCT FROM NEW.reviewed_by
        OR review_decision IS DISTINCT FROM NEW.status::text
      THEN
        RAISE EXCEPTION 'latest consent review does not match the decision';
      END IF;

      SELECT role::text, status::text
        INTO reviewer_role, reviewer_status
      FROM users
      WHERE id = NEW.reviewed_by;

      IF reviewer_role IS DISTINCT FROM 'coordinator'
        OR reviewer_status IS DISTINCT FROM 'active'
      THEN
        RAISE EXCEPTION 'an active coordinator must review guardian consent';
      END IF;

      IF NEW.status = 'approved' AND NEW.granted_at IS NULL THEN
        RAISE EXCEPTION 'approved consent requires granted_at';
      END IF;

      IF NEW.status = 'rejected' AND NEW.granted_at IS NOT NULL THEN
        RAISE EXCEPTION 'rejected consent cannot have granted_at';
      END IF;
    ELSIF NEW.status = 'withdrawn' THEN
      IF OLD.status NOT IN ('pending', 'approved', 'rejected')
        OR NEW.withdrawn_at IS NULL
      THEN
        RAISE EXCEPTION 'consent withdrawal requires a valid prior state and timestamp';
      END IF;
    ELSE
      RAISE EXCEPTION 'unsupported guardian consent status transition';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER guardian_consents_require_review
BEFORE UPDATE OF status, latest_review_id, reviewed_by, reviewed_at, granted_at, withdrawn_at
ON guardian_consents
FOR EACH ROW EXECUTE FUNCTION enforce_guardian_consent_review();

COMMIT;
