-- ============================================================================
-- 0012_sync_fence — the render gate and the fence's evidence table.
--
-- NOTHING BEFORE THIS MIGRATION MAY RENDER YAML FROM POSTGRES. This is the migration that
-- turns the write path from "always render" into "render only what changed", and
-- simultaneously installs the table the fence's violation detector reads.
--
-- THE FENCE, as an enforceable rule (database.mdx §2.2):
--   A byte that will be read by another of the user's computers must be produced by a
--   DESIGNATED SERIALIZER writing a file under a Syncable Data Location, and Postgres must
--   appear nowhere in that write's causal chain except as the source of the values the
--   serializer is handed.
-- One serializer per travelling document, and it does not change. This work creates no new
-- YAML writer.
--
-- THE RENDER EQUALITY GATE (database.mdx §2.3): for every (unit, doc) row here, render the
-- document from Postgres through its designated serializer and compare sha256 against the
-- bytes on disk. ZERO DIFFS, OR THE CUTOVER DOES NOT HAPPEN. It is the right test because
-- tracking-sync.service.ts:225-234 records that 58 of the last 60 device commits were a
-- lone `updated_at` line: a renderer that is ONE BYTE off turns every mirror pass into a
-- commit, and two computers into a re-render loop.
-- ============================================================================

-- ONE ROW PER (unit, document) THAT CROSSES THE BOUNDARY. This table is the fence AND the
-- reason the write path gets faster: `rendered_sha256` is what we last wrote to disk, so
-- the renderer SKIPS a document whose bytes have not changed — which is what makes
-- copyTrackedFile's sameBytes short-circuit and mirror-memo's identity check actually fire.
-- `ingested_sha256` is what we last parsed IN from the SDL.
CREATE TABLE {{S}}.doc_render (
  unit_id         bigint NOT NULL REFERENCES {{S}}.unit(unit_id) ON DELETE CASCADE,
  doc             {{S}}.doc_kind NOT NULL,
  doc_key         text NOT NULL DEFAULT '',      -- rel_posix for sidecar/compression, device label for history
  rendered_sha256 char(64),
  rendered_at     timestamptz,
  rendered_bytes  bigint CHECK (rendered_bytes IS NULL OR rendered_bytes >= 0),
  ingested_sha256 char(64),
  ingested_at     timestamptz,
  ingested_from   text,                          -- absolute path of the SDL copy parsed
  PRIMARY KEY (unit_id, doc, doc_key)
);
-- The PK (unit_id, doc, doc_key) SERVES the render gate itself: before writing a document,
-- compute its sha256 and compare. A match means skip the write entirely.

-- Per (SDL, unit) reconcile watermark. Replaces mirror-memo.json's DST HALF ONLY — the SRC
-- half (the SDL file's ino/size/mtimeNs) STAYS in mirror-memo.json, because `pairSettled`
-- means "this job ran to completion and NEITHER file has moved"
-- (tracking-sync.service.ts:666-670), and the SDL side's identity is a fact about a file
-- Postgres must never own (database.mdx §6.9).
CREATE TABLE {{S}}.sdl_ingest (
  sync_repo_id  smallint NOT NULL REFERENCES {{S}}.sync_repo(sync_repo_id) ON DELETE CASCADE,
  unit_id       bigint   NOT NULL REFERENCES {{S}}.unit(unit_id) ON DELETE CASCADE,
  last_ingest_at timestamptz NOT NULL DEFAULT now(),
  events_in      bigint NOT NULL DEFAULT 0,
  claims_in      bigint NOT NULL DEFAULT 0,
  PRIMARY KEY (sync_repo_id, unit_id)
);

CREATE INDEX doc_render_dirty ON {{S}}.doc_render (unit_id)
  WHERE rendered_sha256 IS DISTINCT FROM ingested_sha256;
--   SERVES: "which documents differ between what we wrote out and what last came in" — the
--   pre-mirror work list, and the input to the fence's detection test. MEASURED target for
--   the whole 29,745-document scope: 20 ms. IS DISTINCT FROM rather than <> because either
--   side is NULL on a document we have only ever written or only ever read, and those are
--   exactly the rows the work list must include.
