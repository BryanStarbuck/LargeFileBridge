-- ============================================================================
-- 0002_dimensions — the 11 enums and the four dimension tables.
--
-- These are pure dimensions with no dependents, so they can be seeded and verified
-- before anything references them (database.mdx §4).
--
-- THE NAMING LAW that the rest of the schema obeys, stated once here because this is
-- where its dimension tables land. It resolves every place two area analyses invented
-- different keys for the same thing:
--
--   * ONE device identity. `{{S}}.device.device_id smallint`. `pinned_by` labels and
--     `history/<device>.txt` filenames are DIFFERENT spellings of one computer
--     (history-log.service.ts sanitizes; `pinned_by` does not) — so both are columns
--     on the one row, and no caller has to change its vocabulary.
--   * ONE cid identity. `cid_canon` (canonical CIDv1 base32) is the join key;
--     `cid_text` is the verbatim value as the fleet recorded it and is NEVER locally
--     rewritten (cid-equivalence.service.ts). Postgres CANNOT compute canonicalCid —
--     ipfs.service.ts:757 is a base58→base32 rewrap in TypeScript — so the app
--     supplies it and a CHECK forbids NULL.
-- ============================================================================

-- ── enums ────────────────────────────────────────────────────────────────────
CREATE TYPE {{S}}.unit_kind       AS ENUM ('repo','personal','company','community','computer','storage');
CREATE TYPE {{S}}.decision_axis   AS ENUM ('sync','ignore','undecided');   -- FROZEN wire literals
CREATE TYPE {{S}}.task_state      AS ENUM ('could','done','na');
CREATE TYPE {{S}}.artifact_kind   AS ENUM ('transcript','description','ocr','visuals_by_time','compression');
CREATE TYPE {{S}}.placement       AS ENUM ('tracking_base','beside','legacy_lfbridge','sync_repo','local_state');
CREATE TYPE {{S}}.file_event_kind AS ENUM ('observed','decision','ipfs_pin','compress','convert','transcribe','pull');
CREATE TYPE {{S}}.claim_origin    AS ENUM ('local','wire');  -- manifest-merge.ts:123-128 asymmetry
CREATE TYPE {{S}}.alias_kind      AS ENUM ('equivalent','superseded');
CREATE TYPE {{S}}.doc_kind        AS ENUM ('manifest','decisions','decisions_policy','repo_storage',
                                           'sidecar','history','compression','files_index');
CREATE TYPE {{S}}.media_kind      AS ENUM ('video','image','audio','pdf');
CREATE TYPE {{S}}.pin_type        AS ENUM ('recursive','direct','mfs');

-- ── 1. DIMENSIONS ────────────────────────────────────────────────────────────

CREATE TABLE {{S}}.device (
  device_id      smallint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  label          text NOT NULL UNIQUE,          -- pinned_by spelling, e.g. 'pc-10-pc10-mint'
  folder_key     text,                          -- history/<device>.txt spelling (sanitize.ts repoFolderKey)
  is_self        boolean NOT NULL DEFAULT false,-- computerLabel() on THIS machine
  ipfs_peer_id   text,
  first_seen_at  timestamptz NOT NULL DEFAULT now(),
  last_seen_at   timestamptz,
  CONSTRAINT device_label_nonblank CHECK (length(label) > 0)
);
-- At most one self. A partial unique index enforces it; a plain CHECK cannot, because
-- the rule is about the table and not about a row. This matters more than it looks:
-- `is_self` is what separates "pinned on THIS computer" from "a peer says it holds
-- this" (ipfs.mdx §1.1), and two self rows would make that question unanswerable.
CREATE UNIQUE INDEX device_one_self ON {{S}}.device ((is_self)) WHERE is_self;

CREATE TABLE {{S}}.person (
  person_id  smallint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  email      {{S}}.citext UNIQUE,               -- allow-listed Google email, or NULL for a sentinel
  handle     text UNIQUE,                       -- u_<12hex> from decision_handles.yaml (SALT stays on disk)
  sentinel   text UNIQUE,                       -- 'not-lfbridge' | 'policy:<email>' | 'anonymous'
  CONSTRAINT person_has_one_identity
    CHECK (num_nonnulls(email, handle, sentinel) >= 1)
);

CREATE TABLE {{S}}.cid (
  cid_canon       text PRIMARY KEY,             -- canonicalCid() output, app-computed
  cid_text        text NOT NULL,                -- verbatim first-seen spelling
  dag_kind        text CHECK (dag_kind IN ('file','directory')),
  cumulative_size bigint CHECK (cumulative_size IS NULL OR cumulative_size >= 0),
  first_seen_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT cid_canon_nonblank CHECK (length(cid_canon) > 0)
);

-- An SDL: the personal / company sync repo whose working tree the mirror writes into.
CREATE TABLE {{S}}.sync_repo (
  sync_repo_id  smallint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  abs_path      text NOT NULL UNIQUE,           -- e.g. ~/BGit/act3/act3_large_files_bridge
  storage_sid   text NOT NULL,
  name          text NOT NULL DEFAULT '',
  last_push_at        timestamptz,
  last_failure_at     timestamptz,
  consecutive_failures int NOT NULL DEFAULT 0 CHECK (consecutive_failures >= 0),
  last_problem        text,
  unpushed_commits    int NOT NULL DEFAULT 0 CHECK (unpushed_commits >= 0)
);
