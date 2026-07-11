// Global "Git ignore" request bus (git_ignore.mdx §4). The page-action "Git ignore" link, the file/dir/
// repo ⋮ catalog items, and domainActions.gitIgnoreBig() all call openGitIgnore(...) from anywhere WITHOUT
// threading a modal callback through every call site. The GitIgnoreProvider mounted once at the app root
// subscribes and shows the pop-over dialog. Mirrors lib/compressInside.ts.
export interface GitIgnoreRequestUi {
  /** The checked target set (absolute paths). Exactly one of paths / root is used (git_ignore.mdx §2). */
  paths?: string[];
  /** A single directory (used only when `paths` is absent — the deepest open column's dir). */
  root?: string;
}

type Listener = (req: GitIgnoreRequestUi) => void;

// Exactly one provider is mounted, so a single-slot listener is all we need (no multi-subscriber fan-out).
let listener: Listener | null = null;

/** The provider registers here; returns an unsubscribe for its effect cleanup. */
export function onGitIgnoreRequested(cb: Listener): () => void {
  listener = cb;
  return () => {
    if (listener === cb) listener = null;
  };
}

/** Ask the app to open the Git Ignore dialog. No-op if the provider isn't mounted (shouldn't happen). */
export function openGitIgnore(target: GitIgnoreRequestUi): void {
  listener?.(target);
}
