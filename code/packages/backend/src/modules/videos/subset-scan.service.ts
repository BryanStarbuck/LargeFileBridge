// The SUBSET calc engine — the dedicated subset scan (subsets.mdx §8, LOCKED). VIDEOS ONLY. Its own
// single-flight detached run, its own `subset_scan` batch kind, its own run stamp — SEPARATE from the
// duplicate scan; one never satisfies the other's staleness clock (videos.mdx §4).
//
// Pipeline (§8):
//   1. candidates — every video LFB knows (reused enumeration, no fresh walk);
//   2. signature phase — MPEG-7 signature (bundled ffmpeg `signature` filter) cached per content hash,
//      computed only when missing/stale; the vPDQ frame list rides along for the cross-check. One batch
//      item per file;
//   3. pair pruning — ordered pairs (shorter, longer) with shorter ≤ 0.9 × longer; members of an
//      existing duplicate group (duplicates.csv) collapse to ONE representative first, so a duplicate
//      never masquerades as a subset;
//   4. match phase — vPDQ contiguous-run containment over the STORED frame lists prunes the pair list,
//      then the MPEG-7 two-input detect confirms and provides the authoritative offsets; a hit whose two
//      algorithms disagree is DROPPED (precision over recall — a wrong "this is inside that" claim
//      invites a wrong delete). One batch item per surviving pair;
//   5. group assembly — one superset + its confirmed subsets per group;
//   6. atomic subsets.csv write + subset_run.yaml stamp + "videos" live-refresh bump.
//
// SIGNAL ONLY — records relations, never touches a file. All computation is local (ffmpeg + the PDQ
// matcher); no sockets (charter).
import crypto from "node:crypto";
import fsp from "node:fs/promises";
import path from "node:path";
import type { MediaKind, VideosScanStatus } from "@lfb/shared";
import { VIDEOS_SCAN_STALE_DAYS } from "@lfb/shared";
import { createBatch, settleExternalItem, recordExternalFailure } from "../jobqueue/jobqueue.service.js";
import { writeManifest, trackBatch, settleOne } from "../jobqueue/batch-manifest.service.js";
import { begin, end } from "../progress/progress.registry.js";
import { bumpTopic, VIDEOS_TOPIC } from "../events/state-events.service.js";
import { coreBudget, mapLimit } from "../../shared/concurrency.js";
import { log, withLogContext } from "../../shared/logging.js";
import { collectKnownMedia } from "./known-media.js";
import { VideosCaches } from "./hash-cache.js";
import { probeVideoAttrs, toolOnPath, type MediaAttrs } from "./exec.js";
import {
  anySampledFrameMatch,
  ensureVpdqFrames,
  readVpdq,
  longestSharedRun,
  vpdqRelRef,
  type SharedRun,
  type VpdqFrame,
} from "./vpdq.service.js";
import {
  computeSignature,
  findContainment,
  hasSignature,
  mpeg7Available,
  signatureRelRef,
  type Containment,
} from "./mpeg7-signature.service.js";
import { readDuplicatesCsv } from "./dedupe-store.js";
import { writeSubsetsCsv, writeSubsetRunStamp, readSubsetRunStamp, type SubsetCsvRow } from "./subset-store.js";
import { SUBSET_SCAN_KIND, asProgressKind } from "./videos.kinds.js";

// §8 step 3 (LOCKED): only pairs where the shorter runs ≤ 0.9 × the longer are subset candidates —
// equal-length same-content pairs are the Duplicates page's territory.
const SUBSET_DURATION_RATIO = 0.9;
// The vPDQ contiguous run must cover this fraction of the subset's timeline to count as containment.
const VPDQ_MIN_COVERAGE = 0.7;
// Corroboration (§7.2): the vPDQ run's superset range and the MPEG-7 range must overlap by at least
// this fraction of the shorter of the two ranges — two independent algorithms agreeing is what lets
// the UI state a containment range with confidence.
const CORROBORATION_MIN_OVERLAP = 0.5;

interface SubsetFileInfo {
  abs: string;
  sizeBytes: number;
  sha256: string;
  attrs: MediaAttrs;
  durationS: number; // > 0 — files without a readable duration cannot be pruned and are excluded
}

interface ConfirmedHit {
  sub: SubsetFileInfo;
  sup: SubsetFileInfo;
  basis: "mpeg7" | "vpdq";
  startS: number;
  endS: number;
  confidence: number;
}

let running = false;

/** Staleness status for the "Start Subset Scan" pop-up (subsets.mdx §5) — its OWN 4-day clock. */
export function subsetStatus(): VideosScanStatus {
  const stamp = readSubsetRunStamp();
  const lastRunAt = stamp?.lastRunAt ?? null;
  const staleMs = VIDEOS_SCAN_STALE_DAYS * 24 * 60 * 60 * 1000;
  const stale = !lastRunAt || !Number.isFinite(Date.parse(lastRunAt)) || Date.now() - Date.parse(lastRunAt) >= staleMs;
  return { lastRunAt, running, recommend: !running && stale };
}

/** Start the subset scan detached; single-flight — `started: false` while one is already running. */
export function startSubsetScan(): { started: boolean } {
  if (running) {
    log.info("videos", "subset scan requested while one is running — coalesced (single-flight)");
    return { started: false };
  }
  running = true;
  runSubsetScan()
    .catch((e) => log.error("videos", `subset scan crashed: ${(e as Error).message}`))
    .finally(() => {
      running = false;
    });
  return { started: true };
}

/** Overlap fraction between two superset-time ranges, relative to the SHORTER range. */
function overlapFraction(aStart: number, aEnd: number, bStart: number, bEnd: number): number {
  const overlap = Math.min(aEnd, bEnd) - Math.max(aStart, bStart);
  const shorter = Math.min(aEnd - aStart, bEnd - bStart);
  if (shorter <= 0) return overlap >= 0 ? 1 : 0;
  return Math.max(0, overlap) / shorter;
}

async function runSubsetScan(): Promise<void> {
  const t0 = Date.now();
  if (!toolOnPath("ffmpeg")) {
    // Without ffmpeg there is no signature and no frame list — nothing this engine can do. An empty
    // completed run would silently reset the staleness clock over zero work, so we do NOT stamp.
    log.error("videos", "subset scan cannot run: ffmpeg is not installed (brew install ffmpeg)");
    return;
  }
  const candidates = await collectKnownMedia(new Set<MediaKind>(["video"]));
  log.info("videos", `subset scan: ${candidates.length} candidate video(s)`);

  const caches = new VideosCaches();
  // Phase 1 — identity + attributes (pre-plan; cheap relative to the signature/match phases). Files
  // whose duration cannot be read are excluded: the §8.3 pruning rule is meaningless without one.
  const width = Math.max(1, Math.floor(coreBudget() / 4));
  const infos: SubsetFileInfo[] = [];
  await mapLimit(candidates, width, async (c) => {
    try {
      const st = await fsp.stat(c.abs);
      const sha = await caches.sha256(c.abs, st.size, st.mtimeMs);
      const attrs = await probeVideoAttrs(c.abs);
      if (attrs.durationS === null || attrs.durationS <= 0) {
        log.debug("videos", `subset scan: no readable duration for ${c.abs} — excluded`);
        return;
      }
      infos.push({ abs: c.abs, sizeBytes: st.size, sha256: sha, attrs, durationS: attrs.durationS });
    } catch (e) {
      log.warn("videos", `subset scan: probe failed for ${c.abs}: ${(e as Error).message}`);
    }
  });

  // Phase 3a — collapse duplicate-group members to ONE representative (§8.3): the largest member of
  // each duplicates.csv group that is present here stands for the group; the rest never pair.
  const dupGroupByPath = new Map<string, string>();
  for (const row of readDuplicatesCsv()) dupGroupByPath.set(row.fullPath, row.group);
  const representativeOf = new Map<string, SubsetFileInfo>(); // duplicate group id → representative
  for (const f of infos) {
    const g = dupGroupByPath.get(f.abs);
    if (!g) continue;
    const cur = representativeOf.get(g);
    if (!cur || f.sizeBytes > cur.sizeBytes) representativeOf.set(g, f);
  }
  const paired = infos.filter((f) => {
    const g = dupGroupByPath.get(f.abs);
    return !g || representativeOf.get(g) === f;
  });

  // Phase 3b — ordered pairs (shorter, longer) with shorter ≤ 0.9 × longer.
  const pairs: Array<{ sub: SubsetFileInfo; sup: SubsetFileInfo }> = [];
  for (let i = 0; i < paired.length; i++) {
    for (let j = 0; j < paired.length; j++) {
      if (i === j) continue;
      const sub = paired[i];
      const sup = paired[j];
      if (sub.durationS <= SUBSET_DURATION_RATIO * sup.durationS) pairs.push({ sub, sup });
    }
  }

  // The batch: one item per file (signature phase) then one per pair (match phase) — subsets.mdx §6.
  const total = infos.length + pairs.length;
  // A zero-item plan is a COMPLETED (empty) run, not a batch — a total-0 batch row could never settle
  // its finishedAt (the fold is per-item), so it would hang "running" forever on the Processing page.
  if (total === 0) {
    caches.save();
    const detectedAt = new Date().toISOString();
    writeSubsetsCsv([]);
    writeSubsetRunStamp({
      lastRunAt: detectedAt,
      ok: true,
      counts: { candidates: candidates.length, files: 0, pairs: 0, groups: 0, subsets: 0 },
      durationMs: Date.now() - t0,
    });
    bumpTopic(VIDEOS_TOPIC);
    return;
  }
  const manifest = writeManifest({
    op: SUBSET_SCAN_KIND,
    scope: "this computer",
    counts: { candidates: candidates.length, files: infos.length, pairs: pairs.length },
    files: infos.map((f) => ({ path: f.abs, sizeBytes: f.sizeBytes })),
  });
  createBatch({
    batchId: manifest.batchId,
    kind: asProgressKind(SUBSET_SCAN_KIND),
    label: `Subset scan · ${infos.length} videos · ${pairs.length} pairs`,
    scope: "this computer",
    total,
    manifestPath: manifest.file,
  });
  trackBatch(manifest.batchId, total);

  await withLogContext({ batchId: manifest.batchId, op: SUBSET_SCAN_KIND }, async () => {
    const mpeg7 = await mpeg7Available();
    if (!mpeg7) {
      log.warn(
        "videos",
        "ffmpeg has no `signature` filter — subset matching falls back to vPDQ contiguous-run only (match_basis vpdq)",
      );
    }

    // Phase 2 — signatures + frame lists, missing/stale only (sha256-keyed caches). Item per file.
    // The frame lists are kept IN MEMORY for the match phase: the O(pairs) phase 4 must never re-read
    // and re-parse the same `.vpdq` file per pair (and readFileSync on the engine path is banned).
    const okFiles = new Set<string>();
    const framesBySha = new Map<string, VpdqFrame[]>();
    await mapLimit(infos, width, async (f) => {
      const jobId = begin(asProgressKind(SUBSET_SCAN_KIND), path.basename(f.abs));
      try {
        if (mpeg7) await computeSignature(f.abs, f.sha256);
        framesBySha.set(f.sha256, await ensureVpdqFrames(f.abs, f.sha256, f.durationS));
        okFiles.add(f.abs);
        settleOne(manifest.batchId, f.abs, "processed");
        settleExternalItem(manifest.batchId, { state: "ok", path: f.abs });
      } catch (e) {
        const reason = (e as Error).message;
        log.warn("videos", `subset scan: signature phase failed for ${f.abs}: ${reason}`);
        settleOne(manifest.batchId, f.abs, "failed", reason);
        settleExternalItem(manifest.batchId, { state: "failed", path: f.abs, reason });
        recordExternalFailure({ op: asProgressKind(SUBSET_SCAN_KIND), path: f.abs, reason, batchId: manifest.batchId });
      } finally {
        end(jobId);
      }
    });

    // Phase 4 — match. The two-input MPEG-7 detect re-decodes both videos, so it fans NARROW; the vPDQ
    // run test over STORED frame lists goes first and prunes the expensive detect down to real
    // candidates (the confirmed set is the intersection either way — §8.4 drops disagreements).
    const hits: ConfirmedHit[] = [];
    const pairWidth = Math.max(1, Math.floor(coreBudget() / 8));
    await mapLimit(pairs, pairWidth, async (p) => {
      const pairLabel = `${p.sub.abs} ⊂ ${p.sup.abs}`;
      const jobId = begin(asProgressKind(SUBSET_SCAN_KIND), `${path.basename(p.sub.abs)} ⊂ ${path.basename(p.sup.abs)}`);
      try {
        if (!okFiles.has(p.sub.abs) || !okFiles.has(p.sup.abs)) {
          settleOne(manifest.batchId, pairLabel, "skipped", "a member failed its signature phase");
          settleExternalItem(manifest.batchId, { state: "ok", path: pairLabel });
          return;
        }
        const hit = await matchPair(p.sub, p.sup, mpeg7, framesBySha);
        if (hit) hits.push(hit);
        settleOne(manifest.batchId, pairLabel, "processed", hit ? "containment confirmed" : undefined);
        settleExternalItem(manifest.batchId, { state: "ok", path: pairLabel });
      } catch (e) {
        const reason = (e as Error).message;
        log.warn("videos", `subset scan: match failed for ${pairLabel}: ${reason}`);
        settleOne(manifest.batchId, pairLabel, "failed", reason);
        settleExternalItem(manifest.batchId, { state: "failed", path: pairLabel, reason });
        recordExternalFailure({ op: asProgressKind(SUBSET_SCAN_KIND), path: pairLabel, reason, batchId: manifest.batchId });
      } finally {
        end(jobId);
      }
    });
    caches.save();

    // Phase 5 — one superset + all its confirmed subsets per group (§8.5).
    const bySuperset = new Map<string, ConfirmedHit[]>();
    for (const h of hits) {
      const list = bySuperset.get(h.sup.abs);
      if (list) list.push(h);
      else bySuperset.set(h.sup.abs, [h]);
    }
    const detectedAt = new Date().toISOString();
    const rows: SubsetCsvRow[] = [];
    for (const [supAbs, groupHits] of bySuperset) {
      const sup = groupHits[0].sup;
      const gid = crypto
        .createHash("sha1")
        .update([supAbs, ...groupHits.map((h) => h.sub.abs)].sort().join("\n"))
        .digest("hex")
        .slice(0, 8);
      const supBasis = groupHits.some((h) => h.basis === "mpeg7") ? "mpeg7" : "vpdq";
      rows.push({
        group: gid,
        fullPath: sup.abs,
        role: "superset",
        sha256: sup.sha256,
        fingerprint: hasSignature(sup.sha256) ? signatureRelRef(sup.sha256) : vpdqRelRef(sup.sha256),
        matchBasis: supBasis,
        startOffsetS: null,
        endOffsetS: null,
        confidence: Math.max(...groupHits.map((h) => h.confidence)),
        sizeBytes: sup.sizeBytes,
        durationS: sup.durationS,
        width: sup.attrs.width,
        height: sup.attrs.height,
        codec: sup.attrs.codec,
        detectedAt,
      });
      for (const h of groupHits.sort((a, b) => a.startS - b.startS)) {
        rows.push({
          group: gid,
          fullPath: h.sub.abs,
          role: "subset",
          sha256: h.sub.sha256,
          fingerprint: hasSignature(h.sub.sha256) ? signatureRelRef(h.sub.sha256) : vpdqRelRef(h.sub.sha256),
          matchBasis: h.basis,
          startOffsetS: Math.round(h.startS * 10) / 10,
          endOffsetS: Math.round(h.endS * 10) / 10,
          confidence: Math.round(h.confidence * 100) / 100,
          sizeBytes: h.sub.sizeBytes,
          durationS: h.sub.durationS,
          width: h.sub.attrs.width,
          height: h.sub.attrs.height,
          codec: h.sub.attrs.codec,
          detectedAt,
        });
      }
    }
    writeSubsetsCsv(rows);
    writeSubsetRunStamp({
      lastRunAt: detectedAt,
      ok: true,
      counts: {
        candidates: candidates.length,
        files: infos.length,
        pairs: pairs.length,
        groups: bySuperset.size,
        subsets: hits.length,
      },
      durationMs: Date.now() - t0,
    });
    bumpTopic(VIDEOS_TOPIC);
    log.info(
      "videos",
      `subset scan finished: ${bySuperset.size} group(s), ${hits.length} contained clip(s) from ${pairs.length} pair(s) in ${Math.round((Date.now() - t0) / 1000)}s`,
    );
  });
}

/**
 * One pruned pair through the two matchers (§8.4). vPDQ contiguous run over STORED frame lists first
 * (cheap, pure); the MPEG-7 detect then confirms and provides the authoritative offsets. Disagreement
 * drops the hit. When the signature filter is unavailable (or errors on this pair), a strong vPDQ run
 * stands alone with `match_basis: vpdq` (subsets.mdx §9 — cross-check-only confirmations).
 */
async function matchPair(
  sub: SubsetFileInfo,
  sup: SubsetFileInfo,
  mpeg7: boolean,
  framesBySha: Map<string, VpdqFrame[]>,
): Promise<ConfirmedHit | null> {
  // Phase 2 already holds both parsed lists in memory; the disk read is only a resume fallback.
  const subFrames = framesBySha.get(sub.sha256) ?? readVpdq(sub.sha256);
  const supFrames = framesBySha.get(sup.sha256) ?? readVpdq(sup.sha256);
  if (!subFrames?.length || !supFrames?.length) return null;
  // Sampled prefilter first — the O(|sub|·|sup|) run DP only spends CPU on plausible pairs.
  if (!anySampledFrameMatch(subFrames, supFrames)) return null;
  const run: SharedRun | null = longestSharedRun(subFrames, supFrames);
  if (!run || run.coverage < VPDQ_MIN_COVERAGE) return null;

  if (mpeg7) {
    let containment: Containment | null = null;
    let mpeg7Failed = false;
    try {
      containment = await findContainment(sub.abs, sup.abs, sub.durationS);
    } catch (e) {
      mpeg7Failed = true;
      log.warn("videos", `mpeg7 detect failed for ${sub.abs} ⊂ ${sup.abs} — falling back to vPDQ: ${(e as Error).message}`);
    }
    if (!mpeg7Failed) {
      if (!containment) return null; // primary says no — precision over recall (§8.4)
      const corroborated =
        overlapFraction(run.supStartTs, run.supEndTs, containment.startS, containment.endS) >= CORROBORATION_MIN_OVERLAP;
      if (!corroborated) {
        log.info(
          "videos",
          `subset hit dropped (offsets disagree): ${sub.abs} ⊂ ${sup.abs} — mpeg7 ${containment.startS.toFixed(1)}–${containment.endS.toFixed(1)}s vs vpdq ${run.supStartTs.toFixed(1)}–${run.supEndTs.toFixed(1)}s`,
        );
        return null;
      }
      return { sub, sup, basis: "mpeg7", startS: containment.startS, endS: containment.endS, confidence: containment.confidence };
    }
  }
  // vPDQ-only confirmation — offsets from the run itself; confidence capped below the two-algorithm bar.
  return {
    sub,
    sup,
    basis: "vpdq",
    startS: run.supStartTs,
    endS: run.supEndTs,
    confidence: Math.min(0.9, run.coverage),
  };
}
