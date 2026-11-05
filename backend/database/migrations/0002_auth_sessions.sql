-- Sauti Yetu authentication support tables
-- Migration: 0002_auth_sessions.sql

BEGIN;

CREATE TABLE auth_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash BYTEA NOT NULL UNIQUE,
  csrf_token_hash BYTEA,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ,
  user_agent_fingerprint BYTEA,
  ip_fingerprint BYTEA,
  CHECK (expires_at > created_at)
);
CREATE INDEX auth_sessions_user_active_idx
  ON auth_sessions(user_id, expires_at DESC)
  WHERE revoked_at IS NULL;

CREATE TABLE auth_attempts (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  account_lookup_hash BYTEA,
  network_fingerprint BYTEA,
  attempted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  succeeded BOOLEAN NOT NULL DEFAULT false
);
CREATE INDEX auth_attempts_account_time_idx
  ON auth_attempts(account_lookup_hash, attempted_at DESC);
CREATE INDEX auth_attempts_network_time_idx
  ON auth_attempts(network_fingerprint, attempted_at DESC);

CREATE FUNCTION set_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

CREATE TRIGGER users_set_updated_at
BEFORE UPDATE ON users
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER sittings_set_updated_at
BEFORE UPDATE ON sittings
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER motions_set_updated_at
BEFORE UPDATE ON motions
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER concerns_set_updated_at
BEFORE UPDATE ON concerns
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

COMMIT;
