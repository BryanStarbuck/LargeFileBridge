// ONE lock per storage's git working tree (storage_company.mdx §11.3).
//
// Every git operation against a storage's working copy — the pin pass, the device write, the mirror nudge,
// and the company ownership assertion — must take THIS lock. The company path used to have a SECOND,
// independent lock in owner-propagation.service.ts, and two locks over one working tree are not a lock: an
// assertion could land mid-merge and corrupt the index. It lives in its own leaf module so both callers can
// share it without an import cycle.
//
interface GitLockState {
  /** The in-flight holder — resolves when the current pass settles. */
  running: Promise<unknown>;
  /** The single queued successor, if any. Further callers share this exact promise. */
  queued: Promise<unknown> | null;
}
const storageGitLocks = new Map<string, GitLockState>();

export function withStorageGitLock<T>(id: string, fn: () => Promise<T>): Promise<T> {
  const state = storageGitLocks.get(id);

  // Nothing running — take the lock immediately.
  if (!state) {
    const running = (async () => fn())();
    const entry: GitLockState = { running, queued: null };
    storageGitLocks.set(id, entry);
    void running.then(
      () => releaseStorageGitLock(id, entry),
      () => releaseStorageGitLock(id, entry),
    );
    return running as Promise<T>;
  }

  // Something is queued already — collapse into it. The queued pass has not started, so it will observe
  // everything this caller wanted synced. Returning its promise means N callers await ONE pass.
  if (state.queued) return state.queued as Promise<T>;

  // One is running, none queued — queue exactly one successor.
  const queued = state.running.then(
    () => fn(),
    () => fn(), // a failed holder must not poison its successor
  );
  state.queued = queued;
  return queued as Promise<T>;
}

/** Promote the queued pass (if any) to running when the current holder settles; else drop the lock entry. */
function releaseStorageGitLock(id: string, entry: GitLockState): void {
  if (storageGitLocks.get(id) !== entry) return; // superseded already
  if (!entry.queued) {
    storageGitLocks.delete(id);
    return;
  }
  const promoted: GitLockState = { running: entry.queued, queued: null };
  storageGitLocks.set(id, promoted);
  void promoted.running.then(
    () => releaseStorageGitLock(id, promoted),
    () => releaseStorageGitLock(id, promoted),
  );
}

