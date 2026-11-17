-- Official sitting lifecycle and public projection (migration 0013).
BEGIN;

UPDATE sittings SET venue = NULL WHERE venue IS NOT NULL AND length(trim(venue)) = 0;
UPDATE sittings SET published_at = NULL, concluded_at = NULL WHERE status = 'draft';
UPDATE sittings SET published_at = COALESCE(published_at, created_at), concluded_at = NULL
WHERE status IN ('published', 'in_progress');
UPDATE sittings SET published_at = COALESCE(published_at, created_at),
  concluded_at = COALESCE(concluded_at, updated_at, created_at) WHERE status = 'concluded';
UPDATE sittings SET concluded_at = NULL WHERE status = 'cancelled';

ALTER TABLE sittings ADD CONSTRAINT sittings_venue_length_check
  CHECK (venue IS NULL OR length(trim(venue)) BETWEEN 2 AND 200);
ALTER TABLE sittings ADD CONSTRAINT sittings_lifecycle_timestamps_check CHECK (
  (status = 'draft' AND published_at IS NULL AND concluded_at IS NULL)
  OR (status = 'published' AND published_at IS NOT NULL AND concluded_at IS NULL)
  OR (status = 'in_progress' AND published_at IS NOT NULL AND concluded_at IS NULL)
  OR (status = 'concluded' AND published_at IS NOT NULL AND concluded_at IS NOT NULL)
  OR (status = 'cancelled' AND concluded_at IS NULL)
);

CREATE TABLE sitting_lifecycle_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sitting_id UUID NOT NULL REFERENCES sittings(id) ON DELETE RESTRICT,
  actor_user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  event_type TEXT NOT NULL CHECK (event_type IN ('baseline','created','updated','published','started','concluded','cancelled')),
  from_status sitting_status,
  to_status sitting_status NOT NULL,
  request_id TEXT CHECK (request_id IS NULL OR length(request_id) <= 128),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(metadata) = 'object'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (
    (event_type IN ('baseline','created') AND from_status IS NULL)
    OR (event_type NOT IN ('baseline','created') AND from_status IS NOT NULL)
  )
);
CREATE INDEX sitting_lifecycle_events_history_idx
  ON sitting_lifecycle_events(sitting_id, created_at DESC);

INSERT INTO sitting_lifecycle_events
  (sitting_id, actor_user_id, event_type, from_status, to_status, metadata, created_at)
SELECT id, created_by, 'baseline', NULL, status, '{"backfilled":true}'::jsonb, created_at
FROM sittings;

CREATE FUNCTION reject_sitting_lifecycle_event_mutation()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'sitting_lifecycle_events are append-only';
END;
$$;
CREATE TRIGGER sitting_lifecycle_events_no_update_delete
BEFORE UPDATE OR DELETE ON sitting_lifecycle_events
FOR EACH ROW EXECUTE FUNCTION reject_sitting_lifecycle_event_mutation();

CREATE FUNCTION enforce_sitting_write()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  actor_setting TEXT;
  actor_role TEXT;
  actor_status TEXT;
  content_changed BOOLEAN;
BEGIN
  actor_setting := nullif(current_setting('app.actor_user_id', true), '');
  IF actor_setting IS NULL THEN
    RAISE EXCEPTION 'authenticated clerk or administrator context is required';
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW.created_by::text <> actor_setting OR NEW.status <> 'draft'
      OR NEW.published_at IS NOT NULL OR NEW.concluded_at IS NOT NULL THEN
      RAISE EXCEPTION 'new sittings must be draft records created by the authenticated official';
    END IF;
  ELSE
    IF NEW.id IS DISTINCT FROM OLD.id OR NEW.created_by IS DISTINCT FROM OLD.created_by
      OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
      RAISE EXCEPTION 'sitting identity and creator are immutable';
    END IF;
  END IF;

  SELECT role::text, status::text INTO actor_role, actor_status
  FROM users WHERE id::text = actor_setting FOR SHARE;
  IF actor_role NOT IN ('clerk','admin') OR actor_status IS DISTINCT FROM 'active' THEN
    RAISE EXCEPTION 'active clerk or administrator required';
  END IF;

  IF TG_OP = 'INSERT' THEN RETURN NEW; END IF;

  content_changed :=
    ROW(NEW.title, NEW.session_number, NEW.scheduled_at, NEW.venue, NEW.order_paper_storage_key)
    IS DISTINCT FROM
    ROW(OLD.title, OLD.session_number, OLD.scheduled_at, OLD.venue, OLD.order_paper_storage_key);

  IF NEW.status IS DISTINCT FROM OLD.status THEN
    IF content_changed THEN
      RAISE EXCEPTION 'save draft details before changing lifecycle status';
    END IF;
    IF OLD.status = 'draft' AND NEW.status = 'published' THEN
      IF NEW.published_at IS NULL OR NEW.published_at IS NOT DISTINCT FROM OLD.published_at
        OR NEW.concluded_at IS NOT NULL THEN
        RAISE EXCEPTION 'publishing requires a publication timestamp';
      END IF;
    ELSIF OLD.status = 'published' AND NEW.status = 'in_progress' THEN
      IF NEW.published_at IS DISTINCT FROM OLD.published_at OR NEW.concluded_at IS NOT NULL THEN
        RAISE EXCEPTION 'invalid start timestamp';
      END IF;
    ELSIF OLD.status = 'in_progress' AND NEW.status = 'concluded' THEN
      IF NEW.published_at IS DISTINCT FROM OLD.published_at OR NEW.concluded_at IS NULL
        OR NEW.concluded_at IS NOT DISTINCT FROM OLD.concluded_at THEN
        RAISE EXCEPTION 'conclusion requires a new conclusion timestamp';
      END IF;
    ELSIF OLD.status IN ('draft','published') AND NEW.status = 'cancelled' THEN
      IF NEW.published_at IS DISTINCT FROM OLD.published_at OR NEW.concluded_at IS NOT NULL THEN
        RAISE EXCEPTION 'invalid cancellation timestamps';
      END IF;
    ELSE
      RAISE EXCEPTION 'unsupported sitting lifecycle transition';
    END IF;
  ELSE
    IF NEW.published_at IS DISTINCT FROM OLD.published_at
      OR NEW.concluded_at IS DISTINCT FROM OLD.concluded_at THEN
      RAISE EXCEPTION 'lifecycle timestamps require a status transition';
    END IF;
    IF NOT content_changed THEN RAISE EXCEPTION 'sitting update did not change a draft field'; END IF;
    IF OLD.status <> 'draft' THEN RAISE EXCEPTION 'published sitting details are immutable'; END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER sittings_write_scope
BEFORE INSERT OR UPDATE ON sittings
FOR EACH ROW EXECUTE FUNCTION enforce_sitting_write();

CREATE FUNCTION enforce_sitting_lifecycle_event_insert()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  actor_setting TEXT;
  actor_role TEXT;
  actor_status TEXT;
  current_status TEXT;
  creator UUID;
  valid_event BOOLEAN := false;
BEGIN
  IF NEW.event_type = 'baseline' THEN RETURN NEW; END IF;
  actor_setting := nullif(current_setting('app.actor_user_id', true), '');
  IF actor_setting IS NULL OR NEW.actor_user_id::text <> actor_setting THEN
    RAISE EXCEPTION 'sitting event actor does not match authenticated context';
  END IF;
  SELECT role::text, status::text INTO actor_role, actor_status
  FROM users WHERE id = NEW.actor_user_id FOR SHARE;
  IF actor_role NOT IN ('clerk','admin') OR actor_status IS DISTINCT FROM 'active' THEN
    RAISE EXCEPTION 'sitting event requires an active clerk or administrator';
  END IF;
  SELECT status::text, created_by INTO current_status, creator
  FROM sittings WHERE id = NEW.sitting_id;
  IF current_status IS DISTINCT FROM NEW.to_status::text THEN
    RAISE EXCEPTION 'sitting event does not match current status';
  END IF;
  CASE NEW.event_type
    WHEN 'created' THEN valid_event := NEW.from_status IS NULL AND NEW.to_status = 'draft' AND creator = NEW.actor_user_id;
    WHEN 'updated' THEN valid_event := NEW.from_status = 'draft' AND NEW.to_status = 'draft';
    WHEN 'published' THEN valid_event := NEW.from_status = 'draft' AND NEW.to_status = 'published';
    WHEN 'started' THEN valid_event := NEW.from_status = 'published' AND NEW.to_status = 'in_progress';
    WHEN 'concluded' THEN valid_event := NEW.from_status = 'in_progress' AND NEW.to_status = 'concluded';
    WHEN 'cancelled' THEN valid_event := NEW.from_status IN ('draft','published') AND NEW.to_status = 'cancelled';
    ELSE valid_event := false;
  END CASE;
  IF NOT valid_event THEN RAISE EXCEPTION 'invalid sitting lifecycle event'; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER sitting_lifecycle_events_authenticated_insert
BEFORE INSERT ON sitting_lifecycle_events
FOR EACH ROW EXECUTE FUNCTION enforce_sitting_lifecycle_event_insert();

CREATE FUNCTION require_sitting_lifecycle_and_audit()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  actor_setting TEXT;
  actor_id UUID;
  expected_event TEXT;
  expected_action TEXT;
  expected_from sitting_status;
  content_changed BOOLEAN := false;
BEGIN
  actor_setting := nullif(current_setting('app.actor_user_id', true), '');
  IF actor_setting IS NULL THEN RAISE EXCEPTION 'sitting write is missing actor context'; END IF;
  actor_id := actor_setting::uuid;

  IF TG_OP = 'INSERT' THEN
    expected_event := 'created';
    expected_action := 'sitting.created';
    expected_from := NULL;
  ELSIF NEW.status IS DISTINCT FROM OLD.status THEN
    expected_from := OLD.status;
    expected_event := CASE NEW.status
      WHEN 'published' THEN 'published' WHEN 'in_progress' THEN 'started'
      WHEN 'concluded' THEN 'concluded' WHEN 'cancelled' THEN 'cancelled' ELSE NULL END;
    expected_action := 'sitting.status_changed';
  ELSE
    content_changed :=
      ROW(NEW.title, NEW.session_number, NEW.scheduled_at, NEW.venue, NEW.order_paper_storage_key)
      IS DISTINCT FROM
      ROW(OLD.title, OLD.session_number, OLD.scheduled_at, OLD.venue, OLD.order_paper_storage_key);
    IF NOT content_changed THEN RETURN NEW; END IF;
    expected_from := OLD.status;
    expected_event := 'updated';
    expected_action := 'sitting.updated';
  END IF;

  IF expected_event IS NULL OR NOT EXISTS (
    SELECT 1 FROM sitting_lifecycle_events e
    WHERE e.sitting_id = NEW.id AND e.actor_user_id = actor_id
      AND e.event_type = expected_event
      AND e.from_status IS NOT DISTINCT FROM expected_from
      AND e.to_status = NEW.status
  ) THEN
    RAISE EXCEPTION 'sitting change requires a matching append-only lifecycle event';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM audit_logs a
    WHERE a.actor_user_id = actor_id AND a.entity_type = 'sitting'
      AND a.entity_id = NEW.id AND a.action = expected_action
  ) THEN
    RAISE EXCEPTION 'sitting change requires a matching audit record';
  END IF;
  RETURN NEW;
END;
$$;
CREATE CONSTRAINT TRIGGER sittings_lifecycle_audit_guard
AFTER INSERT OR UPDATE ON sittings
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION require_sitting_lifecycle_and_audit();

CREATE VIEW public_sitting_summary WITH (security_barrier = true) AS
SELECT id, title, session_number, scheduled_at, venue, status, published_at, concluded_at
FROM sittings WHERE status IN ('published','in_progress','concluded');

COMMIT;
