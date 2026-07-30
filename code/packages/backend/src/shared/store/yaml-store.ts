// The store layer (storage.mdx §15): atomic write, per-file mutex, defaults-on-absence,
// schema-validate-on-read. All state I/O goes through this. Never touches disk elsewhere.
import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { z, type ZodTypeAny } from "zod";
import { log } from "../logging.js";
import { ensureDir } from "../../config/state-dir.js";
import { statOrNull } from "../fs-probe.js";

const mutexes = new Map<string, Promise<unknown>>();

// ── the parsed-document cache ────────────────────────────────────────────────
//
// EVERY state read in the app funnels through `readYaml`, and the same files are re-read constantly:
// building the repos list re-parses each of ~185 repos' unit YAML on every request. A JIT-resolved CPU
// profile of `GET /api/repos` attributed **~40% of the whole request to `readYaml` → YAML.parse**
// (parseDocument/compose/lex), with the filesystem itself a rounding error. Parsing the same unchanged
// bytes over and over is pure waste, and it also drove the GC churn that showed up alongside it.
//
// What is cached is the RAW parsed document (post-`YAML.parse`, PRE-schema). Validation still runs on
// every call, so:
//   * callers keep getting a FRESH zod output object and can mutate it freely — a read-modify-write
//     (`updateYaml`) can never corrupt what the next reader sees, which caching the validated result
//     would have allowed;
//   * schema changes, the empty-block repair, and every error path behave exactly as before.
//
// Freshness is the file's IDENTITY — inode + size + mtime — the same technique `getAppConfig` uses for
// config.yaml and `readStorageIndex` uses for its row cache. Any write through this module also drops
// the entry explicitly, so a same-millisecond rewrite of identical length cannot serve a stale document.
const RAW_CACHE_MAX = 4096;
const rawCache = new Map<string, { ino: number; size: number; mtimeMs: number; raw: unknown }>();

/** Forget the cached parse of `file` (or the whole cache). Called on every write through this module. */
export function invalidateYamlCache(file?: string): void {
  if (file === undefined) rawCache.clear();
  else rawCache.delete(file);
}

/** Serialize read-modify-write per absolute file path (storage.mdx §15). */
async function withLock<T>(file: string, fn: () => Promise<T>): Promise<T> {
  const prev = mutexes.get(file) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  mutexes.set(
    file,
    prev.then(() => gate),
  );
  await prev.catch(() => {});
  try {
    return await fn();
  } finally {
    release();
    if (mutexes.get(file) === undefined) mutexes.delete(file);
  }
}

/**
 * Read a YAML file, validate against `schema`, and return the parsed value.
 * Missing file -> schema defaults (NOT an error, no write, no log spam).
 * Malformed file -> logged loudly and rethrown (storage.mdx §15: never silently trust).
 */
export function readYaml<S extends ZodTypeAny>(file: string, schema: S): z.output<S> {
  // Identity probe first (non-throwing). On a hit this replaces the read AND the parse; on a miss it is
  // one extra cheap stat. See the rawCache note above for why only the PRE-schema document is cached.
  const st = statOrNull(file);
  let parsed: unknown;
  const hit = st ? rawCache.get(file) : undefined;
  if (st && hit && hit.ino === st.ino && hit.size === st.size && hit.mtimeMs === st.mtimeMs) {
    parsed = hit.raw;
  } else {
    let raw: string;
    try {
      raw = fs.readFileSync(file, "utf8");
    } catch (e) {
      // A missing file is the normal defaults-on-absence path; but a permission/I/O error would
      // silently mask real state (and let a later write clobber it), so surface anything but ENOENT.
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") {
        log.warn("store", `read failed (using defaults): ${file}: ${(e as Error).message}`);
      }
      rawCache.delete(file);
      return schema.parse({}) as z.output<S>; // defaults-on-absence (our schemas are all objects)
    }
    try {
      parsed = YAML.parse(raw) ?? {};
    } catch (e) {
      rawCache.delete(file);
      log.error("store", `YAML parse failed: ${file}: ${(e as Error).message}`);
      throw new Error(`Corrupt YAML at ${file}`);
    }
    // Only cache when the stat SUCCEEDED — without an identity we have no way to notice a later change.
    if (st) {
      if (rawCache.size >= RAW_CACHE_MAX) {
        const oldest = rawCache.keys().next().value; // insertion order = eviction order
        if (oldest !== undefined) rawCache.delete(oldest);
      }
      rawCache.set(file, { ino: st.ino, size: st.size, mtimeMs: st.mtimeMs, raw: parsed });
    }
  }
  let result = schema.safeParse(parsed);
  if (!result.success) {
    // THE EMPTY-BLOCK REPAIR (see `dropEmptyBlocks`). An untouched-but-valueless YAML block — `sync_repo:`
    // with nothing indented under it — parses as `null`, which every `z.object(...).prefault({})` in our
    // schemas rejects with "expected object, received null". That is never a real state: it means the block's
    // last child line was removed (a migration, a hand edit) and the parent was left behind. Treat it as
    // ABSENT, which is exactly what `.prefault({})` is there for, and re-parse ONCE.
    const repaired = dropEmptyBlocks(parsed, result.error);
    if (repaired !== null) {
      const retry = schema.safeParse(repaired);
      if (retry.success) {
        log.warn(
          "store",
          `${file}: empty YAML block(s) read as null — using schema defaults for them. ` +
            `The file is rewritten in its normal shape on the next update.`,
        );
        return retry.data;
      }
      result = retry; // report the retry's error — it is the honest remaining problem
    }
    log.error("store", `Schema validation failed: ${file}: ${result.error.message}`);
    throw new Error(`Invalid schema at ${file}`);
  }
  return result.data;
}

/**
 * Delete every path the schema rejected ONLY because an empty YAML block parsed as `null` where an object
 * was required, so a re-parse can apply that block's defaults.
 *
 * DELIBERATELY NARROW — this is a repair, not a bulldozer. It acts on exactly one issue shape
 * (`invalid_type`, expected `object`, got `null`) and it DELETES the key rather than substituting `{}`, so
 * the schema's own `.prefault`/`.default` decides what absence means. A field the schema declares
 * `.nullable()` never produces this issue, so a legitimate `null` (e.g. `owner_override: null`) is untouched.
 * Any other validation failure is left to fail loudly, as before.
 *
 * Returns a repaired shallow-cloned copy, or `null` when nothing matched (so the caller reports the original
 * error unchanged).
 *
 * The bug this exists for: a one-time migration stripped `enabled: false` from under `sync_repo:` in all 178
 * repo unit configs and left the bare parent key behind. Every repo unit then failed to load — no scan, no
 * To-Do recalc, no `reconcileMirroredRepos` — from ONE removed line. A store that cannot survive a valueless
 * block turns any future line-level migration into the same outage.
 */
function dropEmptyBlocks(input: unknown, error: z.ZodError): unknown | null {
  const targets = error.issues.filter(
    (i) =>
      i.code === "invalid_type" &&
      (i as { expected?: string }).expected === "object" &&
      i.path.length > 0 &&
      // zod 4 reports the received value's type in the message; read it off the INPUT instead, which is
      // authoritative and version-proof.
      valueAt(input, i.path) === null,
  );
  if (targets.length === 0) return null;

  const clone = structuredClone(input);
  for (const issue of targets) {
    const parent = issue.path.length === 1 ? clone : valueAt(clone, issue.path.slice(0, -1));
    const key = issue.path[issue.path.length - 1];
    if (parent && typeof parent === "object" && (typeof key === "string" || typeof key === "number")) {
      delete (parent as Record<string | number, unknown>)[key];
    }
  }
  return clone;
}

/** Read a value at a zod issue path, or `undefined` if any hop is missing. */
function valueAt(root: unknown, keyPath: readonly PropertyKey[]): unknown {
  let cur: unknown = root;
  for (const k of keyPath) {
    if (cur === null || typeof cur !== "object") return undefined;
    cur = (cur as Record<PropertyKey, unknown>)[k];
  }
  return cur;
}

/** Atomic write: serialize -> unique tmp -> fsync -> rename (storage.mdx §15). */
export function writeYaml<T extends Record<string, unknown>>(file: string, value: T): void {
  ensureDir(path.dirname(file));
  const stamped = { ...value, updated_at: new Date().toISOString() };
  const body = YAML.stringify(stamped);
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  try {
    const fd = fs.openSync(tmp, "w");
    fs.writeSync(fd, body);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fs.renameSync(tmp, file);
    // The bytes changed — drop the cached parse so a same-millisecond, same-length rewrite can never be
    // served stale by the identity check.
    invalidateYamlCache(file);
  } catch (e) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* ignore cleanup failure */
    }
    invalidateYamlCache(file);
    log.error("store", `Write failed: ${file}: ${(e as Error).message}`);
    throw e;
  }
}

/**
 * Atomic write, but ONLY when the document actually changed — `updated_at` excluded from the comparison.
 *
 * WHY THIS EXISTS (the 2026-07-29 backbone-churn bug). `writeYaml` stamps `updated_at: now` on every call,
 * so a file rewritten with identical content is still byte-different, and anything watching the working
 * tree sees a change. `writeSelfDevice` runs on EVERY device pass (10 min), EVERY pin pass (15 min) and
 * every artifact sync, for EVERY storage — so each cycle produced a commit whose entire diff was one
 * timestamp line:
 *
 *     -updated_at: 2026-07-29T14:15:25.865Z
 *     +updated_at: 2026-07-29T14:15:30.942Z
 *
 * With the same company remote cloned twice on one machine (both clones writing the SAME
 * `devices/<self>.yaml`), every cycle produced two divergent commits touching the same line — so every
 * cycle ended in a merge conflict, a non-fast-forward push, three retries and "giving up this cycle".
 * That is the "sometimes it just doesn't pull/push" the user reported: the schedule fired perfectly, the
 * churn it generated is what kept losing the race.
 *
 * A timestamp is not a change. Skipping the write when nothing else moved means no commit, nothing to
 * push, and no race — the cycle's pull still runs every time, unchanged.
 *
 * THE COMPARISON MUST BE CANONICAL (the 2026-07-29 follow-up defect). The first cut of this guard compared
 * `YAML.stringify(rawDiskDoc)` against `YAML.stringify(schemaParsedValue)` — two documents that are never
 * textually equal even when they mean the same thing, because:
 *   • KEY ORDER differs. The disk file carries the order it was last written in; a zod-parsed object carries
 *     the order the *schema* declares. One reordered field defeats a string compare forever.
 *   • SCHEMA DEFAULTS are injected on read but absent from an older file on disk (`home_user: ""`,
 *     `ip_addresses: []`), so `readYaml` → compare → write oscillated on every single pass.
 * Both sides are therefore normalized the same way — deep key-sorted, volatile paths removed — before they
 * are compared. Measured on the live personal repo: 58 of the last 60 device commits were a lone
 * `updated_at` line that this guard, once it actually fires, deletes entirely.
 *
 * VOLATILE PATHS beyond `updated_at` may be declared per call (dotted, e.g. `device.hardware.ip_addresses`).
 * A field is volatile when it changes on its own without the user doing anything — a heartbeat, a counter, a
 * DHCP lease, the transient `fe80::` link-local addresses a laptop grows and drops as interfaces come and go.
 * Such a field is still WRITTEN (it rides along on the next substantive write, so it is never stale for
 * long); it just never gets a vote on whether a write — and therefore a commit, and therefore a push — is
 * worth making. See git_backbone.mdx §6.6.
 *
 * Returns true when it wrote, false when the on-disk document was already equivalent.
 */
export function writeYamlIfChanged<T extends Record<string, unknown>>(
  file: string,
  value: T,
  opts?: { volatile?: readonly string[] },
): boolean {
  const volatilePaths = ["updated_at", ...(opts?.volatile ?? [])];
  try {
    const existing = YAML.parse(fs.readFileSync(file, "utf8")) ?? {};
    if (canonicalize(existing, volatilePaths) === canonicalize(value, volatilePaths)) return false;
  } catch {
    // Missing / unreadable / unparseable — fall through and write, which is also the repair.
  }
  writeYaml(file, value);
  return true;
}

/**
 * A document's MEANING as a comparable string: volatile paths dropped, object keys deep-sorted, `undefined`
 * normalized away (YAML omits an undefined value, so a key set to undefined must compare equal to a key that
 * is simply absent — otherwise the overlay in `writeSelfDevice` alone would force a write every pass).
 * Array ORDER is preserved: for a list, order can be meaning.
 */
export function canonicalize(doc: unknown, volatilePaths: readonly string[]): string {
  const drop = new Set(volatilePaths);
  const walk = (node: unknown, trail: string): unknown => {
    if (Array.isArray(node)) return node.map((v, i) => walk(v, trail ? `${trail}.${i}` : String(i)));
    if (node === null || typeof node !== "object") return node;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(node as Record<string, unknown>).sort()) {
      const here = trail ? `${trail}.${key}` : key;
      if (drop.has(here)) continue;
      const v = (node as Record<string, unknown>)[key];
      if (v === undefined) continue; // absent and undefined mean the same thing once serialized
      out[key] = walk(v, here);
    }
    return out;
  };
  return JSON.stringify(walk(doc ?? {}, ""));
}

/** Read-modify-write under the per-file mutex. */
export async function updateYaml<S extends ZodTypeAny>(
  file: string,
  schema: S,
  mutate: (current: z.output<S>) => z.output<S>,
): Promise<z.output<S>> {
  return withLock(file, async () => {
    const current = readYaml(file, schema);
    const next = mutate(current);
    writeYaml(file, next as Record<string, unknown>);
    return next;
  });
}

export function fileExists(file: string): boolean {
  try {
    return fs.existsSync(file);
  } catch {
    return false;
  }
}
