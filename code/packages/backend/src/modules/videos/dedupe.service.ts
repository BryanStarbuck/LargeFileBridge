// The DUPLICATE calc engine — the dedicated duplicate-detection scan (duplicates.mdx §8, LOCKED).
// A single-flight, DETACHED background run (scan.mdx §10): startDedupeScan() kicks it off and returns
// immediately; navigation never cancels it; a second Start while one runs returns { started: false }.
// Tracked as a first-class `dedupe_scan` Processing batch (duplicates.mdx §6) — manifest written before
// work, live batch row adopting the manifest's id, one item per candidate file, every outcome folded at
// the settle seams the queue's own runners use.
//
// The engine is PROGRESSIVE (§8.3) — it publishes at every phase boundary instead of once at the end:
//   phase 0 — candidates: the persisted census UNIONED with a live media sweep, so a file copied in
//             since the last repo scan is a candidate (§8.4 — without this the engine cannot see both
//             copies of a just-made duplicate and grouping is impossible);
//   phase 1 — HASH: full-content sha256 for every candidate (streamed, cached, checkpointed), bucketed
//             by exact hash. Byte-identical groups are probed and PUBLISHED IMMEDIATELY — the fast
//             answer never waits on the slow one;
//   phase 2 — FINGERPRINT: perceptual fingerprints for everything not byte-grouped (plus ONE
//             representative per byte-identical group, whose sha-keyed value the whole group reuses),
//             then a stored-value compare — images by banded PDQ Hamming, videos by the symmetric vPDQ
//             shared-frame fraction. Republished periodically, then finally, with the run stamp closed.
//
// SIGNAL ONLY: the engine groups and records; it never deletes, replaces, or alters a file (charter).
import crypto from "node:crypto";
import fsp from "node:fs/promises";
import path from "node:path";
import type { MediaKind, PerceptualFingerprint, VideosScanPhase, VideosScanStatus } from "@lfb/shared";
import { VIDEOS_SCAN_PROMPT_QUIET_DAYS, VIDEOS_SCAN_STALE_DAYS } from "@lfb/shared";
import { fingerprintImage, sameContent, IMAGE_THRESHOLD_STRICT } from "../media/perceptual.service.js";
import { createBatch, settleExternalItem, recordExternalFailure } from "../jobqueue/jobqueue.service.js";
import { writeManifest, trackBatch, settleOne } from "../jobqueue/batch-manifest.service.js";
import { begin, end } from "../progress/progress.registry.js";
import { bumpTopic, VIDEOS_TOPIC } from "../events/state-events.service.js";
import { coreBudget, mapLimit } from "../../shared/concurrency.js";
import { log, withLogContext } from "../../shared/logging.js";
import { collectKnownMedia, type KnownMediaFile } from "./known-media.js";
import { VideosCaches } from "./hash-cache.js";
import { probeImageAttrs, probeVideoAttrs, toolOnPath, type MediaAttrs } from "./exec.js";
import { anySampledFrameMatch, ensureVpdqFrames, symmetricSharedFraction, vpdqRelRef, type VpdqFrame } from "./vpdq.service.js";
import { writeDuplicatesCsv, writeDedupeRunStamp, readDedupeRunStamp, type DuplicateCsvRow } from "./dedupe-store.js";
import { DEDUPE_SCAN_KIND, asProgressKind } from "./videos.kinds.js";

// Videos are duplicates only when a HIGH fraction of frames match in BOTH directions (§7.8) — the
// symmetry is what distinguishes a duplicate from a subset.
const VIDEO_DUP_FRACTION = 0.8;
// A pair whose shorter duration is ≤ 0.9 × the longer is SUBSET territory, not duplicate territory
// (subsets.mdx §8 step 3 draws the same boundary from the other side).
const DUP_DURATION_RATIO = 0.9;
// How often phase 2 republishes its partial results (§8.3) — fingerprint groups appear as they are found.
const REPUBLISH_MS = 60_000;

/** Everything the pure grouping pass needs to know about one candidate (tests inject these directly). */
export interface DedupeFileInfo {
  path: string;
  sizeBytes: number;
  kind: MediaKind; // "video" | "image"
  sha256: string;
  attrs: MediaAttrs;
  imageFp: PerceptualFingerprint | null; // images only
  frames: VpdqFrame[] | null; // videos only — the stored vPDQ frame list
}

export interface DuplicateGroup {
  id: string;
  basis: "sha256" | "fingerprint";
  members: DedupeFileInfo[];
}

// ── the pure grouping engine (§8.2 passes 1–2) — unit-tested with injected fakes ─────────────────────

function groupId(paths: string[]): string {
  return crypto.createHash("sha1").update([...paths].sort().join("\n")).digest("hex").slice(0, 8);
}

/** Union-find over file indices. */
class UnionFind {
  private parent: number[];
  constructor(n: number) {
    this.parent = Array.from({ length: n }, (_, i) => i);
  }
  find(i: number): number {
    while (this.parent[i] !== i) {
      this.parent[i] = this.parent[this.parent[i]];
      i = this.parent[i];
    }
    return i;
  }
  union(a: number, b: number): void {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra !== rb) this.parent[rb] = ra;
  }
}

/**
 * PASS 1 (§8.2) — bucket by exact FULL-CONTENT sha256. Any bucket with ≥ 2 files is a duplicate group.
 *
 * Deliberately keyed on the hash ALONE — never on file size first (§8.6). Bucketing by hash is a single
 * O(N) hash-map build: it is already optimal, and a size pre-bucket could only ever add a second index
 * to arrive at the same answer more slowly. (The tempting "sizes must match, so compare sizes first"
 * shortcut is a pairwise-comparison optimization; we never compare hashes pairwise.)
 */
export function groupByExactHash(files: readonly DedupeFileInfo[]): {
  groups: DuplicateGroup[];
  byteGrouped: Set<DedupeFileInfo>;
} {
  const bySha = new Map<string, DedupeFileInfo[]>();
  for (const f of files) {
    if (!f.sha256) continue;
    const list = bySha.get(f.sha256);
    if (list) list.push(f);
    else bySha.set(f.sha256, [f]);
  }
  const groups: DuplicateGroup[] = [];
  const byteGrouped = new Set<DedupeFileInfo>();
  for (const members of bySha.values()) {
    if (members.length < 2) continue;
    for (const m of members) byteGrouped.add(m);
    groups.push({ id: groupId(members.map((m) => m.path)), basis: "sha256", members });
  }
  return { groups, byteGrouped };
}

const BAND_CHARS = 2; // 2 hex chars = 8 bits per band
const NIBBLE_BITS = new Uint8Array([0, 1, 1, 2, 1, 2, 2, 3, 1, 2, 2, 3, 2, 3, 3, 4]);
const BAD_NIBBLE = 16; // a non-hex character — always counted as 4 differing bits, never as a match

/** Pre-parse a hex fingerprint into nibbles once, so a pair compare is array reads, not string parsing. */
function toNibbles(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length);
  for (let i = 0; i < hex.length; i++) {
    const v = parseInt(hex[i], 16);
    out[i] = Number.isNaN(v) ? BAD_NIBBLE : v;
  }
  return out;
}

/**
 * Hamming distance with EARLY ABORT: returns false the instant the running distance passes the
 * threshold. Most pairs are wildly different, so this exits after a handful of nibbles instead of
 * walking all 64 — and it never allocates.
 */
function withinThreshold(a: Uint8Array, b: Uint8Array, threshold: number): boolean {
  if (a.length !== b.length) return false; // enforced upstream too — length buckets never mix
  let d = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i];
    const y = b[i];
    d += x >= BAD_NIBBLE || y >= BAD_NIBBLE ? 4 : NIBBLE_BITS[x ^ y];
    if (d > threshold) return false;
  }
  return true;
}

/**
 * Union images whose stored fingerprints match, via exact LSH banding (§8.7).
 *
 * THE BUG THIS FIXES: the compare used to be a raw double loop over every non-byte-grouped file. On this
 * machine that is ~26,000 candidates — ~340 MILLION synchronous iterations, each one a function call
 * into sameContent() (which re-parses both 64-char hex strings, nibble by nibble, every time). That pins
 * the Node event loop — the whole app stops answering — for minutes.
 *
 * Banding is a PRE-FILTER WITH NO FALSE NEGATIVES, not an approximation. Split each 256-bit (64-hex)
 * fingerprint into 32 bands of 8 bits. Two fingerprints within the strict de-dup threshold differ in at
 * most IMAGE_THRESHOLD_STRICT (24) bits, so at most 24 bands can hold a differing bit and at least 8
 * bands MUST be byte-identical. Comparing only pairs that share ≥ 1 identical band therefore cannot miss
 * a real match — it only skips pairs that could not possibly have matched.
 *
 * Three further guards keep even a pathological corpus (thousands of near-identical flat images that all
 * collide in every band) cheap:
 *   • a pair is compared in the LOWEST band it collides in, so sharing 32 bands costs one compare, not 32;
 *   • already-united pairs are skipped outright (union-find is consulted before any comparison);
 *   • the compare itself is the early-abort nibble Hamming above, with sameContent() making the final,
 *     authoritative call (threshold + quality gate stay owned by perceptual.service.ts).
 *
 * Safety valve: the guarantee needs bandCount > threshold. A fingerprint too short for that (a 64-bit
 * fallback hash) falls back to full pairwise WITHIN its own length bucket rather than risking a miss.
 */
function unionImagesByFingerprint(
  items: Array<{ idx: number; value: string }>,
  rest: readonly DedupeFileInfo[],
  uf: UnionFind,
): void {
  const byLen = new Map<number, Array<{ idx: number; value: string }>>();
  for (const it of items) {
    const list = byLen.get(it.value.length);
    if (list) list.push(it);
    else byLen.set(it.value.length, [it]);
  }

  const nib = new Map<number, Uint8Array>();
  for (const it of items) nib.set(it.idx, toNibbles(it.value));

  const tryUnion = (ia: number, ib: number): void => {
    if (uf.find(ia) === uf.find(ib)) return; // already the same component — nothing to learn
    const na = nib.get(ia);
    const nb = nib.get(ib);
    if (!na || !nb) return;
    if (!withinThreshold(na, nb, IMAGE_THRESHOLD_STRICT)) return; // cheap reject, no allocation
    const a = rest[ia];
    const b = rest[ib];
    if (a.imageFp && b.imageFp && sameContent(a.imageFp, b.imageFp, { strict: true })) uf.union(ia, ib);
  };

  for (const [len, group] of byLen) {
    const bandCount = Math.floor(len / BAND_CHARS);
    // Different-length fingerprints are never candidates (a length difference alone already costs 4 bits
    // per character), so each length bucket is independent — and a bucket too short to band safely goes
    // full pairwise rather than risking a false negative.
    if (bandCount <= IMAGE_THRESHOLD_STRICT) {
      for (let i = 0; i < group.length; i++) {
        for (let j = i + 1; j < group.length; j++) tryUnion(group[i].idx, group[j].idx);
      }
      continue;
    }
    const value = new Map<number, string>(group.map((g) => [g.idx, g.value]));
    const buckets = new Map<string, number[]>();
    for (const it of group) {
      for (let b = 0; b < bandCount; b++) {
        const key = `${b}:${it.value.slice(b * BAND_CHARS, (b + 1) * BAND_CHARS)}`;
        const list = buckets.get(key);
        if (list) list.push(it.idx);
        else buckets.set(key, [it.idx]);
      }
    }
    for (const [key, list] of buckets) {
      if (list.length < 2) continue;
      const band = Number(key.slice(0, key.indexOf(":")));
      for (let i = 0; i < list.length; i++) {
        const va = value.get(list[i])!;
        for (let j = i + 1; j < list.length; j++) {
          const vb = value.get(list[j])!;
          // Compare this pair in the LOWEST band it collides in — otherwise a pair sharing many bands
          // would be re-tested once per shared band.
          let seenEarlier = false;
          for (let b = 0; b < band; b++) {
            const s = b * BAND_CHARS;
            if (va.charCodeAt(s) === vb.charCodeAt(s) && va.charCodeAt(s + 1) === vb.charCodeAt(s + 1)) {
              seenEarlier = true;
              break;
            }
          }
          if (!seenEarlier) tryUnion(list[i], list[j]);
        }
      }
    }
  }
}

/**
 * Candidate PAIRS for the video fingerprint compare (§8.7). Equal-ish length is already a REQUIREMENT of
 * being a duplicate (a much shorter same-content file is a subset, not a duplicate — DUP_DURATION_RATIO),
 * so sorting by duration and sweeping a window prunes exactly the pairs the pairwise loop would have
 * rejected on its first test. No false negatives: videos whose duration is unknown keep full pairwise
 * treatment, precisely as the original per-pair guard did (it only skipped when BOTH durations were known).
 */
function videoCandidatePairs(items: Array<{ idx: number; durationS: number | null }>): Array<[number, number]> {
  const known = items.filter((i) => i.durationS !== null && i.durationS > 0) as Array<{ idx: number; durationS: number }>;
  const unknown = items.filter((i) => i.durationS === null || i.durationS <= 0);
  known.sort((a, b) => a.durationS - b.durationS);
  const out: Array<[number, number]> = [];
  for (let i = 0; i < known.length; i++) {
    const limit = known[i].durationS / DUP_DURATION_RATIO;
    for (let j = i + 1; j < known.length && known[j].durationS <= limit; j++) {
      out.push([known[i].idx, known[j].idx]);
    }
  }
  // A video with no usable duration could pair with anything — keep it exhaustive rather than guess.
  for (let i = 0; i < unknown.length; i++) {
    for (const other of items) {
      if (other.idx === unknown[i].idx) continue;
      out.push([unknown[i].idx, other.idx]);
    }
  }
  return out;
}

/**
 * PASS 2 (§8.2) — stored perceptual fingerprints for everything pass 1 did not already group. Images
 * strict + quality-gated; videos by the symmetric shared-frame fraction. Never across media kinds.
 * Reads ONLY the stored values on the infos, never the media bytes (§7.8).
 */
export function groupByFingerprint(rest: readonly DedupeFileInfo[]): DuplicateGroup[] {
  const uf = new UnionFind(rest.length);

  const images: Array<{ idx: number; value: string }> = [];
  const videos: Array<{ idx: number; durationS: number | null }> = [];
  for (let i = 0; i < rest.length; i++) {
    const f = rest[i];
    if (f.kind === "image") {
      if (f.imageFp?.value) images.push({ idx: i, value: f.imageFp.value.toLowerCase() });
    } else if (f.frames?.length) {
      videos.push({ idx: i, durationS: f.attrs.durationS });
    }
  }

  unionImagesByFingerprint(images, rest, uf);
  for (const [i, j] of videoCandidatePairs(videos)) {
    const a = rest[i];
    const b = rest[j];
    const da = a.attrs.durationS;
    const db = b.attrs.durationS;
    if (da !== null && db !== null && da > 0 && db > 0 && Math.min(da, db) < DUP_DURATION_RATIO * Math.max(da, db)) {
      continue;
    }
    if (
      a.frames?.length &&
      b.frames?.length &&
      // Sampled prefilter first — the full O(F²) symmetric compare only runs on plausible pairs.
      anySampledFrameMatch(a.frames, b.frames) &&
      symmetricSharedFraction(a.frames, b.frames) >= VIDEO_DUP_FRACTION
    ) {
      uf.union(i, j);
    }
  }

  const components = new Map<number, DedupeFileInfo[]>();
  for (let i = 0; i < rest.length; i++) {
    const root = uf.find(i);
    const list = components.get(root);
    if (list) list.push(rest[i]);
    else components.set(root, [rest[i]]);
  }
  const groups: DuplicateGroup[] = [];
  for (const members of components.values()) {
    if (members.length < 2) continue;
    groups.push({ id: groupId(members.map((m) => m.path)), basis: "fingerprint", members });
  }
  return groups;
}

/**
 * Group candidates into duplicate groups: exact sha256 first, stored-fingerprint compare second
 * (duplicates.mdx §8.2). Pure — reads ONLY the stored values on the infos, never the media bytes
 * (§7.8), so a warm re-group costs nothing but comparisons.
 */
export function computeDuplicateGroups(files: DedupeFileInfo[]): DuplicateGroup[] {
  const { groups, byteGrouped } = groupByExactHash(files);
  return [...groups, ...groupByFingerprint(files.filter((f) => !byteGrouped.has(f)))];
}

// ── the detached, single-flight scan (§5–§6, scan.mdx §10) ────────────────────────────────────────────

let running = false;
let phase: VideosScanPhase = "idle";
let phaseDone = 0;
let phaseTotal = 0;

function setPhase(next: VideosScanPhase, total: number): void {
  phase = next;
  phaseDone = 0;
  phaseTotal = total;
}

/**
 * Status for the page's scan controls (duplicates.mdx §5.2) — TWO clocks, deliberately:
 *  · `recommend`     — the 4-day STALENESS clock (plus never-run / incomplete): "a scan would help".
 *  · `promptOnEntry` — may we INTERRUPT with the pop-up? `recommend` AND outside the 2-day QUIET
 *    window. A scan inside two days never prompts, complete or partial: `complete: false` never
 *    clears on its own, so without this a scan killed an hour ago nagged on every single visit.
 */
export function dedupeStatus(): VideosScanStatus {
  const stamp = readDedupeRunStamp();
  const lastRunAt = stamp?.lastRunAt ?? null;
  const lastRunMs = lastRunAt && Number.isFinite(Date.parse(lastRunAt)) ? Date.parse(lastRunAt) : null;
  const ageMs = lastRunMs == null ? Infinity : Date.now() - lastRunMs;
  const stale = ageMs >= VIDEOS_SCAN_STALE_DAYS * 24 * 60 * 60 * 1000;
  const quiet = ageMs < VIDEOS_SCAN_PROMPT_QUIET_DAYS * 24 * 60 * 60 * 1000;
  // A run that published partial results and then died is NOT a satisfied staleness clock (§8.5) — the
  // page shows what it got, and we still recommend finishing the job (but quietly, inside the window).
  const complete = stamp?.complete !== false;
  const recommend = !running && (stale || !complete);
  return {
    lastRunAt,
    running,
    recommend,
    promptOnEntry: recommend && !quiet,
    phase: running ? phase : "idle",
    phaseDone,
    phaseTotal,
    lastRunComplete: complete,
  };
}

/**
 * Start the duplicate scan in the background and return immediately (detached — the HTTP request never
 * owns the work). Single-flight: `started: false` while one is already running.
 *
 * duplicates.mdx §5.4 (LOCKED): the single-flight latch and the phase are set SYNCHRONOUSLY — so an
 * immediate second click coalesces and GET /status already reads `running: true` — but the run itself
 * is deferred with setImmediate() so the HTTP response FLUSHES FIRST. Calling runDedupeScan() inline
 * ran its synchronous prologue (config reads, unit enumeration) on the request's stack, which delayed
 * the response and made the page look hung behind the pop-up.
 */
export function startDedupeScan(): { started: boolean } {
  if (running) {
    log.info("videos", "duplicate scan requested while one is running — coalesced (single-flight)");
    return { started: false };
  }
  running = true;
  setPhase("candidates", 0); // truthful the instant the caller's next status poll lands
  setImmediate(() => {
    runDedupeScan()
      .catch((e) => log.error("videos", `duplicate scan crashed: ${(e as Error).message}`))
      .finally(() => {
        running = false;
        setPhase("idle", 0);
      });
  });
  return { started: true };
}

/** One member's CSV row, with the fingerprint column resolved from the sha-keyed caches (§7.7). */
function toCsvRow(m: DedupeFileInfo, group: DuplicateGroup, caches: VideosCaches, detectedAt: string): DuplicateCsvRow {
  const fp =
    m.kind === "image"
      ? (m.imageFp?.value ?? caches.imageFp(m.sha256)?.value ?? "")
      : m.frames?.length
        ? vpdqRelRef(m.sha256)
        : "";
  return {
    group: group.id,
    fullPath: m.path,
    sha256: m.sha256,
    fingerprint: fp,
    matchBasis: group.basis,
    sizeBytes: m.sizeBytes,
    durationS: m.attrs.durationS,
    width: m.attrs.width,
    height: m.attrs.height,
    codec: m.attrs.codec,
    detectedAt,
  };
}

function publish(groups: DuplicateGroup[], caches: VideosCaches): { rows: number; groups: number } {
  const detectedAt = new Date().toISOString();
  const rows: DuplicateCsvRow[] = [];
  for (const g of groups) for (const m of g.members) rows.push(toCsvRow(m, g, caches, detectedAt));
  writeDuplicatesCsv(rows);
  bumpTopic(VIDEOS_TOPIC);
  return { rows: rows.length, groups: groups.length };
}

async function runDedupeScan(): Promise<void> {
  const t0 = Date.now();
  log.info("videos", "duplicate calc engine STARTED");

  // Phase 0 — candidates. Freshened against the disk so a file created since the last repo scan is a
  // candidate (§8.4); without this the engine cannot see both copies of a just-made duplicate.
  setPhase("candidates", 0);
  const candidates = await collectKnownMedia(new Set<MediaKind>(["video", "image"]), { freshen: true });
  // Videos first, images second (videos.mdx §2 — the primary/secondary scope order).
  candidates.sort((a, b) => (a.kind === b.kind ? 0 : a.kind === "video" ? -1 : 1));
  log.info("videos", `duplicate scan: ${candidates.length} candidate media file(s)`);

  // Zero candidates is a COMPLETED (empty) run, not a batch: a total-0 batch row could never settle
  // its finishedAt (the fold is per-item), so it would hang "running" forever on the Processing page.
  if (candidates.length === 0) {
    const detectedAt = new Date().toISOString();
    writeDuplicatesCsv([]);
    writeDedupeRunStamp({
      lastRunAt: detectedAt,
      ok: true,
      complete: true,
      phase: "fingerprint",
      counts: { candidates: 0, files: 0, groups: 0 },
      durationMs: Date.now() - t0,
    });
    bumpTopic(VIDEOS_TOPIC);
    log.info("videos", "duplicate calc engine FINISHED: no candidates");
    return;
  }

  // The durable intent record BEFORE any work (processing_batches.mdx), then the live batch row
  // ADOPTING the manifest's id — one item per candidate file (duplicates.mdx §6).
  const manifest = writeManifest({
    op: DEDUPE_SCAN_KIND,
    scope: "this computer",
    counts: { candidates: candidates.length },
    files: candidates.map((c) => ({ path: c.abs, sizeBytes: c.sizeBytes })),
  });
  createBatch({
    batchId: manifest.batchId,
    kind: asProgressKind(DEDUPE_SCAN_KIND),
    label: `Duplicate scan · ${candidates.length} files`,
    scope: "this computer",
    total: candidates.length,
    manifestPath: manifest.file,
  });
  trackBatch(manifest.batchId, candidates.length);

  await withLogContext({ batchId: manifest.batchId, op: DEDUPE_SCAN_KIND }, async () => {
    const caches = new VideosCaches();
    const ffmpeg = toolOnPath("ffmpeg");
    if (!ffmpeg) {
      log.warn("videos", "ffmpeg not on PATH — videos get byte-identity grouping only (no frame fingerprints)");
    }

    // ── PHASE 1 — HASH (§8.3) ────────────────────────────────────────────────────────────────────────
    // Every candidate settles its batch item here: the fast pass is the one pass EVERY candidate goes
    // through, so the Processing counter tracks real, monotonic progress instead of sitting at 0 for
    // however long the fingerprint pass takes. Phase-2 work reports through the progress registry and
    // the `phase` field on the status route.
    const tHash = Date.now();
    setPhase("hash", candidates.length);
    log.info("videos", `phase 1/2 HASH started — sha256 over ${candidates.length} candidate(s)`);
    const infos: DedupeFileInfo[] = [];
    // Hashing is disk-bound streaming, not process spawning — the full core budget is right here.
    await mapLimit(candidates, Math.max(1, coreBudget()), async (c) => {
      const info = await hashOneFile(c, caches, manifest.batchId);
      if (info) infos.push(info);
      phaseDone += 1;
    });
    caches.save();

    const { groups: shaGroups, byteGrouped } = groupByExactHash(infos);
    // Display attributes only for files that actually made a group — probing all 26k candidates would
    // spawn an ffprobe per video for rows nobody will ever see.
    await probeAttrsFor(shaGroups.flatMap((g) => g.members));
    const p1 = publish(shaGroups, caches);
    const hashSecs = Math.round((Date.now() - tHash) / 1000);
    writeDedupeRunStamp({
      lastRunAt: new Date().toISOString(),
      ok: true,
      complete: false, // partial — phase 2 has not run yet (§8.5)
      phase: "hash",
      counts: { candidates: candidates.length, files: p1.rows, groups: p1.groups },
      durationMs: Date.now() - t0,
    });
    log.info(
      "videos",
      `phase 1/2 HASH finished in ${hashSecs}s: ${p1.groups} byte-identical group(s), ${p1.rows} member row(s) ` +
        `PUBLISHED to duplicates.csv (the page has results now); ${infos.length - byteGrouped.size} file(s) go to phase 2`,
    );

    // ── PHASE 2 — FINGERPRINT (§8.3) ─────────────────────────────────────────────────────────────────
    // Work list: every file phase 1 did not group, PLUS one representative per byte-identical group.
    // The representative fills in the CSV's fingerprint column for its whole group at the cost of a
    // single computation — the fingerprint caches are keyed by sha256, and byte-identical files share
    // a sha256 by definition (§7.6 "compute only what is missing").
    const rest = infos.filter((f) => !byteGrouped.has(f));
    const reps = shaGroups.map((g) => g.members[0]);
    const work = [...rest, ...reps];
    const tFp = Date.now();
    setPhase("fingerprint", work.length);
    log.info("videos", `phase 2/2 FINGERPRINT started — ${work.length} file(s) to fingerprint`);

    let lastPublish = Date.now();
    const width = Math.max(1, Math.floor(coreBudget() / 4)); // shells out to ffmpeg/ffprobe — stay narrow
    await mapLimit(work, width, async (f) => {
      await fingerprintOneFile(f, caches, ffmpeg);
      phaseDone += 1;
      caches.maybeSave();
      // Republish periodically so fingerprint groups appear as they are found, not only at the end.
      if (Date.now() - lastPublish >= REPUBLISH_MS) {
        lastPublish = Date.now();
        try {
          const partial = [...shaGroups, ...groupByFingerprint(rest)];
          publish(partial, caches);
          log.info("videos", `phase 2/2 progress: ${phaseDone}/${phaseTotal} fingerprinted, ${partial.length} group(s) so far`);
        } catch (e) {
          log.warn("videos", `interim publish failed (results still land at the end): ${(e as Error).message}`);
        }
      }
    });
    caches.save();

    const fpGroups = groupByFingerprint(rest);
    await probeAttrsFor(fpGroups.flatMap((g) => g.members));
    const all = [...shaGroups, ...fpGroups];
    const final = publish(all, caches);
    writeDedupeRunStamp({
      lastRunAt: new Date().toISOString(),
      ok: true,
      complete: true,
      phase: "fingerprint",
      counts: { candidates: candidates.length, files: final.rows, groups: final.groups },
      durationMs: Date.now() - t0,
    });
    log.info(
      "videos",
      `phase 2/2 FINGERPRINT finished in ${Math.round((Date.now() - tFp) / 1000)}s: ` +
        `${fpGroups.length} perceptual group(s)`,
    );
    log.info(
      "videos",
      `duplicate calc engine FINISHED: ${final.groups} group(s) (${shaGroups.length} sha256, ${fpGroups.length} ` +
        `fingerprint), ${final.rows} member row(s) from ${candidates.length} candidates in ` +
        `${Math.round((Date.now() - t0) / 1000)}s`,
    );
  });
}

/** Probe display attributes for exactly the files that made a group (§8.2 step 3), in place. */
async function probeAttrsFor(members: DedupeFileInfo[]): Promise<void> {
  const need = members.filter((m) => m.attrs.width === null && m.attrs.height === null && m.attrs.codec === null);
  if (need.length === 0) return;
  await mapLimit(need, Math.max(1, Math.floor(coreBudget() / 4)), async (m) => {
    try {
      m.attrs = m.kind === "image" ? await probeImageAttrs(m.path) : await probeVideoAttrs(m.path);
    } catch (e) {
      log.warn("videos", `attribute probe failed for ${m.path}: ${(e as Error).message}`);
    }
  });
}

const NO_ATTRS: MediaAttrs = { durationS: null, width: null, height: null, codec: null };

/** PHASE 1 per file: stat + full-content sha256, with its batch item settled here (§8.3). */
async function hashOneFile(c: KnownMediaFile, caches: VideosCaches, batchId: string): Promise<DedupeFileInfo | null> {
  const jobId = begin(asProgressKind(DEDUPE_SCAN_KIND), path.basename(c.abs));
  try {
    let st;
    try {
      st = await fsp.stat(c.abs);
    } catch {
      // The candidate list can outrun the disk — a vanished file is a skip, not a failure.
      settleOne(batchId, c.abs, "skipped", "file no longer exists");
      settleExternalItem(batchId, { state: "ok", path: c.abs });
      return null;
    }
    const sha = await caches.sha256(c.abs, st.size, st.mtimeMs);
    caches.maybeSave(); // checkpoint — an interrupted run keeps the hashing it already paid for (§8.5)
    settleOne(batchId, c.abs, "processed");
    settleExternalItem(batchId, { state: "ok", path: c.abs });
    return { path: c.abs, sizeBytes: st.size, kind: c.kind, sha256: sha, attrs: { ...NO_ATTRS }, imageFp: null, frames: null };
  } catch (e) {
    const reason = (e as Error).message;
    log.warn("videos", `duplicate scan item failed for ${c.abs}: ${reason}`);
    settleOne(batchId, c.abs, "failed", reason);
    settleExternalItem(batchId, { state: "failed", path: c.abs, reason });
    recordExternalFailure({ op: asProgressKind(DEDUPE_SCAN_KIND), path: c.abs, reason, batchId });
    return null;
  } finally {
    end(jobId);
  }
}

/** PHASE 2 per file: the perceptual fingerprint. A failure loses a SIGNAL, never the item (§7.6). */
async function fingerprintOneFile(f: DedupeFileInfo, caches: VideosCaches, ffmpeg: boolean): Promise<void> {
  const jobId = begin(asProgressKind(DEDUPE_SCAN_KIND), path.basename(f.path));
  try {
    if (f.kind === "image") {
      f.imageFp = caches.imageFp(f.sha256);
      if (!f.imageFp) {
        try {
          f.imageFp = await fingerprintImage(f.path);
          caches.rememberImageFp(f.sha256, f.imageFp);
        } catch (e) {
          log.warn("videos", `image fingerprint failed for ${f.path}: ${(e as Error).message}`);
        }
      }
    } else {
      // The duration gate needs real attributes, and ensureVpdqFrames samples against them.
      if (f.attrs.durationS === null) {
        try {
          f.attrs = await probeVideoAttrs(f.path);
        } catch (e) {
          log.warn("videos", `video probe failed for ${f.path}: ${(e as Error).message}`);
        }
      }
      if (ffmpeg) {
        try {
          f.frames = await ensureVpdqFrames(f.path, f.sha256, f.attrs.durationS);
        } catch (e) {
          log.warn("videos", `vpdq frames failed for ${f.path}: ${(e as Error).message}`);
        }
      }
    }
  } finally {
    end(jobId);
  }
}
