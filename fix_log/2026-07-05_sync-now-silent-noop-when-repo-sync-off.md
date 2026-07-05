# FIXED — "Sync now" silently pinned nothing (repo showed no IPFS-pinned files)

## Bug report

On the one-repo page for `charlie-kirk` (`/repos/bad3cd4187d03401`): "I thought I had a lot of
local files pinned, but now I look in here and don't see anything that's IPFS pinned. Why aren't
all the charlie-kirk files pinned? Is the product broken?"

## Diagnosis (what was and wasn't wrong)

* **The IPFS pin engine works.** Live `ipfs add?pin=true` + `pin/ls` round-trips fine; the daemon
  held 1203 pins (all from other IPFS use — **none** LFB-managed).
* **Nothing was ever opted into sync.** Across all ~160 registered repos there were **zero**
  `manifest.yaml` files, **zero** `synced: true` repos, and **zero** file decisions. charlie-kirk's
  unit (`sync/r/charlie-kirk-2`) had `synced: false`, `decisions: {}`, `last_sync_at: null`, no
  manifest. So the empty "pinned" view was *accurate to the state* — LFB had pinned nothing.
* **The real bug — the reason it stayed that way.** The one-repo page's **Pin toggle** (sets a
  file's decision to `sync`) and **Sync now** button are the whole workflow, but `syncRepoFolder`
  bailed at the top on `if (!cfg.synced) return` — and that guard fired for **both** the background
  scheduler **and** the manual "Sync now" route. On a fresh repo (`synced:false`, which is the
  charter default — "discovered but off until the user opts in") clicking Sync now hit that guard,
  returned immediately, moved no bytes, wrote no manifest — yet the frontend still toasted
  "Sync complete". A silent no-op with a success message. The user could mark files and click Sync
  now forever and nothing would ever pin.

This contradicts the spec: `one_repo.mdx` §3.2 scopes the per-repo `synced` toggle to **background
syncs only** ("skips this repo *during background syncs*; decisions preserved but no bytes move"),
while §3.1 defines **Sync now** as the repo's unconditional primary action. The manual path should
never have been gated by that flag.

## Root cause

`code/packages/backend/src/modules/sync/sync.service.ts` — `syncRepoFolder()` used one
`if (!cfg.synced) return` guard for every caller. Callers:

* `POST /api/repos/:repoId/sync` (repos.router.ts) — **manual** "Sync now" / "Sync now (selected)".
* `syncAll()` — the **background** scheduler (launchd → `cli sync`, and the internal sync worker).

The manual caller inherited the background-only gate.

## Fix

`syncRepoFolder(folder, onlyPaths?, opts?: { manual?: boolean })`:

* Background path (`opts.manual` falsy): unchanged — still skips when `synced:false`.
* Manual path (`opts.manual === true`): no longer skips. Because clicking Sync now is the user
  explicitly opting this repo in, a manual run on an off repo also flips `synced = true` so the
  every-15-min background sync keeps it fresh from then on.

`repos.router.ts` — the `POST /:repoId/sync` handler now calls
`syncRepoFolder(folder, only, { manual: true })`. `syncAll()` is untouched, so background behavior
and the charter's "off until opt-in" default are preserved.

## Verification

* `tsc --noEmit` on the backend → exit 0; `tsx watch` hot-restarted the running server;
  `GET /api/health` → `{status: ok, ipfs: ok}`.
* Integration run of the real service against the live state dir + IPFS node on charlie-kirk-2,
  whole-repo manual sync with one file (the 56 KB `videos/2011947043674034660.mp3`) decided `sync`:
  * BEFORE `synced: false`, `decisions: {}`.
  * AFTER `synced: true`; `manifest.yaml` written with the file's real CID
    `bafybeih2ohwgd5mbkg7epcs7jayuidvfsd6tzgipwz5ctkb2pznc5pjzjy`, `pinned_by: [this-computer]`.
  * `ipfs pin/ls` confirms that CID is pinned recursively; committed manifest published to
    `.lfbridge/manifest.yaml` in the repo.

  Previously this exact call returned immediately and pinned nothing.

## Note / follow-up (not fixed here)

Spec `one_repo.mdx` §3.2 calls the per-repo **Sync** control an *editable toggle in the status
strip* ("the only editable control in the strip"). The current `OneRepoPage.tsx` renders Sync as
**read-only text** inside the collapsed "Repo details" disclosure; the only editable toggle lives on
the separate Repo settings page. With this fix the primary Sync-now path works regardless, so it is
no longer load-bearing — but restoring an inline, editable Sync toggle on the repo page would match
the spec and make the on/off state directly visible.
