# 2026-07-07 — Device sync never runs (broken launchd trigger-script path) + `.lfbridge/` gitignore hazard

## Symptom

On this computer the personal storage (`~/BGit/Bryan_git/personal_large_files_bridge`) never
synced. The user had turned the dedicated repo backing ON and pointed it at that directory, but:

- no `.lfbridge/` directory ever appeared in the repo,
- this computer's device info was never committed/pushed,
- the other computer had earlier hit a problem where a `.gitignore` on the directory blocked sync.

## Root cause (the real bug, not a per-machine patch)

The background workers are driven by **launchd**, which runs a trampoline
`code/deploy/launchd/run-worker.mjs <worker> <port>` that POSTs the loopback
`/api/internal/run/<worker>` route. The every-10-min **device-registration** worker is what writes
this computer's `.lfbridge/devices/<self>.yaml` into each Git-backed storage, commits, and pushes.

`triggerScriptPath()` in `schedule.service.ts` computed the trampoline path with a brittle relative
hop-count:

```ts
path.resolve(here, "../../../../deploy/launchd/run-worker.mjs")   // 4 levels up
```

From `code/packages/backend/src/modules/schedule/`, 4 levels up lands at **`code/packages/`**, so it
resolved to `code/packages/deploy/launchd/run-worker.mjs` — which **does not exist** (the file lives
at `code/deploy/launchd/run-worker.mjs`, 5 levels up). Every launchd fire died instantly with
`MODULE_NOT_FOUND`, **silently** — a dead launchd job writes nothing to our logs and never reaches
`stampRun`. So device registration never ran on any computer that installed that plist.

This was purely the trigger path. The sync/git logic itself was always correct — including
`GitBackbone.ensureSdlCommittable()`, which strips a bare `.lfbridge/` line from `.gitignore` so the
device registry is committable. It just never got a chance to run.

## Fixes (hardened so first-time / other computers self-heal)

All in `code/packages/backend/src/modules/schedule/`:

1. **`schedule.service.ts` — robust trigger resolution.** `triggerScriptPath()` now *locates*
   `deploy/launchd/run-worker.mjs` by walking UP the directory tree (correct regardless of which
   package subdir the module lives in), with a corrected 5-level canonical fallback.

2. **`schedule.service.ts` — install-time guard.** `buildInstallOpts()` `log.error`s loudly if the
   resolved trigger script does not exist, so this class of silent breakage is visible next time.

3. **`schedule.service.ts` — self-healing reconcile.** `reconcileWorkerSchedules()` (runs at every
   boot) now re-renders an installed plist whose baked-in trigger path **drifted** from what we
   resolve, or **no longer exists on disk** — not just on interval drift. This is what heals every
   already-broken install (this machine and any other computer) on its next app boot, with no manual
   step.

4. **`os/launchd.ts` + `os/installer.ts`** — added `installedTriggerScript(label)` so the reconcile
   pass can read the path baked into the current plist and compare.

## Verification (end-to-end, real app)

- Triggered the exact loopback route launchd calls (`POST /api/internal/run/device`) → HTTP 200.
- Personal repo afterward:
  - `.lfbridge/devices/bryanstarbuck-macbook-pro.yaml` — **this** computer, committed + pushed.
  - `.lfbridge/devices/bryan-mac-pro.yaml` — the **other** computer, **pulled down from origin**
    (bidirectional sync confirmed).
  - `.gitignore` — the `.lfbridge/` line was stripped automatically; `.gitattributes` (union-merge)
    added. `git log origin/main..HEAD` empty → fully pushed.
- Ran the trampoline exactly as launchd does → `run-worker device: ok`.
- Restarted the app on the hardened code; boot log shows the self-heal firing:
  `schedule] device: reconciled schedule (trigger script .../code/packages/deploy/... → .../code/deploy/...)`
  and `sync] device-reg storage personal git: pushed device info to remote`.
- All three launchd jobs (device/scan/ipfs) enabled; device + scan now point at the correct path and
  fire on schedule (device every 600s).

## Files changed

- `code/packages/backend/src/modules/schedule/schedule.service.ts`
- `code/packages/backend/src/modules/schedule/os/launchd.ts`
- `code/packages/backend/src/modules/schedule/os/installer.ts`
