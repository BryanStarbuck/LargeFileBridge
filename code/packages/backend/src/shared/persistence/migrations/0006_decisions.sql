-- ============================================================================
-- 0006_decisions — the decision plane: the append-only ledger, the MAINTAINED fold,
-- the per-repo policy, and the email->handle map.
--
-- This is database.mdx §9 slice 6, and the measurement behind it is the single biggest
-- correction to the area analyses. Taken on this machine against the real
-- 18,234-event ledger:
--     DISTINCT ON over the raw log, largest unit (11,423 events)  ..... 96.0 ms (seq+sort)
--     same, with enable_seqscan=off forcing the covering index  ....... 40.2 ms
--     reading the maintained table for the same unit .................. 0.23 ms
--     fleet-wide aggregate off the maintained table ................... 0.37 ms
-- The area analyses assumed the indexed DISTINCT ON was sub-2 ms. It is 40-96 ms. The
-- fold is therefore STORED, never computed on a read path.
-- ============================================================================

-- The append-only ledger. The UNIQUE is the FULL eventIdentity of ledger-merge.ts:24-26
-- — sid, path, fingerprint, asked, ipfs, gitignore, decided_by, decided_at. Omitting
-- `sid` (as one area analysis proposed) collapses genuinely distinct events: the live
-- charlie-kirk ledger carries 5 distinct sids for one storage. `rel_path` is byte-exact
-- because event identity must stay byte-exact; `rel_posix` is generated and is what the
-- fold joins on.
-- NULLS NOT DISTINCT is load-bearing here for the same reason as file_event: `fingerprint`
-- and `decided_by` are nullable, and under the default NULLS DISTINCT two identical
-- events with a NULL in either column would never collide, so every reconcile pass would
-- re-insert them forever.
CREATE TABLE {{S}}.decision_event (
  decision_event_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  unit_id     bigint NOT NULL REFERENCES {{S}}.unit(unit_id) ON DELETE CASCADE,
  sid         text   NOT NULL,
  rel_path    text   NOT NULL,
  rel_posix   text   GENERATED ALWAYS AS (replace(rel_path, '\', '/')) STORED,
  fingerprint text,
  asked       boolean NOT NULL DEFAULT true,
  ipfs        boolean NOT NULL DEFAULT false,
  gitignore   boolean NOT NULL DEFAULT false,
  decided_by  text,                              -- kept as TEXT, byte-exact, for re-render
  decided_at  timestamptz NOT NULL,
  origin      {{S}}.claim_origin NOT NULL DEFAULT 'local',
  CONSTRAINT decision_event_identity UNIQUE NULLS NOT DISTINCT
    (unit_id, sid, rel_path, fingerprint, asked, ipfs, gitignore, decided_by, decided_at)
);

-- THE MAINTAINED FOLD. Not a view, not a DISTINCT ON on the read path. Maintained by an
-- AFTER INSERT trigger applying foldLedger's exact rule (decisions.service.ts:145-157):
-- latest decided_at wins; ties break by decided_by lexical, with NULL sorting as ''.
-- readLedger/foldLedger keep working unchanged and become the VERIFICATION ORACLE — CI
-- asserts this table equals foldLedger(readLedger(root)) for every unit, after every
-- mirror-in (database.mdx §4.1).
CREATE TABLE {{S}}.file_decision (
  unit_id     bigint NOT NULL REFERENCES {{S}}.unit(unit_id) ON DELETE CASCADE,
  rel_posix   text   NOT NULL,
  sid         text   NOT NULL,                   -- provenance of the winning event
  asked       boolean NOT NULL,
  ipfs        boolean NOT NULL,
  gitignore   boolean NOT NULL,                  -- the ledger's INTENT axis, NOT git's verdict
  decided_by  text,
  decided_at  timestamptz NOT NULL,
  winning_event_id bigint NOT NULL REFERENCES {{S}}.decision_event(decision_event_id) ON DELETE CASCADE,
  PRIMARY KEY (unit_id, rel_posix)
);
-- file_decision's PK (unit_id, rel_posix) SERVES every read: the decision-provenance
-- probe behind every visible row on the One-Repo table, at ~1 ms for a whole page.

-- decisions_policy.yaml — the SHARED per-repo default-decision + attribution policy.
-- MISSED BY EVERY AREA ANALYSIS AND A LIVE BUG (database.mdx §2.1): LOCAL_ONLY is
-- {.sync-repo, .durable-artifact} (tracking-sync.service.ts:50) and MERGED_NEVER_COPIED
-- is {manifest.yaml, decisions.yaml, repo_storage.yaml} (:61); copyTreeGen applies both
-- sets ONLY at rel==="" (:196). So this file — which carries user intent — is
-- plain-copied LAST-WRITER-WINS in BOTH directions today. It is NEW STATE, not a port:
-- the file exists in code (decisions.service.ts:82-83) but zero copies exist on disk.
CREATE TABLE {{S}}.unit_decision_policy (
  unit_id        bigint PRIMARY KEY REFERENCES {{S}}.unit(unit_id) ON DELETE CASCADE,
  attribution    text CHECK (attribution IN ('email','handle','anonymous')),  -- NULL = auto
  media_mode     text NOT NULL DEFAULT 'ask'  CHECK (media_mode IN ('auto','ask')),
  media_ipfs     boolean NOT NULL DEFAULT true,
  media_gitignore boolean NOT NULL DEFAULT true,
  other_mode     text NOT NULL DEFAULT 'ask'  CHECK (other_mode IN ('auto','ask')),
  other_ipfs     boolean NOT NULL DEFAULT false,
  other_gitignore boolean NOT NULL DEFAULT false,
  set_by         text,
  set_at         timestamptz
);

-- email -> opaque handle. THE SALT NEVER ENTERS POSTGRES: it stays in
-- ~/T/_large_files_bridge/decision_handles.yaml, because the handle it mints TRAVELS in
-- the SDL ledger and the salt is the de-opaquing key for pseudonymous attributions other
-- people can see (decisions.service.ts:747).
CREATE TABLE {{S}}.decision_handle (
  email   {{S}}.citext PRIMARY KEY,
  handle  text NOT NULL UNIQUE CHECK (handle ~ '^u_[0-9a-f]{12}$')
);

-- ── the fold trigger ────────────────────────────────────────────────────────
-- Implemented ONCE, in SQL, so two computers cannot fold differently. The tie-break is a
-- total order on the value with plain `>`, never `localeCompare` — two computers must not
-- disagree because of collation (database.mdx §2.2).
CREATE FUNCTION {{S}}.fold_decision() RETURNS trigger LANGUAGE plpgsql AS $fold$
BEGIN
  INSERT INTO {{S}}.file_decision AS d
    (unit_id, rel_posix, sid, asked, ipfs, gitignore, decided_by, decided_at, winning_event_id)
  VALUES (NEW.unit_id, NEW.rel_posix, NEW.sid, NEW.asked, NEW.ipfs, NEW.gitignore,
          NEW.decided_by, NEW.decided_at, NEW.decision_event_id)
  ON CONFLICT (unit_id, rel_posix) DO UPDATE
    SET sid = EXCLUDED.sid, asked = EXCLUDED.asked, ipfs = EXCLUDED.ipfs,
        gitignore = EXCLUDED.gitignore, decided_by = EXCLUDED.decided_by,
        decided_at = EXCLUDED.decided_at, winning_event_id = EXCLUDED.winning_event_id
    WHERE (EXCLUDED.decided_at, coalesce(EXCLUDED.decided_by,''))
        > (d.decided_at,        coalesce(d.decided_by,''));
  RETURN NULL;
END $fold$;

CREATE TRIGGER lfb_decision_fold AFTER INSERT ON {{S}}.decision_event
  FOR EACH ROW EXECUTE FUNCTION {{S}}.fold_decision();

-- ── indexes ─────────────────────────────────────────────────────────────────
CREATE INDEX decision_event_fold ON {{S}}.decision_event
  (unit_id, rel_posix, decided_at DESC, decided_by DESC NULLS LAST);
--   SERVES: the trigger's re-fold after a DELETE or a corrective ingest, and the
--   provenance drill-down. It is NOT on the read path — see the measurement at the top.

CREATE INDEX decision_event_serialize ON {{S}}.decision_event (unit_id, decided_at, sid, rel_path);
--   SERVES: serializeLedger's byte-stable ORDER BY (ledger-merge.ts unionLedgerEvents
--   sorts decided_at, sid, path, decided_by). Reading the rows ALREADY ORDERED is what
--   makes the re-render cheap enough to run on every change — and the render equality
--   gate (database.mdx §2.3) means a renderer that is one byte off turns every mirror
--   pass into a commit.
