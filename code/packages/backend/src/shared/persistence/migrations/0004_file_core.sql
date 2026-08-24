-- ============================================================================
-- 0004_file_core — the file plane: one row per path this unit has ever had an
-- opinion about, plus the two indexes the One-Repo "All" tab needs and nothing else.
--
-- THE NAMING LAW, file half (database.mdx §3). ONE file identity: `(unit_id,
-- rel_posix)`.
--   * `rel_path`  is the BYTE-EXACT spelling last seen on disk, required to re-render
--                 the YAML the SDL carries.
--   * `rel_posix` is a STORED GENERATED column, replace(rel_path,'\','/'), and it is
--                 the PRIMARY-KEY component.
-- VERIFIED on 16.15: a PK over a stored generated column works, and it collapses
-- 'a\b.mp4' and 'a/b.mp4' into ONE row — which makes the stray-path fork
-- (file-sidecar.service.ts `sidecarPath`) structurally impossible instead of healed by
-- hand. It reproduces foldLedger's healWindowsPath key exactly
-- (decisions.service.ts:145-157). A generated column in a PK MUST be STORED; VIRTUAL
-- is not indexable.
--
-- WHY THE UNION AND NOT THE MANIFEST: this row set is the UNION of scan candidates
-- (30,758), sidecar subjects (29,138), decision subjects and manifest paths. Measured
-- on disk: 58 decisions have NO manifest entry, so keying files on the manifest (as one
-- area analysis proposed) silently drops them and the file is re-offered to the user
-- forever. `is_candidate` is what the One-Repo table filters on.
-- ============================================================================

CREATE TABLE {{S}}.file (
  unit_id        bigint NOT NULL REFERENCES {{S}}.unit(unit_id) ON DELETE CASCADE,
  rel_path       text   NOT NULL,                          -- byte-exact, for re-render
  rel_posix      text   GENERATED ALWAYS AS (replace(rel_path, '\', '/')) STORED,
  base_name      text   NOT NULL DEFAULT '',
  dir_posix      text   NOT NULL DEFAULT '',               -- '' at root; prefix key for dir rollups
  file_ext       text   NOT NULL DEFAULT '',

  size_bytes     bigint NOT NULL DEFAULT 0 CHECK (size_bytes >= 0),
  created_at     timestamptz,
  modified_at    timestamptz,
  changed_at     timestamptz NOT NULL DEFAULT now(),       -- the 'changed' column's sort key
  present_local  boolean NOT NULL DEFAULT true,            -- false => remote-only row
  is_candidate   boolean NOT NULL DEFAULT false,           -- appeared in the last scan census
  analysis_only  boolean NOT NULL DEFAULT false,           -- scan.mdx §4.1 rule 5
  candidate_gen  bigint NOT NULL DEFAULT 0,                -- matches unit_scan.candidate_gen; sweep key
  categories     text[] NOT NULL DEFAULT '{}',             -- special_files.mdx
  media          {{S}}.media_kind,                         -- NULL = not media

  -- DENORMALIZED CURRENT STATE. Every one of these is maintained by a named writer
  -- (database.mdx §9); each is a column and not a join because the One-Repo table SORTS
  -- on them, and a sort key inside a join cannot be served by an index.
  decision       {{S}}.decision_axis NOT NULL DEFAULT 'undecided',
  decided_by     smallint REFERENCES {{S}}.person(person_id) ON DELETE SET NULL,
  decided_at     timestamptz,
  compress       {{S}}.task_state,
  transcribe     {{S}}.task_state,
  describe       {{S}}.task_state,
  ocr            {{S}}.task_state,
  looks_compressed boolean,                                -- learned baseline verdict; NULL = unknown
  never_ipfs     boolean NOT NULL DEFAULT false,           -- config.yaml file_flags
  no_compress    boolean NOT NULL DEFAULT false,
  cid_canon      text REFERENCES {{S}}.cid(cid_canon) ON DELETE SET NULL,
  pinned_here    boolean,                                  -- NULL = UNVERIFIED, never defaulted
  pinned_foreign boolean NOT NULL DEFAULT false,
  peer_count     smallint NOT NULL DEFAULT 0 CHECK (peer_count >= 0),  -- OTHER devices only
  transfer       text NOT NULL DEFAULT 'na'
                 CHECK (transfer IN ('na','pending','pinned','fetching','pushing')),
  first_seen_at  timestamptz,
  first_seen_device smallint REFERENCES {{S}}.device(device_id) ON DELETE SET NULL,

  is_big boolean GENERATED ALWAYS AS (size_bytes >= 104857600) STORED,  -- default threshold only;
      -- a per-unit override is applied in the query, never baked into an index predicate.

  PRIMARY KEY (unit_id, rel_posix),
  CONSTRAINT file_rel_path_nonblank CHECK (length(rel_path) > 0),
  CONSTRAINT file_decided_pair CHECK ((decided_at IS NULL) = (decision = 'undecided') OR decided_at IS NOT NULL)
) WITH (fillfactor = 85);   -- the pin pass rewrites transfer/pinned_here/peer_count in bulk,
    -- so leaving 15% free space per page keeps those updates HOT and off the indexes below.

-- ── the One-Repo table's tabs: this migration ships the "All" tab only ───────
-- The seven tabs are ONE query shape: scope to a unit, apply a rowFilter, apply the
-- "Large files only" predicate, sort by two keys, LIMIT 500 (the charter's pagination
-- default). SIX OF THE SEVEN TABS SHIP largeOnlyDefault:true (taskTabs.config.ts) —
-- verified — so size_bytes must be IN the index, not a filter on top of it. That is the
-- correction to the area analyses, which benchmarked the unfiltered variant.

CREATE INDEX file_tab_all ON {{S}}.file (unit_id, size_bytes, changed_at DESC)
  INCLUDE (rel_path, base_name, decision, transfer, peer_count, cid_canon,
           compress, transcribe, describe, ocr, media, analysis_only,
           pinned_here, pinned_foreign, present_local, never_ipfs)
  WHERE is_candidate;
--   SERVES: tab "All" — `WHERE unit_id=$1 AND is_candidate AND size_bytes>=$t
--   ORDER BY changed_at DESC LIMIT 500` (taskTabs.config.ts all.defaultSort).
--   WHY THIS ONE: size_bytes sits between unit_id and the sort key so the largeOnly
--   predicate is a RANGE BOUND inside the index rather than a Filter that discards rows
--   after reading them. INCLUDE makes it index-only, so the pin pass's bulk UPDATE of
--   transfer/peer_count does not force heap fetches on the next read — with the caveat
--   that index-only depends on visibility-map coverage, which is why
--   autovacuum_vacuum_scale_factor=0.02 is set on this table in migration 0014.
--   MEASURED analogue on the real candidate set: 0.52 ms for page 1 of 500.

CREATE INDEX file_candidate_sweep ON {{S}}.file (unit_id, candidate_gen) WHERE is_candidate;
--   SERVES: the post-scan sweep `UPDATE ... SET is_candidate=false WHERE unit_id=$1 AND
--   candidate_gen < $2`. This is what replaces status.yaml's whole-document rewrite
--   (largest measured: 820,891 bytes for one unit) with a bounded update.
