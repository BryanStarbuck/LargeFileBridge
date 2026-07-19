# FIXED — bug found and fixed

Run: 2026-07-19 (follow-up to `2026-07-19_undecided-metric-counts-foreign-pinned-files.md`)

## Bug report

> There could be two versions of "Foreign pinned":
> #1 pinned on this computer by "foreign" software (not the Large File Bridge webapp) → view as
> "Pinned Locally" (pinned = true; we don't care what local software pins it).
> #2 NOT pinned locally, "foreign" = on another computer → Large File Bridge must consider it
> PINNED = false, so we can help get it pinned locally.
> Find out the situation with this file (`charlie-kirk/videos/1965869689755812061.mp4`) and our
> software. Update ./pm/ipfs.mdx with "is it pinned on this local computer or not". Re-align code.

## Findings — the situation with this file and our software

* **The file is case #1.** `ipfs pin ls` on this machine shows the CID pinned `recursive`. It was
  pinned by the CLI (other local software), not by Large File Bridge.
* **Our `pinnedForeign` already means exactly definition #1.** Foreign Pin Discovery tests re-hashed
  CIDs against THIS node's kept-set (`listPins()` + MFS roots of the local daemon), and
  `verifyForeignPins()` drops any record the local kept-set no longer holds, every scan. The sidecar
  re-seed path (records traveling from other computers via the git backbone) only re-records a CID
  after testing it against the LOCAL kept-set — so a peer's pin can never set `pinnedForeign` here.
  Yesterday's Undecided-metric fix was therefore the right thing in substance.
* **One true definition-#2 violation existed:** `transferFor()` (both the units.service.ts and the
  entity.service.ts copy) returned `"pinned"` when ANY device appeared in the manifest's `pinned_by`
  — including a peer-only claim. A sync file pinned only on another computer read "pinned" on this
  one (repos-list Pinned column, transfer column, file verdict), exactly what the spec forbids.
* **Presentation misalignment:** three UI strings called case-#1 files "pinned outside Large File
  Bridge"; the spec wants them viewed simply as **"Pinned locally"**.
* **Adjacent self/peer conflation (same axis):** `notBackedUp` counted `peers.length === 0`, but
  `pinned_by` includes THIS device — so a file pinned only here (no other computer) never fired the
  "live only on this machine" warning. And the View-one-file verdict counted this device in
  "backed up on N other computers".

## Fix summary

Wrote the governing definition into `pm/ipfs.mdx` §1.1 (LOCKED): **"pinned" = pinned on THIS local
computer, by any local software; a peer computer's pin is never local pin truth** — then re-aligned
`transferFor` (self-claim-only), the `notBackedUp` metric (other-computers-only), the EntityView
`peers` payload (self excluded), and all user-facing wording to "Pinned locally".

## Files changed

* `pm/ipfs.mdx` — new §1.1 (LOCKED) defining local-pin truth with the two-situations table; §9
  blockquote extended with fix 4 + this realignment.
* `pm/one_repo.mdx` — §4.9 green state renamed "Pinned locally"; §4.1 blockquote segment renamed.
* `code/packages/backend/src/modules/store-model/config.service.ts` — new shared `computerLabel()`
  (single definition of this device's `pinned_by` identity).
* `code/packages/backend/src/modules/pin/pin.service.ts` — local `computerLabel()` removed; imports
  the shared one (claim writes and truth checks can no longer drift apart).
* `code/packages/backend/src/modules/store-model/units.service.ts` — `transferFor(decision, cid,
  peers, selfLabel)` now returns "pinned" only when THIS device's label is in `pinned_by` (exported;
  peer-only claims read "pending" so the pin pass pulls them); `notBackedUp` fires when no OTHER
  computer claims the pin.
* `code/packages/backend/src/modules/entity/entity.service.ts` — duplicate `transferFor` deleted in
  favor of the shared export; ships `peers` with self excluded ("backed up on N other computers" is
  now honest).
* `code/packages/shared/src/types.ts` — `EntityView.peers` and `TaskMetrics.notBackedUp` comments
  document the other-computers-only semantics.
* `code/packages/frontend/src/pages/repos/OneRepoPage.tsx` — summary segment now "N Pinned locally"
  (green, with explanatory tooltip); green pin cell title reworded.
* `code/packages/frontend/src/components/table/taskIcons.tsx` — pin column header tooltip reworded.
* `code/packages/frontend/src/pages/entity/ViewOneFilePage.tsx` — verdict headline now "Pinned
  locally — pinned on this computer's IPFS node".

## Engineering quality passes

* `pnpm -r typecheck` — all packages pass (one unused-import caught and removed in pin.service.ts).
* `npx biome check` on all changed files — clean.
* Backend test suite: 16 files, 124 tests — all pass.
* Deduplication: two copies of `transferFor` collapsed to one export; two copies of
  `computerLabel()` collapsed to one shared helper.

## Behavioral impact measured (probe + live API)

* charlie-kirk: `{ undecided: 7, pinnedForeign: 69 }` unchanged; target row
  `{ decision: "undecided", pinnedForeign: true }` → renders green "Pinned locally".
* `selfLabel` = `bryanstarbuck-macbook-pro`. Zero manifest files currently carry pin claims on this
  machine, so the `transferFor`/`notBackedUp` changes flip nothing today — they correct behavior for
  when peer manifests carry claims (the exact scenario definition #2 describes).

## Restart status

Backend :8787 under `tsx watch` auto-restarted; Vite :2222 HMR applied frontend edits. Live
`GET /api/repos` re-verified serving the realigned counts.
