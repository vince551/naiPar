-- Sauti Yetu coordinator concern moderation and redacted publication
-- Migration: 0012_coordinator_concern_moderation.sql
-- Regular coordinators may review only concerns in their county. Safeguarding
-- referrals remain outside this workflow and never enter the public projection.

BEGIN;

ALTER TABLE concerns
  ADD COLUMN last_moderated_by UUID REFERENCES users(id) ON DELETE RESTRICT,
  ADD COLUMN last_moderated_at TIMESTAMPTZ,
  ADD COLUMN published_by UUID REFERENCES users(id) ON DELETE RESTRICT,
  ADD COLUMN published_at TIMESTAMPTZ;

ALTER TABLE concerns
  ADD CONSTRAINT concerns_moderation_note_not_plaintext_check
  CHECK (moderation_note IS NULL);

ALTER TABLE concerns
  DROP CONSTRAINT concerns_public_projection_redacted_check;

ALTER TABLE concerns
  ADD CONSTRAINT concerns_public_projection_redacted_check
  CHECK (
    (
      is_public = false
      AND public_theme IS NULL
      AND public_title IS NULL
    )
    OR
    (
      is_public = true
      AND status IN ('consolidated', 'responded')
      AND public_theme IS NOT NULL
      AND public_title IS NOT NULL
      AND published_by IS NOT NULL
      AND published_at IS NOT NULL
    )
  );

CREATE TABLE concern_moderation_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  concern_id UUID NOT NULL REFERENCES concerns(id) ON DELETE RESTRICT,
  actor_user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  event_type TEXT NOT NULL CHECK (
    event_type IN ('status_change', 'published', 'unpublished')
  ),
  from_status concern_status NOT NULL,
  to_status concern_status NOT NULL,
  internal_note_ciphertext BYTEA,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (
    (event_type <> 'status_change' OR from_status <> to_status)
    AND (internal_note_ciphertext IS NULL OR octet_length(internal_note_ciphertext) > 0)
  )
);

CREATE INDEX concern_moderation_events_history_idx
  ON concern_moderation_events(concern_id, created_at DESC);

CREATE FUNCTION reject_concern_moderation_event_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'concern_moderation_events are append-only';
END;
$$;

CREATE TRIGGER concern_moderation_events_no_update_delete
BEFORE UPDATE OR DELETE ON concern_moderation_events
FOR EACH ROW EXECUTE FUNCTION reject_concern_moderation_event_mutation();

CREATE FUNCTION enforce_concern_moderation_update()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  actor_setting TEXT;
  actor_role TEXT;
  actor_status TEXT;
  actor_county TEXT;
BEGIN
  IF NEW.submitted_by IS DISTINCT FROM OLD.submitted_by
    OR NEW.county IS DISTINCT FROM OLD.county
    OR NEW.sub_county IS DISTINCT FROM OLD.sub_county
    OR NEW.ward IS DISTINCT FROM OLD.ward
    OR NEW.theme_ciphertext IS DISTINCT FROM OLD.theme_ciphertext
    OR NEW.title_ciphertext IS DISTINCT FROM OLD.title_ciphertext
    OR NEW.description_ciphertext IS DISTINCT FROM OLD.description_ciphertext
  THEN
    RAISE EXCEPTION 'submitted concern identity, location and narrative are immutable';
  END IF;

  IF NEW.moderation_note IS NOT NULL THEN
    RAISE EXCEPTION 'moderation notes must be encrypted in the moderation event history';
  END IF;

  actor_setting := nullif(current_setting('app.actor_user_id', true), '');
  IF actor_setting IS NULL THEN
    RAISE EXCEPTION 'a server-authenticated coordinator context is required';
  END IF;

  IF NEW.assigned_coordinator IS DISTINCT FROM OLD.assigned_coordinator
    AND NEW.assigned_coordinator IS NOT NULL
  THEN
    IF NEW.assigned_coordinator::text <> actor_setting THEN
      RAISE EXCEPTION 'a coordinator may only claim a concern for their own account';
    END IF;
  END IF;

  IF NEW.status IS DISTINCT FROM OLD.status THEN
    IF NEW.last_moderated_by IS NULL
      OR NEW.last_moderated_at IS NULL
      OR NEW.last_moderated_by::text <> actor_setting
      OR NEW.assigned_coordinator IS DISTINCT FROM NEW.last_moderated_by
    THEN
      RAISE EXCEPTION 'status changes require an assigned, authenticated coordinator';
    END IF;

    SELECT role::text, status::text, county
      INTO actor_role, actor_status, actor_county
    FROM users
    WHERE id = NEW.last_moderated_by;

    IF actor_role IS DISTINCT FROM 'coordinator'
      OR actor_status IS DISTINCT FROM 'active'
      OR actor_county IS NULL
      OR actor_county IS DISTINCT FROM NEW.county
    THEN
      RAISE EXCEPTION 'an active coordinator assigned to the concern county is required';
    END IF;

    IF NOT (
      (OLD.status = 'submitted' AND NEW.status IN ('under_review', 'escalated', 'referred_to_safeguarding'))
      OR (OLD.status = 'under_review' AND NEW.status IN ('consolidated', 'escalated', 'responded', 'closed', 'referred_to_safeguarding'))
      OR (OLD.status = 'consolidated' AND NEW.status IN ('escalated', 'responded', 'closed', 'referred_to_safeguarding'))
      OR (OLD.status = 'escalated' AND NEW.status IN ('under_review', 'responded', 'closed', 'referred_to_safeguarding'))
      OR (OLD.status = 'responded' AND NEW.status IN ('under_review', 'closed', 'referred_to_safeguarding'))
    ) THEN
      RAISE EXCEPTION 'unsupported concern moderation status transition';
    END IF;
  END IF;

  IF NEW.is_public IS DISTINCT FROM OLD.is_public THEN
    IF NEW.is_public THEN
      IF NEW.published_by IS NULL
        OR NEW.published_by::text <> actor_setting
        OR NEW.status NOT IN ('consolidated', 'responded')
        OR NEW.published_at IS NULL
        OR NEW.published_by IS NOT DISTINCT FROM NEW.last_moderated_by
      THEN
        RAISE EXCEPTION 'publication requires a second coordinator after moderation';
      END IF;

      SELECT role::text, status::text, county
        INTO actor_role, actor_status, actor_county
      FROM users
      WHERE id = NEW.published_by;

      IF actor_role IS DISTINCT FROM 'coordinator'
        OR actor_status IS DISTINCT FROM 'active'
        OR actor_county IS NULL
        OR actor_county IS DISTINCT FROM NEW.county
      THEN
        RAISE EXCEPTION 'an active coordinator assigned to the concern county is required to publish';
      END IF;
    ELSE
      IF NEW.public_theme IS NOT NULL OR NEW.public_title IS NOT NULL THEN
        RAISE EXCEPTION 'unpublished concerns must clear their public projection';
      END IF;

      SELECT role::text, status::text, county
        INTO actor_role, actor_status, actor_county
      FROM users
      WHERE id::text = actor_setting;

      IF actor_role IS DISTINCT FROM 'coordinator'
        OR actor_status IS DISTINCT FROM 'active'
        OR actor_county IS NULL
        OR actor_county IS DISTINCT FROM NEW.county
      THEN
        RAISE EXCEPTION 'an active coordinator assigned to the concern county is required to unpublish';
      END IF;
    END IF;
  ELSIF NEW.is_public = true AND (
    NEW.public_theme IS DISTINCT FROM OLD.public_theme
    OR NEW.public_title IS DISTINCT FROM OLD.public_title
  ) THEN
    RAISE EXCEPTION 'published public wording cannot be edited without unpublishing first';
  END IF;

  IF NEW.status = 'referred_to_safeguarding' AND NEW.is_public THEN
    RAISE EXCEPTION 'safeguarding referrals must remain private';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER concerns_moderation_scope
BEFORE UPDATE ON concerns
FOR EACH ROW EXECUTE FUNCTION enforce_concern_moderation_update();

CREATE FUNCTION enforce_concern_moderation_event()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  concern_status_value TEXT;
  concern_is_public BOOLEAN;
  concern_county TEXT;
  concern_assignee UUID;
  concern_publisher UUID;
  actor_setting TEXT;
  actor_role TEXT;
  actor_status TEXT;
  actor_county TEXT;
BEGIN
  actor_setting := nullif(current_setting('app.actor_user_id', true), '');
  IF actor_setting IS NULL OR NEW.actor_user_id::text <> actor_setting THEN
    RAISE EXCEPTION 'moderation event actor must match the authenticated coordinator context';
  END IF;

  SELECT status::text, is_public, county, assigned_coordinator, published_by
    INTO concern_status_value, concern_is_public, concern_county, concern_assignee, concern_publisher
  FROM concerns
  WHERE id = NEW.concern_id;

  SELECT role::text, status::text, county
    INTO actor_role, actor_status, actor_county
  FROM users
  WHERE id = NEW.actor_user_id;

  IF actor_role IS DISTINCT FROM 'coordinator'
    OR actor_status IS DISTINCT FROM 'active'
    OR actor_county IS NULL
    OR actor_county IS DISTINCT FROM concern_county
  THEN
    RAISE EXCEPTION 'moderation event requires an active coordinator in the concern county';
  END IF;

  IF NEW.event_type = 'status_change' THEN
    IF concern_status_value IS DISTINCT FROM NEW.to_status::text
      OR concern_assignee IS DISTINCT FROM NEW.actor_user_id
      OR NEW.from_status = NEW.to_status
    THEN
      RAISE EXCEPTION 'status event does not match the moderated concern';
    END IF;
  ELSIF NEW.event_type = 'published' THEN
    IF NOT concern_is_public
      OR concern_publisher IS DISTINCT FROM NEW.actor_user_id
      OR NEW.from_status IS DISTINCT FROM NEW.to_status
    THEN
      RAISE EXCEPTION 'publication event does not match the published concern';
    END IF;
  ELSIF NEW.event_type = 'unpublished' THEN
    IF concern_is_public
      OR NEW.to_status::text IS DISTINCT FROM concern_status_value
    THEN
      RAISE EXCEPTION 'unpublication event does not match the private concern';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER concern_moderation_events_require_actor
BEFORE INSERT ON concern_moderation_events
FOR EACH ROW EXECUTE FUNCTION enforce_concern_moderation_event();

CREATE FUNCTION require_concern_moderation_history()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.status IS DISTINCT FROM OLD.status AND NOT EXISTS (
    SELECT 1
    FROM concern_moderation_events e
    WHERE e.concern_id = NEW.id
      AND e.event_type = 'status_change'
      AND e.actor_user_id = NEW.last_moderated_by
      AND e.from_status = OLD.status
      AND e.to_status = NEW.status
  ) THEN
    RAISE EXCEPTION 'concern status changes require an append-only moderation event';
  END IF;

  IF NEW.is_public IS DISTINCT FROM OLD.is_public AND NOT EXISTS (
    SELECT 1
    FROM concern_moderation_events e
    WHERE e.concern_id = NEW.id
      AND e.actor_user_id = CASE WHEN NEW.is_public THEN NEW.published_by ELSE (
        nullif(current_setting('app.actor_user_id', true), '')::uuid
      ) END
      AND e.event_type = CASE WHEN NEW.is_public THEN 'published' ELSE 'unpublished' END
      AND e.from_status = OLD.status
      AND e.to_status = NEW.status
  ) THEN
    RAISE EXCEPTION 'publication changes require an append-only moderation event';
  END IF;

  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER concerns_require_moderation_history
AFTER UPDATE ON concerns
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION require_concern_moderation_history();

-- The public projection intentionally contains no county, sub-county, ward,
-- submitter ID, guardian data, internal notes or private narrative.
DROP VIEW public_concern_summary;

CREATE VIEW public_concern_summary WITH (security_barrier = true) AS
SELECT
  id,
  public_theme AS theme,
  public_title AS title,
  status,
  created_at
FROM concerns
WHERE is_public = true
  AND status IN ('consolidated', 'responded')
  AND public_theme IS NOT NULL
  AND public_title IS NOT NULL;

COMMIT;
