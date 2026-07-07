# FIXED — File System columns don't restore on return (stale client view-state cache)

## Bug report

"I go into the File System left-bar tab. I select a directory in the first column, that opens a
second column, I select a directory there, a third column opens, I select a directory there. As I
click a directory (often in deeper columns) we should be saving it off in the per-user YAML for each
level. When I navigate away to another left-bar area and then come back and click File System, it
should reload those columns with the directory selected at each level. It doesn't."

Third time reported — every prior fix attempt failed, so the fault was somewhere the earlier passes
weren't looking.

## Why earlier fixes kept missing it

The backend save/load was correct the whole time and looked correct on inspection:

- `PUT /api/fs/view-state` → `saveFsView()` writes `columns` / `selection` into
  `users/<email>/config.yaml` `file_system:` — verified the YAML held the right `columns:`.
- `GET /api/fs/view-state` → `loadFsView()` prunes to existing paths and returns them fine.
- `FileSystemPage` restores from `api.fsViewState()` behind a one-shot `restoredRef` gate.

Because the `config.yaml` clearly showed the correct columns, attention kept going to the
save/load/restore logic — all of which work. The defect was on the **client cache side**, invisible
unless you trace react-query.

## Root cause

The frontend caches the `GET /view-state` result under react-query key `["fs","viewState"]`. Global
config (`api/queryClient.ts`) sets `staleTime: 5_000` with the default 5-minute `gcTime`.

Sequence that breaks:

1. First mount fetches view state → cache holds it (on a fresh session: empty columns).
2. User clicks through columns. `stack` grows; the debounced `saveFsViewState()` PUTs the new chain
   to the backend — **but never updates the `["fs","viewState"]` cache.** The cache still holds the
   snapshot from step 1.
3. User navigates to another left-bar tab → `FileSystemPage` unmounts. The unmount flush PUTs again
   (server correct), cache still stale. `gcTime` keeps the stale entry for 5 minutes.
4. User returns within 5 minutes → remount. The query serves the **stale cached** value immediately
   (`isPending: false`) and kicks off a background refetch.
5. The restore effect runs once, seeds `stack` from the stale cache (empty → falls back to home),
   and sets `restoredRef = true`. When the background refetch lands with the correct server value,
   `restoredRef` is already true, so the fresh value is ignored.

Net: the just-selected columns are thrown away and the page reopens at home — even though the server
and YAML are correct.

## Fix summary

**Keep the client view-state cache coherent with every save** —
`code/packages/frontend/src/pages/fs/FileSystemPage.tsx`, `FileSystemPage`:

1. Added a `persistView()` helper (via `useQueryClient()`) that writes the just-saved
   `{columns, selection}` into the `["fs","viewState"]` cache with `queryClient.setQueryData()` at
   the same moment it calls `api.saveFsViewState()`, preserving any existing `filters` / `updated_at`.
2. Routed BOTH save paths through it — the debounced on-change save and the flush-on-unmount save.

Now the cache always equals the last-saved state, so the one-shot restore on the next mount seeds the
correct column chain whether it reads from cache (within the window) or refetches from the server
(after gc). No react-query timing races: even the "serve stale then refetch" path now serves the
correct value.

## Spec updated

`pm/directories.mdx §1.3` — added a LOCKED "Client cache coherence on the round-trip" rule spelling
out that the save must update the client's cached view state (not just the server) and that the
one-shot restore must not lock in a stale cached value, plus the diagnostic tell (correct YAML +
page still opens at home ⇒ the defect is client-cache-side). Also added a frontend code-pointer for
`persistView()`.

## Verification

- `pnpm --filter @lfb/frontend typecheck` — clean.
- Logic trace: after selecting columns, the `["fs","viewState"]` cache now carries the new chain, so
  a remount within the 5-minute window restores it instead of the pre-selection snapshot.
