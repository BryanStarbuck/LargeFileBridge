-- ############################################################################
-- ##                                                                        ##
-- ##   G A T E D  —  D O   N O T   A P P L Y                                ##
-- ##                                                                        ##
-- ##   THIS MIGRATION MUST NOT BE APPLIED until the slice-12 measurement     ##
-- ##   justifies it (database.mdx §8.1). The default expectation is that it  ##
-- ##   will NOT, and that the right action is to DELETE THIS FILE rather     ##
-- ##   than ship a 726,503-row table for a page that is not slow.            ##
-- ##                                                                        ##
-- ############################################################################
--
-- WHY IT IS GATED, in the words of the open question it belongs to:
--
--   Two of the three numbers used to argue for `fs_dir` do not survive the code as
--   written. `GET /api/repos` measures 0 ms of synchronous handler time in the loop-watch
--   breakdown, and the Full Paths walk truncates on FLAT_ITER_BUDGET alone. DECIDE BY
--   MEASURING `listDirectory('~')` cold and warm AFTER the slice-12 watcher fix. If warm
--   is already 3-6 ms, DELETE {{S}}.fs_dir from the schema.
--
-- The residual cost of the warm listDirectory path is readdir + a per-entry statSync + a
-- `git check-ignore` subprocess. POSTGRES REMOVES NONE OF THOSE THREE. A rollup table that
-- does not remove the cost is 726,503 rows of write amplification bought with nothing.
--
-- Measured under $HOME: 726,503 directories vs 3,254,966 files, of which only 6,647 are
-- >=100 MB. Directories only — that is the only part that would ever pay for itself, and it
-- is why the full 3.25-million-file index is explicitly NOT BUILT (database.mdx §6.11):
-- ~629 MB for data the product has no opinion about.
--
-- HOW THE GATE IS OPERATED: the runner applies every `NNNN_name.sql` it finds in this
-- directory (migrate.ts `loadMigrations`), so leaving this file in place while the gate is
-- shut would apply it. Either the file is deleted (the expected outcome) or the measurement
-- came back the other way and it ships. There is no third state, and no runtime flag —
-- a half-shipped table that some installs have and others do not is worse than either.
--
-- The SQL below is kept verified-valid so the decision is a decision and not a rewrite.
-- ============================================================================

-- THE SUBTREE-INTEREST ROLLUP for the File System column browser.
-- `hidden_*` is a PAIR because `hidden` is a LIVE per-request toggle (fs.router.ts:97) and
-- a single scalar would be wrong in one of the two modes.
CREATE TABLE {{S}}.fs_dir (
  dir_path         text COLLATE "C" PRIMARY KEY,   -- COLLATE "C" for LIKE-prefix support, not for range scans
  parent_path      text COLLATE "C",
  depth            int NOT NULL CHECK (depth >= 0),
  dir_mtime_ms     bigint NOT NULL,
  hard_skipped     boolean NOT NULL DEFAULT false,
  subtree_interest         smallint NOT NULL DEFAULT 0,  -- visible entries only
  subtree_interest_hidden  smallint NOT NULL DEFAULT 0,  -- including dotted entries
  subtree_big_count        int NOT NULL DEFAULT 0,
  subtree_big_count_hidden int NOT NULL DEFAULT 0,
  subtree_bytes            bigint NOT NULL DEFAULT 0,
  rollup_dirty     boolean NOT NULL DEFAULT false,
  scanned_at       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX fs_dir_parent ON {{S}}.fs_dir (parent_path);
--   SERVES: the column browser's children-with-interest-tint, one scan per column.

CREATE INDEX fs_dir_prefix ON {{S}}.fs_dir (dir_path text_pattern_ops);
--   SERVES: subtree questions as `dir_path LIKE $1 || '/%'`.
--   NOTE, CORRECTING AN AREA CLAIM: COLLATE "C" is NOT what makes a RANGE predicate
--   indexable — verified on this server that a default en_US.UTF-8 btree serves
--   `p >= $1 AND p < $2` as an Index Only Scan. COLLATE "C" is here for LIKE-prefix and
--   deterministic byte ordering, nothing more. And any subtree bound must be the '/'->'0'
--   successor (`< $1 || '0'`), NEVER `|| chr(255)`: chr(255) is U+00FF, encoded C3 BF,
--   which sorts BELOW every 4-byte UTF-8 lead byte, so an emoji-named child is silently
--   dropped. Verified.
