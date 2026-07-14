// Leaf-safe storage-type resolution (no imports from storage.service, so tracking.service can use it without
// an import cycle — storage.service already imports tracking.service). It answers ONE question the Category-B
// placement needs: is a given root a WORKING repo, or a dedicated LFB SDL storage (personal/company/community)?
//
// WHY it matters for `files.yaml` (and the rest of Category-B): the split is by storage KIND
// (artifact_placement_policy.mdx / storages.mdx §4.1):
//   • A WORKING repo (a user's code/media repo — type "repo") must NOT carry LFB's noisy tracking state; its
//     fingerprint index lives in Local Storage at ~/T/_large_files_bridge/repos/<repoKey>/files.yaml, never in
//     the repo's own `.lfbridge/` (the merge-conflict-every-scan failure this fixes; the user's absolute rule
//     that a working repo's `.lfbridge/` exists ONLY for transcripts / AI descriptions).
//   • A dedicated SDL storage (personal / company / community) is a purpose-built LFB git repo whose committed
//     `.lfbridge/` is MEANT to travel — its `files.yaml`/`manifest.yaml` belong there so teammates and the
//     user's other computers share the index (storage_personal.mdx §1, storage_company.mdx §1). Committing
//     per-scan churn to a repo that exists only for that is the intended behavior.
import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import type { StorageType } from "@lfb/shared";

const STORAGE_YAML = "storage.yaml";
const LFBRIDGE_DIR = ".lfbridge";
const CONVENTION_SUFFIX = "_large_files_bridge";

/** Resolve a root's storage type WITHOUT importing storage.service (leaf-safe). Mirrors the classification
 *  storage.service uses: an explicit descriptor `type` wins; else the `<name>_large_files_bridge` naming
 *  convention names an SDL; else it is a plain working `repo` (the safe default — an unclassified root is far
 *  more likely a stray working directory than a mis-detected SDL, and "repo" routes tracking OFF the working
 *  tree, which is the conservative choice for the absolute rule). */
export function resolveStorageType(root: string): StorageType {
  for (const p of [path.join(root, STORAGE_YAML), path.join(root, LFBRIDGE_DIR, STORAGE_YAML)]) {
    try {
      const raw = YAML.parse(fs.readFileSync(p, "utf8")) as { type?: StorageType } | null;
      if (raw?.type) return raw.type;
    } catch {
      /* not present / unreadable → keep probing, then fall through to convention */
    }
  }
  const base = path.basename(root);
  if (base === `personal${CONVENTION_SUFFIX}`) return "personal";
  if (base.endsWith(CONVENTION_SUFFIX)) return "company";
  return "repo";
}

/** True when this storage's Category-B tracking (the `files.yaml` fingerprint index, etc.) belongs in LOCAL
 *  STORAGE rather than the storage's own committed `.lfbridge/` — i.e. it is a working `repo`. A personal /
 *  company / community SDL commits its index into `.lfbridge/` so it travels, so this is false for those. */
export function tracksIndexInLocalStorage(type: StorageType): boolean {
  return type === "repo";
}
