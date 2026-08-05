# 2026-08-04 — Auto-commit across platforms, and the switches it was ignoring

Follow-on to [`2026-08-04_autocommit-and-sync-never-run-on-windows.md`](./2026-08-04_autocommit-and-sync-never-run-on-windows.md),
written while reviewing it. Two of its fixes did not work, one platform was still unscheduled, and the
`git_backbone.auto_commit` switch shipped the day before had a hole of its own.

## 1. The Windows scheduler could not register a single task

`renderTaskXml()` emitted a bare `<Principal id="Author">` directly under `<Task>`. The Task Scheduler
schema has a **`<Principals>`** element wrapping `<Principal>`; a bare one is rejected outright, so
`schtasks /Create /XML` failed on every worker on every machine.

It failed **silently**, and that is the part worth keeping:

* `schtasks()` swallows its own failures (deliberately — they are chatty and benign more often than not),
  so the rejection was a `log.warn` and `install()` returned normally.
* `isInstalled()` answers from the **shim file**, which had just been written.
* So config recorded `installed: true`, the jobs page said installed, and **no task existed**. Precisely
  the silent nothing the whole file was written to end.

**Fixed** by wrapping the principal, and by making `install()` **verify**: it queries the task back, and
when Windows does not have it, removes the shim (so `isInstalled()` stops lying) and raises, which sends
the next `reconcileWorkerSchedules()` round through the reinstall branch.

## 2. Installing a Windows worker turned it ON, whatever the user had chosen

`<Settings><Enabled>true</Enabled>` was hard-coded. A scheduled task is **live the moment `/Create`
accepts it** — unlike a plist, which does nothing until `launchctl bootstrap` — so every install
re-enabled the worker: at boot, at each watchdog repair, and at each routine drift re-render inside
`reconcileWorkerSchedules()`. For the `device` worker that is the git pull / commit / push for every
storage: the computer resumed committing and pushing every 10 minutes with the switch showing off.

Nothing in the reconcile pass could have caught it either. It only ever asked whether an **ON** worker
was running (`notActuallyLoaded`); a worker that was OFF and running anyway read as "already correct".

**Fixed** by carrying the desired state into the install (`InstallOpts.enabled`, from
`<worker>_process.enabled`) and rendering `<Settings><Enabled>` from it, and by teaching reconcile the
other direction — `runningWhileOff` now stops a worker the OS runs while settings say off.

**The same asymmetry existed for `installed`**, and it was worse because it was silent on every platform:
reconcile handled "config says installed, the OS does not have it" (reinstall) but for the mirror —
**"the OS has it, config says it is not installed"** — it just `continue`d. So a unit left behind by a
hand-edited config, a config reset, or a half-failed uninstall kept firing forever with nothing anywhere
to correct it; for the `device` worker, an orphan schedule still committing and pushing. Reconcile now
uninstalls it. Config is the decision and the OS is made to match it in both directions, for both flags —
the table in `pm/scan.mdx §3.0`.

## 3. Linux had no OS scheduler at all — the same hole, one platform over

`installer()` returned the no-op for Linux, so nothing fired the every-10-minute device worker there
either: auto-commit ran at the in-process watchdog's overdue threshold (~22 minutes at best) and only
while the web app was open. `scan.mdx §3` had listed a systemd timer as a supported target the whole time.

**Fixed** with `modules/schedule/os/systemd.ts` — a **user** timer (never a system unit: these workers run
as the user and reach the user's git credentials), implementing the full `SchedulerInstaller` interface
including the four drift readers, so a Linux computer self-heals exactly as a Mac one does. Two choices
worth naming: `OnActiveSec` + `OnUnitActiveSec` rather than `OnBootSec` (a boot-relative deadline is
already in the past for a timer started mid-session, so systemd fires it immediately — every reconcile
repair would kick a git cycle), and a `daemon-reload` after every write, without which systemd keeps
serving the old unit and a re-render that fixed a drifted interval changes nothing. `installer()` returns
it only when systemd is genuinely drivable (`supported()`: systemd-booted **and** `systemctl` present) —
a non-systemd Linux keeps the no-op rather than accumulating unit files nothing reads. Spec'd in
`pm/scan.mdx §3.3`.

Existing Linux machines heal themselves: they already have `device_process.installed = true` written by
a build whose installer was the no-op, so the reinstall branch added yesterday picks them up on the next
boot, past the `auto_provisioned` latch, with no manual step.

## 4. With auto-commit OFF, the backbone stopped syncing after one pass

The write switch's read-only pull is fetch + `merge --ff-only`. But with the switch off,
`checkpointOwnWrites()` is skipped — it is a commit — while everything that **writes** the tree carries
on every pass: the device file, the manifest, the mirrored `repos/<repoUid>/` subtree (pin.service.ts
writes those regardless of Git, by design). So the tree is permanently dirty with LFB's own generated
text, and the fast-forward aborts with `Your local changes to the following files would be overwritten by
merge` — the exact abort the checkpoint was invented to kill, now on **every** cycle. Read-only meant
"does not sync", which is not what the switch says. The surfaced message also blamed the wrong thing:
"fast-forward not possible", pointing the user at a divergence that usually wasn't there.

**Fixed** by having the read-only pull clear **its own** blockers, the way a refused merge already does
elsewhere: `clearBlockingOwnFiles()` quarantines each path under the state root, then deletes an untracked
one and restores a tracked one from HEAD, and the fast-forward is retried. That **authors nothing** —
index and working tree only — and the peer's copy simply wins over a cache the next pass regenerates. A
blocker LFB does not own is still never touched: it is named in the problem and the user decides. A
genuine divergence still surfaces, now saying so accurately. Spec'd in `pm/git_backbone.mdx §6.8`.

## 5. Three git spawns the git-bin fix missed

`stableGitBin()` exists because a background worker's PATH need not contain git. Three sites still spawned
a bare `"git"`, all of them reachable from the workers:

* `modules/storage/artifact-committability.service.ts` — the worst of them. A spawn failure reads as a
  non-zero exit, i.e. "this repo cannot commit its artifacts", so a git that isn't on PATH would quietly
  quarantine every artifact on the machine.
* `modules/pin/pin.service.ts` `readGitRemoteUrl()` — runs once per device pass.
* `modules/storage/hardware.service.ts` `gitConfig()` — the user identity written into device registration.

## 6. Smaller things found on the way

* `collapseHome()` compared with a bare `startsWith`, so with home `/Users/bry` the **sibling**
  `/Users/bryan/BGit` displayed as `~an/BGit`. Now boundary-aware, and case-insensitive on Windows.
* Every `schtasks /Query` is a process spawn, and the sync reader blocks the event loop for its duration —
  one reconcile pass asked twice per worker. Memoized for 5s, dropped whenever we change the registration.
* `/Query … /XML ONE` → `/XML`. `ONE` is documented as "all tasks in one file"; combined with `/TN` its
  behaviour varies by build, and another task's `<Repetition>` is the last thing that reader wants.
* Orphaned doc comments and doubled blank lines left by yesterday's `expandHome` de-duplication — one of
  them had drifted onto the *following* function.

## Verification

- Full backend suite: **510 passed / 58 files**. `tsc --noEmit`: clean.
- New specs: the `<Principals>` wrapper and the ON/OFF rendering (`schtasks.spec.ts`), the whole
  systemd render→read round-trip (`systemd.spec.ts`, new), read-only convergence over a dirty tree and
  the untouched-foreign-file case (`auto-commit-switch.spec.ts`), `collapseHome`'s segment boundary.
- `merge --ff-only` refusing on a dirty tracked file was reproduced by hand first, to confirm §4 was real
  and that `parseBlockedPaths()` matches the message git actually prints.
- **Not verified on Windows** — no Windows host available. What can only be observed there: `schtasks`
  accepting the corrected XML, and the task firing on its repetition. §1's verify step is what turns a
  further mistake there into a loud failure instead of another silent one.
- **`reconcileWorkerSchedules()` has no automated test**, before or after this change — it selects its
  installer by `process.platform`, so a spec would be platform-dependent, and the only honest end-to-end
  version would shell out to the developer's real `systemctl --user` and could disable a unit they
  actually use. Not worth the harness for these branches; both are the exact mirror of code beside them.
- **Not verified on a logged-out Linux session.** A user timer only fires while the user's systemd manager
  is running (`loginctl enable-linger` otherwise) — the same practical bound the app already has, since
  the trampoline POSTs a running backend.

## Still open (deliberately)

- **The OS scheduler does not make the workers run while the app is closed, on any platform.** The
  trampoline `run-worker.mjs` POSTs the loopback API and, finding nothing there, records a missed cycle and
  exits. What a scheduler buys is the *configured* cadence instead of the watchdog's overdue threshold, and
  a recorded miss instead of silence. Yesterday's entry describes the closed-app gap as part of the
  reported symptom; it is not something a scheduled task or timer fixes.
- The macOS working-tree gate is still case-sensitive while a default APFS volume is not (noted in
  yesterday's entry, unchanged here).
- IPFS autostart-on-reboot remains macOS-only.

## Files changed

- `code/packages/backend/src/modules/schedule/os/schtasks.ts` — `<Principals>`, `<Settings><Enabled>` from
  `InstallOpts.enabled`, install verification, query memoization, `/XML`
- `code/packages/backend/src/modules/schedule/os/systemd.ts` (new) + `systemd.spec.ts` (new)
- `code/packages/backend/src/modules/schedule/os/installer.ts` — `InstallOpts.enabled`
- `code/packages/backend/src/modules/schedule/schedule.service.ts` — systemd in `installer()`,
  `enabled` in `buildInstallOpts()`, `runningWhileOff` in `reconcileWorkerSchedules()`
- `code/packages/backend/src/modules/git/git.service.ts` — `tryFastForward()`, `pullReadOnly()` recovery
- `code/packages/backend/src/modules/storage/artifact-committability.service.ts`,
  `code/packages/backend/src/modules/pin/pin.service.ts`,
  `code/packages/backend/src/modules/storage/hardware.service.ts` — `stableGitBin()`
- `code/packages/backend/src/shared/home-path.ts` — `collapseHome()` boundary + case
- `code/packages/backend/src/modules/schedule/os/schtasks.spec.ts`,
  `code/packages/backend/src/modules/git/auto-commit-switch.spec.ts`,
  `code/packages/backend/src/shared/home-path.spec.ts`
- `code/packages/backend/src/modules/todo/todo.router.ts`,
  `code/packages/backend/src/modules/files-query/files-query.service.ts`,
  `code/packages/backend/src/modules/videos/known-media.ts` — orphaned comments / blank lines
- `pm/scan.mdx` §3 / §3.0 / §3.2 / §3.3, `pm/git_backbone.mdx` §6.8
