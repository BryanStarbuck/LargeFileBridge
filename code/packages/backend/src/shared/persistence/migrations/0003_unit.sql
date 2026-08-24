-- ============================================================================
-- 0003_unit — the canonical unit row, its settings, its scan state, its rollup.
--
-- THE NAMING LAW, unit half (database.mdx §3). `{{S}}.unit.unit_id bigint` is the ONLY
-- FK target in the schema. The five spellings the code already uses are COLUMNS on
-- that one row, so no caller has to change its vocabulary:
--     abs_path      the natural key (UNIQUE) — everything else derives from it
--     repo_key      sha1(resolve(abs_path))[0:12]   tracking-root.service.ts:26
--     repo_id       sha1(resolve(abs_path))[0:16]   units.service.ts:69
--     storage_sid   = repo_key for a repo; 'personal'; or the community id
--                                                   storage.service.ts:75
--     pin_folder    the pin/r/<folder> directory name
--     repo_uid      sha1(lower(host/owner/repo))[0:12], NULL when no remote
--                                                   repo-identity.ts repoUidFor
-- repo_key / repo_id / storage_sid are the SAME sha1 at different lengths. They are
-- STORED, NOT RECOMPUTED, because Postgres cannot reproduce the TypeScript hash and
-- must never disagree with it.
--
-- This is the slice that kills folderForRepoId's 105-config linear scan
-- (units.service.ts:187, reached from 16 call sites in repos.router.ts).
-- ============================================================================

CREATE TABLE {{S}}.unit (
  unit_id      bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  kind         {{S}}.unit_kind NOT NULL,
  abs_path     text NOT NULL,                   -- path.resolve()d; '' only for kind='computer'
  -- the five existing spellings, all app-supplied, all stored so nothing recomputes a TS hash in SQL
  repo_key     char(12),                        -- sha1(abs_path)[0:12]
  repo_id      char(16),                        -- sha1(abs_path)[0:16]
  storage_sid  text NOT NULL,
  pin_folder   text,                            -- pin/r/<folder> | 'computer' | pin/s/<id>
  repo_uid     char(12),                        -- NULL => no remote => CANNOT mirror (repo-identity.ts)
  slug_local   text NOT NULL DEFAULT '',        -- basename(abs_path)   -> repos/<slug>-<repoKey>/
  slug_shared  text,                            -- remote repo name     -> <sdl>/repos/<slug>-<repoUid>/
  name         text NOT NULL DEFAULT '',        -- user-editable display name (repo_storage.yaml)
  remote       text,
  sync_repo_id smallint REFERENCES {{S}}.sync_repo(sync_repo_id) ON DELETE SET NULL,
  mirror_optout boolean,                        -- TRI-STATE: NULL = default ON (schemas.ts sync_repo.enabled)
  present      boolean NOT NULL DEFAULT true,   -- repo_state 'present' | 'missing'
  enlisted_at        timestamptz,
  enlisted_by        smallint REFERENCES {{S}}.person(person_id) ON DELETE SET NULL,
  enlisted_on_device smallint REFERENCES {{S}}.device(device_id) ON DELETE SET NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT unit_abs_path_unique UNIQUE (abs_path),
  CONSTRAINT unit_repo_has_keys
    CHECK (kind <> 'repo' OR (repo_key IS NOT NULL AND repo_id IS NOT NULL AND pin_folder IS NOT NULL)),
  CONSTRAINT unit_computer_pathless
    CHECK (kind = 'computer' OR length(abs_path) > 0)
);

-- FOUR SEPARATE PARTIAL UNIQUE INDEXES, not one composite, because each is a distinct
-- entry point from a different layer: the HTTP route id (repo_id), the Local-Storage
-- directory key (repo_key), the Storages tab (storage_sid) and the pin unit
-- (pin_folder). Together they turn folderForRepoId's linear scan of all 105
-- pin/r/*/config.yaml — run on EVERY /api/repos/:repoId* route — into one lookup.
CREATE UNIQUE INDEX unit_repo_key_uq   ON {{S}}.unit (repo_key)   WHERE repo_key IS NOT NULL;
CREATE UNIQUE INDEX unit_repo_id_uq    ON {{S}}.unit (repo_id)    WHERE repo_id IS NOT NULL;
CREATE UNIQUE INDEX unit_pin_folder_uq ON {{S}}.unit (pin_folder) WHERE pin_folder IS NOT NULL;
CREATE UNIQUE INDEX unit_sid_uq        ON {{S}}.unit (storage_sid);
CREATE INDEX        unit_repo_uid_idx  ON {{S}}.unit (repo_uid)   WHERE repo_uid IS NOT NULL;

CREATE INDEX unit_kind_name ON {{S}}.unit (kind, name);
--   SERVES: GET /api/storages (StoragesPage, tableId='storages'), which lists by type
--   then name. kind-leading because the page always filters by kind first.

-- pin/r/<folder>/config.yaml minus its `decisions:` map (which becomes file.decision).
CREATE TABLE {{S}}.unit_setting (
  unit_id                 bigint PRIMARY KEY REFERENCES {{S}}.unit(unit_id) ON DELETE CASCADE,
  pinned                  boolean NOT NULL DEFAULT false,
  bookmarked              boolean NOT NULL DEFAULT false,
  big_file_override_on    boolean NOT NULL DEFAULT false,
  big_file_override_bytes bigint  CHECK (big_file_override_bytes IS NULL OR big_file_override_bytes > 0),
  follow_gitignore        boolean NOT NULL DEFAULT true,
  include_globs           text[]  NOT NULL DEFAULT '{}',
  exclude_globs           text[]  NOT NULL DEFAULT '{}',
  pin_locally             boolean NOT NULL DEFAULT true,
  fetch_missing           boolean NOT NULL DEFAULT true,
  publish_manifest        boolean NOT NULL DEFAULT true,   -- GATES the tracking-manifest write, pin.service.ts:793
  access_shared           boolean NOT NULL DEFAULT false,
  access_participants     text[]  NOT NULL DEFAULT '{}',
  transcription_placement {{S}}.placement NOT NULL DEFAULT 'tracking_base',
  description_placement   {{S}}.placement NOT NULL DEFAULT 'tracking_base',
  ocr_placement           {{S}}.placement NOT NULL DEFAULT 'tracking_base',
  owner_override_kind     text CHECK (owner_override_kind IN ('personal','company')),
  owner_override_company  text,
  recommend_ipfs_pin      boolean NOT NULL DEFAULT true,
  recommend_compress      boolean NOT NULL DEFAULT true,
  recommend_transcribe    boolean NOT NULL DEFAULT false,
  updated_at              timestamptz NOT NULL DEFAULT now()
);

-- pin/r/<folder>/status.yaml scalars + repo_storage.yaml last_scan. MACHINE-LOCAL,
-- never projected out — `last_scan` and `counts` are exactly what
-- projectRepoStorageToMirror scrubs on the way to the wire
-- (tracking-sync.service.ts:447, MACHINE_LOCAL_REPO_STORAGE at :432).
CREATE TABLE {{S}}.unit_scan (
  unit_id                  bigint PRIMARY KEY REFERENCES {{S}}.unit(unit_id) ON DELETE CASCADE,
  last_scan_at             timestamptz,
  last_scan_device         smallint REFERENCES {{S}}.device(device_id) ON DELETE SET NULL,
  last_scan_headless       boolean NOT NULL DEFAULT false,
  scan_source              text NOT NULL DEFAULT 'scheduled' CHECK (scan_source IN ('scheduled','manual')),
  last_pin_at              timestamptz,
  effective_threshold_bytes bigint NOT NULL DEFAULT 104857600 CHECK (effective_threshold_bytes > 0),
  big_file_count           int    NOT NULL DEFAULT 0 CHECK (big_file_count >= 0),
  big_file_bytes           bigint NOT NULL DEFAULT 0 CHECK (big_file_bytes >= 0),
  scan_dropped_candidates  int    NOT NULL DEFAULT 0 CHECK (scan_dropped_candidates >= 0),
  candidate_gen            bigint NOT NULL DEFAULT 0,   -- bumped per scan; sweeps stale file.is_candidate
  last_error               text
);

-- status.yaml `orphans:` — decided files whose bytes vanished, with the grace period.
CREATE TABLE {{S}}.unit_orphan (
  unit_id       bigint NOT NULL REFERENCES {{S}}.unit(unit_id) ON DELETE CASCADE,
  rel_posix     text   NOT NULL,
  first_seen_at timestamptz NOT NULL,
  cid_canon     text REFERENCES {{S}}.cid(cid_canon) ON DELETE SET NULL,
  PRIMARY KEY (unit_id, rel_posix)
);

-- THE MAINTAINED ROLLUP. Read by the Repos list and every metric tile; NEVER computed
-- live. MEASURED JUSTIFICATION: the live equivalent (GROUP BY over 30,758 candidate
-- rows) is 27.9 ms; reading this table is sub-millisecond. `partial` is
-- performance.mdx P-38's honesty flag — a rollup that is still provisional says so
-- rather than showing a number that will change under the user.
CREATE TABLE {{S}}.unit_rollup (
  unit_id             bigint PRIMARY KEY REFERENCES {{S}}.unit(unit_id) ON DELETE CASCADE,
  file_count          int    NOT NULL DEFAULT 0,
  bytes_total         bigint NOT NULL DEFAULT 0,
  bytes_pinned        bigint NOT NULL DEFAULT 0,
  n_pinned            int NOT NULL DEFAULT 0,
  n_pending           int NOT NULL DEFAULT 0,
  n_undecided         int NOT NULL DEFAULT 0,
  n_ignored           int NOT NULL DEFAULT 0,
  n_pinned_foreign    int NOT NULL DEFAULT 0,
  n_not_backed_up     int NOT NULL DEFAULT 0,
  n_missing_here      int NOT NULL DEFAULT 0,
  peer_count          int NOT NULL DEFAULT 0,          -- OTHER devices only (ipfs.mdx §1.1)
  n_big_not_ignored   int NOT NULL DEFAULT 0,          -- charter rollup row 3
  n_big_ignored_untracked int NOT NULL DEFAULT 0,      -- charter rollup row 4
  n_compressible_videos int NOT NULL DEFAULT 0,        -- charter rollup row 1
  n_compressible_images int NOT NULL DEFAULT 0,        -- charter rollup row 2
  n_already_compressed  int NOT NULL DEFAULT 0,
  n_transcribable     int NOT NULL DEFAULT 0,
  n_transcribed       int NOT NULL DEFAULT 0,
  n_describable       int NOT NULL DEFAULT 0,
  n_described         int NOT NULL DEFAULT 0,
  n_ocrable           int NOT NULL DEFAULT 0,
  n_ocred             int NOT NULL DEFAULT 0,
  computed_at         timestamptz NOT NULL DEFAULT now(),
  partial             boolean NOT NULL DEFAULT false,
  CONSTRAINT rollup_nonneg CHECK (file_count >= 0 AND bytes_total >= 0 AND peer_count >= 0)
);

-- The PK (unit_id) is the only index the Repos list needs: it is
-- `SELECT ... FROM unit u JOIN unit_rollup r USING (unit_id) ORDER BY u.bookmarked
-- DESC, u.name` over 105 rows — a seq scan + sort at ~0.3 ms. Adding an index to 105
-- rows is decoration.
CREATE INDEX unit_rollup_dirty ON {{S}}.unit_rollup (computed_at) WHERE partial;
--   SERVES: the health probe "which rollups are still provisional" (P-38 honesty).
--   Partial so the index holds only the handful of in-flight units, never all 105.
