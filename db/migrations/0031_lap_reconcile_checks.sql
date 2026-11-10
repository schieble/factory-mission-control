-- What `reconcile:laps` last found for each run (AIF-160), so a tick replays only the runs that
-- changed since and a run whose repair keeps failing waits out a backoff. Replaying every run on
-- every tick grew with Archon's run store until the replays ran the compute out of memory.
--
-- `source` and `lap` are fingerprints, as `reconcile-laps.ts` computes them, of Archon's rows the
-- projection reads for the run and of the run's lap rows. A run whose fingerprints both still match
-- a clean check is not replayed; a dropped projection follows an Archon write, which changes
-- `source`. A failed repair counts in `failures` and sets `retry_at`; the run is parked until then
-- or until either fingerprint changes; `checked_at` and `error` say when and why, for the owner
-- reading a parked run. Only `reconcile:laps` writes this table, and it deletes the rows of runs
-- Archon no longer has. Run again, this file changes nothing.

CREATE TABLE IF NOT EXISTS mc.lap_reconcile_checks (
  run_id uuid PRIMARY KEY,
  source text NOT NULL,
  lap text NOT NULL,
  checked_at timestamptz NOT NULL,
  failures integer NOT NULL DEFAULT 0 CHECK (failures >= 0),
  retry_at timestamptz,
  error text
);
