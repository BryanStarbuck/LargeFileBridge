# 2026-08-05 — `pnpm install` said "Already up to date" over a tree where nothing resolved

`just run` on Windows installed nothing, verified nothing, started nothing, and then reported a
**port timeout** for an app that had already been dead for 29 of those 30 seconds.

## Symptom

```
pnpm -C "D:\IPFS\LargeFileBridge/code" install
Scope: all 4 workspace projects
Already up to date                                      ← the install's own verdict
Done in 369ms using pnpm v11.13.0
Setup complete.
…
Starting… (logs: C:\Users\nayan\T\_large_files_bridge\launcher.log …)
Timed out waiting for ports — see C:\Users\nayan\T\_large_files_bridge\launcher.log
error: recipe `run` failed on line 71 with exit code 1
```

and in the launcher log, one second after the start and 29 seconds before that timeout:

```
packages/frontend dev: Error: Cannot find module
  'D:\IPFS\LargeFileBridge\code\packages\frontend\node_modules\vite\bin\vite.js'
[ERR_PNPM_RECURSIVE_RUN_FIRST_FAIL] @lfb/frontend@0.1.0 dev: `vite`
[launcher] pnpm dev exited (code=1 signal=none)
```

Two failures, stacked. `just setup` declared an install complete that was not, and `just run` then
described the consequence as a **slow boot** rather than a dead one.

## Root cause

**1. "Already up to date" is a claim about the LOCKFILE, not about `node_modules`.** pnpm decides it from
the manifests, the lockfile and `node_modules/.modules.yaml` — all plain files, all of them intact here.
It does not walk the tree. Reproduced exactly, on Linux, by removing a single package link from an
otherwise healthy project:

```
before:  .  lib — not installed
Already up to date            ← pnpm, 215ms
Done in 215ms using pnpm v11.3.0
```

**2. On Windows the links inside `node_modules` are junctions, and a junction stores an ABSOLUTE path.**
Move or copy the repo — which is a normal thing to do to *this* repo; it travels between computers by
design, and this checkout lives at `D:\IPFS\LargeFileBridge` — and every package link dangles at once,
while the `.bin\*.CMD` shims survive: they are plain text holding *relative* paths. So `vite.CMD` still
ran, and the `vite\bin\vite.js` it pointed at was no longer reachable. macOS and Linux write **relative**
symlinks, so the same move is harmless there. That is why this was a Windows-only failure.

The same silent shape has several other causes and the task runner cannot tell them apart from outside: a
virtual store pruned by hand, a package quarantined by antivirus, a path over Windows' 260-char limit, an
install cut short — or a tree written by a different pnpm **major** (the `packageManager: pnpm@11.13.0`
pin was making `code/` install under 11.13.0 while `cli/code/` used the machine's 10.28.2; the pin has
since been removed, so a tree built by 11 is now read by 10).

**3. `run` waited for ports it had no reason to expect.** `cmdRun` polled the port file for the full 30s
and then blamed the ports. The launcher — which lives exactly as long as `pnpm dev` does — had exited at
second one. Its death certificate was on the floor, unread.

## The fix

**The task runner stops taking the install's word for it.** `scripts/dev/deps.mjs` is new and owns the
question "does the tree on disk actually resolve":

| function | what it answers |
| --- | --- |
| `treeProblems(root)` | every DIRECT dep of every project resolves to a real package dir (a `stat` that FOLLOWS links, so a dangling junction fails it), and every tool the project's own scripts name has a runnable `node_modules/.bin` shim |
| `ensureInstalled(root)` | install, verify, and repair: `pnpm install` → `pnpm install --force` → remove every `node_modules` and install from scratch → give up **loudly**, naming the packages |
| `describeProblems()` | the finding, per package, with the reason distinguished: `not installed` vs `link points nowhere (→ …)` — the second is the signature of a repo that moved |

`just setup` and `just build-cli` now call `node scripts/dev/dev.mjs install [--cli]` instead of bare
`pnpm install`, so the CLI's tree is held to the same standard as the app's, and the login job
(`boot-run`) uses it too — an unattended start is the least-watched place for a tree that claims to be
installed and is not. It still starts either way there: a repair that could not run unattended must not be
the reason the app is missing at the desk in the morning.

Measured against the reproduction, `--force` says "Already up to date" and repairs **nothing**; the
from-scratch rung is the one that works. It is kept anyway, first and cheap, because it is pnpm's
documented remedy for a modules directory written by a non-compatible major — the case the removed
`packageManager` pin now makes likely.

**`run` reads the death certificate.** `cmdRun` watches the launcher's `exit` (a detached, `unref`'d child
still delivers it) and reports `reportDeadTree()` the moment it arrives: the exit code, the tail of the
launcher log, and — because a stack trace names one missing file rather than the state that produced it —
the dependency-tree finding underneath it.

```
✗ The dev tree exited (code=1) before the app came up — it is NOT running.
  …launcher.log:
  …
  The installed dependency tree is broken — that is very likely why:
    packages/frontend  vite — link points nowhere (→ D:\…\node_modules\.pnpm\vite@8.1.4…)
  Fix it with:  just clean     then     just run
```

## Known and left alone

* **A false-positive verification would fail `just setup`.** That is deliberate — a broken tree reported at
  install time costs a minute, and the same tree discovered later cost the 30-second timeout above. The
  check is kept narrow to earn it: only DIRECT deps (pnpm links every one of those into its own project),
  and only bins the project's own scripts actually name, so a package shipping a bin nobody calls can
  never produce a finding. It reports clean on this repo on macOS/Linux and on `cli/code`.
* **The verifier does not read `pnpm-workspace.yaml`.** It looks at the root and `packages/*`, which is
  what both workspaces here declare. A new glob in that file would need a line here.
* **Nothing prevents the junctions from dangling again.** Moving the repo on Windows will break the tree a
  second time; the difference is that `just run` now says so, in the first second, and fixes it itself.
* **`just clean` was already the manual cure** and still is — the repair ladder is that, automated, at the
  moment the breakage is provable rather than the moment a human suspects it.
