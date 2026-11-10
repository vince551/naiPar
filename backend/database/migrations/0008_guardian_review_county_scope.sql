-- Sauti Yetu coordinator county-scope enforcement
-- Migration: 0008_guardian_review_county_scope.sql
-- Consent reviewers must be active coordinators assigned to the child's county.

BEGIN;

CREATE OR REPLACE FUNCTION enforce_guardian_consent_review()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  review_decision TEXT;
  review_consent_id UUID;
  review_actor_id UUID;
  reviewer_role TEXT;
  reviewer_status TEXT;
  reviewer_county TEXT;
  child_county TEXT;
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

      SELECT role::text, status::text, county
        INTO reviewer_role, reviewer_status, reviewer_county
      FROM users
      WHERE id = NEW.reviewed_by;

      SELECT county
        INTO child_county
      FROM users
      WHERE id = NEW.child_user_id;

      IF reviewer_role IS DISTINCT FROM 'coordinator'
        OR reviewer_status IS DISTINCT FROM 'active'
      THEN
        RAISE EXCEPTION 'an active coordinator must review guardian consent';
      END IF;

      IF reviewer_county IS NULL OR reviewer_county IS DISTINCT FROM child_county THEN
        RAISE EXCEPTION 'coordinator county must match the child county';
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

COMMIT;
