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
import { resolveTrackingRoot } from "../storage/tracking-root.service.js";
import { trackingBaseDir } from "../storage/storage-type.service.js";
import { mirrorToSyncRepo } from "../storage/tracking-sync.service.js";
import { log } from "../../shared/logging.js";

/** The committed manifest for an SDL storage lives at the storage ROOT — `<root>/manifest.yaml` — because an
 *  SDL has NO `.lfbridge/` at all: `.lfbridge/` is a working-repo-only concept and the SDL root IS the
 *  tracking area (artifact_placement_policy.mdx §0, storage_company.mdx §1/§8.7). This used to hardcode
 *  `<root>/.lfbridge/manifest.yaml`, which violated that locked rule and left TWO divergent manifests in the
 *  same company storage. Routed through `trackingBaseDir()` so there is exactly one answer per storage kind.
 *  A plain repo storage does NOT use this — its manifest is Category-B tracking state in Local Storage
 *  (see {@link repoTrackingManifestPath}). */
export function committedManifestPath(repoPath: string): string {
  return path.join(trackingBaseDir(repoPath), "manifest.yaml");
}

/** A repo storage's manifest is Category-B tracking state: it lives in LOCAL STORAGE at
 *  `~/T/_large_files_bridge/repos/<repoKey>/manifest.yaml` (never the working repo, so it can't
 *  merge-conflict there), and travels via the company/Personal sync repo when configured
 *  (artifact_placement_policy.mdx §1.2). */
export function repoTrackingManifestPath(repoRoot: string): string {
  return path.join(resolveTrackingRoot(repoRoot), "manifest.yaml");
}

/** Where a conflicted/half-merged list is quarantined so we never parse it as truth (§5.1). */
function quarantinePathFor(file: string): string {
  return file.replace(/manifest\.yaml$/, "manifest.conflicted.yaml");
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
 *   caller from overwriting the previous good copy (the unit pin pass aborts and retains prior state).
 */
/** Read a manifest FROM A GIVEN FILE (shared by the SDL-committed and repo-tracking readers). Missing →
 *  schema defaults; merge-conflict markers → quarantine + refuse (§5.1). */
function readManifestFile(file: string): Manifest {
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
    // Quarantine the half-merged file, retain the previous good copy, and refuse (a sync-repo pull can also
    // produce markers — never load a half-merged list as valid).
    const quarantine = quarantinePathFor(file);
    try {
      fs.copyFileSync(file, quarantine);
    } catch (e) {
      log.warn("manifest", `quarantine copy failed: ${(e as Error).message}`);
    }
    log.error(
      "manifest",
      `${file}: git merge-conflict markers detected — REFUSING to load; quarantined to ${quarantine}`,
    );
    throw new Error(`Merge conflict in manifest at ${file} (quarantined, not loaded)`);
  }
  let parsed: unknown;
  try {
    parsed = YAML.parse(raw) ?? {};
  } catch (e) {
    log.error("manifest", `YAML parse failed: ${file}: ${(e as Error).message}`);
    throw new Error(`Corrupt manifest at ${file}`);
  }
  const result = ManifestSchema.safeParse(parsed);
  if (!result.success) {
    log.error("manifest", `Schema validation failed: ${file}: ${result.error.message}`);
    throw new Error(`Invalid manifest at ${file}`);
  }
  return result.data;
}

/** Write a manifest TO A GIVEN FILE DETERMINISTICALLY (repo__list_syns.mdx §6) and ATOMICALLY (§7 /
 *  storage.mdx §15) — sorted by `path`, stable key order, no volatile timestamp, so an unchanged list
 *  re-serializes byte-identically. */
function writeManifestFile(file: string, manifest: Manifest): void {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
  } catch {
    /* best effort */
  }
  const body = serializeDeterministic(manifest);
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

/** Read an SDL storage's committed manifest from its `.lfbridge/` (storage_personal.mdx §1). */
export function readCommittedManifest(repoPath: string): Manifest {
  return readManifestFile(committedManifestPath(repoPath));
}

/** Write an SDL storage's committed manifest into its `.lfbridge/` (that dedicated repo commits + pushes it). */
export function writeCommittedManifest(repoPath: string, manifest: Manifest): void {
  writeManifestFile(committedManifestPath(repoPath), manifest);
}

/** Read a repo storage's manifest from LOCAL STORAGE (`repos/<repoKey>/manifest.yaml`) — reconciled there
 *  from the sync repo when one is configured (artifact_placement_policy.mdx §1.2/§5). */
export function readRepoTrackingManifest(repoRoot: string): Manifest {
  return readManifestFile(repoTrackingManifestPath(repoRoot));
}

/** Write a repo storage's manifest to LOCAL STORAGE (never the working repo → no merge conflict), then
 *  additively mirror it to the company/Personal sync repo when configured (default off → no-op). */
export function writeRepoTrackingManifest(repoRoot: string, manifest: Manifest): void {
  writeManifestFile(repoTrackingManifestPath(repoRoot), manifest);
  mirrorToSyncRepo(repoRoot);
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
