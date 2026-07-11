// Mounted ONCE at the app root (main.tsx). Subscribes to the git-ignore bus (git_ignore.mdx §4) and shows
// the pop-over dialog when a page "Git ignore" link or a file/dir/repo ⋮ item fires openGitIgnore(...).
// One provider, one dialog — no per-call-site modal wiring. Mirrors CompressInsideProvider.
import { useEffect, useState } from "react";
import { onGitIgnoreRequested, type GitIgnoreRequestUi } from "../../lib/gitIgnore.js";
import { GitIgnoreDialog } from "./GitIgnoreDialog.js";

export function GitIgnoreProvider() {
  const [req, setReq] = useState<GitIgnoreRequestUi | null>(null);
  useEffect(() => onGitIgnoreRequested((r) => setReq(r)), []);
  if (!req) return null;
  return <GitIgnoreDialog req={req} onClose={() => setReq(null)} />;
}
