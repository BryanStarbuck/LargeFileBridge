// Per-file `<name>.yaml` sidecars (repo_tracking_scheme.mdx §3) — one small YAML PER SPECIAL FILE, mirroring
// the file's repo-relative path under `.lfbridge/files/` (videos/trees.mov → .lfbridge/files/videos/
// trees.mov.yaml). HARD SCHEMA RULE: the ONLY level-one key is `file:`. Carries the file's identity plus an
// APPEND-ONLY `events:` history (observed / decision / ipfs_pin / compress / convert / transcribe / pull);
// events are never edited in place. Every event is stamped `at` (UTC), `on_device` (this computer's unique
// name), and `by` (the allow-listed email, or the sentinel `not-lfbridge` for actions done OUTSIDE us that
// a scan merely observed). Git-ignored WORKING artifact, gated on the keep-`.lfbridge/` consent, written
// deterministically + atomically (temp → fsync → rename) like the decision ledger.
import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import {
  FileSidecarSchema,
  FileEventSchema,
  type FileSidecar,
  type FileEvent,
  type PerceptualFingerprint,
} from "@lfb/shared";
import { LFBRIDGE_DIR } from "./tracking.service.js";
import { storageSid } from "./storage.service.js";
import { readStorageSettings } from "./storage-settings.service.js";
import { selfDeviceName } from "./devices.service.js";
import { log } from "../../shared/logging.js";

/** The sentinel `by` value for an action LFBridge did NOT do — a scan merely observed it (§3.3). */
export const NOT_LFBRIDGE = "not-lfbridge";

// ── paths + consent (same pattern as decisions.service.ts) ─────────────────────

function trackingDir(repoRoot: string): string {
  try {
    const relocated = readStorageSettings(storageSid(repoRoot)).lfbridge.path;
    if (relocated && relocated.trim()) return path.resolve(relocated);
  } catch {
    /* no per-storage settings yet → default location */
  }
  return path.join(repoRoot, LFBRIDGE_DIR);
}

function keepsLfbridge(repoRoot: string): boolean {
  try {
    return readStorageSettings(storageSid(repoRoot)).lfbridge.enabled;
  } catch {
    return true; // documented default: keep .lfbridge/
  }
}

/**
 * The sidecar path for a repo-relative file — mirrors the file's path under `.lfbridge/files/`, leaf is
 * `<name>.yaml` (repo_tracking_scheme.mdx §3). `videos/trees.mov` → `.lfbridge/files/videos/trees.mov.yaml`.
 * Honors a relocated `.lfbridge/`.
 */
export function sidecarPath(repoRoot: string, relPath: string): string {
  return path.join(trackingDir(repoRoot), "files", `${relPath}.yaml`);
}

// ── read / write ───────────────────────────────────────────────────────────────

/** Read a file's sidecar (missing/corrupt → null). */
export function readSidecar(repoRoot: string, relPath: string): FileSidecar | null {
  const file = sidecarPath(repoRoot, relPath);
  let parsed: unknown;
  try {
    parsed = YAML.parse(fs.readFileSync(file, "utf8")) ?? {};
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") {
      log.warn("storage", `sidecar read failed: ${file}: ${(e as Error).message}`);
    }
    return null;
  }
  const result = FileSidecarSchema.safeParse(parsed);
  if (!result.success) {
    log.warn("storage", `sidecar schema mismatch (ignoring): ${file}: ${result.error.message}`);
    return null;
  }
  return result.data;
}

function writeSidecar(repoRoot: string, relPath: string, doc: FileSidecar): void {
  const normalized = FileSidecarSchema.parse(doc); // fill defaults, enforce the single `file:` root key
  const file = sidecarPath(repoRoot, relPath);
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true }); // create the mirrored directory hierarchy
  } catch {
    /* best effort */
  }
  // sortMapEntries → stable key order; the events array keeps its append order (arrays aren't sorted).
  const body = YAML.stringify(normalized, { sortMapEntries: true });
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
      /* ignore */
    }
    log.error("storage", `sidecar write failed: ${file}: ${(e as Error).message}`);
    throw e;
  }
}

/**
 * The shape a caller appends — `kind` is required; `at`/`on_device`/`by` are stamped when omitted; any
 * kind-specific fields (ipfs / before / after / codec / format / output / note …) pass through the schema.
 */
export type FileEventInput = {
  kind: FileEvent["kind"];
  at?: string;
  on_device?: string;
  by?: string | null;
} & Record<string, unknown>;

/** Identity fields for seeding a sidecar the first time a file is seen as special (§3.1). */
export interface SidecarSeed {
  name?: string;
  categories?: string[];
  size?: number | null;
  created?: string;
  modified?: string;
  hash?: string | null;
  fingerprint?: PerceptualFingerprint | null;
  firstSeen?: { at?: string; on_device?: string };
}

/** Build a fresh sidecar doc (identity + empty events) — the create-on-first-special seed. */
function buildSeed(relPath: string, seed?: SidecarSeed): FileSidecar {
  return FileSidecarSchema.parse({
    file: {
      path: relPath,
      name: seed?.name ?? path.basename(relPath),
      categories: seed?.categories ?? [],
      size: seed?.size ?? null,
      created: seed?.created,
      modified: seed?.modified,
      hash: seed?.hash ?? null,
      fingerprint: seed?.fingerprint ?? null,
      first_seen: seed?.firstSeen ?? { at: new Date().toISOString(), on_device: selfDeviceName() },
      events: [],
    },
  });
}

/**
 * Create-on-first-special: ensure a sidecar exists for a file, seeding identity + `first_seen` if absent
 * (§3.1). Idempotent — an existing sidecar is returned untouched (never re-seeded). Gated on the
 * keep-`.lfbridge/` consent (returns null when consent is off — nothing is written to the repo root).
 */
export function ensureSidecar(repoRoot: string, relPath: string, seed?: SidecarSeed): FileSidecar | null {
  if (!keepsLfbridge(repoRoot)) return null;
  const existing = readSidecar(repoRoot, relPath);
  if (existing) return existing;
  const doc = buildSeed(relPath, seed);
  writeSidecar(repoRoot, relPath, doc);
  return doc;
}

/**
 * Append one event to a file's sidecar (repo_tracking_scheme.mdx §3.2) — create-on-first-special (seed
 * identity + first_seen if the sidecar doesn't exist yet), then append-only to `events[]`. Stamps `at`
 * (defaults to now), `on_device` (this computer's unique name when the caller left it blank), and preserves
 * `by` (the caller passes the allow-listed email, or the `NOT_LFBRIDGE` sentinel). Kind-specific fields
 * (ipfs / before / after / codec / format / output / note …) pass through the schema unchanged. Gated on
 * the keep-`.lfbridge/` consent — with consent off, writes NOTHING into the repo root.
 */
export function appendFileEvent(
  repoRoot: string,
  relPath: string,
  event: FileEventInput,
  seed?: SidecarSeed,
): void {
  if (!keepsLfbridge(repoRoot)) return; // consent off → never touch the repo root
  const doc = readSidecar(repoRoot, relPath) ?? buildSeed(relPath, seed);
  // Stamp the common fields, letting anything the caller supplied win, then validate (passthrough keeps
  // the kind-specific fields). on_device is filled from THIS computer's name only when the caller left it
  // blank; `by` stays exactly as the caller passed it (email or the not-lfbridge sentinel).
  const stamped = FileEventSchema.parse({
    ...event,
    at: event.at ?? new Date().toISOString(),
    on_device: event.on_device && event.on_device.trim() ? event.on_device : selfDeviceName(),
    by: event.by ?? null,
  });
  doc.file.events.push(stamped);
  writeSidecar(repoRoot, relPath, doc);
}
