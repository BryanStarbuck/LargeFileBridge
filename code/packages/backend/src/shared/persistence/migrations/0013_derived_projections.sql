-- ============================================================================
-- 0013_derived_projections — read-only projections over files that STAY authoritative on
-- disk, plus the advisory mirror of the data-migration ledger.
--
-- THE RULE FOR EVERYTHING IN THIS FILE: the app never writes the source from these rows.
-- The YAML stays authoritative; these tables are purely the query surface.
-- ============================================================================

-- _batches/*.yaml — the job-queue batch manifests. The YAML stays authoritative and
-- APPEND-ONLY: batch-manifest.service.ts:12-18 chose O(1) appendFileSync deliberately, to
-- avoid O(n^2) on the exact 1,440-file batch it was built for. This is the query surface,
-- because listManifests() is an uncached readdir + YAML.parse of up to 200 documents
-- (measured 45-82 ms, and unbounded, since manifests live forever).
-- `terminal_state='crashed'` when the manifest has NO terminal record — the ABSENCE is the
-- signal, and it must survive the projection or a crashed batch reads as an unfinished one.
CREATE TABLE {{S}}.batch_manifest (
  batch_id       uuid PRIMARY KEY,
  manifest_path  text NOT NULL UNIQUE,
  op             text NOT NULL,
  label          text NOT NULL DEFAULT '',
  scope          text NOT NULL DEFAULT '',
  file_count     int  NOT NULL DEFAULT 0 CHECK (file_count >= 0),
  started_at     timestamptz NOT NULL,
  finished_at    timestamptz,
  terminal_state text CHECK (terminal_state IN ('completed','halted','crashed')),
  environment    jsonb NOT NULL DEFAULT '{}',
  src_size       bigint NOT NULL,
  src_mtime_ms   bigint NOT NULL
);
-- src_size / src_mtime_ms are the projection's validity token, the same shape
-- file_artifact uses: if the file on disk no longer matches, the projection is stale and
-- the answer is "re-read", never "believe the row".

CREATE TABLE {{S}}.batch_item (
  batch_id   uuid NOT NULL REFERENCES {{S}}.batch_manifest(batch_id) ON DELETE CASCADE,
  rel_path   text NOT NULL,
  size_bytes bigint CHECK (size_bytes IS NULL OR size_bytes >= 0),
  outcome    text,
  reason     text,
  PRIMARY KEY (batch_id, rel_path)
);

-- ADVISORY MIRROR of migration_state.yaml, so SQL and /api/health can join on backfill
-- progress. NEVER read to decide whether a backfill ran — THE YAML IS THE AUTHORITY,
-- because four of the boot migrations run before any connection exists (main.ts:341-380,
-- all before bootstrapState() at :382), and a ledger that lives in the database those
-- migrations do not use cannot be their authority (database_migration.mdx §1).
CREATE TABLE {{S}}.backfill_mirror (
  name            text PRIMARY KEY,
  kind            text NOT NULL CHECK (kind IN ('local','backfill','sweep')),
  status          text NOT NULL CHECK (status IN ('pending','running','done','failed','skipped','superseded')),
  version         int  NOT NULL,
  applied_version int,
  rows_migrated   bigint NOT NULL DEFAULT 0,
  rows_expected   bigint,
  pg_epoch        text,
  last_error      text,
  mirrored_at     timestamptz NOT NULL DEFAULT now()
);
-- `pg_epoch` is the cluster+database identity from readPgEpoch() (migrate.ts). If it
-- changes, the database was dropped and recreated, and a `done` backfill is NOT done.

CREATE INDEX batch_manifest_recent ON {{S}}.batch_manifest (started_at DESC);
--   SERVES: listManifests(limit) newest-first — today a readdir + YAML.parse of up to 200
--   documents.

CREATE INDEX batch_item_outcome ON {{S}}.batch_item (batch_id, outcome);
--   SERVES: "Retry failed (N)" — the unfinished remainder, which readManifest() computes
--   today by re-parsing the whole 483 KB manifest.
