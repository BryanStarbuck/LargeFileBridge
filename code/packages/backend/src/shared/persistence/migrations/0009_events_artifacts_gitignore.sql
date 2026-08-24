-- ============================================================================
-- 0009_events_artifacts_gitignore — everything hanging off one file row: its event
-- history, its generated artifacts, its git-ignore verdict, its compressed/uncompressed
-- variants, and its perceptual fingerprint.
--
-- This is the slice that deletes 29,138 inodes of read amplification (database.mdx §9
-- slice 9). Measured: the sidecar mirror re-merged 20,059 UNCHANGED files every pass, a
-- profile attributed 7.9 s of 17 s non-idle time to readYamlDoc, and on any given pass
-- 99.98% of those sidecars are byte-identical.
-- ============================================================================

-- The sidecar `events:` array. UNION-MERGED: THE UNIQUE BELOW IS THE MERGE.
-- `NULLS NOT DISTINCT` is load-bearing — 18 of 29,138 sidecars on disk carry `by: null`,
-- and a default NULLS DISTINCT constraint would re-insert every one of them on every
-- reconcile pass, forever. VERIFIED on 16.15.
CREATE TABLE {{S}}.file_event (
  event_id   bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  unit_id    bigint NOT NULL,
  rel_posix  text   NOT NULL,
  at         timestamptz NOT NULL,
  kind       {{S}}.file_event_kind NOT NULL,
  device_id  smallint REFERENCES {{S}}.device(device_id) ON DELETE SET NULL,
  actor_id   smallint REFERENCES {{S}}.person(person_id) ON DELETE SET NULL,
  detail     jsonb NOT NULL DEFAULT '{}',       -- FileEventSchema is .passthrough()
  origin     {{S}}.claim_origin NOT NULL DEFAULT 'local',
  FOREIGN KEY (unit_id, rel_posix) REFERENCES {{S}}.file(unit_id, rel_posix) ON DELETE CASCADE,
  CONSTRAINT file_event_union UNIQUE NULLS NOT DISTINCT
    (unit_id, rel_posix, at, kind, device_id, actor_id, detail)
);

-- THE ARTIFACT INDEX. Replaces analysisOutputs()'s ~12 statSync probes PER ROW
-- (tracking.service.ts:114-170). `body_size`/`body_mtime_ms` are the ONLY validity token:
-- a mismatch on re-stat means UNKNOWN, never done. `media_size_at_record` is REQUIRED for
-- kind='compression' because compressionRecordFresh() compares the record's compressed
-- size against a LIVE stat of the media — the verdict is not a static fact, and a stale
-- row here is a FALSE DONE that silently never re-offers the file to the user.
CREATE TABLE {{S}}.file_artifact (
  unit_id       bigint NOT NULL,
  rel_posix     text   NOT NULL,
  kind          {{S}}.artifact_kind NOT NULL,
  body_path     text   NOT NULL,
  placement     {{S}}.placement NOT NULL,
  body_size     bigint NOT NULL CHECK (body_size >= 0),
  body_mtime_ms bigint NOT NULL,
  media_size_at_record bigint,                 -- required for kind='compression'
  engine        text,
  provider      text,
  language      text,
  generated_at  timestamptz,
  indexed_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (unit_id, rel_posix, kind),
  FOREIGN KEY (unit_id, rel_posix) REFERENCES {{S}}.file(unit_id, rel_posix) ON DELETE CASCADE,
  CONSTRAINT artifact_compression_needs_media_size
    CHECK (kind <> 'compression' OR media_size_at_record IS NOT NULL)
);
-- The PK (unit_id, rel_posix, kind) SERVES the point question analysisOutputs() answers
-- with ~12 statSync probes today, and the batched form `WHERE unit_id=$1 AND rel_posix =
-- ANY($2)` for a whole page of rows at once.

-- The git-ignore axis. NEVER folded from the ledger — repos.router.ts:822-830 is explicit
-- that GIT ITSELF is the source (a hand-written or nested pattern rule leaves no ledger
-- event). THREE-VALUED: the ABSENCE of a row means UNDETERMINED, which is NOT "not
-- ignored" (performance.mdx P-37 fix 4). Carries its own freshness stamp because it is a
-- cache of a SUBPROCESS, not of a file.
CREATE TABLE {{S}}.file_gitignore (
  unit_id     bigint NOT NULL,
  rel_posix   text   NOT NULL,
  ignored     boolean NOT NULL,
  locked      boolean NOT NULL DEFAULT false,   -- a rule Large File Bridge must not rewrite
  rule_source text,                             -- basename, e.g. '.gitignore'
  rule_line   int CHECK (rule_line IS NULL OR rule_line > 0),
  rule_pattern text,
  checked_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (unit_id, rel_posix),
  FOREIGN KEY (unit_id, rel_posix) REFERENCES {{S}}.file(unit_id, rel_posix) ON DELETE CASCADE
);

-- The charter's two-hashes-per-compressible-file rule, as ROWS rather than as YAML
-- nesting: for one logical file we may be tracking both the compressed and the
-- uncompressed fingerprint, and each carries its own size.
CREATE TABLE {{S}}.file_variant (
  unit_id    bigint NOT NULL,
  rel_posix  text   NOT NULL,
  variant    text   NOT NULL CHECK (variant IN ('uncompressed','compressed')),
  algo       text   NOT NULL DEFAULT 'sha256',
  hash       text   NOT NULL,
  size_bytes bigint CHECK (size_bytes IS NULL OR size_bytes >= 0),
  codec      text,
  width      int CHECK (width IS NULL OR width > 0),
  height     int CHECK (height IS NULL OR height > 0),
  duration_s numeric CHECK (duration_s IS NULL OR duration_s >= 0),
  observed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (unit_id, rel_posix, variant),
  FOREIGN KEY (unit_id, rel_posix) REFERENCES {{S}}.file(unit_id, rel_posix) ON DELETE CASCADE
);

-- Perceptual fingerprint — the PhotoDNA-style capability the charter asks for, so that two
-- files that are "fundamentally the same file" after a resize, a re-compress or a PNG->JPEG
-- conversion can be recognized as such.
-- LOCAL-ONLY BY CHARTER: whatever algorithm fills this table must run ENTIRELY locally and
-- must never phone home — we are not a reporting service.
-- Keyed by CONTENT hash rather than by path, so it survives a rename and never needs
-- invalidating.
CREATE TABLE {{S}}.file_fingerprint (
  content_hash text PRIMARY KEY,                 -- sha256 of the bytes
  algo         text NOT NULL CHECK (algo IN ('pdq','vpdq','blockhash')),
  bits         bit(256) NOT NULL,
  quality      smallint,
  computed_at  timestamptz NOT NULL DEFAULT now()
);

-- ── indexes ─────────────────────────────────────────────────────────────────
CREATE INDEX file_event_by_file ON {{S}}.file_event (unit_id, rel_posix, at DESC);
--   SERVES: one file's history (the sidecar's events[] rendered back), and the sidecar
--   re-render. Also the ONLY way today to answer "what happened to this file" without
--   opening its 793-byte YAML.

CREATE INDEX file_event_by_device ON {{S}}.file_event (device_id, kind, at DESC);
--   SERVES: "what did device pc-4-pc-4 pin" — DEVICE FIRST, then kind. The area analyses
--   proposed (kind, on_device), which cannot serve a device-filtered query because
--   Postgres has no skip scan.
-- The constraint file_event_union doubles as the merge index; no separate one is created.

CREATE INDEX file_artifact_kind ON {{S}}.file_artifact (kind, generated_at DESC);
--   SERVES: "everything gemini-flash-latest described in July" and the per-kind rollup
--   counts — questions that are impossible today because the metadata is locked inside
--   12,921 separate artifact bodies.

CREATE INDEX file_gitignore_stale ON {{S}}.file_gitignore (unit_id, checked_at);
--   SERVES: "which paths need a fresh `git check-ignore` batch for this unit". Freshness
--   is a first-class column because the source is a subprocess measured at 2.3 s for 1,875
--   paths (units.service.ts:519-520) — git's own evaluation, not process startup. THAT
--   COST SURVIVES THE MIGRATION IN FULL and must be scheduled, not hidden
--   (database.mdx §8.3).
