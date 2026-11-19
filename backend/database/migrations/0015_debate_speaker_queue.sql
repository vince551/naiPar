-- Controlled debate speaker requests, clerk allocation and one-speaker-at-a-time floor control.
-- Migration 0015. No public projection is created: speaker identity and requests remain restricted.
BEGIN;

ALTER TABLE debate_requests
  ADD COLUMN updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  ADD COLUMN review_reason_code TEXT;

ALTER TABLE debate_requests
  ADD CONSTRAINT debate_request_review_reason_check
    CHECK (review_reason_code IS NULL OR review_reason_code IN (
      'not_relevant', 'capacity', 'procedural', 'other'
    ));

-- Preserve the existing relative order while repairing duplicate or missing
-- positions from any earlier demonstration records.
UPDATE debate_requests
SET queue_position = NULL
WHERE status IN ('pending', 'rejected', 'cancelled');

WITH ordered AS (
  SELECT id,
         row_number() OVER (
           PARTITION BY motion_id
           ORDER BY queue_position NULLS LAST, requested_at, id
         )::integer AS next_position
  FROM debate_requests
  WHERE status IN ('approved', 'completed')
)
UPDATE debate_requests AS request
SET queue_position = ordered.next_position
FROM ordered
WHERE request.id = ordered.id;

CREATE UNIQUE INDEX debate_queue_position_unique
  ON debate_requests(motion_id, queue_position)
  WHERE queue_position IS NOT NULL;

CREATE UNIQUE INDEX debate_one_active_speaker_per_motion
  ON debate_requests(motion_id)
  WHERE status = 'approved'
    AND speaking_started_at IS NOT NULL
    AND speaking_ended_at IS NULL;

CREATE INDEX debate_speaker_history_idx
  ON debate_requests(speaker_id, requested_at DESC);

CREATE TABLE debate_request_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  debate_request_id UUID NOT NULL REFERENCES debate_requests(id) ON DELETE RESTRICT,
  actor_user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  event_type TEXT NOT NULL CHECK (event_type IN (
    'baseline', 'requested', 'approved', 'rejected', 'speaker_started', 'speaker_finished'
  )),
  from_status debate_request_status,
  to_status debate_request_status NOT NULL,
  request_id TEXT CHECK (request_id IS NULL OR length(request_id) <= 128),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(metadata) = 'object'),
  CHECK (
    (event_type = 'baseline' AND metadata = '{"backfilled":true}'::jsonb)
    OR (event_type = 'requested' AND metadata = '{}'::jsonb)
    OR (event_type IN ('approved', 'rejected') AND metadata - ARRAY['queuePosition', 'allocatedSeconds', 'reasonCode'] = '{}'::jsonb)
    OR (event_type IN ('speaker_started', 'speaker_finished') AND metadata - ARRAY['queuePosition', 'allocatedSeconds'] = '{}'::jsonb)
  ),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (
    (event_type = 'baseline' AND from_status IS NULL)
    OR (event_type = 'requested' AND from_status IS NULL AND to_status = 'pending')
    OR (event_type = 'approved' AND from_status = 'pending' AND to_status = 'approved')
    OR (event_type = 'rejected' AND from_status = 'pending' AND to_status = 'rejected')
    OR (event_type = 'speaker_started' AND from_status = 'approved' AND to_status = 'approved')
    OR (event_type = 'speaker_finished' AND from_status = 'approved' AND to_status = 'completed')
  )
);

CREATE INDEX debate_request_events_history_idx
  ON debate_request_events(debate_request_id, created_at DESC);

INSERT INTO debate_request_events
  (debate_request_id, actor_user_id, event_type, from_status, to_status, metadata, created_at)
SELECT id,
       COALESCE(reviewed_by, speaker_id),
       'baseline',
       NULL,
       status,
       '{"backfilled":true}'::jsonb,
       requested_at
FROM debate_requests;

CREATE FUNCTION reject_debate_request_event_mutation()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'debate_request_events are append-only';
END;
$$;

CREATE TRIGGER debate_request_events_no_update_delete
BEFORE UPDATE OR DELETE ON debate_request_events
FOR EACH ROW EXECUTE FUNCTION reject_debate_request_event_mutation();

CREATE FUNCTION enforce_debate_request_write()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  actor_setting TEXT;
  actor_id UUID;
  actor_role TEXT;
  actor_status TEXT;
  motion_state TEXT;
  sitting_state TEXT;
BEGIN
  actor_setting := nullif(current_setting('app.actor_user_id', true), '');
  IF actor_setting IS NULL THEN
    RAISE EXCEPTION 'authenticated debate actor context is required';
  END IF;
  actor_id := actor_setting::uuid;

  SELECT role::text, status::text
  INTO actor_role, actor_status
  FROM users
  WHERE id = actor_id
  FOR SHARE;

  IF actor_status IS DISTINCT FROM 'active' THEN
    RAISE EXCEPTION 'active Assembly account required';
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW.speaker_id IS DISTINCT FROM actor_id
      OR actor_role IS DISTINCT FROM 'delegate'
      OR NEW.status <> 'pending'
      OR NEW.reviewed_by IS NOT NULL
      OR NEW.reviewed_at IS NOT NULL
      OR NEW.speaking_started_at IS NOT NULL
      OR NEW.speaking_ended_at IS NOT NULL
      OR NEW.queue_position IS NOT NULL
      OR NEW.review_reason_code IS NOT NULL
      OR NEW.allocated_seconds <> 120
      OR NEW.requested_at IS DISTINCT FROM now()
    THEN
      RAISE EXCEPTION 'only an active delegate may create an unreviewed speaker request';
    END IF;

    SELECT motion.status::text, sitting.status::text
    INTO motion_state, sitting_state
    FROM motions AS motion
    JOIN sittings AS sitting ON sitting.id = motion.sitting_id
    WHERE motion.id = NEW.motion_id
    FOR UPDATE OF motion, sitting;

    IF motion_state IS DISTINCT FROM 'under_debate'
      OR sitting_state NOT IN ('published', 'in_progress')
    THEN
      RAISE EXCEPTION 'speaker requests require an open sitting and a motion under debate';
    END IF;

    PERFORM id
    FROM guardian_consents
    WHERE child_user_id = actor_id
      AND status = 'approved'
      AND withdrawn_at IS NULL
    FOR SHARE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'approved guardian consent is required for debate participation';
    END IF;

    IF EXISTS (
      SELECT 1
      FROM debate_requests
      WHERE motion_id = NEW.motion_id
        AND speaker_id = actor_id
        AND status IN ('pending', 'approved', 'completed')
    ) THEN
      RAISE EXCEPTION 'a speaker request already exists for this motion';
    END IF;

    NEW.updated_at := now();
    RETURN NEW;
  END IF;

  IF NEW.id IS DISTINCT FROM OLD.id
    OR NEW.motion_id IS DISTINCT FROM OLD.motion_id
    OR NEW.speaker_id IS DISTINCT FROM OLD.speaker_id
    OR NEW.requested_at IS DISTINCT FROM OLD.requested_at
  THEN
    RAISE EXCEPTION 'debate request identity is immutable';
  END IF;

  IF actor_role NOT IN ('clerk', 'admin') THEN
    RAISE EXCEPTION 'active clerk or administrator required for debate management';
  END IF;

  SELECT motion.status::text, sitting.status::text
  INTO motion_state, sitting_state
  FROM motions AS motion
  JOIN sittings AS sitting ON sitting.id = motion.sitting_id
  WHERE motion.id = OLD.motion_id
  FOR UPDATE OF motion, sitting;

  IF OLD.status = 'pending' AND NEW.status IN ('approved', 'rejected') THEN
    IF OLD.reviewed_by IS NOT NULL OR OLD.reviewed_at IS NOT NULL
      OR NEW.reviewed_by IS DISTINCT FROM actor_id
      OR NEW.reviewed_at IS DISTINCT FROM now()
      OR NEW.speaking_started_at IS NOT NULL
      OR NEW.speaking_ended_at IS NOT NULL
    THEN
      RAISE EXCEPTION 'pending debate request requires one clerk review';
    END IF;

    IF NEW.status = 'approved' THEN
      IF NEW.queue_position IS NULL OR NEW.queue_position < 1
        OR NEW.queue_position IS DISTINCT FROM (
          SELECT COALESCE(MAX(queue_position), 0) + 1
          FROM debate_requests WHERE motion_id = OLD.motion_id
        )
        OR NEW.review_reason_code IS NOT NULL
        OR motion_state IS DISTINCT FROM 'under_debate'
        OR sitting_state NOT IN ('published', 'in_progress')
      THEN
        RAISE EXCEPTION 'approved speaker request requires an open debate and queue position';
      END IF;
    ELSE
      IF NEW.queue_position IS NOT NULL
        OR NEW.review_reason_code IS NULL
        OR NEW.review_reason_code NOT IN ('not_relevant', 'capacity', 'procedural', 'other')
      THEN
        RAISE EXCEPTION 'rejected speaker request requires a controlled reason code';
      END IF;
    END IF;

  ELSIF OLD.status = 'approved'
    AND NEW.status = 'approved'
    AND OLD.speaking_started_at IS NULL
    AND NEW.speaking_started_at IS NOT NULL
    AND NEW.speaking_ended_at IS NULL
  THEN
    IF NEW.speaking_started_at IS DISTINCT FROM now()
      OR NEW.reviewed_by IS DISTINCT FROM OLD.reviewed_by
      OR NEW.reviewed_at IS DISTINCT FROM OLD.reviewed_at
      OR NEW.allocated_seconds IS DISTINCT FROM OLD.allocated_seconds
      OR NEW.queue_position IS DISTINCT FROM OLD.queue_position
      OR NEW.review_reason_code IS DISTINCT FROM OLD.review_reason_code
      OR motion_state IS DISTINCT FROM 'under_debate'
      OR sitting_state NOT IN ('published', 'in_progress')
    THEN
      RAISE EXCEPTION 'speaker start may only record the start timestamp during an open debate';
    END IF;

    IF EXISTS (
      SELECT 1
      FROM debate_requests
      WHERE motion_id = OLD.motion_id
        AND id <> OLD.id
        AND status = 'approved'
        AND speaking_started_at IS NOT NULL
        AND speaking_ended_at IS NULL
    ) THEN
      RAISE EXCEPTION 'another speaker is already on the floor';
    END IF;

    IF EXISTS (
      SELECT 1
      FROM debate_requests
      WHERE motion_id = OLD.motion_id
        AND id <> OLD.id
        AND status = 'approved'
        AND speaking_started_at IS NULL
        AND queue_position < OLD.queue_position
    ) THEN
      RAISE EXCEPTION 'an earlier approved speaker is waiting in the queue';
    END IF;

  ELSIF OLD.status = 'approved'
    AND NEW.status = 'completed'
    AND OLD.speaking_started_at IS NOT NULL
    AND OLD.speaking_ended_at IS NULL
    AND NEW.speaking_ended_at IS NOT NULL
  THEN
    IF NEW.reviewed_by IS DISTINCT FROM OLD.reviewed_by
      OR NEW.reviewed_at IS DISTINCT FROM OLD.reviewed_at
      OR NEW.allocated_seconds IS DISTINCT FROM OLD.allocated_seconds
      OR NEW.queue_position IS DISTINCT FROM OLD.queue_position
      OR NEW.review_reason_code IS DISTINCT FROM OLD.review_reason_code
      OR NEW.speaking_started_at IS DISTINCT FROM OLD.speaking_started_at
      OR NEW.speaking_ended_at IS DISTINCT FROM now()
      OR NEW.speaking_ended_at < OLD.speaking_started_at
      OR motion_state IS DISTINCT FROM 'under_debate'
    THEN
      RAISE EXCEPTION 'speaker finish may only record the end timestamp and completed status';
    END IF;
  ELSE
    RAISE EXCEPTION 'invalid debate request lifecycle transition';
  END IF;

  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

CREATE TRIGGER debate_requests_write_scope
BEFORE INSERT OR UPDATE ON debate_requests
FOR EACH ROW EXECUTE FUNCTION enforce_debate_request_write();

CREATE FUNCTION enforce_debate_request_event_insert()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  actor_setting TEXT;
  actor_role TEXT;
  actor_status TEXT;
BEGIN
  IF NEW.event_type = 'baseline' THEN
    RETURN NEW;
  END IF;

  actor_setting := nullif(current_setting('app.actor_user_id', true), '');
  IF actor_setting IS NULL OR NEW.actor_user_id::text <> actor_setting THEN
    RAISE EXCEPTION 'debate event actor does not match authenticated context';
  END IF;

  SELECT role::text, status::text
  INTO actor_role, actor_status
  FROM users
  WHERE id = NEW.actor_user_id
  FOR SHARE;

  IF actor_status IS DISTINCT FROM 'active' THEN
    RAISE EXCEPTION 'active account required for debate event';
  END IF;

  IF NEW.event_type = 'requested' THEN
    IF actor_role IS DISTINCT FROM 'delegate' THEN
      RAISE EXCEPTION 'only an active delegate may record a debate request event';
    END IF;
  ELSE
    IF actor_role NOT IN ('clerk', 'admin') THEN
      RAISE EXCEPTION 'only an active clerk or administrator may record debate management events';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER debate_request_events_insert_scope
BEFORE INSERT ON debate_request_events
FOR EACH ROW EXECUTE FUNCTION enforce_debate_request_event_insert();

CREATE FUNCTION enforce_debate_request_event_integrity()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  expected_event TEXT;
  expected_action TEXT;
  expected_from debate_request_status;
  expected_to debate_request_status;
  actor_setting TEXT;
BEGIN
  IF TG_OP = 'INSERT' THEN
    expected_event := 'requested';
    expected_action := 'debate_request.requested';
    expected_from := NULL;
    expected_to := NEW.status;
  ELSIF OLD.status = 'pending' AND NEW.status = 'approved' THEN
    expected_event := 'approved';
    expected_action := 'debate_request.approved';
    expected_from := OLD.status;
    expected_to := NEW.status;
  ELSIF OLD.status = 'pending' AND NEW.status = 'rejected' THEN
    expected_event := 'rejected';
    expected_action := 'debate_request.rejected';
    expected_from := OLD.status;
    expected_to := NEW.status;
  ELSIF OLD.speaking_started_at IS NULL AND NEW.speaking_started_at IS NOT NULL THEN
    expected_event := 'speaker_started';
    expected_action := 'debate_request.speaker_started';
    expected_from := OLD.status;
    expected_to := NEW.status;
  ELSIF OLD.status = 'approved' AND NEW.status = 'completed' THEN
    expected_event := 'speaker_finished';
    expected_action := 'debate_request.speaker_finished';
    expected_from := OLD.status;
    expected_to := NEW.status;
  ELSE
    RETURN NEW;
  END IF;

  actor_setting := nullif(current_setting('app.actor_user_id', true), '');
  IF actor_setting IS NULL THEN
    RAISE EXCEPTION 'debate lifecycle event requires authenticated actor context';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM debate_request_events
    WHERE debate_request_id = NEW.id
      AND actor_user_id::text = actor_setting
      AND event_type = expected_event
      AND from_status IS NOT DISTINCT FROM expected_from
      AND to_status = expected_to
      AND created_at = NEW.updated_at
  ) THEN
    RAISE EXCEPTION 'debate request change requires matching append-only lifecycle event';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM audit_logs
    WHERE entity_type = 'debate_request'
      AND entity_id = NEW.id
      AND actor_user_id::text = actor_setting
      AND action = expected_action
      AND created_at = NEW.updated_at
  ) THEN
    RAISE EXCEPTION 'debate request change requires matching audit record';
  END IF;

  RETURN NEW;
END;
$$;

CREATE CONSTRAINT TRIGGER debate_requests_event_integrity
AFTER INSERT OR UPDATE ON debate_requests
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION enforce_debate_request_event_integrity();

COMMIT;
