# FIXED — bug found and fixed

Run: 2026-07-19_16-12-31

## Bug report

> /Users/bryanstarbuck/BGit/Bryan_git/charlie-kirk/videos/1965869689755812061.mp4
>
> claude code says it is IPFS pinned locally. But in Large file Bridge is the bug.
> * In "View one repo" page
> * "Undecided" metric shows 76. Including this file. Does it show there because it thinks
>   it isn't IPFS pinned and it is asking me to IPFS pin it?
> * IF so, that is a bug because claude code says it is already pinned.
> * Find bug. Fix bug
>
> (CID Qmdupxi4TifTuoMz25qHPMUxP3DVz7btycwvJ1rfZZKBpq, recursive pin, verified on disk.)

## Resolved context

* App: Large File Bridge (this repo) — not the ACT3/JFK stack the skill template assumes.
* Page: View one repo (`/repos/$repoId`, `OneRepoPage.tsx`) — the "Undecided" metric tile,
  the summary counts line, and the triage popup.
* Stack layer: both — the counts are computed in the backend (`units.service.ts`), rendered
  by the frontend (`OneRepoPage.tsx` / `metricWarningDefs.tsx`).
* Ports: backend API :8787 (tsx watch), web :2222 (Vite).
* This is fix 4 of the "CLI says pinned, app says not pinned" saga (see
  `pm/one_repo.mdx` §4.9 and the `foreign-pin-recorded-must-render` memory).

## Root cause

The file is `decision === "undecided"` (no Large File Bridge decision) **and**
`pinnedForeign === true` (foreign-pin discovery correctly recorded its recursive pin in
`~/T/_large_files_bridge/foreign-pins.json`; verified present, and the row ships
`pinnedForeign: true` through `composeFileRows`).

Fix 3 taught the pin **icon** to render `pinnedForeign` (the green fourth state), but every
**counting** surface still classified rows by `decision` alone:

* `computeTaskMetrics` — `if (f.decision === "undecided") m.undecided++` → the "Undecided"
  metric tile counted 76 (7 truly undecided + 69 foreign-pinned).
* `countDecisions` — same predicate → the summary line, the repos-list "Undecided" column,
  and the `needs_review` status rollup.
* `buildUndecidedWarning` — the triage popup listed all 76 files and offered "Add them to
  IPFS", with copy claiming "A file not added to IPFS is not pinned … it's gone".
* `todo-batch.engine.ts` — recommended `ipfs: true` (a pin) for foreign-pinned files.

So yes — the metric was effectively asking the user to pin 69 files that are already pinned
on this node. Same defect as fixes 1–3, wearing a number instead of an icon.

## Fix summary

Foreign-pinned rows are excluded from every `undecided` pin-nag count and popup, and are
counted apart as `RepoCounts.pinnedForeign`; the summary line surfaces them as
"N pinned outside Large File Bridge" (green) so they never silently vanish. The to-do batch
engine no longer recommends the IPFS axis for them (git-ignore axis still offered when owed).

## Files changed

* `code/packages/shared/src/types.ts:28` — `RepoCounts` gains `pinnedForeign: number`;
  `TaskMetrics.undecided` comment documents the exclusion.
* `code/packages/backend/src/modules/store-model/units.service.ts:515` —
  `computeTaskMetrics`: undecided tile skips `pinnedForeign` rows.
* `code/packages/backend/src/modules/store-model/units.service.ts:552` —
  `countDecisions`: undecided branch splits into `undecided` vs `pinnedForeign`.
* `code/packages/frontend/src/pages/repos/metricWarningDefs.tsx:141` —
  `buildUndecidedWarning`: popup target list mirrors the backend predicate.
* `code/packages/frontend/src/pages/repos/OneRepoPage.tsx:593` — summary line appends
  "· N pinned outside Large File Bridge" (green) when > 0.
* `code/packages/backend/src/modules/todo/todo-batch.engine.ts:145` — foreign-pinned files
  never get an `ipfs` recommendation; still get `git_ignore` when not ignored.
* `pm/one_repo.mdx` §4.1 blockquote + §4.9 "fix 4" — spec for the exclusion, with code
  pointers per the charter pattern.
* `pm/task_tabs.mdx` §2.4 Undecided bullet — metric/popup exclusion, with code pointers.

## Detailed changes

* **Before:** any `decision === "undecided"` row counted toward the Undecided tile, the
  `N Undecided` summary segment, the repos-list Undecided column, the `needs_review` repo
  status, the triage popup's file list, and the to-do batch `pin` recommendation —
  regardless of whether the bytes were already pinned on this node.
* **After:** rows with `pinnedForeign === true` are carved out of all of those into
  `counts.pinnedForeign`. They still render in the table with the green "Pinned outside
  Large File Bridge" pin (fix 3), which remains the affordance for "have Large File Bridge
  sync it too". `rollupStatus` was not edited but inherits the change: a repo whose only
  undecided files are all foreign-pinned no longer sticks at `needs_review`.
* **Follow-on:** none mechanical — no codegen/migrations in this stack. Backend `tsx watch`
  auto-restarted on save; Vite HMR picked up the frontend edits.

## Engineering quality passes

* `pnpm -r typecheck` — all three packages pass.
* `npx biome check` on all five changed code files — clean.
* Only one `RepoCounts` constructor site exists (`countDecisions`) — no other literal to
  update; the field is required, so the compiler guards future constructors.
* Popup/backed-count consistency verified: `detail.counts.undecided` and the popup's
  filtered file list now use the same predicate (a mismatch would show "7 need a decision"
  over a 76-row list).
* `seen.add` behavior preserved in `todo-batch.engine.ts` for all branches, so a
  foreign-pinned file can't be re-picked by a later category scan.
* No security-relevant surface touched (counts only; no new input paths, no auth changes).

## Use case verification

Not applicable — no Use_Cases.csv in this repo; verified against the pm specs instead
(`one_repo.mdx` §4.1/§4.9, `task_tabs.mdx` §2.4, `foreign_pin_discovery.mdx` §6).

## Restart status

* Backend :8787 — running under `tsx watch`; auto-restarted on save (verified below).
* Web :2222 — Vite running; HMR applied the frontend edits. No manual restarts needed.

## Verification

* State check: the reported file's pin IS recorded in
  `~/T/_large_files_bridge/foreign-pins.json` under its exact CID and absolute path.
* Service probe (`tsx`, real service path): `computeRepoDetail` for
  `~/BGit/Bryan_git/charlie-kirk` now returns
  `counts: { undecided: 7, pinnedForeign: 69, … }` and the target row
  `{ decision: "undecided", pinnedForeign: true }` — 7 + 69 = the 76 the user saw, so the
  arithmetic accounts for exactly the reported number.
* Live HTTP check (minted HS256 bearer, real auth path):
  `GET http://localhost:8787/api/repos` serves
  `charlie-kirk → counts { undecided: 7, pinnedForeign: 69 }` — the running server has the
  fix; the page will show "7 Undecided · … · 69 pinned outside Large File Bridge" on next
  load, and the file no longer appears in the Undecided triage popup.
