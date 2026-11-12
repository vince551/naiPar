-- Sauti Yetu private child concern intake
-- Migration: 0011_concern_intake_privacy.sql
-- Private narratives are encrypted by the API. Only separately reviewed,
-- de-identified public fields may appear in the public concern projection.

BEGIN;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM concerns) THEN
    RAISE EXCEPTION
      'Migration 0011 requires an empty concerns table; re-encrypt legacy concern content with the application key before applying';
  END IF;
END;
$$;

ALTER TABLE concerns
  ADD COLUMN theme_ciphertext BYTEA,
  ADD COLUMN title_ciphertext BYTEA,
  ADD COLUMN description_ciphertext BYTEA,
  ADD COLUMN public_theme TEXT,
  ADD COLUMN public_title TEXT;

ALTER TABLE concerns
  ALTER COLUMN theme DROP NOT NULL,
  ALTER COLUMN title DROP NOT NULL,
  ALTER COLUMN description DROP NOT NULL;

ALTER TABLE concerns
  ADD CONSTRAINT concerns_private_content_encrypted_check
  CHECK (
    theme IS NULL
    AND title IS NULL
    AND description IS NULL
    AND theme_ciphertext IS NOT NULL
    AND title_ciphertext IS NOT NULL
    AND description_ciphertext IS NOT NULL
  );

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
      AND status <> 'referred_to_safeguarding'
      AND public_theme IS NOT NULL
      AND public_title IS NOT NULL
    )
  );

CREATE INDEX concerns_submitter_created_idx
  ON concerns(submitted_by, created_at DESC)
  WHERE submitted_by IS NOT NULL;

CREATE OR REPLACE VIEW public_concern_summary WITH (security_barrier = true) AS
SELECT
  id,
  public_theme AS theme,
  public_title AS title,
  county,
  sub_county,
  ward,
  status,
  created_at
FROM concerns
WHERE is_public = true
  AND status NOT IN ('referred_to_safeguarding')
  AND public_theme IS NOT NULL
  AND public_title IS NOT NULL;

COMMENT ON COLUMN concerns.is_public IS
  'False by default. Publication requires separately reviewed, de-identified public_theme and public_title; safeguarding referrals can never be public.';

COMMENT ON COLUMN concerns.description_ciphertext IS
  'Authenticated-encrypted private child narrative. Never expose through public or stakeholder projections.';

COMMIT;
