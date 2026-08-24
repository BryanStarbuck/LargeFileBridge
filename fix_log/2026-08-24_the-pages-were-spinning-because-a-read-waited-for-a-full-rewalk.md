# FIXED — the app hung, and now it says why when it does

Run: 2026-08-24

## Bug report

> this web app is hanging. Debug and fix it. Find out why the pages are spinning. I think there are things
> that are happening on the UI render thread that need to be pushed into the background. Find all those.
> Fix all those. Completely fix and upgrade the code. This needs to be fixed. If you need to add more
> instrumentation to understand what pages continually never finish rendering, add instrumentation to the
> error.ERR files. Find anything you can and fix everything you can

## What the fault trail already said, and what it could not

`loop-watch` (P-39, added the day before) had the day's evidence: **110 warned windows in `error.err`**,
worst stalls of **1,469–7,310 ms**, recurring all day rather than only after a boot. So the symptom was
confirmed as an **event-loop stall**, not memory.

What no line anywhere could say was **which code** stopped the loop, or **which request** the browser was
still waiting on. A libuv histogram measures delay, not identity, and the backend had **no per-request
timing of any kind**. So the first work of this run was instrumentation, and the instrumentation is what
found the biggest bug.

## Findings

### 1. `GET /api/todo/batches` awaited a full re-walk of every repo — on the sidebar of every page

The single most literal instance of the report. `await maybeRecalc()` sat in front of the read, throttled to
once per 30 s; `recalcAll()` walks every repo and every storage. **Measured live: 11,985 ms.**

It is not the To Do page's problem — the **sidebar** issues that query for its badge count, and the sidebar
is on every screen. So once every 30 s, whichever page the user happened to open sat on a spinner for twelve
seconds waiting for a filesystem walk it never asked for.

Both new watches caught it independently, within a minute of being armed:

```
[client:perf.route] PAGE STILL SPINNING after 10319ms: /repos/… is still waiting on 1 query: ["todo","batches"]
[request]           SLOW: GET /api/todo/batches -> 200 took 11985ms
```

**Fixed:** a read must not wait for a write. The batches on disk are the answer; the recalc only makes them
fresher and already announces itself (`writeBatch` bumps `TODO_TOPIC` → the live event stream → the page
refetches). Answer from disk, start the recalc behind the response, yield between repos while it runs, and
subscribe the sidebar badge to the topic. **11,985 ms → 26 ms.**

### 2. The sync mirror re-derived multi-megabyte YAML on every pass — and two memos were cancelling each other

A warm mirror + reconcile over 105 repos and 29,412 tracked files cost **7,285 ms of uninterrupted
synchronous time** — the 7,310 ms `loop-watch` kept reporting. The walk was never the cost; the YAML was
(`YAML.parse` of `charlie-kirk/decisions.yaml` is 458 ms, of its `manifest.yaml` 110 ms, and each pass paid
four to six times over).

Three faults compounding: the manifest merge had **no memo at all**; the mirror leg's writes were
**unconditional**, so it re-stamped the mtime the ledger memo was keyed on and **the memo could never hold
in the running system**; and the copy and the merge were **inseparable**, so the expensive half could not be
skipped without leaving a wholesale overwrite standing.

**Fixed:** the shared documents are merged, never copied; both merges memoize on `(ino, size, mtimeNs)`;
every write goes through `writeIfDifferent`; the per-file byte comparison remembers proven-equal pairs; and
the memo is **persisted**, so a restart re-derives nothing that has not moved. **7,285 ms → 1,021 ms.**

### 3. The walk was one uninterrupted synchronous stretch (the item the last pass left open)

**Fixed:** one generator, two drivers. `drainSync` for the write-path callers that cannot await;
`drainYielding` in 8 ms slices with `setImmediate` for every asynchronous caller. Both drive the same
generator, so they cannot drift. Only the reconcile gets the yielding twin — the mirror writes into a git
working tree, where an interruptible pass could straddle the start of a git cycle.

### 4. Four latent faults the new guard tests found

* `mergeManifests` threw `f.pinned_by is not iterable` on an entry lacking that optional field — and every
  call site wraps the merge in a `catch` that WARNs, so the visible symptom was **the manifest silently not
  travelling between the user's computers**.
* `repo_storage.yaml` was copied and then rewritten every pass, an arrangement that cannot converge.
* A **valid empty** mirror document was read as corrupt, refusing to seed a new mirror forever.
* `migrateSyncToPin` — a "one-time" migration — re-read and re-parsed 210+ unit files on **every boot**
  (`boot.migrate.sync-to-pin 754ms/1 call`, found the moment the boot window was attributed). It now latches,
  and the latch is written only on a run that neither threw *nor failed to read anything* — every helper
  there answers an unreadable directory with `[]`, so a naive latch would record "nothing to migrate" for a
  state root nobody looked at. The guard test found that trap, not review.

### 5. The reporter's own hypothesis, tested and not confirmed

"Things happening on the UI render thread" was the right instinct — T1/T2 in `performance.mdx` are exactly
that — but with `perfWatch` armed and tabs open on the heaviest pages, the browser recorded **20
`client:perf` lines and zero `perf.longtask`**: the main thread never accumulated even 500 ms of long tasks
in any 10-second window. Every spinner it reported had a matching server-side slow line. The earlier
hardening (windowed rows, no `MAX_SAFE_INTEGER` page size, route code-splitting) is holding. That is now a
measurement rather than an opinion — if a change puts work back on the render thread, `perf.longtask` says so.

## Verification

| | before | after |
|---|---|---|
| warned 60 s windows | 110 in a day, worst 1,469–7,310 ms | boot window only; steady state clean |
| `GET /api/todo/batches` | 11,985 ms | 26 ms |
| warm mirror + reconcile, 105 repos | 7,285 ms | 1,021 ms |
| worst stall, first pass after a restart | 3,374 ms, `BLOCKED BY: nothing measured` | ~1,200 ms, fully attributed |

Tests: **989 backend + 161 frontend, all passing**, including a new `mirror-cost.spec.ts` (a settled pass
touches no file; a change still travels; the yielding driver lets a timer fire mid-walk) and
`migrate-sync-to-pin.spec.ts` (the second run reads nothing; a failed run leaves no latch).

**Not fixed, and not mine:** `watch-tree.spec.ts`'s macOS content-edit test fails on this machine. Verified
it fails identically at the pre-session baseline commit, in a clean worktree — a pre-existing,
environment-dependent flake in a module this run did not touch.

## Where the code is

* `code/packages/backend/src/shared/blocking.ts` — `blocking()`, `takeBlockingTally()`
* `code/packages/backend/src/shared/request-watch.ts` — `requestWatch()`, `startRequestWatch()`
* `code/packages/backend/src/shared/loop-watch.ts` — `closeWindow()` (prints culprit + who was waiting)
* `code/packages/frontend/src/lib/perfWatch.ts` — `startPerfWatch()`
* `code/packages/backend/src/modules/storage/tracking-sync.service.ts` — the memos, the generator, the drivers
* `code/packages/backend/src/modules/todo/todo.router.ts` — `kickRecalc()`
* `code/packages/backend/src/config/migrate-sync-to-pin.ts` — the latch

Full write-up: `pm/performance.mdx` eighth pass (P-45…P-49). Playbook: `pm/debugging.mdx` Node 0.
