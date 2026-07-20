// A repo's MACHINE-INDEPENDENT identity, derived from its git remote (storage_company.mdx §8.4.1).
//
// There are TWO keys for a repo and they do different jobs:
//   • repoKey (tracking-root.service.ts) = sha1(absolute path) — "THIS repo on THIS computer". It keys
//     Local Storage `~/T/_large_files_bridge/repos/<repoKey>/`, which is machine-local state and SHOULD be
//     path-keyed. Two clones of the same repo on one machine correctly get separate state.
//   • repoUid (here) = sha1(normalized remote) — "this repo, ANYWHERE". It keys the shared sync-repo mirror
//     `<syncRepo>/repos/<repoUid>/`, which every one of the user's computers reads and writes.
//
// The defect this closes: the mirror used to be keyed by repoKey. The same repo lives at
// /Users/bryan/BGit/… on one computer and /Users/bryanstarbuck/BGit/… on another, so the two machines wrote
// and looked for DIFFERENT directories inside the same sync repo. The manifest could travel perfectly and
// still never be found. A machine-local value must never key machine-shared data.
//
// This is a LEAF module (pure string + crypto, no project imports) so tracking-root.service.ts can use it
// without an import cycle. git.service.ts re-exports `parseRemoteOwner` / `normalizeRemoteKey` /
// `sameRemoteKey` from here so their existing importers are unchanged and there is only ONE parser.
import crypto from "node:crypto";

// The public forge hosts we recognize for owner/organization parsing (repo_company_mapping.mdx §2). On
// these, a repo URL carries `<host>/<owner>/<repo>`, and `<owner>` is the GitHub org / GitLab group / user.
export const KNOWN_FORGES = /(github\.com|gitlab\.com|bitbucket\.org|codeberg\.org|git\.sr\.ht)/i;

/** The parsed pieces of a remote origin URL (repo_company_mapping.mdx §2), or null when it isn't a
 *  host/owner/repo URL (a bare local path, or an unparseable shape). NO NETWORKING — pure string parsing per
 *  the charter. Handles the scp-like (`git@host:owner/repo.git`), https, ssh://, and git:// shapes. */
export function parseRemoteOwner(
  remoteUrl: string | null,
): { host: string; owner: string; repo: string; knownForge: boolean } | null {
  const r = (remoteUrl ?? "").trim();
  if (!r) return null;
  // scp-like: git@github.com:Owner/Repo.git
  let m = /^[\w.-]+@([\w.-]+):([^/]+)\/(.+?)(?:\.git)?\/?$/.exec(r);
  // url forms: https://github.com/Owner/Repo.git · ssh://git@github.com/Owner/Repo · git://…
  if (!m) m = /^(?:https?|ssh|git):\/\/(?:[^@/]+@)?([\w.-]+)(?::\d+)?\/([^/]+)\/(.+?)(?:\.git)?\/?$/.exec(r);
  if (!m) return null;
  const [, host, owner, repo] = m;
  if (!host || !owner || !repo) return null;
  return { host, owner, repo, knownForge: KNOWN_FORGES.test(host) };
}

/**
 * The NORMALIZED remote key `host/owner/repo` (repo_owner_propagation.mdx §2) — the identity that lets one
 * member's (or one machine's) clone of a repo be matched to another's. SSH and HTTPS forms of the same remote
 * collapse to one key because both parse to the same host/owner/repo. Returns null when the remote has no
 * host/owner/repo (a bare local path, or an absent/unparseable remote). Case is PRESERVED for display;
 * callers compare case-insensitively (see {@link sameRemoteKey}).
 */
export function normalizeRemoteKey(remote: string | null): string | null {
  const p = parseRemoteOwner(remote);
  if (!p) return null;
  return `${p.host}/${p.owner}/${p.repo}`;
}

/** Case-insensitive equality of two normalized remote keys (SSH/HTTPS already collapsed by normalizeRemoteKey). */
export function sameRemoteKey(a: string | null, b: string | null): boolean {
  return !!a && !!b && a.toLowerCase() === b.toLowerCase();
}

/**
 * The repo's SHARED identity — a stable 12-hex hash of its LOWERCASED normalized remote key
 * (storage_company.mdx §8.4.1). `https://github.com/ACT3ai/charlie-kirk.git` and
 * `git@github.com:act3ai/charlie-kirk` both yield the same uid, on every computer.
 *
 * Returns **null** when the repo has no parseable remote. That is a real answer, not a fallback: a repo with
 * no remote has no identity the user's other computers could agree on, so it CANNOT mirror — and the product
 * says so rather than writing into a subtree nothing will ever read (§8.4.1).
 */
export function repoUidFor(remote: string | null): string | null {
  const key = normalizeRemoteKey(remote);
  if (!key) return null;
  return crypto.createHash("sha1").update(key.toLowerCase()).digest("hex").slice(0, 12);
}
