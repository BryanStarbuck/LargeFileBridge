// Filesystem confinement (security audit finding 2). Every filesystem path the API resolves — the
// column browser (fs.service), the flat large-file walk (fsindex), the media stream (media.service),
// and the single-entity view (entity.service) — is confined to an allow-listed set of roots. Without
// this, ANY allow-listed principal (and in server mode a whole DOMAIN can be allow-listed) could read
// EVERY file on the host: /etc, other users' homes, ~/.ssh, and this app's own OAuth client secret.
//
// The confinement is two-layer and fail-closed:
//   1. Allow-roots — a resolved path must sit under one of the allowed roots (the browse roots the
//      app is meant to serve: the home dir it opens on, the configured scanner roots, registered
//      repos, or an explicit LFB_BROWSE_ROOTS override). Everything outside is rejected.
//   2. Secret denylist — a small set of well-known secret stashes that live INSIDE the home root
//      (SSH keys, cloud creds, keychains, this app's ~/.credentials) is rejected even though it is
//      under an allowed root.
// Paths are canonicalized with realpath first, so a `..` sequence (already collapsed by path.resolve)
// or a symlink pointing outside an allowed root cannot escape the check.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getAppConfig } from "../store-model/config.service.js";
import { listRepoFolders, getRepoConfig } from "../store-model/units.service.js";
import { detectCloudRoots } from "./cloud-roots.js";

function expandHome(p: string): string {
  return p.replace(/^~(?=\/|$)/, os.homedir());
}

/**
 * Canonicalize `abs` with realpath so symlinks are resolved (an in-tree symlink to /etc resolves to
 * /etc and then fails the prefix check). For a path that does not yet exist (a move/delete
 * destination), realpath the nearest existing ancestor and re-append the missing tail — so the
 * confinement still applies to where the path WOULD live.
 */
function canonicalize(abs: string): string {
  let cur = abs;
  const missing: string[] = [];
  for (;;) {
    try {
      const real = fs.realpathSync.native(cur);
      return missing.length ? path.join(real, ...missing.reverse()) : real;
    } catch {
      const parent = path.dirname(cur);
      if (parent === cur) return abs; // reached the filesystem root without resolving — use as-is
      missing.push(path.basename(cur));
      cur = parent;
    }
  }
}

/** The raw (pre-canonicalization) set of roots browsing is permitted under. */
function rawRoots(): string[] {
  const env = (process.env.LFB_BROWSE_ROOTS || "")
    .split(/[:,]/)
    .map((s) => s.trim())
    .filter(Boolean);
  if (env.length) return env.map(expandHome);

  // Default: the home dir (the column browser opens on it), plus the configured scanner roots and any
  // registered repos (which may live on other volumes outside home).
  const roots = new Set<string>();
  roots.add(os.homedir());
  for (const r of getAppConfig().scanner.roots) roots.add(expandHome(r));
  for (const folder of listRepoFolders()) {
    const rc = getRepoConfig(folder);
    if (rc.repo.path) roots.add(expandHome(rc.repo.path));
  }
  // Cloud-storage mounts surfaced at the top of the home column (file_system.mdx §6). These live under
  // ~/Library/CloudStorage/ so they are already under the home root, but a mount that realpaths outside
  // home (a FileProvider firmlink, a relocated Drive) would otherwise fail confinement — add each
  // explicitly so browsing into a surfaced cloud root always resolves.
  for (const cr of detectCloudRoots()) roots.add(cr.path);
  return [...roots];
}

/** Canonicalized, existing-directory allow-roots. Falls back to the home dir if none resolve. */
export function allowedRoots(): string[] {
  const out: string[] = [];
  for (const r of rawRoots()) {
    try {
      const abs = canonicalize(path.resolve(r));
      if (fs.statSync(abs).isDirectory()) out.push(abs);
    } catch {
      /* skip a root that isn't a real directory */
    }
  }
  return out.length ? out : [canonicalize(os.homedir())];
}

// Secret stashes that live inside the home root but must never be served. Absolute-prefix matched.
function deniedPrefixes(): string[] {
  const home = os.homedir();
  return [
    path.join(home, ".ssh"),
    path.join(home, ".credentials"),
    path.join(home, ".aws"),
    path.join(home, ".gnupg"),
    path.join(home, ".config", "gcloud"),
    path.join(home, ".kube"),
    path.join(home, ".docker"),
    path.join(home, ".password-store"),
    path.join(home, "Library", "Keychains"),
  ];
}

// Sensitive directory names denied wherever they appear in a path (e.g. a nested repo's own .ssh).
const DENY_SEGMENTS = new Set([".ssh", ".gnupg", ".aws", ".credentials", ".password-store"]);

function isUnder(child: string, root: string): boolean {
  if (child === root) return true;
  const base = root.endsWith(path.sep) ? root : root + path.sep;
  return child.startsWith(base);
}

/**
 * Confine a resolved absolute path to the allow-roots (symlink-safe via realpath) and reject secret
 * stashes. Returns the canonicalized absolute path on success; throws "path not allowed" otherwise.
 * Callers should resolve/expand `~` first, then hand the absolute path here.
 */
export function assertAllowedPath(abs: string): string {
  const real = canonicalize(abs);
  if (!allowedRoots().some((r) => isUnder(real, r))) throw new Error("path not allowed");
  for (const seg of real.split(path.sep)) {
    if (DENY_SEGMENTS.has(seg)) throw new Error("path not allowed");
  }
  for (const d of deniedPrefixes()) {
    if (isUnder(real, d)) throw new Error("path not allowed");
  }
  return real;
}
