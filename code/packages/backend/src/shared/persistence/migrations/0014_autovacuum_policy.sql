-- ============================================================================
-- 0014_autovacuum_policy — autovacuum is part of the schema, not an afterthought.
--
-- MEASURED REASON (database.mdx §5.1): a single pin-pass-shaped UPDATE of one unit's rows
-- took Heap Fetches on the covering index from 0 to non-zero — i.e. THE INDEX-ONLY SCANS
-- THIS WHOLE DESIGN IS BUILT ON STOP BEING INDEX-ONLY under default vacuum settings.
--
-- Index-only scans are a VISIBILITY-MAP property, not an index property. `file_tab_all`
-- carries a 16-column INCLUDE list precisely so the One-Repo page never touches the heap;
-- that INCLUDE list buys nothing the moment the visibility map goes stale. The pin pass
-- rewrites transfer / pinned_here / peer_count in bulk across a unit, which is exactly the
-- workload that outruns the default scale factor of 0.2 (20% of the table) on a relation
-- with 30,758 rows.
--
-- Three tables, and only three, because these are the three the bulk passes rewrite:
--   file           — the pin pass and the post-scan candidate sweep
--   manifest_entry — the manifest merge, per unit per mirror cycle
--   pin_claim      — the DELETE-then-reinsert of our own claims (the withdrawal)
-- The 0.02 / 0.01 pair means vacuum at 2% dead tuples and analyze at 1% changed, so the
-- visibility map is refreshed while the working set is still small enough for vacuum to be
-- cheap. `file` also gets fillfactor 85 (migration 0004) so those updates stay HOT and do
-- not have to touch the indexes at all.
--
-- These are storage parameters on an existing table: ALTER TABLE ... SET (...) is
-- transactional and takes only a brief lock, so this migration is safe inside the runner's
-- single BEGIN..COMMIT like every other.
-- ============================================================================

ALTER TABLE {{S}}.file
  SET (autovacuum_vacuum_scale_factor = 0.02, autovacuum_analyze_scale_factor = 0.01);

ALTER TABLE {{S}}.manifest_entry
  SET (autovacuum_vacuum_scale_factor = 0.02, autovacuum_analyze_scale_factor = 0.01);

ALTER TABLE {{S}}.pin_claim
  SET (autovacuum_vacuum_scale_factor = 0.02, autovacuum_analyze_scale_factor = 0.01);
