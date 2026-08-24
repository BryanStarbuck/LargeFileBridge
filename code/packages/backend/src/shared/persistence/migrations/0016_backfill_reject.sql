-- ============================================================================
-- 0016_backfill_reject — the backfill's reject table.
--
-- MECHANIC (c) OF THREE (database_migration.mdx §4.1): a reject table, NOT an abort.
--
-- 2 of the 29,138 sidecars on this machine fail `YAML.parse` today — a Windows-separator
-- `path:` value that raises BLOCK_AS_IMPLICIT_KEY — and `readSidecar` swallows the error,
-- so the product has been running with them unreadable for months without anybody
-- noticing. A backfill that ABORTED on the first one would migrate nothing at all
-- because of two bad bytes out of 23 MB; a backfill that SKIPPED them silently would
-- reproduce the exact blindness that let them sit there.
--
-- So the record is a row: which area, which scope, which file, and the parser's own
-- message. The run continues, and the count is surfaced in the outcome and in
-- migration_state.yaml `rejects:`.
--
-- The scope is part of the key because rejects are cleared PER SCOPE, at the moment a
-- scope restarts from zero (backfill.ts `clearRejects`). A scope resuming from a cursor
-- must keep the rejects its earlier, interrupted half already recorded — otherwise a
-- resumed run reports two rejects as zero.
-- ============================================================================

CREATE TABLE {{S}}.backfill_reject (
  area          text NOT NULL,          -- the migration_state.yaml key, e.g. 'adopt_units'
  scope         text NOT NULL,          -- the scope key within the area ('' when the area has one scope)
  source_path   text NOT NULL,          -- the file (or the record inside it) we could not use
  reason        text NOT NULL,          -- the parser's / validator's own message, verbatim
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at  timestamptz NOT NULL DEFAULT now(),
  seen_count    int NOT NULL DEFAULT 1 CHECK (seen_count > 0),
  PRIMARY KEY (area, scope, source_path)
);
-- The PK is also the idempotency constraint: re-running an area re-rejects the same
-- files, and DO UPDATE refreshes `reason`/`last_seen_at` rather than adding rows. That
-- is what makes "run twice, identical row counts" true for the reject table too.

CREATE INDEX backfill_reject_area ON {{S}}.backfill_reject (area, last_seen_at DESC);
--   SERVES: "what did the last run of this area refuse, newest first" — the one question
--   anybody asks this table, from `just db-status` and from the backfill outcome report.
