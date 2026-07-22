// The DUPLICATE calc engine — the dedicated duplicate-detection scan (duplicates.mdx §8, LOCKED).
// A single-flight, DETACHED background run (scan.mdx §10): startDedupeScan() kicks it off and returns
// immediately; navigation never cancels it; a second Start while one runs returns { started: false }.
// Tracked as a first-class `dedupe_scan` Processing batch (duplicates.mdx §6) — manifest written before
// work, live batch row adopting the manifest's id, one item per candidate file, every outcome folded at
// the settle seams the queue's own runners use.
//
// The engine (§8.2):
//   pass 1 — bucket by exact FULL-CONTENT sha256 (byte-identical copies; async streamed, cached);
//   pass 2 — perceptual fingerprints for everything not byte-grouped: images through the EXISTING
//            fingerprintImage/sameContent boundary (strict threshold + quality gate), videos by the
//            SYMMETRIC vPDQ shared-frame fraction over stored frame lists; connected components of
//            matches become groups with match_basis "fingerprint";
//   pass 3 — display-attribute probe (ffprobe/sharp, async, all local);
//   pass 4 — atomic duplicates.csv write + dedupe_run.yaml stamp + "videos" live-refresh bump.
//
// SIGNAL ONLY: the engine groups and records; it never deletes, replaces, or alters a file (charter).
import crypto from "node:crypto";
import fsp from "node:fs/promises";
import path from "node:path";
import type { MediaKind, PerceptualFingerprint, VideosScanStatus } from "@lfb/shared";
import { VIDEOS_SCAN_STALE_DAYS } from "@lfb/shared";
import { fingerprintImage, sameContent } from "../media/perceptual.service.js";
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
 * Group candidates into duplicate groups: exact sha256 first, stored-fingerprint compare second
 * (duplicates.mdx §8.2). Pure — reads ONLY the stored values on the infos, never the media bytes
 * (§7.8), so a warm re-group costs nothing but comparisons.
 */
export function computeDuplicateGroups(files: DedupeFileInfo[]): DuplicateGroup[] {
  const groups: DuplicateGroup[] = [];

  // Pass 1 — exact content hash. Any bucket with ≥ 2 files is a group; its members never enter pass 2.
  const bySha = new Map<string, DedupeFileInfo[]>();
  for (const f of files) {
    if (!f.sha256) continue;
    const list = bySha.get(f.sha256);
    if (list) list.push(f);
    else bySha.set(f.sha256, [f]);
  }
  const byteGrouped = new Set<DedupeFileInfo>();
  for (const members of bySha.values()) {
    if (members.length < 2) continue;
    for (const m of members) byteGrouped.add(m);
    groups.push({ id: groupId(members.map((m) => m.path)), basis: "sha256", members });
  }

  // Pass 2 — stored perceptual fingerprints for the rest. Images strict + quality-gated; videos by the
  // symmetric shared-frame fraction. Never across media kinds.
  const rest = files.filter((f) => !byteGrouped.has(f));
  const uf = new UnionFind(rest.length);
  for (let i = 0; i < rest.length; i++) {
    for (let j = i + 1; j < rest.length; j++) {
      const a = rest[i];
      const b = rest[j];
      if (a.kind !== b.kind) continue;
      if (a.kind === "image") {
        if (a.imageFp && b.imageFp && sameContent(a.imageFp, b.imageFp, { strict: true })) uf.union(i, j);
      } else {
        // Equal-ish length is part of being a DUPLICATE — a much-shorter same-content file is a subset.
        const da = a.attrs.durationS;
        const db = b.attrs.durationS;
        if (da !== null && db !== null && da > 0 && db > 0 && Math.min(da, db) < DUP_DURATION_RATIO * Math.max(da, db)) {
          continue;
        }
        if (
          a.frames?.length &&
          b.frames?.length &&
          // Sampled prefilter first — the full O(F²) symmetric compare only runs on plausible pairs,
          // keeping the N² pass from pinning the event loop on all-miss comparisons.
          anySampledFrameMatch(a.frames, b.frames) &&
          symmetricSharedFraction(a.frames, b.frames) >= VIDEO_DUP_FRACTION
        ) {
          uf.union(i, j);
        }
      }
    }
  }
  const components = new Map<number, DedupeFileInfo[]>();
  for (let i = 0; i < rest.length; i++) {
    const root = uf.find(i);
    const list = components.get(root);
    if (list) list.push(rest[i]);
    else components.set(root, [rest[i]]);
  }
  for (const members of components.values()) {
    if (members.length < 2) continue;
    groups.push({ id: groupId(members.map((m) => m.path)), basis: "fingerprint", members });
  }
  return groups;
}

// ── the detached, single-flight scan (§5–§6, scan.mdx §10) ────────────────────────────────────────────

let running = false;

/** Staleness status for the Start-Scan pop-up (duplicates.mdx §5): last completed run + 4-day clock. */
export function dedupeStatus(): VideosScanStatus {
  const stamp = readDedupeRunStamp();
  const lastRunAt = stamp?.lastRunAt ?? null;
  const staleMs = VIDEOS_SCAN_STALE_DAYS * 24 * 60 * 60 * 1000;
  const stale = !lastRunAt || !Number.isFinite(Date.parse(lastRunAt)) || Date.now() - Date.parse(lastRunAt) >= staleMs;
  return { lastRunAt, running, recommend: !running && stale };
}

/**
 * Start the duplicate scan in the background and return immediately (detached — the HTTP request never
 * owns the work). Single-flight: `started: false` while one is already running.
 */
export function startDedupeScan(): { started: boolean } {
  if (running) {
    log.info("videos", "duplicate scan requested while one is running — coalesced (single-flight)");
    return { started: false };
  }
  running = true;
  runDedupeScan()
    .catch((e) => log.error("videos", `duplicate scan crashed: ${(e as Error).message}`))
    .finally(() => {
      running = false;
    });
  return { started: true };
}

async function runDedupeScan(): Promise<void> {
  const t0 = Date.now();
  const candidates = await collectKnownMedia(new Set<MediaKind>(["video", "image"]));
  // Videos first, images second (videos.mdx §2 — the primary/secondary scope order).
  candidates.sort((a, b) => (a.kind === b.kind ? 0 : a.kind === "video" ? -1 : 1));
  log.info("videos", `duplicate scan: ${candidates.length} candidate media file(s)`);

  // Zero candidates is a COMPLETED (empty) run, not a batch: a total-0 batch row could never settle
  // its finishedAt (the fold is per-item), so it would hang "running" forever on the Processing page.
  if (candidates.length === 0) {
    const detectedAt = new Date().toISOString();
    writeDuplicatesCsv([]);
    writeDedupeRunStamp({ lastRunAt: detectedAt, ok: true, counts: { candidates: 0, files: 0, groups: 0 }, durationMs: Date.now() - t0 });
    bumpTopic(VIDEOS_TOPIC);
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
    const infos: DedupeFileInfo[] = [];
    const ffmpeg = toolOnPath("ffmpeg");
    if (!ffmpeg) {
      log.warn("videos", "ffmpeg not on PATH — videos get byte-identity grouping only (no frame fingerprints)");
    }
    // Fan out per file, NARROW (the per-file work shells out to ffmpeg/ffprobe): budget/4, floor 1.
    const width = Math.max(1, Math.floor(coreBudget() / 4));
    await mapLimit(candidates, width, async (c) => {
      const info = await dedupeOneFile(c, caches, ffmpeg, manifest.batchId);
      if (info) infos.push(info);
    });
    caches.save();

    const groups = computeDuplicateGroups(infos);
    const detectedAt = new Date().toISOString();
    const rows: DuplicateCsvRow[] = [];
    for (const g of groups) {
      for (const m of g.members) {
        rows.push({
          group: g.id,
          fullPath: m.path,
          sha256: m.sha256,
          // Text-encoded per §7.7: images carry the 64-hex inline; videos reference their `.vpdq` list.
          fingerprint: m.kind === "image" ? (m.imageFp?.value ?? "") : m.frames?.length ? vpdqRelRef(m.sha256) : "",
          matchBasis: g.basis,
          sizeBytes: m.sizeBytes,
          durationS: m.attrs.durationS,
          width: m.attrs.width,
          height: m.attrs.height,
          codec: m.attrs.codec,
          detectedAt,
        });
      }
    }
    writeDuplicatesCsv(rows);
    writeDedupeRunStamp({
      lastRunAt: detectedAt,
      ok: true,
      counts: { candidates: candidates.length, files: rows.length, groups: groups.length },
      durationMs: Date.now() - t0,
    });
    bumpTopic(VIDEOS_TOPIC);
    log.info(
      "videos",
      `duplicate scan finished: ${groups.length} group(s), ${rows.length} member row(s) from ${candidates.length} candidates in ${Math.round((Date.now() - t0) / 1000)}s`,
    );
  });
}

/** One candidate through hash + fingerprint + probe, with its item settled at the shared seams. */
async function dedupeOneFile(
  c: KnownMediaFile,
  caches: VideosCaches,
  ffmpeg: boolean,
  batchId: string,
): Promise<DedupeFileInfo | null> {
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
    let attrs: MediaAttrs;
    let imageFp: PerceptualFingerprint | null = null;
    let frames: VpdqFrame[] | null = null;
    if (c.kind === "image") {
      attrs = await probeImageAttrs(c.abs);
      imageFp = caches.imageFp(sha);
      if (!imageFp) {
        // §7.6 — compute only what is missing; a fingerprint failure loses a signal, never the item.
        try {
          imageFp = await fingerprintImage(c.abs);
          caches.rememberImageFp(sha, imageFp);
        } catch (e) {
          log.warn("videos", `image fingerprint failed for ${c.abs}: ${(e as Error).message}`);
        }
      }
    } else {
      attrs = await probeVideoAttrs(c.abs);
      if (ffmpeg) {
        try {
          frames = await ensureVpdqFrames(c.abs, sha, attrs.durationS);
        } catch (e) {
          log.warn("videos", `vpdq frames failed for ${c.abs}: ${(e as Error).message}`);
        }
      }
    }
    settleOne(batchId, c.abs, "processed");
    settleExternalItem(batchId, { state: "ok", path: c.abs });
    return { path: c.abs, sizeBytes: st.size, kind: c.kind, sha256: sha, attrs, imageFp, frames };
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
