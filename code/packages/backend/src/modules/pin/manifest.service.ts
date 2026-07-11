// Manifest read/write + the committed in-repo copy that git carries (storage.mdx §9.2,
// repo__list_syns.mdx). This file is TRACKED BY GIT and merged line-by-line on `git pull`, so it is
// NOT written through the state-store `writeYaml` (which stamps a volatile `updated_at`). Instead it is
// serialized DETERMINISTICALLY — files sorted by `path`, stable key order, no volatile timestamp — so
// re-serializing an unchanged list is byte-identical (no noise commits) and two computers editing
// DIFFERENT files never collide (repo__list_syns.mdx §6). On read it detects git merge-conflict markers
// and REFUSES to load a half-merged file (repo__list_syns.mdx §5.1).
import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { ManifestSchema, type Manifest, type ManifestFile } from "@lfb/shared";
import { log } from "../../shared/logging.js";

/** The committed manifest lives in the repo working tree so `git pull` carries it. */
export function committedManifestPath(repoPath: string): string {
  return path.join(repoPath, ".lfbridge", "manifest.yaml");
}

/** Where a conflicted/half-merged committed list is quarantined so we never parse it as truth (§5.1). */
function quarantinePath(repoPath: string): string {
  return path.join(repoPath, ".lfbridge", "manifest.conflicted.yaml");
}

/** True if the raw file text carries git merge-conflict markers (repo__list_syns.mdx §5.1). */
function hasConflictMarkers(raw: string): boolean {
  return /^(<{7}|={7}|>{7})(\s|$)/m.test(raw);
}

/**
 * Read the committed in-repo list a `git pull` delivered (repo__list_syns.mdx §4).
 * Missing file -> schema defaults (defaults-on-absence, storage.mdx §15).
 * Merge-conflict markers -> QUARANTINE the half-merged file and REFUSE to load it (§5.1): never parse a
 *   half-merged file as if it were valid — even if it parsed it would be a lie. Throwing here keeps the
 *   caller from overwriting the previous good copy (the unit sync aborts and retains prior state).
 */
export function readCommittedManifest(repoPath: string): Manifest {
  const file = committedManifestPath(repoPath);
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") {
      log.warn("manifest", `read failed (using defaults): ${file}: ${(e as Error).message}`);
    }
    return ManifestSchema.parse({}); // defaults-on-absence
  }
  if (hasConflictMarkers(raw)) {
    // Quarantine the half-merged file, retain the previous good copy, and refuse (hub §5.3 reconciliation
    // resolves the two sides later; we must NEVER load a half-merged list as valid).
    try {
      fs.copyFileSync(file, quarantinePath(repoPath));
    } catch (e) {
      log.warn("manifest", `quarantine copy failed: ${(e as Error).message}`);
    }
    log.error(
      "manifest",
      `${file}: git merge-conflict markers detected — REFUSING to load; quarantined to ${quarantinePath(repoPath)}`,
    );
    throw new Error(`Merge conflict in committed manifest at ${file} (quarantined, not loaded)`);
  }
  let parsed: unknown;
  try {
    parsed = YAML.parse(raw) ?? {};
  } catch (e) {
    log.error("manifest", `YAML parse failed: ${file}: ${(e as Error).message}`);
    throw new Error(`Corrupt committed manifest at ${file}`);
  }
  const result = ManifestSchema.safeParse(parsed);
  if (!result.success) {
    log.error("manifest", `Schema validation failed: ${file}: ${result.error.message}`);
    throw new Error(`Invalid committed manifest at ${file}`);
  }
  return result.data;
}

/**
 * Write the committed in-repo manifest DETERMINISTICALLY (repo__list_syns.mdx §6) and ATOMICALLY (§7 /
 * storage.mdx §15). Files are sorted by `path` with a stable key order and NO volatile timestamp, so an
 * unchanged list re-serializes byte-identically (no git noise) and independent edits on two machines
 * touch different regions and merge cleanly.
 */
export function writeCommittedManifest(repoPath: string, manifest: Manifest): void {
  const dir = path.join(repoPath, ".lfbridge");
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {
    /* best effort */
  }
  const body = serializeDeterministic(manifest);
  const file = committedManifestPath(repoPath);
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  try {
    const fd = fs.openSync(tmp, "w");
    fs.writeSync(fd, body);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fs.renameSync(tmp, file);
  } catch (e) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* ignore cleanup failure */
    }
    log.error("manifest", `Write failed: ${file}: ${(e as Error).message}`);
    throw e;
  }
}

/**
 * Canonical, byte-stable YAML for the committed list (repo__list_syns.mdx §6):
 *   • file entries sorted by `path` (a stable total order),
 *   • stable key order within every mapping (path, cid, size, sha256, modified_at, pinned_by),
 *   • `pinned_by` sorted so peer-order churn never diffs,
 *   • NO volatile timestamp (`generated_at`/`updated_at` omitted) so an unchanged list is byte-identical.
 */
function serializeDeterministic(manifest: Manifest): string {
  const files = [...manifest.files]
    .sort((a, b) => a.path.localeCompare(b.path))
    .map((f: ManifestFile) => ({
      path: f.path,
      cid: f.cid,
      size: f.size,
      sha256: f.sha256,
      modified_at: f.modified_at,
      pinned_by: [...f.pinned_by].sort((a, b) => a.localeCompare(b)),
    }));
  const canonical = {
    schema_version: manifest.schema_version,
    unit: manifest.unit,
    files,
  };
  return YAML.stringify(canonical);
}
