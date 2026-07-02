// Manifest read/write + the committed in-repo copy that git carries (storage.mdx §9.2).
import fs from "node:fs";
import path from "node:path";
import { ManifestSchema, type Manifest } from "@lfb/shared";
import { readYaml, writeYaml } from "../../shared/store/yaml-store.js";

/** The committed manifest lives in the repo working tree so `git pull` carries it. */
export function committedManifestPath(repoPath: string): string {
  return path.join(repoPath, ".lfbridge", "manifest.yaml");
}

export function readCommittedManifest(repoPath: string): Manifest {
  return readYaml(committedManifestPath(repoPath), ManifestSchema);
}

export function writeCommittedManifest(repoPath: string, manifest: Manifest): void {
  const dir = path.join(repoPath, ".lfbridge");
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {
    /* best effort */
  }
  writeYaml(committedManifestPath(repoPath), { ...manifest });
}
