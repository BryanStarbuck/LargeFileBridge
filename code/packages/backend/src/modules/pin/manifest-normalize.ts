// LEAF module (logging + the pure manifest-merge leaf, nothing else) so BOTH manifest readers —
// manifest.service.ts and tracking-sync.service.ts's best-effort mirror reader — share the one heal
// without an import cycle.
import type { Manifest } from "@lfb/shared";
import { log } from "../../shared/logging.js";
import { hasWindowsSeparator } from "../../shared/rel-path.js";
import { foldManifestFiles } from "../storage/manifest-merge.js";

/**
 * Manifest paths are POSIX (`/`) ON THE WIRE — always (repo__list_syns.mdx §6.1). A Windows peer that
 * built entries with `path.relative` recorded them with `\` separators, and on macOS/Linux those read as
 * literal filename characters: `fs.existsSync` never matches, the pull-down list never clears, and a pull
 * materializes a stray file literally named `jfk\training\...` at the repo ROOT (the 2026-08-04 defect).
 * So EVERY manifest read normalizes `\` → `/` and FOLDS entries that then collide (a `\` and a `/`
 * spelling of the same file): keep the entry with a CID / newest modified_at, union the `pinned_by` claims.
 *
 * THE FOLD RUNS UNCONDITIONALLY, not only when a `\` is present. `manifest.yaml` carries `merge=union`, so a
 * conflicting merge concatenates both sides and the file holds the SAME `/`-spelled path twice — 27 of the
 * 92 commits on the live `all` mirror did. Reading those with the old separator-gated fold handed callers a
 * list with duplicates, and every caller keyed it into a Map (last wins), which is where a peer's pin claim
 * quietly died. Folding on read is the only place that catches every reader at once.
 *
 * NOT the computer unit. Its entries are ABSOLUTE paths (pin.service `resolveAbs` is home-expand identity),
 * so `C:\Users\…` is a legitimate value there and healing it would destroy it. §6.1 is a statement about
 * REPO-RELATIVE keys; only repo and storage units have them.
 */
export function normalizeManifestPaths(manifest: Manifest, file: string): Manifest {
  const healed = manifest.unit !== "computer" && manifest.files.some((f) => hasWindowsSeparator(f.path));
  const files = foldManifestFiles(manifest.files, manifest.unit);
  if (!healed && files.length === manifest.files.length) return manifest;
  log.info(
    "manifest",
    `${file}: normalized (${manifest.files.length} -> ${files.length} entries` +
      `${healed ? "; Windows path separators healed" : ""})`,
  );
  return { ...manifest, files };
}
