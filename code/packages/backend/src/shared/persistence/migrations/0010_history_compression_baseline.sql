-- ============================================================================
-- 0010_history_compression_baseline — per-device history, per-file compression records,
-- and the LEARNED compressed-vs-uncompressed baseline.
--
-- This is the migration that makes the charter's learned baseline expressible FOR THE
-- FIRST TIME. Today badges.ts:229 decides "is this compressed?" from the file EXTENSION,
-- with `_sizeBytes` and `_threshold` both unused.
-- ============================================================================

-- history/<device>.txt, parsed. The self-owned-file trust model means the merge is a PURE
-- UNION with no conflict (history-log.service.ts:2-4) — each device writes only its own
-- file, so two computers can never disagree about a line.
CREATE TABLE {{S}}.history_entry (
  history_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  unit_id    bigint NOT NULL REFERENCES {{S}}.unit(unit_id) ON DELETE CASCADE,
  device_id  smallint NOT NULL REFERENCES {{S}}.device(device_id) ON DELETE CASCADE,
  at         timestamptz NOT NULL,
  verb       text NOT NULL,
  actor      text,
  fields     jsonb NOT NULL DEFAULT '{}',
  summary    text NOT NULL DEFAULT '',
  per_file   jsonb,
  line_no    int NOT NULL CHECK (line_no > 0),   -- position in that device's file; the resume cursor
  CONSTRAINT history_union UNIQUE NULLS NOT DISTINCT (unit_id, device_id, at, verb, summary)
);

-- analysis/<rel>/compression.yaml — 37 records measured locally, 37 in the act3 SDL, 0 in
-- personal. TRAVELS: `writeLedger` (modules/compress/compress-ledger.ts) stays the
-- designated serializer and this table only feeds it values (database.mdx §2.2).
CREATE TABLE {{S}}.compression_record (
  unit_id        bigint NOT NULL REFERENCES {{S}}.unit(unit_id) ON DELETE CASCADE,
  rel_posix      text   NOT NULL,
  source_rel     text   NOT NULL,
  original_name  text   NOT NULL,
  original_ext   text   NOT NULL DEFAULT '',
  original_size  bigint NOT NULL CHECK (original_size >= 0),
  codec          text,
  compressed_size bigint NOT NULL CHECK (compressed_size >= 0),
  ratio          numeric(8,6) NOT NULL CHECK (ratio > 0),
  compressed_at  timestamptz NOT NULL,
  duration_s     numeric CHECK (duration_s IS NULL OR duration_s >= 0),
  width          int CHECK (width IS NULL OR width > 0),
  height         int CHECK (height IS NULL OR height > 0),
  PRIMARY KEY (unit_id, rel_posix)
);

-- THE LEARNED BASELINE the charter demands: "the mean of the bell curve plus one sigma and
-- two sigma, across a range of durations and a range of pixel sizes."
-- GREENFIELD — nothing implements it today.
-- Normalized on BITS PER PIXEL PER SECOND so one curve generalizes across the whole
-- duration x resolution grid; log-normal, because file sizes are.
-- THE UNIQUE IS THE IDEMPOTENCY KEY: without it a re-run of the backfill DOUBLES every
-- sample and silently moves the mean the classifier reads — which would corrupt the
-- charter's baseline in a way nothing would surface (database.mdx §4.1).
CREATE TABLE {{S}}.compression_sample (
  sample_id    bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  media        {{S}}.media_kind NOT NULL CHECK (media IN ('video','image')),
  content_hash text,
  codec        text,
  container    text,
  duration_s   numeric CHECK (duration_s IS NULL OR duration_s > 0),
  width        int NOT NULL CHECK (width > 0),
  height       int NOT NULL CHECK (height > 0),
  size_bytes   bigint NOT NULL CHECK (size_bytes > 0),
  is_compressed boolean NOT NULL,
  label_source text NOT NULL CHECK (label_source IN
    ('our_encode_output','our_encode_input','in_file_marker','declined_record','user_confirmed')),
  bpps numeric GENERATED ALWAYS AS (
    (size_bytes::numeric * 8) /
    GREATEST(width::numeric * height::numeric * COALESCE(duration_s, 1), 1)
  ) STORED,
  pixel_bucket    int GENERATED ALWAYS AS (floor(log(2, GREATEST(width*height,1)::numeric))::int) STORED,
  duration_bucket int GENERATED ALWAYS AS (floor(log(2, GREATEST(COALESCE(duration_s,1),1)))::int) STORED,
  observed_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT compression_sample_ident UNIQUE NULLS NOT DISTINCT
    (media, content_hash, is_compressed, label_source)
);

-- ── indexes ─────────────────────────────────────────────────────────────────
CREATE INDEX history_by_unit ON {{S}}.history_entry (unit_id, at DESC);
--   SERVES: the per-repo history UI.

CREATE INDEX history_resume ON {{S}}.history_entry (unit_id, device_id, line_no DESC);
--   SERVES: the backfill's resume cursor — history/<device>.txt is APPEND-ONLY, so
--   "ingest from line N+1" is the only way to make a 2.4 MB text re-ingest cheap.

CREATE INDEX compression_shape ON {{S}}.compression_record (width, height, duration_s);
--   SERVES: seeding compression_sample, and the "what did we get for a 1080p clip"
--   question. Today aggregating 37 per-file YAMLs across a mirrored path hierarchy is a
--   full tree walk with no possible index.

CREATE INDEX compression_sample_cell ON {{S}}.compression_sample
  (media, pixel_bucket, duration_bucket, is_compressed);
--   SERVES: THE classifier, and the only index it needs. The query is:
--     WITH cell AS (SELECT is_compressed, count(*) n, avg(ln(bpps)) mu,
--                          stddev_samp(ln(bpps)) sigma
--                     FROM {{S}}.compression_sample
--                    WHERE media=$1 AND pixel_bucket BETWEEN $2-1 AND $2+1
--                      AND duration_bucket BETWEEN $3-1 AND $3+1
--                    GROUP BY is_compressed HAVING count(*) >= 12)
--     SELECT ... (z-score against each hypothesis) ...
--   The +/-1 bucket widening is why the leading three columns must be in EXACTLY this
--   order: media is an equality, the two buckets are ranges, is_compressed is the GROUP BY.
--   HAVING n>=12 is the ABSTENTION RULE — below it the verdict is 'unknown' and the
--   extension heuristic stays in charge, because a wrong "uncompressed" badge is how a user
--   is talked into a needless lossy generation. Seeding from the 74 existing records yields
--   only ~110 samples, so most cells will correctly answer "unknown" for months
--   (database.mdx §8.7).
