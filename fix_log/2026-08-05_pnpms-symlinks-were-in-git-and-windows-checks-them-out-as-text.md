# 2026-08-05 — pnpm's symlinks were committed to git, and Windows checks a symlink out as a text file

The morning's [install-verification fix](./2026-08-05_install-said-up-to-date-over-a-tree-that-resolved-nothing.md)
made `just setup` prove its own work and repair what it found. It did not hold: the same failure came back
on the next Windows machine, because the breakage was not in `node_modules` at all. **It was in git.**

## Symptom

Two machines, two different missing modules, one shape.

```
Error: Cannot find module 'D:\…\code\packages\frontend\node_modules\vite\bin\vite.js'
```
```
Error: Cannot find module 'jose'          ← the backend, before its logger exists, so log.log is empty
```

Both survived a reinstall. Both came back after a `git pull`.

## Root cause

`git ls-files -s` on this repo, before this fix:

```
120000 6542374b…  code/packages/frontend/node_modules/vite
120000 0a1f0edb…  code/packages/backend/node_modules/tsx
…36 entries
```

and in OpenAuthFederated, twelve more — including the one that names the second symptom:

```
120000 da6c955b…  code/packages/auth-backend/node_modules/jose
```

**Mode 120000 is a symlink**, and git stores one as a blob containing the target path. `git cat-file -p`
on the `vite` entry is a single line:

```
../../../node_modules/.pnpm/vite@8.1.4_@types+node@26.1.1_esbuild@0.28.1_jiti@2.7.0_tsx@4.23.1_yaml@2.9.0/node_modules/vite
```

**A Windows checkout has no symlink support by default** — creating one needs Developer Mode or
elevation, so git sets `core.symlinks=false` and writes the blob as an ORDINARY FILE. So on every Windows
clone, `packages\frontend\node_modules\vite` is a 123-byte **text file** whose entire contents are that
path. Not a package. Not a link. A file named `vite`.

That is the whole failure, and it explains every part of it that made no sense:

* `pnpm install` says **"Already up to date"** — the lockfile and `.modules.yaml` are intact, and pnpm
  does not walk the tree;
* the `.bin\vite.CMD` shim runs and cannot find `..\vite\bin\vite.js`;
* **no repair holds.** `just clean` + reinstall fixes the tree, and the next `git checkout`, `git pull` or
  auto-sync writes the text files straight back. This repo auto-commits continuously, so the loop was
  closed: the Mac kept re-committing the symlinks that broke every Windows machine, forever.

`.gitignore` has listed `node_modules/` all along (line 99, with a comment saying it is never committed).
**An ignore rule does not untrack what is already in the index** — one `git add -f`, or one commit made
before the rule existed, and it is in history for good.

## The fix

**1. Untracked, in both repos** — `git rm -r --cached -- "*node_modules/*"`, 36 entries here and 12 in
OpenAuthFederated. The files stay on disk; git stops carrying them between computers.

**2. `just setup` now refuses to be quiet about it.** `scripts/dev/deps.mjs` `trackedModules()` asks git
what it is tracking under any `node_modules/`, and `warnIfTracked()` — called at the top of every
`ensureInstalled()` — prints the count, the first few paths, and the two commands that untrack them. It is
a warning and not a hard stop: the tree can still be repaired, but the user is told, in the same breath,
that git will undo the repair.

**3. The diagnosis names this shape directly.** A plain FILE where a package directory belongs is now
reported as what it is, rather than as a generic "does not resolve":

```
packages/frontend  vite — a COMMITTED SYMLINK, checked out as text (→ ../../../node_modules/.pnpm/vite@8.1.4…)
```

**4. The auth lib gets its own verified install** (`dev.mjs` `ensureAuthLib`), which is what makes the
untracking safe there. A `link:` dependency is a link to a directory, not a copy of a package: nothing
about installing this workspace installs OpenAuthFederated's, and once its `jose` link is no longer
carried by git, a machine that never ran `pnpm install` there has no `jose` at all. Loud, never fatal — a
sibling repo is not ours to guarantee, and `_check-auth-lib` already hard-stops when it is missing
outright. Its `checkAuthLib()` now tests for `package.json` rather than for the directory, because the
directory a `link:` points at survives its contents being removed.

## What every machine has to do once

Pulling this DELETES those paths from the working tree — they are tracked deletions. That empties the
links on macOS and Linux too, so on every computer, once:

```
just setup        (detects the emptied tree and reinstalls it — deps.mjs)
```

## Known and left alone

* **Git cannot be made to write symlinks on Windows** without Developer Mode or an elevated shell
  (`git config core.symlinks true` only lies faster). Keeping them out of the index is the whole cure.
* **Other repos on this machine still commit symlinks outside `node_modules`** — `all` has four
  (`go.mod`/`go.sum` and two media directories), `charlie-kirk` one. They are deliberate and they are not
  dependency trees, but they will check out as text files on Windows just the same.
* **Nothing stops a future `git add -f node_modules/…`.** The warning above fires on the next `just setup`
  and names the fix; a pre-commit hook was not added, because this repo's auto-commit path would be the
  thing fighting it.
