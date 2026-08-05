// One-time repair of the Windows-separator damage already on disk (repo__list_syns.mdx §6.1).
//
// The code now produces POSIX keys everywhere and heals `\` on every read, but a heal only hides the
// damage — it does not remove it, and two kinds of damage cannot be healed by a reader at all:
//
//   1. STATE FILES whose keys are `\`-spelled (`pin/r/<repo>/manifest.yaml`, `status.yaml`, the unit
//      config's `decisions:` map). A read-time heal fixes the value the app sees, but the file keeps
//      re-supplying the bad spelling to anything that reads it another way, and every duplicate entry is
//      still shipped to peers on the next mirror.
//   2. STRAY FILES the defect MATERIALIZED. `path.join(repoRoot, 'jfk\\training\\clip.mp4')` on macOS/Linux
//      writes ONE file at the repo root literally named `jfk\training\clip.mp4`. The bytes are real and
//      correct — they are the file the user pulled — but they are in the wrong place, they can never match
//      the manifest entry (so the pull-down row never clears), and git cannot check that name out on
//      Windows AT ALL, which breaks the clone for the very machine that wrote it. Same for the per-file
//      sidecars, which mirror the path into their own filename.
//
// So: rewrite the keys, and MOVE each stray file to the path its name was always describing.
//
// Contract (identical to its siblings):
//   * Runs ONCE at startup, guarded by a marker in the state root; re-running is a no-op.
//   * Best-effort and NEVER throws — a failed migration must never crash boot.
//   * NEVER destructive. A stray file is MOVED, never deleted, and only when its proper path is FREE; when
//     something already sits there the stray is left alone and the collision is logged. Nothing is
//     overwritten, so the worst case is that a file stays where the defect put it.
import fs from "node:fs";
import path from "node:path";
import { parse, stringify } from "yaml";
import { log } from "../shared/logging.js";
import { resolveHome } from "../shared/home-path.js";
import { hasWindowsSeparator, healWindowsPath } from "../shared/rel-path.js";
import { mergeSidecarFiles } from "../modules/storage/sidecar-heal.js";

const MARKER = ".posix-paths-repaired";

interface Repair {
  stateFiles: number;
  strayFiles: number;
  straySidecars: number;
  collisions: number;
}

export function migratePosixPaths(stateDir: string): void {
  try {
    const marker = path.join(stateDir, MARKER);
    if (fs.existsSync(marker)) return;

    const tally: Repair = { stateFiles: 0, strayFiles: 0, straySidecars: 0, collisions: 0 };
    const reposRoot = path.join(stateDir, "pin", "r");
    for (const folder of listDirs(reposRoot)) {
      const unitDir = path.join(reposRoot, folder);
      if (healUnitManifest(path.join(unitDir, "manifest.yaml"))) tally.stateFiles++;
      if (healPathKeyedBlock(path.join(unitDir, "status.yaml"), ["candidates", "orphans"])) tally.stateFiles++;
      if (healPathKeyedBlock(path.join(unitDir, "config.yaml"), ["decisions"])) tally.stateFiles++;
      relocateStraysForUnit(path.join(unitDir, "config.yaml"), tally);
    }
    // Category-B tracking state (`repos/<repoKey>/`): the per-file sidecars mirror the path INTO their
    // filename, so a `\` key produced a flat file that no `sidecarPath()` will ever look up again.
    for (const key of listDirs(path.join(stateDir, "repos"))) {
      const repoState = path.join(stateDir, "repos", key);
      relocateStraySidecars(path.join(repoState, "files"), tally);
      // …and the same repo's subtree in the company/Personal SYNC REPO. The mirror is an ADDITIVE copy
      // (tracking-sync `copyTree` never deletes), so a stray that is fixed here would otherwise live on in
      // the mirror forever — and that copy is COMMITTED, where a `\` in a filename makes `git checkout`
      // fail outright on Windows: the machine that caused the defect cannot clone the repo carrying it.
      const mirror = syncRepoSubtree(repoState);
      if (mirror) relocateStraySidecars(path.join(mirror, "files"), tally);
    }

    fs.writeFileSync(marker, new Date().toISOString(), "utf8");
    if (tally.stateFiles || tally.strayFiles || tally.straySidecars) {
      log.info(
        "migrate",
        `POSIX path repair: ${tally.stateFiles} state file(s) rewritten, ${tally.strayFiles} stray file(s) ` +
          `moved into place, ${tally.straySidecars} stray sidecar(s) moved` +
          (tally.collisions ? `, ${tally.collisions} left alone (target already exists)` : "") +
          ".",
      );
    }
  } catch (e) {
    log.warn("migrate", `POSIX path repair skipped: ${(e as Error).message}`);
  }
}

function listDirs(dir: string): string[] {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch {
    return [];
  }
}

/** Read + parse a YAML state file, or null when it is missing/unreadable/unparseable (never a throw). */
function readDoc(file: string): Record<string, unknown> | null {
  try {
    const doc = parse(fs.readFileSync(file, "utf8"));
    return doc && typeof doc === "object" ? (doc as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function writeDoc(file: string, doc: unknown): void {
  const tmp = `${file}.${process.pid}.tmp`;
  const fd = fs.openSync(tmp, "w");
  try {
    fs.writeSync(fd, stringify(doc));
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, file);
}

/**
 * Heal a unit manifest's `files[].path` in place, folding the two spellings of one file into a single entry
 * (the same rule `normalizeManifestPaths` applies on read: the entry that knows more wins, `pinned_by`
 * unions). The COMPUTER unit is skipped — its entries are absolute paths, where `C:\…` is legitimate.
 */
function healUnitManifest(file: string): boolean {
  const doc = readDoc(file);
  const files = doc?.files;
  if (!doc || doc.unit === "computer" || !Array.isArray(files)) return false;
  if (!files.some((f) => typeof f?.path === "string" && hasWindowsSeparator(f.path))) return false;

  const byPath = new Map<string, Record<string, unknown>>();
  for (const raw of files as Array<Record<string, unknown>>) {
    if (typeof raw?.path !== "string") continue;
    const p = healWindowsPath(raw.path);
    const prev = byPath.get(p);
    if (!prev) {
      byPath.set(p, { ...raw, path: p });
      continue;
    }
    const winner =
      (raw.cid && !prev.cid) ||
      (!!raw.cid === !!prev.cid && String(raw.modified_at ?? "") > String(prev.modified_at ?? ""))
        ? { ...raw, path: p }
        : prev;
    winner.pinned_by = [
      ...new Set([...toList(prev.pinned_by), ...toList(raw.pinned_by)]),
    ].sort((a, b) => a.localeCompare(b));
    byPath.set(p, winner);
  }
  doc.files = [...byPath.values()].sort((a, b) => String(a.path).localeCompare(String(b.path)));
  writeDoc(file, doc);
  return true;
}

function toList(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

/**
 * Heal the path KEYS of the named blocks in a state file. A block is either a map keyed by path
 * (`decisions`, `orphans`) or a list of `{ path }` records (`candidates`); both shapes appear in the unit
 * files. An already-POSIX key wins a collision — it is this computer's own spelling.
 */
function healPathKeyedBlock(file: string, blocks: string[]): boolean {
  const doc = readDoc(file);
  if (!doc) return false;
  let changed = false;
  for (const name of blocks) {
    const block = doc[name];
    if (Array.isArray(block)) {
      const rows = block as Array<Record<string, unknown>>;
      if (!rows.some((r) => typeof r?.path === "string" && hasWindowsSeparator(r.path))) continue;
      const seen = new Map<string, Record<string, unknown>>();
      for (const r of rows) {
        if (typeof r?.path !== "string") continue;
        const p = healWindowsPath(r.path);
        // A row that was ALREADY POSIX describes a file we really scanned — it wins.
        if (!seen.has(p) || !hasWindowsSeparator(r.path)) seen.set(p, { ...r, path: p });
      }
      doc[name] = [...seen.values()];
      changed = true;
    } else if (block && typeof block === "object") {
      const map = block as Record<string, unknown>;
      const keys = Object.keys(map);
      if (!keys.some(hasWindowsSeparator)) continue;
      const out: Record<string, unknown> = {};
      for (const k of keys) {
        if (!hasWindowsSeparator(k)) continue;
        const healed = healWindowsPath(k);
        if (!(healed in out)) out[healed] = map[k];
      }
      for (const k of keys) if (!hasWindowsSeparator(k)) out[k] = map[k];
      doc[name] = out;
      changed = true;
    }
  }
  if (changed) writeDoc(file, doc);
  return changed;
}

/**
 * Move the stray root files a pull materialized in this unit's working tree to the path their own name
 * describes. Only TOP-LEVEL entries are considered, because that is the only place the defect could put
 * one: the whole relative path became a single filename, so it landed exactly one level under the root.
 */
function relocateStraysForUnit(configFile: string, tally: Repair): void {
  const doc = readDoc(configFile);
  const repoPath = (doc?.repo as Record<string, unknown> | undefined)?.path;
  if (typeof repoPath !== "string" || !repoPath) return;
  const root = resolveHome(repoPath);
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return; // repo not mounted / not here right now — the marker is not written until the whole pass ends
  }
  for (const e of entries) {
    if (!e.isFile() || !hasWindowsSeparator(e.name)) continue;
    if (relocate(path.join(root, e.name), path.join(root, ...e.name.split("\\")), tally)) tally.strayFiles++;
  }
}

/**
 * The same repair for the per-file sidecars, whose whole mirrored path lives inside ONE filename.
 *
 * Unlike a payload file, a collision here is REPAIRABLE rather than a refusal. A sidecar's `events:` list is
 * APPEND-ONLY by contract (repo_tracking_scheme.mdx §3.2), so two spellings of one file are not rivals — they
 * are two halves of the same history, split at the moment a peer wrote the `\` spelling. On the live repo
 * this was exact: the stray held one computer's `pull` + `ipfs_pin` for a CID, and the proper sidecar held
 * ANOTHER computer's for the same CID. Union the events, keep the correctly-spelled file's identity fields
 * (the stray's `path`/`name` are the corruption, and its `size` is null), and only then drop the stray —
 * nothing is lost, which is what makes the delete honest.
 */
function relocateStraySidecars(filesDir: string, tally: Repair): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(filesDir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (!e.isFile() || !hasWindowsSeparator(e.name)) continue;
    const from = path.join(filesDir, e.name);
    const to = path.join(filesDir, ...e.name.split("\\"));
    if (fs.existsSync(to) ? mergeSidecarInto(from, to) : relocate(from, to, tally)) tally.straySidecars++;
  }
}

/** Union the stray sidecar's events into the correctly-spelled one, then remove the stray. The merge
 *  itself is `sidecar-heal.ts` — ONE implementation shared with the continuous reconcile/mirror heal, so
 *  the two can never drift on what "same event" means. Only the delete is this migration's own call: on
 *  disk the stray IS ours to remove, whereas the copy paths do not own their source. */
function mergeSidecarInto(strayFile: string, keepFile: string): boolean {
  if (!mergeSidecarFiles(strayFile, keepFile)) return false;
  fs.rmSync(strayFile, { force: true });
  log.info("migrate", `POSIX path repair: merged ${strayFile} into ${keepFile}`);
  return true;
}

/** This repo's subtree in the company/Personal sync repo, from its `.sync-repo` marker (two lines: the
 *  sync-repo root, then the repo's machine-independent uid). Null when the repo does not mirror. */
function syncRepoSubtree(repoStateDir: string): string | null {
  try {
    const [root, uid] = fs.readFileSync(path.join(repoStateDir, ".sync-repo"), "utf8").split("\n");
    if (!root?.trim() || !uid?.trim()) return null;
    return path.join(root.trim(), "repos", uid.trim());
  } catch {
    return null;
  }
}

/** Move `from` to `to`, creating the hierarchy. Refuses when `to` exists — never overwrite real bytes. */
function relocate(from: string, to: string, tally: Repair): boolean {
  try {
    if (fs.existsSync(to)) {
      tally.collisions++;
      log.warn(
        "migrate",
        `POSIX path repair: leaving ${from} alone — ${to} already exists. Compare them and delete the ` +
          `stray copy by hand if it is a duplicate.`,
      );
      return false;
    }
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.renameSync(from, to);
    log.info("migrate", `POSIX path repair: moved ${from} -> ${to}`);
    return true;
  } catch (e) {
    // EXDEV (a different filesystem) or a permission problem: leave the file, keep the trail. The stray
    // still shows in the UI, which is better than a half-copied file.
    log.warn("migrate", `POSIX path repair: could not move ${from}: ${(e as Error).message}`);
    return false;
  }
}
