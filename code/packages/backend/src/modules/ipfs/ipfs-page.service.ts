// The IPFS page (ipfs.mdx): reconcile the LOCAL pinset (`ipfs pin ls`, ground truth) against the
// LFB manifests, compose one row per pinned root CID, group the tracked pins by repo (the left-bar
// children — ipfs.mdx §2.1), and IMPORT untracked pins into tracking (metadata-only — ipfs.mdx §4).
import path from "node:path";
import fs from "node:fs";
import {
  ManifestSchema,
  type IpfsPageData,
  type IpfsPinRow,
  type IpfsNodeCard,
  type IpfsRepoGroup,
  type IpfsTracked,
} from "@lfb/shared";
import { readYaml, updateYaml } from "../../shared/store/yaml-store.js";
import { computerUnitDir, unitManifestPath } from "../../shared/store/scopes.js";
import {
  listRepoFolders,
  getRepoConfig,
  getRepoManifest,
  getRepoStatus,
  repoIdFromPath,
} from "../store-model/units.service.js";
import { getAppConfig } from "../store-model/config.service.js";
import * as ipfs from "./ipfs.service.js";
import { log } from "../../shared/logging.js";

// What we know about a CID that appears in some manifest (i.e. a Tracked pin).
interface TrackedInfo {
  repoId: string | null; // null for the computer unit
  unit: string; // repo name, or "computer"
  path: string | null; // absolute local path when resolvable
  size: number;
  peers: number; // pinned_by length (your computers claiming this CID)
  seenAt: string | null;
}

const COMPUTER_MANIFEST = () => unitManifestPath(computerUnitDir());

/** Build cid → TrackedInfo across every repo manifest and the computer-unit manifest. */
function buildTrackedIndex(): Map<string, TrackedInfo> {
  const index = new Map<string, TrackedInfo>();

  for (const folder of listRepoFolders()) {
    try {
      const cfg = getRepoConfig(folder);
      const manifest = getRepoManifest(folder);
      const status = getRepoStatus(folder);
      const repoId = repoIdFromPath(cfg.repo.path || folder);
      const name = cfg.repo.name || folder;
      const base = cfg.repo.path || "";
      for (const f of manifest.files) {
        if (!f.cid) continue;
        index.set(f.cid, {
          repoId,
          unit: name,
          path: base ? path.join(base, f.path) : f.path || null,
          size: f.size,
          peers: f.pinned_by.length,
          seenAt: status.last_scan_at ?? manifest.generated_at ?? null,
        });
      }
    } catch (e) {
      // A corrupt/unreadable repo config or manifest shouldn't blank the whole IPFS page — skip it.
      log.warn("ipfs", `tracked-index build skipped repo ${folder}: ${(e as Error).message}`);
    }
  }

  // Computer-unit manifest — path-less imported pins and whole-computer pin entries.
  try {
    const computer = readYaml(COMPUTER_MANIFEST(), ManifestSchema);
    for (const f of computer.files) {
      if (!f.cid || index.has(f.cid)) continue;
      // A path that isn't absolute (e.g. the CID used as a placeholder key) means "no local path".
      const resolved = f.path && path.isAbsolute(f.path) ? f.path : null;
      index.set(f.cid, {
        repoId: null,
        unit: "computer",
        path: resolved,
        size: f.size,
        peers: f.pinned_by.length,
        seenAt: computer.generated_at ?? null,
      });
    }
  } catch (e) {
    // Missing/corrupt computer-unit manifest → proceed with just the repo-derived index.
    log.warn("ipfs", `tracked-index build skipped computer manifest: ${(e as Error).message}`);
  }

  return index;
}

/** Run async `fn` over `items` with bounded concurrency (keeps object/stat from flooding the node). */
async function pool<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  });
  await Promise.all(workers);
  return out;
}

const UNTRACKED_STAT_CAP = 400; // stat at most this many untracked CIDs per page load (bounded cost)

/** Compose the full IPFS page: node card + one row per pinned root CID + the pinning-repo groups. */
export async function computeIpfsPage(): Promise<IpfsPageData> {
  const health = await ipfs.health();
  const [peerId, posture, pins] = await Promise.all([
    ipfs.peerId(),
    ipfs.nodePosture(),
    health === "ok" ? ipfs.listPins() : Promise.resolve([]),
  ]);

  const index = buildTrackedIndex();

  // Untracked pins get a best-effort size from the node (tracked pins already carry it in the manifest).
  const untrackedCids = pins.filter((p) => !index.has(p.cid)).map((p) => p.cid);
  const capped = untrackedCids.slice(0, UNTRACKED_STAT_CAP);
  const sizes = new Map<string, number | null>();
  const statted = await pool(capped, 8, (cid) => ipfs.objectSize(cid));
  capped.forEach((cid, i) => sizes.set(cid, statted[i]));

  const rows: IpfsPinRow[] = pins.map((p) => {
    const info = index.get(p.cid);
    if (info) {
      const tracked: IpfsTracked = info.path ? "pinned" : "path-less";
      return {
        cid: p.cid,
        file: info.path ? path.basename(info.path) : null,
        path: info.path,
        sizeBytes: info.size,
        pinType: p.type,
        tracked,
        unit: info.unit,
        repoId: info.repoId,
        peers: info.peers,
        seenAt: info.seenAt,
      };
    }
    return {
      cid: p.cid,
      file: null,
      path: null,
      sizeBytes: sizes.get(p.cid) ?? 0,
      pinType: p.type,
      tracked: "import" as const,
      unit: null,
      repoId: null,
      peers: 0,
      seenAt: null,
    };
  });

  const trackedCount = rows.filter((r) => r.tracked !== "import").length;
  const untrackedCount = rows.length - trackedCount;
  const publicGateway = getAppConfig().ipfs.public_gateway;
  // Compliant = only-our-content posture (knowledge/ipfs.mdx §6, ipfs.mdx §3.2). The charter bans
  // bouncing other people's CONTENT *or TRAFFIC*, so all FOUR vectors must be clean: announce
  // pinned/roots + gateway loopback-only (content), AND relay-service off + DHT client-only (traffic).
  // The last two default to ON in Kubo, so omitting them meant rendering "Only your content ✓" for a
  // node relaying strangers' traffic. The publicGateway SETTING doesn't make a public node compliant —
  // it only downgrades the card's flag from red error to amber "acknowledged" (§3.1, handled in the UI).
  const compliant =
    (posture.reprovideStrategy === "pinned" || posture.reprovideStrategy === "roots") &&
    posture.gatewayLocalOnly &&
    posture.relayServiceOff &&
    posture.dhtClientOnly;

  const node: IpfsNodeCard = {
    health,
    peerId,
    reprovideStrategy: posture.reprovideStrategy,
    gatewayLocalOnly: posture.gatewayLocalOnly,
    publicGateway,
    relayServiceOff: posture.relayServiceOff,
    dhtClientOnly: posture.dhtClientOnly,
    compliant: health === "ok" ? compliant : false,
    gcOn: posture.gcOn,
    pinnedCount: rows.length,
    pinnedBytes: rows.reduce((sum, r) => sum + (r.sizeBytes || 0), 0),
    trackedCount,
    untrackedCount,
  };

  // Left-bar children (ipfs.mdx §2.1): one per repo that owns ≥1 tracked pin, most pins first.
  const groups = new Map<string, IpfsRepoGroup>();
  for (const r of rows) {
    if (!r.repoId || !r.unit) continue;
    const g = groups.get(r.repoId) ?? { repoId: r.repoId, name: r.unit, pinnedCount: 0 };
    g.pinnedCount++;
    groups.set(r.repoId, g);
  }
  const repos = [...groups.values()].sort(
    (a, b) => b.pinnedCount - a.pinnedCount || a.name.localeCompare(b.name),
  );

  return { node, pins: rows, repos };
}

/**
 * Import untracked pins into tracking (ipfs.mdx §4) — METADATA ONLY. The bytes are already pinned,
 * so nothing is fetched, re-added, or re-pinned: we only record the CID as a tracked (path-less)
 * entry in the computer-unit manifest, after which it counts as tracked (not an import candidate).
 * `cids` selects specific pins; omit it (or pass all=true) to import every currently-untracked pin.
 */
export async function importPins(opts: { cids?: string[]; all?: boolean }): Promise<number> {
  const health = await ipfs.health();
  if (health !== "ok") return 0;

  const index = buildTrackedIndex();
  const pinned = await ipfs.listPins();
  const untracked = pinned.filter((p) => !index.has(p.cid));
  const want = opts.all ? new Set(untracked.map((p) => p.cid)) : new Set(opts.cids ?? []);
  const toImport = untracked.filter((p) => want.has(p.cid));
  if (toImport.length === 0) return 0;

  const label = getAppConfig().computer.label;
  const sizes = await pool(toImport, 8, (p) => ipfs.objectSize(p.cid));

  ensureComputerUnitDir();
  await updateYaml(COMPUTER_MANIFEST(), ManifestSchema, (m) => {
    m.unit = "computer";
    const have = new Set(m.files.map((f) => f.cid).filter(Boolean));
    toImport.forEach((p, i) => {
      if (have.has(p.cid)) return;
      m.files.push({
        path: p.cid, // placeholder key — a path-less tracked pin (ipfs.mdx §4)
        cid: p.cid,
        size: sizes[i] ?? 0,
        sha256: null,
        pinned_by: [label],
      });
    });
    return m;
  });

  return toImport.length;
}

function ensureComputerUnitDir(): void {
  try {
    fs.mkdirSync(computerUnitDir(), { recursive: true });
  } catch {
    /* best effort — writeYaml also ensures the dir */
  }
}
