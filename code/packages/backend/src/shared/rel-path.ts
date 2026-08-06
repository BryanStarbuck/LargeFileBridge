// THE ONE VOCABULARY for unit-relative paths (repo__list_syns.mdx §6.1). A LEAF module — no imports
// beyond node:path — so every producer, consumer and heal in the app can share it without a cycle.
//
// Three separate operations that are easy to confuse, and confusing them is exactly the 2026-08-04 defect:
//
//   relPosix()  PRODUCE a stored key from an absolute path. SEPARATOR-AWARE: it splits on `path.sep`, so a
//               Windows `a\b.mp4` becomes `a/b.mp4` while a POSIX file whose NAME genuinely contains a
//               backslash keeps it. Every repo-relative path we persist or send is built this way.
//
//   joinRel()   CONSUME a stored key back into this computer's absolute path. Splits the POSIX key on `/`
//               and re-joins natively, so `a/b.mp4` lands at `a\b.mp4` on Windows and `a/b.mp4` here.
//
//   healWindowsPath()  REPAIR a key that a PEER (or an older build of ours) already wrote with `\`. This one
//               is character-blind — it cannot tell a separator from a filename character — so it belongs
//               ONLY on the read path of shared/wire state (manifests, ledgers, decision maps), never on a
//               path just derived from this computer's own filesystem. On POSIX a `\` in a real filename is
//               legal; we accept losing that spelling because a separator-ambiguous key is unusable as a
//               cross-computer join key, and Windows cannot represent such a name at all.
import path from "node:path";

/** PRODUCE: `abs` as a unit-relative POSIX key. The only way a stored relative path should be built. */
export function relPosix(root: string, abs: string): string {
  return toPosixRel(path.relative(root, abs));
}

/** PRODUCE: an already-relative native path as a POSIX key (separator-aware — see the header). */
export function toPosixRel(rel: string): string {
  return path.sep === "/" ? rel : rel.split(path.sep).join("/");
}

/** CONSUME: a POSIX key as this computer's absolute path. */
export function joinRel(root: string, rel: string): string {
  return path.join(root, ...rel.split("/"));
}

/**
 * CONSUME **with confinement**: {@link joinRel}, but **null** when the key does not land inside `root`.
 *
 * Manifest keys are not this computer's own data. They arrive from the user's other computers — and, on a
 * company storage, from teammates — through a file that is merged by git and folded by us, so a `..`
 * segment, an absolute path or a drive letter can reach us from a corrupted merge as easily as from anyone
 * acting badly. The byte-placement path (`pin.service` fetch-missing / `pullMissing` → `ipfs.catToFile`)
 * does `mkdirSync(dirname)` and then writes, so an unconfined key writes anywhere the app can reach.
 *
 * Every request-facing filesystem route is already confined (`assertAllowedPath`, fs/allow-root.ts). This is
 * the same guarantee for the path that actually materializes bytes, and it belongs in this leaf because it
 * is the same "consume a stored key" operation `joinRel` performs — just with the check that makes it safe.
 *
 * NOT for the COMPUTER unit, whose keys are absolute BY DESIGN (`resolveAbs` is home-expand identity).
 */
export function joinRelConfined(root: string, rel: string): string | null {
  // An absolute key can never be unit-relative — POSIX (`/x`), UNC (`\\host\share`) or a drive (`C:\x`).
  if (path.isAbsolute(rel) || /^[A-Za-z]:[\\/]/.test(rel) || rel.startsWith("\\\\")) return null;
  const base = path.resolve(root);
  const abs = path.resolve(joinRel(base, rel));
  if (abs === base) return null; // the root itself is not a file inside it
  return abs.startsWith(base.endsWith(path.sep) ? base : base + path.sep) ? abs : null;
}

/** REPAIR: a `\`-spelled key from a Windows peer or an older build. Character-blind — read path only. */
export function healWindowsPath(p: string): string {
  return p.includes("\\") ? p.replace(/\\/g, "/") : p;
}

/** True when `p` carries a `\` — i.e. it needs {@link healWindowsPath} (or IS a stray literal-`\` name). */
export function hasWindowsSeparator(p: string): boolean {
  return p.includes("\\");
}

/**
 * REPAIR a whole `{ relPath: value }` map, folding a `\` and a `/` spelling of the same file into one entry.
 * `prefer` decides the survivor when both spellings carry a value (default: the existing `/` entry wins,
 * which is what "the local, already-correct record beats the imported one" means for a decisions map).
 * Returns the input untouched when nothing carries a `\`, so the caller pays nothing on the normal path.
 */
export function healPathKeyedMap<T>(
  map: Record<string, T>,
  prefer?: (posixEntry: T, windowsEntry: T) => T,
): Record<string, T> {
  const keys = Object.keys(map);
  if (!keys.some(hasWindowsSeparator)) return map;
  const out: Record<string, T> = {};
  // The `\`-spelled entries land first so an already-POSIX key — this computer's own, authoritative
  // spelling — always gets the last word (or the `prefer` vote) when both spellings exist.
  for (const k of keys) {
    if (!hasWindowsSeparator(k)) continue;
    const key = healWindowsPath(k);
    if (!(key in out)) out[key] = map[k]!;
  }
  for (const k of keys) {
    if (hasWindowsSeparator(k)) continue;
    out[k] = k in out && prefer ? prefer(map[k]!, out[k]!) : map[k]!;
  }
  return out;
}
