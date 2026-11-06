-- Sauti Yetu audit and stakeholder ownership integrity
-- Migration: 0005_accountability_integrity.sql

BEGIN;

-- Append-only audit rows cannot support ON DELETE SET NULL on their actor FK.
-- Restrict account deletion instead; accounts should normally be archived.
ALTER TABLE audit_logs
  DROP CONSTRAINT audit_logs_actor_user_id_fkey;

ALTER TABLE audit_logs
  ADD CONSTRAINT audit_logs_actor_user_id_fkey
  FOREIGN KEY (actor_user_id) REFERENCES users(id) ON DELETE RESTRICT;

-- Ensure the stakeholder recorded on an update is the stakeholder assigned
-- to that exact resolution assignment, not merely another valid user.
ALTER TABLE stakeholder_assignments
  ADD CONSTRAINT stakeholder_assignments_id_stakeholder_key
  UNIQUE (id, stakeholder_id);

ALTER TABLE stakeholder_updates
  ADD CONSTRAINT stakeholder_updates_assignment_owner_fkey
  FOREIGN KEY (assignment_id, stakeholder_id)
  REFERENCES stakeholder_assignments(id, stakeholder_id)
  ON DELETE RESTRICT;

-- Preserve update history. Corrections are represented by a new update.
CREATE FUNCTION reject_stakeholder_update_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'stakeholder_updates are append-only';
END;
$$;

CREATE TRIGGER stakeholder_updates_no_update_delete
BEFORE UPDATE OR DELETE ON stakeholder_updates
FOR EACH ROW EXECUTE FUNCTION reject_stakeholder_update_mutation();

COMMIT;
