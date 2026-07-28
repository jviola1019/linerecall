-- Preserve the complete tactical-attempt evidence emitted by the v1 puzzle UI.
-- Historical unsolved attempts are conservatively classified as abandoned;
-- historical hints, incorrect moves, and timings remain unknown/zero rather
-- than being fabricated.
BEGIN;

ALTER TABLE puzzle_attempt_events
  ADD COLUMN IF NOT EXISTS abandoned boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS incorrect_attempts integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS used_hint boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS elapsed_ms integer;

UPDATE puzzle_attempt_events
SET abandoned = NOT solved
WHERE abandoned <> NOT solved;

ALTER TABLE puzzle_progress
  ADD COLUMN IF NOT EXISTS abandoned integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS clean_solves integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS hints_used integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS incorrect_moves bigint NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS total_elapsed_ms bigint NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_elapsed_ms integer;

UPDATE puzzle_progress
SET abandoned = attempts - solved
WHERE abandoned <> attempts - solved;

DO $constraints$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'puzzle_attempt_events_outcome') THEN
    ALTER TABLE puzzle_attempt_events ADD CONSTRAINT puzzle_attempt_events_outcome
      CHECK (solved <> abandoned);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'puzzle_attempt_events_incorrect_attempts') THEN
    ALTER TABLE puzzle_attempt_events ADD CONSTRAINT puzzle_attempt_events_incorrect_attempts
      CHECK (incorrect_attempts >= 0 AND incorrect_attempts <= 10000);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'puzzle_attempt_events_elapsed_ms') THEN
    ALTER TABLE puzzle_attempt_events ADD CONSTRAINT puzzle_attempt_events_elapsed_ms
      CHECK (elapsed_ms IS NULL OR elapsed_ms BETWEEN 0 AND 86400000);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'puzzle_progress_totals') THEN
    ALTER TABLE puzzle_progress ADD CONSTRAINT puzzle_progress_totals CHECK (
      attempts >= 0 AND solved >= 0 AND abandoned >= 0 AND
      solved + abandoned = attempts AND clean_solves BETWEEN 0 AND solved AND
      hints_used BETWEEN 0 AND attempts AND incorrect_moves >= 0 AND
      total_elapsed_ms >= 0 AND
      (last_elapsed_ms IS NULL OR last_elapsed_ms BETWEEN 0 AND 86400000)
    );
  END IF;
END $constraints$;

COMMIT;
