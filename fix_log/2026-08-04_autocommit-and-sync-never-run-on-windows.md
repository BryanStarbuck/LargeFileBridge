# 2026-08-04 — Auto-commit and sync never really run on Windows

> **Superseded in part.** Reviewing this fix found that two of its pieces did not work: the generated task
> XML was invalid (a bare `<Principal>` where the schema wants `<Principals>`), so no task was ever
> registered — silently — and the installer turned a worker ON regardless of the user's on/off choice. Both,
> plus the still-unscheduled Linux platform, are in
> [`2026-08-04_autocommit-cross-platform-and-the-enabled-switch.md`](./2026-08-04_autocommit-cross-platform-and-the-enabled-switch.md).
> One claim below also needs qualifying: an OS scheduler does **not** make a worker run while the web app is
> closed — the trampoline POSTs the app's loopback API and records a missed cycle when nothing answers. What
> it buys is the *configured* cadence rather than the watchdog's overdue threshold.

## Symptom

On a Windows computer the git backbone barely worked: storages committed and pushed erratically or not
at all, and nothing happened while the web app was closed. Same build, same config, same repos — a Mac
next to it synced every 10 minutes.

## Root causes

Four independent ones, each sufficient on its own to stop a storage syncing.

### 1. No OS scheduler existed on Windows at all

`installer()` in `schedule.service.ts` returned the **no-op** installer for every platform but macOS:

```ts
return process.platform === "darwin" ? launchdInstaller : noopInstaller;
```

So `ensureDeviceWorkerDefaultOn()` "installed" nothing — it flipped config flags and created no OS job.
Nothing ever fired the every-10-minute **device** worker (the git pull / commit / push for every
storage) or the 15-minute **pin** worker.

What covered for it was the in-process watchdog, and only partly: by design it acts on a worker that is
**overdue** — last successful run older than 2× its interval + slack — and only while the app is
running. So the practical cadence on Windows was ~22 minutes, and **zero** whenever the web app was
closed. That is the whole reported symptom, and `scan.mdx §3` had listed Windows Task Scheduler as a
supported target the entire time.

Worse for anyone upgrading: `device_process.auto_provisioned` was already `true` on every Windows
machine that had ever run LFB (the no-op installer "succeeded"), so the default-on provisioning path is
latched shut — merely adding an installer would have healed nobody.

### 2. `~` never expanded, so the working copy never resolved

Twenty modules open-coded the expansion as
`p.replace(/^~(?=\/|$)/, process.env.HOME || "~")`. **`HOME` is a POSIX variable — Windows sets
`USERPROFILE` and leaves `HOME` unset.** A storage configured with a `~/…` local remote therefore
expanded to the *literal* string `~/BGit/sync-repo`; `resolveWorkingCopy()` stats
`~/BGit/sync-repo/.git`, finds nothing, logs `local remote … is not a checkout yet — skipping git
cycle` at INFO, and skips that storage's entire commit/push cycle every pass. Nothing fails. It just
stops syncing.

The same defect seeded `scanner.roots` with the literal `~/BGit` and `~/Documents`
(`config.service.ts defaultRoots()`), so a fresh Windows install scanned nothing and had nothing to
commit in the first place.

### 3. `stableGitBin()` could not find git

Every candidate was built as `path.join(dir, "git")` — the file on Windows is `git.exe` — and the
search directories were `/usr/bin`, `/bin`, `/opt/homebrew/bin`, `/usr/local/bin`. So it always fell
through to the bare name `"git"`, which works only while git is on the *process* PATH: precisely not
the thin background environment this module exists to survive.

### 4. The working-tree gate was case-blind

`worktree-gate.ts` compares resolved path strings. Windows paths are case-insensitive and
`path.resolve` normalizes separators but never case, so `C:\Users\bryan\BGit\repo` and
`c:\users\bryan\bgit\repo` — the same directory — did not match. The gate then answered "nothing is
mid-cycle over this path", the tracking mirror wrote into a tree between its fetch and its merge, and
git refused with `Your local changes to the following files would be overwritten by merge` — the exact
failure that module was written to prevent, reintroduced by the platform.

## Fixes

1. **`modules/schedule/os/schtasks.ts` (new)** — a Windows Task Scheduler installer implementing the
   full `SchedulerInstaller` interface, including the four drift readers so
   `reconcileWorkerSchedules()` self-heals on Windows exactly as it does on macOS. Registered from
   generated XML (`/TR` quoting is lossy; XML is also language-neutral, which `isEnabled()` needs
   because `schtasks /Query /FO LIST` prints a localized status). Its action runs a generated `.vbs`
   shim under `wscript` — redirecting stdout/stderr to the same `log.log`/`error.err` the plist names,
   and hidden, because a console-program action pops a window on the desktop on every fire. Cadence is
   a `TimeTrigger` bounded at now with an indefinite repetition, deliberately not a `LogonTrigger`
   (whose repetition would not start until the next logon). Spec'd in `pm/scan.mdx §3.2`.

2. **`schedule.service.ts`** — `installer()` returns it on `win32`; `stableNodeBin()` returns
   `process.execPath` unchanged on Windows (following the `C:\Program Files\nodejs` symlink, which is
   what the POSIX branch deliberately does, would bake in the version-pinned nvm path this function
   exists to avoid); and `reconcileWorkerSchedules()` now **reinstalls a schedule the OS does not have
   while config says it is installed**. That last one is what heals every already-upgraded Windows
   machine on its next boot, past the `auto_provisioned` latch, with no manual step.

3. **`shared/home-path.ts` (new)** — one `expandHome`/`resolveHome`/`collapseHome` built on
   `os.homedir()`, handling `~/x` and `~\x` and leaving `~user` alone. All 20 open-coded sites now
   call it; `badges.ts` re-exports it so existing importers are unchanged. `defaultRoots()` fixed.

4. **`modules/git/git-bin.ts`** — looks for `git.exe` on Windows and searches the real Git for Windows
   install locations (`%ProgramFiles%\Git\cmd`, the x86 tree, and the per-user `winget` install), read
   from the environment so a machine whose Windows is not on `C:` works. Never resolves to `git.cmd`:
   Node refuses to spawn `.cmd` without `shell: true` (CVE-2024-27980), which would trade a missing
   binary for an unspawnable one.

5. **`modules/git/worktree-gate.ts`** — case-folds paths on Windows. Scoped to `win32` on purpose: a
   default APFS/HFS+ volume is case-insensitive too, so the same hole is open on macOS, but changing
   comparison semantics on the primary platform is its own decision.

6. **`config/state-dir.ts` + `deploy/launchd/run-worker.mjs`** — the last-ditch state-root fallback is
   `os.tmpdir()`, not a literal `/tmp`, which on Windows means `<drive>:\tmp` — a directory that does
   not exist, so a missed cycle could not even be recorded.

## Verification

- New specs: `modules/schedule/os/schtasks.spec.ts` (shim render→read round-trip for every field
  reconcile compares, task-XML cadence/battery/overlap/missed-run settings, UTF-16 decoding, and that
  `isEnabled` reads `<Settings><Enabled>` rather than a trigger's) and `shared/home-path.spec.ts`.
- Full backend suite: **485 passed / 56 files**. `tsc --noEmit`: clean.
- Not verified on a Windows machine — no Windows host was available. The behaviour that can only be
  observed there is `schtasks` accepting the generated XML and the task firing on its repetition.

## Known Windows gaps left open (deliberately, and out of this fix's scope)

- **IPFS auto-start on reboot is macOS-only** (`ipfs-autostart.service.ts` `supported()` returns
  `darwin`). The daemon can be started from the app on Windows, but it will not come back after a
  restart, so byte sync stays off until someone opens the app. Porting it means a logon-triggered task
  plus a Windows equivalent of the launchd state/conflict reading.
- **The app-launch layer is Mac/Linux-shaped** — `justfile`, and `packages/frontend/scripts/web-port.mjs`
  which shells out to `lsof` and writes `/tmp/lfb.web.port`. On Windows it degrades (it cannot detect
  or reclaim a stale instance's port) rather than failing outright; the backend and the workers are
  unaffected once running.

## Files changed

- `code/packages/backend/src/modules/schedule/os/schtasks.ts` (new)
- `code/packages/backend/src/modules/schedule/os/schtasks.spec.ts` (new)
- `code/packages/backend/src/modules/schedule/schedule.service.ts`
- `code/packages/backend/src/shared/home-path.ts` (new)
- `code/packages/backend/src/shared/home-path.spec.ts` (new)
- `code/packages/backend/src/modules/git/git-bin.ts`
- `code/packages/backend/src/modules/git/worktree-gate.ts`
- `code/packages/backend/src/config/state-dir.ts`
- `code/deploy/launchd/run-worker.mjs`
- `code/packages/backend/src/modules/store-model/config.service.ts`
- 13 modules repointed at the shared `expandHome` (badges, pin, scanner, watcher, units, repos,
  files-query, decisions, debug-export, known-media, todo-batch, transcribe-scan,
  export-repo-recommendations) plus `todo.router.ts` / `compression.service.ts` for `collapseHome`
- `pm/scan.mdx` §3 / §3.2
