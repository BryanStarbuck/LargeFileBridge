-- ============================================================================
-- 0005_file_tabs_and_search — the remaining One-Repo tab indexes, the two trigram
-- search indexes, and the cross-repo tile indexes.
--
-- Split from 0004 deliberately: the tab cutover is measured ONE TAB AT A TIME
-- (database.mdx §9, "reads cut over one surface at a time, behind the tab or endpoint
-- id, so a regression is scoped to one tab"). Every index here is additive — nothing
-- in 0004 depends on it, and dropping any one of them degrades a single tab rather
-- than breaking the page.
-- ============================================================================

CREATE INDEX file_tab_ipfs ON {{S}}.file (unit_id, peer_count, size_bytes DESC)
  WHERE is_candidate AND (media IS NOT NULL OR size_bytes >= 104857600);
--   SERVES: tab "IPFS" — sort (peers ASC, size DESC) over media-or-large rows.
--   WHY PARTIAL: the tab's rowFilter is exactly this predicate, so the partial index is
--   both the filter and the sort. A plain (unit_id, peer_count, size_bytes) index would
--   be chosen by the planner for the "All" tab too and then lose to a top-N sort there
--   — MEASURED on the probe: the general index won the plan and cost 5.09 ms where the
--   purpose-built one cost 1.36 ms.

CREATE INDEX file_tab_compress   ON {{S}}.file (unit_id, compress,   size_bytes DESC) WHERE compress   IN ('could','done');
CREATE INDEX file_tab_transcribe ON {{S}}.file (unit_id, transcribe, size_bytes DESC) WHERE transcribe IN ('could','done');
CREATE INDEX file_tab_describe   ON {{S}}.file (unit_id, describe,   size_bytes DESC) WHERE describe   IN ('could','done');
CREATE INDEX file_tab_ocr        ON {{S}}.file (unit_id, ocr,        size_bytes DESC) WHERE ocr        IN ('could','done');
--   SERVE: the four analysis tabs, each sorting (status ASC, size DESC) over rows whose
--   status is could|done (taskTabs.config.ts:83/101/119/139). These are the sorts a
--   document-shaped design cannot index, because the task status is a DERIVED VERDICT no
--   document owns. Here it is a real column.
--   WHY FOUR INDEXES: the four statuses are independent axes; one composite over all
--   four would have to lead with a column three of the four queries do not filter on.

CREATE INDEX file_path_trgm ON {{S}}.file USING gin (rel_posix {{S}}.gin_trgm_ops);
CREATE INDEX file_name_trgm ON {{S}}.file USING gin (base_name {{S}}.gin_trgm_ops);
--   SERVE: the search box mandated above every table (CLAUDE.md, Tables). The frontend
--   filter is a case-insensitive CONTAINS (DataTable.tsx globalFilterFn), debounced
--   200 ms per keystroke — hence trigram and not a prefix btree.
--   HARD PRECONDITION, stated because it is a real limitation: pg_trgm cannot serve a
--   term shorter than 3 characters. MEASURED on a 200k-row probe: 2-char ILIKE fell back
--   to a PK bitmap scan + filter at 5.6 ms; 5-char hit the trigram index at 0.41 ms. The
--   API therefore refuses to push a <3-char term to SQL and lets the client filter the
--   already-fetched page — which is right for a page and wrong for a repo with 2,743
--   candidates where the match is on page 6. Open question, database.mdx §8.2.
--   The opclass is qualified `{{S}}.gin_trgm_ops` because 0001 installs pg_trgm into
--   `{{S}}`, so the index does not depend on the caller's search_path.

CREATE INDEX file_cid ON {{S}}.file (cid_canon) WHERE cid_canon IS NOT NULL;
--   SERVES: the IPFS page's CID->file reverse lookup (ipfs-page.service.ts
--   syncedPinTargets), today a re-parse of all 105 manifests per CID on every unpin.

CREATE INDEX file_not_backed_up ON {{S}}.file (unit_id)
  WHERE peer_count = 0 AND present_local AND NOT analysis_only;
--   SERVES: the "Not backed up anywhere" tile and files-query.service.ts.
--   Partial: on a healthy machine this index is nearly EMPTY, so the probe is a couple of
--   pages regardless of how many files the unit holds.

CREATE INDEX file_remote_only ON {{S}}.file (unit_id, size_bytes DESC) WHERE NOT present_local;
--   SERVES: the "Pull down" tile and the remote-only rows (storage_company.mdx §8.5).

CREATE INDEX file_unpublished_foreign ON {{S}}.file (unit_id)
  WHERE pinned_foreign AND decision = 'undecided';
--   SERVES: the unpublished-foreign-pin durability alarm (units.service.ts:1031) — the
--   surface MEMORY.md's "foreign pin: recorded must render" note is about. `pinned_foreign`
--   is the column every pin-truth surface and pin-nag count must read; a peer's claim is
--   never pinned-here.
