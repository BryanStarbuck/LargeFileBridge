// The Communities backend (communities.mdx). A community is a publisher of large PUBLIC files a user
// can subscribe to; subscribing carries an INTENT (Get/Support) and a BACKUP MODE (Block · Recommended
// · Full) bounded by a storage BUDGET LFB derives from this computer's real free disk. On disk each
// subscribed community materializes as a community storage (storage_community.mdx); its per-community
// subscription choices live computer-wide under pin/c/<community_id>/config.yaml (§8), and the single
// machine-wide budget lives on the app-level config.yaml as `community_budget` (§5.2).
//
// Charter compliance (§1): Support = "pin this publisher's PUBLIC files to add redundancy," an explicit,
// narrow, per-community opt-in — NEVER a general public gateway/relay. Nothing here flips the
// only-our-content default. Node fs only (charter). No pin bytes are ever committed here without the
// user's explicit backup-mode choice.
import fs from "node:fs";
import type {
  CommunitiesPageData,
  CommunityRow,
  CommunityStorageMath,
  CommunityBackupMode,
  CommunitySubscription,
  CommunitySubscriptionPatch,
  CommunityLibrary,
  StorageRow,
} from "@lfb/shared";
import { CommunitySubscriptionSchema } from "@lfb/shared";
import { readYaml, updateYaml } from "../../shared/store/yaml-store.js";
import { communityUnitDir, unitConfigPath } from "../../shared/store/scopes.js";
import { getAppConfig, updateAppConfig } from "../store-model/config.service.js";
import { resolveStateDir } from "../../config/state-dir.js";
import { listStoragesPage, readDescriptor } from "../storage/storage.service.js";
import { readStorageIndex } from "../storage/tracking.service.js";
import { log } from "../../shared/logging.js";

// Headroom floor we never cross (§5.1): a percentage of total, with an absolute minimum.
const HEADROOM_FRACTION = 0.1; // keep 10% of the volume free…
const HEADROOM_MIN_BYTES = 10 * 1024 * 1024 * 1024; // …but never less than 10 GiB.
// We do not assume the user wants to hand the whole disk to other people's videos (§5.2).
const RECOMMENDED_BUDGET_FRACTION = 0.5;

function subscriptionConfigPath(communityId: string): string {
  return unitConfigPath(communityUnitDir(communityId));
}

// ── storage math (§5) ─────────────────────────────────────────────────────────
/**
 * Measure this computer's real storage on the state-root volume (§5.1) and derive the community budget
 * (§5.2). `freeOutsideIpfs` is the volume's genuinely-available free space — the IPFS datastore's bytes
 * are already committed (not free), so they are excluded from "room we can still grow into." Reserved
 * headroom is never crossed (§5.1); every plan (Full included) stays inside `communityBudget`.
 */
export async function computeStorageMath(usedBytes = 0): Promise<CommunityStorageMath> {
  let totalDiskBytes = 0;
  let freeOutsideIpfsBytes = 0;
  try {
    // Node fs.statfs on the state-root volume — local only, no shell (charter / §5.1).
    const st = await fs.promises.statfs(resolveStateDir());
    totalDiskBytes = st.blocks * st.bsize;
    freeOutsideIpfsBytes = st.bavail * st.bsize;
  } catch (e) {
    log.warn("communities", `statfs failed: ${(e as Error).message}`);
  }

  const reservedHeadroomBytes = Math.max(Math.round(totalDiskBytes * HEADROOM_FRACTION), HEADROOM_MIN_BYTES);
  const growable = Math.max(0, freeOutsideIpfsBytes - reservedHeadroomBytes);
  const recommendedBudgetBytes = Math.round(growable * RECOMMENDED_BUDGET_FRACTION);

  const configured = getAppConfig().community_budget;
  // The user's set number wins; otherwise propose the recommendation. Clamp to [0 … growable] so a stale
  // budget can never push a plan across the headroom floor (§5.2).
  const communityBudgetBytes = Math.min(Math.max(0, configured ?? recommendedBudgetBytes), growable);

  return {
    totalDiskBytes,
    freeOutsideIpfsBytes,
    reservedHeadroomBytes,
    communityBudgetBytes,
    recommendedBudgetBytes,
    usedBytes,
  };
}

// ── per-community subscription state (§8) ──────────────────────────────────────
/** Read one community's subscription choices (defaults-on-absence → all off / Block). */
function readSubscription(communityId: string): CommunitySubscription {
  const c = readYaml(subscriptionConfigPath(communityId), CommunitySubscriptionSchema);
  return { get: c.get, support: c.support, backupMode: c.backup_mode, bookmarked: c.bookmarked };
}

// ── library rollup (§2 totals) ────────────────────────────────────────────────
function libraryFor(root: string): CommunityLibrary {
  const files = readStorageIndex(root);
  let videos = 0;
  let images = 0;
  let totalBytes = 0;
  for (const f of files) {
    totalBytes += f.sizeBytes;
    if (f.compressible === "video") videos++;
    else if (f.compressible === "image") images++;
  }
  return { items: files.length, videos, images, totalBytes };
}

// ── the budget planner (§5.3) ──────────────────────────────────────────────────
// Full-backup communities are funded FIRST from the budget; Recommended communities then share the
// remainder, each capped at its recommended amount. Block = 0. Nothing exceeds `communityBudget`, so the
// headroom floor is never violated (the budget was already clamped inside it, §5.2).
function planTargets(
  rows: Array<{ id: string; library: CommunityLibrary; mode: CommunityBackupMode }>,
  budgetBytes: number,
): Map<string, number> {
  const target = new Map<string, number>();
  let remaining = budgetBytes;

  for (const r of rows) {
    if (r.mode !== "full") continue;
    const t = Math.min(r.library.totalBytes, Math.max(0, remaining));
    target.set(r.id, t);
    remaining -= t;
  }

  const recommended = rows.filter((r) => r.mode === "recommended");
  if (recommended.length > 0) {
    const perCommunity = Math.max(0, remaining) / recommended.length; // even split of the remainder
    for (const r of recommended) {
      const t = Math.min(r.library.totalBytes, perCommunity);
      target.set(r.id, t);
    }
  }

  for (const r of rows) if (!target.has(r.id)) target.set(r.id, 0); // Block and any leftover.
  return target;
}

// ── public API (the router calls these) ────────────────────────────────────────
/** The Communities page payload: the storage-math header (§6) + one row per community (§7). */
export async function getCommunitiesPage(): Promise<CommunitiesPageData> {
  // Subscribed communities materialize as community storages (storage_community.mdx); that discovery is
  // the catalog we have locally. Browsing a remote catalog is a future concern — we surface what exists.
  const storages: StorageRow[] = listStoragesPage().communities;

  const base = storages.map((s) => {
    const desc = readDescriptor(s.root);
    const community = desc?.community ?? null;
    const sub = readSubscription(s.id);
    return {
      row: s,
      library: libraryFor(s.root),
      publisher: (community?.publisher as string | undefined) ?? null,
      description: (community?.description as string | undefined) ?? desc?.name ?? null,
      sub,
    };
  });

  const targets = planTargets(
    base.map((b) => ({ id: b.row.id, library: b.library, mode: b.sub.backupMode })),
    (await computeStorageMath()).communityBudgetBytes,
  );

  const communities: CommunityRow[] = base.map((b) => ({
    id: b.row.id,
    name: b.row.name,
    publisher: b.publisher,
    description: b.description,
    root: b.row.root,
    library: b.library,
    subscription: b.sub,
    // No bytes are pinned by this subsystem until a pin pass wires the plan; report the honest 0 vs the
    // planned target so the meter never overstates coverage (§5.3 "degrade gracefully and says so").
    keepingSecureBytes: 0,
    targetBytes: b.sub.backupMode === "block" ? 0 : Math.round(targets.get(b.row.id) ?? 0),
    redundancy: null, // unknown without peer data.
  }));

  const usedBytes = communities.reduce((sum, c) => sum + c.keepingSecureBytes, 0);
  const math = await computeStorageMath(usedBytes);
  return { math, communities };
}

/** Set the single computer-wide community storage budget (§5.2). Bytes; null clears back to the default. */
export async function setCommunityBudget(bytes: number | null): Promise<CommunityStorageMath> {
  await updateAppConfig((c) => {
    c.community_budget = bytes === null ? null : Math.max(0, Math.round(bytes));
    return c;
  });
  return computeStorageMath();
}

/** Apply a partial update to one community's subscription (§3–§4). Persists to pin/c/<id>/config.yaml. */
export async function setCommunitySubscription(
  communityId: string,
  patch: CommunitySubscriptionPatch,
): Promise<CommunitySubscription> {
  const next = await updateYaml(subscriptionConfigPath(communityId), CommunitySubscriptionSchema, (c) => {
    if (patch.get !== undefined) c.get = patch.get;
    if (patch.support !== undefined) c.support = patch.support;
    if (patch.backupMode !== undefined) c.backup_mode = patch.backupMode;
    if (patch.bookmarked !== undefined) c.bookmarked = patch.bookmarked;
    return c;
  });
  return { get: next.get, support: next.support, backupMode: next.backup_mode, bookmarked: next.bookmarked };
}
