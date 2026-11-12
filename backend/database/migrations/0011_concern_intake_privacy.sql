-- Sauti Yetu private child concern intake
-- Migration: 0011_concern_intake_privacy.sql
-- Children submit concerns privately; only a later, authorised moderation
-- workflow may publish a de-identified summary.

BEGIN;

CREATE INDEX concerns_submitter_created_idx
  ON concerns(submitted_by, created_at DESC)
  WHERE submitted_by IS NOT NULL;

ALTER TABLE concerns
  ADD CONSTRAINT concerns_safeguarding_referrals_private_check
  CHECK (status <> 'referred_to_safeguarding' OR is_public = false);

COMMENT ON COLUMN concerns.is_public IS
  'False by default. Set true only after authorised moderation and de-identification; never publish safeguarding referrals.';

COMMIT;
