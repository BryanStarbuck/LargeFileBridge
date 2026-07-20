// The store layer (storage.mdx §15): atomic write, per-file mutex, defaults-on-absence,
// schema-validate-on-read. All state I/O goes through this. Never touches disk elsewhere.
import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { z, type ZodTypeAny } from "zod";
import { log } from "../logging.js";
import { ensureDir } from "../../config/state-dir.js";

const mutexes = new Map<string, Promise<unknown>>();

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
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch (e) {
    // A missing file is the normal defaults-on-absence path; but a permission/I/O error would
    // silently mask real state (and let a later write clobber it), so surface anything but ENOENT.
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") {
      log.warn("store", `read failed (using defaults): ${file}: ${(e as Error).message}`);
    }
    return schema.parse({}) as z.output<S>; // defaults-on-absence (our schemas are all objects)
  }
  let parsed: unknown;
  try {
    parsed = YAML.parse(raw) ?? {};
  } catch (e) {
    log.error("store", `YAML parse failed: ${file}: ${(e as Error).message}`);
    throw new Error(`Corrupt YAML at ${file}`);
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
  } catch (e) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* ignore cleanup failure */
    }
    log.error("store", `Write failed: ${file}: ${(e as Error).message}`);
    throw e;
  }
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
