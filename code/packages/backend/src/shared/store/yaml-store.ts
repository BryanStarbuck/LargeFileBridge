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
  } catch {
    return schema.parse({}) as z.output<S>; // defaults-on-absence (our schemas are all objects)
  }
  let parsed: unknown;
  try {
    parsed = YAML.parse(raw) ?? {};
  } catch (e) {
    log.error("store", `YAML parse failed: ${file}: ${(e as Error).message}`);
    throw new Error(`Corrupt YAML at ${file}`);
  }
  const result = schema.safeParse(parsed);
  if (!result.success) {
    log.error("store", `Schema validation failed: ${file}: ${result.error.message}`);
    throw new Error(`Invalid schema at ${file}`);
  }
  return result.data;
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
