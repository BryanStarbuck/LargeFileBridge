-- ============================================================================
-- 0011_directory_rollup_indexes — the charter's category-rollup table, scoped to a
-- DIRECTORY.
--
-- A separate migration because these indexes are only useful once file.media,
-- file.compress and file.dir_posix are POPULATED, which is backfill slice 5. Shipping
-- them earlier would cost write amplification on an empty predicate for nothing.
--
-- TWO INDEX NOTES THAT COST REAL CORRECTNESS (database.mdx §5):
--   * `text_pattern_ops` IS REQUIRED on a dir_posix prefix index. The directory-scope
--     predicate is `dir_posix = $2 OR dir_posix LIKE $2 || '/%'`, and a default
--     en_US.UTF-8 btree cannot serve a LIKE-prefix. text_pattern_ops can.
--   * Any directory-prefix RANGE bound must use the `p||'0'` successor, NEVER
--     `p||chr(255)`. chr(255) is U+00FF, encoded C3 BF, which sorts BELOW every 4-byte
--     UTF-8 lead byte — so an emoji-named child is silently dropped. Verified.
--
-- HONESTY ABOUT WHAT THESE DO NOT SERVE: at the UNIT level the same four counts come from
-- {{S}}.unit_rollup, NOT from these indexes. A single query with four `count(*) FILTER`
-- aggregates scans the relation once and cannot use four different partial indexes —
-- verified on PG 16.15: with all four partials present the planner produced one Bitmap
-- Heap Scan on the PK. These partials serve the DIRECTORY-scoped variant, issued as
-- separate scalar queries by ViewOneDirectoryPage.
-- ============================================================================

CREATE INDEX file_rollup_video ON {{S}}.file (unit_id, dir_posix text_pattern_ops)
  WHERE compress = 'could' AND media = 'video' AND NOT analysis_only AND NOT no_compress;
--   SERVES: charter category-rollup row 1, "videos that can be compressed", count + click
--   to compress. Videos are the charter's PRIMARY compression target.

CREATE INDEX file_rollup_image ON {{S}}.file (unit_id, dir_posix text_pattern_ops)
  WHERE compress = 'could' AND media = 'image' AND NOT analysis_only AND NOT no_compress;
--   SERVES: charter category-rollup row 2, "images that can be compressed". Secondary
--   target. Note that neither index means we may act: the charter is absolute that we
--   detect, surface and offer, and never compress or alter a file unless the user asks.

CREATE INDEX file_rollup_big_open ON {{S}}.file (unit_id, dir_posix text_pattern_ops)
  WHERE is_big AND NOT analysis_only AND present_local;
--   SERVES: charter rollup row 3, "big files that aren't a good idea to check in".
--   IT DELIBERATELY DOES NOT ENCODE THE GIT-IGNORE AXIS, because that axis lives in
--   {{S}}.file_gitignore and is THREE-VALUED: the query joins and filters
--   `g.ignored IS FALSE`, never `IS NOT TRUE` — an UNDETERMINED row must not be counted as
--   a nudge (performance.mdx P-37 fix 4). Counting it would nag the user about a file git
--   has not been asked about yet.

-- CHARTER ROLLUP ROW 4 ("big files that ARE git-ignored, therefore untracked and unsynced")
-- gets NO INDEX HERE, and that is deliberate rather than an omission: its selecting
-- predicate lives entirely on {{S}}.file_gitignore (`ignored` true) and its count is served
-- at the unit level from unit_rollup.n_big_ignored_untracked. A partial index on
-- {{S}}.file could only express the `is_big` half, which file_rollup_big_open already
-- covers. If the directory-scoped variant of row 4 is ever measured slow, the index it
-- wants is on file_gitignore, not here.
