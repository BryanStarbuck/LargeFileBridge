// ONE pin pass at a time PER REPO UNIT.
//
// Storage units have had a lock since storage_company.mdx §11.3 (git-lock.ts). Repo units had nothing, and
// three independent callers reach `pinRepoFolder` for the SAME folder:
//
//   • the decision-triggered targeted pin — one per decision click (repos.router.ts, `firePin`);
//   • a manual "Pin now" (POST /:repoId/pin);
//   • the 15-minute background pass (`pinAll` → `pinRepoSafe`).
//
// `passInFlight` guards whole passes against each other, never a pass against a route call. Two overlapping
// runs each snapshot the manifest at entry and each write it WHOLESALE at exit (`runUnitPin` →
// `writeRepoManifest`), so the loser's freshly-added CIDs are dropped — and the file is then re-hashed and
// re-uploaded on the next pass. Clicking a decision while the background pass happens to be on that repo is
// all it takes.
//
// WHY A FIFO CHAIN AND NOT THE COALESCING LOCK. git-lock.ts deliberately collapses waiters: a storage git
// cycle is a reconciliation to current state, so running it twice is never more correct than once. A repo
// pin is NOT always that — a paths-SCOPED run (`onlyPaths`) carries the user's selection, so collapsing a
// pin of {y} into a queued pin of {x} would silently never pin y. Each caller therefore keeps its own turn
// AND its own `PinCounts`, which the route reports back to the user.
//
// Chains are dropped once drained, so an idle repo costs nothing.
const chains = new Map<string, Promise<void>>();

/** Run `fn` after every earlier caller for `key` has settled. Each caller gets its own result. */
export function withUnitLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = chains.get(key) ?? Promise.resolve();
  // `.then(fn, fn)` — a predecessor that threw must not poison its successor, exactly as git-lock.ts does.
  const run = prev.then(fn, fn);
  const tail = run.then(
    () => {},
    () => {},
  );
  chains.set(key, tail);
  void tail.then(() => {
    if (chains.get(key) === tail) chains.delete(key);
  });
  return run;
}

/** TEST-ONLY: how many repo units currently have a pass running or queued. */
export function activeUnitLockCount(): number {
  return chains.size;
}
