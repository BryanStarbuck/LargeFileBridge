-- THE COLUMN THAT TWO WRITERS WANTED TO MEAN TWO THINGS (database.mdx §2.3).
--
-- THE EVIDENCE. The render equality gate — the check that must pass before Postgres is allowed to feed a
-- Category-B document's serializer — came back RED at full corpus scope on 2026-08-24:
--
--     documents on disk examined : 29447
--     rendered and BYTE-IDENTICAL: 13474
--     rendered and DIFFERENT     : 15868
--
-- and 34 distinct diff shapes were dominated by one line, `modified:`, with a second, much rarer shape on
-- `size:`. A worked example from the run:
--
--     sidecar on disk : modified: 2026-04-28T00:26:13.508Z   size 759712
--     live filesystem : 2026-04-28T15:16:20Z mtime           759712 bytes
--     lfb.file row    : modified_at 2026-04-28 18:16:20.558-07
--
-- THE CAUSE IS NOT THE RENDERER. It is that `lfb.file.modified_at` has two writers with two DIFFERENT
-- MEANINGS, and both of them are right:
--
--   * THE SCAN CENSUS (area 3, file.repo.ts) writes the LIVE stat. It has to: `size_bytes` drives `is_big`,
--     the compression rollups and every "large files only" tab, and a stale size there is a wrong answer on
--     a user-visible surface.
--   * THE SIDECAR (area 6, file-detail.repo.ts) stores the size and mtime AS OF the last time Large File
--     Bridge itself touched the file. That is not a stale measurement — it is a DIFFERENT FACT, and it is
--     the fact the sidecar document is required to state when it is re-serialized.
--
-- The previous compromise (fill `size_bytes` only when it is still the 0 default; `COALESCE` the existing
-- `modified_at`) protects the census's fresh measurement correctly, and that behaviour is KEPT. But it also
-- means the sidecar's own value is discarded, so the document can never be reproduced byte-for-byte — which
-- is exactly what the gate measured.
--
-- ONE COLUMN CANNOT HOLD BOTH FACTS. So the sidecar gets its own, and each writer owns what it writes (R5).
-- `sidecar_modified_at` and `sidecar_size_bytes` are written ONLY by the sidecar plane and read ONLY by
-- `renderSidecar`; nothing on a query path may use them, because they are deliberately not the live truth.
--
-- WHY BOTH ARE NULLABLE, and why `sidecar_size_bytes` has NO `>= 0` CHECK like its live twin:
-- `FileSidecarSchema` (shared/src/schemas.ts:748-750) declares `size: z.number().nullable().default(null)`
-- and `modified: iso.optional()`. A sidecar on disk may legitimately say `size: null`, and it may omit
-- `modified` entirely. NULL here therefore means "the document said null / said nothing", which is a value
-- the renderer must be able to reproduce — it is NOT "we do not know yet". Rendering `size: 0` where the
-- document says `size: null` is one of the diff shapes this migration exists to remove.

ALTER TABLE {{S}}.file
  ADD COLUMN IF NOT EXISTS sidecar_size_bytes  bigint,
  ADD COLUMN IF NOT EXISTS sidecar_modified_at timestamptz;

COMMENT ON COLUMN {{S}}.file.sidecar_size_bytes IS
  'Sidecar-owned. The size the files/<rel>.yaml document states, which may be NULL by schema. Written only '
  'by the sidecar plane, read only by renderSidecar. NEVER use on a query path — size_bytes is the live '
  'measurement (database.mdx §2.3).';

COMMENT ON COLUMN {{S}}.file.sidecar_modified_at IS
  'Sidecar-owned. The mtime AS OF the last time Large File Bridge touched the file, as the sidecar document '
  'states it — a different fact from the live stat in modified_at, not a staler one. Written only by the '
  'sidecar plane, read only by renderSidecar (database.mdx §2.3).';

-- NO INDEX, DELIBERATELY. These two columns have exactly one reader, `renderSidecar`, which always arrives
-- by the primary key (unit_id, rel_posix). An index would be pure write cost on the table this schema most
-- needs to stay cheap to update — 44,868 rows today, and migration 0014 already tightened its autovacuum
-- because a pin-pass-shaped UPDATE was taking Heap Fetches on the covering index from 0 to non-zero.
