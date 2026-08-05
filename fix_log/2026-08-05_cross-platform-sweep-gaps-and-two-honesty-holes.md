# 2026-08-05 — What the cross-platform sweep missed, and two things that reported the wrong thing

Review of the two 2026-08-04 entries
([the Windows one](./2026-08-04_autocommit-and-sync-never-run-on-windows.md),
[the follow-on](./2026-08-04_autocommit-cross-platform-and-the-enabled-switch.md)) before they shipped.
Both are correct as far as they go. Two of their sweeps stopped one file short, and two paths they added
report something other than what happened.

## 1. Two call sites the sweeps did not reach

The `~`-expansion sweep replaced ~20 open-coded `p.replace(/^~(?=\/|$)/, process.env.HOME || "~")` sites
with `shared/home-path.ts`. It missed **`modules/pin/pull-retry.service.ts` `repoRootFor()`** — the
3-hour pass that retries user-decided pulls whose bytes never arrived. On Windows it resolved a
configured `~/BGit/repo` against the process CWD, found nothing there, and reported "nothing left to
pull" — so it **stopped re-arming itself**, which is exactly what a completed pass looks like. Now
`resolveHome()`.

The `stableGitBin()` sweep — never a bare `"git"`, because a background worker's PATH need not contain
it and on Windows the file is `git.exe` — covered three of nine sites. It missed
**`modules/storage/company-discovery.service.ts`** (six: `config --global/--system user.email`,
`config user.email`, `log --author`, `init`, `remote`) and **`modules/compress/compression.service.ts`
`findReferences()`** (two). Both swallow a non-zero exit as an *answer* rather than a fault, so a
missing git means "you are a member of zero organizations" and "nothing references the file you just
renamed" — wrong, quiet, and indistinguishable from working.

## 2. The read-only pull called a stuck file a diverged branch

`pullReadOnly()` now clears its own generated blockers and retries the fast-forward. A clear can **fail**
— a file another process holds open, a directory the account may not write, both ordinary on the platform
this was written for — and git then refuses the retry naming the same paths. Everything that was not an
outright success fell through to one message: *"this checkout has diverged from it and reconciling would
require a merge commit"*. That is a false diagnosis of a true failure. It sends the user to `git merge`
for a problem no merge can fix, and the raw first line of git's error carries no filename, so the file
that is actually stuck is never named anywhere.

**Fixed** by re-parsing the residual error: blocked paths still present ⇒ name them and say the tree is in
the way; only a genuine divergence earns the merge-commit wording. Regression test in
`auto-commit-switch.spec.ts` (skipped as root, which ignores the permission bits it turns on).

## 3. A Windows install could still leave the shim lying about being installed

`install()` verifies the registration and drops the shim when Windows does not have the task — the fix in
§1 of the follow-on entry. But the **definition write sits between the shim write and that check**, and
it `throw`s on its own. A full disk or a permission there left the shim on disk with nothing registered:
`isInstalled()` says yes, the jobs page says installed, and reconcile's "already handled" branch keeps
that computer unscheduled forever. The precise silent nothing the verification was added to end, one
failure path over. Every exit from `install()` now takes the shim with it; both paths are tested.

## 4. Two smaller ones

* **`install()` blocked the event loop.** The verification used the *sync* `schtasks /Query` reader, and
  `install()` runs inside `POST /api/jobs/:kind/:action` — up to its own 20s timeout with the whole web
  app frozen behind it. It has an async reader; it now uses it.
* **No systemd call was bounded.** `--user` talks to a session bus that can be absent or wedged, and
  `isEnabled()` is awaited on every jobs-page render — one stuck `is-active` would hang the page rather
  than answer "off". Bounded at 20s, the way `schtasks.ts` bounds its reads.

## Known and left alone

`repetitionInterval()` rounds to whole minutes (Task Scheduler's floor) and `renderTimer()` clamps to
60s (a sane systemd floor), while `reconcileWorkerSchedules()` compares the *configured* seconds against
the *installed* ones. A hand-edited sub-minute `interval_minutes` would therefore read as permanent drift
and re-install on every reconcile. No UI exposes these fields, every shipped value is a whole number of
minutes, and the loop is self-limiting (reconcile runs at boot and on watchdog ticks, and each pass
installs correctly). Teaching the installer interface to declare its own granularity is more surface than
the case is worth today.
