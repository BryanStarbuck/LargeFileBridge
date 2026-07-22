// REST for the Videos review screens (videos.mdx; duplicates.mdx §3.2/§5/§6; subsets.mdx §3/§5/§6).
// Allow-list-gated like every data route. The list endpoints read ONLY the scan CSVs (the pages never
// re-derive groups — duplicates.mdx §9); the scan endpoints are DETACHED and single-flight (scan.mdx
// §10): they return { started } immediately and the work reports through the Processing surfaces.
import { Router } from "express";
import path from "node:path";
import type {
  DuplicateMemberRow,
  DuplicatesListResponse,
  SubsetMemberRow,
  SubsetsListResponse,
} from "@lfb/shared";
import { requireAllowListed } from "../auth/identify.js";
import { log } from "../../shared/logging.js";
import { readDuplicatesCsv } from "./dedupe-store.js";
import { readSubsetsCsv } from "./subset-store.js";
import { dedupeStatus, startDedupeScan } from "./dedupe.service.js";
import { subsetStatus, startSubsetScan } from "./subset-scan.service.js";
import { buildIconStateIndex, EMPTY_ICON_STATE, type IconState } from "./known-media.js";

export const videosRouter = Router();
videosRouter.use(requireAllowListed);

// GET /api/videos/duplicates — the review table's rows from duplicates.csv, groups sorted by
// reclaimable bytes descending (duplicates.mdx §3.2), icon-state enriched best-effort.
videosRouter.get("/duplicates", async (_req, res) => {
  try {
    const csv = readDuplicatesCsv();
    const icons = await safeIconIndex();
    const groups = new Map<string, DuplicateMemberRow[]>();
    for (const r of csv) {
      const icon = icons.get(r.fullPath) ?? EMPTY_ICON_STATE;
      const row: DuplicateMemberRow = {
        group: r.group,
        matchBasis: r.matchBasis,
        fullPath: r.fullPath,
        name: path.basename(r.fullPath),
        sizeBytes: r.sizeBytes,
        durationS: r.durationS,
        width: r.width,
        height: r.height,
        codec: r.codec,
        sha256: r.sha256,
        fingerprint: r.fingerprint,
        detectedAt: r.detectedAt,
        ...icon,
      };
      const list = groups.get(r.group);
      if (list) list.push(row);
      else groups.set(r.group, [row]);
    }
    // Reclaimable bytes = sum of member sizes minus the largest member (§3.2) — most disk-winning first.
    const ordered = [...groups.values()]
      .map((members) => {
        members.sort((a, b) => b.sizeBytes - a.sizeBytes);
        const total = members.reduce((s, m) => s + m.sizeBytes, 0);
        return { members, reclaimable: total - (members[0]?.sizeBytes ?? 0) };
      })
      .sort((a, b) => b.reclaimable - a.reclaimable);
    const rows = ordered.flatMap((g) => g.members);
    const data: DuplicatesListResponse = { rows, groupCount: groups.size, fileCount: rows.length };
    res.json({ ok: true, data });
  } catch (e) {
    log.error("videos", `duplicates list failed: ${(e as Error).message}`);
    res.status(500).json({ ok: false, error: (e as Error).message });
  }
});

// GET /api/videos/duplicates/status — the Start-Scan pop-up's staleness read (duplicates.mdx §5).
videosRouter.get("/duplicates/status", (_req, res) => {
  try {
    res.json({ ok: true, data: dedupeStatus() });
  } catch (e) {
    log.error("videos", `duplicates status failed: ${(e as Error).message}`);
    res.status(500).json({ ok: false, error: (e as Error).message });
  }
});

// POST /api/videos/duplicates/scan — start the detached duplicate scan; single-flight (§6).
videosRouter.post("/duplicates/scan", (_req, res) => {
  try {
    res.json({ ok: true, data: startDedupeScan() });
  } catch (e) {
    log.error("videos", `duplicate scan start failed: ${(e as Error).message}`);
    res.status(500).json({ ok: false, error: (e as Error).message });
  }
});

// GET /api/videos/subsets — the review table's rows from subsets.csv: groups sorted by reclaimable
// bytes (sum of subset sizes) descending, superset row first, subsets by containment start (subsets.mdx §3).
videosRouter.get("/subsets", async (_req, res) => {
  try {
    const csv = readSubsetsCsv();
    const icons = await safeIconIndex();
    const groups = new Map<string, SubsetMemberRow[]>();
    for (const r of csv) {
      const icon = icons.get(r.fullPath) ?? EMPTY_ICON_STATE;
      const row: SubsetMemberRow = {
        group: r.group,
        role: r.role,
        fullPath: r.fullPath,
        name: path.basename(r.fullPath),
        sizeBytes: r.sizeBytes,
        durationS: r.durationS,
        width: r.width,
        height: r.height,
        codec: r.codec,
        sha256: r.sha256,
        fingerprint: r.fingerprint,
        matchBasis: r.matchBasis,
        startOffsetS: r.startOffsetS,
        endOffsetS: r.endOffsetS,
        confidence: r.confidence,
        detectedAt: r.detectedAt,
        ...icon,
      };
      const list = groups.get(r.group);
      if (list) list.push(row);
      else groups.set(r.group, [row]);
    }
    const ordered = [...groups.values()]
      .map((members) => {
        members.sort((a, b) => {
          if (a.role !== b.role) return a.role === "superset" ? -1 : 1; // superset row first (§3)
          return (a.startOffsetS ?? 0) - (b.startOffsetS ?? 0);
        });
        const reclaimable = members.filter((m) => m.role === "subset").reduce((s, m) => s + m.sizeBytes, 0);
        return { members, reclaimable };
      })
      .sort((a, b) => b.reclaimable - a.reclaimable);
    const rows = ordered.flatMap((g) => g.members);
    const data: SubsetsListResponse = { rows, groupCount: groups.size, fileCount: rows.length };
    res.json({ ok: true, data });
  } catch (e) {
    log.error("videos", `subsets list failed: ${(e as Error).message}`);
    res.status(500).json({ ok: false, error: (e as Error).message });
  }
});

// GET /api/videos/subsets/status — the subset pop-up's staleness read; its OWN clock (subsets.mdx §5).
videosRouter.get("/subsets/status", (_req, res) => {
  try {
    res.json({ ok: true, data: subsetStatus() });
  } catch (e) {
    log.error("videos", `subsets status failed: ${(e as Error).message}`);
    res.status(500).json({ ok: false, error: (e as Error).message });
  }
});

// POST /api/videos/subsets/scan — start the detached subset scan; single-flight (subsets.mdx §6).
videosRouter.post("/subsets/scan", (_req, res) => {
  try {
    res.json({ ok: true, data: startSubsetScan() });
  } catch (e) {
    log.error("videos", `subset scan start failed: ${(e as Error).message}`);
    res.status(500).json({ ok: false, error: (e as Error).message });
  }
});

/** Icon-state enrichment, best-effort: on any failure the lists render with cheap defaults rather than
 *  failing or blocking (tables.mdx §4c is a nicety here, not the data). */
async function safeIconIndex(): Promise<Map<string, IconState>> {
  try {
    return await buildIconStateIndex();
  } catch {
    return new Map();
  }
}
