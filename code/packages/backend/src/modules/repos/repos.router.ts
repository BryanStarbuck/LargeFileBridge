// REST for the Repos + One-repo + per-repo settings screens (repos.mdx, one_repo.mdx, repo_settings.mdx).
import path from "node:path";
import { Router, type Response } from "express";
import { z } from "zod";
import type {
  RepoRow,
  RepoSettings,
  Decision,
  RepoDetail,
  MissingPinnedFile,
  DeletedHereFile,
  FileRow,
  IpfsHealth,
  RepoRowsStreamEvent,
  RepoDetailStreamEvent,
} from "@lfb/shared";
import {
  listRepoFolders,
  computeRepoRow,
  computeRepoDetail,
  registerRepo,
  unregisterRepo,
  folderForRepoId,
  getRepoConfig,
  updateRepoConfig,
  ownerForRepoConfig,
  setRepoOwnerOverride,
  getRepoStatus,
  getRepoManifest,
} from "../store-model/units.service.js";
import { startScan, getScanJob, maybeTriggerStaleScan } from "../scanner/scan-job.js";
import { pinRepoFolder, pinAll, missingPinnedFromPeers, pullMissing, ORPHAN_GRACE_MS } from "../pin/pin.service.js";
import { schedulePullRetry } from "../pin/pull-retry.service.js";
import {
  recordDecision,
  readDecisionPolicy,
  setDecisionPolicy,
  shareStatus,
  readLedger,
  foldLedger,
} from "../storage/decisions.service.js";
import { flagsResolver, computerLabel } from "../store-model/config.service.js";
import { ensureSyncRepoMarker } from "../storage/tracking-sync.service.js";
import { resolveOwnerDedicatedRepo } from "../storage/artifact-placement.service.js";
import { repoUidFor } from "../storage/repo-identity.js";
import { getStorageRow } from "../storage/storage.service.js";
import { indexStorageFiles, storageIndexDroppedFiles } from "../storage/tracking.service.js";
import { maybeSyncBackbone } from "../storage/backbone-freshness.service.js";
import {
  maybeConvergeWorkingRepo,
  getRepoSyncBlock,
  recheckWorkingRepoConvergence,
} from "../pin/repo-artifact-sync.service.js";
import { assertCompanyOwnership, withdrawCompanyOwnership } from "../storage/owner-propagation.service.js";
import { track } from "../progress/progress.registry.js";
import * as ipfs from "../ipfs/ipfs.service.js";
import { requireAllowListed } from "../auth/identify.js";
import { currentUser } from "../auth/current-user.js";
import { joinRel } from "../../shared/rel-path.js";
import { log } from "../../shared/logging.js";
import { expandHome } from "../../shared/home-path.js";

/**
 * Absolute working-tree root for a state-root folder key — the same derivation the decisions service uses
 * (decisions.service.ts `repoRootFor`): the config `repo.path` with a leading `~` home-expanded. Needed to
 * drive the pin-service helpers (which take a repoRoot) and the Never-IPFS flag lookup (keyed by abs path).
 */
function repoRootFor(folder: string): string {
  const p = getRepoConfig(folder).repo.path;
  if (!p) throw new Error(`repo ${folder} has no path`);
  return path.resolve(expandHome(p));
}

/**
 * Best-effort list of peer-pinned files this computer is missing (warnings.mdx §10.8.12). Wrapped so a slow
 * or erroring IPFS node never blocks / fails the repo-detail page — a fault yields [] and the warning simply
 * doesn't show. Augmented onto the RepoDetail at the router, because computeRepoDetail is the SHARED
 * composer every caller uses and none of the others wants an IPFS round-trip.
 */
async function missingPinnedSafe(repoRoot: string): Promise<MissingPinnedFile[]> {
  try {
    return await missingPinnedFromPeers(repoRoot);
  } catch (e) {
    log.warn("repos", `missingPinned lookup failed for ${repoRoot}: ${(e as Error).message}`);
    return [];
  }
}

/**
 * The deletions the pin pass noticed (decisions.mdx §12): decided files this computer PINNED and then lost
 * from disk, still inside their grace period. The scan cannot see them (no file) and they are not
 * remote-only (no peer claim is required), so without this list they exist only in the pin log — the user
 * deletes a synced file and the app says nothing at all.
 *
 * Read straight off the unit status the pin pass writes; no IPFS call, so it cannot slow the page.
 */
function deletedHereFor(folder: string): DeletedHereFile[] {
  const orphans = getRepoStatus(folder).orphans ?? {};
  if (Object.keys(orphans).length === 0) return [];
  const selfLabel = computerLabel();
  const byPath = new Map(getRepoManifest(folder).files.map((f) => [f.path, f]));
  return Object.entries(orphans).map(([rel, o]) => {
    const m = byPath.get(rel);
    return {
      path: rel,
      name: rel.slice(rel.lastIndexOf("/") + 1),
      sizeBytes: m?.size ?? 0,
      cid: o.cid ?? m?.cid ?? null,
      firstSeenAt: o.first_seen_at,
      staleAt: new Date(Date.parse(o.first_seen_at) + ORPHAN_GRACE_MS).toISOString(),
      pinnedElsewhere: (m?.pinned_by ?? []).some((d) => d && d !== selfLabel),
    };
  });
}

/**
 * Compute the One-repo detail with the LIVE pin reality folded in. Fetches this node's pinset ONCE (canonical,
 * knowledge/ipfs.mdx §5.1) and threads it into composeFileRows so every decided row carries `pinnedHere` — the
 * signal behind the three-state pin icon (one_repo.mdx §4.9: blue = decided & pinned here, red = decided but
 * this machine doesn't hold it yet). Best-effort: a down/slow node yields an undefined pinset (never blocks the
 * page), and the icon simply falls back to intent-only. This is the ONE choke point every RepoDetail-returning
 * handler uses, so a pin toggle's response reflects reality the same way the initial GET does.
 */
async function repoDetailWithPins(folder: string): Promise<RepoDetail> {
  const { health, pinset } = await pinReality(folder);
  return computeRepoDetail(folder, health, pinset);
}

/** The node's health + canonical pinset, both best-effort. Split out of {@link repoDetailWithPins} so the
 *  streaming route can start this — the slowest single step on the page, since a full `pin ls` enumeration
 *  can take seconds on a large pinset — CONCURRENTLY with composing the rows, instead of before them. */
async function pinReality(folder: string): Promise<{ health: IpfsHealth; pinset: Set<string> | undefined }> {
  const health = await ipfs.health();
  let pinset: Set<string> | undefined;
  try {
    pinset = await ipfs.canonicalPinnedSet();
  } catch (e) {
    log.debug("repos", `pinset fetch skipped for ${folder} (node unreachable?): ${(e as Error).message}`);
  }
  return { health, pinset };
}

/**
 * The per-repo sync-repo mirror as the settings page should show it (repo_settings.mdx §2.9.1,
 * storage_company.mdx §8.4.2). The mirror is ON by default, so this reports the EFFECTIVE state — an absent
 * `enabled` means ON, and only an explicit `false` is an opt-out.
 *
 * It also reports whether the repo CAN mirror at all, because a toggle that silently does nothing is worse
 * than a disabled one that explains itself. Two honest "no" cases: a repo with no git remote has no identity
 * the user's other computers could agree on (§8.4.1), and a repo whose owning storage has no git-backed SDL
 * has nowhere to mirror to.
 */
function syncRepoSetting(c: ReturnType<typeof getRepoConfig>): RepoSettings["syncRepo"] {
  const optedOut = c.sync_repo?.enabled === false;
  const remote = c.repo.remote ?? null;
  if (!repoUidFor(remote)) {
    return { enabled: false, available: false, reason: "No git remote — this repo's tracking stays on this computer." };
  }
  let target: string | null = null;
  try {
    target = c.repo.path ? resolveOwnerDedicatedRepo(c.repo.path, remote) : null;
  } catch {
    target = null; // owner resolution failed → treat as "nowhere to mirror to" rather than claiming success
  }
  if (!target) {
    return {
      enabled: false,
      available: false,
      reason: "No company or personal storage owns this repo yet, so there is nowhere for its tracking state to travel.",
    };
  }
  return { enabled: !optedOut, available: true, target };
}

/** Repo-relative paths that carry the sticky Never-IPFS flag (decisions.mdx §17) — the IPFS axis is rejected
 *  for these at the write path. The flag is path-scoped (own entry OR any ancestor dir), read through the
 *  SAME fold the policy engine uses (config.service `flagsResolver` / `effectiveFlags` — one predicate). */
function neverIpfsPaths(repoRoot: string, relPaths: string[]): string[] {
  const flagsFor = flagsResolver(); // one snapshot for the whole (possibly bulk) list, not one per path
  return relPaths.filter((rel) => flagsFor(joinRel(repoRoot, rel)).neverIpfs);
}

export const reposRouter = Router();
reposRouter.use(requireAllowListed);

/**
 * How many repos to compose before handing the event loop back (see {@link startRepoRowsFeed}).
 * Small enough that the pause between two chunks is a few milliseconds, large enough that the yields
 * themselves cost nothing measurable on a machine with a handful of repos.
 *
 * It is also the streamed BATCH size — the walk flushes what it has to every listener at each pause, so a
 * reader sees the first rows after ~10 repos rather than after all of them.
 */
const REPO_ROWS_YIELD_EVERY = 10;

/**
 * ONE Repos-table walk, MULTICAST to every reader — buffered and streaming alike (performance.mdx P-37).
 *
 * Two problems share one answer here.
 *
 * The first is the older one: the Repos page invalidates `["repos"]` on every live-refresh bump, and a
 * burst of bumps (a scan pass, a pin pass) used to turn into a burst of overlapping `GET /api/repos` walks
 * that serialised on the event loop — each finishing later than the last (10s, 21s, 31s…) while every
 * unrelated request queued behind the growing backlog. A single in-flight walk is what keeps a bump storm
 * costing one walk.
 *
 * The second is the one this rewrite fixes: that shared walk RESOLVED ALL AT ONCE, so however well it
 * yielded, the browser still waited for the last repo before it could draw the first. The feed keeps the
 * one-walk guarantee and adds a subscriber list: a reader that attaches mid-walk is handed the rows already
 * composed and then receives each later batch as it lands, so N tabs opening the list at once still cost
 * exactly one pass over the disk and every one of them paints immediately.
 *
 * A reader disconnecting does NOT abort the walk — the other subscribers still want it, and unlike a
 * filesystem walk this one is bounded by the repo count and yields throughout.
 */
interface RepoRowsFeed {
  rows: RepoRow[]; // every row composed so far — a late subscriber's catch-up payload
  total: number; // how many repos this walk will visit
  done: boolean;
  error: Error | null;
  listeners: Set<(batch: RepoRow[]) => void>;
  finished: Set<(err: Error | null) => void>;
  promise: Promise<RepoRow[]>;
}

let liveFeed: RepoRowsFeed | null = null;

function startRepoRowsFeed(): RepoRowsFeed {
  if (liveFeed && !liveFeed.done) return liveFeed;
  const folders = listRepoFolders();
  const feed: RepoRowsFeed = {
    rows: [],
    total: folders.length,
    done: false,
    error: null,
    listeners: new Set(),
    finished: new Set(),
    promise: undefined as unknown as Promise<RepoRow[]>,
  };
  // Published BEFORE the walk starts. A zero-repo walk finishes synchronously, and if the publish came
  // after, the `finally` below would clear a `liveFeed` that had not been set yet and we would leave a
  // finished feed installed as the live one.
  liveFeed = feed;
  feed.promise = (async () => {
    let batch: RepoRow[] = [];
    const flush = (): void => {
      if (batch.length === 0) return;
      const out = batch;
      batch = [];
      feed.rows.push(...out);
      // A listener that throws must never take the walk (or the other listeners) down with it.
      for (const l of feed.listeners) {
        try {
          l(out);
        } catch (e) {
          log.warn("repos", `repo-rows listener failed: ${(e as Error).message}`);
        }
      }
    };
    try {
      for (let i = 0; i < folders.length; i++) {
        batch.push(await computeRepoRow(folders[i]));
        if ((i + 1) % REPO_ROWS_YIELD_EVERY === 0) {
          flush();
          await new Promise<void>((r) => setImmediate(r));
        }
      }
      flush();
      return feed.rows;
    } catch (e) {
      feed.error = e as Error;
      throw e;
    } finally {
      feed.done = true;
      if (liveFeed === feed) liveFeed = null;
      for (const f of feed.finished) {
        try {
          f(feed.error);
        } catch (e) {
          log.warn("repos", `repo-rows finish listener failed: ${(e as Error).message}`);
        }
      }
      feed.listeners.clear();
      feed.finished.clear();
      // Working-repo convergence (backbone_resilience.mdx §6.4), fired ONCE PER WALK rather than once per
      // reader. It runs here — after the walk, after every listener has been answered — because it re-reads
      // every repo's config and must never compete with the rows it follows. A walk that FAILED gets no
      // sweep: the trigger means "the list was loaded", and it wasn't.
      // The `.catch` is load-bearing, not decoration: an unhandled rejection is a process fatal here
      // (main.ts), and a freshness trigger must never be able to take the server down.
      if (!feed.error) {
        void convergeAllWorkingRepos().catch((e) =>
          log.warn("repos", `working-repo convergence sweep failed: ${(e as Error).message}`),
        );
      }
    }
  })();
  // The feed's promise is consumed by whoever asked for it; a subscriber that only wants BATCHES still
  // leaves the promise unhandled, and an unhandled rejection is a process-fatal in this app (main.ts).
  // The rejection is already reported through `feed.error` / the `finished` listeners.
  feed.promise.catch(() => {});
  return feed;
}

/** The whole list as one array — the buffered `GET /api/repos`, riding the same single walk. */
function repoRows(): Promise<RepoRow[]> {
  return startRepoRowsFeed().promise;
}

/**
 * Fire the per-repo working-tree convergence trigger for every tracked repo, yielding as it goes.
 * Each call is individually cheap and throttled, but `repoRootFor` re-reads a config per repo, so the
 * sweep is chunked for the same reason the row build is: it must never hold the thread against the
 * requests the page issues immediately after this one.
 */
async function convergeAllWorkingRepos(): Promise<void> {
  const folders = listRepoFolders();
  for (let i = 0; i < folders.length; i++) {
    try {
      maybeConvergeWorkingRepo(repoRootFor(folders[i]), "Repos list loaded");
    } catch {
      /* a freshness trigger must never break the page */
    }
    if ((i + 1) % REPO_ROWS_YIELD_EVERY === 0) await new Promise<void>((r) => setImmediate(r));
  }
}

/**
 * Open an NDJSON response and return the per-event writer (performance.mdx P-22 transport, reused).
 *
 * One JSON object per line, flushed after every write so chunks leave the process immediately even when a
 * compression or proxy layer would otherwise buffer them — without the flush the whole point of streaming
 * is lost behind the dev proxy.
 */
function ndjson<E>(res: Response): (ev: E) => void {
  res.setHeader("Content-Type", "application/x-ndjson; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Accel-Buffering", "no"); // don't let a reverse proxy buffer the stream
  return (ev: E): void => {
    // `destroyed` as well as `writableEnded`: a reader that vanishes mid-walk leaves a DESTROYED socket
    // that has not been `end()`ed, and writing to it raises ERR_STREAM_DESTROYED — which, unhandled, is a
    // process fatal in this app (main.ts). Both producers stop within one batch of an abort, so this
    // guards the one write that can still be in flight when they do.
    if (res.writableEnded || res.destroyed) return;
    try {
      res.write(JSON.stringify(ev) + "\n");
      (res as unknown as { flush?: () => void }).flush?.();
    } catch (e) {
      log.debug("repos", `stream write dropped (reader gone?): ${(e as Error).message}`);
    }
  };
}

// GET /api/repos/stream — the Repos table as an NDJSON STREAM (performance.mdx P-37). Same rows as
// `GET /api/repos`, same single shared walk, delivered `meta` → `batch`× → `done` so the landing page
// paints its first repos in tens of milliseconds instead of after the last one. Registered BEFORE
// `/:repoId` so "stream" is not captured as a repo id.
reposRouter.get("/stream", (_req, res) => {
  const write = ndjson<RepoRowsStreamEvent>(res);
  maybeTriggerStaleScan("Repos list loaded"); // same freshness self-heal as the buffered route
  const feed = startRepoRowsFeed();

  write({ t: "meta", total: feed.total });
  // Catch-up FIRST: a reader that attached mid-walk must receive what has already been composed, or those
  // rows are lost to it forever (the walk will never re-emit them).
  if (feed.rows.length) write({ t: "batch", rows: feed.rows.slice() });

  const onBatch = (rows: RepoRow[]): void => write({ t: "batch", rows });
  const onFinish = (err: Error | null): void => {
    detach();
    if (err) {
      log.error("repos", `list stream failed: ${err.message}`);
      write({ t: "error", error: err.message });
    } else {
      write({ t: "done", total: feed.rows.length });
    }
    if (!res.writableEnded) res.end();
  };
  const detach = (): void => {
    feed.listeners.delete(onBatch);
    feed.finished.delete(onFinish);
  };

  if (feed.done) {
    // The walk finished between `startRepoRowsFeed()` and here (or was already complete): everything is in
    // the catch-up batch above, so close immediately rather than waiting for an event that will never come.
    onFinish(feed.error);
    return;
  }
  feed.listeners.add(onBatch);
  feed.finished.add(onFinish);
  // The reader went away. Detach only — the walk is shared and bounded, so other subscribers keep it.
  res.on("close", detach);
});

// GET /api/repos — the Repos table.
reposRouter.get("/", async (_req, res) => {
  try {
    // Freshness self-heal: if we haven't scanned the filesystem in >4h, kick a background scan now so the
    // next poll reflects current disk state. Non-blocking + single-flight (scan-job.ts) — never delays this
    // response and no-ops when a scan is already running or recent.
    maybeTriggerStaleScan("Repos list loaded");
    const rows: RepoRow[] = await repoRows();
    res.json({ ok: true, data: rows });
    // (The working-repo convergence sweep is fired by the shared feed when its walk completes — once per
    // walk, not once per reader. See startRepoRowsFeed.)
  } catch (e) {
    log.error("repos", `list failed: ${(e as Error).message}`);
    res.status(500).json({ ok: false, error: (e as Error).message });
  }
});

// POST /api/repos — add a repo by folder path.
reposRouter.post("/", async (req, res) => {
  const body = z.object({ path: z.string().min(1) }).safeParse(req.body);
  if (!body.success) return res.status(400).json({ ok: false, error: "path required" });
  try {
    const { repoId } = await registerRepo(body.data.path);
    // Kick a background scan to populate the new repo's status; do NOT block the response on the walk.
    // If a scan is already running, startScan coalesces this into a queued follow-up pass so the new
    // repo is still covered (scan-job.ts single-flight).
    startScan("manual");
    res.json({ ok: true, data: { repoId } });
  } catch (e) {
    res.status(400).json({ ok: false, error: (e as Error).message });
  }
});

// POST /api/repos/rescan — trigger the discovery scan on demand. Returns IMMEDIATELY; the walk runs as
// a detached server-side job (scan-job.ts) so navigating away or a request timeout never cancels it.
reposRouter.post("/rescan", (_req, res) => {
  const result = startScan("manual");
  res.json({ ok: true, data: result });
});

// POST /api/repos/:repoId/index — (re)build this repo's per-file fingerprint index (storages.mdx §4.1).
// Exists so the one-repo page can act on an INCOMPLETE index: when a build hits its size backstop the page
// says exactly how many large files went unrecorded (§4.1a), and this is the button that re-checks it once
// the user has trimmed what the repo carries. Returns how many files were indexed and how many were
// dropped, so the caller never has to infer completeness.
reposRouter.post("/:repoId/index", async (req, res) => {
  const folder = folderForRepoId(req.params.repoId);
  if (!folder) return res.status(404).json({ ok: false, error: "repo not found" });
  const root = getRepoConfig(folder).repo.path;
  if (!root) return res.status(400).json({ ok: false, error: "repo has no path" });
  const abs = path.resolve(expandHome(root));
  try {
    const indexed = await indexStorageFiles(abs);
    res.json({ ok: true, data: { indexed, dropped: storageIndexDroppedFiles(abs) } });
  } catch (e) {
    log.error("repos", `${folder}: index rebuild failed: ${(e as Error).message}`);
    res.status(500).json({ ok: false, error: (e as Error).message });
  }
});

// GET /api/repos/scan-status — live progress of the current/last discovery scan (scan.mdx §10). The
// progress bar polls this so it can re-attach after the user navigates away and back.
reposRouter.get("/scan-status", (_req, res) => {
  res.json({ ok: true, data: getScanJob() });
});

// POST /api/repos/:repoId/bookmark — toggle the favorite (repos.mdx §8). Persists to config.yaml;
// idempotent. Returns the updated RepoRow so the table can reconcile its optimistic flip.
reposRouter.post("/:repoId/bookmark", async (req, res) => {
  const body = z.object({ bookmarked: z.boolean() }).safeParse(req.body);
  if (!body.success) return res.status(400).json({ ok: false, error: "bookmarked (boolean) required" });
  const folder = folderForRepoId(req.params.repoId);
  if (!folder) return res.status(404).json({ ok: false, error: "repo not found" });
  try {
    await updateRepoConfig(folder, (c) => ({ ...c, bookmarked: body.data.bookmarked }));
    log.info("repos", `${folder}: bookmarked -> ${body.data.bookmarked}`);
    res.json({ ok: true, data: await computeRepoRow(folder) });
  } catch (e) {
    log.error("repos", `${folder}: bookmark update failed: ${(e as Error).message}`);
    res.status(500).json({ ok: false, error: (e as Error).message });
  }
});

// POST /api/repos/:repoId/owner — reassign a repo's owner (repo_company_mapping.mdx §5). Writes/clears the
// local `owner_override` in the repo's config.yaml (source becomes "manual"; a reset returns it to auto). When
// the NEW owner is a company that has a sync repo configured, ALSO records the travelling ownership assertion
// into that company's owner_map.yaml (repo_owner_propagation.mdx §2); when reassigning AWAY from a company that
// had it, tombstones that assertion. Idempotent. Unknown repoId → 404; company kind with an unknown companyId
// → 400 (repo_company_mapping.mdx §9).
const OwnerReassignBody = z.union([
  z.object({ reset: z.literal(true) }),
  z.object({ kind: z.enum(["personal", "company"]), companyId: z.string().optional() }),
]);
reposRouter.post("/:repoId/owner", async (req, res) => {
  const body = OwnerReassignBody.safeParse(req.body);
  if (!body.success) return res.status(400).json({ ok: false, error: "reset:true or { kind, companyId? } required" });
  const folder = folderForRepoId(req.params.repoId);
  if (!folder) return res.status(404).json({ ok: false, error: "repo not found" });

  // The NEW override to persist (null clears → auto). A company kind requires a KNOWN company storage id.
  let next: { kind: "personal" | "company"; company_id: string | null } | null;
  if ("reset" in body.data) {
    next = null;
  } else if (body.data.kind === "personal") {
    next = { kind: "personal", company_id: null };
  } else {
    const companyId = body.data.companyId;
    if (!companyId) return res.status(400).json({ ok: false, error: "companyId required for a company owner" });
    const company = getStorageRow(companyId);
    if (!company || company.type !== "company") {
      return res.status(400).json({ ok: false, error: `unknown company: ${companyId}` });
    }
    next = { kind: "company", company_id: companyId };
  }

  try {
    // Capture the PRIOR company (if any) so a move away can tombstone its assertion (§6).
    const prev = getRepoConfig(folder).owner_override;
    const prevCompanyId = prev?.kind === "company" ? prev.company_id : null;
    const remote = getRepoConfig(folder).repo.remote;

    await setRepoOwnerOverride(folder, next);

    // Assertion side effects (repo_owner_propagation.mdx §2/§6) — best-effort; never fail the reassign on git.
    const nextCompanyId = next?.kind === "company" ? next.company_id : null;
    if (prevCompanyId && prevCompanyId !== nextCompanyId) {
      await withdrawCompanyOwnership(remote, prevCompanyId);
    }
    if (nextCompanyId) {
      await assertCompanyOwnership(remote, nextCompanyId, currentUser(req).email);
    }

    log.info("repos", `${folder}: owner reassigned -> ${next ? next.kind + (nextCompanyId ? `:${nextCompanyId}` : "") : "auto"}`);
    res.json({ ok: true, data: await computeRepoRow(folder) });
  } catch (e) {
    log.error("repos", `${folder}: owner reassign failed: ${(e as Error).message}`);
    res.status(500).json({ ok: false, error: (e as Error).message });
  }
});

// DELETE /api/repos/:repoId — remove repo (unregister, menus.mdx §5.1). Unregisters from LFB ONLY;
// never deletes the folder or any local file on disk (menus.mdx §6.2). Idempotent.
reposRouter.delete("/:repoId", (req, res) => {
  const folder = folderForRepoId(req.params.repoId);
  if (!folder) return res.status(404).json({ ok: false, error: "repo not found" });
  try {
    unregisterRepo(folder);
    res.json({ ok: true, data: { removed: true } });
  } catch (e) {
    log.error("repos", `${folder}: unregister failed: ${(e as Error).message}`);
    res.status(500).json({ ok: false, error: (e as Error).message });
  }
});

/**
 * Fire this repo's three freshness triggers (scan / backbone / working-tree convergence). All three are
 * non-blocking + single-flighted + throttled; shared by the buffered detail route and the stream so the two
 * cannot fall out of step about what a page load implies.
 */
function touchRepoFreshness(folder: string): void {
  maybeTriggerStaleScan(`One-repo detail loaded (${folder})`);
  maybeSyncBackbone(`One-repo detail loaded (${folder})`);
  try {
    maybeConvergeWorkingRepo(repoRootFor(folder), `One-repo detail loaded (${folder})`);
  } catch (e) {
    // A repo with no readable path still has a detail worth rendering — never fail the page on a trigger.
    log.debug("repos", `${folder}: convergence trigger skipped: ${(e as Error).message}`);
  }
}

// GET /api/repos/:repoId/detail/stream — the One-repo detail as an NDJSON STREAM (performance.mdx P-37).
//
// Same facts as `GET /:repoId`, delivered in the order they become knowable instead of all at the end:
// `head` (config + scan status — instant) → `files` batches as rows are composed → `totals` after each
// batch → `pins` once the node's pinset enumeration returns → `extras` (peer/IPFS warnings) → `done`.
//
// The pinset fetch is started HERE, concurrently with the walk, and folded in at the end. The buffered
// route awaits it FIRST, and a `pin ls` over a large pinset can take seconds — seconds during which the
// page had every fact it needed to draw the table and drew nothing. Rows stream with `pinnedHere`
// undefined, which is the already-defined "not known yet" state (never a false red), until `pins` lands.
reposRouter.get("/:repoId/detail/stream", async (req, res) => {
  const folder = folderForRepoId(req.params.repoId);
  // Answer the 404 as ORDINARY JSON — before any NDJSON header is set, so a bad id is a normal HTTP error
  // the client's error path already understands rather than a 200 stream carrying one error line.
  if (!folder) return res.status(404).json({ ok: false, error: "repo not found" });

  const write = ndjson<RepoDetailStreamEvent>(res);
  const ac = new AbortController();
  res.on("close", () => ac.abort());

  try {
    touchRepoFreshness(folder);
    // Started but NOT awaited — it runs while the rows compose. `.catch` here (not later) so a rejection can
    // never be an unhandled one in the window before we await it.
    const pins = pinReality(folder).catch((e): { health: IpfsHealth; pinset: Set<string> | undefined } => {
      log.debug("repos", `${folder}: pin reality unavailable: ${(e as Error).message}`);
      return { health: "unreachable", pinset: undefined };
    });

    let headSent = false;
    const detail = await computeRepoDetail(folder, "unreachable", undefined, {
      signal: ac.signal,
      onFileBatch: (files: FileRow[]) => write({ t: "files", files }),
      onSnapshot: (d: RepoDetail) => {
        if (!headSent) {
          headSent = true;
          // The header, with no rows on it — everything the page needs to paint its chrome.
          write({ t: "head", detail: { ...d, files: [] } });
          return;
        }
        write({ t: "totals", counts: d.counts, taskMetrics: d.taskMetrics, peerCount: d.peerCount, status: d.status });
      },
    });
    if (ac.signal.aborted) return; // reader left mid-walk — nothing to close, the socket is gone
    // The FINAL aggregates. The per-batch snapshots above are subtotals; this one is the answer.
    write({
      t: "totals",
      counts: detail.counts,
      taskMetrics: detail.taskMetrics,
      peerCount: detail.peerCount,
      status: detail.status,
    });

    // Live pin reality, folded in now that the enumeration has had the whole walk to finish.
    const { health, pinset } = await pins;
    if (ac.signal.aborted) return;
    const pinnedHere: Record<string, boolean> = {};
    if (pinset) {
      for (const f of detail.files) {
        // EXACTLY the rows composeFileRows would have given a defined `pinnedHere` — computed here, from the
        // same three conditions, so the patch can never disagree with the buffered route's rows.
        if (f.presence === "remote-only") pinnedHere[f.path] = false;
        else if (f.decision === "sync" && f.cid) pinnedHere[f.path] = pinset.has(ipfs.canonicalCid(f.cid));
      }
    }
    write({ t: "pins", ipfs: health, pinnedHere });

    // The peer/IPFS-dependent warnings — last, because each is another round-trip and none of them gates a
    // single row of the table.
    const root = repoRootFor(folder);
    write({
      t: "extras",
      missingPinned: await missingPinnedSafe(root),
      deletedHere: deletedHereFor(folder),
      syncBlocked: getRepoSyncBlock(root) ?? null,
    });
    write({ t: "done" });
  } catch (e) {
    log.error("repos", `${folder}: detail stream failed: ${(e as Error).message}`);
    write({ t: "error", error: (e as Error).message });
  }
  if (!res.writableEnded) res.end();
});

// GET /api/repos/:repoId — the One-repo detail (header + status strip + files).
reposRouter.get("/:repoId", async (req, res) => {
  const folder = folderForRepoId(req.params.repoId);
  if (!folder) return res.status(404).json({ ok: false, error: "repo not found" });
  try {
    touchRepoFreshness(folder);
    const detail: RepoDetail = await repoDetailWithPins(folder);
    // Augment with the peer-pinned-but-missing set so the §10.8.12 "pull them down" warning has data.
    // Best-effort at the router (computeRepoDetail is the shared composer): a down/slow IPFS never blocks
    // the page — the streaming route sends this as its own `extras` event, after the rows.
    detail.missingPinned = await missingPinnedSafe(repoRootFor(folder));
    // Deletions the pin pass noticed on THIS computer — the other half of "a decided file has no bytes here"
    // (decisions.mdx §12). Sync + local, so it costs the page nothing.
    detail.deletedHere = deletedHereFor(folder);
    // Why this repo can no longer fast-forward from its remote, when that is the case (bug #15B). Refusing
    // to touch the user's repo is right; leaving them unaware that it has stopped converging is not.
    detail.syncBlocked = getRepoSyncBlock(repoRootFor(folder)) ?? undefined;
    res.json({ ok: true, data: detail });
  } catch (e) {
    log.error("repos", `${folder}: detail failed: ${(e as Error).message}`);
    res.status(500).json({ ok: false, error: (e as Error).message });
  }
});

// GET /api/repos/:repoId/files — just the file rows.
reposRouter.get("/:repoId/files", async (req, res) => {
  const folder = folderForRepoId(req.params.repoId);
  if (!folder) return res.status(404).json({ ok: false, error: "repo not found" });
  try {
    const detail = await repoDetailWithPins(folder);
    res.json({ ok: true, data: detail.files });
  } catch (e) {
    log.error("repos", `${folder}: files failed: ${(e as Error).message}`);
    res.status(500).json({ ok: false, error: (e as Error).message });
  }
});

// PATCH /api/repos/:repoId/files — record a decision on one or many files (bulk). Two accepted bodies,
// both funneling through the shared decision ledger (decisions.mdx §8):
//   • TWO-AXIS (the checkbox popup):  { paths, ipfs?, gitignore? }  — the full decision, both axes.
//   • LEGACY single-axis (per-row / bulk IPFS control): { paths, decision: sync|ignore|undecided }
//     — mapped onto the IPFS axis (sync→ipfs:true, ignore→ipfs:false, undecided→un-decide/tombstone).
reposRouter.patch("/:repoId/files", async (req, res) => {
  const body = z
    .object({
      paths: z.array(z.string()).min(1),
      // Two-axis form (either box may be omitted; both-off is a valid decision — decisions.mdx §1).
      ipfs: z.boolean().optional(),
      gitignore: z.boolean().optional(),
      // Legacy single-axis form.
      decision: z.enum(["sync", "ignore", "undecided"]).optional(),
      // Whether turning the IPFS axis on should also fire the targeted pin below (default true). The bulk
      // "Pin now (selected)" sets it false: it marks the undecided rows and then runs ONE pin over the whole
      // selection, and two concurrent pin runs over the same unit race on its manifest.
      pin: z.boolean().optional(),
    })
    .safeParse(req.body);
  if (!body.success || (body.data.decision === undefined && body.data.ipfs === undefined && body.data.gitignore === undefined)) {
    return res.status(400).json({ ok: false, error: "paths + (ipfs/gitignore) or decision required" });
  }
  const folder = folderForRepoId(req.params.repoId);
  if (!folder) return res.status(404).json({ ok: false, error: "repo not found" });

  const decidedBy = currentUser(req).email; // who decided — from the authenticated session (decisions.mdx §3.3)
  const paths = body.data.paths;

  // NEVER-IPFS GUARD (decisions.mdx §17/§20): a decision that turns the IPFS axis ON is REJECTED at the write
  // path for any target carrying the sticky Never-IPFS flag. This covers both the two-axis form (ipfs===true)
  // and the legacy single-axis form (decision==="sync" → ipfs:true). The git-ignore axis is unaffected, so a
  // both-off write, a gitignore-only write, or an ipfs:false/"ignore" write are all still allowed.
  const settingIpfsOn = body.data.decision === "sync" || body.data.ipfs === true;
  if (settingIpfsOn) {
    let blocked: string[];
    try {
      blocked = neverIpfsPaths(repoRootFor(folder), paths);
    } catch (e) {
      log.error("repos", `${folder}: never-ipfs check failed: ${(e as Error).message}`);
      return res.status(500).json({ ok: false, error: (e as Error).message });
    }
    if (blocked.length > 0) {
      log.info("repos", `${folder}: rejected IPFS decision — ${blocked.length} Never-IPFS file(s)`);
      return res.status(409).json({
        ok: false,
        error: `Cannot add to IPFS: ${blocked.length} file(s) are flagged Never IPFS: ${blocked.join(", ")}`,
        data: { neverIpfs: blocked },
      });
    }
  }

  try {
    if (body.data.decision !== undefined) {
      // Legacy single-axis → IPFS axis. "undecided" removes the record (returns to triage).
      const decision = body.data.decision as Decision;
      if (decision === "undecided") {
        await recordDecision(folder, paths, {}, decidedBy, { asked: false });
      } else {
        await recordDecision(folder, paths, { ipfs: decision === "sync" }, decidedBy);
      }
      log.info("repos", `${folder}: set ${paths.length} file(s) -> ${decision} (ledger)`);
    } else {
      // Two-axis decision from the checkbox popup — both axes as chosen (either may be undefined).
      // `unignore: true` — this is THE user-facing click, the only path allowed to remove a `.gitignore`
      // line (git_ignore.mdx §5.5). It still only ever removes an exact anchored single-file line.
      await recordDecision(folder, paths, { ipfs: body.data.ipfs, gitignore: body.data.gitignore }, decidedBy, {
        unignore: true,
      });
      log.info(
        "repos",
        `${folder}: decided ${paths.length} file(s) ipfs=${!!body.data.ipfs} gitignore=${!!body.data.gitignore} by ${decidedBy ?? "?"}`,
      );
    }
    // A decision that turns the IPFS axis ON must MOVE BYTES, not just write the ledger (decisions.mdx §1:
    // the checkbox is the user's explicit ask). Without this, a repo whose `pinned` flag was never flipped
    // by a manual "Pin now" NEVER pinned or published anything — the decided file had no CID, no manifest
    // entry travelled to the company sync repo, and every other computer's Pull-down stayed 0 forever.
    // Fire-and-forget targeted pin of exactly the decided paths; `manual: true` because a decision IS the
    // explicit opt-in (it also enables the 15-min background pass for this repo, keeping the pin fresh).
    //
    // AFTER THE RESPONSE, and on a fresh tick. "Fire-and-forget" is only true from the first `await`
    // onward: `pinRepoFolder` runs a long SYNCHRONOUS prelude first (the sync-repo marker, the reconcile
    // that re-parses and rewrites a six-figure-line ledger, the manifest merge), and starting it here held
    // the event loop — so this response, and every other request including the progress poll the dock
    // feeds on, waited on it. That is why clicking a row's pin icon looked like it did nothing.
    const firePin = (): void => {
      const repoName = getRepoConfig(folder).repo.name || folder;
      const target = `${repoName} (${paths.length} file${paths.length === 1 ? "" : "s"})`;
      void track("pin", target, (report) =>
        pinRepoFolder(folder, new Set(paths), { manual: true, report }),
      ).catch((e) => log.error("repos", `${folder}: decision-triggered pin failed: ${(e as Error).message}`));
    };
    const detail: RepoDetail = await repoDetailWithPins(folder);
    detail.missingPinned = await missingPinnedSafe(repoRootFor(folder));
    res.json({ ok: true, data: detail });
    if (settingIpfsOn && body.data.pin !== false) setImmediate(firePin);
  } catch (e) {
    log.error("repos", `${folder}: file decision update failed: ${(e as Error).message}`);
    res.status(500).json({ ok: false, error: (e as Error).message });
  }
});

// POST /api/repos/:repoId/pull — pull peer-pinned files this computer is missing DOWN over IPFS
// (warnings.mdx §10.8.12 C). Body: { paths: string[] (repo-relative, >=1), compress?: boolean }. Pinning the
// manifest CID fetches the bytes (no re-add / new CID) and materializes them into the working tree; with
// compress set, each pulled media file is queued for background compression. NON-destructive (only ADDS local
// copies) — no red confirm. Returns the recomputed repo detail (same shape as PATCH /files) so the UI
// re-renders and the "pull them down" warning leaves the page once the bytes are here.
reposRouter.post("/:repoId/pull", async (req, res) => {
  const body = z
    .object({ paths: z.array(z.string()).min(1), compress: z.boolean().optional() })
    .safeParse(req.body);
  if (!body.success) return res.status(400).json({ ok: false, error: "paths (>=1) required" });
  const folder = folderForRepoId(req.params.repoId);
  if (!folder) return res.status(404).json({ ok: false, error: "repo not found" });
  const by = currentUser(req).email;
  try {
    const repoRoot = repoRootFor(folder);
    log.info("repos", `${folder}: pull starting for ${body.data.paths.length} file(s) by ${by ?? "?"}`);
    // Record the PIN DECISION first (decisions.mdx §1): clicking "Add to IPFS (pin)" in the pull-down
    // popup IS the user's sync decision for these files. Persisting it — before the transfer, so a
    // failed pull still keeps the intent — takes each file out of the offer-only `knownFromPeers` set,
    // which means the 15-minute background pin pass AUTO-FETCHES it the moment the peer computer comes
    // back online; the user never has to press the button again. Each file's existing git-ignore axis is
    // preserved (recordDecision coerces an omitted axis to false, so it must be passed explicitly).
    try {
      const folded = foldLedger(readLedger(repoRoot));
      const ignored = body.data.paths.filter((p) => folded.get(p)?.gitignore === true);
      const notIgnored = body.data.paths.filter((p) => folded.get(p)?.gitignore !== true);
      if (ignored.length) await recordDecision(folder, ignored, { ipfs: true, gitignore: true }, by);
      if (notIgnored.length) await recordDecision(folder, notIgnored, { ipfs: true }, by);
    } catch (e) {
      log.warn("repos", `${folder}: could not record pull-down pin decisions: ${(e as Error).message}`);
    }
    const counts = await pullMissing(repoRoot, body.data.paths, { compress: !!body.data.compress, by });
    log.info(
      "repos",
      `${folder}: pulled ${counts.pulled} file(s), ${counts.failed} failed (compress=${!!body.data.compress}) by ${by ?? "?"}`,
    );
    // A pull that failed (fully or partially) must SAY so — the old unconditional 200 made the popup's
    // progress card report "N files pulled" while zero bytes arrived and the metric stayed put (the
    // 2026-08-04 defect). Partial success still errors: the refreshed metric shows what actually landed.
    if (counts.failed > 0) {
      // The decision above is recorded, so these files auto-retry: the 15-min pin pass keeps trying, and
      // the 3-hour pull-retry pass adds a direct dial of the holder's IPFS peer (self-stopping at zero
      // pending — warnings.mdx §10.8.12 C.3).
      schedulePullRetry(`${counts.failed} pull(s) failed for ${folder} — holder offline?`);
      const why = counts.errors[0] ?? "see the server log";
      return res.status(502).json({
        ok: false,
        error:
          counts.pulled > 0
            ? `Pulled ${counts.pulled} of ${body.data.paths.length} — ${counts.failed} failed: ${why}`
            : `Could not pull ${counts.failed} file${counts.failed === 1 ? "" : "s"}: ${why}`,
      });
    }
    const detail: RepoDetail = await repoDetailWithPins(folder);
    detail.missingPinned = await missingPinnedSafe(repoRoot);
    res.json({ ok: true, data: detail });
  } catch (e) {
    log.error("repos", `${folder}: pull failed: ${(e as Error).message}`);
    res.status(500).json({ ok: false, error: (e as Error).message });
  }
});

// POST /api/repos/:repoId/sync-check — re-attempt convergence for a repo that reported a sync block
// (bug #15B). The user has (presumably) just committed/stashed their changes or reconciled their branch, so
// this bypasses the 30-minute converge throttle and answers with the CURRENT block (null = resolved).
// STRICTLY READ-ONLY toward the user's work: it is the same `fetch` + `merge --ff-only` the background
// converge runs — never a rebase, never a reset, never a force.
reposRouter.post("/:repoId/sync-check", async (req, res) => {
  const folder = folderForRepoId(req.params.repoId);
  if (!folder) return res.status(404).json({ ok: false, error: "repo not found" });
  try {
    const r = await recheckWorkingRepoConvergence(repoRootFor(folder));
    log.info("repos", `${folder}: sync re-check → converged=${r.converged} blocked=${r.block?.kind ?? "no"}`);
    res.json({ ok: true, data: { converged: r.converged, syncBlocked: r.block ?? null } });
  } catch (e) {
    log.error("repos", `${folder}: sync re-check failed: ${(e as Error).message}`);
    res.status(500).json({ ok: false, error: (e as Error).message });
  }
});

// POST /api/repos/:repoId/pin — Pin now (whole repo or selected files).
reposRouter.post("/:repoId/pin", async (req, res) => {
  const body = z.object({ paths: z.array(z.string()).optional() }).safeParse(req.body ?? {});
  const folder = folderForRepoId(req.params.repoId);
  if (!folder) return res.status(404).json({ ok: false, error: "repo not found" });
  const only = body.success && body.data.paths ? new Set(body.data.paths) : undefined;
  try {
    // Pin THIS repo first as the priority unit (manual = explicit opt-in), then answer immediately so
    // the button feels instant. A manual Pin now is still a FULL PASS: after responding we run the
    // pass over every OTHER known unit in the background so it never blocks the response
    // (pin_process.mdx §2/§3). `priorityDone` stops the pass re-pinning the repo we just did.
    // Register the manual pin in the progress registry so the dock shows a live card — including for
    // a poll from another tab (webapp.mdx §12 source B). track() always ends the job, success or error.
    const repoName = getRepoConfig(folder).repo.name || folder;
    // Name the SCOPE in the dock card: a selective pin of 3 files and a whole-repo pin are different pieces
    // of work, and a card that calls both "Pinning <repo>" cannot tell the user which one is running.
    const target = only ? `${repoName} (${only.size} selected)` : repoName;
    // Report what the run ACTUALLY did (counts), never a fixed "complete" string (pin_process.mdx §6), and
    // stream per-file progress into the card so a long pass is visibly moving rather than a bare spinner.
    const counts = await track("pin", target, (report) => pinRepoFolder(folder, only, { manual: true, report }));
    const detail = await repoDetailWithPins(folder);
    res.json({ ok: true, data: { detail, counts } });
    void pinAll({ priorityDone: folder }).catch((e) =>
      log.error("repos", `full pass after manual pin of ${folder} failed: ${(e as Error).message}`),
    );
  } catch (e) {
    log.error("repos", `${folder}: pin failed: ${(e as Error).message}`);
    res.status(500).json({ ok: false, error: (e as Error).message });
  }
});

// GET /api/repos/:repoId/settings — per-repo settings (repo_settings.mdx).
reposRouter.get("/:repoId/settings", (req, res) => {
  const folder = folderForRepoId(req.params.repoId);
  if (!folder) return res.status(404).json({ ok: false, error: "repo not found" });
  try {
    res.json({ ok: true, data: toRepoSettings(req.params.repoId, folder) });
  } catch (e) {
    log.error("repos", `${folder}: read settings failed: ${(e as Error).message}`);
    res.status(500).json({ ok: false, error: (e as Error).message });
  }
});

// PATCH /api/repos/:repoId/settings
reposRouter.patch("/:repoId/settings", async (req, res) => {
  const folder = folderForRepoId(req.params.repoId);
  if (!folder) return res.status(404).json({ ok: false, error: "repo not found" });
  const patch = RepoSettingsPatch.safeParse(req.body);
  if (!patch.success) return res.status(400).json({ ok: false, error: patch.error.message });
  const p = patch.data;
  try {
    await updateRepoConfig(folder, (c) => {
    if (p.pinned !== undefined) c.pinned = p.pinned;
    if (p.bigFileOverride) c.big_file_override = { ...c.big_file_override, ...p.bigFileOverride };
    if (p.largeFiles)
      c.large_files = {
        follow_gitignore: p.largeFiles.followGitignore ?? c.large_files.follow_gitignore,
        include_globs: p.largeFiles.includeGlobs ?? c.large_files.include_globs,
        exclude_globs: p.largeFiles.excludeGlobs ?? c.large_files.exclude_globs,
      };
    if (p.pin)
      c.pin = {
        pin_locally: p.pin.pinLocally ?? c.pin.pin_locally,
        fetch_missing: p.pin.fetchMissing ?? c.pin.fetch_missing,
        publish_manifest: p.pin.publishManifest ?? c.pin.publish_manifest,
      };
    if (p.access)
      c.access = {
        shared: p.access.shared ?? c.access.shared,
        participants: p.access.participants ?? c.access.participants,
      };
    if (p.transcription?.placement) c.artifacts = { ...c.artifacts, transcription_placement: p.transcription.placement };
    if (p.aiDescription?.placement) c.artifacts = { ...c.artifacts, ai_description_placement: p.aiDescription.placement };
    if (p.syncRepo?.enabled !== undefined) c.sync_repo = { ...c.sync_repo, enabled: p.syncRepo.enabled };
    return c;
  });
    // Reflect the sync-repo toggle onto the Local-Storage marker that resolveStateSyncRepo/mirrorToSyncRepo
    // read: ON → point it at the owning storage's dedicated sync repo (null if none configured, which leaves
    // it Local-Storage-only); OFF → remove the marker (artifact_placement_policy.mdx §4).
    if (p.syncRepo?.enabled !== undefined) {
      const cfg = getRepoConfig(folder);
      const repoPath = cfg.repo.path;
      if (repoPath) {
        // The toggle is now an OPT-OUT (storage_company.mdx §8.4.2): ON re-resolves the owning storage's
        // sync repo (remote-org first) and re-stamps the marker with this repo's shared `repoUid`; OFF
        // removes the marker and the repo keeps its tracking in Local Storage only.
        ensureSyncRepoMarker(repoPath, cfg.repo.remote ?? null, p.syncRepo.enabled);
      }
    }
    res.json({ ok: true, data: toRepoSettings(req.params.repoId, folder) });
  } catch (e) {
    log.error("repos", `${folder}: update settings failed: ${(e as Error).message}`);
    res.status(500).json({ ok: false, error: (e as Error).message });
  }
});

// GET /api/repos/:repoId/decision-policy — the SHARED per-repo default-decision + attribution policy plus
// whether decisions made here actually reach a team (decisions.mdx §9/§14/§15, repo_settings.mdx §2.7/§2.8).
reposRouter.get("/:repoId/decision-policy", (req, res) => {
  const folder = folderForRepoId(req.params.repoId);
  if (!folder) return res.status(404).json({ ok: false, error: "repo not found" });
  try {
    res.json({
      ok: true,
      data: { policy: readDecisionPolicy(folder), shareStatus: shareStatus(folder) },
    });
  } catch (e) {
    log.error("repos", `${folder}: read decision-policy failed: ${(e as Error).message}`);
    res.status(500).json({ ok: false, error: (e as Error).message });
  }
});

// PATCH /api/repos/:repoId/decision-policy — merge a partial policy into the shared doc (decisions.mdx §9).
// Changing the policy is itself an audited decision: stamp who set it (set_by) from the authenticated session
// so a later auto-decide can attribute `policy:<set_by>`. Returns the updated policy.
reposRouter.patch("/:repoId/decision-policy", (req, res) => {
  const folder = folderForRepoId(req.params.repoId);
  if (!folder) return res.status(404).json({ ok: false, error: "repo not found" });
  const patch = DecisionPolicyPatch.safeParse(req.body);
  if (!patch.success) return res.status(400).json({ ok: false, error: patch.error.message });
  try {
    const setBy = currentUser(req).email;
    const updated = setDecisionPolicy(folder, { ...patch.data, set_by: patch.data.set_by ?? setBy });
    log.info("repos", `${folder}: decision-policy updated by ${setBy ?? "?"}`);
    res.json({ ok: true, data: updated });
  } catch (e) {
    log.error("repos", `${folder}: update decision-policy failed: ${(e as Error).message}`);
    res.status(500).json({ ok: false, error: (e as Error).message });
  }
});

// A validated PARTIAL of the decision policy doc (decisions.mdx §9/§14). attribution accepts the three modes
// or null (auto: resolve from the remote). media/other are the full kind-policy shape { mode, ipfs, gitignore }.
const DecisionKindPolicyPatch = z.object({
  mode: z.enum(["auto", "ask"]),
  ipfs: z.boolean(),
  gitignore: z.boolean(),
});
const DecisionPolicyPatch = z.object({
  attribution: z.enum(["email", "handle", "anonymous"]).nullable().optional(),
  media: DecisionKindPolicyPatch.optional(),
  other: DecisionKindPolicyPatch.optional(),
  set_by: z.string().nullable().optional(),
});

const RepoSettingsPatch = z.object({
  pinned: z.boolean().optional(),
  bigFileOverride: z
    .object({ enabled: z.boolean(), value: z.number(), unit: z.enum(["MB", "GB", "TB"]) })
    .partial()
    .optional(),
  largeFiles: z
    .object({
      followGitignore: z.boolean(),
      includeGlobs: z.array(z.string()),
      excludeGlobs: z.array(z.string()),
    })
    .partial()
    .optional(),
  pin: z
    .object({ pinLocally: z.boolean(), fetchMissing: z.boolean(), publishManifest: z.boolean() })
    .partial()
    .optional(),
  access: z
    .object({ shared: z.boolean(), participants: z.array(z.string()) })
    .partial()
    .optional(),
  // Transcription / AI-description placement radios (repo_settings.mdx §4-5, placement_radios.mdx).
  transcription: z.object({ placement: z.enum(["lfbridge", "beside", "sync_repo"]) }).partial().optional(),
  aiDescription: z.object({ placement: z.enum(["lfbridge", "beside", "sync_repo"]) }).partial().optional(),
  // Sync-tracking-state-to-the-company-sync-repo toggle (repo_settings.mdx §2.9).
  syncRepo: z.object({ enabled: z.boolean() }).partial().optional(),
});

function toRepoSettings(repoId: string, folder: string): RepoSettings {
  const c = getRepoConfig(folder);
  return {
    repoId,
    name: c.repo.name || folder,
    path: c.repo.path,
    remote: c.repo.remote,
    pinned: c.pinned,
    bigFileOverride: {
      enabled: c.big_file_override.enabled,
      value: c.big_file_override.value,
      unit: c.big_file_override.unit,
    },
    largeFiles: {
      followGitignore: c.large_files.follow_gitignore,
      includeGlobs: c.large_files.include_globs,
      excludeGlobs: c.large_files.exclude_globs,
    },
    pin: {
      pinLocally: c.pin.pin_locally,
      fetchMissing: c.pin.fetch_missing,
      publishManifest: c.pin.publish_manifest,
    },
    access: { shared: c.access.shared, participants: c.access.participants },
    // Company/personal owner: local owner_override (manual) else derived from the git remote (auto)
    // (repo_settings.mdx §6 / repo_company_mapping.mdx §5.2).
    owner: ownerForRepoConfig(c),
    // Transcription / AI-description placement (repo_settings.mdx §4-5, placement_radios.mdx).
    transcription: { placement: c.artifacts.transcription_placement },
    aiDescription: { placement: c.artifacts.ai_description_placement },
    // Whether this repo mirrors its tracking state to the owner's sync repo (repo_settings.mdx §2.9.1).
    // Reported as the EFFECTIVE state, with an honest reason when the repo cannot mirror at all.
    syncRepo: syncRepoSetting(c),
  };
}
