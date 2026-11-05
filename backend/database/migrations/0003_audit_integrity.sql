-- Sauti Yetu integrity hardening
-- Migration: 0003_audit_integrity.sql

BEGIN;

CREATE FUNCTION reject_audit_log_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'audit_logs are append-only';
END;
$$;

CREATE TRIGGER audit_logs_no_update
BEFORE UPDATE OR DELETE ON audit_logs
FOR EACH ROW EXECUTE FUNCTION reject_audit_log_mutation();

-- A cast vote is immutable. Corrections must be handled by a separately
-- authorised, reasoned administrative process with an audit event.
CREATE FUNCTION reject_vote_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'votes are immutable; use the authorised correction workflow';
END;
$$;

CREATE TRIGGER votes_no_update_delete
BEFORE UPDATE OR DELETE ON votes
FOR EACH ROW EXECUTE FUNCTION reject_vote_mutation();

ALTER TABLE users
  ADD CONSTRAINT adult_accounts_require_email
  CHECK (
    role IN ('public_child', 'delegate')
    OR email_normalized IS NOT NULL
    OR status = 'pending'
  );

COMMIT;
