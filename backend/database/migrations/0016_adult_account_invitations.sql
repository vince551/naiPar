-- Controlled, invitation-only provisioning for adult Assembly accounts.
-- Migration 0016. Admin accounts are bootstrapped out of band; invitations
-- cannot grant admin, speaker or child/delegate roles.
BEGIN;

CREATE TABLE adult_account_invitations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email_normalized TEXT NOT NULL
    CHECK (
      email_normalized = lower(btrim(email_normalized))
      AND length(email_normalized) BETWEEN 5 AND 254
      AND email_normalized ~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
    ),
  invited_role account_role NOT NULL
    CHECK (invited_role IN ('clerk', 'coordinator', 'stakeholder')),
  county TEXT CHECK (county IS NULL OR length(btrim(county)) BETWEEN 2 AND 100),
  organisation TEXT CHECK (organisation IS NULL OR length(btrim(organisation)) BETWEEN 2 AND 200),
  token_hash BYTEA NOT NULL UNIQUE CHECK (octet_length(token_hash) = 32),
  invited_by UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  expires_at TIMESTAMPTZ NOT NULL,
  accepted_by UUID REFERENCES users(id) ON DELETE RESTRICT,
  accepted_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (expires_at > created_at),
  CHECK ((accepted_by IS NULL) = (accepted_at IS NULL)),
  CHECK (accepted_at IS NULL OR revoked_at IS NULL),
  CHECK (invited_role NOT IN ('clerk', 'coordinator') OR county IS NOT NULL),
  CHECK (invited_role <> 'stakeholder' OR organisation IS NOT NULL)
);

-- An expired outstanding invitation must be explicitly revoked before a
-- replacement is issued. This keeps concurrent invitation creation safe.
CREATE UNIQUE INDEX adult_invitation_one_outstanding_per_email
  ON adult_account_invitations(email_normalized)
  WHERE accepted_at IS NULL AND revoked_at IS NULL;
CREATE INDEX adult_invitation_expiry_idx
  ON adult_account_invitations(expires_at)
  WHERE accepted_at IS NULL AND revoked_at IS NULL;

CREATE FUNCTION reject_adult_account_invitation_delete()
RETURNS TRIGGER LANGUAGE plpgsql AS $
BEGIN
  RAISE EXCEPTION 'adult_account_invitations cannot be deleted; revoke or accept the invitation instead';
END;
$;
CREATE TRIGGER adult_account_invitations_no_delete
BEFORE DELETE ON adult_account_invitations
FOR EACH ROW EXECUTE FUNCTION reject_adult_account_invitation_delete();

CREATE TABLE adult_invitation_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  invitation_id UUID NOT NULL REFERENCES adult_account_invitations(id) ON DELETE RESTRICT,
  actor_user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  event_type TEXT NOT NULL CHECK (event_type IN ('issued', 'accepted', 'revoked')),
  from_state TEXT CHECK (from_state IS NULL OR from_state IN ('pending', 'accepted', 'revoked')),
  to_state TEXT NOT NULL CHECK (to_state IN ('pending', 'accepted', 'revoked')),
  request_id TEXT CHECK (request_id IS NULL OR length(request_id) <= 128),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(metadata) = 'object'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (
    (event_type = 'issued' AND from_state IS NULL AND to_state = 'pending')
    OR (event_type = 'accepted' AND from_state = 'pending' AND to_state = 'accepted')
    OR (event_type = 'revoked' AND from_state = 'pending' AND to_state = 'revoked')
  )
);
CREATE INDEX adult_invitation_events_history_idx
  ON adult_invitation_events(invitation_id, created_at DESC);

CREATE FUNCTION reject_adult_invitation_event_mutation()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'adult_invitation_events are append-only';
END;
$$;
CREATE TRIGGER adult_invitation_events_no_update_delete
BEFORE UPDATE OR DELETE ON adult_invitation_events
FOR EACH ROW EXECUTE FUNCTION reject_adult_invitation_event_mutation();

CREATE FUNCTION enforce_adult_invitation_write()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  actor_setting TEXT;
  actor_id UUID;
  actor_role TEXT;
  actor_status TEXT;
  account_role_value TEXT;
  account_status_value TEXT;
  account_email TEXT;
BEGIN
  actor_setting := nullif(current_setting('app.actor_user_id', true), '');
  IF actor_setting IS NULL THEN
    RAISE EXCEPTION 'authenticated actor context is required for adult invitations';
  END IF;
  actor_id := actor_setting::uuid;

  IF TG_OP = 'INSERT' THEN
    IF NEW.invited_by IS DISTINCT FROM actor_id THEN
      RAISE EXCEPTION 'invitation issuer must match authenticated actor';
    END IF;
    SELECT role::text, status::text INTO actor_role, actor_status
    FROM users WHERE id = actor_id FOR SHARE;
    IF actor_role IS DISTINCT FROM 'admin' OR actor_status IS DISTINCT FROM 'active' THEN
      RAISE EXCEPTION 'active administrator required to issue adult invitations';
    END IF;
    IF NEW.invited_role NOT IN ('clerk', 'coordinator', 'stakeholder')
      OR NEW.expires_at <= now()
      OR NEW.expires_at > now() + interval '72 hours'
    THEN
      RAISE EXCEPTION 'adult invitation role or expiry is invalid';
    END IF;
    IF EXISTS (SELECT 1 FROM users WHERE email_normalized = NEW.email_normalized) THEN
      RAISE EXCEPTION 'an account already exists for this email';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.id IS DISTINCT FROM OLD.id
    OR NEW.email_normalized IS DISTINCT FROM OLD.email_normalized
    OR NEW.invited_role IS DISTINCT FROM OLD.invited_role
    OR NEW.county IS DISTINCT FROM OLD.county
    OR NEW.organisation IS DISTINCT FROM OLD.organisation
    OR NEW.token_hash IS DISTINCT FROM OLD.token_hash
    OR NEW.invited_by IS DISTINCT FROM OLD.invited_by
    OR NEW.expires_at IS DISTINCT FROM OLD.expires_at
    OR NEW.created_at IS DISTINCT FROM OLD.created_at
  THEN
    RAISE EXCEPTION 'adult invitation identity and token digest are immutable';
  END IF;

  IF OLD.accepted_at IS NULL AND OLD.revoked_at IS NULL
    AND NEW.accepted_at IS NOT NULL
  THEN
    IF NEW.accepted_by IS NULL
      OR NEW.revoked_at IS NOT NULL
      OR NEW.accepted_at IS DISTINCT FROM now()
      OR current_setting('app.adult_invitation_acceptance', true) IS DISTINCT FROM 'true'
      OR actor_id IS DISTINCT FROM NEW.accepted_by
      OR OLD.expires_at <= now()
    THEN
      RAISE EXCEPTION 'valid invitation acceptance context is required';
    END IF;
    SELECT role::text, status::text, email_normalized
    INTO account_role_value, account_status_value, account_email
    FROM users WHERE id = NEW.accepted_by FOR SHARE;
    IF account_status_value IS DISTINCT FROM 'active'
      OR account_role_value IS DISTINCT FROM NEW.invited_role::text
      OR account_email IS DISTINCT FROM NEW.email_normalized
    THEN
      RAISE EXCEPTION 'accepted account does not match the invitation';
    END IF;
    RETURN NEW;
  END IF;

  IF OLD.accepted_at IS NULL AND OLD.revoked_at IS NULL
    AND NEW.revoked_at IS NOT NULL
  THEN
    SELECT role::text, status::text INTO actor_role, actor_status
    FROM users WHERE id = actor_id FOR SHARE;
    IF actor_role IS DISTINCT FROM 'admin'
      OR actor_status IS DISTINCT FROM 'active'
      OR NEW.revoked_at IS DISTINCT FROM now()
      OR NEW.accepted_by IS DISTINCT FROM OLD.accepted_by
      OR NEW.accepted_at IS DISTINCT FROM OLD.accepted_at
    THEN
      RAISE EXCEPTION 'only an active administrator may revoke a pending invitation';
    END IF;
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'invalid adult invitation lifecycle transition';
END;
$$;
CREATE TRIGGER adult_account_invitations_write_scope
BEFORE INSERT OR UPDATE ON adult_account_invitations
FOR EACH ROW EXECUTE FUNCTION enforce_adult_invitation_write();

CREATE FUNCTION enforce_adult_invitation_event_insert()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  actor_setting TEXT;
  actor_role TEXT;
  actor_status TEXT;
  invitation_role TEXT;
  invitation_email TEXT;
  accepted_actor UUID;
  accepted_at_value TIMESTAMPTZ;
BEGIN
  actor_setting := nullif(current_setting('app.actor_user_id', true), '');
  IF actor_setting IS NULL OR NEW.actor_user_id::text <> actor_setting THEN
    RAISE EXCEPTION 'adult invitation event actor does not match authenticated context';
  END IF;

  SELECT role::text, status::text INTO actor_role, actor_status
  FROM users WHERE id = NEW.actor_user_id FOR SHARE;
  IF actor_status IS DISTINCT FROM 'active' THEN
    RAISE EXCEPTION 'active account required for adult invitation event';
  END IF;

  IF NEW.event_type IN ('issued', 'revoked') THEN
    IF actor_role IS DISTINCT FROM 'admin' THEN
      RAISE EXCEPTION 'only an active administrator may issue or revoke adult invitations';
    END IF;
  ELSE
    SELECT invited_role::text, email_normalized, accepted_by, accepted_at
    INTO invitation_role, invitation_email, accepted_actor, accepted_at_value
    FROM adult_account_invitations WHERE id = NEW.invitation_id;
    IF actor_role IS DISTINCT FROM invitation_role
      OR accepted_actor IS DISTINCT FROM NEW.actor_user_id
      OR accepted_at_value IS NULL
      OR NOT EXISTS (
        SELECT 1 FROM users
        WHERE id = NEW.actor_user_id
          AND email_normalized = invitation_email
          AND status = 'active'
      )
    THEN
      RAISE EXCEPTION 'accepted invitation event must belong to the provisioned account';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER adult_invitation_events_authenticated_insert
BEFORE INSERT ON adult_invitation_events
FOR EACH ROW EXECUTE FUNCTION enforce_adult_invitation_event_insert();

CREATE FUNCTION require_adult_invitation_event_and_audit()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  expected_event TEXT;
  expected_action TEXT;
  expected_actor UUID;
  expected_time TIMESTAMPTZ;
  actor_setting TEXT;
BEGIN
  IF TG_OP = 'INSERT' THEN
    expected_event := 'issued';
    expected_action := 'adult_invitation.issued';
    expected_actor := NEW.invited_by;
    expected_time := NEW.created_at;
  ELSIF OLD.accepted_at IS NULL AND NEW.accepted_at IS NOT NULL THEN
    expected_event := 'accepted';
    expected_action := 'adult_invitation.accepted';
    expected_actor := NEW.accepted_by;
    expected_time := NEW.accepted_at;
  ELSIF OLD.revoked_at IS NULL AND NEW.revoked_at IS NOT NULL THEN
    expected_event := 'revoked';
    expected_action := 'adult_invitation.revoked';
    actor_setting := nullif(current_setting('app.actor_user_id', true), '');
    IF actor_setting IS NULL THEN
      RAISE EXCEPTION 'adult invitation revocation is missing actor context';
    END IF;
    expected_actor := actor_setting::uuid;
    expected_time := NEW.revoked_at;
  ELSE
    RETURN NEW;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM adult_invitation_events
    WHERE invitation_id = NEW.id
      AND actor_user_id = expected_actor
      AND event_type = expected_event
      AND to_state = CASE expected_event
        WHEN 'issued' THEN 'pending'
        WHEN 'accepted' THEN 'accepted'
        ELSE 'revoked'
      END
      AND created_at = expected_time
  ) THEN
    RAISE EXCEPTION 'adult invitation change requires a matching append-only event';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM audit_logs
    WHERE actor_user_id = expected_actor
      AND entity_type = 'adult_account_invitation'
      AND entity_id = NEW.id
      AND action = expected_action
      AND created_at = expected_time
  ) THEN
    RAISE EXCEPTION 'adult invitation change requires a matching audit record';
  END IF;
  RETURN NEW;
END;
$$;
CREATE CONSTRAINT TRIGGER adult_invitation_event_audit_guard
AFTER INSERT OR UPDATE ON adult_account_invitations
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION require_adult_invitation_event_and_audit();

COMMIT;
