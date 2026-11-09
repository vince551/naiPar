-- Sauti Yetu session revocation on security-state changes
-- Migration: 0006_session_revocation.sql

BEGIN;

CREATE FUNCTION revoke_user_sessions_after_security_change()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF
    (OLD.status IS DISTINCT FROM NEW.status AND NEW.status <> 'active')
    OR OLD.role IS DISTINCT FROM NEW.role
    OR OLD.password_hash IS DISTINCT FROM NEW.password_hash
    OR OLD.passphrase_hash IS DISTINCT FROM NEW.passphrase_hash
  THEN
    UPDATE auth_sessions
    SET revoked_at = COALESCE(revoked_at, now())
    WHERE user_id = NEW.id
      AND revoked_at IS NULL;
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER users_revoke_sessions_after_security_change
AFTER UPDATE OF status, role, password_hash, passphrase_hash ON users
FOR EACH ROW
EXECUTE FUNCTION revoke_user_sessions_after_security_change();

CREATE FUNCTION revoke_child_sessions_after_consent_withdrawal()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.status = 'approved'
    AND (NEW.status <> 'approved' OR NEW.withdrawn_at IS NOT NULL)
  THEN
    UPDATE auth_sessions
    SET revoked_at = COALESCE(revoked_at, now())
    WHERE user_id = NEW.child_user_id
      AND revoked_at IS NULL;
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER guardian_consents_revoke_sessions_after_withdrawal
AFTER UPDATE OF status, withdrawn_at ON guardian_consents
FOR EACH ROW
EXECUTE FUNCTION revoke_child_sessions_after_consent_withdrawal();

CREATE FUNCTION prevent_guardian_consent_delete()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'guardian consent records cannot be deleted; use the withdrawal workflow';
END;
$$;

CREATE TRIGGER guardian_consents_no_delete
BEFORE DELETE ON guardian_consents
FOR EACH ROW
EXECUTE FUNCTION prevent_guardian_consent_delete();

COMMIT;
