-- THE PERCEPTUAL FINGERPRINT CACHE (perceptual_fingerprint.mdx §FD.4, apis.mdx §5).
--
-- One row per FILE PATH holding its PDQ fingerprint — the FINAL engines: PDQ via ajdnik/imghash for images
-- (algo 'pdq'), PDQ per sampled frame for videos (algo 'pdq-frames'). The web app's power option, the REST
-- API and the MCP server all write here, and a repeat request for an unchanged file is answered from this
-- row instead of re-decoding the media.
--
-- WHY A NEW TABLE, NOT file_fingerprint (0009). That table is keyed by CONTENT HASH, holds exactly one
-- bit(256), and is the sidecar plane's twin of `file.fingerprint` inside the per-file YAML (render-gate
-- owned — database.mdx §2). This cache has different needs:
--   * it must answer "is the stored value still valid for THIS path?" without hashing a 4 GB video first,
--     so the key is the path and validity is (size, mtime) — see below;
--   * a video fingerprint is a FRAME LIST, not one 256-bit value;
--   * it covers any file on the computer, not only tracked repo units.
--
-- VALIDITY (the rule the product asked for). A row is valid only while the file still has the size and
-- mtime it had when the row was computed, AND the row was produced by the current engine version. A file
-- modified after its fingerprint was computed therefore has a different mtime and the row is stale; it is
-- recomputed and overwritten. The check lives in fingerprint.store.ts `isValid()`.

CREATE TABLE IF NOT EXISTS {{S}}.perceptual_fp (
  abs_path      text PRIMARY KEY,
  kind          text NOT NULL CHECK (kind IN ('image', 'video')),
  algo          text NOT NULL CHECK (algo IN ('pdq', 'pdq-frames')),
  algo_version  text NOT NULL,
  size_bytes    bigint NOT NULL CHECK (size_bytes >= 0),
  mtime_ms      double precision NOT NULL,
  value         text NOT NULL,                  -- 64 hex: the image hash, or a video's representative frame
  quality       smallint CHECK (quality IS NULL OR quality BETWEEN 0 AND 100),
  frame_count   integer CHECK (frame_count IS NULL OR frame_count >= 0),
  frames        text,                           -- video only: "n,hex,quality,ts" lines (the .vpdq line format)
  duration_s    double precision,
  strategy      text,                           -- video only: the decode plan that produced the frames
  compute_ms    double precision,
  computed_at   timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE {{S}}.perceptual_fp IS
  'PDQ perceptual fingerprint cache, one row per path; valid while (size_bytes, mtime_ms, algo_version) '
  'still match the file (perceptual_fingerprint.mdx §FD.4).';

-- SERVES: "which files look like this one?" — an exact-value probe before the Hamming scan.
CREATE INDEX IF NOT EXISTS perceptual_fp_value ON {{S}}.perceptual_fp (value);

-- SERVES: directory-scoped reads (lookup and CSV export for a whole directory) via a prefix range scan.
CREATE INDEX IF NOT EXISTS perceptual_fp_path_prefix ON {{S}}.perceptual_fp (abs_path text_pattern_ops);
