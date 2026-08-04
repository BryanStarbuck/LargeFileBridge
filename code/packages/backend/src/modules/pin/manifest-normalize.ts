// LEAF module (no intra-app imports beyond logging) so BOTH manifest readers — manifest.service.ts and
// tracking-sync.service.ts's best-effort mirror reader — share the one heal without an import cycle.
import type { Manifest, ManifestFile } from "@lfb/shared";
import { log } from "../../shared/logging.js";

/**
 * Manifest paths are POSIX (`/`) ON THE WIRE — always (repo__list_syns.mdx §6.1). A Windows peer that
 * built entries with `path.relative` recorded them with `\` separators, and on macOS/Linux those read as
 * literal filename characters: `fs.existsSync` never matches, the pull-down list never clears, and a pull
 * materializes a stray file literally named `jfk\training\...` at the repo ROOT (the 2026-08-04 defect).
 * So EVERY manifest read normalizes `\` → `/` and FOLDS entries that then collide (a `\` and a `/`
 * spelling of the same file): keep the entry with a CID / newest modified_at, union the `pinned_by` claims.
 */
export function normalizeManifestPaths(manifest: Manifest, file: string): Manifest {
  if (!manifest.files.some((f) => f.path.includes("\\"))) return manifest;
  const byPath = new Map<string, ManifestFile>();
  for (const f of manifest.files) {
    const p = f.path.replace(/\\/g, "/");
    const prev = byPath.get(p);
    if (!prev) {
      byPath.set(p, { ...f, path: p });
      continue;
    }
    // Collision: the same file spelled both ways. Prefer the entry that knows more (has a CID; else the
    // newer modified_at) and union the pinned_by device claims so no peer's pin claim is dropped.
    const winner =
      (f.cid && !prev.cid) || (!!f.cid === !!prev.cid && (f.modified_at ?? "") > (prev.modified_at ?? ""))
        ? { ...f, path: p }
        : prev;
    winner.pinned_by = [...new Set([...prev.pinned_by, ...f.pinned_by])];
    byPath.set(p, winner);
  }
  log.info("manifest", `${file}: normalized Windows path separators (${manifest.files.length} -> ${byPath.size} entries)`);
  return { ...manifest, files: [...byPath.values()] };
}
