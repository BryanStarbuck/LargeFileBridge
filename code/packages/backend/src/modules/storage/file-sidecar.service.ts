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
import { resolveTrackingRoot } from "./tracking-root.service.js";
import { storageSid } from "./storage.service.js";
import { readStorageSettings } from "./storage-settings.service.js";
import { selfDeviceName } from "./devices.service.js";
import { joinRel, healWindowsPath } from "../../shared/rel-path.js";
import { log } from "../../shared/logging.js";
import { dbEnabled, tryDb } from "../../shared/persistence/db.js";
import {
  deviceIdsByLabel,
  ensureDeviceLabels,
  ensureFileRows,
  ensurePeopleForTokens,
  insertFileEvents,
  personIdsByToken,
  relPosixKey,
  unitIdForRootSync,
  upsertFileFingerprints,
  upsertFileVariants,
  upsertSidecarFiles,
} from "../store-model/file-detail.repo.js";

/** The sentinel `by` value for an action LFBridge did NOT do — a scan merely observed it (§3.3). */
export const NOT_LFBRIDGE = "not-lfbridge";

// ── paths + consent (same pattern as decisions.service.ts) ─────────────────────

// PER-REPO MEMO of the storage settings these two helpers read.
//
// `readStorageSettings` is NOT cheap: it resolves the storage row (a filesystem discovery walk) and then
// does a `readFileSync` + `YAML.parse` + zod-parse of the storage's config. Both helpers below are on the
// PER-FILE path — `readSidecar`/`writeSidecar` call `trackingDir` for every single file a scan touches —
// so a scan re-derived the same repo's settings once per file. Together with the uncached discovery walk
// underneath it, that was the dominant cost of a scan (see the note on `discoverRows` in
// storage.service.ts) and it blocked the event loop while doing it.
//
// Memoized per repo root with a short TTL. Settings changes flow through the settings router (a user
// action, seconds apart at most), so a brief staleness window is invisible in practice, while a scan's
// thousands of repeat lookups collapse into one.
const SETTINGS_TTL_MS = 5_000;
const settingsMemo = new Map<string, { at: number; relocated: string | null | undefined; keeps: boolean }>();

function repoTrackingSettings(repoRoot: string): { relocated: string | null | undefined; keeps: boolean } {
  const now = Date.now();
  const hit = settingsMemo.get(repoRoot);
  if (hit && now - hit.at <= SETTINGS_TTL_MS) return hit;
  let relocated: string | null | undefined;
  let keeps = true;
  try {
    const lf = readStorageSettings(storageSid(repoRoot)).lfbridge;
    relocated = lf.path;
    keeps = lf.enabled;
  } catch {
    /* no per-storage settings yet → defaults */
  }
  const val = { at: now, relocated, keeps };
  settingsMemo.set(repoRoot, val);
  return val;
}

/** WHERE this repo's sidecars live — the content-threshold placement (artifact_placement_policy.mdx §3):
 *  the machine-local state root pre-threshold, `<repo>/.lfbridge/` once transcribed/described. */
function trackingDir(repoRoot: string): string {
  const { relocated, keeps } = repoTrackingSettings(repoRoot);
  return resolveTrackingRoot(repoRoot, { relocated, keepsLfbridge: keeps });
}

function keepsLfbridge(repoRoot: string): boolean {
  return repoTrackingSettings(repoRoot).keeps; // documented default on failure: keep .lfbridge/
}

/**
 * The sidecar path for a repo-relative file — mirrors the file's path under `.lfbridge/files/`, leaf is
 * `<name>.yaml` (repo_tracking_scheme.mdx §3). `videos/trees.mov` → `.lfbridge/files/videos/trees.mov.yaml`.
 * Honors a relocated `.lfbridge/`.
 */
export function sidecarPath(repoRoot: string, relPath: string): string {
  // MIRROR the hierarchy — `relPath` is a POSIX key (repo__list_syns.mdx §6.1), so it is split on `/` and
  // re-joined natively. Interpolating it raw made a `\`-spelled key from a Windows peer into a FLAT file
  // literally named `jfk\training\…mp4.yaml`, which (a) is a different file from the real sidecar, so the
  // file's history forked in two, and (b) cannot be checked out on Windows at all — `\` is not a legal
  // filename character there, so the whole sync repo failed to clone on the machine that wrote it.
  return `${joinRel(path.join(trackingDir(repoRoot), "files"), healWindowsPath(relPath))}.yaml`;
}

// ── the Postgres mirror (dual-write, database.mdx §6.2 / R1) ───────────────────
//
// EVERY YAML WRITE BELOW STAYS EXACTLY AS IT WAS AND KEEPS RUNNING. Postgres is added BEHIND it, never in
// front of it and never instead of it. That is not a transitional courtesy — `mirrorToSyncRepo` copies THE
// FILE, byte for byte, into the SDL that the user's other computers reconcile from (database.mdx §6.2). The
// sync protocol IS the file. A query result cannot be copied, so the sidecar's designated serializer stays
// the authority and this mirror is a read index built alongside it.
//
// THREE PROPERTIES MAKE THE MIRROR SAFE TO RUN FROM A SYNCHRONOUS SCAN WALK:
//
//   1. FIRE AND FORGET. `writeSidecar` / `appendFileEvent` are synchronous — `scanner.service.ts:748` and
//      `pin.service.ts:1649` call them from inside walks that have no `await` to give — so the mirror is
//      started, not awaited. `tryDb` swallows and throttles every failure, so no promise can reject into a
//      request handler (R2).
//   2. ORDER-INDEPENDENT. `file_event_union` is the merge (0009), so two appends racing to the same file
//      cannot produce a duplicate or a lost row whichever order they land in. There is nothing to serialize.
//   3. IT MAY SILENTLY DO NOTHING. With no `unit_id` for this repo (never enlisted, or enlisted since the
//      last cache refresh) the mirror skips. Nothing is lost: the YAML was already written, and backfill
//      area 6 adopts the row on its next pass.

/** Short-lived join maps. A scan appends thousands of events; re-reading two dimension tables per event
 *  would turn a ~2 µs Map hit into a socket round trip and make the scan slower than the YAML-only path. */
const JOIN_TTL_MS = 30_000;
let joinMaps: { at: number; devices: Map<string, number>; people: Map<string, number> } | null = null;

async function joins(): Promise<{ devices: Map<string, number>; people: Map<string, number> }> {
  if (joinMaps && Date.now() - joinMaps.at < JOIN_TTL_MS) return joinMaps;
  const [devices, people] = await Promise.all([deviceIdsByLabel(), personIdsByToken()]);
  joinMaps = { at: Date.now(), devices, people };
  return joinMaps;
}

/**
 * Resolve a device label and an actor token to ids, INSERTING only what is genuinely new.
 *
 * CACHE-FIRST IS THE WHOLE POINT. A scan appends thousands of events, and there are nine distinct device
 * labels and eleven distinct actor tokens in the entire 56,946-event corpus on this machine. Calling
 * `ensureDeviceLabels` / `ensurePeopleForTokens` unconditionally would be two extra statements per event for
 * rows that already exist — turning a ~2 µs Map hit into two socket round trips and making the scan slower
 * than it was before the mirror existed.
 */
async function idsFor(
  label: string,
  by: string,
): Promise<{ deviceId: number | null; actorId: number | null }> {
  let maps = await joins();
  const known = (m: Map<string, number>, k: string): number | null => m.get(k) ?? m.get(k.toLowerCase()) ?? null;
  const missingDevice = label !== "" && known(maps.devices, label) === null;
  const missingPerson = by !== "" && known(maps.people, by) === null;
  if (missingDevice || missingPerson) {
    if (missingDevice) await ensureDeviceLabels([label]);
    if (missingPerson) await ensurePeopleForTokens([by]);
    joinMaps = null; // the rows we just inserted are, by definition, not in the cached maps
    maps = await joins();
  }
  return {
    deviceId: label === "" ? null : known(maps.devices, label),
    actorId: by === "" ? null : known(maps.people, by),
  };
}

/** Tests only — the join maps are module state. */
export function resetSidecarMirrorCache(): void {
  joinMaps = null;
}

function isoOrNull(v: string | undefined | null): Date | null {
  if (!v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * Mirror the sidecar's IDENTITY block — the `lfb.file` row plus the two hash tables hanging off it.
 *
 * Called from `writeSidecar`, which is the single funnel every sidecar mutation passes through
 * (`ensureSidecar` seeds and writes; `appendFileEvent` appends and writes), so one call site covers all of
 * them and there is no third place to keep in step.
 */
function mirrorIdentity(repoRoot: string, relPath: string, doc: FileSidecar): void {
  if (!dbEnabled()) return;
  const unitId = unitIdForRootSync(repoRoot);
  if (unitId === null) return;
  const rel = relPosixKey(relPath);
  const f = doc.file;
  void tryDb(
    async () => {
      const deviceLabel = f.first_seen.on_device?.trim() ?? "";
      const { deviceId } = await idsFor(deviceLabel, "");
      await upsertSidecarFiles([
        {
          unitId,
          relPath,
          sizeBytes: f.size ?? 0,
          // VERBATIM, null included — the render has to reproduce `size: null` (migration 0017).
          sidecarSizeBytes: f.size ?? null,
          createdAt: isoOrNull(f.created),
          modifiedAt: isoOrNull(f.modified),
          categories: f.categories,
          firstSeenAt: isoOrNull(f.first_seen.at),
          firstSeenDevice: deviceId,
        },
      ]);
      // The charter's two-hashes rule and the perceptual index. Both are NEAR-EMPTY in practice — 2 of
      // 29,138 sidecars carry a hash and 2 carry a fingerprint (measured 2026-08-24) — so these are almost
      // always no-ops. They are written anyway because the day something starts filling `file.hash` is the
      // day this has to already work.
      if (f.hash) {
        await upsertFileVariants([
          { unitId, relPosix: rel, variant: "uncompressed", hash: f.hash, sizeBytes: f.size ?? null },
        ]);
      }
      if (f.fingerprint && f.hash) {
        await upsertFileFingerprints([
          {
            contentHash: f.hash,
            algo: f.fingerprint.algo,
            hex: f.fingerprint.value,
            quality: f.fingerprint.quality,
          },
        ]);
      }
      return 0;
    },
    0,
    "sidecar.mirrorIdentity",
  );
}

/**
 * Mirror ONE appended event.
 *
 * Deliberately not the whole `events[]` array: `writeSidecar` rewrites the entire document every time, and
 * mirroring all of it per append would re-offer every prior event on every append — 40 statements' worth of
 * work for one new row on a file with 40 events, and this runs inside a scan. `appendFileEvent` is the only
 * caller that knows which event is new, so it is the only one that mirrors an event.
 */
function mirrorEvent(repoRoot: string, relPath: string, event: FileEvent): void {
  if (!dbEnabled()) return;
  const unitId = unitIdForRootSync(repoRoot);
  if (unitId === null) return;
  const rel = relPosixKey(relPath);
  void tryDb(
    async () => {
      const at = isoOrNull(event.at);
      if (!at) return 0; // `at` is NOT NULL in the schema; an unparseable stamp is not an event we can file
      const { deviceId, actorId } = await idsFor(event.on_device?.trim() ?? "", event.by?.trim() ?? "");
      // THE PARENT ROW FIRST, AND UNCONDITIONALLY.
      //
      // MEASURED FAILURE (2026-08-24): without this line the event mirror wrote NOTHING at all. `file_event`
      // carries `FOREIGN KEY (unit_id, rel_posix) REFERENCES lfb.file` (0009), and `appendFileEvent` starts
      // TWO fire-and-forget mirrors — `writeSidecar`'s identity upsert and this one — which race. When the
      // event insert won, every row failed the FK, and `tryDb` swallowed it exactly as designed: the sidecar
      // was on disk, the `lfb.file` row appeared, and the events silently were not there.
      //
      // `ensureFileRows` is a `DO NOTHING` presence claim over the PK, so it is a no-op on the (normal) path
      // where the identity mirror already won. One extra ~200 µs statement in a background task, against a
      // write that has already done a full YAML `fsync`, in exchange for an ordering guarantee that does not
      // depend on which promise the event loop happened to schedule first.
      await ensureFileRows([{ unitId, relPath: relPath }]);
      await insertFileEvents([
        {
          unitId,
          relPosix: rel,
          at,
          kind: event.kind,
          deviceId,
          actorId,
          detail: detailOf(event),
          origin: "local",
        },
      ]);
      return 0;
    },
    0,
    "sidecar.mirrorEvent",
  );
}

/**
 * The event MINUS the four columns 0009 normalizes out of it.
 *
 * `FileEventSchema` is `.passthrough()`, so an event carries arbitrary kind-specific fields (`cid`,
 * `before`/`after`, `codec`, `note`, `compressed`, …) and `detail` is where they go. `kind` / `at` /
 * `on_device` / `by` are dropped because they became columns, and leaving them in `detail` as well would put
 * them TWICE inside `file_event_union` — which is over `detail` too, so a stale duplicate spelling would
 * quietly stop the merge from recognising a repeat.
 */
function detailOf(event: FileEvent): Record<string, unknown> {
  const { kind: _k, at: _a, on_device: _d, by: _b, ...rest } = event as Record<string, unknown> & FileEvent;
  return rest;
}

// ── read / write ───────────────────────────────────────────────────────────────

/**
 * Read a file's sidecar (missing/corrupt → null).
 *
 * THIS READ DOES NOT CUT OVER TO POSTGRES (R3 / database_migration.mdx §4.5), and that is deliberate rather
 * than unfinished. Two reasons, both structural:
 *
 *   * It returns a `FileSidecar` — the exact document `mirrorToSyncRepo` copies and `reconcileFromSyncRepo`
 *     merges. Rendering that from rows would make Postgres a YAML emitter, which the sync fence forbids
 *     (R4 / database.mdx §2.2); the render gate that is allowed to do it is its own slice.
 *   * It is the VERIFICATION ORACLE. Area 6's whole claim is "the rows say what the sidecars say", and an
 *     oracle that consulted the thing it is checking would assert nothing.
 */
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
  // DUAL-WRITE, and strictly AFTER the rename. The YAML is the authority and the thing that travels; the
  // mirror describes what is already durably on disk. Mirroring first would let a failed rename leave a row
  // asserting a sidecar that does not exist.
  mirrorIdentity(repoRoot, relPath, normalized);
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
  // The recorded identity is the POSIX key too (§6.1) — the sidecar travels, and `file.path` is what a peer
  // joins on. `basename` off the POSIX spelling, so a `\`-spelled key doesn't name the file after its
  // whole path.
  const rel = healWindowsPath(relPath);
  return FileSidecarSchema.parse({
    file: {
      path: rel,
      name: seed?.name ?? path.posix.basename(rel),
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
  writeSidecar(repoRoot, relPath, doc); // mirrors the IDENTITY (the `lfb.file` row) as a side effect
  // …and the one NEW event. Split from the identity mirror on purpose — see `mirrorEvent`: this is the only
  // caller that knows which of the events in the document did not exist a moment ago.
  mirrorEvent(repoRoot, relPath, stamped);
}
