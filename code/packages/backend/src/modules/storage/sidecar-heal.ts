// Heal a `\`-named tracking file AS IT CROSSES the wire (repo__list_syns.mdx §6.1b). A LEAF module —
// node + yaml only — so both the continuous copy paths (tracking-sync's mirror and reconcile) and the
// one-time boot migration share ONE implementation.
//
// WHY A CONTINUOUS HEAL AND NOT JUST THE MIGRATION. The migration is marker-guarded and runs once. The
// mirror is additive and runs every cycle, so a peer still on an old build re-creates `files/jfk\training\
// clip.mp4.yaml` in the shared sync repo and pushes it; this computer's next reconcile copies it straight
// back into Local Storage, and its next mirror pushes it out again. Measured on the live repo: the stray
// sidecars were deleted at 14:23, a peer's commit re-added them at 15:36, and the reconcile had them back
// on disk by 15:38 — a bounce that repeats forever while ANY computer runs the old build.
//
// Healing at the copy boundary turns that loop one-way: the bad name is normalized on arrival, so it is
// never on this disk and never re-mirrored. A peer can keep sending it; it stops here.
import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { log } from "../../shared/logging.js";

/** True when this entry NAME is really a whole relative path that lost its separators. */
export function isStrayPathName(name: string): boolean {
  return name.includes("\\");
}

/** Where `name` should have landed: `a\b\c.yaml` under `dst` → `dst/a/b/c.yaml`. */
export function healedTarget(dst: string, name: string): string {
  return path.join(dst, ...name.split("\\"));
}

/**
 * Copy `src` (a file whose NAME carries `\`) to the path that name describes under `dst`.
 *
 * A collision is REPAIRABLE for a sidecar rather than a refusal: its `events:` list is append-only
 * (repo_tracking_scheme.mdx §3.2), so the two spellings are two halves of ONE history — union them and keep
 * the correctly-spelled file's identity fields (the stray's `path`/`name` ARE the corruption, and its
 * `size` is null). Any other colliding file is left alone; we never overwrite bytes we cannot merge.
 *
 * Returns true when the stray was fully absorbed (so the caller may delete the source).
 */
export function copyHealed(src: string, dst: string, name: string): boolean {
  const target = healedTarget(dst, name);
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    if (!fs.existsSync(target)) {
      fs.copyFileSync(src, target);
      log.info("storage", `path heal: ${name} -> ${path.relative(dst, target)}`);
      return true;
    }
    if (!name.endsWith(".yaml")) return false; // not a shape we know how to merge — leave both
    return mergeSidecarFiles(src, target);
  } catch (e) {
    log.warn("storage", `path heal failed for ${src}: ${(e as Error).message}`);
    return false;
  }
}

/**
 * Union the stray sidecar's events into the correctly-spelled one and rewrite it. Does NOT delete the
 * stray — the caller owns that, because "is the source mine to remove?" differs between a copy (no) and
 * the on-disk migration (yes). Returns true when the merge landed.
 */
export function mergeSidecarFiles(strayFile: string, keepFile: string): boolean {
  try {
    const stray = readYamlDoc(strayFile);
    const keep = readYamlDoc(keepFile);
    const keepBlock = keep?.file as Record<string, unknown> | undefined;
    if (!keep || !keepBlock) return false; // unreadable survivor → leave both, lose nothing
    const merged = new Map<string, unknown>();
    for (const ev of [...eventsOf(keepBlock), ...eventsOf(stray?.file as Record<string, unknown>)]) {
      const r = ev as Record<string, unknown>;
      // Identity = when + what + where. Two computers can collide on all three only by coincidence.
      merged.set(`${String(r.at)}|${String(r.kind)}|${String(r.on_device)}`, ev);
    }
    const before = eventsOf(keepBlock).length;
    keepBlock.events = [...merged.values()].sort((a, b) =>
      String((a as Record<string, unknown>).at).localeCompare(String((b as Record<string, unknown>).at)),
    );
    if (merged.size === before) return true; // nothing new — already absorbed, don't rewrite the file
    writeYamlDoc(keepFile, keep);
    log.info("storage", `path heal: merged ${path.basename(strayFile)} (${merged.size} event(s) kept)`);
    return true;
  } catch (e) {
    log.warn("storage", `path heal: sidecar merge failed for ${strayFile}: ${(e as Error).message}`);
    return false;
  }
}

function eventsOf(fileBlock: Record<string, unknown> | undefined): unknown[] {
  return Array.isArray(fileBlock?.events) ? (fileBlock.events as unknown[]) : [];
}

export function readYamlDoc(file: string): Record<string, unknown> | null {
  try {
    const doc = YAML.parse(fs.readFileSync(file, "utf8"));
    return doc && typeof doc === "object" ? (doc as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** Atomic write (temp → fsync → rename), the same contract every other tracking writer uses. */
export function writeYamlDoc(file: string, doc: unknown): void {
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  const fd = fs.openSync(tmp, "w");
  try {
    fs.writeSync(fd, YAML.stringify(doc, { sortMapEntries: true }));
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, file);
}
