// BACKFILL AREAS 6 AND 7 — the sidecar tree, and the artifact index (database_migration.mdx §4.3).
//
// AREA 6 (backfill_sidecars) is the biggest single read-amplification win in the whole exercise: 29,138
// per-file YAML documents, 23.1 MB of content occupying ~124 MB of disk because the mean document is 793 B
// in a 4 KiB block, re-merged in full on every reconcile pass while 99.98% of them are byte-identical.
//
// AREA 7 (backfill_artifacts) is the one where a MISTAKE COSTS MONEY. `analysisOutputs()` is the "is it
// already done?" check; a placement the index forgets reads as a FALSE MISSING, and a false missing on an
// AI description re-bills the provider. That is why nothing here re-implements where an artifact can live:
// the layout is `tracking.service.ts artifactLayoutFor()`, the same function the probe itself uses, and the
// verification re-runs the app's own `analysisOutputsFromDisk()` and asserts set equality.
//
// Both obey the harness's three mechanics and add none of their own (see shared/persistence/backfill.ts),
// both read through `readRawYaml` and never `readYaml()` (R6 / §4.2), and both write only the columns they
// own (R5 — see the per-helper notes in `file-detail.repo.ts`). Neither touches a YAML writer: this is a
// pure ADD behind writers that are unchanged and still running (R1).
import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { FileSidecarSchema, RepoUnitConfigSchema, StorageUnitConfigSchema } from "@lfb/shared";
import {
  registerBackfill,
  type BackfillArea,
  type BackfillContext,
  type BackfillScope,
} from "../../shared/persistence/backfill.js";
import { readRawYaml } from "../../shared/persistence/raw-yaml.js";
import { resolveStateDir } from "../../config/state-dir.js";
import { isDirForKey } from "../../shared/store/keyed-dir.js";
import { expandHome } from "../../shared/home-path.js";
import { healWindowsPath, joinRel, relPosix } from "../../shared/rel-path.js";
import { statOrNull } from "../../shared/fs-probe.js";
import { log } from "../../shared/logging.js";
import { HARD_SKIP } from "../fs/badges.js";
import { repoKeyFor } from "./tracking-root.service.js";
import { RESERVED_SDL_ROOT_NAMES } from "./storage-type.service.js";
import {
  analysisOutputsFromDisk,
  artifactLayoutFor,
  COMPRESSION_RECORD_FILE,
  type ArtifactPlacementKind,
} from "./tracking.service.js";
import {
  countFileArtifacts,
  countFileEvents,
  deviceIdsByLabel,
  ensureDeviceLabels,
  ensureFileRows,
  ensurePeopleForTokens,
  insertFileEvents,
  personIdsByToken,
  readArtifactsForFiles,
  refreshUnitIdCache,
  unitIdForRoot,
  upsertFileFingerprints,
  upsertFileArtifacts,
  upsertFileVariants,
  upsertSidecarFiles,
  type FileArtifactRow,
  type FileEventRow,
} from "../store-model/file-detail.repo.js";

// ── shared state-root layout (mirrors unit-backfill.ts; kept local so neither file owns the other) ───────

const stateRoot = (): string => resolveStateDir();
const pinReposRoot = (): string => path.join(stateRoot(), "pin", "r");
const pinStoragesRoot = (): string => path.join(stateRoot(), "pin", "s");
const trackingReposRoot = (): string => path.join(stateRoot(), "repos");

function listDirs(dir: string): string[] {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort();
  } catch {
    return []; // a state root with no repos yet is normal, not an error
  }
}

/**
 * The Local-Storage tracking dir for a repo key, WITHOUT `repoStateDir()`'s `mkdir` side effect.
 *
 * Same reasoning as `unit-backfill.ts trackingDirFor`: a read-only migration must not plant empty
 * directories for repos it is only looking at. Matched by the key SUFFIX (`keyed-dir.ts isDirForKey`), never
 * by exact name, so a directory written before the `<slug>-<key>` rename still resolves.
 */
function trackingDirFor(repoKey: string): string | null {
  for (const name of listDirs(trackingReposRoot())) {
    if (isDirForKey(name, repoKey)) return path.join(trackingReposRoot(), name);
  }
  return null;
}

/** The repo root a pin folder claims, or null when its config cannot name one. */
function repoRootForPinFolder(folder: string): string | null {
  try {
    const cfg = readRawYaml(path.join(pinReposRoot(), folder, "config.yaml"), RepoUnitConfigSchema);
    return cfg.repo.path.trim() ? path.resolve(expandHome(cfg.repo.path)) : null;
  } catch {
    return null; // area 2 already rejected it by name with the parser's own message
  }
}

/** The storage root a `pin/s/<id>` unit claims, or null. */
function storageRootForId(id: string): string | null {
  try {
    const cfg = readRawYaml(path.join(pinStoragesRoot(), id, "config.yaml"), StorageUnitConfigSchema);
    return cfg.storage.root.trim() ? path.resolve(expandHome(cfg.storage.root)) : null;
  } catch {
    return null;
  }
}

/**
 * A bounded recursive file walk.
 *
 * `skipDirs` is the SAME hard-skip discipline the describe / OCR walks use (`describe.service.ts:56`,
 * `ocr.service.ts:39`: `new Set([...HARD_SKIP, '.lfbridge', '.transcribe'])`) — build/, dist/, node_modules/
 * and the artifact dirs, which hold duplicate source media and would otherwise be indexed twice under two
 * different relative keys.
 *
 * Symlinked directories are NOT followed (`withFileTypes` reports the link itself, and `isDirectory()` is
 * false for one), which is what keeps a self-referential link from turning a one-shot migration into a
 * non-terminating walk.
 */
function walkFiles(base: string, skipDirs: ReadonlySet<string>, onFile: (abs: string) => void): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(base, { withFileTypes: true });
  } catch {
    return; // a base that does not exist is the normal case for most placements
  }
  for (const e of entries) {
    const abs = path.join(base, e.name);
    if (e.isDirectory()) {
      if (skipDirs.has(e.name)) continue;
      walkFiles(abs, skipDirs, onFile);
    } else if (e.isFile()) {
      onFile(abs);
    }
  }
}

// ════════════════════════════════════════════════════════════════════════════════════════════════════════
// AREA 6 — backfill_sidecars
// ════════════════════════════════════════════════════════════════════════════════════════════════════════

interface SidecarScopeData {
  folder: string;
  repoRoot: string;
  filesDir: string;
  /** Every sidecar in this repo, absolute, sorted — the scope's watermark AND its work list. */
  sidecars: string[];
}

/**
 * THE SCOPE'S WATERMARK IS EVERY SIDECAR IT WILL READ, not the directory that holds them.
 *
 * A directory's mtime moves when an entry is added or removed but NOT when a nested file's contents change,
 * and a sidecar changes contents constantly — every appended event rewrites one. A directory-level watermark
 * would therefore report "unchanged" for a repo whose sidecars had all been rewritten, and the re-arm would
 * migrate nothing. Measured cost of doing it exactly: 29,138 `statSync` calls across the whole tree, ~60 ms
 * warm — a rounding error against the 23.1 MB of YAML the area then parses.
 */
function sidecarScopes(): BackfillScope[] {
  const scopes: BackfillScope[] = [];
  for (const folder of listDirs(pinReposRoot())) {
    const repoRoot = repoRootForPinFolder(folder);
    if (!repoRoot) continue;
    const trackingDir = trackingDirFor(repoKeyFor(repoRoot));
    if (!trackingDir) continue; // no Local-Storage dir → this repo has never been tracked
    const filesDir = path.join(trackingDir, "files");
    const sidecars: string[] = [];
    walkFiles(filesDir, new Set(), (abs) => {
      if (abs.endsWith(".yaml")) sidecars.push(abs);
    });
    if (sidecars.length === 0) continue;
    sidecars.sort(); // the cursor is a path, so the order it advances through must be stable
    scopes.push({
      key: `r/${folder}`,
      sources: sidecars,
      data: { folder, repoRoot, filesDir, sidecars } satisfies SidecarScopeData,
    });
  }
  return scopes;
}

/** Rows this run wrote beyond the sidecar count, reported by `verify()` rather than folded into `rows`. */
let sidecarEventRows = 0;
let sidecarVariantRows = 0;
let sidecarFingerprintRows = 0;

/** How many sidecars a batch holds before it is flushed. 500 matches `copyRows`' measured statement knee. */
const SIDECAR_BATCH = 500;

interface SidecarBatch {
  files: Parameters<typeof upsertSidecarFiles>[0];
  events: FileEventRow[];
  variants: Parameters<typeof upsertFileVariants>[0];
  fingerprints: Parameters<typeof upsertFileFingerprints>[0];
}

function emptyBatch(): SidecarBatch {
  return { files: [], events: [], variants: [], fingerprints: [] };
}

async function flushSidecarBatch(batch: SidecarBatch): Promise<void> {
  // ORDER MATTERS AND IS NOT NEGOTIABLE: `file_event` / `file_variant` carry
  // `FOREIGN KEY (unit_id, rel_posix) REFERENCES lfb.file` (0009), and an FK violation aborts the WHOLE
  // multi-row statement — not the offending row. So the parent rows land first, in their own statement.
  if (batch.files.length) await upsertSidecarFiles(batch.files);
  if (batch.events.length) sidecarEventRows += await insertFileEvents(batch.events);
  if (batch.variants.length) sidecarVariantRows += await upsertFileVariants(batch.variants);
  if (batch.fingerprints.length) sidecarFingerprintRows += await upsertFileFingerprints(batch.fingerprints);
}

function isoOrNull(v: string | undefined | null): Date | null {
  if (!v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

async function runSidecarScope(data: SidecarScopeData, ctx: BackfillContext): Promise<number> {
  const unitId = await unitIdForRoot(data.repoRoot);
  if (unitId === null) {
    // Area 2 owns `lfb.unit`. A repo with no unit row means area 2 has not run, or rejected this repo — and
    // inventing the row here would put a second writer on a table another area owns (R5).
    ctx.reject(data.filesDir, `no lfb.unit row for ${data.repoRoot} — run adopt_units first`);
    return 0;
  }

  // The dimensions every event joins to. Collected across the WHOLE scope first, so nine device labels and
  // a handful of actor tokens cost two statements per repo instead of two per event.
  const deviceLabels = new Set<string>();
  const actorTokens = new Set<string>();
  const parsed: Array<{ rel: string; doc: ReturnType<typeof FileSidecarSchema.parse> }> = [];

  let rows = ctx.rowsBefore;
  let batch = emptyBatch();
  let devices = new Map<string, number>();
  let people = new Map<string, number>();

  // PASS 1 — parse, and collect the dimension tokens. The parse is the expensive half (23.1 MB of YAML
  // across the whole tree), so it happens exactly once and the result is held per BATCH, never for the whole
  // repo: the largest repo here holds 20,059 sidecars, and keeping all of them resident would be ~40 MB of
  // live objects for no reason.
  const flushParsed = async (): Promise<void> => {
    if (parsed.length === 0) return;
    if (deviceLabels.size) await ensureDeviceLabels([...deviceLabels]);
    if (actorTokens.size) await ensurePeopleForTokens([...actorTokens]);
    if (deviceLabels.size || actorTokens.size) {
      devices = await deviceIdsByLabel();
      people = await personIdsByToken();
      deviceLabels.clear();
      actorTokens.clear();
    }
    for (const { rel, doc } of parsed) {
      const f = doc.file;
      const relKey = healWindowsPath(rel);
      const firstSeenDevice = f.first_seen.on_device?.trim() ?? "";
      batch.files.push({
        unitId,
        relPath: rel,
        sizeBytes: f.size ?? 0,
        // VERBATIM, null included — `renderSidecar` must reproduce `size: null` as `size: null`, not as the
        // `0` the live column coerces it to (migration 0017).
        sidecarSizeBytes: f.size ?? null,
        createdAt: isoOrNull(f.created),
        modifiedAt: isoOrNull(f.modified),
        categories: f.categories,
        firstSeenAt: isoOrNull(f.first_seen.at),
        firstSeenDevice: firstSeenDevice ? (devices.get(firstSeenDevice) ?? null) : null,
      });
      for (const ev of f.events) {
        const at = isoOrNull(ev.at);
        if (!at) continue; // `at` is NOT NULL; an unparseable stamp is not an event we can file
        const label = ev.on_device?.trim() ?? "";
        const by = ev.by?.trim() ?? "";
        const { kind: _k, at: _a, on_device: _d, by: _b, ...detail } = ev as Record<string, unknown> &
          typeof ev;
        batch.events.push({
          unitId,
          relPosix: relKey,
          at,
          kind: ev.kind,
          deviceId: label ? (devices.get(label) ?? null) : null,
          // `by` is EITHER an address or a sentinel — see `isEmailToken`. One lookup over a map built from
          // both UNIQUE columns, so a `not-lfbridge` event and a real user's event resolve the same way.
          actorId: by ? (people.get(by.toLowerCase()) ?? people.get(by) ?? null) : null,
          detail,
          origin: "local",
        });
      }
      // THE TWO NEAR-EMPTY ONES. Measured 2026-08-24: 2 of 29,138 sidecars carry a `hash`, 2 carry a
      // `fingerprint`. That is not a migration failure — nothing on the sidecar path populates them today,
      // and that emptiness is exactly why the charter's perceptual-match feature cannot work yet. The
      // migration reports the real number rather than hiding it.
      if (f.hash) {
        batch.variants.push({
          unitId,
          relPosix: relKey,
          variant: "uncompressed",
          hash: f.hash,
          sizeBytes: f.size ?? null,
        });
        if (f.fingerprint) {
          batch.fingerprints.push({
            contentHash: f.hash,
            algo: f.fingerprint.algo,
            hex: f.fingerprint.value,
            quality: f.fingerprint.quality,
          });
        }
      }
    }
    parsed.length = 0;
    await flushSidecarBatch(batch);
    batch = emptyBatch();
  };

  for (const abs of data.sidecars) {
    // Mechanic (a): an interrupted run resumes from its cursor. The list is sorted, so "everything at or
    // before the cursor is done" is exact.
    if (ctx.resumeFrom !== null && abs <= ctx.resumeFrom) continue;

    let doc;
    try {
      // Raw read + zod, NEVER `readYaml()` (R6): `yaml-store`'s rawCache is 4,096 entries with FIFO
      // eviction, and walking 29,138 documents through it would overwrite the live working set ~7 times and
      // evict every hot unit config — degrading the exact request this work exists to speed up.
      doc = readRawYaml(abs, FileSidecarSchema);
    } catch (e) {
      // Mechanic (c): RECORD AND CONTINUE. Two of the 29,138 sidecars on this machine have historically
      // failed `YAML.parse` (a Windows-separator `path:` value raising BLOCK_AS_IMPLICIT_KEY) and
      // `readSidecar` swallows the error — which is exactly how they sat here unnoticed. The reject table
      // is what makes them visible.
      ctx.reject(abs, `sidecar unreadable: ${(e as Error).message}`);
      continue;
    }

    // THE KEY IS THE SIDECAR'S OWN `file.path`, NOT THE FILENAME IT IS STORED UNDER. `sidecarPath()` mirrors
    // the media's relative path and appends `.yaml`, so the two normally agree — but a `\`-spelled key from
    // a Windows peer produced a FLAT file literally named `a\b.mp4.yaml`, and the recorded `path:` is the
    // one a peer joins on (repo__list_syns.mdx §6.1). `rel_posix` is generated from it and heals the `\`.
    const rel = doc.file.path?.trim() || relPosix(data.filesDir, abs).replace(/\.yaml$/, "");
    if (!rel) {
      ctx.reject(abs, "sidecar has no file.path and no derivable relative key");
      continue;
    }

    if (doc.file.first_seen.on_device?.trim()) deviceLabels.add(doc.file.first_seen.on_device.trim());
    for (const ev of doc.file.events) {
      if (ev.on_device?.trim()) deviceLabels.add(ev.on_device.trim());
      if (ev.by?.trim()) actorTokens.add(ev.by.trim());
    }
    parsed.push({ rel, doc });
    rows += 1;

    if (parsed.length >= SIDECAR_BATCH) {
      await flushParsed();
      ctx.checkpoint(abs, rows);
    }
  }
  await flushParsed();
  ctx.checkpoint(null, rows);
  return rows;
}

export const BACKFILL_SIDECARS: BackfillArea = {
  name: "backfill_sidecars",
  // v3 (2026-08-24) — v2 added the two sidecar-owned columns to the INSERT list but not to the ON CONFLICT
  // clause, so every already-existing row kept them NULL and the gate got WORSE (15,868 -> 28,451). v3 is
  // the corrected clause.
  // v2 (2026-08-24) — migration 0017 split the contested columns, and this area now also populates
  // `sidecar_size_bytes` / `sidecar_modified_at`. Bumping the LOGIC version is the whole point of
  // `applied_version < version` (database_migration.mdx §2.1): a v1 run left those two columns NULL, so the
  // watermark alone would have declared every scope up-to-date and the render gate would have stayed red
  // with no indication why. A 24-byte timestamp sentinel could not have expressed this.
  version: 3,
  kind: "backfill",
  sources: () => sidecarScopes().flatMap((s) => s.sources),
  scopes: async () => {
    sidecarEventRows = 0;
    sidecarVariantRows = 0;
    sidecarFingerprintRows = 0;
    await refreshUnitIdCache(); // area 2's rows are this area's FK target
    return sidecarScopes();
  },

  async run(scope: BackfillScope, ctx: BackfillContext): Promise<{ rows: number }> {
    const rows = await runSidecarScope(scope.data as SidecarScopeData, ctx);
    return { rows };
  },

  /**
   * §4.5's named assertion: `file_event` count = the events on disk, minus the events of any rejected
   * sidecar — and every rejected path is in the reject table with its parse error (the harness writes those;
   * this only has to make the arithmetic add up).
   */
  async verify() {
    const mismatches: string[] = [];
    let yamlEvents = 0;
    let yamlFiles = 0;
    let unreadable = 0;
    for (const scope of sidecarScopes()) {
      const data = scope.data as SidecarScopeData;
      for (const abs of data.sidecars) {
        try {
          const doc = readRawYaml(abs, FileSidecarSchema);
          yamlFiles += 1;
          yamlEvents += doc.file.events.length;
        } catch {
          unreadable += 1; // its events are legitimately absent from Postgres — see the subtraction below
        }
      }
    }
    const pgEvents = await countFileEvents();
    if (pgEvents < yamlEvents) {
      mismatches.push(
        `file_event holds ${pgEvents} rows for ${yamlEvents} events across ${yamlFiles} readable sidecars ` +
          `(${unreadable} unreadable, whose events are correctly absent)`,
      );
    }
    log.info(
      "migrate",
      `backfill_sidecars: ${yamlFiles} sidecars, ${yamlEvents} events on disk, ${pgEvents} file_event rows; ` +
        `${sidecarVariantRows} variant row(s) and ${sidecarFingerprintRows} fingerprint row(s) written ` +
        `— hash/fingerprint are null on essentially every sidecar, which is the honest state of the product`,
    );
    return { yamlRows: yamlEvents, pgRows: pgEvents, mismatches };
  },
};

// ════════════════════════════════════════════════════════════════════════════════════════════════════════
// AREA 7 — backfill_artifacts
// ════════════════════════════════════════════════════════════════════════════════════════════════════════

const TRANSCRIPTION_EXT = ".transcription";
const AI_DESCRIPTION_EXT = ".ai_description";
const OCR_EXT = ".ocr";
const VISUALS_FILE = "visuals_by_time.yaml";

/**
 * THE LEGACY GIT-TRACKED TRANSCRIPT DIRECTORY.
 *
 * `<sdl>/.transcribe/<rel>.txt` — a DIFFERENT extension under a DIFFERENT root from every current placement,
 * written by an older build before transcripts moved to `<base>/<rel>.transcription`. There are 30 of them on
 * this machine, all under `personal_large_files_bridge`, and `describe.service.ts:56` / `ocr.service.ts:39`
 * both explicitly SKIP the `.transcribe` directory when they walk.
 *
 * MISSING THEM MEANS 30 FALSE MISSINGS AND 30 RE-BILLED AI REGENERATIONS. They are indexed as
 * `kind='transcript'`, `placement='legacy_lfbridge'` — the enum value that already means "a pre-migration
 * location a READER falls back to and a WRITER never uses" (`legacyTrackingBaseDir`'s header).
 *
 * This is the one placement with no counterpart in `artifactLayoutFor()`, because the app's own probe does
 * not look here — which is exactly the gap that makes it worth indexing. It is spelled ONCE, here, and both
 * the writer and `verify()`'s oracle read it.
 */
const LEGACY_TRANSCRIBE_DIR = ".transcribe";
const LEGACY_TRANSCRIBE_EXT = ".txt";

/** `<root>/.transcribe/<rel>.txt` for a media key, or null when it is not there. */
export function legacyTranscriptPath(root: string, rel: string): string | null {
  const p = joinRel(path.join(root, LEGACY_TRANSCRIBE_DIR), rel) + LEGACY_TRANSCRIBE_EXT;
  return statOrNull(p)?.isFile() ? p : null;
}

interface ArtifactScopeData {
  key: string;
  root: string;
}

function artifactScopes(): BackfillScope[] {
  const scopes: BackfillScope[] = [];
  const seen = new Set<string>();
  const add = (key: string, root: string): void => {
    if (seen.has(root)) return; // one directory is one unit row (`unit_abs_path_unique`), so one scope
    seen.add(root);
    // The scope's watermark is the ROOT DIRECTORY, not its artifacts. Unlike the sidecar tree — where a
    // watermark over the files is both cheap and necessary — an artifact scope's file list is what the run
    // itself discovers by walking, so listing it up front would do the walk twice for every unchanged repo.
    // A source-fingerprint miss just means the area re-walks, which is the cheap direction to be wrong in.
    scopes.push({ key, sources: [root], data: { key, root } satisfies ArtifactScopeData });
  };
  for (const folder of listDirs(pinReposRoot())) {
    const root = repoRootForPinFolder(folder);
    if (root) add(`r/${folder}`, root);
  }
  for (const id of listDirs(pinStoragesRoot())) {
    const root = storageRootForId(id);
    if (root) add(`s/${id}`, root);
  }
  return scopes;
}

/** Directories no artifact walk descends into — the app's own hard-skip set, plus the SDL's own metadata. */
function skipDirsFor(base: string, root: string): ReadonlySet<string> {
  const skip = new Set<string>(HARD_SKIP);
  skip.add(".git");
  skip.add(LEGACY_TRANSCRIBE_DIR); // walked separately, under its own placement
  // Walking the root as the BESIDE base must not descend into the TRACKING base, or every tracking-base
  // artifact would be found a second time under the key `.lfbridge/videos/x.mp4` — a path no media has.
  if (path.resolve(base) === path.resolve(root)) {
    for (const n of RESERVED_SDL_ROOT_NAMES) skip.add(n);
  } else {
    skip.add("analysis"); // the tracking base's own analysis tree has its own bases
  }
  return skip;
}

/** Header fields we are allowed to lift out of a YAML-shaped artifact. */
interface ArtifactHeader {
  engine: string | null;
  provider: string | null;
  language: string | null;
  generatedAt: Date | null;
}

const EMPTY_HEADER: ArtifactHeader = { engine: null, provider: null, language: null, generatedAt: null };

/** How many bytes of a body we are willing to look at to find its header. Real headers run under 200 B. */
const HEADER_BYTES = 4096;

/**
 * HEADERS ONLY. NEVER THE BODY.
 *
 * `.ai_description` and `.ocr` are YAML-shaped: a handful of `key: value` header lines followed by a
 * `description:` or `text:` block scalar holding the artifact itself. Those bodies are CATEGORY-A CONTENT
 * and they stay in files — 31.0 MB of descriptions and 70.8 MB of OCR text on this machine, which is not
 * something to copy into a database that exists to make an index fast.
 *
 * So this reads the first 4 KiB, takes top-level scalar `key: value` pairs, and STOPS at the first key whose
 * value opens a block scalar (`|`, `|-`, `>`, `>-`) or is empty — which is precisely where the body starts.
 * It never calls `YAML.parse`, because parsing means materialising the body.
 */
export function readArtifactHeader(abs: string): ArtifactHeader {
  let text: string;
  try {
    const fd = fs.openSync(abs, "r");
    try {
      const buf = Buffer.alloc(HEADER_BYTES);
      const n = fs.readSync(fd, buf, 0, HEADER_BYTES, 0);
      text = buf.subarray(0, n).toString("utf8");
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return EMPTY_HEADER;
  }
  const head: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const m = /^([A-Za-z_][A-Za-z0-9_]*):(.*)$/.exec(line); // top-level keys only — no leading whitespace
    if (!m) continue;
    const value = m[2].trim();
    if (value === "" || value.startsWith("|") || value.startsWith(">")) break; // the body begins here
    head[m[1]] = value;
  }
  return {
    engine: head.engine ?? null,
    provider: head.provider ?? null,
    language: head.language ?? null,
    generatedAt: head.generated ? (Number.isNaN(Date.parse(head.generated)) ? null : new Date(head.generated)) : null,
  };
}

/** One discovered artifact, before it is turned into a row. */
interface Found {
  rel: string;
  kind: FileArtifactRow["kind"];
  bodyPath: string;
  placement: ArtifactPlacementKind;
}

const BODY_EXTS: Array<{ ext: string; kind: FileArtifactRow["kind"] }> = [
  { ext: TRANSCRIPTION_EXT, kind: "transcript" },
  { ext: AI_DESCRIPTION_EXT, kind: "description" },
  { ext: OCR_EXT, kind: "ocr" },
];

/**
 * Discover every artifact under one root, in the app's OWN probe order.
 *
 * The order is what makes the result agree with `analysisOutputsFromDisk()`: that function asks
 * `bases.some(...)`, which short-circuits on the first base that has the file, and its compression loop
 * `break`s on the first record it finds. So the FIRST base to yield a (rel, kind) wins here too, and the
 * indexed `body_path` is the same copy the probe would have stopped at.
 */
function discoverArtifacts(root: string): Found[] {
  const layout = artifactLayoutFor(root);
  const byKey = new Map<string, Found>();
  const claim = (f: Found): void => {
    const k = `${healWindowsPath(f.rel)} ${f.kind}`;
    if (!byKey.has(k)) byKey.set(k, f);
  };

  // 1. Artifact BODIES (`<rel><ext>`), in base order. Duplicate base directories are skipped rather than
  //    walked twice: for an SDL, `trackingBaseDir(root) === root`, so tracking_base and beside are the same
  //    directory and only the first (tracking_base) should claim its finds.
  const walked = new Set<string>();
  for (const base of layout.bodyBases) {
    const dir = path.resolve(base.dir);
    if (walked.has(dir)) continue;
    walked.add(dir);
    walkFiles(dir, skipDirsFor(dir, root), (abs) => {
      for (const { ext, kind } of BODY_EXTS) {
        if (!abs.endsWith(ext)) continue;
        claim({ rel: relPosix(dir, abs).slice(0, -ext.length), kind, bodyPath: abs, placement: base.placement });
        return;
      }
    });
  }

  // 2. `analysis/<rel>/visuals_by_time.yaml`.
  for (const base of layout.analysisBases) {
    const dir = path.resolve(base.dir);
    walkFiles(dir, new Set(HARD_SKIP), (abs) => {
      if (path.basename(abs) !== VISUALS_FILE) return;
      claim({
        rel: relPosix(dir, path.dirname(abs)),
        kind: "visuals_by_time",
        bodyPath: abs,
        placement: base.placement,
      });
    });
  }

  // 3. The travelling compression record, `analysis/<rel>/compression.yaml`, in the probe's own order —
  //    the Local-Storage state dir first (where we write), then the sync-repo mirror (how another computer's
  //    record reaches this one), then the tracking bases (records written before the Category-B fix).
  for (const base of layout.recordBases(root)) {
    const dir = path.resolve(base.dir);
    walkFiles(dir, new Set(HARD_SKIP), (abs) => {
      if (path.basename(abs) !== COMPRESSION_RECORD_FILE) return;
      claim({
        rel: relPosix(dir, path.dirname(abs)),
        kind: "compression",
        bodyPath: abs,
        placement: base.placement,
      });
    });
  }

  // 4. The 30 legacy git-tracked transcripts. See `legacyTranscriptPath` for why missing them costs money.
  const legacyBase = path.join(root, LEGACY_TRANSCRIBE_DIR);
  walkFiles(legacyBase, new Set(HARD_SKIP), (abs) => {
    if (!abs.endsWith(LEGACY_TRANSCRIBE_EXT)) return;
    claim({
      rel: relPosix(legacyBase, abs).slice(0, -LEGACY_TRANSCRIBE_EXT.length),
      kind: "transcript",
      bodyPath: abs,
      placement: "legacy_lfbridge",
    });
  });

  return [...byKey.values()].sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : a.kind < b.kind ? -1 : 1));
}

/** `compressed.size` out of a compression record — the value `media_size_at_record` must carry. */
function compressionMediaSize(abs: string): number | null {
  try {
    // The 74 records on this machine are ~400 B each, so a full parse is honest here — unlike the
    // description / OCR bodies, there is no content to avoid materialising.
    const doc = YAML.parse(fs.readFileSync(abs, "utf8")) as { compressed?: { size?: number | null } } | null;
    const size = doc?.compressed?.size;
    return typeof size === "number" && Number.isFinite(size) ? size : null;
  } catch {
    return null;
  }
}

const ARTIFACT_BATCH = 500;

async function runArtifactScope(data: ArtifactScopeData, ctx: BackfillContext): Promise<number> {
  const unitId = await unitIdForRoot(data.root);
  if (unitId === null) {
    ctx.reject(data.root, `no lfb.unit row for ${data.root} — run adopt_units first`);
    return 0;
  }
  const found = discoverArtifacts(data.root);
  let rows = ctx.rowsBefore;
  let parents: Array<{ unitId: number; relPath: string }> = [];
  let batch: FileArtifactRow[] = [];

  const flush = async (): Promise<void> => {
    if (parents.length === 0) return;
    // The FK again (0009): the parent rows first, in their own statement. `ensureFileRows` claims no column
    // — an artifact body proves a path exists, and proves nothing about the media's size.
    await ensureFileRows(parents);
    await upsertFileArtifacts(batch);
    parents = [];
    batch = [];
  };

  for (const f of found) {
    if (ctx.resumeFrom !== null && `${f.rel} ${f.kind}` <= ctx.resumeFrom) continue;
    const st = statOrNull(f.bodyPath);
    if (!st) {
      // Discovered by the walk and gone by the time we stat it. Not a reject — nothing is wrong with the
      // data, the file simply moved under a migration that takes minutes.
      continue;
    }
    let mediaSizeAtRecord: number | null = null;
    let header = EMPTY_HEADER;
    if (f.kind === "compression") {
      mediaSizeAtRecord = compressionMediaSize(f.bodyPath);
      if (mediaSizeAtRecord === null) {
        // `artifact_compression_needs_media_size` refuses the row, and refusing it is RIGHT: without the
        // recorded size there is nothing to compare a live `stat` against, and `compressionRecordFresh()`'s
        // "a record without a size is trusted" has no row form. The file falls back to the disk probe, which
        // answers it correctly — so this is a gap in the INDEX, recorded, not a wrong answer for the user.
        ctx.reject(f.bodyPath, "compression record has no compressed.size — cannot satisfy media_size_at_record");
        continue;
      }
      header = readArtifactHeader(f.bodyPath);
    } else if (f.kind === "description" || f.kind === "ocr" || f.kind === "visuals_by_time") {
      // YAML-shaped kinds carry a header worth indexing. `.transcription` and the legacy `.txt` do NOT —
      // their first lines are prose ("Transcription of: …"), not fields, and guessing at them would put
      // invented metadata in a table that is supposed to answer questions.
      header = readArtifactHeader(f.bodyPath);
    }
    parents.push({ unitId, relPath: f.rel });
    batch.push({
      unitId,
      relPosix: healWindowsPath(f.rel),
      kind: f.kind,
      bodyPath: f.bodyPath,
      placement: f.placement,
      bodySize: st.size,
      bodyMtimeMs: Math.round(st.mtimeMs),
      mediaSizeAtRecord,
      engine: header.engine,
      provider: header.provider,
      language: header.language,
      generatedAt: header.generatedAt,
    });
    rows += 1;
    if (batch.length >= ARTIFACT_BATCH) {
      await flush();
      ctx.checkpoint(`${f.rel} ${f.kind}`, rows);
    }
  }
  await flush();
  ctx.checkpoint(null, rows);
  return rows;
}

/**
 * The deterministic 200-file sample §4.5 asks for.
 *
 * DETERMINISTIC means the same 200 every run: sorted keys, then a fixed stride. A random sample would make a
 * failure unreproducible, which is the one property a gate that BLOCKS a read cutover cannot have.
 */
export function sampleEvenly<T>(items: T[], n: number): T[] {
  if (items.length <= n) return [...items];
  const stride = items.length / n;
  const out: T[] = [];
  for (let i = 0; i < n; i += 1) out.push(items[Math.floor(i * stride)]);
  return out;
}

export const BACKFILL_ARTIFACTS: BackfillArea = {
  name: "backfill_artifacts",
  version: 1,
  kind: "backfill",
  sources: () => artifactScopes().flatMap((s) => s.sources),
  scopes: async () => {
    await refreshUnitIdCache();
    return artifactScopes();
  },

  async run(scope: BackfillScope, ctx: BackfillContext): Promise<{ rows: number }> {
    const rows = await runArtifactScope(scope.data as ArtifactScopeData, ctx);
    return { rows };
  },

  /**
   * §4.5's named assertion: for a deterministic sample of 200 files, re-run `analysisOutputs()` in
   * TypeScript and assert SET EQUALITY with the Postgres rows. ANY mismatch fails the slice.
   *
   * The oracle is `analysisOutputsFromDisk` — the ORIGINAL function, which survives the cutover precisely so
   * it can be the thing the new path is checked against (R3). It is UNIONED with `legacyTranscriptPath`,
   * because the 30 legacy transcripts are a placement the app's probe does not look in: the index knowing
   * about them is the POINT of area 7, not a disagreement with the oracle, and an oracle that ignored them
   * would fail the slice for being right.
   */
  async verify() {
    const mismatches: string[] = [];
    let checked = 0;

    // ONE discovery pass, held, so the apportionment below has a denominator and the walk is not done twice.
    const perUnit: Array<{ data: ArtifactScopeData; unitId: number; rels: string[] }> = [];
    for (const scope of artifactScopes()) {
      const data = scope.data as ArtifactScopeData;
      const unitId = await unitIdForRoot(data.root);
      if (unitId === null) continue;
      const rels = [...new Set(discoverArtifacts(data.root).map((f) => healWindowsPath(f.rel)))].sort();
      if (rels.length) perUnit.push({ data, unitId, rels });
    }
    const totalRels = perUnit.reduce((n, u) => n + u.rels.length, 0);

    for (const { data, unitId, rels } of perUnit) {
      // 200 across the WHOLE corpus, apportioned by how much of it each unit holds — a flat 200 per unit
      // would spend the entire sample on the first repo and never look at the SDLs, where the legacy
      // transcripts live. Every unit that has any artifact at all contributes at least one file, so a small
      // repo cannot be rounded out of the sample entirely.
      const share = Math.max(1, Math.round((SAMPLE_FILES * rels.length) / Math.max(1, totalRels)));
      const sample = sampleEvenly(rels, share);
      const rows = await readArtifactsForFiles(unitId, sample);
      const pgByRel = new Map<string, Set<string>>();
      for (const r of rows) {
        const s = pgByRel.get(r.rel_posix) ?? new Set<string>();
        s.add(r.kind);
        pgByRel.set(r.rel_posix, s);
      }
      for (const rel of sample) {
        checked += 1;
        const expected = new Set(analysisOutputsFromDisk(data.root, rel));
        if (legacyTranscriptPath(data.root, rel)) expected.add("transcript");
        const actual = pgByRel.get(rel) ?? new Set<string>();
        // The disk probe reports `compression` only while the record is FRESH and only when the name still
        // reads "should compress"; the INDEX records the record's existence either way, because freshness is
        // re-evaluated at read time against a live stat. So a `compression` row with no matching probe
        // result is expected and is not a mismatch — the reverse (a probe that says done with no row) is.
        const missing = [...expected].filter((k) => !actual.has(k));
        const extra = [...actual].filter((k) => !expected.has(k) && k !== "compression");
        if (missing.length || extra.length) {
          mismatches.push(
            `${data.key} ${rel}: missing [${missing.join(",")}] extra [${extra.join(",")}]`,
          );
        }
      }
    }
    const pgRows = await countFileArtifacts();
    log.info(
      "migrate",
      `backfill_artifacts: ${pgRows} artifact row(s); ${checked} file(s) checked against analysisOutputs()`,
    );
    return { yamlRows: checked, pgRows, mismatches };
  },
};

/** §4.5's sample size. Deliberately a named constant so the spec and the runner cannot drift apart. */
const SAMPLE_FILES = 200;

/**
 * Register areas 6 and 7, in that order.
 *
 * Both depend on area 2's `lfb.unit` rows (the FK target) and area 1's `device` / `person` rows (the join
 * targets), so they register after `registerUnitBackfills()` and the registry's insertion order is what runs
 * them in the right sequence.
 *
 * Explicit rather than a module-load side effect, so importing this file for one exported helper (the specs
 * import `readArtifactHeader` and `sampleEvenly`) does not silently mutate the global registry.
 */
export function registerSidecarBackfills(): void {
  registerBackfill(BACKFILL_SIDECARS);
  registerBackfill(BACKFILL_ARTIFACTS);
}
