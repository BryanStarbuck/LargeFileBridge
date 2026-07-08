# FIXED — bug found and fixed

## Bug report

> Repo page http://localhost:2222/repos/bef908e3bce0fa2f (repo
> /Users/bryanstarbuck/BGit/Bryan_git/Intel_Murder_Docus) only shows 4 files in the root
> directory table, but hitting Transcribe queued 69+ videos. Either the table is hiding
> subdirectories/recursive files (then show directories in the table), or transcribe is
> scanning outside the repo hierarchy (serious bug). Check the transcription queue and recent
> finished transcriptions to see what's actually queued. Debug and fix.

## Resolved context

* Project: **LargeFileBridge** (`~/BGit/Bryan_git/LargeFileBridge/code`) — not the ACT3 stack;
  the skill's ACT3 variables do not apply.
* URL: `http://localhost:2222/repos/bef908e3bce0fa2f` → One-repo page (`OneRepoPage.tsx`).
* Repo id `bef908e3bce0fa2f` = sha1(`/Users/bryanstarbuck/BGit/Bryan_git/Intel_Murder_Docus`)
  .slice(0,16) — verified with `repoIdFromPath` logic. The id maps to the right repo.
* Stack layer: **backend** (batch walk in transcribe/describe services) + spec update.

## Root cause

Three separate facts stacked into the confusing "4 shown / 69+ queued" experience:

1. **The table's 4 files are honest and already recursive.** The scan candidates for
   Intel_Murder_Docus (`~/T/_large_files_bridge/sync/r/intel_murder_docus/status.yaml`) are the
   4 media files under `static/videos/` — shown with their subdirectory prefix in the File
   column. `build/` is excluded by the scanner's `HARD_SKIP` set (build outputs duplicate
   source media — scan.mdx §4). Nothing is hidden; there is no missing-directories bug.

2. **THE CODE BUG — the Transcribe walk did not honor the shared skip set.**
   `transcribe.service.ts` and `describe.service.ts` each had a private
   `SKIP_DIRS = {".git", "node_modules", ".transcribe", ".lfbridge"}` instead of the shared
   `HARD_SKIP` from `shared/scan-filters.ts`. So "Create Transcriptions" on the repo page
   walked into `build/videos/` and queued **8** files (4 real + 4 build duplicates) while the
   table showed 4. Log proof: `enqueue: 8 considered → 8 queued` at 01:37:54Z — exactly the
   repo's media count including `build/`. This violates the invariant stated in
   scan-filters.ts: "the FS browser's hard-skip set MATCHES the scanner's."

3. **The other ~65 queued jobs were a separate enqueue for a different repo, 32 seconds
   earlier.** Log: `enqueue: 66 considered → 65 queued` at 01:37:22Z; every transcription that
   drained afterwards was under `/Users/bryanstarbuck/BGit/Bryan_git/charlie-kirk/` — which has
   **exactly 66** media files. A "Create Transcriptions" action ran with root=charlie-kirk
   (another click/tab shortly before the Intel one; the user then bookmarked
   intel_murder_docus at 01:37:47Z between the two enqueues). Both batches drain through the
   single FIFO job queue, so the progress dock showed ~69–73 pending and it *looked* like the
   4-file repo had queued them all.

   **The serious scenario is ruled out:** transcribe never walked outside the given root.
   Each enqueue's count exactly equals the media under its stated root (66 = charlie-kirk,
   8 = Intel incl. build/), and the enqueue endpoint requires an explicit client-supplied
   `paths[]`/`root` — the server never invents a scope. Why it was hard to see: the enqueue
   log line recorded only counts, never the root (also fixed).

## Fix summary

Aligned both batch root-walks with the shared `HARD_SKIP` set so a page action considers
exactly what the page shows (repo page: 4 considered, not 8), and added the walk scope
(root or checked-set size) to the enqueue log lines so every queued batch is attributable.
Locked the invariant into the pm spec with code pointers.

## Files changed

* `code/packages/backend/src/modules/transcribe/transcribe.service.ts:12` — import `HARD_SKIP`;
  `SKIP_DIRS = HARD_SKIP ∪ {".transcribe", ".lfbridge"}`; enqueue log line now includes
  `[root …]` / `[N checked path(s)]` via new `scopeLabel()` helper.
* `code/packages/backend/src/modules/describe/describe.service.ts:26` — same three changes for
  the AI-description twin (`walkDescribable` / `enqueueDescribe`).
* `pm/page_actions.mdx` (§1.1) — new LOCKED "Same skip set as the scan" rule with the two-line
  functionality → code pointer (walkMedia/SKIP_DIRS, scan-filters.ts HARD_SKIP).

## Detailed changes

**transcribe.service.ts** — Before: `walkMedia()` descended into `build/`, `dist/`,
`.docusaurus/` etc., queuing duplicate transcriptions of generated copies of media (Docusaurus
mirrors `static/videos/*` into `build/videos/*`). After: the walk shares the scanner's/FS
browser's `HARD_SKIP` (which exists precisely to prevent this double-report, per the comment in
scan-filters.ts), keeping the two artifact-dir extras. The enqueue log went from
`enqueue: 8 considered → …` to `enqueue [root /abs/path]: 4 considered → …`, so the next queue
mystery is answerable from `~/T/_large_files_bridge/log.log` directly.

**describe.service.ts** — identical twin fix; also fixes "Create AI descriptions" over-counting
into build outputs (worse there, since HARD_SKIP-excluded dirs can hold thousands of images and
each description is a paid vision-API call).

**pm/page_actions.mdx** — records the invariant so the walk and the page can't drift again.

## Engineering quality passes

* Typecheck: `pnpm --filter @lfb/backend typecheck` clean.
* No new unchecked errors / resource handles; `scopeLabel()` is pure. It is intentionally
  duplicated in the two services, matching their existing deliberate mirroring
  (walkMedia/walkDescribable twins).
* Security: no new input paths; log lines write local absolute paths to the local log file,
  consistent with existing per-file transcription log lines. No compliance issues with the
  no-gateway policy (nothing network-facing touched).
* Dead code: none introduced; stale comments on both SKIP_DIRS rewritten to name the invariant.

## Use case verification

Not applicable (no ACT3 use-case specs; LFB pm specs consulted instead: page_actions.mdx §1.1
SCOPE rule, scan.mdx §4 hard-skip invariant, job_queue.mdx queue semantics).

## Restart status

Backend (127.0.0.1:8787) runs under `tsx watch` — it auto-restarted on save at
2026-07-08T01:50:16Z; `/api/health` returns 200. Frontend dev server on :2222 returns 200
(Vite HMR, no restart needed). Side effect of the backend restart: the **in-memory job queue
was cleared**, so the leftover ~60 charlie-kirk transcribe jobs are gone (by design —
job_queue.mdx: the queue does not survive restarts; re-running the action re-queues only
still-unfinished files).

## Verification

* Simulated the fixed walk over Intel_Murder_Docus with the new SKIP_DIRS: **4 files
  considered** — exactly the 4 rows the repo page shows (`static/videos/*`), `build/` excluded.
* Verified repo-id mapping (sha1 prefix) — `bef908e3bce0fa2f` resolves to Intel_Murder_Docus.
* Verified charlie-kirk recursive media count = 66 = the mystery enqueue's `considered`.
* Typecheck clean; backend restarted healthy (health 200); log confirms new process up.
* Not yet exercised end-to-end from the browser (needs a signed-in click on "Create
  Transcriptions"); the next click on that repo page should toast
  "4 files will have their Transcriptions created" (or "All 4 … already have transcriptions").
