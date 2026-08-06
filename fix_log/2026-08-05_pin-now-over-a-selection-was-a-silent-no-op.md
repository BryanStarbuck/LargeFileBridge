# FIXED — bug found and fixed

Run: 2026-08-05

## Bug report

> In LargeFileBridge pinning a single file seems to be working but not pin selection — comprehensively
> analyze the repo and check if there is any issue.
>
> (Screenshot: repo `all` on Windows, filter `sital`, 5 rows checked, "Pin now (5)" in the More menu.
> Every row's CID column reads `—`.)
>
> Follow-up: "when i click in pin icon in the file row, there is no feedback and progress".

## Findings

The selection plumbing was correct — `fileId → repo-relative path` mapping, the count on the label, the
route, `onlyPaths`. The pin was gated on something the UI never showed.

1. **`Pin now (N selected)` is an INTERSECTION with the decided set.** `runUnitPin` builds its work list as
   `decision === "sync" && onlyPaths.has(rel)`. The five checked files were decided `ignore`, so the run
   was eligible for nothing and toasted a **green** "Nothing to pin — no files marked Pin". Confirmed from
   the user's own synced state, not inferred: `pin/r/all/config.yaml` had all five as `ignore`, and
   `decisions.yaml` carried five `ipfs:false, gitignore:true` events stamped 06:12–06:15 that day. The repo
   manifest had no entry for any of them — never pinned by any computer.
2. **Why they were `ignore`: the ⊘ toggle decided the IPFS axis.** It sent `ipfs: f.decision === "sync"`
   alongside its own axis, so each click on an **undecided** file recorded "never add to IPFS". The events
   are 15 seconds apart — five individual ⊘ clicks. `recordDecision` could not express otherwise either:
   `ipfs: !!axes.ipfs` turned the documented "undefined = leave as-is" into a decision of "no". The files
   then left the **Add to IPFS** tile (it counts *undecided* files), so the to-do never resurfaced.
   Git-ignoring a big video had opted it out of the sync git-ignoring exists to enable.
3. **The row pin icon felt dead because the request was blocked by its own side effect.** `void track(...)`
   is only fire-and-forget from its first `await` onward: `pinRepoFolder` runs a long SYNCHRONOUS prelude
   (sync-repo marker, a reconcile that re-parses and rewrites a 155k-line ledger, the manifest merge) and it
   was started **before** `res.json`. That held the event loop — the PATCH response *and* the `/api/progress`
   poll the dock feeds on. Nothing on the click gave any sign of life until all of it finished.
4. **A scoped pin did unscoped work.** Fetch-missing ignored `onlyPaths`, so "Pin now (5)" pulled down every
   missing file in the repo and reported `fetched`/`failed` for files the user never checked.
5. **A scoped pin erased orphan state it never looked at.** `classifyAbsent` only saw the scoped paths, then
   `writeStatus` wrote that map **wholesale** — every other file's `first_seen_at` gone. Since each decision
   click fires a targeted pin, the 24h grace was restarted repeatedly and a deleted file never staled back
   to Undecided.
6. **Four different failures shared one sentence.** IPFS unreachable, `pin ls` failed, repo missing, and a
   healthy no-op all return an all-zero tally, printed as "Nothing to pin — no files marked Pin". `Pin now`
   was also never disabled with the node down, contrary to one_repo.mdx §3.2/§4.

## Fix summary

* **`Pin now (N)` asks for the missing half instead of doing nothing** (one_repo.mdx §4.4). A selection
  containing rows that aren't set to Add to IPFS opens a confirm — *"Add 3 files to IPFS and pin?"* —
  then writes the decision for exactly those and pins the whole selection in **one** run. Declining still
  pins whatever IS set; a selection with nothing set says so. Never-IPFS rows are named, never sent. The
  decision write carries the new `pin: false` so the server does not also fire its own targeted pin —
  two pin runs over one unit race on its manifest.
* **Each row toggle writes only its own axis**, and `axesToRecord()` gives "leave as-is" real meaning:
  carry the prior decision forward, or — with no prior decision — record **no event** and leave the file
  Undecided (decisions.mdx §1.0a). The git-ignore still lands in `.gitignore`, which is where the ⊘ state
  is read from anyway.
* **The click answers immediately**: a loading toast and an optimistic row flip on `onMutate`, the clicked
  icon spins while the write is in flight (`StatusActionIcon busy`), and the toast is replaced in place by
  the outcome (rolled back on failure). The targeted pin now fires **after** the response, on a fresh tick,
  so the dock's card and its `n / N files` bar appear while the request is already answered.
* **Scope binds the whole pass**: fetch-missing honors `onlyPaths`, and `mergeOrphans()` carries
  out-of-scope orphan records forward instead of erasing them.
* **`PinCounts.error`** distinguishes "the run never started" from "there was nothing to do" — the toast
  says *"Pin didn't run — IPFS node unreachable"*; a scoped no-op says *"none of the selected files is set
  to Add to IPFS"*; and `Pin now` is disabled with a reason while the node is unreachable.

## Files changed

* `code/packages/backend/src/modules/storage/decisions.service.ts` — `axesToRecord()` (new, exported);
  `recordDecision` folds prior state once and reuses that read for the append (`appendEvents(…, alreadyRead)`).
* `code/packages/backend/src/modules/pin/pin.service.ts` — `counts.error` on the three early exits;
  fetch-missing honors `onlyPaths`; status write-back via `mergeOrphans`.
* `code/packages/backend/src/modules/pin/orphans.service.ts` — `mergeOrphans()` (new, pure).
* `code/packages/backend/src/modules/repos/repos.router.ts` — `pin?: boolean` on PATCH `/files`; the
  targeted pin moved after `res.json` behind `setImmediate`.
* `code/packages/shared/src/types.ts` — `PinCounts.error?`.
* `code/packages/frontend/src/pages/repos/OneRepoPage.tsx` — `pinNowScoped()`, single-axis toggles,
  optimistic + busy + toast lifecycle, scope-aware `pinSummary`, `Pin now` disabled when IPFS is down.
* `code/packages/frontend/src/pages/repos/selection.ts` — `partitionForPin()` (new, pure).
* `code/packages/frontend/src/api/client.ts` — `setFileDecisions(…, { pin })`.
* `code/packages/frontend/src/components/StatusActionIcon.tsx`, `components/table/taskIcons.tsx` — `busy`.
* `code/packages/frontend/src/components/menu/PageActions.tsx`, `styles.css` — a disabled action link shows
  its REASON as the tooltip and reads as disabled.
* `pm/one_repo.mdx` §4.4, `pm/pin_process.mdx` §3/§6, `pm/decisions.mdx` §1.0a.

## Engineering quality passes

* `pnpm --filter @lfb/{shared,backend,frontend} typecheck` — all clean.
* Backend: 68 files, 614 tests pass (13 new: `decision-axis-independence.spec.ts`, `mergeOrphans` in
  `orphans.spec.ts`). Frontend: 11 files, 91 tests pass (4 new: `partitionForPin` in `selection.spec.ts`).
* Self-review caught a data-loss hazard introduced mid-fix: passing `[]` to `appendEvents` after a failed
  prior-read would have written a ledger containing only the current click's events. The reuse parameter is
  now `null`-guarded and documented.

## Not changed (deliberately)

* **The five files' existing `ignore` decisions stand.** The fix stops new ones being fabricated; it does
  not rewrite recorded history. They are recoverable through the UI: check them and pick `Pin now (5)`,
  which now offers to add them.
* **The 18,948 `\`-spelled events** in that repo's ledger are healed on the fold (`foldLedger`), and event
  identity must stay byte-exact for the union merge — left alone.
* **`Limiter` can exceed its cap by one** per release/acquire interleaving (a freed slot claimed by both a
  new caller and the woken waiter). Real but minor, and orthogonal to this bug — not touched here.
