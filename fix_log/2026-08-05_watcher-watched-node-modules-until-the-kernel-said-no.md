# 2026-08-05 — The live watcher watched `node_modules` until the kernel said no

## Symptom

On Linux the live filesystem watcher (scan.mdx §2.2) filled the log with:

```
[WARN] [watcher] watch error on /home/xenx/SSD/Projects/ACT3: ENOSPC: System limit for number of
file watchers reached, watch '…/act3ai-appsrv/.git/objects/pack/multi-pack-index.lock'
[WARN] [watcher] … watch '…/act3ai-appclient/.git/objects/maintenance.lock'   [×89 since 16:00]
```

Every one of those names is a file we would **never** act on. Meanwhile the watcher was doing its real
job badly: past the limit it binds nothing new, so an added or deleted big/media file in an unbound
folder produced **no event at all** — the failure is silent, and looks exactly like "nothing changed".

## Root cause

`startWatcher()` bound one `fs.watch(root, { recursive: true })` per scanner root, and
`onFsEvent()` dropped events whose path contained a `HARD_SKIP` segment.

**Filtering after the event arrives saves the rescan. It never saves the watch.** And `recursive: true`
means three different things:

| OS | What the kernel does | Cost |
| --- | --- | --- |
| macOS | one FSEvents stream per subtree | 1 object |
| Windows | one ReadDirectoryChangesW handle per subtree | 1 object |
| **Linux** | **nothing — inotify has no recursive mode.** Node emulates it by walking the tree and binding an inotify watch to **every** directory | **1 per directory** |

So on Linux we asked the kernel to watch `node_modules`, `.git/objects/**`, `dist/`, `.venv/`,
`__pycache__/` — 104,188 directories under the one configured root — and then threw their events away on
arrival. inotify watches are capped **per user** (`fs.inotify.max_user_watches`) and shared with every
other program on the machine, and `tsx watch` re-registers all of them on every backend restart. ENOSPC
was arithmetic.

Two smaller faults rode along:

* **`scanner.ignore_globs` was dead config.** scan.mdx §2.2 says paths matching it "are ignored before
  either test"; it was surfaced in Settings, written to `config.yaml`, and read by **nothing**. The
  user's `**/node_modules/**` entry had never done anything.
* **LFB woke on LFB.** `ipfs.service.ts` writes `<dest>.lfb-fetch-<pid>-<ms>.tmp` at full size before
  renaming it into place. Being big, it passed the qualifying test — so every file the pin process
  pulled down queued a whole-tree discovery rescan. Both appear in the same log window as the ENOSPC
  storm.

## The fix

**Prune before binding, not after receiving.**

New `modules/watcher/watch-tree.ts`:

* `makeWatchFilter(root, globs)` — the one predicate for what may hold a watch: the scanner's own prune
  set (`HARD_SKIP` + macOS bundles, matching `walkUnit()`) **plus** `scanner.ignore_globs`, now actually
  applied. Directory pruning uses the same three gitignore probes as the scanner's `dirIsExcluded`
  (`foo`, `foo/`, `foo/**` all mean "don't go in here"), and backs off to per-path filtering when a
  pattern is a negation.
* `watchTreePruned(root, opts)` — walks the tree itself (async, yielding, so boot never blocks) and
  binds one **non-recursive** watch per surviving directory. New directories are bound as they appear
  (a freshly installed `node_modules` is refused there too); a deleted directory hands its subtree's
  watches back. `maxDirs` bounds a pathological tree, and hitting it — or the OS refusing a watch — is
  logged **once, with the sysctl that fixes it**, and shown on the Scans page. Never silently partial.

`watcher.service.ts` picks the shape per platform: macOS/Windows keep the single native recursive handle
(binding per-directory there would be strictly worse — thousands of FSEvent streams for no gain);
everything else uses the pruned set. Both run the same filter, so the two paths honour one contract.

`isTransientDownloadFile()` now also matches `*.lfb-fetch-<pid>-<ms>.tmp`.

### Caught in review, fixed here too

* **A folder moved into a root was invisible.** `mv ~/Downloads/shoot ~/Media/` is **one** kernel event,
  for the directory — the files inside it never individually appear, so nothing qualified and no rescan
  ran. `bindTree()` now takes `announceFiles` and reports the files it finds while extending into a
  **newly-appeared** directory (the initial boot walk stays silent — those files are not news). Same fix
  closes the window between a `mkdir` and the watch reaching it, during which a file written inside
  produced no event at all.
* **The cap latched.** Hitting `max_watched_dirs` set the same flag as `ENOSPC`, so once a tree brushed
  the ceiling **no folder was ever watched again** for the life of the process — even after the user
  deleted the tree that filled it. The cap is now a ceiling that re-opens as watches come back (warned
  once, not per folder); only `ENOSPC` stays sticky, because asking the kernel again is genuinely futile.
* **`void startWatcher()` could take the process down.** The call is deliberately not awaited so a big
  tree's walk doesn't delay boot — which left its rejection unhandled, and `main()` registers its
  `unhandledRejection` handler *after* this line. A watcher that failed to bind would have read as a
  process fatal (or killed boot outright). It carries a `.catch()` now; the watcher is best-effort by
  contract.
* **A disable during the initial walk logged "started".** `generation` was claimed after the
  `watcher.enabled` early-return, so the walk that a disable had just orphaned still owned the log line
  and announced "started over 0 root(s)". Claimed first now.
* Plus: the "Listening to 1 folders" plural on the Scans card, and a comment that credited
  `scanner.follow_symlinks` for the symlink skip when `walkUnit()` refuses symlinks unconditionally.

Measured on the reporting machine's actual root, with its actual `ignore_globs`:

```
total dirs under root:        104,188
watches bound after pruning:   30,255   (71% fewer)
```

## Files

* `code/packages/backend/src/modules/watcher/watch-tree.ts` — new: the prune filter + pruned watcher
* `code/packages/backend/src/modules/watcher/watcher.service.ts` — per-platform binding, one filter
* `code/packages/backend/src/shared/scan-filters.ts` — `.lfb-fetch-*.tmp` is a transient temp
* `code/packages/shared/src/schemas.ts` — `watcher.max_watched_dirs` (default 50,000)
* `code/packages/shared/src/types.ts` — `WatcherState.mode` / `.watchedDirs` / `.truncated`
* `code/packages/frontend/src/pages/scans/ScansPage.tsx` — shows folders bound; warns when truncated
* `code/packages/backend/src/modules/watcher/watch-tree.spec.ts` — new: 11 cases
* `pm/scan.mdx` §2.2 / §5

## What this does not change

The watcher's contract is untouched: add/delete only (never "modified"), metadata-only, one `stat` at
most, no IPFS and no network, and the same debounced single kick of the coalesced discovery worker.
Anything outside the watch set is still reconciled by the 4-hour discovery pass — that is exactly what
it is for.
